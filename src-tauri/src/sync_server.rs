//! M2 手机端同步服务器：axum + JSON over HTTP，监听 0.0.0.0:4180（被占则 +1 重试）。
//! 手机 = 局域网同步中心节点；桌面端（客户端）发现/配对后驱动双向同步回合。
//! 端点幂等可重放；token 仅防误连（docs/05：TLS+证书固定推迟到 M4）。
//!
//! 并发说明：单客户端串行同步（锁在客户端侧），文件写入走 M1 的 tmp+rename，
//! handler 内联阻塞 IO 在当前量级（1e3-1e4 文件）是毫秒级，可接受。

use std::collections::HashMap;
use std::net::{TcpListener, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::{self, CmdResult};
use crate::fs_ops;
use crate::sync::{
    b64_decode, b64_encode, local_manifest, write_conflict_copy, FileMeta, PullFile, PullRequest,
    PullResponse, PushFile, PushResult, Tombstone,
};
use crate::vault::AppState;

pub const SERVICE_TYPE: &str = "_lanmark._tcp.local.";
pub const DEFAULT_PORT: u16 = 4180;
/// 生产单实例下 10 个足够；测试并行各起常驻服务器（无停机机制），
/// 范围太窄会 AddrInUse（M3 测试矩阵扩到 80+ 后 4180..4200 已不够，再放宽）
const MAX_PORT_TRIES: u16 = 60;

/// vault 内同步元数据（.lanmark/sync.json）：设备名 + 配对码 + 已发 token
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub device_name: String,
    pub pairing_code: String,
    #[serde(default)]
    pub tokens: Vec<String>,
}

fn sync_config_path(vault: &std::path::Path) -> PathBuf {
    vault.join(fs_ops::META_DIR).join("sync.json")
}

pub fn load_sync_config(vault: &std::path::Path) -> SyncConfig {
    std::fs::read_to_string(sync_config_path(vault))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| {
            let cfg = SyncConfig {
                device_name: "Lanmark 手机".into(),
                pairing_code: gen_pairing_code(),
                tokens: Vec::new(),
            };
            let _ = save_sync_config(vault, &cfg);
            cfg
        })
}

pub fn save_sync_config(vault: &std::path::Path, cfg: &SyncConfig) -> std::io::Result<()> {
    let path = sync_config_path(vault);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // tmp+rename 原子写（tmp 名含 pid+序号，与笔记落盘同纪律）
    fs_ops::atomic_write(
        &path,
        serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?.as_bytes(),
    )?;
    Ok(())
}

/// 8 位数字配对码：sha256(time_ns + pid + vault path) 取数字，防误连足够（M4 前不加密）
fn gen_pairing_code() -> String {
    let mut material = format!(
        "{}{}{:?}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id(),
        std::env::temp_dir()
    );
    use sha2::{Digest, Sha256};
    // 混入指针地址增加熵（同一纳秒内两次调用的场景）
    material.push_str(&format!("{:p}", &material));
    let hash = Sha256::digest(material.as_bytes());
    hash.iter().map(|b| (b % 10).to_string()).collect::<Vec<_>>()[..8]
        .concat()
}

fn gen_token(code: &str) -> String {
    use sha2::{Digest, Sha256};
    let material = format!(
        "{code}{}{}{:p}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id(),
        code,
    );
    let hash = Sha256::digest(material.as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

/// 服务器上下文：AppState + 内存中的 sync 配置（落盘 .lanmark/sync.json）
pub struct ServerCtx {
    pub app: Arc<AppState>,
    pub cfg: Mutex<SyncConfig>,
    /// /pair 爆破保护：连续失败计数 + 锁定截止时间
    pair_guard: Mutex<PairGuard>,
}

#[derive(Default)]
pub(crate) struct PairGuard {
    failures: u32,
    locked_until: Option<std::time::Instant>,
}

/// 8 位数字配对码仅 10^8 组合，LAN 内可被脚本穷尽 → 失败退避锁定
const PAIR_MAX_FAILURES: u32 = 10;
const PAIR_LOCK_SECS: u64 = 60;

impl ServerCtx {
    pub fn new(app: Arc<AppState>, cfg: SyncConfig) -> Self {
        Self { app, cfg: Mutex::new(cfg), pair_guard: Mutex::new(PairGuard::default()) }
    }

    fn vault(&self) -> Result<PathBuf, String> {
        self.app
            .vault
            .lock()
            .map_err(|_| "vault 锁中毒".to_string())?
            .clone()
            .ok_or_else(|| "尚未打开 vault".to_string())
    }

    /// 从**当前** vault 实时加载 sync 配置（磁盘为真相；切换 vault 后
    /// 配对码/token 立即跟随新库，而不是停留在首次 spawn 时的旧库）
    fn current_config(&self) -> Result<(PathBuf, SyncConfig), (StatusCode, String)> {
        let vault = self.vault().map_err(|e| (StatusCode::CONFLICT, e))?;
        let cfg = load_sync_config(&vault);
        Ok((vault, cfg))
    }

    fn check_token(&self, headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = auth.strip_prefix("Bearer ").unwrap_or("");
        if token.is_empty() {
            return Err((StatusCode::UNAUTHORIZED, "缺少 token（先 /api/v1/pair）".into()));
        }
        // cfg 锁兼作 /pair 写配置的串行化锁；配置本体从当前 vault 实时读
        let cfg = {
            let _serial = self
                .cfg
                .lock()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "配置锁中毒".into()))?;
            self.current_config()?.1
        };
        let ok = cfg.tokens.iter().any(|t| const_eq(t, token));
        if ok {
            Ok(())
        } else {
            Err((StatusCode::FORBIDDEN, "token 无效（服务器可能重启过或已切换笔记库，重新配对）".into()))
        }
    }
}

/// 轻量统计（/info 用）：设备名读当前 vault 的 sync.json，笔记数走 DB 计数、
/// 附件数浅层计数——不逐文件 sha256（那是 local_manifest 的重活；/info 无鉴权，
/// 单线程 runtime 上被刷请求会停摆整个服务器）
fn light_stats(app: &Arc<AppState>) -> (String, u64, u64) {
    let vault = match app.vault.lock().ok().and_then(|g| g.clone()) {
        Some(v) => v,
        None => return (String::new(), 0, 0),
    };
    let cfg = load_sync_config(&vault);
    let mut notes = 0i64;
    if let Ok(guard) = app.db.lock() {
        if let Some(c) = guard.as_ref() {
            notes = c
                .query_row("SELECT COUNT(*) FROM files WHERE is_note=1", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap_or(0);
        }
    }
    let assets = std::fs::read_dir(vault.join(fs_ops::ASSETS_DIR))
        .map(|d| {
            d.filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_type()
                        .map(|ft| ft.is_file() && !ft.is_symlink())
                        .unwrap_or(false)
                })
                .count() as u64
        })
        .unwrap_or(0);
    (cfg.device_name, notes as u64, assets)
}

/// 常量时间字符串比较（token 校验，避免时序侧信道）
fn const_eq(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    if x.len() != y.len() {
        return false;
    }
    x.iter().zip(y).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

// ---------- 端点 ----------

/// GET /api/v1/info —— 无需鉴权：设备名 + vault 统计（不含任何笔记数据）
async fn info(State(ctx): State<Arc<ServerCtx>>) -> impl IntoResponse {
    let app = ctx.app.clone();
    let (name, notes, assets) = tokio::task::spawn_blocking(move || light_stats(&app))
        .await
        .unwrap_or((String::new(), 0, 0));
    Json(json!({
        "app": "lanmark",
        "name": name,
        "notes": notes,
        "assets": assets,
        "requiresPairing": true,
    }))
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
}

/// POST /api/v1/pair —— 配对码换 token（token 持久化，服务器重启后仍有效）
/// 爆破保护：连续 PAIR_MAX_FAILURES 次失败 → 锁定 PAIR_LOCK_SECS 秒
async fn pair(
    State(ctx): State<Arc<ServerCtx>>,
    Json(body): Json<PairBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // 锁定检查（guard 锁单独持有，不与 cfg 锁叠加）
    {
        let guard = ctx
            .pair_guard
            .lock()
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "配置锁中毒".into()))?;
        if let Some(until) = guard.locked_until {
            if let Some(rem) = until.checked_duration_since(std::time::Instant::now()) {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    format!("配对尝试过于频繁，{} 后重试", rem.as_secs()),
                ));
            }
        }
    }

    // cfg 锁串行化「读码→追加 token→落盘」，防并发配对丢失更新；
    // 配置本体从当前 vault 实时读（切库后旧库的码/token 不再有效）
    let serial = ctx.cfg.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "配置锁中毒".into()))?;
    let (vault, mut cfg) = ctx.current_config()?;
    if body.code.trim() != cfg.pairing_code {
        drop(serial);
        let mut guard = ctx.pair_guard.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "配置锁中毒".into()))?;
        guard.failures += 1;
        if guard.failures >= PAIR_MAX_FAILURES {
            guard.locked_until = Some(
                std::time::Instant::now() + std::time::Duration::from_secs(PAIR_LOCK_SECS),
            );
            guard.failures = 0;
        }
        return Err((StatusCode::FORBIDDEN, "配对码错误".into()));
    }
    // 成功：复位失败计数
    if let Ok(mut g) = ctx.pair_guard.lock() {
        g.failures = 0;
        g.locked_until = None;
    }
    let token = gen_token(&cfg.pairing_code);
    cfg.tokens.push(token.clone());
    let res = save_sync_config(&vault, &cfg).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("保存配置失败: {e}")));
    drop(serial);
    res?;
    Ok(Json(json!({ "token": token, "name": cfg.device_name })))
}

/// GET /api/v1/manifest —— 全量清单（notes + assets）
async fn manifest(
    State(ctx): State<Arc<ServerCtx>>,
    headers: HeaderMap,
) -> Result<Json<Vec<FileMeta>>, (StatusCode, String)> {
    ctx.check_token(&headers)?;
    // 每回合客户端必先拉 manifest → 记「最近回合」（手机端面板展示）
    ctx.app.last_sync_round_at.store(crate::fs_ops::now_ms(), std::sync::atomic::Ordering::Relaxed);
    // 重活（读全库 + 逐文件 sha256）移出单线程 runtime，防服务器停摆
    let app = ctx.app.clone();
    let list = tokio::task::spawn_blocking(move || local_manifest(&app))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("同步任务异常: {e}")))?
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(Json(list))
}

/// POST /api/v1/pull —— 按路径取文件内容（base64）；仅服务当前清单内的路径
async fn pull(
    State(ctx): State<Arc<ServerCtx>>,
    headers: HeaderMap,
    Json(req): Json<PullRequest>,
) -> Result<Json<PullResponse>, (StatusCode, String)> {
    ctx.check_token(&headers)?;
    // 重活（manifest + 读文件 + 编码）移出单线程 runtime，防服务器停摆
    let ctx2 = ctx.clone();
    let (files, missing) = tokio::task::spawn_blocking(move || pull_blocking(&ctx2, &req.paths))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("同步任务异常: {e}")))?
        .map_err(|(s, m)| (s, m))?;
    Ok(Json(PullResponse { files, missing }))
}

/// pull 阻塞主体（spawn_blocking 内执行）
fn pull_blocking(
    ctx: &Arc<ServerCtx>,
    paths: &[String],
) -> Result<(Vec<PullFile>, Vec<(String, String)>), (StatusCode, String)> {
    let vault = ctx.vault().map_err(|e| (StatusCode::CONFLICT, e))?;
    let current = local_manifest(&ctx.app).map_err(|e| (StatusCode::CONFLICT, e))?;
    let by_path: HashMap<String, FileMeta> =
        current.into_iter().map(|m| (m.path.clone(), m)).collect();

    let mut files = Vec::new();
    let mut missing = Vec::new();
    for path in paths {
        let Some(meta) = by_path.get(path) else {
            missing.push((path.clone(), "不在服务器清单中".into()));
            continue;
        };
        let abs = match fs_ops::safe_join(&vault, path) {
            Ok(a) => a,
            Err(e) => {
                missing.push((path.clone(), e.to_string()));
                continue;
            }
        };
        match std::fs::read(&abs) {
            Ok(bytes) => files.push(PullFile {
                path: path.clone(),
                kind: meta.kind.clone(),
                content_base64: b64_encode(&bytes),
                // 实际字节 hash：与所发内容严格一致，DB/清单可能因外部改动过时
                hash: fs_ops::content_hash(&bytes),
                mtime_ms: meta.mtime_ms,
            }),
            Err(e) => missing.push((path.clone(), format!("读取失败: {e}"))),
        }
    }
    Ok((files, missing))
}

#[derive(Deserialize)]
pub struct PushBody {
    pub files: Vec<PushFile>,
}

/// POST /api/v1/push —— 客户端推送更新。
/// 冲突判定（M3a 起，docs/07 §5.1）：服务器现 hash ≠ base_hash（含 base 空 + 文件已存在）
/// → 版本元组 (mtime, size, hash) 仲裁：来件新 → 来件落原路径、原版本改名保留；
/// 来件旧/平手 → 来件改名保留、原路径不动（serverHash 回传操作后最终 hash）。
/// 内容 hash 校验不符则拒绝该文件。
async fn push(
    State(ctx): State<Arc<ServerCtx>>,
    headers: HeaderMap,
    Json(body): Json<PushBody>,
) -> Result<Json<Vec<PushResult>>, (StatusCode, String)> {
    ctx.check_token(&headers)?;
    // 逐文件落盘（含 DB 写）移出单线程 runtime
    let ctx2 = ctx.clone();
    let results = tokio::task::spawn_blocking(move || push_blocking(&ctx2, &body.files))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("同步任务异常: {e}")))?
        .map_err(|(s, m)| (s, m))?;
    Ok(Json(results))
}

/// push 阻塞主体（spawn_blocking 内执行）
fn push_blocking(
    ctx: &Arc<ServerCtx>,
    files: &[PushFile],
) -> Result<Vec<PushResult>, (StatusCode, String)> {
    let vault = ctx.vault().map_err(|e| (StatusCode::CONFLICT, e))?;
    let mut results = Vec::new();

    for pf in files {
        let result = write_pushed_file(ctx, &vault, pf);
        match result {
            Ok(Landed { conflict_saved_as, server_hash }) => results.push(PushResult {
                path: pf.path.clone(),
                ok: true,
                error: None,
                conflict_saved_as,
                server_hash: Some(server_hash),
            }),
            Err(e) => results.push(PushResult {
                path: pf.path.clone(),
                ok: false,
                error: Some(e),
                conflict_saved_as: None,
                server_hash: None,
            }),
        }
    }
    Ok(results)
}

/// push 落盘结果：冲突副本去向 + 原路径**操作后的最终 hash**（docs/07 §3）
struct Landed {
    conflict_saved_as: Option<String>,
    server_hash: String,
}

/// 服务器侧 push 仲裁（docs/07 §5.1，M3a 核心语义变更）：
/// 当前 P 存在且 hash ≠ base_hash（含 base 为空 + 文件已存在 = 竞态创建窗口，
/// 修掉 M2 该场景静默覆盖的洞）→ 版本元组 (mtime_ms, size, hash) 与当前 P 比较：
/// - 来件更大 → 来件赢：当前 P 存为服务器侧冲突副本，来件落原路径（M2 既有行为）
/// - 来件更小/平手 → 来件降级：来件存冲突副本，当前 P 保留（serverHash = 当前 hash）
/// 返回 None = 无需仲裁（文件不存在或 base 与现状一致 → 干净落盘）。
///
/// 序列化前提不变：runtime 单线程、handler 天然串行，仲裁的检查-落盘无竞态。
fn arbitrate_existing(
    vault: &std::path::Path,
    conn: &rusqlite::Connection,
    kind: &str,
    pf: &PushFile,
    incoming_bytes: &[u8],
) -> Result<Option<Landed>, String> {
    let abs = match fs_ops::resolve_in_vault(vault, &pf.path) {
        Ok(a) if a.is_file() => a,
        _ => return Ok(None),
    };
    // 读原始字节（非 UTF-8 文件 M2 走 read_note 会 Err 而静默跳过仲裁）
    let cur_bytes = std::fs::read(&abs).map_err(|e| format!("读取当前版本失败: {e}"))?;
    let cur_hash = fs_ops::content_hash(&cur_bytes);
    if cur_hash == pf.base_hash {
        return Ok(None);
    }
    let incoming = (pf.mtime_ms, incoming_bytes.len() as i64, pf.hash.as_str());
    let current = (crate::sync::meta_mtime_ms(&abs), cur_bytes.len() as i64, cur_hash.as_str());
    if crate::sync::version_gt(incoming, current) {
        // 来件赢：当前 P → 冲突副本（进索引），移除原位置，来件随后落原路径
        let saved = write_conflict_copy(vault, conn, &pf.path, kind, &cur_bytes, fs_ops::now_ms())
            .map_err(|e| format!("冲突副本落盘失败: {e}"))?;
        if let Err(e) = std::fs::remove_file(&abs) {
            log::warn!("同步: 仲裁胜出后移除原路径 {} 失败: {e}", pf.path);
        }
        Ok(Some(Landed {
            conflict_saved_as: Some(saved),
            server_hash: pf.hash.clone(),
        }))
    } else {
        // 来件降级（更旧/平手）：来件 → 冲突副本，当前 P 保留（铁律：双份都在）
        let saved = write_conflict_copy(vault, conn, &pf.path, kind, incoming_bytes, fs_ops::now_ms())
            .map_err(|e| format!("冲突副本落盘失败: {e}"))?;
        Ok(Some(Landed {
            conflict_saved_as: Some(saved),
            server_hash: cur_hash,
        }))
    }
}

/// 单文件落盘逻辑（阻塞，从 handler 分离便于测试）
fn write_pushed_file(
    ctx: &Arc<ServerCtx>,
    vault: &std::path::Path,
    pf: &PushFile,
) -> Result<Landed, String> {
    // 点目录（.lanmark/ 等）禁止写入：否则远程可写 .lanmark/evil.md 进索引
    // 并每回合重复拉取，或污染元数据目录
    if has_dot_segment(&pf.path) {
        return Err("点目录路径禁止同步".into());
    }
    let bytes = b64_decode(&pf.content_base64)?;
    // 内容完整性：hash 必须与内容一致
    let actual_hash = fs_ops::content_hash(&bytes);
    if actual_hash != pf.hash {
        return Err(format!("内容 hash 不符（声称 {} 实际 {}）", pf.hash, &actual_hash[..16.min(actual_hash.len())]));
    }

    match pf.kind.as_str() {
        "note" => {
            if !pf.path.ends_with(".md") {
                return Err("笔记必须以 .md 结尾".into());
            }
            let conn_guard = ctx
                .app
                .db
                .lock()
                .map_err(|_| "DB 锁中毒".to_string())?;
            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
            // M3a 仲裁：baseHash 与现状不符 → mtime 元组裁决（取代 M2 无条件改名）
            let landed = match arbitrate_existing(vault, conn, "note", pf, &bytes)? {
                Some(l) if l.server_hash != pf.hash => {
                    // 来件被降级：原路径保留，来件已成副本 → 不落盘
                    return Ok(l);
                }
                other => other,
            };
            // 同步场景父目录可能尚不存在（对端先建的笔记在其目录里）；
            // 目录须通过符号链接逃逸校验（否则 create_dir_all 会在 vault 外建目录）
            if let Some(parent) = fs_ops::resolve_in_vault(vault, &pf.path)
                .map_err(|e| e.to_string())?
                .parent()
                .map(|p| p.to_path_buf())
            {
                std::fs::create_dir_all(&parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            // write_note：tmp+rename 原子落盘 + 更新索引（非 UTF-8 字节级保真）
            match std::str::from_utf8(&bytes) {
                Ok(content) => fs_ops::write_note(vault, &pf.path, content, conn),
                Err(_) => fs_ops::write_note_bytes(vault, &pf.path, &bytes, conn),
            }
            .map_err(|e| format!("写入失败: {e}"))?;
            // LWW 时间源保真（docs/07 §2）：保留源端保存时间，服务器 mtime 不得是落地时刻
            if let Ok(abs) = fs_ops::resolve_in_vault(vault, &pf.path) {
                fs_ops::set_file_mtime(&abs, pf.mtime_ms);
            }
            Ok(Landed {
                conflict_saved_as: landed.and_then(|l| l.conflict_saved_as),
                server_hash: pf.hash.clone(),
            })
        }
        "asset" => {
            // 附件按原路径落盘（内容 hash 已在上方验证）：vault 里的附件可能
            // 不是内容寻址名（Obsidian 导入/演示库的人名文件），路径即身份。
            // M3a 起附件同样参与 mtime 仲裁（堵 M2 同路径不同内容静默覆盖的洞）
            if !pf.path.starts_with("assets/") || pf.path.contains("..") {
                return Err(format!("附件路径非法: {}", pf.path));
            }
            let conn_guard = ctx
                .app
                .db
                .lock()
                .map_err(|_| "DB 锁中毒".to_string())?;
            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
            let landed = match arbitrate_existing(vault, conn, "asset", pf, &bytes)? {
                Some(l) if l.server_hash != pf.hash => {
                    // 来件被降级：原路径保留，来件已成副本 → 不落盘
                    return Ok(l);
                }
                other => other,
            };
            let abs = fs_ops::resolve_in_vault(vault, &pf.path).map_err(|e| e.to_string())?;
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            std::fs::write(&abs, &bytes).map_err(|e| format!("附件写入失败: {e}"))?;
            // LWW 时间源保真（docs/07 §2）：同笔记分支
            fs_ops::set_file_mtime(&abs, pf.mtime_ms);
            // M3b D4：push 干净落盘/仲裁获胜 → 清除该路径 tombstone（笔记分支经 write_note 自动清）
            if let Err(e) = crate::sync::clear_tombstone_if_present(vault, &pf.path) {
                log::warn!("清 tombstone 失败 {}: {e}", pf.path);
            }
            Ok(Landed {
                conflict_saved_as: landed.and_then(|l| l.conflict_saved_as),
                server_hash: pf.hash.clone(),
            })
        }
        other => Err(format!("未知类型: {other}")),
    }
}

/// 路径任一段以 `.` 开头（.lanmark、.obsidian…）
fn has_dot_segment(path: &str) -> bool {
    path.split('/').any(|seg| seg.starts_with('.'))
}

/// GET /api/v1/tombstones —— 删除墓碑列表（需鉴权；docs/07 §3）。
/// 旧服务器无此端点 → 404，客户端按空列表处理（删除传播静默关闭，退化 M2 行为）。
/// 顺带做 TTL 清理（30 天，惰性执行）。
async fn tombstones(
    State(ctx): State<Arc<ServerCtx>>,
    headers: HeaderMap,
) -> Result<Json<Vec<Tombstone>>, (StatusCode, String)> {
    ctx.check_token(&headers)?;
    let app = ctx.app.clone();
    let list = tokio::task::spawn_blocking(move || -> Result<Vec<Tombstone>, (StatusCode, String)> {
        let vault = ctx2_vault(&app)?;
        let now = crate::fs_ops::now_ms();
        crate::sync::purge_expired_tombstones(&vault, now)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("tombstone 清理失败: {e}")))?;
        Ok(crate::sync::load_tombstones(&vault))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("同步任务异常: {e}")))?;
    Ok(Json(list?))
}

/// 当前 vault（阻塞线程内用）
fn ctx2_vault(app: &Arc<AppState>) -> Result<PathBuf, (StatusCode, String)> {
    app.vault
        .lock()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "vault 锁中毒".to_string()))?
        .clone()
        .ok_or_else(|| (StatusCode::CONFLICT, "尚未打开 vault".to_string()))
}

#[derive(Deserialize)]
struct DeleteBody {
    paths: Vec<String>,
}

/// POST /api/v1/delete —— 软删（入回收站，铁律永不硬删）。M2 同步回合不主动调用。
async fn delete_files(
    State(ctx): State<Arc<ServerCtx>>,
    headers: HeaderMap,
    Json(body): Json<DeleteBody>,
) -> Result<Json<Vec<PushResult>>, (StatusCode, String)> {
    ctx.check_token(&headers)?;
    let app = ctx.app.clone();
    // 软删是 fs + DB 阻塞操作，移出单线程 runtime
    let results =
        tokio::task::spawn_blocking(move || delete_blocking(&app, &body.paths))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("同步任务异常: {e}")))?;
    Ok(Json(results))
}

/// delete 阻塞主体（spawn_blocking 内执行）
fn delete_blocking(app: &Arc<AppState>, paths: &[String]) -> Vec<PushResult> {
    let mut results = Vec::new();
    for path in paths {
        // 点目录禁止删除：.lanmark/lanmark.db（索引事实）与 sync.json（全体凭据）
        // 被删 = 同步体系自我 DoS
        if has_dot_segment(path) {
            results.push(PushResult {
                path: path.clone(),
                ok: false,
                error: Some("点目录路径禁止删除".into()),
                conflict_saved_as: None,
                server_hash: None,
            });
            continue;
        }
        match commands::entry_delete_op(app, path) {
            Ok(trash) => results.push(PushResult {
                path: path.clone(),
                ok: true,
                error: None,
                conflict_saved_as: Some(trash),
                server_hash: None,
            }),
            Err(e) => results.push(PushResult {
                path: path.clone(),
                ok: false,
                error: Some(e),
                conflict_saved_as: None,
                server_hash: None,
            }),
        }
    }
    results
}

pub fn router(ctx: Arc<ServerCtx>) -> Router {
    Router::new()
        .route("/api/v1/info", get(info))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/manifest", get(manifest))
        .route("/api/v1/pull", post(pull))
        .route("/api/v1/push", post(push))
        .route("/api/v1/delete", post(delete_files))
        .route("/api/v1/tombstones", get(tombstones))
        .with_state(ctx)
}

/// 绑定端口并开始服务（供测试与 spawn 共用）：4180 被占则 +1 重试。
/// 返回 (实际端口, TcpListener)。
pub fn bind_listener() -> std::io::Result<(u16, TcpListener)> {
    for port in DEFAULT_PORT..DEFAULT_PORT + MAX_PORT_TRIES {
        match TcpListener::bind(("0.0.0.0", port)) {
            Ok(l) => return Ok((port, l)),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        format!("{DEFAULT_PORT}..{} 全部被占", DEFAULT_PORT + MAX_PORT_TRIES),
    ))
}

/// mDNS fullname（`设备名._lanmark._tcp.local.`）→ 实例名（还原转义的 `.`）
pub fn service_instance_name(fullname: &str) -> String {
    fullname.trim_end_matches('.').replace("\\.", ".")
}

/// 生产启动：独立线程 + 单线程 tokio runtime（不依赖 tauri runtime 的 feature 组合）。
/// 返回实际端口。幂等：已启动则直接返回端口。服务器随进程存活（M2 无停止需求）。
pub fn spawn(app: Arc<AppState>) -> Result<u16, String> {
    // 幂等：Android 端 vault 每次打开都会调；进程重建后状态归零会重新走到这里
    {
        let port = app.sync_port.lock().map_err(|_| "锁中毒".to_string())?;
        if let Some(p) = *port {
            return Ok(p);
        }
    }
    let (port, listener) = bind_listener().map_err(|e| format!("绑定端口失败: {e}"))?;
    // 先记端口再起线程：并发的幂等检查在 bind 后立即生效，避免双绑
    *app.sync_port.lock().map_err(|_| "锁中毒".to_string())? = Some(port);
    let vault = app
        .vault
        .lock()
        .map_err(|_| "vault 锁中毒".to_string())?
        .clone()
        .ok_or("尚未打开 vault")?;
    let cfg = load_sync_config(&vault);
    // 保留一份 app 引用给线程退出路径复位 sync_port（否则服务器死后
    // UI 仍报 running，且 spawn 幂等早退无法自愈）
    let app_for_cleanup = Arc::clone(&app);
    let ctx = Arc::new(ServerCtx::new(app, cfg));

    // mDNS 广播（best effort；Android 需 multicast lock，失败不阻断服务器）
    let mdns_name = {
        let cfg = ctx.cfg.lock().map_err(|_| "锁中毒".to_string())?;
        cfg.device_name.clone()
    };
    advertise_mdns(port, mdns_name);

    std::thread::Builder::new()
        .name("lanmark-sync-server".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("同步服务器 runtime 启动失败: {e}");
                    reset_sync_port(&app_for_cleanup);
                    return;
                }
            };
            let serve_failed = rt.block_on(async move {
                match serve_on(listener, ctx).await {
                    Ok(_) => false,
                    Err(e) => {
                        eprintln!("同步服务器退出: {e}");
                        true
                    }
                }
            });
            if serve_failed {
                reset_sync_port(&app_for_cleanup);
            }
        })
        .map_err(|e| format!("启动同步服务器线程失败: {e}"))?;
    Ok(port)
}

/// 服务器线程退出后把 sync_port 置回 None（自愈：下次 sync_server_start 可重新绑定）
fn reset_sync_port(app: &Arc<AppState>) {
    if let Ok(mut p) = app.sync_port.lock() {
        *p = None;
    }
}

/// std listener → tokio listener → axum serve（spawn 与测试共用）
pub(crate) async fn serve_on(
    listener: std::net::TcpListener,
    ctx: Arc<ServerCtx>,
) -> std::io::Result<()> {
    // tokio 要求 fd 先行 nonblocking（否则 panic，tokio#7172）
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, router(ctx)).await
}

/// mDNS 注册 _lanmark._tcp（服务名 = 设备名）。失败仅记日志。
fn advertise_mdns(port: u16, name: String) {
    std::thread::Builder::new()
        .name("lanmark-mdns".into())
        .spawn(move || {
            let result = (|| -> Result<(), String> {
                let mdns = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
                let host = {
                    // 本机局域网地址作 host 提示；enable_addr_auto 会按网卡实际发送
                    let ip = local_lan_ip().unwrap_or_else(|| "lanmark".into());
                    format!("{ip}.")
                };
                let props = [("app", "lanmark")];
                let service = mdns_sd::ServiceInfo::new(
                    SERVICE_TYPE,
                    &name,
                    &host,
                    (), // addr_auto：地址按网卡动态填充
                    port,
                    &props[..],
                )
                .map_err(|e| e.to_string())?
                .enable_addr_auto();
                mdns.register(service).map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(e) = result {
                eprintln!("mDNS 广播失败（可用手输 URL 兜底）: {e}");
            }
        })
        .ok();
}

/// 本机局域网 IPv4（UDP connect 技巧，不真正发包）
fn local_lan_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip().to_string())
}

// ---------- Tauri 命令 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPairingInfo {
    pub running: bool,
    pub port: Option<u16>,
    pub device_name: String,
    pub pairing_code: String,
    /// 最近一次客户端回合时间（unix ms；服务器重启后为 None）
    #[serde(default)]
    pub last_round_at: Option<i64>,
}

/// 同步服务器状态 + 配对信息（手机端 UI 展示）
#[tauri::command]
pub fn sync_pairing_info(state: tauri::State<'_, Arc<AppState>>) -> CmdResult<SyncPairingInfo> {
    let port = *state.sync_port.lock().map_err(|_| "锁中毒")?;
    let vault = state
        .vault
        .lock()
        .map_err(|_| "锁中毒")?
        .clone()
        .ok_or("尚未打开 vault")?;
    let cfg = load_sync_config(&vault);
    // 最近回合时间（进程内状态：服务器/应用重启后归零，属展示信息）
    let last_round_at = {
        let t = state.last_sync_round_at.load(std::sync::atomic::Ordering::Relaxed);
        (t > 0).then_some(t)
    };
    Ok(SyncPairingInfo {
        running: port.is_some(),
        port,
        device_name: cfg.device_name,
        pairing_code: cfg.pairing_code,
        last_round_at,
    })
}

/// vault 内冲突副本计数（docs/07 §6 手机端可发现性）：
/// 笔记走 DB 索引（路径含「冲突」，无逐文件 hash），附件浅层扫描。
#[tauri::command]
pub fn sync_conflict_count(state: tauri::State<'_, Arc<AppState>>) -> CmdResult<u32> {
    let vault = state
        .vault
        .lock()
        .map_err(|_| "锁中毒")?
        .clone()
        .ok_or("尚未打开 vault")?;
    let mut count = 0u32;
    if let Ok(guard) = state.db.lock() {
        if let Some(c) = guard.as_ref() {
            if let Ok(n) = c.query_row(
                "SELECT COUNT(*) FROM files WHERE is_note=1 AND path LIKE '%冲突%'",
                [],
                |r| r.get::<_, i64>(0),
            ) {
                count += n as u32;
            }
        }
    }
    if let Ok(d) = std::fs::read_dir(vault.join(fs_ops::ASSETS_DIR)) {
        for e in d.flatten() {
            if e.file_name().to_string_lossy().contains("冲突") {
                count += 1;
            }
        }
    }
    Ok(count)
}

/// 启动同步服务器（幂等；Android 端在 vault 打开后自动调用，桌面端可手动开）
#[tauri::command]
pub fn sync_server_start(state: tauri::State<'_, Arc<AppState>>) -> CmdResult<u16> {
    spawn(state.inner().clone())
}

// ---------- 测试工具（跨模块共享） ----------

/// 测试用：在独立线程 + current_thread runtime 上起 axum 服务器（与生产 spawn 同构）。
/// 用普通 #[test] 而非 #[tokio::test]：reqwest blocking client 的内部 runtime
/// 不能在异步上下文里 drop（tokio blocking/shutdown panic）。
#[cfg(test)]
pub(crate) mod test_util {
    use super::*;
    use std::path::Path;

    pub(crate) fn start_phone_server(phone_vault: &Path, app: Arc<AppState>) -> (String, String) {
        let (port, listener) = bind_listener().unwrap();
        let cfg = load_sync_config(phone_vault);
        let code = cfg.pairing_code.clone();
        let ctx = Arc::new(ServerCtx::new(app, cfg));
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let _ = serve_on(listener, ctx).await;
            });
        });
        (format!("http://127.0.0.1:{port}"), code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_code_is_8_digits_and_varies() {
        let a = gen_pairing_code();
        let b = gen_pairing_code();
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_digit()));
        assert_ne!(a, b, "连续两次生成应不同");
    }

    /// 回归：/pair 爆破保护——连续失败 PAIR_MAX_FAILURES 次后锁定，
    /// 期间连正确码也拒绝（429）。8 位数字码仅 10^8 组合，
    /// LAN 内脚本数小时可穷尽，无退避 = 同步体系裸奔
    /// 回归：切换 vault 后配对配置必须实时跟随当前库（此前 ServerCtx.cfg
    /// 停在首次 spawn 的旧库：UI 显示新库的码、服务器校验旧 token，永远 403）
    #[test]
    fn vault_switch_updates_pairing_live() {
        use crate::commands::open_vault_at;
        let dir_a = tempfile::TempDir::new().unwrap();
        let dir_b = tempfile::TempDir::new().unwrap();
        let app = Arc::new(AppState::default());
        open_vault_at(&app, dir_a.path()).unwrap();
        let (base, code_a) = test_util::start_phone_server(dir_a.path(), Arc::clone(&app));
        let client = reqwest::blocking::Client::new();
        wait_ready(&client, &base);

        let paired: serde_json::Value = client
            .post(format!("{base}/api/v1/pair"))
            .json(&json!({ "code": code_a }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        let token_a = paired["token"].as_str().unwrap().to_string();

        // 切库（服务器不重启，随 ctx.app 跟随）
        open_vault_at(&app, dir_b.path()).unwrap();
        let code_b = load_sync_config(dir_b.path()).pairing_code;
        assert_ne!(code_a, code_b, "两库配对码应独立");

        // 旧库 token 对新库无效
        let r = client
            .get(format!("{base}/api/v1/manifest"))
            .header("authorization", format!("Bearer {token_a}"))
            .send()
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN, "旧库 token 应被拒");

        // 新库码（UI 从当前库读）配对成功且可用
        let paired_b: serde_json::Value = client
            .post(format!("{base}/api/v1/pair"))
            .json(&json!({ "code": code_b }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        let token_b = paired_b["token"].as_str().unwrap().to_string();
        let r = client
            .get(format!("{base}/api/v1/manifest"))
            .header("authorization", format!("Bearer {token_b}"))
            .send()
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK, "新库 token 应可用");
    }

    #[test]
    fn const_eq_semantics() {
        assert!(const_eq("abc", "abc"));
        assert!(const_eq("", ""));
        assert!(!const_eq("abc", "abd"));
        assert!(!const_eq("abc", "ab"));
        assert!(!const_eq("a", ""));
    }

    #[test]
    fn pair_locks_after_repeated_failures() {
        use crate::commands::open_vault_at;
        let dir = tempfile::TempDir::new().unwrap();
        let app = Arc::new(AppState::default());
        open_vault_at(&app, dir.path()).unwrap();
        let (base, code) = test_util::start_phone_server(dir.path(), app);
        let client = reqwest::blocking::Client::new();
        wait_ready(&client, &base);

        for i in 0..PAIR_MAX_FAILURES {
            let r = client
                .post(format!("{base}/api/v1/pair"))
                .json(&json!({ "code": "00000000" }))
                .send()
                .unwrap();
            assert_eq!(r.status(), StatusCode::FORBIDDEN, "第 {i} 次应为 403");
        }
        // 锁定：连正确码也 429
        let r = client
            .post(format!("{base}/api/v1/pair"))
            .json(&json!({ "code": code }))
            .send()
            .unwrap();
        assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = r.text().unwrap();
        assert!(body.contains("后重试"), "{body}");
    }

    #[test]
    fn sync_config_roundtrip_and_defaults() {
        let dir = tempfile::TempDir::new().unwrap();
        let vault = dir.path();
        // 首次读取自动生成并落盘
        let cfg1 = load_sync_config(vault);
        assert_eq!(cfg1.pairing_code.len(), 8);
        assert!(cfg1.tokens.is_empty());
        // 第二次读取同一份（不再重新生成）
        let cfg2 = load_sync_config(vault);
        assert_eq!(cfg1.pairing_code, cfg2.pairing_code);
        // 修改后往返
        let mut cfg3 = cfg2.clone();
        cfg3.tokens.push("tok123".into());
        cfg3.device_name = "测试机".into();
        save_sync_config(vault, &cfg3).unwrap();
        let cfg4 = load_sync_config(vault);
        assert_eq!(cfg4.tokens, vec!["tok123".to_string()]);
        assert_eq!(cfg4.device_name, "测试机");
        assert!(sync_config_path(vault).exists());
    }

    #[test]
    fn server_end_to_end_pair_manifest_pull_push_conflict() {
        use crate::commands::open_vault_at;

        let dir = tempfile::TempDir::new().unwrap();
        let app = Arc::new(AppState::default());
        open_vault_at(&app, dir.path()).unwrap();

        // 手机端建一篇笔记 + 一个附件
        let note = commands::note_create_op(&app, "", "手机笔记").unwrap();
        commands::note_write_op(&app, &note.path, "手机端内容").unwrap();
        let asset = commands::asset_save_op(&app, &b64_encode(b"phone-bytes"), "png").unwrap();

        let (base, code) = test_util::start_phone_server(dir.path(), Arc::clone(&app));

        // 用 blocking reqwest 模拟桌面客户端（与 sync_client 同一 HTTP 栈）
        let client = reqwest::blocking::Client::new();
        wait_ready(&client, &base);

        // 1. info 无需鉴权
        let info: serde_json::Value = client.get(format!("{base}/api/v1/info")).send().unwrap().json().unwrap();
        assert_eq!(info["app"], "lanmark");
        assert!(info["notes"].as_u64().unwrap() >= 1);

        // 2. 未配对时 manifest 拒绝
        let r = client.get(format!("{base}/api/v1/manifest")).send().unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);

        // 3. 错误配对码 → 403
        let r = client
            .post(format!("{base}/api/v1/pair"))
            .json(&json!({ "code": "00000000" }))
            .send()
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);

        // 4. 正确配对码 → token；token 持久化到 .lanmark/sync.json
        let paired: serde_json::Value = client
            .post(format!("{base}/api/v1/pair"))
            .json(&json!({ "code": code }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        let token = paired["token"].as_str().unwrap().to_string();
        let saved: SyncConfig =
            serde_json::from_str(&std::fs::read_to_string(sync_config_path(dir.path())).unwrap()).unwrap();
        assert_eq!(saved.tokens, vec![token.clone()]);

        let auth = format!("Bearer {token}");

        // 5. manifest 含笔记与附件
        let manifest: Vec<FileMeta> = client
            .get(format!("{base}/api/v1/manifest"))
            .header("authorization", &auth)
            .send()
            .unwrap()
            .json()
            .unwrap();
        let note_meta = manifest.iter().find(|m| m.path == note.path).expect("笔记在清单");
        assert_eq!(note_meta.hash, fs_ops::content_hash("手机端内容".as_bytes()));

        // 6. pull 取回内容
        let pulled: PullResponse = client
            .post(format!("{base}/api/v1/pull"))
            .header("authorization", &auth)
            .json(&json!({ "paths": [note.path, asset, ".lanmark/db"] }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(pulled.files.len(), 2);
        assert_eq!(b64_decode(&pulled.files[0].content_base64).unwrap(), "手机端内容".as_bytes());
        assert_eq!(pulled.missing.len(), 1, "清单外路径拒绝");
        assert_eq!(pulled.missing[0].0, ".lanmark/db");

        // 7. push 桌面版内容（base_hash = 服务器现 hash → 干净覆盖）
        let desktop_content = "桌面端内容";
        let pushed: Vec<PushResult> = client
            .post(format!("{base}/api/v1/push"))
            .header("authorization", &auth)
            .json(&json!({
                "files": [{
                    "path": note.path,
                    "kind": "note",
                    "contentBase64": b64_encode(desktop_content.as_bytes()),
                    "hash": fs_ops::content_hash(desktop_content.as_bytes()),
                    "mtimeMs": 123,
                    "baseHash": note_meta.hash,
                }]
            }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(pushed.len(), 1);
        assert!(pushed[0].ok, "push 应成功: {:?}", pushed[0].error);
        assert!(pushed[0].conflict_saved_as.is_none(), "base_hash 相同不是冲突");
        // M3a：干净落盘 → serverHash = 所推 hash
        let desktop_hash = fs_ops::content_hash(desktop_content.as_bytes());
        assert_eq!(pushed[0].server_hash.as_deref(), Some(desktop_hash.as_str()));
        let after = std::fs::read_to_string(dir.path().join(&note.path)).unwrap();
        assert_eq!(after, desktop_content);

        // 8. 仲裁（来件新）：base_hash 与服务器现 hash 不一致且来件 mtime 更新
        //    → 服务器版本改名保留 + 客户端内容落原路径（M2 行为保留，mtime 定向）
        let third = "第三方版本";
        let future_ms = fs_ops::now_ms() + 3_600_000;
        let pushed2: Vec<PushResult> = client
            .post(format!("{base}/api/v1/push"))
            .header("authorization", &auth)
            .json(&json!({
                "files": [{
                    "path": note.path,
                    "kind": "note",
                    "contentBase64": b64_encode(third.as_bytes()),
                    "hash": fs_ops::content_hash(third.as_bytes()),
                    "mtimeMs": future_ms,
                    "baseHash": "stale-hash".to_string(),
                }]
            }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(pushed2[0].ok, "冲突 push 也应成功: {:?}", pushed2[0].error);
        let conflict_path = pushed2[0].conflict_saved_as.clone().expect("应有冲突副本");
        assert!(conflict_path.contains("冲突"), "冲突命名: {conflict_path}");
        assert_eq!(pushed2[0].server_hash.as_deref(), Some(fs_ops::content_hash(third.as_bytes()).as_str()), "来件获胜 → serverHash = 所推 hash");
        // 双份都在：原路径 = 第三方版本，冲突副本 = 桌面版本
        assert_eq!(std::fs::read_to_string(dir.path().join(&note.path)).unwrap(), third);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&conflict_path)).unwrap(),
            desktop_content
        );
        // 冲突副本进了索引
        assert!(crate::db::get_file(
            app.db.lock().unwrap().as_ref().unwrap(),
            &conflict_path
        )
        .unwrap()
        .is_some());

        // 8b. 仲裁（来件旧）：来件 mtime 更旧 → 来件降级为冲突副本，原路径保留（M3a 新方向）
        let fourth = "更旧版本";
        let past_ms = fs_ops::now_ms() - 3_600_000;
        let current_hash = fs_ops::content_hash(third.as_bytes());
        let pushed2b: Vec<PushResult> = client
            .post(format!("{base}/api/v1/push"))
            .header("authorization", &auth)
            .json(&json!({
                "files": [{
                    "path": note.path,
                    "kind": "note",
                    "contentBase64": b64_encode(fourth.as_bytes()),
                    "hash": fs_ops::content_hash(fourth.as_bytes()),
                    "mtimeMs": past_ms,
                    "baseHash": "stale-hash-2".to_string(),
                }]
            }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(pushed2b[0].ok, "降级 push 也应成功（内容进副本）: {:?}", pushed2b[0].error);
        let loser_copy = pushed2b[0].conflict_saved_as.clone().expect("降级来件应有冲突副本");
        assert_ne!(loser_copy, conflict_path, "两次降级命名不撞: {loser_copy} vs {conflict_path}");
        // serverHash = 原路径现 hash（third），来件未落原路径
        assert_eq!(pushed2b[0].server_hash.as_deref(), Some(current_hash.as_str()));
        assert_eq!(std::fs::read_to_string(dir.path().join(&note.path)).unwrap(), third);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&loser_copy)).unwrap(),
            fourth
        );

        // 9. push 内容 hash 造假的被拒
        let pushed3: Vec<PushResult> = client
            .post(format!("{base}/api/v1/push"))
            .header("authorization", &auth)
            .json(&json!({
                "files": [{
                    "path": "伪造.md",
                    "kind": "note",
                    "contentBase64": b64_encode(b"x"),
                    "hash": "deadbeef".to_string(),
                    "mtimeMs": 1,
                    "baseHash": "",
                }]
            }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(!pushed3[0].ok);
        assert!(pushed3[0].error.as_deref().unwrap().contains("hash 不符"));

        // 10. delete → 回收站
        let deleted: Vec<PushResult> = client
            .post(format!("{base}/api/v1/delete"))
            .header("authorization", &auth)
            .json(&json!({ "paths": [note.path] }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(deleted[0].ok);
        assert!(deleted[0].conflict_saved_as.as_deref().unwrap().starts_with(".lanmark/trash/"));
        assert!(!dir.path().join(&note.path).exists());

        // 11. 点目录保护：push .lanmark/evil.md 拒绝（否则进索引并每回合重复拉取）
        let pushed4: Vec<PushResult> = client
            .post(format!("{base}/api/v1/push"))
            .header("authorization", &auth)
            .json(&json!({
                "files": [{
                    "path": ".lanmark/evil.md",
                    "kind": "note",
                    "contentBase64": b64_encode(b"# evil"),
                    "hash": fs_ops::content_hash(b"# evil"),
                    "mtimeMs": 1,
                    "baseHash": "",
                }]
            }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(!pushed4[0].ok, "点目录 push 必须拒绝");
        assert!(!dir.path().join(".lanmark/evil.md").exists());

        // 12. 点目录保护：delete .lanmark/lanmark.db / sync.json 拒绝（自我 DoS）
        let deleted2: Vec<PushResult> = client
            .post(format!("{base}/api/v1/delete"))
            .header("authorization", &auth)
            .json(&json!({ "paths": [".lanmark/lanmark.db", ".lanmark/sync.json"] }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(!deleted2[0].ok && !deleted2[1].ok, "点目录 delete 必须拒绝");
        assert!(dir.path().join(".lanmark/lanmark.db").exists(), "索引库必须还在");
    }

    /// M3a 仲裁单测（docs/07 §9：来件新 / 来件旧 / 平手三向）。
    /// 直接调 arbitrate_existing——HTTP 层无法钉住服务器侧文件的 mtime
    #[test]
    fn arbitrate_mtime_directions_and_tie() {
        use crate::commands::open_vault_at;

        let dir = tempfile::TempDir::new().unwrap();
        let app = Arc::new(AppState::default());
        open_vault_at(&app, dir.path()).unwrap();
        let guard = app.db.lock().unwrap();
        let conn = guard.as_ref().unwrap();
        let vault = dir.path();

        const T_MS: i64 = 1_700_000_000_000;
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(T_MS as u64);
        // 把当前 P 写成 content 并钉 mtime = T，返回其 hash
        let set_current = |content: &str| {
            fs_ops::write_note(vault, "p.md", content, conn).unwrap();
            let abs = vault.join("p.md");
            let times = std::fs::FileTimes::new().set_modified(t);
            std::fs::File::open(&abs).unwrap().set_times(times).unwrap();
            fs_ops::content_hash(content.as_bytes())
        };
        let make_pf = |path: &str, content: &str, mtime_ms: i64| PushFile {
            path: path.into(),
            kind: "note".into(),
            content_base64: b64_encode(content.as_bytes()),
            hash: fs_ops::content_hash(content.as_bytes()),
            mtime_ms,
            base_hash: "stale-base".into(),
        };

        // 1) 来件新 → 赢：当前 P → 冲突副本并移除（随后由调用方落来件）
        set_current("cur");
        let pf = make_pf("p.md", "newer", T_MS + 1_000);
        let landed = arbitrate_existing(vault, conn, "note", &pf, "newer".as_bytes())
            .unwrap()
            .expect("base 与现状不符必须仲裁");
        assert_eq!(landed.server_hash, pf.hash, "来件获胜 → serverHash = 所推 hash");
        assert!(!vault.join("p.md").exists(), "获胜后原路径已移除，等调用方落来件");
        let copy = landed.conflict_saved_as.unwrap();
        assert_eq!(std::fs::read_to_string(vault.join(&copy)).unwrap(), "cur");
        // 调用方落来件（write_pushed_file 流程）
        fs_ops::write_note(vault, "p.md", "newer", conn).unwrap();
        assert_eq!(std::fs::read_to_string(vault.join("p.md")).unwrap(), "newer");

        // 2) 来件旧 → 降级：当前 P 保留，来件 → 冲突副本
        let h_cur = set_current("cur2");
        let pf = make_pf("p.md", "older", T_MS - 1_000);
        let landed = arbitrate_existing(vault, conn, "note", &pf, "older".as_bytes())
            .unwrap()
            .expect("base 与现状不符必须仲裁");
        assert_eq!(landed.server_hash, h_cur, "来件降级 → serverHash = 原路径现 hash");
        assert_eq!(std::fs::read_to_string(vault.join("p.md")).unwrap(), "cur2");
        let copy = landed.conflict_saved_as.unwrap();
        assert_eq!(std::fs::read_to_string(vault.join(&copy)).unwrap(), "older");

        // 3) 平手（同 mtime 同 size）→ hash 字典序大者赢
        let h_c3 = set_current("cur3");
        let pf = make_pf("p.md", "cur4", T_MS);
        let landed = arbitrate_existing(vault, conn, "note", &pf, "cur4".as_bytes())
            .unwrap()
            .expect("平手也必须仲裁");
        if pf.hash > h_c3 {
            assert_eq!(landed.server_hash, pf.hash, "平手：hash 大者赢");
            let copy = landed.conflict_saved_as.unwrap();
            assert_eq!(std::fs::read_to_string(vault.join(&copy)).unwrap(), "cur3");
            fs_ops::write_note(vault, "p.md", "cur4", conn).unwrap();
            assert_eq!(std::fs::read_to_string(vault.join("p.md")).unwrap(), "cur4");
        } else {
            assert_eq!(landed.server_hash, h_c3, "平手：hash 小者降级");
            assert_eq!(std::fs::read_to_string(vault.join("p.md")).unwrap(), "cur3");
            let copy = landed.conflict_saved_as.unwrap();
            assert_eq!(std::fs::read_to_string(vault.join(&copy)).unwrap(), "cur4");
        }

        // 4) base 与现状一致 → 无需仲裁（干净落盘，即使来件 mtime 更新）
        let h_now = set_current("same");
        let mut pf = make_pf("p.md", "same", T_MS + 9999);
        pf.base_hash = h_now;
        assert!(
            arbitrate_existing(vault, conn, "note", &pf, "same".as_bytes())
                .unwrap()
                .is_none(),
            "base 匹配不得仲裁"
        );

        // 5) 当前 P 不存在 → 无需仲裁
        let pf = make_pf("fresh.md", "fresh", T_MS + 1);
        assert!(
            arbitrate_existing(vault, conn, "note", &pf, "fresh".as_bytes())
                .unwrap()
                .is_none()
        );
    }

    /// 等服务器就绪（最多 2s）
    fn wait_ready(client: &reqwest::blocking::Client, base: &str) {
        for _ in 0..40 {
            if client.get(format!("{base}/api/v1/info")).send().is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("服务器 2s 内未就绪");
    }
}
