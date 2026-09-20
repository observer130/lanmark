//! M2 同步共享层：协议类型、本地/远端清单构建、冲突命名。
//! 协议沿用 docs/02+05 决策：文件级 sha256 版本对比、冲突保留双份、JSON over HTTP。
//! 服务器（手机 axum）与客户端（桌面）两侧共用，保证语义一致。

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::commands::{with_db, with_vault};
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
    /// 该路径在服务器上**操作后的最终 hash**（docs/07 §3，M3a 新增）：
    /// 干净落盘/来件仲裁获胜 = 所推 hash；来件被仲裁降级 = 原路径现有 hash。
    /// 旧服务器不返回该字段（None）→ 客户端退化 M2 行为（ok = 落盘）。
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    /// 冲突副本（服务器版本在本地落成的 <stem>-冲突<mmdd-HHMM>.md）
    pub conflicts: Vec<String>,
    pub skipped: usize,
    pub errors: Vec<String>,
}

// ---------- 清单 ----------

/// 本地清单：笔记来自 DB 索引（write_note/reindex 维护 hash），附件 walk assets/。
pub fn local_manifest(state: &Arc<AppState>) -> Result<Vec<FileMeta>, String> {
    let mut out = Vec::new();
    with_vault(state, |vault| {
        with_db(state, |conn| {
            // 笔记：DB 是可重建索引，hash 由 M1 写路径维护
            let rows: Vec<(String, String, i64)> = {
                let mut stmt = conn
                    .prepare("SELECT path, hash, mtime_ms FROM files WHERE is_note=1")
                    .map_err(|e| e.to_string())?;
                let list = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .map_err(|e| e.to_string())?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|e| e.to_string())?;
                list
            };
            for (path, _hash, _mtime) in rows {
                // 磁盘是唯一事实源：DB 的 hash/body 只服务搜索，可能因外部改动
                // （其他 App/编辑器直接改文件）与磁盘脱节——同步清单必须以磁盘为准
                let abs = vault.join(&path);
                let Ok(bytes) = std::fs::read(&abs) else { continue };
                let (mtime_ms, size) = match std::fs::metadata(&abs) {
                    Ok(m) => (
                        m.modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0),
                        m.len() as i64,
                    ),
                    Err(_) => (0, 0),
                };
                out.push(FileMeta {
                    path,
                    kind: "note".into(),
                    hash: fs_ops::content_hash(&bytes),
                    mtime_ms,
                    size,
                });
            }
            Ok(())
        })?;
        // 附件：内容寻址（assets/<sha16>.<ext>），不进 DB，直接 walk
        for meta in asset_walk(vault).map_err(|e| e.to_string())? {
            out.push(meta);
        }
        Ok(out)
    })
}

/// walk assets/，逐文件计算 sha256（内容寻址目录，文件数有限）
pub fn asset_walk(vault: &Path) -> std::io::Result<Vec<FileMeta>> {
    let mut out = Vec::new();
    let assets = vault.join(fs_ops::ASSETS_DIR);
    if !assets.is_dir() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&assets)? {
        let entry = entry?;
        // file_type 不跟随符号链接：assets/ 内的链接不进同步清单
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() || !ft.is_file() {
            continue;
        }
        let path = entry.path();
        let bytes = std::fs::read(&path)?;
        let rel = format!(
            "{}/{}",
            fs_ops::ASSETS_DIR,
            entry.file_name().to_string_lossy()
        );
        out.push(FileMeta {
            path: rel,
            kind: "asset".into(),
            hash: fs_ops::content_hash(&bytes),
            mtime_ms: entry
                .metadata()?
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            size: bytes.len() as i64,
        });
    }
    Ok(out)
}

// ---------- 版本元组（LWW 裁决，docs/07 §4.1） ----------

/// 版本元组：`(mtime_ms, size, hash_hex)`，字典序比较，**大者赢**。
/// mtime 不同 → mtime 新者赢；同毫秒 → size 大者赢；size 同 → hash 字典序大者赢
/// （hash 相同 = 内容相同，本不会进裁决）。M3b 删除参与裁决时取
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
