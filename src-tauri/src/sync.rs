//! 同步共享层：协议类型、本地/远端清单构建、冲突命名。
//! 协议：文件级 sha256 版本对比、冲突保留双份（铁律：任何裁决都不得静默丢内容）、JSON over HTTP。
//! 服务器（手机 axum）与客户端（桌面）两侧共用，保证语义一致。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::commands::with_vault;
use crate::fs_ops;
use crate::vault::AppState;

/// 清单条目：一个同步单元（笔记或附件）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    /// "note" | "asset"
    pub kind: String,
    pub hash: String,
    pub mtime_ms: i64,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullFile {
    pub path: String,
    pub kind: String,
    pub content_base64: String,
    pub hash: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushFile {
    pub path: String,
    pub kind: String,
    pub content_base64: String,
    pub hash: String,
    pub mtime_ms: i64,
    /// 客户端所见的服务器旧版本 hash（空串 = 服务器无此文件）
    pub base_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub path: String,
    pub ok: bool,
    /// ok=false 时的错误信息
    pub error: Option<String>,
    /// 服务器侧原有版本被改名保留时的新路径（冲突命名）
    pub conflict_saved_as: Option<String>,
    /// 该路径在服务器上**操作后的最终 hash**（新增）：
    /// 干净落盘/来件仲裁获胜 = 所推 hash；来件被仲裁降级 = 原路径现有 hash。
    /// 旧服务器不返回该字段（None）→ 客户端退化行为（ok = 落盘）。
    #[serde(default)]
    pub server_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub files: Vec<PullFile>,
    /// 请求了但服务器没有/拒绝的路径 + 原因
    pub missing: Vec<(String, String)>,
}

/// 一次 LWW 自动合并：较新版留原路径，较旧版降级为可见冲突副本。
/// 报告仅 IPC 消费（非 wire 字段）；UI 据此展示「自动合并 N（较新留原名）」明细。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeEvent {
    pub path: String,
    /// "local" | "server"
    pub winner: String,
    /// 输家副本落成的原路径（进目录树，可点击打开）
    pub loser_copy: String,
    pub winner_mtime_ms: i64,
    /// 0 = 未知（如服务器侧被仲裁保留的旧版本 mtime 未随 wire 回传）
    pub loser_mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    /// LWW 自动合并明细（；的 Vec<String> 冲突列表由此取代）
    #[serde(default)]
    pub merges: Vec<MergeEvent>,
    /// 已同步的删除（本地软删 / 服务器 /delete，均进回收站）
    #[serde(default)]
    pub deleted: Vec<String>,
    pub skipped: usize,
    pub errors: Vec<String>,
    /// 另一回合正在跑（客户端串行锁），本次调用没有做任何事。
    /// 单独给字段而不是 Err：前端此前靠 `msg.includes("进行中")` 判，
    /// 文案一改就把「正常跳过的噪声」变成红色错误提示。
    #[serde(default)]
    pub busy: bool,
    /// 清单骤缩熔断：本回合未做任何拉取/推送/删除/写基线。
    /// 这是需要用户确认的正常安全状态，不是 Err（Err 会被自动循环静默重试）。
    #[serde(default)]
    pub blocked: Option<BlockedShrink>,
}

/// 清单骤缩熔断的现场快照（UI 展示 + 确认动作的输入）。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockedShrink {
    /// 本地清单里「上回合还有、本回合没有、且无墓碑」的数量
    pub local_missing: usize,
    /// 服务器清单里同上
    pub server_missing: usize,
    /// 本回合本地清单总数
    pub local_total: usize,
    /// 本回合服务器清单总数
    pub server_total: usize,
    /// 上回合基线里的路径总数（判定全灭用）
    pub prior_total: usize,
    /// 本地缺失路径（全量；UI 只展示前几条）
    pub local_paths: Vec<String>,
    /// 服务器缺失路径（全量；UI 只展示前几条）
    pub server_paths: Vec<String>,
    /// 触发熔断的绝对阈值（当前为 3）
    pub threshold: usize,
}

// ---------- tombstone（删除传播） ----------

/// 删除墓碑：一端删除 → 另一端软删（铁律：永不硬删）。
/// `mtime_ms` = 删除时刻（LWW 裁决时间源，与编辑侧的文件 mtime 比较）；
/// `deleted_at` = 删除时刻（TTL 清理依据）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub path: String,
    /// 被删版本的内容 hash（hash 相同 = 删后没再改 → 静默传播）
    pub hash: String,
    pub mtime_ms: i64,
    pub deleted_at: i64,
}

/// tombstone TTL：30 天
pub const TOMBSTONE_TTL_MS: i64 = 30 * 86_400_000;

fn tombstones_path(vault: &Path) -> std::path::PathBuf {
    // 与基线 sync-<id>.json 同模式（.lanmark/ 不参与同步，walk 跳过 dot 目录）
    vault.join(fs_ops::META_DIR).join("tombstones.json")
}

/// 读本地 tombstone（文件不可恢复 → 空列表）
pub fn load_tombstones(vault: &Path) -> Vec<Tombstone> {
    std::fs::read_to_string(tombstones_path(vault))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_tombstones(vault: &Path, list: &[Tombstone]) -> std::io::Result<()> {
    let path = tombstones_path(vault);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(list).map_err(std::io::Error::other)?;
    fs_ops::atomic_write(&path, json.as_bytes())
}

/// 记 tombstone（按 path upsert）。`deleted_ms` = 删除时刻
pub fn record_tombstone(vault: &Path, path: &str, hash: &str, deleted_ms: i64) -> std::io::Result<()> {
    record_tombstones(vault, &[(path.to_string(), hash.to_string())], deleted_ms)
}

/// 批量记 tombstone：**一次 load、批量 upsert、一次 atomic save**。
///
/// 文件夹删除/改名会给每个同步单元记墓碑；逐条调 `record_tombstone` 会把
/// `tombstones.json` 整读整写 N 次（大文件夹删除时主线程 I/O 成倍放大）。
/// 与逐条版同语义：同 path 覆盖旧墓碑，`deleted_ms` 统一为本批删除时刻。
pub fn record_tombstones(
    vault: &Path,
    entries: &[(String, String)],
    deleted_ms: i64,
) -> std::io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut list = load_tombstones(vault);
    // 先剔除本批涉及的旧条目（同 path 在批内重复时后写覆盖先写），再统一追加
    list.retain(|t| !entries.iter().any(|(p, _)| *p == t.path));
    for (path, hash) in entries {
        list.push(Tombstone {
            path: path.clone(),
            hash: hash.clone(),
            mtime_ms: deleted_ms,
            deleted_at: deleted_ms,
        });
    }
    save_tombstones(vault, &list)
}

/// D4：路径被（重新）创建 → 清除该路径 tombstone（不存在则无操作）
pub fn clear_tombstone_if_present(vault: &Path, path: &str) -> std::io::Result<()> {
    let list = load_tombstones(vault);
    let filtered: Vec<Tombstone> = list.iter().filter(|t| t.path != path).cloned().collect();
    if filtered.len() != list.len() {
        save_tombstones(vault, &filtered)?;
    }
    Ok(())
}

/// TTL 清理：删超过 30 天的 tombstone。返回清理数
pub fn purge_expired_tombstones(vault: &Path, now_ms: i64) -> std::io::Result<usize> {
    let list = load_tombstones(vault);
    let kept: Vec<Tombstone> = list
        .iter()
        .filter(|t| now_ms.saturating_sub(t.deleted_at) < TOMBSTONE_TTL_MS)
        .cloned()
        .collect();
    let removed = list.len() - kept.len();
    if removed > 0 {
        save_tombstones(vault, &kept)?;
    }
    Ok(removed)
}

// ---------- 清单 ----------

/// 清单构建失败的分类。服务器据此区分「扫描过程中文件刚好消失」（可重试）
/// 与「存储整体不可读」（503，别让客户端把空清单当成全库删除）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestErrorKind {
    NotFound,
    PermissionDenied,
    Other,
    /// 目录遍历/元数据读取失败（无法定位到单个文件）
    Walk,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    pub path: String,
    pub kind: ManifestErrorKind,
    pub detail: String,
}

impl ManifestError {
    fn new(path: &Path, err: &std::io::Error) -> Self {
        let kind = match err.kind() {
            std::io::ErrorKind::NotFound => ManifestErrorKind::NotFound,
            std::io::ErrorKind::PermissionDenied => ManifestErrorKind::PermissionDenied,
            _ => ManifestErrorKind::Other,
        };
        Self { path: path.display().to_string(), kind, detail: err.to_string() }
    }

    fn walk(err: std::io::Error) -> Self {
        Self { path: String::new(), kind: ManifestErrorKind::Walk, detail: err.to_string() }
    }

    /// 存储整体不可用（权限/遍历失败），而不是单个文件在扫描中消失。
    pub fn storage_unavailable(&self) -> bool {
        matches!(
            self.kind,
            ManifestErrorKind::PermissionDenied | ManifestErrorKind::Walk
        )
    }
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            write!(f, "清单构建失败: {}", self.detail)
        } else {
            write!(f, "清单读取失败 {}: {}", self.path, self.detail)
        }
    }
}

impl std::error::Error for ManifestError {}

/// 读一个同步单元（笔记/附件）的字节 + mtime + size。
///
/// 瞬时 IO 错误（文件被别的进程占用、刚被 rename）重试一次；仍失败则让整份
/// 清单失败。绝不能 `continue`：清单静默变短会被客户端当成「这些文件被删了」，
/// 进而补墓碑并让其他设备软删。失败关闭最多让本轮同步报错，下一轮还能重来。
fn read_file_meta(abs: &Path) -> Result<(Vec<u8>, i64, i64), ManifestError> {
    let mut last: Option<ManifestError> = None;
    for attempt in 0..2 {
        match std::fs::read(abs) {
            Ok(bytes) => match std::fs::metadata(abs) {
                Ok(m) => {
                    let mtime_ms = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    return Ok((bytes, mtime_ms, m.len() as i64));
                }
                Err(e) => last = Some(ManifestError::new(abs, &e)),
            },
            Err(e) => last = Some(ManifestError::new(abs, &e)),
        }
        if attempt == 0 {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    Err(last.expect("read_file_meta 至少尝试一次"))
}

/// 本地清单：笔记 walk 磁盘（vault 文件是唯一事实源），附件 walk assets/。
///
/// 不再查 DB：手机端（服务器）常驻期间只在开库 reindex，外部新建/删除/改名
/// 若以 DB 为准就同步不出去，外部删除还会被桌面「推回来」复活。
/// 逐文件读磁盘字节算 hash/mtime/size；读失败整份清单失败（fail-closed）。
pub fn local_manifest(state: &Arc<AppState>) -> Result<Vec<FileMeta>, ManifestError> {
    // 只在取路径时持锁：全库 walk + 逐文件 sha256 在 1e4 文件量级是秒级的，
    // 持着 vault 锁会让 check_token / /pair / /info 一起排队（此前就踩过）。
    // 路径是 clone 出去的快照，切库瞬间最多读到旧库的清单，下回合自然纠正。
    let vault: PathBuf = with_vault(state, |v| Ok(v.clone())).map_err(|e| ManifestError {
        path: String::new(),
        kind: ManifestErrorKind::Other,
        detail: e,
    })?;
    let mut out = Vec::new();
    {
        let vault = &vault;
        for path in fs_ops::collect_note_paths(vault).map_err(ManifestError::walk)? {
            let abs = vault.join(&path);
            let (bytes, mtime_ms, size) = read_file_meta(&abs)?;
            out.push(FileMeta {
                path,
                kind: "note".into(),
                hash: fs_ops::content_hash(&bytes),
                mtime_ms,
                size,
            });
        }
        // 附件：内容寻址（assets/<sha16>.<ext>），不进 DB，直接 walk
        for meta in asset_walk(vault)? {
            out.push(meta);
        }
    }
    Ok(out)
}

/// walk assets/，逐文件计算 sha256（内容寻址目录，文件数有限）
pub fn asset_walk(vault: &Path) -> Result<Vec<FileMeta>, ManifestError> {
    let mut out = Vec::new();
    let assets = vault.join(fs_ops::ASSETS_DIR);
    // 不能用 `!assets.is_dir()` 提前返回：is_dir() 对 EACCES 也返回 false，
    // 会把「附件目录不可读」静默当成「没有附件」。只把 NotFound 当空目录。
    match std::fs::metadata(&assets) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(ManifestError::new(&assets, &e)),
    }
    for entry in std::fs::read_dir(&assets).map_err(ManifestError::walk)? {
        let entry = entry.map_err(ManifestError::walk)?;
        // file_type 不跟随符号链接：assets/ 内的链接不进同步清单
        let ft = entry
            .file_type()
            .map_err(|e| ManifestError::new(&entry.path(), &e))?;
        if ft.is_symlink() || !ft.is_file() {
            continue;
        }
        // 原子写的半成品不进清单：tmp 在 rename 前一瞬存在，写失败时也可能残留；
        // 一旦被同步出去，对端会多一个永远修不好的孤儿附件。
        // 非 UTF-8 文件名同样跳过（与 collect_notes 同纪律：清单里表达不了）
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.ends_with(fs_ops::TMP_SUFFIX) {
            continue;
        }
        let path = entry.path();
        let (bytes, mtime_ms, size) = read_file_meta(&path)?;
        let rel = format!("{}/{}", fs_ops::ASSETS_DIR, name);
        out.push(FileMeta {
            path: rel,
            kind: "asset".into(),
            hash: fs_ops::content_hash(&bytes),
            mtime_ms,
            size,
        });
    }
    Ok(out)
}

// ---------- 版本元组（LWW 裁决） ----------

/// 版本元组：`(mtime_ms, size, hash_hex)`，字典序比较，**大者赢**。
/// mtime 不同 → mtime 新者赢；同毫秒 → size 大者赢；size 同 → hash 字典序大者赢
/// （hash 相同 = 内容相同，本不会进裁决）。删除参与裁决时取
/// `(tombstone.mtime_ms, 0, tombstone.hash)`——size 记 0，mtime 平手时编辑恒赢删除。
pub fn version_gt(a: (i64, i64, &str), b: (i64, i64, &str)) -> bool {
    (a.0, a.1, a.2) > (b.0, b.1, b.2)
}

/// 文件 mtime（unix 毫秒），读失败记 0（与 local_manifest 同口径）
pub fn meta_mtime_ms(abs: &Path) -> i64 {
    std::fs::metadata(abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- 冲突命名 ----------

/// 冲突副本命名：`<stem>-冲突<mmdd-HHMM>[N]<ext>`（UTC，唯一性优先）。
pub fn conflict_name(rel: &str, now_ms: i64, attempt: u32) -> String {
    let (dir, name) = match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    // unix ms → mmdd-HHMM（UTC，唯一性优先于时区语义）
    let secs = now_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    // 1970-01-01 是周四；算月日用简化 civil 算法
    let (mm, dd) = month_day(days);
    let stamp = format!(
        "{mm:02}{dd:02}-{hh:02}{mi:02}",
        hh = secs_of_day / 3600,
        mi = (secs_of_day % 3600) / 60
    );
    let suffix = if attempt == 0 {
        String::new()
    } else {
        format!("-{attempt}")
    };
    if dir.is_empty() {
        format!("{stem}-冲突{stamp}{suffix}{ext}")
    } else {
        format!("{dir}/{stem}-冲突{stamp}{suffix}{ext}")
    }
}

/// 冲突副本路径的解析结果（UI 列表/精确计数用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictCopyPath {
    /// 原始路径（相对 vault，含目录）
    pub original_path: String,
    /// `MMDD-HHMM`（UTC，与 `conflict_name` 同口径）
    pub stamp: String,
    /// 0 = 同分钟首个；N = 第 N 个（`-N` 后缀）
    pub attempt: u32,
}

/// 严格解析 `<stem>-冲突<MMDD>-<HHMM>[-N]<ext>`。
///
/// 与 `LIKE '%冲突%'` 相比，时间字段必须合法（月 01-12、日 01-31、时 00-23、
/// 分 00-59），普通文件名里的「冲突」不会误判。局限：用户手写一个恰好形如
/// `-冲突0917-0830` 的名字仍会被当成副本（无法与真实副本区分）。
/// 从右往左找标记，原文件名本身可以含「-冲突」。
pub fn parse_conflict_path(rel: &str) -> Option<ConflictCopyPath> {
    let (dir, name) = match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut search_end = stem.len();
    while let Some(pos) = stem[..search_end].rfind("-冲突") {
        let rest = &stem[pos + "-冲突".len()..];
        if let Some((stamp, attempt)) = parse_conflict_stamp(rest) {
            let original_stem = &stem[..pos];
            if !original_stem.is_empty() {
                let original_name = format!("{original_stem}{ext}");
                let original_path = if dir.is_empty() {
                    original_name
                } else {
                    format!("{dir}/{original_name}")
                };
                return Some(ConflictCopyPath { original_path, stamp, attempt });
            }
        }
        search_end = pos;
    }
    None
}

/// 解析 `MMDD-HHMM[-N]`（紧跟 `-冲突` 之后的部分）。
fn parse_conflict_stamp(rest: &str) -> Option<(String, u32)> {
    // 固定 9 字节 `MMDD-HHMM`，再跟可选的 `-N`
    if rest.len() < 9 || !rest.is_char_boundary(9) {
        return None;
    }
    let (stamp, tail) = rest.split_at(9);
    let (mmdd, hhmm) = stamp.split_once('-')?;
    if mmdd.len() != 4 || hhmm.len() != 4 {
        return None;
    }
    if !mmdd.bytes().chain(hhmm.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mm: u32 = mmdd[0..2].parse().ok()?;
    let dd: u32 = mmdd[2..4].parse().ok()?;
    let hh: u32 = hhmm[0..2].parse().ok()?;
    let mi: u32 = hhmm[2..4].parse().ok()?;
    if !(1..=12).contains(&mm) || !(1..=31).contains(&dd) || hh > 23 || mi > 59 {
        return None;
    }
    let attempt = match tail.strip_prefix('-') {
        Some(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => n.parse().ok()?,
        None if tail.is_empty() => 0,
        _ => return None,
    };
    Some((stamp.to_string(), attempt))
}

/// 天数（自 1970-01-01）→ (月, 日)，闰年规则完整
fn month_day(days: i64) -> (i64, i64) {
    // 400 年 = 146097 天，循环起点 1970-01-01
    let days = days.rem_euclid(146_097);
    let mut year = 1970 + 400 * (days / 146_097);
    let mut rest = days % 146_097;
    loop {
        let len = civil_year_len(year);
        if rest < len {
            break;
        }
        rest -= len;
        year += 1;
    }
    let leap = civil_year_len(year) == 366;
    let mdays = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut mm = 0usize;
    while rest >= mdays[mm] {
        rest -= mdays[mm];
        mm += 1;
    }
    (mm as i64 + 1, rest + 1)
}

fn civil_year_len(y: i64) -> i64 {
    if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
        366
    } else {
        365
    }
}

/// 把服务器版本落成本地冲突副本（笔记进索引；附件按冲突名落盘）。
/// 命名冲突时自动 -2、-3…。返回新相对路径。
pub fn write_conflict_copy(
    vault: &Path,
    conn: &rusqlite::Connection,
    rel: &str,
    kind: &str,
    bytes: &[u8],
    now_ms: i64,
) -> std::io::Result<String> {
    let mut attempt = 0u32;
    loop {
        let candidate = conflict_name(rel, now_ms, attempt);
        let abs = vault.join(&candidate);
        if abs.exists() {
            attempt += 1;
            if attempt > 100 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "冲突副本命名耗尽",
                ));
            }
            continue;
        }
        if kind == "note" {
            let content = String::from_utf8_lossy(bytes).to_string();
            // 直接落盘（不经 write_note 的原路径语义），再手工进索引。
            // 落盘用**原始字节**（非 UTF-8 服务器版本不损坏，与 hash 一致），
            // 索引 body 用 lossy 文本；tmp+rename 原子写，与笔记落盘同纪律
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            fs_ops::atomic_write(&abs, bytes)?;
            let title = fs_ops::extract_frontmatter_title(&content)
                .unwrap_or_else(|| fs_ops::title_from_stem(&candidate));
            crate::db::upsert_file(conn, &candidate, &title, &content, now_ms, &fs_ops::content_hash(bytes), true)
                .map_err(std::io::Error::other)?;
        } else {
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            fs_ops::atomic_write(&abs, bytes)?;
        }
        return Ok(candidate);
    }
}

// ---------- base64 ----------

pub fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("base64 解码失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// S5 配套：原子写的半成品不得进同步清单——否则会被当成新附件同步给
    /// 对端，而它随后被 rename 走/删除都不会传播，留下永远修不好的孤儿文件。
    #[test]
    fn asset_walk_skips_atomic_tmp() {
        let dir = tempfile::TempDir::new().unwrap();
        fs_ops::ensure_layout(dir.path()).unwrap();
        let assets = dir.path().join(fs_ops::ASSETS_DIR);
        std::fs::write(assets.join("ok.png"), b"png").unwrap();
        std::fs::write(
            assets.join(format!("ok.png.1.2{}", fs_ops::TMP_SUFFIX)),
            b"half",
        )
        .unwrap();

        let list = asset_walk(dir.path()).unwrap();
        assert_eq!(list.len(), 1, "tmp 不得进清单: {list:?}");
        assert_eq!(list[0].path, "assets/ok.png");
    }

    /// assets 路径存在但不是目录：必须报错（503），不能当成“没有附件”。
    /// 这正是 `is_dir()` 对 EACCES/ENOTDIR 一律 false 会引入的静默丢文件。
    #[test]
    fn asset_walk_rejects_assets_path_that_is_not_a_directory() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(fs_ops::ASSETS_DIR), b"not a dir").unwrap();

        let err = asset_walk(dir.path()).unwrap_err();
        assert_eq!(err.kind, ManifestErrorKind::Walk);
        assert!(err.storage_unavailable(), "应让 /manifest 回 503: {err:?}");
    }

    /// A1 回归：批量记墓碑 = 一次 load + 一次 atomic save。
    /// 此前 entry_delete 对文件夹里每个文件各调一次 `record_tombstone`，
    /// N 个文件就要整读整写 N 次 tombstones.json（大文件夹删除时主线程卡顿）。
    #[test]
    fn record_tombstones_batches_into_one_ledger() {
        let dir = tempfile::TempDir::new().unwrap();
        let vault = dir.path();
        fs_ops::ensure_layout(vault).unwrap();

        let entries = vec![
            ("工作/一.md".to_string(), "h1".to_string()),
            ("工作/二.md".to_string(), "h2".to_string()),
        ];
        record_tombstones(vault, &entries, 1_789_633_800_000).unwrap();

        let ts = load_tombstones(vault);
        assert_eq!(ts.len(), 2, "批量写入两条墓碑: {ts:?}");
        let by_path = |p: &str| ts.iter().find(|t| t.path == p).unwrap();
        assert_eq!(by_path("工作/一.md").hash, "h1");
        assert_eq!(by_path("工作/二.md").hash, "h2");
        assert!(ts.iter().all(|t| t.deleted_at == 1_789_633_800_000));

        // 账本只有一个文件，且内容是可整体反序列化的数组（不是多份拼接）
        let ledger = vault.join(".lanmark/tombstones.json");
        assert!(ledger.is_file(), "账本必须落盘");
        let raw = std::fs::read_to_string(&ledger).unwrap();
        let parsed: Vec<Tombstone> = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.len(), 2);

        // 第二批：同 path 覆盖（不膨胀），新 path 追加
        record_tombstones(
            vault,
            &[
                ("工作/一.md".to_string(), "h1b".to_string()),
                ("根.md".to_string(), "h3".to_string()),
            ],
            1_789_633_900_000,
        )
        .unwrap();
        let ts = load_tombstones(vault);
        assert_eq!(ts.len(), 3, "同路径覆盖、新路径追加: {ts:?}");
        let n1 = ts.iter().find(|t| t.path == "工作/一.md").unwrap();
        assert_eq!(n1.hash, "h1b", "同路径墓碑取最新一次");
        assert_eq!(n1.deleted_at, 1_789_633_900_000);

        // 空批次不写盘（清理路径不应凭空造账本）
        let empty_vault = tempfile::TempDir::new().unwrap();
        fs_ops::ensure_layout(empty_vault.path()).unwrap();
        record_tombstones(empty_vault.path(), &[], 1).unwrap();
        assert!(!empty_vault.path().join(".lanmark/tombstones.json").exists());
    }

    #[test]
    fn version_tuple_ordering() {
        // mtime 不同 → mtime 新者赢
        assert!(version_gt((2, 0, "a"), (1, 0, "b")));
        assert!(!version_gt((1, 0, "b"), (2, 0, "a")));
        // mtime 同 → size 大者赢
        assert!(version_gt((1, 10, "a"), (1, 5, "b")));
        assert!(!version_gt((1, 5, "b"), (1, 10, "a")));
        // size 同 → hash 字典序大者赢
        assert!(version_gt((1, 5, "cafe"), (1, 5, "beef")));
        assert!(!version_gt((1, 5, "beef"), (1, 5, "cafe")));
        // 完全相同 → 非严格大于（平手）
        assert!(!version_gt((1, 5, "cafe"), (1, 5, "cafe")));
    }

    #[test]
    fn conflict_name_format_and_suffix() {
        // 2026-09-17 08:30:00 UTC = 1789633800s
        let ms = 1_789_633_800_000i64;
        let n = conflict_name("工作/读书笔记.md", ms, 0);
        assert_eq!(n, "工作/读书笔记-冲突0917-0830.md");
        let n2 = conflict_name("工作/读书笔记.md", ms, 2);
        assert_eq!(n2, "工作/读书笔记-冲突0917-0830-2.md");
        // 无扩展名（文件夹场景）
        let n3 = conflict_name("图片", ms, 0);
        assert_eq!(n3, "图片-冲突0917-0830");
        // 根目录
        let n4 = conflict_name("README.md", ms, 0);
        assert_eq!(n4, "README-冲突0917-0830.md");
    }

    #[test]
    fn conflict_name_across_eras() {
        // 1970-01-01 00:00 UTC
        assert_eq!(conflict_name("a.md", 0, 0), "a-冲突0101-0000.md");
        // 2000-02-29（闰年）：951782400s = 2000-02-29 00:00 UTC
        let ms = 951_782_400_000i64;
        assert_eq!(conflict_name("b.md", ms, 0), "b-冲突0229-0000.md");
        // 2100-02-28（2100 非闰年）：4107456000s
        let ms2 = 4_107_456_000_000i64; // 2100-02-28 00:00 UTC
        assert_eq!(conflict_name("c.md", ms2, 0), "c-冲突0228-0000.md");
    }

    #[test]
    fn parse_conflict_path_roundtrip() {
        // 2026-09-17 08:30:00 UTC = 1789633800s
        let ms = 1_789_633_800_000i64;
        for attempt in [0u32, 2, 17] {
            let rel = conflict_name("工作/读书笔记.md", ms, attempt);
            let p = parse_conflict_path(&rel).expect("生成的副本名必须能解析回来");
            assert_eq!(p.original_path, "工作/读书笔记.md");
            assert_eq!(p.stamp, "0917-0830");
            assert_eq!(p.attempt, attempt);
        }
        // 无扩展名 + 根目录
        let rel = conflict_name("图片", ms, 0);
        let p = parse_conflict_path(&rel).unwrap();
        assert_eq!((p.original_path.as_str(), p.attempt), ("图片", 0));
        // 原名本身含「-冲突」：从右往左找标记
        let p = parse_conflict_path("a-冲突b-冲突0917-0830.md").unwrap();
        assert_eq!(p.original_path, "a-冲突b.md");
        // 多级目录
        let p = parse_conflict_path("笔记本/子目录/x-冲突0917-0830-2.md").unwrap();
        assert_eq!(p.original_path, "笔记本/子目录/x.md");
        assert_eq!(p.attempt, 2);
    }

    #[test]
    fn parse_conflict_path_rejects_non_copies() {
        for rel in [
            "冲突.md",                     // 普通文件名
            "笔记-冲突1317-0830.md",       // 月 13
            "笔记-冲突0932-0830.md",       // 日 32
            "笔记-冲突0917-2430.md",       // 时 24
            "笔记-冲突0917-0860.md",       // 分 60
            "笔记-冲突09170830.md",        // 缺分隔
            "笔记-冲突0917-0830-2-3.md",   // 多余后缀
            "笔记-冲突0917-0830foo.md",    // 时间后有多余字符
            "笔记-冲突0917-0830-.md",      // 空 attempt
            "-冲突0917-0830.md",           // 空 stem
            "目录-冲突0917/a.md",          // 标记在目录里
        ] {
            assert!(parse_conflict_path(rel).is_none(), "{rel} 不应判为副本");
        }
    }

    #[test]
    fn read_file_meta_missing_file_is_manifest_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = read_file_meta(&dir.path().join("不存在.md")).unwrap_err();
        assert_eq!(err.kind, ManifestErrorKind::NotFound);
        assert!(!err.storage_unavailable(), "单个文件消失是 409，不是 503");
    }

    #[test]
    fn local_manifest_notes_and_assets() {
        use crate::commands::open_vault_at;
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        let s = &state;

        let note = crate::commands::note_create_op(s, "", "笔记 A").unwrap();
        crate::commands::note_write_op(s, &note.path, "内容甲").unwrap();
        let asset = crate::commands::asset_save_op(s, &b64_encode(b"png-data"), "png").unwrap();

        let manifest = local_manifest(s).unwrap();
        let paths: Vec<&str> = manifest.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&note.path.as_str()), "笔记在清单: {paths:?}");
        assert!(paths.contains(&asset.as_str()), "附件在清单: {paths:?}");

        let note_meta = manifest.iter().find(|m| m.path == note.path).unwrap();
        assert_eq!(note_meta.kind, "note");
        assert_eq!(note_meta.hash, fs_ops::content_hash("内容甲".as_bytes()));
        let asset_meta = manifest.iter().find(|m| m.path == asset).unwrap();
        assert_eq!(asset_meta.kind, "asset");
        assert_eq!(asset_meta.size, 8);
        // .lanmark 与回收站不出现在清单
        assert!(!paths.iter().any(|p| p.starts_with(".lanmark")));
    }

    /// A2 回归：服务端清单以磁盘为准——外部（不经命令/DB）新建/删除的笔记
    /// 必须立刻反映在 `local_manifest`；DB 残留旧行不得复活已删文件。
    /// 手机端常驻期间只在开库 reindex，外部增删改必须靠这条路径同步。
    #[test]
    fn local_manifest_follows_disk_not_db() {
        use crate::commands::open_vault_at;
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        let s = &state;

        // 外部新建：不经过 note_write_op，DB 里没有这一行
        std::fs::write(dir.path().join("外部新建.md"), "外部内容").unwrap();
        let manifest = local_manifest(s).unwrap();
        let paths: Vec<&str> = manifest.iter().map(|m| m.path.as_str()).collect();
        let m = manifest
            .iter()
            .find(|m| m.path == "外部新建.md")
            .unwrap_or_else(|| panic!("磁盘上的笔记必须在清单: {paths:?}"));
        assert_eq!(m.hash, fs_ops::content_hash("外部内容".as_bytes()), "hash 取自磁盘");
        assert_eq!(m.size, "外部内容".len() as i64, "size 取自磁盘");
        assert!(m.mtime_ms > 0, "mtime 取自磁盘");

        // 外部删除：磁盘没了就不能再出现（即便 DB 还有旧行）
        std::fs::remove_file(dir.path().join("外部新建.md")).unwrap();
        let manifest = local_manifest(s).unwrap();
        assert!(
            !manifest.iter().any(|m| m.path == "外部新建.md"),
            "已删除文件不得被清单复活: {manifest:?}"
        );

        // DB 残留一行、磁盘没有 → 不出现
        {
            let conn = s.db.lock().unwrap();
            let conn = conn.as_ref().unwrap();
            crate::db::upsert_file(conn, "幽灵.md", "幽灵", "x", 1, "deadbeef", true).unwrap();
        }
        let manifest = local_manifest(s).unwrap();
        assert!(!manifest.iter().any(|m| m.path == "幽灵.md"), "DB 孤行不得进清单");

        // 磁盘有、DB 残留旧 hash → 以磁盘为准
        std::fs::write(dir.path().join("真实.md"), "真实内容").unwrap();
        {
            let conn = s.db.lock().unwrap();
            let conn = conn.as_ref().unwrap();
            crate::db::upsert_file(conn, "真实.md", "真实", "旧", 1, "deadbeef", true).unwrap();
        }
        let manifest = local_manifest(s).unwrap();
        let m = manifest.iter().find(|m| m.path == "真实.md").unwrap();
        assert_eq!(m.hash, fs_ops::content_hash("真实内容".as_bytes()), "hash 以磁盘为准");
    }

    #[test]
    fn write_conflict_copy_creates_indexed_note() {
        use crate::commands::open_vault_at;
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        let conn = state.db.lock().unwrap();
        let conn = conn.as_ref().unwrap();

        let c1 = write_conflict_copy(
            dir.path(),
            conn,
            "工作/笔记.md",
            "note",
            "服务器版本".as_bytes(),
            1_789_633_800_000,
        )
        .unwrap();
        assert!(c1.starts_with("工作/笔记-冲突0917-0830"));
        assert!(c1.ends_with(".md"));
        assert!(dir.path().join(&c1).exists());
        let (title, body, _mtime, hash) = crate::db::get_file(conn, &c1).unwrap().unwrap();
        assert_eq!(body, "服务器版本");
        assert_eq!(hash, fs_ops::content_hash("服务器版本".as_bytes()));
        assert!(!title.is_empty());

        // 同分钟再落同名冲突 → 自动 -2
        let c2 = write_conflict_copy(
            dir.path(),
            conn,
            "工作/笔记.md",
            "note",
            "另一个版本".as_bytes(),
            1_789_633_800_000,
        )
        .unwrap();
        assert_ne!(c1, c2);
        assert!(c2.contains("-2.md") || !c2.starts_with("工作/笔记-冲突0917-0830.md"));
        assert!(dir.path().join(&c2).exists());
    }

    /// 回归：冲突副本落盘必须用原始字节。此前 note 分支写 lossy String，
    /// 非 UTF-8（如 GBK）服务器版本会变成乱码副本，且与 hash 不一致。
    #[test]
    fn write_conflict_copy_preserves_non_utf8_bytes() {
        use crate::commands::open_vault_at;
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        let conn = state.db.lock().unwrap();
        let conn = conn.as_ref().unwrap();

        // GBK 字节（"中文" 的 GBK 编码），非合法 UTF-8
        let gbk = b"\xd6\xd0\xce\xc4";
        let c = write_conflict_copy(dir.path(), conn, "n.md", "note", gbk, 1_789_633_800_000)
            .unwrap();
        let on_disk = std::fs::read(dir.path().join(&c)).unwrap();
        assert_eq!(on_disk, gbk, "磁盘字节必须与服务器版本一致");
        let (_t, _body, _mtime, hash) = crate::db::get_file(conn, &c).unwrap().unwrap();
        assert_eq!(hash, fs_ops::content_hash(gbk), "索引 hash 基于原始字节");
    }
}
