//! Vault 文件系统操作：目录树、笔记/文件夹 CRUD（回收站语义）、读写、重索引。
//! 所有路径均为 vault 相对路径（'/' 分隔），出口入口都做防逃逸校验。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use crate::db;
use crate::sanitize::{sanitize_filename, sanitize_filename_with_ext};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const TRASH_DIR: &str = ".lanmark/trash";
pub const ASSETS_DIR: &str = "assets";
pub const META_DIR: &str = ".lanmark";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub path: String,
    pub kind: String, // "note" | "folder"
    pub name: String,
    pub title: Option<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 相对路径安全校验 + 拼接（拒绝绝对路径、.. 逃逸、反斜杠）
pub fn safe_join(vault: &Path, rel: &str) -> std::io::Result<PathBuf> {
    let rel = rel.trim();
    if rel.is_empty()
        || rel == "."
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.split('/').any(|seg| seg == ".." || seg.is_empty())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("非法路径: {rel}"),
        ));
    }
    Ok(vault.join(rel))
}

/// 解析 vault 相对路径并校验不越出 vault（防符号链接逃逸）。
///
/// `safe_join` 只挡字符串层面的 `..`/绝对路径，挡不住 vault 内的符号链接：
/// 远程 sync push「linkdir/evil.md」（linkdir → /etc）会写到 vault 外，
/// delete 同理。这里用 canonicalize 做真路径判定：路径尚不存在（新建）时
/// 以最近存在的祖先目录为准，不存在段拼回规范化祖先之后。
pub fn resolve_in_vault(vault: &Path, rel: &str) -> std::io::Result<PathBuf> {
    let abs = safe_join(vault, rel)?;
    // 向上找最近存在的祖先（abs 本身可能尚不存在）
    let mut existing = abs.clone();
    loop {
        if existing.exists() {
            break;
        }
        match existing.parent() {
            Some(p) if !p.as_os_str().is_empty() => existing = p.to_path_buf(),
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "路径不存在且无法定位祖先目录",
                ))
            }
        }
    }
    let canon = existing.canonicalize()?;
    let canon_vault = vault.canonicalize().unwrap_or_else(|_| vault.to_path_buf());
    if !canon.starts_with(&canon_vault) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "路径经符号链接越出 vault",
        ));
    }
    // 校验通过：返回原拼接路径（后续 rel 计算以 vault 前缀为准，
    // 若 vault 本身含符号链接段，canonicalize 后的路径无法 strip_prefix）
    Ok(abs)
}

/// 目录相对路径解析：空串 = vault 根
fn dir_for(vault: &Path, dir_rel: &str) -> std::io::Result<PathBuf> {
    let rel = dir_rel.trim();
    if rel.is_empty() || rel == "." {
        return Ok(vault.to_path_buf());
    }
    safe_join(vault, rel)
}

pub fn rel_to_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub fn ensure_layout(vault: &Path) -> std::io::Result<()> {
    fs::create_dir_all(vault.join(META_DIR))?;
    fs::create_dir_all(vault.join(ASSETS_DIR))?;
    fs::create_dir_all(vault.join(TRASH_DIR))?;
    Ok(())
}

/* ── 目录颜色（用户手动设置，取代旧的顶层名哈希取色） ──
   存于 .lanmark/folder-colors.json（relPath → "fd1"|"fd2"|"fd3"）。
   .lanmark/ 不参与同步 → 颜色是设备本地偏好；键为目录相对路径，
   重命名/移动/删除时由对应 op 负责迁移与清理。 */

pub const FOLDER_COLORS_FILE: &str = "folder-colors.json";

/// 合法颜色 token（与前端调色板一致；None/空 = 恢复默认无色）
fn is_valid_color_token(c: Option<&str>) -> bool {
    matches!(c, None | Some("") | Some("fd1") | Some("fd2") | Some("fd3"))
}

pub fn load_folder_colors(vault: &Path) -> std::io::Result<std::collections::BTreeMap<String, String>> {
    let p = vault.join(META_DIR).join(FOLDER_COLORS_FILE);
    let bytes = match fs::read(&p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(e) => return Err(e),
    };
    // 文件损坏按空表处理（下次 set 会重写整份），不让颜色问题挡住开库
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn write_folder_colors(
    vault: &Path,
    map: &std::collections::BTreeMap<String, String>,
) -> std::io::Result<()> {
    let dir = vault.join(META_DIR);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(FOLDER_COLORS_FILE), serde_json::to_vec(map)?)
}

pub fn set_folder_color(vault: &Path, rel: &str, color: Option<&str>) -> std::io::Result<()> {
    if !is_valid_color_token(color) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("未知颜色 token: {color:?}"),
        ));
    }
    // 仅允许给真实存在的目录上色（顺带防路径穿越与给笔记上色）
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "仅目录可设置颜色",
        ));
    }
    let mut map = load_folder_colors(vault)?;
    let rel = rel_to_string(Path::new(rel));
    match color {
        Some("") | None => {
            map.remove(&rel);
        }
        Some(token) => {
            map.insert(rel, token.to_string());
        }
    }
    write_folder_colors(vault, &map)
}

/// 文件夹重命名/移动后迁移颜色键（old_rel → new_rel，含全部子孙目录）。
/// 最好 effort 语义由调用方兜底：失败仅告警，不影响重命名本身。
pub fn migrate_folder_colors(vault: &Path, old_rel: &str, new_rel: &str) -> std::io::Result<()> {
    let old_rel = rel_to_string(Path::new(old_rel));
    let new_rel = rel_to_string(Path::new(new_rel));
    let mut map = load_folder_colors(vault)?;
    let mut changed = false;
    let prefix = format!("{old_rel}/");
    let keys: Vec<String> = map.keys().cloned().collect();
    for k in keys {
        let mapped = if k == old_rel {
            Some(new_rel.clone())
        } else if k.starts_with(&prefix) {
            Some(format!("{new_rel}/{}", &k[prefix.len()..]))
        } else {
            None
        };
        if let Some(nk) = mapped {
            let v = map.remove(&k).unwrap();
            map.insert(nk, v);
            changed = true;
        }
    }
    if changed {
        write_folder_colors(vault, &map)?;
    }
    Ok(())
}

/// 删除目录后清理其颜色键（含子孙）。空表顺手删文件，避免残留空 json。
pub fn prune_folder_colors(vault: &Path, removed_rel: &str) -> std::io::Result<()> {
    let removed_rel = rel_to_string(Path::new(removed_rel));
    let prefix = format!("{removed_rel}/");
    let mut map = load_folder_colors(vault)?;
    let before = map.len();
    map.retain(|k, _| k != &removed_rel && !k.starts_with(&prefix));
    if map.len() == before {
        return Ok(());
    }
    if map.is_empty() {
        let p = vault.join(META_DIR).join(FOLDER_COLORS_FILE);
        match fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    } else {
        write_folder_colors(vault, &map)
    }
}

fn is_note_file(p: &Path) -> bool {
    p.extension().map(|e| e == "md").unwrap_or(false)
}

/// 遍历 vault（跳过 .lanmark），返回相对路径节点列表。
/// 顺序 = 深度优先前序：每个目录内「目录在前、按名升序（忽略大小写）」，
/// 文件夹后紧跟其子项——扁平列表 + 前端按段数缩进即可还原层级。
pub fn list_tree(vault: &Path) -> std::io::Result<Vec<Node>> {
    let mut out = Vec::new();
    walk(vault, vault, &mut out)?;
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<Node>) -> std::io::Result<()> {
    // 逐目录排序（目录在前、按名升序）；⚠️ 不能对整棵树做全局 (kind, name) 排序——
    // 那会把不同层级的同名序节点穿插在一起，破坏「子项紧跟父目录」的深度优先序
    // file_type() 不跟随符号链接（path.is_dir() 会），遍历必须用前者
    let mut entries: Vec<(std::fs::DirEntry, Option<std::fs::FileType>)> =
        fs::read_dir(dir)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|e| {
                let ft = e.file_type().ok();
                (e, ft)
            })
            .collect();
    entries.sort_by_key(|(e, ft)| {
        (ft.map_or(false, |f| !f.is_dir()), e.file_name().to_string_lossy().to_lowercase())
    });
    for (entry, ft) in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == META_DIR || name.starts_with('.') {
            continue;
        }
        // 附件目录不进目录树：assets/ 是粘贴/拖入图片的落盘处（save_asset），
        // 用户无需在树里操作它。同步清单与搜索索引走各自的遍历器，不受影响
        if name == ASSETS_DIR {
            continue;
        }
        // 符号链接一律跳过：指向 vault 外的链接会把外部文件列进树/索引/同步清单
        // （内容经同步服务器明文外发），链接循环则使递归栈溢出
        if ft.map_or(false, |f| f.is_symlink()) {
            log::warn!("vault 内符号链接已跳过: {name}");
            continue;
        }
        let path = entry.path();
        let rel = rel_to_string(path.strip_prefix(root).unwrap());
        if ft.map_or(false, |f| f.is_dir()) {
            out.push(Node { path: rel, kind: "folder".into(), name, title: None });
            walk(root, &path, out)?;
        } else if is_note_file(&path) {
            out.push(Node {
                path: rel.clone(),
                kind: "note".into(),
                title: Some(title_from_stem(&name)),
                name,
            });
        }
    }
    Ok(())
}

pub fn title_from_stem(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string())
}

/// 目标已存在时自动追加 -2、-3…。
/// 上限耗尽返回 Err 而非 panic：此前 unreachable! 在持 db+vault 双锁路径上
/// panic → 锁中毒，之后所有 IPC 恒报「锁中毒」（release 下 panic=abort 直接杀进程）
fn unique_target(dir: &Path, file_name: &str) -> std::io::Result<PathBuf> {
    unique_target_with_cap(dir, file_name, 10000)
}

fn unique_target_with_cap(dir: &Path, file_name: &str, cap: u32) -> std::io::Result<PathBuf> {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = Path::new(file_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..=cap {
        let candidate = dir.join(format!("{stem}-{i}{ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("同名目标过多，无法生成唯一名: {file_name}"),
    ))
}

/// 解析出「目标目录 + 规范化后的名字」，供 create/rename 复用
fn resolve_target(
    vault: &Path,
    dir_rel: &str,
    raw_name: &str,
) -> std::io::Result<(PathBuf, String)> {
    let dir = dir_for(vault, dir_rel)?;
    if !dir.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("目录不存在: {dir_rel}"),
        ));
    }
    // 目标目录不得经符号链接越出 vault（否则新建笔记会落到 vault 外）
    let trimmed = dir_rel.trim();
    if !trimmed.is_empty() && trimmed != "." {
        resolve_in_vault(vault, trimmed)?;
    }
    let name = sanitize_filename_with_ext(raw_name);
    let name = if is_windows_reserved_base(&name) {
        format!("n-{name}")
    } else {
        name
    };
    Ok((dir, name))
}

fn is_windows_reserved_base(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
            | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
            | "LPT7" | "LPT8" | "LPT9"
    )
}

pub fn create_note(vault: &Path, dir_rel: &str, raw_name: &str) -> std::io::Result<Node> {
    let (dir, name) = resolve_target(vault, dir_rel, raw_name)?;
    let name = if name.ends_with(".md") { name } else { format!("{name}.md") };
    let target = unique_target(&dir, &name)?;
    fs::write(&target, "")?;
    let rel = rel_to_string(target.strip_prefix(vault).unwrap());
    // M3b D4：路径被（重新）创建 → 清 tombstone（best effort；回合开头有权威判定兜底）
    if let Err(e) = crate::sync::clear_tombstone_if_present(vault, &rel) {
        log::warn!("清 tombstone 失败 {rel}: {e}");
    }
    Ok(Node {
        title: Some(title_from_stem(&name)),
        path: rel.clone(),
        name,
        kind: "note".into(),
    })
}

pub fn create_folder(vault: &Path, dir_rel: &str, raw_name: &str) -> std::io::Result<Node> {
    let (dir, name) = resolve_target(vault, dir_rel, raw_name)?;
    let target = unique_target(&dir, &name)?;
    fs::create_dir(&target)?;
    let rel = rel_to_string(target.strip_prefix(vault).unwrap());
    Ok(Node { path: rel, kind: "folder".into(), name, title: None })
}

/// 重命名（同目录内）。返回新相对路径。
pub fn rename_entry(
    vault: &Path,
    rel_path: &str,
    new_raw_name: &str,
    conn: &Connection,
) -> std::io::Result<String> {
    let old_abs = resolve_in_vault(vault, rel_path)?;
    let parent = old_abs
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "无父目录"))?
        .to_path_buf();
    let old_name = old_abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // 新名字不带扩展名时，保留原扩展名（避免 .md 笔记变无扩展名文件）
    let new_name = if new_raw_name.rfind('.').map_or(false, |i| i > 0) {
        sanitize_filename_with_ext(new_raw_name)
    } else {
        let old_ext = old_abs.extension().and_then(|e| e.to_str()).unwrap_or("");
        if old_ext.is_empty() {
            // 文件夹等无扩展名条目：不追加点
            sanitize_filename(new_raw_name)
        } else {
            format!("{}.{}", sanitize_filename(new_raw_name), old_ext)
        }
    };
    if new_name == old_name {
        return Ok(rel_path.to_string());
    }
    let target = unique_target(&parent, &new_name)?;
    // M3b：重命名 = 旧路径消失 → 记旧路径 tombstone（文件夹展开），
    // 对端收敛为「旧路径删除 + 新路径推送」，内容在新路径保留（铁律）
    record_tombstones_for_entry(vault, rel_path, conn);
    fs::rename(&old_abs, &target)?;
    let new_rel = rel_to_string(target.strip_prefix(vault).unwrap());
    db::rename_paths(conn, rel_path, &new_rel)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    clear_tombstones_for_entry(vault, &new_rel, conn);
    // 重命名文件后，索引里的 title 需要更新。
    // 与 write_note 同纪律：优先 frontmatter title，而不是无脑退回文件名 stem
    // （带 title: 的笔记重命名后 recents/favorites 显示不应回退）
    if target.is_file() {
        let content = fs::read_to_string(&target).unwrap_or_default();
        let title = extract_frontmatter_title(&content).unwrap_or_else(|| title_from_stem(&new_name));
        let _ = conn.execute(
            "UPDATE files SET title=?1 WHERE path=?2",
            params![title, new_rel],
        );
    }
    Ok(new_rel)
}

/// 移动到另一目录（拖拽）。返回新相对路径。
pub fn move_entry(
    vault: &Path,
    rel_path: &str,
    new_dir_rel: &str,
    conn: &Connection,
) -> std::io::Result<String> {
    let old_abs = resolve_in_vault(vault, rel_path)?;
    let new_dir = dir_for(vault, new_dir_rel)?;
    if !new_dir.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "目标目录不存在"));
    }
    // 不能移动到自身或自己的子目录
    let self_prefix = format!("{}/", rel_path);
    let new_dir_rel_norm = new_dir_rel.trim_matches('/');
    // 目标目录不得经符号链接越出 vault
    if !new_dir_rel_norm.is_empty() {
        resolve_in_vault(vault, new_dir_rel_norm)?;
    }
    if new_dir_rel_norm == rel_path || new_dir_rel_norm.starts_with(&self_prefix) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能移动到自身内部",
        ));
    }
    // 移到当前所在目录 = 无操作：否则 unique_target 把条目自己当「已存在」，
    // 会把它改名为 x-2（真机 review 发现的数据损坏路径）
    let parent_rel = rel_path
        .rsplit_once('/')
        .map(|(d, _)| d.to_string())
        .unwrap_or_default();
    if new_dir_rel_norm == parent_rel {
        return Ok(rel_path.to_string());
    }
    let name = old_abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let target = unique_target(&new_dir, &name)?;
    // M3b：移动 = 旧路径消失 → 同 rename 的 tombstone 处理
    record_tombstones_for_entry(vault, rel_path, conn);
    fs::rename(&old_abs, &target)?;
    let new_rel = rel_to_string(target.strip_prefix(vault).unwrap());
    db::rename_paths(conn, rel_path, &new_rel)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    clear_tombstones_for_entry(vault, &new_rel, conn);
    Ok(new_rel)
}

/// 列出条目下全部同步单元（文件）：文件 → 自身；文件夹 → 其下全部笔记（DB）+ 附件（磁盘 walk）。
/// tombstone 文件夹展开用（M3b）。只列同步单元（笔记/assets），外来文件不列。
pub fn entry_file_list(vault: &Path, rel: &str, conn: &Connection) -> std::io::Result<Vec<String>> {
    let abs = resolve_in_vault(vault, rel)?;
    if abs.is_file() {
        return Ok(vec![rel.to_string()]);
    }
    if !abs.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "条目不存在"));
    }
    let mut out: Vec<String> = db::list_prefix_paths(conn, rel)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // 附件不进 DB，磁盘 walk；file_type 不跟随符号链接（防逃逸/循环）
    fn walk(dir: &Path, vault: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
        for e in fs::read_dir(dir)? {
            let e = e?;
            let ft = e.file_type()?;
            if ft.is_symlink() {
                continue;
            }
            let p = e.path();
            if ft.is_dir() {
                walk(&p, vault, out)?;
            } else if ft.is_file() {
                let r = rel_to_string(
                    p.strip_prefix(vault)
                        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径越界"))?,
                );
                if r.starts_with(ASSETS_DIR) {
                    out.push(r);
                }
            }
        }
        Ok(())
    }
    walk(&abs, vault, &mut out)?;
    out.sort();
    out.dedup();
    Ok(out)
}

/// M3b：为条目下全部同步单元记 tombstone（hash 以磁盘为准，时间 = 现在）
fn record_tombstones_for_entry(vault: &Path, rel: &str, conn: &Connection) {
    if let Ok(files) = entry_file_list(vault, rel, conn) {
        let now = now_ms();
        for f in &files {
            if let Ok(bytes) = fs::read(vault.join(f)) {
                let h = content_hash(&bytes);
                if let Err(e) = crate::sync::record_tombstone(vault, f, &h, now) {
                    log::warn!("记 tombstone 失败 {f}: {e}");
                }
            }
        }
    }
}

/// M3b D4：清除条目下全部同步单元的 tombstone
fn clear_tombstones_for_entry(vault: &Path, rel: &str, conn: &Connection) {
    if let Ok(files) = entry_file_list(vault, rel, conn) {
        for f in &files {
            if let Err(e) = crate::sync::clear_tombstone_if_present(vault, f) {
                log::warn!("清 tombstone 失败 {f}: {e}");
            }
        }
    }
}

/// 回收站名冲突消解：`<ms>-<name>` 已存在则追加 -2、-3…
fn trash_unique_name(trash_dir: &Path, base: String) -> String {
    let mut name = base.clone();
    let mut i = 2u32;
    while trash_dir.join(&name).exists() {
        name = format!("{base}-{i}");
        i += 1;
    }
    name
}

/// 删除 → 回收站（铁律：永不硬删）。返回回收站内的相对路径。
pub fn delete_entry(vault: &Path, rel_path: &str, conn: &Connection) -> std::io::Result<String> {
    let abs = resolve_in_vault(vault, rel_path)?;
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let trash_dir = safe_join(vault, TRASH_DIR)?;
    fs::create_dir_all(&trash_dir)?;
    // 同毫秒删两个同名条目会撞名（此前 rename 报 AlreadyExists）→ 追加 -2、-3…
    let trash_name = trash_unique_name(&trash_dir, format!("{}-{}", now_ms(), name));
    let trash_abs = trash_dir.join(&trash_name);
    fs::rename(&abs, &trash_abs)?;
    db::remove_prefix(conn, rel_path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    Ok(format!("{TRASH_DIR}/{trash_name}"))
}

// ---------- M4d/M4e：vault 统计与回收站清理 ----------

/// vault 规模统计（`vault_stats` 命令的返回体，docs/08 §3.3 C2）。
#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultStats {
    pub notes: usize,
    pub folders: usize,
    pub assets: usize,
    /// vault 内笔记 + 附件 + `.lanmark/` 元数据的总占用字节
    pub bytes: u64,
    pub trash_entries: usize,
    pub trash_bytes: u64,
}

/// 递归统计目录占用（字节）。读不到的条目按 0 计，不因单个坏文件让整个统计失败。
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => total += dir_bytes(&p),
            Ok(t) if t.is_file() => total += e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => {} // 符号链接：不跟进（避免环）
        }
    }
    total
}

/// 一次遍历产出统计。跳过 `.lanmark/`（元数据另计）与所有隐藏目录/文件
/// （与 `list_tree` 的跳过规则一致，硬约定 4：vault 文件才是事实源，
/// 同步产生的临时文件、`.git` 之类不该被算成用户的笔记）。
///
/// `assets/` 是附件目录（粘贴图片落盘处），进 assets 计数而不进 folders。
pub fn vault_stats(vault: &Path) -> std::io::Result<VaultStats> {
    let mut st = VaultStats::default();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if name.starts_with('.') {
                    continue; // .lanmark / .git / .obsidian … 不计入
                }
                if dir == vault && name == ASSETS_DIR {
                    // 附件目录：只数文件，不再往里递归出「文件夹」
                    st.assets += count_files(&p);
                    st.bytes += dir_bytes(&p);
                    continue;
                }
                st.folders += 1;
                st.bytes += dir_bytes(&p);
                stack.push(p);
            } else if ft.is_file() {
                if name.starts_with('.') {
                    continue;
                }
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                if name.to_lowercase().ends_with(".md") {
                    st.notes += 1;
                } else {
                    st.assets += 1;
                }
                st.bytes += len;
            }
        }
    }
    // `.lanmark/`：索引 / 基线 / tombstone / 回收站 —— 计入总占用但不计条目
    if let Ok(meta) = safe_join(vault, META_DIR) {
        st.bytes += dir_bytes(&meta);
    }
    let (entries, bytes) = trash_usage(vault);
    st.trash_entries = entries;
    st.trash_bytes = bytes;
    Ok(st)
}

fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    for e in rd.flatten() {
        match e.file_type() {
            Ok(t) if t.is_dir() => n += count_files(&e.path()),
            Ok(t) if t.is_file() => n += 1,
            _ => {}
        }
    }
    n
}

/// 回收站条目数 + 占用字节。
pub fn trash_usage(vault: &Path) -> (usize, u64) {
    let Ok(trash) = safe_join(vault, TRASH_DIR) else { return (0, 0) };
    let Ok(rd) = fs::read_dir(&trash) else { return (0, 0) };
    let mut n = 0;
    let mut bytes = 0u64;
    for e in rd.flatten() {
        n += 1;
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => bytes += dir_bytes(&p),
            Ok(t) if t.is_file() => bytes += e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => {}
        }
    }
    (n, bytes)
}

/// 从 `.lanmark/trash/<ms>-<name>` 的文件名前缀解析删除时刻（unix ms）。
/// 解析不出（老格式 / 手改过的名字）返回 `None` —— 这类条目**永不自动清理**，
/// 宁可占点空间也不能误删用户还没找回的东西。
pub fn trash_entry_ms(name: &str) -> Option<i64> {
    let prefix = name.split('-').next()?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    prefix.parse::<i64>().ok().filter(|v| *v > 0)
}

/// 按保留天数清理回收站，返回删除条目数。
///
/// `days == 0` = 从不清理（docs/08 §3.3 C6）。
/// **与 M3 tombstone TTL 无关**：trash 是本地找回（不进同步），tombstone 是删除
/// 传播账本（`.lanmark/tombstones.json`，固定 30 天）——清 trash 不影响同步传播删除。
pub fn trash_prune(vault: &Path, days: u32, now: i64) -> std::io::Result<usize> {
    if days == 0 {
        return Ok(0);
    }
    let cutoff = now - (days as i64) * 24 * 60 * 60 * 1000;
    let trash = safe_join(vault, TRASH_DIR)?;
    let Ok(rd) = fs::read_dir(&trash) else { return Ok(0) };
    let mut removed = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(ms) = trash_entry_ms(&name) else { continue };
        if ms >= cutoff {
            continue;
        }
        let p = e.path();
        let res = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
        if res.is_ok() {
            removed += 1;
        } else {
            log::warn!("回收站条目清理失败（跳过）: {}", p.display());
        }
    }
    Ok(removed)
}

/// 清空回收站，返回删除条目数。
pub fn trash_clear(vault: &Path) -> std::io::Result<usize> {
    let trash = safe_join(vault, TRASH_DIR)?;
    if !trash.is_dir() {
        return Ok(0);
    }
    let mut removed = 0;
    for e in fs::read_dir(&trash)?.flatten() {
        let p = e.path();
        let res = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
        if res.is_ok() {
            removed += 1;
        } else {
            log::warn!("回收站条目删除失败（跳过）: {}", p.display());
        }
    }
    Ok(removed)
}

// ---------- 读写 ----------

/// 从 frontmatter 提取可选 title（仅支持 `title: xxx` 形式）
pub fn extract_frontmatter_title(content: &str) -> Option<String> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        if let Some(v) = line.strip_prefix("title:") {
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn read_note(vault: &Path, rel_path: &str) -> std::io::Result<String> {
    let abs = resolve_in_vault(vault, rel_path)?;
    if !abs.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "笔记不存在"));
    }
    fs::read_to_string(abs)
}

pub fn content_hash(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 原子写 tmp 路径：原名 + pid + 单调序号。
/// 固定名（`.md.lanmark-tmp`）会让「UI 保存」与「sync push」并发写同一文件时
/// 互相踩踏（一方 rename ENOENT，或把对方写一半的截断文件落成正式笔记）。
fn tmp_path_for(abs: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let parent = abs.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{name}.{}.{}.lanmark-tmp", std::process::id(), seq))
}

/// 设定文件 mtime（LWW 时间源跨端保真，docs/07 §2：裁决按「文件 mtime」而非
/// 「服务器到达顺序」——push/pull 落地时若不保留源端保存时间，服务器侧文件
/// mtime 会被写成落地时刻，离线早改、晚上线的设备会被晚到的旧版覆盖）。
/// `ms <= 0` 视为无效（读不到 mtime 的退化值），跳过不覆写。best effort。
pub fn set_file_mtime(abs: &Path, ms: i64) {
    if ms <= 0 {
        return;
    }
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    let times = std::fs::FileTimes::new().set_modified(t);
    if let Ok(f) = std::fs::File::open(abs) {
        let _ = f.set_times(times);
    }
}

/// 原子写（tmp+rename）。崩溃最多留一个孤儿 tmp，绝不产生截断的正式文件。
pub fn atomic_write(abs: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_path_for(abs);
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, abs)
}

/// 写入（tmp+rename 原子落盘），更新索引。返回 (mtime_ms, hash)。
pub fn write_note(
    vault: &Path,
    rel_path: &str,
    content: &str,
    conn: &Connection,
) -> std::io::Result<(i64, String)> {
    let abs = resolve_in_vault(vault, rel_path)?;
    atomic_write(&abs, content.as_bytes())?;
    let mtime = now_ms();
    let hash = content_hash(content.as_bytes());
    let title = extract_frontmatter_title(content)
        .unwrap_or_else(|| title_from_stem(&abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()));
    db::upsert_file(conn, rel_path, &title, content, mtime, &hash, true)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // M3b D4：路径被（重新）写入 = （重新）创建 → 清 tombstone（含同步拉取落地）
    if let Err(e) = crate::sync::clear_tombstone_if_present(vault, rel_path) {
        log::warn!("清 tombstone 失败 {rel_path}: {e}");
    }
    Ok((mtime, hash))
}

/// 字节级写入（非 UTF-8 外来文件保真），tmp+rename 原子落盘 + 索引（body 为 lossy 文本）。
/// 返回 (mtime_ms, hash)。
pub fn write_note_bytes(
    vault: &Path,
    rel_path: &str,
    bytes: &[u8],
    conn: &Connection,
) -> std::io::Result<(i64, String)> {
    let abs = resolve_in_vault(vault, rel_path)?;
    atomic_write(&abs, bytes)?;
    let mtime = now_ms();
    let hash = content_hash(bytes);
    let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let title = extract_frontmatter_title(&String::from_utf8_lossy(bytes))
        .unwrap_or_else(|| title_from_stem(&name));
    db::upsert_file(conn, rel_path, &title, &String::from_utf8_lossy(bytes), mtime, &hash, true)
        .map_err(|e| std::io::Error::other(e))?;
    // M3b D4：同 write_note
    if let Err(e) = crate::sync::clear_tombstone_if_present(vault, rel_path) {
        log::warn!("清 tombstone 失败 {rel_path}: {e}");
    }
    Ok((mtime, hash))
}

/// 附件：内容落盘 assets/<sha256前16位>.<ext>，返回相对路径
pub fn save_asset(vault: &Path, bytes: &[u8], ext: &str) -> std::io::Result<String> {
    let ext = {
        let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if e.is_empty() {
            "bin".to_string()
        } else {
            e
        }
    };
    // 白名单（字母数字 + 点/加/连字符）：挡掉含 / 的 ext——
    // 否则 `assets/<hash>.png/../evil` 可爬出 assets/ 落盘
    // （resolve_in_vault 是第二道闸，此处挡在拼名之前）
    if !ext
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '+' || c == '-')
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("非法附件扩展名: {ext}"),
        ));
    }
    let full_hash = content_hash(bytes);
    let name = format!("{}.{}", &full_hash[..16.min(full_hash.len())], ext);
    // assets/ 本身是符号链接（或恶意 ext 构造的路径）时拒绝落盘
    resolve_in_vault(vault, &format!("{ASSETS_DIR}/{name}"))?;
    let assets = safe_join(vault, ASSETS_DIR)?;
    fs::create_dir_all(&assets)?;
    let target = assets.join(&name);
    if !target.exists() {
        fs::write(&target, bytes)?;
    }
    let rel = format!("{ASSETS_DIR}/{name}");
    // M3b D4：附件路径被（重新）落盘 → 清 tombstone
    if let Err(e) = crate::sync::clear_tombstone_if_present(vault, &rel) {
        log::warn!("清 tombstone 失败 {rel}: {e}");
    }
    Ok(rel)
}

/// 全量重索引：以磁盘为准同步 DB（外部编辑/Obsidian 改动后调用）
pub fn reindex(vault: &Path, conn: &Connection) -> std::io::Result<usize> {
    let mut count = 0usize;
    let mut on_disk = std::collections::HashSet::new();
    collect_notes(vault, vault, &mut on_disk)?;
    for rel in &on_disk {
        let abs = vault.join(rel);
        // hash 必须基于**磁盘原始字节**：非 UTF-8（GBK 等）外来文件此前
        // read_to_string 失败 → unwrap_or_default 得空串 → 入库 hash = sha256(空串)，
        // 与磁盘字节不符（违反 files.hash 契约）
        let bytes = fs::read(&abs).unwrap_or_default();
        let content = String::from_utf8_lossy(&bytes).to_string();
        let mtime = fs::metadata(&abs)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let hash = content_hash(&bytes);
        let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let title = extract_frontmatter_title(&content).unwrap_or_else(|| title_from_stem(&name));
        db::upsert_file(conn, rel, &title, &content, mtime, &hash, true)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        count += 1;
    }
    // 清掉磁盘上已不存在的行（排除回收站路径本来就不在 vault 树内）
    let stale: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT path FROM files")
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        rows
    };
    for p in stale {
        if !on_disk.contains(&p) {
            db::remove_path(conn, &p)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        }
    }
    Ok(count)
}

fn collect_notes(
    root: &Path,
    dir: &Path,
    out: &mut std::collections::HashSet<String>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == META_DIR || name.starts_with('.') {
            continue;
        }
        // 符号链接跳过（与 walk 同纪律）：不进索引 → 不进同步清单
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            collect_notes(root, &path, out)?;
        } else if is_note_file(&path) {
            out.insert(rel_to_string(path.strip_prefix(root).unwrap()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        db::init_db(&conn).unwrap();
        ensure_layout(dir.path()).unwrap();
        (dir, conn)
    }

    #[test]
    fn create_rename_search_flow() {
        let (tmp, conn) = setup();
        let vault = tmp.path();

        // 建目录 + 中文笔记
        let folder = create_folder(vault, "", "工作 笔记").unwrap();
        assert_eq!(folder.name, "工作-笔记");
        let note = create_note(vault, &folder.path, "读书 笔记").unwrap();
        assert_eq!(note.name, "读书-笔记.md");
        assert!(vault.join("工作-笔记/读书-笔记.md").exists());

        // 写入内容 → 搜索
        write_note(vault, &note.path, "# 读书笔记\n\n关于 Rust 异步 的思考", &conn).unwrap();
        let hits = db::search(&conn, "异步", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, note.path);

        // 重命名：文件与索引同步
        let new_path = rename_entry(vault, &note.path, "新 名字", &conn).unwrap();
        assert_eq!(new_path, "工作-笔记/新-名字.md");
        assert!(!vault.join("工作-笔记/读书-笔记.md").exists());
        assert!(vault.join(&new_path).exists());
        assert!(db::search(&conn, "异步", 10).unwrap().len() == 1); // 正文仍在索引

        // frontmatter title 覆盖
        write_note(vault, &new_path, "---\ntitle: 真标题\n---\n内容", &conn).unwrap();
        let (title, _, _, _) = db::get_file(&conn, &new_path).unwrap().unwrap();
        assert_eq!(title, "真标题");
    }

    #[test]
    fn delete_goes_to_trash_and_purges_index() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let note = create_note(vault, "", "待删.md").unwrap();
        write_note(vault, &note.path, "内容", &conn).unwrap();
        db::record_recent(&conn, &note.path, 1, 50).unwrap();

        let trash_rel = delete_entry(vault, &note.path, &conn).unwrap();
        assert!(trash_rel.starts_with(TRASH_DIR));
        assert!(vault.join(&trash_rel).exists());
        assert!(!vault.join(&note.path).exists());
        assert!(db::get_file(&conn, &note.path).unwrap().is_none());
        assert!(db::list_recents(&conn, 10).unwrap().is_empty());
    }

    #[test]
    fn move_folder_updates_children() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let f1 = create_folder(vault, "", "a").unwrap();
        let f2 = create_folder(vault, "", "b").unwrap();
        let note = create_note(vault, &f1.path, "n.md").unwrap();
        write_note(vault, &note.path, "x", &conn).unwrap();

        let moved = move_entry(vault, &f1.path, &f2.path, &conn).unwrap();
        assert_eq!(moved, "b/a");
        assert!(vault.join("b/a/n.md").exists());
        assert!(db::get_file(&conn, "b/a/n.md").unwrap().is_some());
        assert!(db::get_file(&conn, "a/n.md").unwrap().is_none());
    }

    /// 回归：同名目标耗尽上限必须返回 Err（此前 unreachable! panic 会
    /// 中毒 db+vault 双锁，之后所有 IPC 恒报「锁中毒」；release 下直接杀进程）
    #[test]
    fn unique_target_exhaustion_returns_err_not_panic() {
        let (tmp, _conn) = setup();
        let dir = tmp.path();
        fs::write(dir.join("x.md"), "").unwrap();
        fs::write(dir.join("x-2.md"), "").unwrap();
        // cap=2 → 2..=2 全占用 → Err
        let r = unique_target_with_cap(dir, "x.md", 2);
        assert!(r.is_err());
        assert!(r.as_ref().unwrap_err().kind() == std::io::ErrorKind::AlreadyExists);
        // 正常去重仍工作
        let t = unique_target_with_cap(dir, "x.md", 100).unwrap();
        assert!(t.to_string_lossy().ends_with("x-3.md"));
    }

    /// 回归：移到「当前所在目录」必须是无操作。
    /// 此前 unique_target 把条目自己当「已存在」，`x.md` 会被改名 `x-2.md`（数据损坏）。
    #[test]
    fn move_to_current_dir_is_noop() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let f = create_folder(vault, "", "工作").unwrap();
        let note = create_note(vault, &f.path, "n.md").unwrap();
        write_note(vault, &note.path, "内容", &conn).unwrap();

        // 笔记 → 当前目录
        assert_eq!(move_entry(vault, &note.path, "工作", &conn).unwrap(), note.path);
        assert!(vault.join(&note.path).exists());
        assert!(!vault.join("工作/n-2.md").exists());

        // 文件夹 → 自身父目录
        let root_note = create_note(vault, "", "r.md").unwrap();
        assert_eq!(move_entry(vault, &root_note.path, "", &conn).unwrap(), root_note.path);
        assert!(!vault.join("r-2.md").exists());
    }

    /// tmp 路径必须唯一（pid+序号），并发写同一文件不互相踩踏。
    /// 场景：UI 保存 与 sync push 同时写同一笔记（此前固定 tmp 名，
    /// 一方 rename ENOENT，或把对方写一半的截断文件落成正式笔记）。
    #[test]
    fn atomic_write_tmp_unique_and_concurrent_safe() {
        let p = PathBuf::from("/tmp/x.md");
        let a = tmp_path_for(&p);
        let b = tmp_path_for(&p);
        assert_ne!(a, b, "两次调用必须得到不同 tmp 名");
        assert!(a.to_string_lossy().contains(".lanmark-tmp"));

        let (tmp, _conn) = setup();
        let vault = tmp.path();
        let target = vault.join("hot.md");
        fs::write(&target, "初始").unwrap();

        // 两线程各写 50 轮同一文件：双方都必须成功，
        // 且最终文件内容是某一方写入的完整内容（不出现截断/ENOENT）
        let t1 = std::thread::spawn({
            let t = target.clone();
            move || {
                for i in 0..50 {
                    atomic_write(&t, format!("A{}", i).as_bytes()).unwrap();
                }
            }
        });
        let t2 = std::thread::spawn({
            let t = target.clone();
            move || {
                for i in 0..50 {
                    atomic_write(&t, format!("B{}", i).as_bytes()).unwrap();
                }
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();

        let final_body = fs::read_to_string(&target).unwrap();
        assert!(
            final_body.starts_with('A') || final_body.starts_with('B'),
            "最终内容应是某次完整写入: {final_body:?}"
        );
        // 并发结束后不留孤儿 tmp
        let leftovers: Vec<_> = fs::read_dir(vault)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".lanmark-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn rename_updates_recent_paths() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let note = create_note(vault, "", "旧名.md").unwrap();
        db::record_recent(&conn, &note.path, 1, 50).unwrap();
        db::favorite_toggle(&conn, &note.path, 1).unwrap();
        let new_path = rename_entry(vault, &note.path, "新名.md", &conn).unwrap();
        let recents = db::list_recents(&conn, 10).unwrap();
        assert_eq!(recents[0].0, new_path);
        let favs = db::list_favorites(&conn).unwrap();
        assert_eq!(favs[0].0, new_path);
    }

    #[test]
    fn path_escape_blocked() {
        let (tmp, _conn) = setup();
        assert!(safe_join(tmp.path(), "../逃逸").is_err());
        assert!(safe_join(tmp.path(), "/绝对").is_err());
        assert!(safe_join(tmp.path(), "a\\b").is_err());
        assert!(safe_join(tmp.path(), "正常/子目录").is_ok());
    }

    /// 回归：vault 内符号链接必须被跳过——
    /// 目录链接会把外部文件列进树/索引/同步清单（内容经同步服务器明文外发），
    /// 链接循环会使递归栈溢出
    #[cfg(unix)]
    #[test]
    fn symlinks_skipped_in_walk_reindex_and_guarded_on_ops() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let outside = tmp
            .path()
            .parent()
            .unwrap()
            .join(format!("outside-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(outside.join("外部目录")).unwrap();
        std::fs::write(outside.join("secret.md"), "# 外部秘密").unwrap();
        std::fs::write(outside.join("外部目录/深.md"), "# 深").unwrap();

        std::os::unix::fs::symlink(&outside, vault.join("外部链接")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), vault.join("秘密.md")).unwrap();
        std::fs::create_dir_all(vault.join("循环")).unwrap();
        std::os::unix::fs::symlink(vault, vault.join("循环/loop")).unwrap();

        // 树：链接与循环都不出现
        let tree = list_tree(vault).unwrap();
        assert!(tree.iter().all(|n| n.name != "外部链接" && n.name != "秘密.md"));
        assert!(tree.iter().all(|n| !n.path.contains("loop")));

        // 索引：链接文件不进 reindex
        let n = reindex(vault, &conn).unwrap();
        assert_eq!(n, 0, "符号链接文件不得入索引");

        // 读写删均拒绝链接路径（防止经 IPC/sync 落到 vault 外）
        assert!(read_note(vault, "秘密.md").is_err());
        assert!(write_note(vault, "秘密.md", "pwn", &conn).is_err());
        assert!(delete_entry(vault, "秘密.md", &conn).is_err());
        assert!(write_note(vault, "外部链接/evil.md", "x", &conn).is_err());
        assert!(save_asset(vault, b"x", "png")
            .is_ok(), "正常 assets 写入不受影响");

        // 普通不存在路径（新建）与 vault 内路径放行
        assert!(resolve_in_vault(vault, "新笔记.md").is_ok());
        assert!(resolve_in_vault(vault, "循环/ok.md").is_ok());
        // 字符串逃逸仍被挡
        assert!(resolve_in_vault(vault, "../x").is_err());
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn reindex_rebuilds_from_disk() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let note = create_note(vault, "", "n.md").unwrap();
        // 模拟外部编辑（绕过 write_note）
        std::fs::write(vault.join(&note.path), "# 外部改动").unwrap();
        db::upsert_file(&conn, &note.path, "旧", "旧内容", 1, "", true).unwrap();

        let n = reindex(vault, &conn).unwrap();
        assert_eq!(n, 1);
        let (title, body, _, _) = db::get_file(&conn, &note.path).unwrap().unwrap();
        // 无 frontmatter 时标题 = 文件名 stem；正文来自磁盘
        assert_eq!(title, "n");
        assert_eq!(body, "# 外部改动");
        assert!(db::search(&conn, "外部", 5).unwrap().len() == 1);

        // 磁盘上删除后重索引 → 索引清掉
        std::fs::remove_file(vault.join(&note.path)).unwrap();
        reindex(vault, &conn).unwrap();
        assert!(db::get_file(&conn, &note.path).unwrap().is_none());
    }

    #[test]
    fn asset_dedup_by_hash() {
        let (tmp, _conn) = setup();
        let p1 = save_asset(tmp.path(), b"pngbytes", "png").unwrap();
        let p2 = save_asset(tmp.path(), b"pngbytes", "png").unwrap();
        assert_eq!(p1, p2);
        assert!(p1.starts_with("assets/"));
        assert!(p1.ends_with(".png"));
        assert!(tmp.path().join(&p1).exists());
    }

    /// 回归：恶意 ext（含 / 或 .. 残留段）可拼出爬出 assets/ 的路径
    #[test]
    fn save_asset_rejects_hostile_ext() {
        let (tmp, _conn) = setup();
        assert!(save_asset(tmp.path(), b"x", "../evil").is_err());
        assert!(save_asset(tmp.path(), b"x", "a/b").is_err());
        assert!(save_asset(tmp.path(), b"x", "png/../evil").is_err());
        // 归一化后为空（".."→""）走 bin 兜底，不算恶意
        let p = save_asset(tmp.path(), b"x", "..").unwrap();
        assert!(p.ends_with(".bin"));
        // 正常 ext 不受影响（含大小写/点前缀/多点）
        assert!(save_asset(tmp.path(), b"x", ".PNG").is_ok());
        assert!(save_asset(tmp.path(), b"x", "tar.gz").is_ok());
    }

    /// 回归：回收站同毫秒同名删除撞名（此前 rename 报 AlreadyExists）
    #[test]
    fn trash_name_collision_suffixed() {
        let (tmp, _conn) = setup();
        let dir = tmp.path();
        fs::create_dir_all(dir.join(TRASH_DIR)).unwrap();
        // 无冲突 → 原名
        assert_eq!(trash_unique_name(&dir.join(TRASH_DIR), "123-x.md".into()), "123-x.md");
        fs::write(dir.join(format!("{TRASH_DIR}/123-x.md")), "").unwrap();
        // 再删一个同毫秒同名的 → base 追加 -2
        assert_eq!(
            trash_unique_name(&dir.join(TRASH_DIR), "123-x.md".into()),
            "123-x.md-2"
        );
    }

    /// 回归：非 UTF-8（GBK）笔记 reindex 后 files.hash 必须等于磁盘字节 sha256
    /// （此前 read_to_string 失败 → hash = sha256(空串)）
    #[test]
    fn reindex_hashes_raw_bytes_for_non_utf8() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        // GBK「中文」，非合法 UTF-8
        let gbk: &[u8] = b"\xd6\xd0\xce\xc4";
        fs::write(vault.join("gbk.md"), gbk).unwrap();
        reindex(vault, &conn).unwrap();
        let (_t, _b, _m, hash) = db::get_file(&conn, "gbk.md").unwrap().unwrap();
        assert_eq!(hash, content_hash(gbk), "hash 基于磁盘原始字节");
    }

    /// 回归：重命名不得把 frontmatter title 降回文件名 stem（与 write_note 同纪律）
    #[test]
    fn rename_preserves_frontmatter_title() {
        let (tmp, conn) = setup();
        let vault = tmp.path();
        let note = create_note(vault, "", "旧名.md").unwrap();
        write_note(vault, &note.path, "---\ntitle: 真标题\n---\n内容", &conn).unwrap();
        let new_path = rename_entry(vault, &note.path, "新名", &conn).unwrap();
        let (title, _, _, _) = db::get_file(&conn, &new_path).unwrap().unwrap();
        assert_eq!(title, "真标题", "重命名后 title 应保留 frontmatter 值");
        // 无 frontmatter 的笔记仍回退到 stem
        let n2 = create_note(vault, "", "b.md").unwrap();
        write_note(vault, &n2.path, "纯正文", &conn).unwrap();
        let p2 = rename_entry(vault, &n2.path, "c", &conn).unwrap();
        let (t2, _, _, _) = db::get_file(&conn, &p2).unwrap().unwrap();
        assert_eq!(t2, "c");
    }

    /// 回归：树必须保持「深度优先前序 + 目录内目录在前/按名升序」。
    /// 曾因对整棵树全局 (kind, name) 排序，把不同层级节点按名穿插，
    /// 三层真实 vault 下层级完全打散（用户报障：目录树与实际结构不一致）。
    #[test]
    fn list_tree_keeps_hierarchical_dfs_order() {
        let (tmp, _conn) = setup();
        let vault = tmp.path();
        // 构造与技术支撑库同构的三层结构：
        // 技术/人工智能/CUDA.md、技术/编程语言/{Git,SQL}.md、技术/系统与网络/Arch.md、
        // 备忘/租房.md、根 README.md、assets/
        for dir in ["技术/人工智能", "技术/编程语言", "技术/系统与网络", "备忘", "assets"] {
            fs::create_dir_all(vault.join(dir)).unwrap();
        }
        for rel in [
            "技术/人工智能/CUDA C 权威编程指南.md",
            "技术/编程语言/SQL必知必会.md",
            "技术/编程语言/Git版本管理.md",
            "技术/系统与网络/Arch Linux使用笔记.md",
            "备忘/密码簿.md",
            "备忘/租房.md",
            "README.md",
        ] {
            fs::write(vault.join(rel), "# t").unwrap();
        }

        let tree = list_tree(vault).unwrap();
        let paths: Vec<&str> = tree.iter().map(|n| n.path.as_str()).collect();
        let idx = |p: &str| paths.iter().position(|&x| x == p).unwrap_or(usize::MAX);

        // 1) 子项紧跟父目录（DFS 前序）：父 < 子，且人工智能的子块先于兄弟目录编程语言
        assert!(idx("技术") < idx("技术/人工智能"));
        assert!(idx("技术/人工智能") < idx("技术/人工智能/CUDA C 权威编程指南.md"));
        assert!(idx("技术/人工智能/CUDA C 权威编程指南.md") < idx("技术/编程语言"));

        // 2) 同目录内目录在前、按名升序：备忘 < 技术，根级笔记 README 在根级目录后
        assert!(idx("备忘") < idx("技术"));
        assert!(idx("技术/系统与网络/Arch Linux使用笔记.md") < idx("README.md"));

        // 2b) 附件目录不进树（assets/ 是 save_asset 的图片落盘处，UI 侧隐藏）
        assert!(!paths.contains(&"assets"));

        // 3) 兄弟子块连续：备忘 的两个文件相邻，且按名升序（密 < 租）
        assert_eq!(idx("备忘/密码簿.md") + 1, idx("备忘/租房.md"));
    }
}
