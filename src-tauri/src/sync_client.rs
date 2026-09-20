//! M2 桌面端同步客户端：mDNS 发现、配对、同步回合驱动。
//! 手机是服务器，桌面是客户端（docs/05）；回合幂等可重放：
//! manifest 四分类（仅服务器→拉 / 仅本地→推 / hash 同→跳 / hash 异→冲突双份）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::fs_ops;
use crate::sync::{
    b64_decode, local_manifest, write_conflict_copy, FileMeta, PushFile, SyncReport,
};
use crate::vault::AppState;

const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
const PULL_BATCH: usize = 32;
const PUSH_BATCH: usize = 8;

/// pull 一批的返回：文件内容 + 缺失/拒绝清单
type PullBatch = (Vec<crate::sync::PullFile>, Vec<(String, String)>);

/// 已配对服务器（桌面侧 app_config_dir/sync-servers.json）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub token: String,
}

/// mDNS 发现结果
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub name: String,
    pub url: String,
}

// ---------- 服务器配置持久化 ----------

fn servers_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    tauri::Manager::path(app)
        .app_config_dir()
        .map(|d| d.join("sync-servers.json"))
        .map_err(|_| "无法定位配置目录".into())
}

pub fn load_servers(app: &tauri::AppHandle) -> Vec<ServerProfile> {
    std::fs::read_to_string(servers_path(app).unwrap_or_default())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_servers(app: &tauri::AppHandle, servers: &[ServerProfile]) -> Result<(), String> {
    let path = servers_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // tmp+rename 原子写：写一半断电损坏 JSON → load 静默回退 → 全部已配 token 丢失
    crate::fs_ops::atomic_write(
        &path,
        serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?.as_bytes(),
    )
    .map_err(|e| e.to_string())
}

pub fn normalize_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("地址不能为空".into());
    }
    if !url.starts_with("http://") {
        return Err("地址需以 http:// 开头（如 http://192.168.1.20:4180）".into());
    }
    Ok(url.to_string())
}

// ---------- HTTP 封装 ----------

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(CLIENT_TIMEOUT)
        .build()
        .expect("构建 HTTP 客户端失败")
}

fn auth_bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// POST /api/v1/pair：配对码换 token
pub fn pair(base_url: &str, code: &str) -> Result<(String, String), String> {
    let url = normalize_url(base_url)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Paired {
        token: String,
        name: String,
    }
    let resp = client()
        .post(format!("{url}/api/v1/pair"))
        .json(&serde_json::json!({ "code": code.trim() }))
        .send()
        .map_err(|e| format!("连接失败: {e}"))?;
    match resp.status() {
        reqwest::StatusCode::OK => {
            let p: Paired = resp.json().map_err(|e| e.to_string())?;
            Ok((p.token, p.name))
        }
        s if s == reqwest::StatusCode::FORBIDDEN => Err("配对码错误".into()),
        s => Err(format!("配对失败（HTTP {s}）")),
    }
}

fn fetch_manifest(c: &reqwest::blocking::Client, url: &str, token: &str) -> Result<Vec<FileMeta>, String> {
    let resp = c
        .get(format!("{url}/api/v1/manifest"))
        .header("authorization", auth_bearer(token))
        .send()
        .map_err(|e| format!("拉取清单失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取清单失败（HTTP {}）", resp.status()));
    }
    resp.json().map_err(|e| format!("清单解析失败: {e}"))
}

fn pull_batch(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    paths: &[String],
) -> Result<PullBatch, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Resp {
        files: Vec<crate::sync::PullFile>,
        missing: Vec<(String, String)>,
    }
    let resp = c
        .post(format!("{url}/api/v1/pull"))
        .header("authorization", auth_bearer(token))
        .json(&serde_json::json!({ "paths": paths }))
        .send()
        .map_err(|e| format!("拉取失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取失败（HTTP {}）", resp.status()));
    }
    let r: Resp = resp.json().map_err(|e| e.to_string())?;
    Ok((r.files, r.missing))
}

fn push_batch(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    files: &[PushFile],
) -> Result<Vec<crate::sync::PushResult>, String> {
    let resp = c
        .post(format!("{url}/api/v1/push"))
        .header("authorization", auth_bearer(token))
        .json(&serde_json::json!({ "files": files }))
        .send()
        .map_err(|e| format!("推送失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("推送失败（HTTP {}）", resp.status()));
    }
    resp.json().map_err(|e| format!("推送响应解析失败: {e}"))
}

/// GET /api/v1/tombstones（docs/07 §3）：旧服务器 404 → 空列表（删除传播静默关闭，退化 M2 行为，不报错）
fn fetch_tombstones(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
) -> Result<Vec<crate::sync::Tombstone>, String> {
    let resp = c
        .get(format!("{url}/api/v1/tombstones"))
        .header("authorization", auth_bearer(token))
        .send()
        .map_err(|e| format!("拉取 tombstone 失败: {e}"))?;
    match resp.status() {
        s if s.is_success() => resp.json().map_err(|e| format!("tombstone 解析失败: {e}")),
        reqwest::StatusCode::NOT_FOUND => {
            log::debug!("服务器无 /tombstones（旧版本），按空列表处理");
            Ok(Vec::new())
        }
        s => Err(format!("拉取 tombstone 失败（HTTP {s}）")),
    }
}

/// POST /api/v1/delete（批量；服务器软删入回收站 + 记 tombstone）
fn delete_batch(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    paths: &[String],
) -> Result<Vec<crate::sync::PushResult>, String> {
    let resp = c
        .post(format!("{url}/api/v1/delete"))
        .header("authorization", auth_bearer(token))
        .json(&serde_json::json!({ "paths": paths }))
        .send()
        .map_err(|e| format!("删除传播失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("删除传播失败（HTTP {}）", resp.status()));
    }
    resp.json().map_err(|e| format!("删除传播响应解析失败: {e}"))
}

// ---------- 落盘辅助 ----------

/// 把拉取内容落到本地（笔记走 write_note 进索引；附件校验内容寻址）。
/// 返回错误信息（None = 成功）。
fn store_pulled(vault: &Path, conn: &rusqlite::Connection, f: &crate::sync::PullFile) -> Option<String> {
    let bytes = match b64_decode(&f.content_base64) {
        Ok(b) => b,
        Err(e) => return Some(format!("{}: {e}", f.path)),
    };
    let actual = fs_ops::content_hash(&bytes);
    if actual != f.hash {
        return Some(format!("{}: 内容 hash 不符", f.path));
    }
    match f.kind.as_str() {
        "note" => {
            // 同步场景父目录可能尚不存在（对端先建的笔记在其目录里）
            if let Some(parent) = fs_ops::safe_join(vault, &f.path)
                .map_err(|e| e.to_string())
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            {
                if let Err(e) = std::fs::create_dir_all(&parent) {
                    return Some(format!("{}: 创建目录失败: {e}", f.path));
                }
            }
            // 非 UTF-8 的 .md（GBK 等外来文件）字节级原样落盘；索引 body 用 lossy 文本
            match std::str::from_utf8(&bytes) {
                Ok(content) => match fs_ops::write_note(vault, &f.path, content, conn) {
                    Ok(_) => None,
                    Err(e) => Some(format!("{}: 写入失败: {e}", f.path)),
                },
                Err(_) => match fs_ops::write_note_bytes(vault, &f.path, &bytes, conn) {
                    Ok(_) => None,
                    Err(e) => Some(format!("{}: 写入失败: {e}", f.path)),
                },
            }
        }
        "asset" => {
            // 附件按原路径落盘（内容 hash 已验证），与服务器 push 同语义
            if !f.path.starts_with("assets/") || f.path.contains("..") {
                return Some(format!("{}: 附件路径非法", f.path));
            }
            let abs = match fs_ops::safe_join(vault, &f.path) {
                Ok(a) => a,
                Err(e) => return Some(format!("{}: 路径非法: {e}", f.path)),
            };
            if let Err(e) = std::fs::write(&abs, &bytes) {
                return Some(format!("{}: 附件写入失败: {e}", f.path));
            }
            None
        }
        other => Some(format!("{}: 未知类型 {other}", f.path)),
    }
}

/// 本地文件读为 PushFile（含 base_hash）
fn read_push_file(vault: &Path, path: &str, kind: &str, base_hash: &str) -> Option<PushFile> {
    let abs = vault.join(path);
    let bytes = std::fs::read(&abs).ok()?;
    let hash = fs_ops::content_hash(&bytes);
    let mtime_ms = std::fs::metadata(&abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(PushFile {
        path: path.to_string(),
        kind: kind.to_string(),
        content_base64: crate::sync::b64_encode(&bytes),
        hash,
        mtime_ms,
        base_hash: base_hash.to_string(),
    })
}

// ---------- 客户端基线（避免假冲突） ----------

/// 客户端基线：上次回合结束时服务器各文件的 hash（.lanmark/sync-<id>.json）。
/// 纯 hash 对比无法区分「只有一方改过」与「双方都改」：有了基线即可——
/// 本地 hash == 基线 → 只有服务器改 → 快进拉取；服务器 hash == 基线 → 只有本地改 → 推送；
/// 两者都不是 → 双方都改 → 真冲突保留双份（docs/05 §3）。
fn sync_state_path(vault: &Path, id: &str) -> PathBuf {
    // .lanmark/ 不参与同步（walk 跳过 dot 目录）
    vault.join(fs_ops::META_DIR).join(format!("sync-{id}.json"))
}

fn load_sync_state(vault: &Path, id: &str) -> HashMap<String, String> {
    std::fs::read_to_string(sync_state_path(vault, id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_sync_state(vault: &Path, id: &str, state: &HashMap<String, String>) -> Result<(), String> {
    let path = sync_state_path(vault, id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- 同步回合（docs/07 §5 回合语义 v2） ----------

/// 同步回合核心（分阶段；`sync_round` = 各阶段的默认编排）。
/// 分阶段两个目的：1) 测试可在阶段之间注入服务器侧改动，确定性构造
/// 「manifest 已过期」的竞态（M2 单体回合只能在 HTTP 层测竞态）；
/// 2) M3b/M3c 的新阶段（tombstone 处理、LWW 裁决）挂在这里，不堆进单一函数。
pub(crate) struct RoundCore {
    state: Arc<AppState>,
    profile: ServerProfile,
    vault: PathBuf,
    url: String,
    c: reqwest::blocking::Client,
    server_map: HashMap<String, FileMeta>,
    local_map: HashMap<String, FileMeta>,
    /// 服务器 tombstone（旧服务器 404 → 空列表，docs/07 §3）
    server_tombstones: Vec<crate::sync::Tombstone>,
    /// 本地 tombstone（回合开头 D4 判定后；步骤 3/4 消费与更新）
    local_tombstones: Vec<crate::sync::Tombstone>,
    /// 上轮基线（上次回合结束时服务器的 hash 快照）
    #[allow(dead_code)] // 分类在 new() 内消费；M3c 起阶段间需要时再放开
    base_prev: HashMap<String, String>,
    /// 仅服务器有 → 拉
    to_pull: Vec<String>,
    /// 仅本地有 / 冲突要推 → (path, base_hash)
    to_push: Vec<(String, String)>,
    /// 双方都改（两端 hash 均 ≠ 基线）→ (path, 服务器 hash)
    conflicts: Vec<(String, String)>,
    /// 本回合基线（步骤 8）：起点 = 回合开始时的服务器清单，
    /// 拉取/推送结果按「操作后最终 hash」更新（M3a G3 修复）
    baseline: HashMap<String, String>,
    report: SyncReport,
}

impl RoundCore {
    /// 步骤 0–2：本地 reindex → 双侧清单 + 基线 → 四分类
    fn new(state: &Arc<AppState>, profile: &ServerProfile) -> Result<Self, String> {
        let url = normalize_url(&profile.url)?;
        let vault = state
            .vault
            .lock()
            .map_err(|_| "vault 锁中毒".to_string())?
            .clone()
            .ok_or("尚未打开 vault")?;

        // 0. 本地重索引：外部改动（其他编辑器/App 直接改 vault 文件）后 DB 缓存
        //    可能缺文件或 hash 过时——同步回合必须以磁盘为准（M1 契约：磁盘是事实源）
        {
            let conn_guard = state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
            fs_ops::reindex(&vault, conn).map_err(|e| format!("重索引失败: {e}"))?;
        }

        // 1. 双侧清单 + 客户端基线 + 服务器 tombstones（docs/07 §5 步骤 1）
        let c = client();
        let server_manifest = fetch_manifest(&c, &url, &profile.token)?;
        let server_tombstones = fetch_tombstones(&c, &url, &profile.token)?;

        // M3b：本地 tombstone TTL 清理（30 天）
        if let Err(e) = crate::sync::purge_expired_tombstones(&vault, fs_ops::now_ms()) {
            log::warn!("tombstone TTL 清理失败: {e}");
        }
        // 回合开头 D4 判定：本地 tombstone 的路径重新出现在磁盘上（回收站恢复/重建）
        let local_tombstones = {
            let mut keep: Vec<crate::sync::Tombstone> = Vec::new();
            for t in crate::sync::load_tombstones(&vault) {
                let abs = vault.join(&t.path);
                if abs.is_file() {
                    if crate::sync::meta_mtime_ms(&abs) > t.mtime_ms {
                        // 重建比删除新 → 路径复活（D4）：清 tombstone，正常同步流程推送
                        if let Err(e) = crate::sync::clear_tombstone_if_present(&vault, &t.path) {
                            log::warn!("回合开头清 tombstone 失败 {}: {e}", t.path);
                        }
                    } else {
                        // 陈旧恢复（mtime ≤ 删除时刻）：删除仍然有效 → 再软删（内容进回收站，铁律）
                        let res = {
                            let conn_guard = state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
                            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
                            fs_ops::delete_entry(&vault, &t.path, conn).map_err(|e| e.to_string())
                        };
                        if let Err(e) = res {
                            log::warn!("陈旧恢复文件再软删失败 {}: {e}", t.path);
                        }
                        keep.push(t);
                    }
                } else {
                    keep.push(t);
                }
            }
            keep
        };

        let local = local_manifest(state)?;
        let server_map: HashMap<String, FileMeta> =
            server_manifest.iter().cloned().map(|m| (m.path.clone(), m)).collect();
        let local_map: HashMap<String, FileMeta> =
            local.iter().cloned().map(|m| (m.path.clone(), m)).collect();
        let base_prev = load_sync_state(&vault, &profile.id);

        let mut report = SyncReport::default();
        let mut to_pull: Vec<String> = Vec::new();
        let mut to_push: Vec<(String, String)> = Vec::new(); // (path, base_hash)
        let mut conflicts: Vec<(String, String)> = Vec::new(); // (path, server hash)

        // 2. 四分类（仅服务器有→拉 / 仅本地有→推 / hash 同→跳 / hash 异→三方对比）
        for (path, sm) in &server_map {
            match local_map.get(path) {
                None => to_pull.push(path.clone()),
                Some(lm) => {
                    if lm.hash == sm.hash {
                        report.skipped += 1;
                    } else {
                        let base = base_prev.get(path);
                        if base == Some(&lm.hash) {
                            // 只有服务器改了 → 快进拉取（覆盖本地）
                            to_pull.push(path.clone());
                        } else if base == Some(&sm.hash) {
                            // 只有本地改了 → 推送
                            to_push.push((path.clone(), sm.hash.clone()));
                        } else {
                            // 双方都改（或无基线，如首次同步/重新配对）→ 双份（M3c：LWW 裁决）
                            conflicts.push((path.clone(), sm.hash.clone()));
                        }
                    }
                }
            }
        }
        for path in local_map.keys() {
            if !server_map.contains_key(path) {
                to_push.push((path.clone(), String::new()));
            }
        }

        // 8（基线起点）：= 回合开始时的服务器清单（步骤 8 按本回合结果更新）
        let baseline = server_map
            .iter()
            .map(|(k, v)| (k.clone(), v.hash.clone()))
            .collect();

        Ok(RoundCore {
            state: state.clone(),
            profile: profile.clone(),
            vault,
            url,
            c,
            server_map,
            local_map,
            server_tombstones,
            local_tombstones,
            base_prev,
            to_pull,
            to_push,
            conflicts,
            baseline,
            report,
        })
    }

    /// 步骤 3：服务器 tombstone 处理（docs/07 §5 步骤 3）
    /// hash 同 → 本地软删 + 记本地 tombstone；hash 异 → edit/delete LWW（删除元组 size=0，
    /// mtime 平手时编辑恒赢）；本地无 → 补记本地 tombstone 跳过
    fn server_tombstones_phase(&mut self) -> Result<(), String> {
        // take 出来再遍历：块内要 &mut self（upsert/软删/清 tombstone）
        let server_tombstones = std::mem::take(&mut self.server_tombstones);
        for t in server_tombstones {
            // 防御：服务器 manifest 仍有该路径（tombstone 未清的不一致态）→ 跳过，正常流程优先
            if self.server_map.contains_key(&t.path) {
                continue;
            }
            match self.local_map.get(&t.path) {
                None => {
                    // 双方已删 → 补记本地 tombstone（供传播到其他服务器），跳过
                    self.upsert_local_tombstone(&t);
                }
                Some(lm) => {
                    let edit = (lm.mtime_ms, lm.size, lm.hash.as_str());
                    let del = (t.mtime_ms, 0, t.hash.as_str());
                    if crate::sync::version_gt(edit, del) {
                        // 编辑赢 → 推送复活（服务器落盘时 D4 清 tombstone）；清陈旧本地 tombstone
                        if let Err(e) = crate::sync::clear_tombstone_if_present(&self.vault, &t.path) {
                            log::warn!("清 tombstone 失败 {}: {e}", t.path);
                        }
                        self.local_tombstones.retain(|x| x.path != t.path);
                        // 分类里「仅本地」应已在 to_push；不在则补（base 空 = 服务器无此文件）
                        if !self.to_push.iter().any(|(p, _)| p == &t.path) {
                            self.to_push.push((t.path.clone(), String::new()));
                        }
                    } else {
                        // 删除赢 → 本地软删 + 继承服务器的删除事件
                        self.soft_delete_local(&t.path)?;
                        self.upsert_local_tombstone(&t);
                        // 分类可能已把该路径放进 to_push/to_pull（不一致态）→ 撤掉
                        self.to_push.retain(|(p, _)| p != &t.path);
                        self.to_pull.retain(|p| p != &t.path);
                    }
                }
            }
        }
        Ok(())
    }

    /// 步骤 4：本地 tombstone vs 服务器 manifest（docs/07 §5 步骤 4，方向对调）
    /// hash 同 → 调 /delete 静默传播；hash 异 → edit/delete LWW（服务器编辑新 → 拉取复活 + 清
    /// 本地 tombstone；删除新 → /delete）；服务器无此文件 → 无操作
    fn local_tombstones_phase(&mut self) -> Result<(), String> {
        let mut to_delete: Vec<String> = Vec::new();
        // take 出来再遍历：块内要 &mut self（清 tombstone/撤 to_pull）
        let local_tombstones = std::mem::take(&mut self.local_tombstones);
        for t in local_tombstones {
            let Some(sm) = self.server_map.get(&t.path) else {
                continue;
            };
            let edit_wins =
                crate::sync::version_gt((sm.mtime_ms, sm.size, sm.hash.as_str()), (t.mtime_ms, 0, t.hash.as_str()));
            if sm.hash == t.hash || !edit_wins {
                // 删后没再改（静默传播）/ 删除比服务器编辑新 → 服务器也软删
                to_delete.push(t.path.clone());
                // 分类已把它放进 to_pull（仅服务器有）→ 撤掉，否则快进拉取会把已删文件拉回来
                self.to_pull.retain(|p| p != &t.path);
            } else {
                // 服务器编辑更新 → 复活：保留 to_pull（分类已放，正常拉取），清本地 tombstone（D4）
                if let Err(e) = crate::sync::clear_tombstone_if_present(&self.vault, &t.path) {
                    log::warn!("清 tombstone 失败 {}: {e}", t.path);
                }
                self.local_tombstones.retain(|x| x.path != t.path);
            }
        }
        if !to_delete.is_empty() {
            let results = delete_batch(&self.c, &self.url, &self.profile.token, &to_delete)?;
            for r in results {
                if r.ok {
                    self.report.deleted.push(r.path.clone());
                } else {
                    self.report
                        .errors
                        .push(format!("删除传播失败 {}: {}", r.path, r.error.unwrap_or_default()));
                }
            }
        }
        Ok(())
    }

    /// 本地软删（进回收站，铁律）+ 报告计数
    fn soft_delete_local(&mut self, path: &str) -> Result<(), String> {
        let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
        let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
        fs_ops::delete_entry(&self.vault, path, conn)
            .map_err(|e| format!("{path}: 本地软删失败: {e}"))?;
        self.report.deleted.push(path.to_string());
        Ok(())
    }

    /// 本地 tombstone upsert（内存 + 磁盘）
    fn upsert_local_tombstone(&mut self, t: &crate::sync::Tombstone) {
        self.local_tombstones.retain(|x| x.path != t.path);
        self.local_tombstones.push(t.clone());
        if let Err(e) = crate::sync::record_tombstone(&self.vault, &t.path, &t.hash, t.deleted_at) {
            log::warn!("记 tombstone 失败 {}: {e}", t.path);
        }
    }

    /// 步骤 5（M2 语义：本地恒赢；M3c 以 mtime LWW 仲裁取代）：
    /// 服务器版本 → 本地冲突副本；本地版本原样保留，稍后以服务器 hash 为 base 推送
    fn resolve_conflicts(&mut self) -> Result<(), String> {
        let state = &self.state;
        let profile = &self.profile;
        let conn_guard = state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
        let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
        for (path, sm_hash) in self.conflicts.iter().cloned() {
            let (files, missing) =
                pull_batch(&self.c, &self.url, &profile.token, std::slice::from_ref(&path))?;
            if let Some((p, why)) = missing.first() {
                self.report.errors.push(format!("冲突副本拉取失败 {p}: {why}"));
                continue;
            }
            let Some(f) = files.first() else {
                self.report.errors.push(format!("冲突副本拉取为空: {path}"));
                continue;
            };
            let bytes = match b64_decode(&f.content_base64) {
                Ok(b) => b,
                Err(e) => {
                    self.report.errors.push(format!("冲突副本解码失败 {path}: {e}"));
                    continue;
                }
            };
            match write_conflict_copy(&self.vault, conn, &path, &f.kind, &bytes, fs_ops::now_ms()) {
                Ok(copy) => self.report.conflicts.push(copy),
                Err(e) => self.report.errors.push(format!("冲突副本落盘失败 {path}: {e}")),
            }
            self.to_push.push((path, sm_hash));
        }
        Ok(())
    }

    /// 步骤 6：拉取（批量 32）。实拉 hash 进基线（步骤 8：拉取路径 → 实拉 hash）
    fn pull_phase(&mut self) -> Result<(), String> {
        for chunk in self.to_pull.chunks(PULL_BATCH) {
            let (files, missing) =
                pull_batch(&self.c, &self.url, &self.profile.token, chunk)?;
            for (p, why) in missing {
                self.report.errors.push(format!("拉取失败 {p}: {why}"));
            }
            let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
            for f in files {
                match store_pulled(&self.vault, conn, &f) {
                    None => {
                        self.report.pulled.push(f.path.clone());
                        self.baseline.insert(f.path.clone(), f.hash.clone());
                    }
                    Some(e) => self.report.errors.push(e),
                }
            }
        }
        Ok(())
    }

    /// 步骤 7：推送（批量 8；base_hash 空 = 服务器没有，非空 = 客户端所见服务器旧版）。
    /// M3a（步骤 8 配套）：基线取 `serverHash`（操作后最终 hash）；
    /// 推送被服务器仲裁降级（serverHash ≠ 所推 hash）→ 纠正拉取服务器 P 对齐本地
    fn push_phase(&mut self) -> Result<(), String> {
        // take 出来再分块：块内 corrective_pull 要 &mut self，与 to_push 借用冲突
        let to_push = std::mem::take(&mut self.to_push);
        for chunk in to_push.chunks(PUSH_BATCH) {
            let mut batch = Vec::new();
            for (path, base_hash) in chunk {
                let Some(lm) = self.local_map.get(path).cloned() else { continue };
                let Some(pf) = read_push_file(&self.vault, path, &lm.kind, base_hash) else {
                    self.report.errors.push(format!("推送读取失败: {path}"));
                    continue;
                };
                batch.push(pf);
            }
            if batch.is_empty() {
                continue;
            }
            let results = push_batch(&self.c, &self.url, &self.profile.token, &batch)?;
            for r in results {
                let Some(pf) = batch.iter().find(|f| f.path == r.path) else {
                    continue;
                };
                if !r.ok {
                    self.report
                        .errors
                        .push(format!("推送失败 {}: {}", r.path, r.error.unwrap_or_default()));
                    continue;
                }
                match &r.server_hash {
                    // 被服务器仲裁降级：原路径上是更新的版本（docs/07 §5 步骤 8）
                    Some(sh) if sh != &pf.hash => match self.corrective_pull(&r.path, sh) {
                        Ok(actual) => {
                            self.report.pulled.push(r.path.clone());
                            self.baseline.insert(r.path.clone(), actual);
                            // 输家（本次推送内容）已在服务器侧存为冲突副本，下回合作普通文件拉回
                        }
                        Err(e) => {
                            self.report.errors.push(e);
                            // 兜底：基线 = 所推 hash → 下回合「只有服务器改」快进拉取
                            //（M2 行为：内容在服务器侧副本中安全，无丢失）
                            self.baseline.insert(r.path.clone(), pf.hash.clone());
                        }
                    },
                    Some(sh) => {
                        // 干净落盘 / 来件仲裁获胜：服务器 P = 所推内容
                        self.report.pushed.push(r.path.clone());
                        if let Some(cp) = r.conflict_saved_as {
                            self.report.conflicts.push(cp);
                        }
                        self.baseline.insert(r.path.clone(), sh.clone());
                    }
                    // 旧服务器（无 serverHash 字段）→ M2 行为：ok = 落盘成功
                    None => {
                        self.report.pushed.push(r.path.clone());
                        if let Some(cp) = r.conflict_saved_as {
                            self.report.conflicts.push(cp);
                        }
                        self.baseline.insert(r.path.clone(), pf.hash.clone());
                    }
                }
            }
        }
        Ok(())
    }

    /// M3a：推送被服务器仲裁降级后，拉服务器 P 现值对齐本地。
    /// 先拉后覆写（hash 校验通过才落盘）；输家内容已有服务器侧冲突副本，无丢失。
    /// 返回实拉 hash。
    fn corrective_pull(&mut self, path: &str, expect_hash: &str) -> Result<String, String> {
        let (files, missing) = pull_batch(
            &self.c,
            &self.url,
            &self.profile.token,
            std::slice::from_ref(&path.to_string()),
        )
        .map_err(|e| format!("{path}: 降级纠正拉取失败: {e}"))?;
        if let Some((p, why)) = missing.first() {
            return Err(format!("{p}: 降级纠正拉取被拒: {why}"));
        }
        let f = files
            .first()
            .ok_or_else(|| format!("{path}: 降级纠正拉取为空"))?;
        if f.hash != expect_hash {
            // push 与 pull 之间服务器又被别的客户端改了——拉回内容已 hash 校验，以实拉为准
            log::warn!(
                "同步: {} 降级参照 {} 与实拉 {} 不一致（服务器又变了），以实拉为准",
                path,
                expect_hash,
                f.hash
            );
        }
        let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
        let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
        if let Some(e) = store_pulled(&self.vault, conn, f) {
            return Err(format!("{path}: 降级纠正写入失败: {e}"));
        }
        Ok(f.hash.clone())
    }

    /// 步骤 8–9：持久化基线 + 返回报告
    fn finish(self) -> Result<SyncReport, String> {
        save_sync_state(&self.vault, &self.profile.id, &self.baseline)?;
        Ok(self.report)
    }
}

/// 一个完整同步回合（docs/07 §5 回合语义 v2 的 M3a+M3b 子集：M2 + serverHash 基线修复
/// + 仲裁降级纠正拉取 + tombstone 删除传播）。阻塞；调用方负责放到 blocking 线程。
pub fn sync_round(state: &Arc<AppState>, profile: &ServerProfile) -> Result<SyncReport, String> {
    let mut core = RoundCore::new(state, profile)?;
    core.server_tombstones_phase()?;
    core.local_tombstones_phase()?;
    core.resolve_conflicts()?;
    core.pull_phase()?;
    core.push_phase()?;
    core.finish()
}

// ---------- mDNS 发现 ----------

/// 浏览 _lanmark._tcp 约 2s，返回去重结果（按 url）。
pub fn discover(timeout: Duration) -> Vec<Discovered> {
    let daemon = match mdns_sd::ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("mDNS daemon 启动失败: {e}");
            return vec![];
        }
    };
    let receiver = match daemon.browse(crate::sync_server::SERVICE_TYPE) {
        Ok(rx) => rx,
        Err(e) => {
            eprintln!("mDNS browse 失败: {e}");
            return vec![];
        }
    };
    let deadline = std::time::Instant::now() + timeout;
    let mut out: Vec<Discovered> = Vec::new();
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        match receiver.recv_timeout(deadline - now) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let host = info
                    .get_addresses()
                    .iter()
                    .next()
                    .map(|ip| ip.to_string())
                    .or_else(|| info.get_hostname().trim_end_matches('.').to_string().into())
                    .unwrap_or_default();
                if host.is_empty() {
                    continue;
                }
                let url = format!("http://{}:{}", host, info.get_port());
                let name = info.get_fullname().trim_end_matches(&format!(".{}", crate::sync_server::SERVICE_TYPE)).to_string();
                let name = crate::sync_server::service_instance_name(&name);
                if !out.iter().any(|d| d.url == url) {
                    out.push(Discovered { name, url });
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.stop_browse(crate::sync_server::SERVICE_TYPE);
    out
}

// ---------- Tauri 命令 ----------

/// mDNS 发现（约 2s 阻塞扫描；异步命令 + blocking 线程，不卡 UI）
#[tauri::command]
pub async fn sync_discover() -> CmdResult<Vec<Discovered>> {
    tauri::async_runtime::spawn_blocking(|| discover(Duration::from_secs(2)))
        .await
        .map_err(|e| format!("发现任务失败: {e}"))
}

/// 配对并保存服务器（pair 成功才落盘）
#[tauri::command]
pub async fn sync_pair(
    app: tauri::AppHandle,
    url: String,
    code: String,
) -> CmdResult<ServerProfile> {
    tauri::async_runtime::spawn_blocking(move || {
        let (token, name) = pair(&url, &code)?;
        let mut servers = load_servers(&app);
        let hash = fs_ops::content_hash(format!("{url}{token}").as_bytes());
        let id = format!("s{}", &hash[..8]);
        let profile = ServerProfile { id: id.clone(), name, url: normalize_url(&url)?, token };
        servers.retain(|s| s.url != profile.url);
        servers.push(profile.clone());
        save_servers(&app, &servers)?;
        Ok(profile)
    })
    .await
    .map_err(|e| format!("配对任务失败: {e}"))?
}

#[tauri::command]
pub fn sync_servers(app: tauri::AppHandle) -> CmdResult<Vec<ServerProfile>> {
    Ok(load_servers(&app))
}

#[tauri::command]
pub fn sync_server_remove(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let mut servers = load_servers(&app);
    servers.retain(|s| s.id != id);
    save_servers(&app, &servers)
}

/// 立即同步（阻塞回合放进 blocking 线程）。
/// Rust 侧全局互斥兜底：UI 锁（syncing 标志）之外的双发（快速双击/多窗口）
/// 会让两个回合并发 reindex/写基线文件互踩
static SYNC_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn sync_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> CmdResult<SyncReport> {
    use std::sync::atomic::Ordering;
    if SYNC_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("同步回合进行中，请稍候".into());
    }
    let _guard = SyncGuard;
    let servers = load_servers(&app);
    let profile = servers
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("未找到服务器: {id}"))?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync_round(&state, &profile))
        .await
        .map_err(|e| format!("同步任务失败: {e}"))?
}

pub type CmdResult<T> = Result<T, String>;

#[cfg(test)]
#[allow(non_snake_case)] // 测试惯用短标识（dA/deskA/profile_a…）
mod tests {
    use super::*;
    use crate::commands::{
        asset_save_op, entry_delete_op, entry_rename_op, folder_create_op, note_create_op,
        note_write_op, open_vault_at,
    };
    use crate::sync::{b64_encode, load_tombstones};
    use crate::sync_server::test_util::start_phone_server;
    use crate::vault::AppState;

    fn client_vault() -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        (dir, state)
    }

    /// 测试：显式设定文件 mtime（LWW 仲裁确定性；真实场景由保存时间自然分布）
    fn set_mtime(state: &Arc<AppState>, rel: &str, ms: i64) {
        let vault = state.vault.lock().unwrap().clone().unwrap();
        let abs = vault.join(rel);
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64);
        let times = std::fs::FileTimes::new().set_modified(t);
        std::fs::File::open(&abs).unwrap().set_times(times).unwrap();
    }

    /// 测试：vault 全量快照（相对路径 → 内容 hash；跳过点目录与孤儿 tmp）
    fn vault_snapshot(vault: &Path) -> std::collections::BTreeMap<String, String> {
        fn walk(dir: &Path, vault: &Path, out: &mut std::collections::BTreeMap<String, String>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let p = e.path();
                let s = e.file_name().to_string_lossy().to_string();
                if s.starts_with('.') {
                    continue; // .lanmark/（索引/回收站/基线）不参与收敛比对
                }
                if p.is_dir() {
                    walk(&p, vault, out);
                } else if p.is_file() && !s.contains("lanmark-tmp") {
                    if let Ok(b) = std::fs::read(&p) {
                        let rel = fs_ops::rel_to_string(p.strip_prefix(vault).unwrap());
                        out.insert(rel, fs_ops::content_hash(&b));
                    }
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(vault, vault, &mut out);
        out
    }

    #[test]
    fn pair_requires_correct_code() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let app = Arc::new(AppState::default());
        open_vault_at(&app, phone_dir.path()).unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), app);

        assert!(pair(&base, "00000000").is_err());
        assert!(pair(&base, &code).is_ok());
        assert!(pair("not-a-url", "x").is_err());
        assert!(pair(&base, "").is_err());
    }

    #[test]
    fn sync_round_full_flow_bidirectional() {
        // 手机端：两篇笔记 + 一个附件（手机侧建一篇、稍后桌面侧建一篇）
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note_a = note_create_op(&phone, "", "手机笔记").unwrap();
        note_write_op(&phone, &note_a.path, "手机端内容甲").unwrap();
        let asset = asset_save_op(&phone, &b64_encode(b"img-phone"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        // 桌面端：一篇手机没有的笔记
        let (desk_dir, desk) = client_vault();
        let note_b = note_create_op(&desk, "", "桌面笔记").unwrap();
        note_write_op(&desk, &note_b.path, "桌面端内容乙").unwrap();

        // 配对 → round 1：手机 → 桌面（2 文件），桌面 → 手机（1 笔记）
        let (token, name) = pair(&base, &code).unwrap();
        assert!(!name.is_empty());
        let profile = ServerProfile { id: "s1".into(), name: name.clone(), url: base.clone(), token };
        let r1 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r1.pulled.len(), 2, "拉回笔记+附件: {:?}", r1);
        assert_eq!(r1.pushed.len(), 1, "推走桌面笔记: {:?}", r1);
        assert_eq!(r1.conflicts.len(), 0);
        assert_eq!(r1.skipped, 0);
        assert!(r1.errors.is_empty(), "无错误: {:?}", r1.errors);

        // 双方对齐：桌面有手机笔记（内容一致）+ 附件
        let got = std::fs::read_to_string(desk_dir.path().join(&note_a.path)).unwrap();
        assert_eq!(got, "手机端内容甲");
        assert!(desk_dir.path().join(&asset).exists());
        // 手机有桌面笔记
        let got2 = std::fs::read_to_string(phone_dir.path().join(&note_b.path)).unwrap();
        assert_eq!(got2, "桌面端内容乙");

        // round 2：全部 hash 相同 → 全跳过
        let r2 = sync_round(&desk, &profile).unwrap();
        assert!(r2.pulled.is_empty() && r2.pushed.is_empty() && r2.conflicts.is_empty());
        assert_eq!(r2.skipped, 3, "3 个文件跳过: {:?}", r2);

        // 双向各改一篇 → round 3 互见（无冲突：各自改不同文件）
        note_write_op(&desk, &note_b.path, "桌面端内容乙改").unwrap();
        note_write_op(&phone, &note_a.path, "手机端内容甲改").unwrap();
        let r3 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r3.pulled.len(), 1);
        assert_eq!(r3.pushed.len(), 1);
        assert!(r3.errors.is_empty(), "{:?}", r3.errors);
        assert_eq!(std::fs::read_to_string(desk_dir.path().join(&note_a.path)).unwrap(), "手机端内容甲改");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&note_b.path)).unwrap(), "桌面端内容乙改");
    }

    #[test]
    fn sync_round_conflict_keeps_both_versions() {
        // 两端离线各改同一篇 → 同步后双份都在、无丢失（docs/05 验收 3）
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "冲突笔记").unwrap();
        note_write_op(&phone, &note.path, "原始内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token };

        // 先同步让桌面拿到原始内容
        let r0 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r0.pulled.len(), 1, "{r0:?}");

        // 离线：两端各改同一篇
        note_write_op(&desk, &note.path, "桌面版本").unwrap();
        note_write_op(&phone, &note.path, "手机版本").unwrap();

        // 同步回合：手机版本 → 桌面冲突副本；桌面版本 → 推给手机
        let r1 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r1.conflicts.len(), 1, "一个冲突副本: {r1:?}");
        assert_eq!(r1.pushed.len(), 1, "桌面版本推走: {r1:?}");
        assert!(r1.errors.is_empty(), "{:?}", r1.errors);

        // 桌面端：原路径 = 桌面版本，冲突副本 = 手机版本（双份都在）
        assert_eq!(std::fs::read_to_string(desk_dir.path().join(&note.path)).unwrap(), "桌面版本");
        let copy = &r1.conflicts[0];
        assert!(copy.contains("冲突"), "冲突命名: {copy}");
        assert_eq!(std::fs::read_to_string(desk_dir.path().join(copy)).unwrap(), "手机版本");

        // 手机端：原路径 = 桌面版本（干净覆盖，base_hash 一致），随后回合把冲突副本推过来
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&note.path)).unwrap(), "桌面版本");

        // 收敛回合：桌面把冲突副本推给手机 → 两端都有两份
        let r2 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r2.pushed.len(), 1, "冲突副本推送: {r2:?}");
        assert_eq!(r2.skipped, 1, "原路径已一致: {r2:?}");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(copy)).unwrap(), "手机版本");

        // 终态：再跑一轮全跳过（note + 冲突副本）
        let r3 = sync_round(&desk, &profile).unwrap();
        assert!(r3.pulled.is_empty() && r3.pushed.is_empty());
        assert_eq!(r3.skipped, 2);
    }

    #[test]
    fn sync_round_race_on_server_side_conflict_naming() {
        // 推送时服务器版本在 manifest 之后又变了（base_hash 过期）→ 服务器侧冲突命名
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "竞态笔记").unwrap();
        note_write_op(&phone, &note.path, "手机版本一").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token: token.clone() };

        let r0 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r0.pulled.len(), 1);

        // 1) 客户端先取 manifest（此刻服务器还是「手机版本一」）
        let c = client();
        let manifest = fetch_manifest(&c, &base, &token).unwrap();
        let stale_hash = manifest.iter().find(|m| m.path == note.path).unwrap().hash.clone();

        // 2) 桌面基于旧版修改；服务器在 manifest 之后被改成「手机版本二」。
        //    显式设定 mtime：桌面版本更新（M3a 仲裁下来件获胜，M2 断言保持成立）
        note_write_op(&desk, &note.path, "桌面版本").unwrap();
        set_mtime(&desk, &note.path, fs_ops::now_ms() + 3_600_000);
        note_write_op(&phone, &note.path, "手机版本二").unwrap();

        // 3) 客户端带着过期 base_hash 推送 → 服务器仲裁（来件新）：原版本冲突命名
        let pf = read_push_file(desk_dir.path(), &note.path, "note", &stale_hash).unwrap();
        let pushed_hash = pf.hash.clone();
        let results = push_batch(&c, &base, &token, &[pf]).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "竞态 push 应成功: {:?}", results[0].error);
        let server_copy = results[0].conflict_saved_as.clone().expect("服务器侧应有冲突副本");
        assert!(server_copy.contains("冲突"), "服务器侧冲突命名: {server_copy}");
        // M3a：来件获胜 → serverHash = 所推 hash
        assert_eq!(results[0].server_hash.as_deref(), Some(pushed_hash.as_str()));

        // 服务器：原路径 = 桌面版本，冲突副本 = 手机版本二（双份都在）
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&note.path)).unwrap(), "桌面版本");
        assert_eq!(
            std::fs::read_to_string(phone_dir.path().join(&server_copy)).unwrap(),
            "手机版本二"
        );

        // 4) 收敛回合：服务器多出的冲突副本被桌面拉回，无新冲突
        let r1 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r1.pulled.len(), 1, "拉回服务器侧冲突副本: {r1:?}");
        assert!(r1.conflicts.is_empty(), "{r1:?}");
        assert!(r1.errors.is_empty(), "{r1:?}");
        assert_eq!(
            std::fs::read_to_string(desk_dir.path().join(&server_copy)).unwrap(),
            "手机版本二"
        );
        // 三份内容都在，无丢失：桌面（桌面版本 + 手机版本二副本）、服务器同
    }

    // ---------- M3a 双客户端集成（docs/07 §9） ----------

    /// 三端（手机服务器 + 桌面×2）顺序改动 → 收敛，终轮全跳过
    #[test]
    #[allow(non_snake_case)]
    fn dual_client_sequential_convergence() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let s_note = note_create_op(&phone, "", "服务器笔记").unwrap();
        note_write_op(&phone, &s_note.path, "服务器内容").unwrap();
        let _s_asset = asset_save_op(&phone, &b64_encode(b"phone-asset"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        // 两个客户端各用独立 id（基线按 id 隔离，模拟两台桌面）
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();

        // 两客户端首次同步：各拉回 2（笔记 + 附件）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");

        // A 改：修改服务器笔记 + 新建笔记
        note_write_op(&deskA, &s_note.path, "服务器内容-A 改").unwrap();
        let na = note_create_op(&deskA, "", "A 新笔记").unwrap();
        note_write_op(&deskA, &na.path, "A 新笔记内容").unwrap();
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pushed.len(), 2, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        // B 同步 → 互见
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");

        // B 改：修改 A 的新笔记 + 新建附件
        note_write_op(&deskB, &na.path, "A 新笔记内容-B 改").unwrap();
        let _b_asset = asset_save_op(&deskB, &b64_encode(b"b-asset"), "png").unwrap();
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 2, "{r:?}");
        // A 同步 → 互见
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");

        // 三端快照一致（收敛）
        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()), "A 与服务器不一致");
        assert_eq!(snap_phone, vault_snapshot(dB.path()), "B 与服务器不一致");
        assert_eq!(snap_phone.len(), 4, "4 个同步单元: {snap_phone:?}");

        // 终轮：全跳过
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty() && r.conflicts.is_empty(), "{r:?}");
        assert_eq!(r.skipped, 4, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty(), "{r:?}");
        assert_eq!(r.skipped, 4, "{r:?}");
    }

    /// 双端离线改同一篇（较新者走冲突分支）→ 较新者留原路径、较旧者成可见副本
    #[test]
    #[allow(non_snake_case)]
    fn dual_client_interleaved_same_file_newer_wins() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "交错笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // 离线：A 改旧版（mtime -1h），B 改新版（mtime +1h）
        note_write_op(&deskA, &p.path, "A 版本").unwrap();
        set_mtime(&deskA, &p.path, fs_ops::now_ms() - 3_600_000);
        note_write_op(&deskB, &p.path, "B 版本").unwrap();
        set_mtime(&deskB, &p.path, fs_ops::now_ms() + 3_600_000);

        // A 先同步：干净推送 A 版本
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        // B 同步：双方都改 → 冲突分支（B 本地更新）：A 版本 → B 侧副本，B 版本推走
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        assert_eq!(r.conflicts.len(), 1, "{r:?}");
        let b_copy = r.conflicts[0].clone();
        // A 再同步：快进拉 B 版本
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "{r:?}");

        // 三端原路径 = B 版本（较新者赢）
        assert_eq!(std::fs::read_to_string(dA.path().join(&p.path)).unwrap(), "B 版本");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "B 版本");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 版本");

        // 副本传播：B 推 → A 拉 → 三端互见（铁律：A 版本内容不丢）
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "{r:?}");

        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        let copy_rel = snap_phone
            .keys()
            .find(|k| k.contains("冲突"))
            .cloned()
            .expect("冲突副本应在三端");
        assert_eq!(std::fs::read_to_string(dA.path().join(&copy_rel)).unwrap(), "A 版本");
        assert_eq!(copy_rel, b_copy, "A 拉回的副本 = B 侧落地的副本");
    }

    /// 同文件并发竞态：A 的旧版推送晚于 B 的新版落服务器（到达顺序 ≠ mtime 顺序）
    /// → 服务器仲裁降级 A → A 回合内纠正拉取 → 最终 P = mtime 新者，输家副本落点正确
    #[test]
    #[allow(non_snake_case)]
    fn round_demoted_push_corrective_pull_converges() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "竞态笔记").unwrap();
        note_write_op(&phone, &p.path, "基础版").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 离线改「旧版」（mtime -1h），回合开始：此刻服务器还是「基础版」
        note_write_op(&deskA, &p.path, "A 旧版").unwrap();
        set_mtime(&deskA, &p.path, fs_ops::now_ms() - 3_600_000);
        let mut core = RoundCore::new(&deskA, &profile_a).unwrap();
        // A 的回合分类：只有本地改 → 推送（base = 基础版 hash，即将过期）

        // 注入竞态：B 在 A 的 manifest 之后、推送之前完成整回合（新版 mtime +1h）
        note_write_op(&deskB, &p.path, "B 新版").unwrap();
        set_mtime(&deskB, &p.path, fs_ops::now_ms() + 3_600_000);
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "B 新版干净落盘: {r:?}");

        // A 继续回合：推送 A 旧版（base 已过期）→ 服务器仲裁降级 → 回合内纠正拉取
        core.resolve_conflicts().unwrap();
        core.pull_phase().unwrap();
        core.push_phase().unwrap();
        let report = core.finish().unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        // 铁律核查：A 旧版内容已在服务器侧副本落盘
        let server_snap = vault_snapshot(phone_dir.path());
        assert!(
            server_snap.values().any(|h| *h == fs_ops::content_hash("A 旧版".as_bytes())),
            "降级来件必须已有服务器侧副本: {server_snap:?}"
        );
        // A 本地原路径 = B 新版（纠正拉取对齐，未被快进覆盖）
        assert_eq!(std::fs::read_to_string(dA.path().join(&p.path)).unwrap(), "B 新版");
        // A 基线 = 服务器操作后 hash（G3：不再误判「只有本地改」重推旧版）
        let base_file = dA.path().join(fs_ops::META_DIR).join("sync-sa.json");
        let base_state: HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(base_file).unwrap()).unwrap();
        assert_eq!(
            base_state.get(&p.path),
            Some(&fs_ops::content_hash("B 新版".as_bytes())),
            "基线必须 = serverHash（G3 修复）"
        );

        // 收敛：A、B 各补一回合 → 三端 P = B 新版 + 副本（A 旧版）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "A 拉回降级副本: {r:?}");
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pulled.len(), 1, "B 拉回降级副本: {r:?}");
        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 新版");
        let copy_rel = snap_phone
            .keys()
            .find(|k| k.contains("冲突"))
            .cloned()
            .expect("输家副本应在三端");
        assert_eq!(std::fs::read_to_string(dA.path().join(&copy_rel)).unwrap(), "A 旧版");
        // 终轮全跳过
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty() && r.conflicts.is_empty(), "{r:?}");
        assert_eq!(r.skipped, snap_phone.len());
    }

    // ---------- M3b tombstone（docs/07 §9） ----------

    /// 删除传播：hash 相同（删后没再改）→ 三端软删，回收站都有，不再拉回复活
    #[test]
    fn delete_propagation_hash_match() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "删除笔记").unwrap();
        note_write_op(&phone, &p.path, "内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除（本地 UI 路径：entry_delete_op → 回收站 + tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        assert!(load_tombstones(dA.path()).iter().any(|t| t.path == p.path));

        // A 回合：删除传播到服务器（/delete → 服务器回收站 + 服务器 tombstone）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "A 报告删除: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(
            load_tombstones(phone_dir.path()).iter().any(|t| t.path == p.path),
            "服务器应记 tombstone"
        );
        assert!(!phone_dir.path().join(&p.path).exists(), "服务器原路径应已软删");

        // B 回合：服务器 tombstone → B 本地软删 + 记本地 tombstone
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "B 报告删除: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dB.path().join(&p.path).exists(), "B 本地应软删");
        assert!(load_tombstones(dB.path()).iter().any(|t| t.path == p.path));

        // 铁律：三端回收站都有（内容未丢）
        for (label, vault) in [("A", dA.path()), ("B", dB.path()), ("服务器", phone_dir.path())] {
            let trash = vault.join(fs_ops::TRASH_DIR);
            let found = std::fs::read_dir(&trash)
                .unwrap()
                .flatten()
                .any(|e| {
                    e.path().is_file()
                        && std::fs::read_to_string(e.path())
                            .map(|c| c == "内容")
                            .unwrap_or(false)
                });
            assert!(found, "{label} 回收站应保留被删内容");
        }

        // 后续回合：不拉回复活（M2 会复活，M3b 修掉）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.iter().all(|x| x != &p.path), "不得拉回已删文件: {r:?}");
        assert!(!dA.path().join(&p.path).exists());
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.iter().all(|x| x != &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
    }

    /// 删后编辑：编辑更新（mtime > 删除时刻）→ 推送复活，服务器 D4 清 tombstone
    #[test]
    fn delete_vs_edit_edit_newer_resurrects() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "复活笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除并同步（服务器 tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        let del_ms = load_tombstones(dA.path())
            .into_iter()
            .find(|t| t.path == p.path)
            .unwrap()
            .mtime_ms;
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // B 离线编辑（mtime 晚于删除时刻）
        note_write_op(&deskB, &p.path, "B 的新编辑").unwrap();
        set_mtime(&deskB, &p.path, del_ms + 3_600_000);

        // B 回合：服务器 tombstone vs 本地编辑 → 编辑赢 → 推送复活
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "B 应推送复活: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 的新编辑");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "B 的新编辑");
        assert!(
            load_tombstones(phone_dir.path()).iter().all(|t| t.path != p.path),
            "服务器 D4：复活后 tombstone 应清除"
        );

        // A 回合：拉回复活后的 P；本地 tombstone 被 D4（服务器编辑更新）清除
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.iter().any(|x| x == &p.path), "A 应拉回复活文件: {r:?}");
        assert_eq!(std::fs::read_to_string(dA.path().join(&p.path)).unwrap(), "B 的新编辑");
        assert!(load_tombstones(dA.path()).iter().all(|t| t.path != p.path), "A 的 tombstone 应清除");
    }

    /// 删后编辑：删除更新（编辑 mtime < 删除时刻）→ 本地再软删，内容进回收站
    #[test]
    fn delete_vs_edit_delete_newer_soft_deletes() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "删除赢笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // B 先离线编辑（mtime 旧）
        note_write_op(&deskB, &p.path, "B 的旧编辑").unwrap();
        let old_ms = fs_ops::now_ms() - 3_600_000;
        set_mtime(&deskB, &p.path, old_ms);

        // A 删除（晚于编辑）并同步
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // B 回合：编辑（旧）vs 删除（新）→ 删除赢 → B 软删 + 本地 tombstone
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "B 应软删: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dB.path().join(&p.path).exists(), "B 原路径应消失");
        let trash = dB.path().join(fs_ops::TRASH_DIR);
        let kept = std::fs::read_dir(&trash)
            .unwrap()
            .flatten()
            .any(|e| {
                e.path().is_file()
                    && std::fs::read_to_string(e.path())
                        .map(|c| c == "B 的旧编辑")
                        .unwrap_or(false)
            });
        assert!(kept, "铁律：B 的旧编辑内容必须留在回收站");
        // 终态：三端都没有该文件，不复活
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.iter().all(|x| x != &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
        assert!(!dA.path().join(&p.path).exists(), "A 端保持删除");
    }

    /// 平手（编辑 mtime == 删除时刻）→ 编辑恒赢（删除元组 size=0）
    #[test]
    fn delete_vs_edit_tie_edit_wins() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "平手笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (_dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除并同步（服务器墓碑时间 = /delete 处理时刻，B 回合看到的就是它）
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let del_ms = load_tombstones(phone_dir.path())
            .into_iter()
            .find(|t| t.path == p.path)
            .unwrap()
            .mtime_ms;

        // B 编辑，mtime 恰好 == 服务器删除时刻（平手）
        note_write_op(&deskB, &p.path, "B 平手编辑").unwrap();
        set_mtime(&deskB, &p.path, del_ms);

        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "平手时编辑必须赢（size=0 规则）: {r:?}");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 平手编辑");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "B 平手编辑");
    }

    /// 双方已删 → 跳过，无错误无复活
    #[test]
    fn delete_both_sides_already_deleted_skip() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "双删笔记").unwrap();
        note_write_op(&phone, &p.path, "内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除 + 同步；B 直接删除（未同步，服务器已有 tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        entry_delete_op(&deskB, &p.path).unwrap();

        // B 回合：双方已删 → 静默跳过
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.pulled.iter().all(|x| x != &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
        // A 再回合：无动作
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dA.path().join(&p.path).exists());
    }

    /// D4：删除后同路径重新创建 → tombstone 清除，文件推送复活
    #[test]
    fn d4_recreation_clears_tombstone() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "重建笔记").unwrap();
        note_write_op(&phone, &p.path, "旧内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除 + 同步（服务器 tombstone），然后同路径重建（create_note → D4 清本地 tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let created = note_create_op(&deskA, "", "重建笔记").unwrap();
        assert_eq!(created.path, p.path, "同路径重建: {:?}", created.path);
        note_write_op(&deskA, &created.path, "重建内容").unwrap();
        assert!(
            load_tombstones(dA.path()).iter().all(|t| t.path != p.path),
            "D4：重建后本地 tombstone 应清除"
        );

        // A 回合：推送重建内容（base 空）→ 服务器 D4 清 tombstone
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(
            load_tombstones(phone_dir.path()).iter().all(|t| t.path != p.path),
            "服务器 tombstone 应清除"
        );
        // B 回合：正常拉取（当作新文件），无删除传播
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.is_empty(), "{r:?}");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "重建内容");
    }

    /// TTL：30 天以上的 tombstone 回合开头清理；新鲜 tombstone 保留
    #[test]
    fn tombstone_ttl_purge() {
        let (_dir, desk) = client_vault();
        let vault = desk.vault.lock().unwrap().clone().unwrap();
        let now = fs_ops::now_ms();

        crate::sync::record_tombstone(&vault, "过期.md", "h1", now - crate::sync::TOMBSTONE_TTL_MS - 1).unwrap();
        crate::sync::record_tombstone(&vault, "新鲜.md", "h2", now - 86_400_000).unwrap();
        assert_eq!(load_tombstones(&vault).len(), 2);

        let removed = crate::sync::purge_expired_tombstones(&vault, now).unwrap();
        assert_eq!(removed, 1);
        let kept = load_tombstones(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].path, "新鲜.md");
    }

    /// 文件夹删除：tombstone 展开为文件级 → 三端内容全部软删（铁律）
    #[test]
    fn folder_delete_expands_tombstones() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let f = folder_create_op(&phone, "", "项目").unwrap();
        let n1 = note_create_op(&phone, &f.path, "笔记一").unwrap();
        let n2 = note_create_op(&phone, &f.path, "笔记二").unwrap();
        note_write_op(&phone, &n1.path, "一").unwrap();
        note_write_op(&phone, &n2.path, "二").unwrap();
        let asset = asset_save_op(&phone, &b64_encode(b"dir-asset"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删整个文件夹
        entry_delete_op(&deskA, &f.path).unwrap();
        let ts = load_tombstones(dA.path());
        for expected in [&n1.path, &n2.path] {
            assert!(ts.iter().any(|t| t.path == *expected), "文件夹应展开为文件 tombstone: {ts:?}");
        }
        assert!(ts.iter().all(|t| t.path != asset), "根级附件不得被文件夹展开波及: {ts:?}");

        // A 回合：传播到服务器
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!phone_dir.path().join(&n1.path).exists(), "服务器 n1 应软删");
        assert!(!phone_dir.path().join(&n2.path).exists(), "服务器 n2 应软删");
        assert!(phone_dir.path().join(&asset).exists(), "根级附件必须存活");

        // B 回合：服务器 tombstone → B 本地软删
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dB.path().join(&n1.path).exists(), "B n1 应软删: {r:?}");
        assert!(!dB.path().join(&n2.path).exists(), "B n2 应软删");
        assert!(dB.path().join(&asset).exists(), "B 根级附件必须存活");
        // 铁律：B 回收站保留文件夹内 2 个文件内容
        let trash = dB.path().join(fs_ops::TRASH_DIR);
        let contents: Vec<Vec<u8>> = std::fs::read_dir(&trash)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .filter_map(|e| std::fs::read(e.path()).ok())
            .collect();
        for expect in ["一".as_bytes().to_vec(), "二".as_bytes().to_vec()] {
            assert!(contents.iter().any(|c| *c == expect), "B 回收站缺内容: {expect:?}");
        }

        // 终态：三端快照一致（文件夹内笔记全没了，根级附件都在）
        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        assert!(snap_phone.iter().all(|(k, _)| !k.starts_with(&f.path)));
        assert!(snap_phone.contains_key(&asset));
    }

    /// 回收站恢复（mtime 保留旧值）→ 删除仍然有效：再软删，不复活
    #[test]
    fn stale_restore_from_trash_keeps_deletion() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "恢复笔记").unwrap();
        note_write_op(&phone, &p.path, "内容甲").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // 删除 + 同步（服务器 tombstone）
        let trash_path = entry_delete_op(&deskA, &p.path).unwrap();
        let del_ms = load_tombstones(dA.path())
            .into_iter()
            .find(|t| t.path == p.path)
            .unwrap()
            .mtime_ms;
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // 从回收站恢复（fs::rename，mtime 保留删除前 < del_ms）
        let abs = dA.path().join(&p.path);
        std::fs::rename(dA.path().join(&trash_path), &abs).unwrap();
        assert!(crate::sync::meta_mtime_ms(&abs) <= del_ms, "恢复文件 mtime 应保留旧值");

        // 回合：陈旧恢复 → 再软删（删除仍有效），不推不拉
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.pushed.iter().all(|x| x != &p.path), "陈旧恢复不得推送: {r:?}");
        assert!(!abs.exists(), "应再软删");
        // 服务器也仍然没有
        assert!(!phone_dir.path().join(&p.path).exists());
    }

    /// 恢复后再编辑（mtime > 删除时刻）→ D4 复活，推送服务器
    #[test]
    fn restore_and_edit_resurrects() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "恢复编辑笔记").unwrap();
        note_write_op(&phone, &p.path, "内容甲").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除 + 同步；恢复 + 编辑（mtime 新）
        let trash_path = entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let abs = dA.path().join(&p.path);
        std::fs::rename(dA.path().join(&trash_path), &abs).unwrap();
        note_write_op(&deskA, &p.path, "恢复后的编辑").unwrap(); // 编辑 → mtime = now > 删除时刻

        // A 回合：D4 清 tombstone + 推送复活
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "应推送复活: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "恢复后的编辑");
        // B 回合：拉取
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.iter().any(|x| x == &p.path), "{r:?}");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "恢复后的编辑");
    }

    /// 重命名 = 旧路径删除传播 + 新路径推送（内容保留，铁律）
    #[test]
    fn rename_propagates_old_path_deletion() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "改名前").unwrap();
        note_write_op(&phone, &p.path, "保留的内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 重命名
        let new_rel = entry_rename_op(&deskA, &p.path, "改名后").unwrap();
        assert_ne!(new_rel, p.path);
        assert!(load_tombstones(dA.path()).iter().any(|t| t.path == p.path), "旧路径应记 tombstone");

        // A 回合：旧路径 /delete + 新路径推送
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "旧路径应传播删除: {r:?}");
        assert!(r.pushed.iter().any(|x| x == &new_rel), "新路径应推送: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!phone_dir.path().join(&p.path).exists(), "服务器旧路径应消失");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&new_rel)).unwrap(), "保留的内容");

        // B 回合：旧路径软删 + 新路径拉取
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
        assert_eq!(std::fs::read_to_string(dB.path().join(&new_rel)).unwrap(), "保留的内容");
        // 铁律：B 回收站保留旧路径内容
        let trash = dB.path().join(fs_ops::TRASH_DIR);
        let kept = std::fs::read_dir(&trash)
            .unwrap()
            .flatten()
            .any(|e| {
                e.path().is_file()
                    && std::fs::read_to_string(e.path())
                        .map(|c| c == "保留的内容")
                        .unwrap_or(false)
            });
        assert!(kept, "B 回收站应保留旧路径内容");
    }

    /// 旧服务器（无 /tombstones）→ 404 按空列表处理，不报错
    #[test]
    fn fetch_tombstones_404_degrades_to_empty() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                listener.set_nonblocking(true).unwrap();
                let tl = tokio::net::TcpListener::from_std(listener).unwrap();
                // 空路由 = 模拟旧服务器（任何路径 404）
                let _ = axum::serve(tl, axum::Router::new()).await;
            });
        });
        let c = client();
        let base = format!("http://127.0.0.1:{port}");
        // 等就绪
        for _ in 0..40 {
            if c.get(format!("{base}/api/v1/info")).send().is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let ts = fetch_tombstones(&c, &base, "any-token").unwrap();
        assert!(ts.is_empty(), "404 必须按空列表处理");
    }

    #[test]
    fn sync_round_asset_pull_and_dedup() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let asset = asset_save_op(&phone, &b64_encode(b"binary-image-data"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token };

        let r = sync_round(&desk, &profile).unwrap();
        assert_eq!(r.pulled, vec![asset.clone()]);
        // 内容一致
        assert_eq!(
            std::fs::read(desk_dir.path().join(&asset)).unwrap(),
            b"binary-image-data".to_vec()
        );
    }

    #[test]
    fn sync_round_fails_gracefully_without_vault_or_server() {
        let (_dir, desk) = client_vault();
        let profile = ServerProfile { id: "s".into(), name: "x".into(), url: "http://127.0.0.1:1".into(), token: "t".into() };
        let err = sync_round(&desk, &profile).unwrap_err();
        assert!(!err.is_empty());

        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), phone);
        let (token, _) = pair(&base, &code).unwrap();
        // 无 vault 的 state
        let empty = Arc::new(AppState::default());
        let profile2 = ServerProfile { id: "s".into(), name: "x".into(), url: base, token };
        assert!(sync_round(&empty, &profile2).is_err());
    }

    #[test]
    fn sync_creates_parent_dirs_and_preserves_asset_names() {
        // 回归（真机验收发现）：对端「空库」没有父目录 / 附件不是内容寻址名
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        // 手机端只有一篇根目录笔记；桌面端有「目录/笔记」和「assets/人名.png」
        let phone_note = note_create_op(&phone, "", "手机笔记").unwrap();
        note_write_op(&phone, &phone_note.path, "手机内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let folder = crate::commands::folder_create_op(&desk, "", "工作").unwrap();
        let desk_note = note_create_op(&desk, &folder.path, "会议纪要").unwrap();
        note_write_op(&desk, &desk_note.path, "# 纪要\n\n内容").unwrap();
        let asset_path = "assets/示例图片.png";
        std::fs::create_dir_all(desk_dir.path().join("assets")).unwrap();
        std::fs::write(desk_dir.path().join(asset_path), "fake-png-数据".as_bytes()).unwrap();
        // 非 UTF-8 的 .md（如 GBK 编码的外来文件）也必须能同步（hash 按字节）
        let foreign = "工作/GBK笔记.md";
        std::fs::write(desk_dir.path().join(foreign), [0xC4, 0xE3, 0xBA, 0xC3]).unwrap();

        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token: token.clone() };

        let r = sync_round(&desk, &profile).unwrap();
        assert!(r.errors.is_empty(), "应无错误: {:?}", r.errors);
        // 推送：工作/会议纪要.md + GBK笔记.md + 附件（+ 根目录无重名文件）
        assert_eq!(r.pushed.len(), 3, "推送 3 个: {r:?}");
        assert_eq!(r.pulled.len(), 1, "拉取手机笔记: {r:?}");

        // 服务器侧：父目录被创建、附件保留人名、GBK 文件字节原样
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&desk_note.path)).unwrap(), "# 纪要\n\n内容");
        assert_eq!(std::fs::read(phone_dir.path().join(asset_path)).unwrap(), "fake-png-数据".as_bytes().to_vec());
        assert_eq!(std::fs::read(phone_dir.path().join(foreign)).unwrap(), vec![0xC4, 0xE3, 0xBA, 0xC3]);

        // 服务器 manifest 与 pull 字节一致（修复1+2：磁盘真相）
        let c = client();
        let manifest = fetch_manifest(&c, &base, &token).unwrap();
        let asset_meta = manifest.iter().find(|m| m.path == asset_path).unwrap();
        let served = std::fs::read(phone_dir.path().join(asset_path)).unwrap();
        assert_eq!(asset_meta.hash, crate::fs_ops::content_hash(&served));

        // 终态：再跑一轮全跳过
        let r2 = sync_round(&desk, &profile).unwrap();
        assert!(r2.pulled.is_empty() && r2.pushed.is_empty() && r2.conflicts.is_empty(), "{r2:?}");
        assert_eq!(r2.skipped, 4);
    }

    #[test]
    fn manifest_reflects_external_disk_changes() {
        // 回归（真机验收发现）：磁盘被外部改动后（DB 未更新），manifest 必须反映磁盘
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "外部改动").unwrap();
        note_write_op(&phone, &note.path, "初始内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();

        // 外部直接改文件（绕过 write_note，DB 保持旧值）
        std::fs::write(phone_dir.path().join(&note.path), "外部改过的内容").unwrap();

        let c = client();
        let manifest = fetch_manifest(&c, &base, &token).unwrap();
        let meta = manifest.iter().find(|m| m.path == note.path).unwrap();
        assert_eq!(
            meta.hash,
            crate::fs_ops::content_hash("外部改过的内容".as_bytes()),
            "manifest 必须反映磁盘"
        );
        // pull 服务的 hash 与内容一致（客户端校验必过）
        let (files, missing) = pull_batch(&c, &base, &token, &[note.path.clone()]).unwrap();
        assert!(missing.is_empty());
        assert_eq!(files[0].hash, crate::fs_ops::content_hash("外部改过的内容".as_bytes()));
    }

    #[test]
    fn normalize_url_rules() {
        assert_eq!(normalize_url(" http://1.2.3.4:4180/ ").unwrap(), "http://1.2.3.4:4180");
        assert!(normalize_url("https://x").is_err(), "M2 仅明文 http");
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("1.2.3.4").is_err());
        assert!(normalize_url("").is_err());
    }
}
