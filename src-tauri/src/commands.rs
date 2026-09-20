//! Tauri 命令层：`xxx` 是 3 行的命令封装（IPC 入口），`xxx_op` 是纯逻辑
//! （接收 &Arc<AppState>，可被集成测试与 M2/M3 的同步引擎直接复用）。
//! 约定：所有路径参数均为 vault 相对路径（'/' 分隔）；未打开 vault 时返回错误。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::db;
use crate::fs_ops::{self, Node};
use crate::vault::{self, AppState};

pub type CmdResult<T> = Result<T, String>;

pub(crate) fn with_db<T>(state: &Arc<AppState>, f: impl FnOnce(&Connection) -> CmdResult<T>) -> CmdResult<T> {
    let guard = state.db.lock().map_err(|_| "DB 锁中毒")?;
    let conn = guard.as_ref().ok_or("尚未打开 vault")?;
    f(conn)
}

pub(crate) fn with_vault<T>(state: &Arc<AppState>, f: impl FnOnce(&PathBuf) -> CmdResult<T>) -> CmdResult<T> {
    let guard = state.vault.lock().map_err(|_| "vault 锁中毒")?;
    let vault = guard.as_ref().ok_or("尚未打开 vault")?;
    f(vault)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub configured: bool,
    pub open: bool,
    pub path: Option<String>,
    /// M3：自动同步开关（默认 true）
    pub sync_auto: bool,
}

#[tauri::command]
pub fn vault_status(app: tauri::AppHandle, state: State<Arc<AppState>>) -> CmdResult<VaultStatus> {
    let cfg = vault::load_config(&app);
    let open = state.vault.lock().map_err(|_| "锁中毒")?.is_some();
    Ok(VaultStatus {
        configured: cfg.vault_path.is_some(),
        open,
        path: cfg.vault_path.clone(),
        sync_auto: cfg.sync_auto,
    })
}

/// 按路径打开/创建 vault 并持久化配置。
/// 文件夹选择由前端完成（JS dialog 桌面跨平台；移动端 M1 用 app 文档目录，M2 改 SAF 选择器），
/// 本命令只接收路径——Rust 侧不依赖任何 cfg(desktop) 的对话框 API。
#[tauri::command]
pub async fn vault_set_path(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    mode: String,
) -> CmdResult<String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    // 开库含全量 reindex（大库可达数秒）：同步命令跑在 Tauri 主线程会冻 UI，
    // Android 上有 ANR 风险 → 阻塞主体挪出主线程
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
        pick_and_set_op(&state, &p, &mode)?;
        // 读旧配置只改 vault_path：syncAuto 等既有字段不得被开库重置
        let mut cfg = vault::load_config(&app);
        cfg.vault_path = Some(path.clone());
        vault::save_config(&app, &cfg).map_err(|e| format!("保存配置失败: {e}"))?;
        Ok(path)
    })
    .await
    .map_err(|e| format!("开库任务失败: {e}"))?
}

/// M3：自动同步开关（app_config_dir/config.json 持久化，docs/07 §7）
#[tauri::command]
pub fn vault_set_sync_auto(app: tauri::AppHandle, enabled: bool) -> CmdResult<bool> {
    let mut cfg = vault::load_config(&app);
    cfg.sync_auto = enabled;
    vault::save_config(&app, &cfg).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(enabled)
}

/// 纯逻辑：校验目录 → 开库（对话框与配置持久化由上层负责）
pub fn pick_and_set_op(state: &Arc<AppState>, path: &Path, mode: &str) -> CmdResult<()> {
    match mode {
        "create" => {
            // 允许空目录；若目录里已有笔记则拒绝，避免误吞
            let has_notes = std::fs::read_dir(path)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .any(|e| e.file_name().to_string_lossy().ends_with(".md"))
                })
                .unwrap_or(false);
            if has_notes {
                return Err("所选目录已包含 .md 笔记，请改用「打开」模式".into());
            }
        }
        "open" => {}
        _ => return Err(format!("未知模式: {mode}")),
    }
    open_vault_at(state, path)
}

/// Android 首启「应用目录」场景：目录可能尚不存在，先创建（含父目录）。
/// 路径安全：只允许绝对路径、拒绝 .. 段与非法字符。
#[tauri::command]
pub fn vault_ensure_dir(path: String) -> CmdResult<String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("非法路径: {path}"));
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(path)
}

/// 直接按路径打开 vault（设置页 / 测试用）
#[tauri::command]
pub async fn vault_open_path(state: State<'_, Arc<AppState>>, path: String) -> CmdResult<String> {
    let state = state.inner().clone();
    // reindex 重活挪出主线程（同 vault_set_path）
    tauri::async_runtime::spawn_blocking(move || vault_open_path_op(&state, path))
        .await
        .map_err(|e| format!("开库任务失败: {e}"))?
}

pub fn vault_open_path_op(state: &Arc<AppState>, path: String) -> CmdResult<String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    open_vault_at(state, &p)?;
    Ok(path)
}

pub fn open_vault_at(state: &Arc<AppState>, path: &Path) -> CmdResult<()> {
    fs_ops::ensure_layout(path).map_err(|e| format!("初始化 vault 失败: {e}"))?;
    let db_path = path.join(fs_ops::META_DIR).join("lanmark.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {e}"))?;
    // WAL 在部分共享存储（Android 外部存储）上不可用：回退必须留痕，
    // 否则「搜索偶发锁库」一类问题无从排查
    if let Err(e) = conn.pragma_update(None, "journal_mode", "WAL") {
        log::warn!("WAL 模式启用失败（回退默认 journal）: {e}");
    }
    db::init_db(&conn).map_err(|e| format!("初始化数据库失败: {e}"))?;
    {
        let mut vg = state.vault.lock().map_err(|_| "锁中毒")?;
        let mut dg = state.db.lock().map_err(|_| "锁中毒")?;
        fs_ops::reindex(path, &conn).map_err(|e| format!("重索引失败: {e}"))?;
        *vg = Some(path.to_path_buf());
        *dg = Some(conn);
    }
    // M2：Android = 局域网同步中心节点，vault 打开即启动 axum 服务器（幂等；
    // 前台服务由 Kotlin 侧保活，见 gen/android SyncService）。桌面默认不做服务器。
    #[cfg(target_os = "android")]
    {
        let st = Arc::clone(state);
        std::thread::spawn(move || {
            if let Err(e) = crate::sync_server::spawn(st) {
                eprintln!("同步服务器启动失败: {e}");
            }
        });
    }
    Ok(())
}

// ---------- 纯逻辑（xxx_op） ----------

pub fn reindex_vault_op(state: &Arc<AppState>) -> CmdResult<usize> {
    with_vault(state, |vault| with_db(state, |conn| fs_ops::reindex(vault, conn).map_err(|e| e.to_string())))
}

pub fn tree_list_op(state: &Arc<AppState>) -> CmdResult<Vec<Node>> {
    with_vault(state, |vault| fs_ops::list_tree(vault).map_err(|e| e.to_string()))
}

pub fn note_create_op(state: &Arc<AppState>, dir: &str, name: &str) -> CmdResult<Node> {
    with_vault(state, |vault| {
        with_db(state, |conn| {
            let node = fs_ops::create_note(vault, dir, name).map_err(|e| e.to_string())?;
            db::upsert_file(conn, &node.path, node.title.as_deref().unwrap_or(""), "", fs_ops::now_ms(), "", true)
                .map_err(|e| e.to_string())?;
            Ok(node)
        })
    })
}

pub fn folder_create_op(state: &Arc<AppState>, dir: &str, name: &str) -> CmdResult<Node> {
    with_vault(state, |vault| fs_ops::create_folder(vault, dir, name).map_err(|e| e.to_string()))
}

pub fn entry_rename_op(state: &Arc<AppState>, path: &str, new_name: &str) -> CmdResult<String> {
    with_vault(state, |vault| with_db(state, |conn| fs_ops::rename_entry(vault, path, new_name, conn).map_err(|e| e.to_string())))
}

pub fn entry_move_op(state: &Arc<AppState>, path: &str, new_dir: &str) -> CmdResult<String> {
    with_vault(state, |vault| with_db(state, |conn| fs_ops::move_entry(vault, path, new_dir, conn).map_err(|e| e.to_string())))
}

pub fn entry_delete_op(state: &Arc<AppState>, path: &str) -> CmdResult<String> {
    with_vault(state, |vault| {
        with_db(state, |conn| {
            // M3b：删除前记 tombstone（文件夹 = 展开其下全部同步单元；hash 以磁盘为准），
            // 本地 UI 删除与服务器 /delete 都走这里 → 两侧墓碑统一
            if let Ok(files) = fs_ops::entry_file_list(vault, path, conn) {
                let now = fs_ops::now_ms();
                for f in &files {
                    if let Ok(bytes) = std::fs::read(vault.join(f)) {
                        let h = fs_ops::content_hash(&bytes);
                        if let Err(e) = crate::sync::record_tombstone(vault, f, &h, now) {
                            log::warn!("记 tombstone 失败 {f}: {e}");
                        }
                    }
                }
            }
            fs_ops::delete_entry(vault, path, conn).map_err(|e| e.to_string())
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub content: String,
    pub title: String,
}

/// 读取笔记内容，同时记入「最近」
pub fn note_read_op(state: &Arc<AppState>, path: &str) -> CmdResult<NoteContent> {
    with_vault(state, |vault| {
        let content = fs_ops::read_note(vault, path).map_err(|e| e.to_string())?;
        with_db(state, |conn| {
            db::record_recent(conn, path, fs_ops::now_ms(), 50).map_err(|e| e.to_string())?;
            let title = fs_ops::title_from_stem(path.rsplit('/').next().unwrap_or(path));
            Ok(NoteContent { content, title })
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: i64,
    pub hash: String,
}

pub fn note_write_op(state: &Arc<AppState>, path: &str, content: &str) -> CmdResult<WriteResult> {
    with_vault(state, |vault| {
        with_db(state, |conn| {
            let (mtime_ms, hash) = fs_ops::write_note(vault, path, content, conn).map_err(|e| e.to_string())?;
            Ok(WriteResult { mtime_ms, hash })
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

pub fn search_op(state: &Arc<AppState>, query: &str) -> CmdResult<Vec<SearchHit>> {
    with_db(state, |conn| {
        Ok(db::search(conn, query, 50)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|h| SearchHit { path: h.path, title: h.title, snippet: h.snippet })
            .collect())
    })
}

pub fn recents_list_op(state: &Arc<AppState>) -> CmdResult<Vec<(String, String)>> {
    with_db(state, |conn| db::list_recents(conn, 20).map_err(|e| e.to_string()))
}

pub fn favorites_list_op(state: &Arc<AppState>) -> CmdResult<Vec<(String, String)>> {
    with_db(state, |conn| db::list_favorites(conn).map_err(|e| e.to_string()))
}

/// 返回切换后的状态（true=已收藏）
pub fn favorite_toggle_op(state: &Arc<AppState>, path: &str) -> CmdResult<bool> {
    with_db(state, |conn| db::favorite_toggle(conn, path, fs_ops::now_ms()).map_err(|e| e.to_string()))
}

pub fn asset_save_op(state: &Arc<AppState>, data_base64: &str, ext: &str) -> CmdResult<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    with_vault(state, |vault| fs_ops::save_asset(vault, &bytes, ext).map_err(|e| e.to_string()))
}

// ---------- IPC 封装（3 行一层） ----------

#[tauri::command]
pub async fn reindex_vault(state: State<'_, Arc<AppState>>) -> CmdResult<usize> {
    let state = state.inner().clone();
    // 全量 reindex 挪出主线程（同 vault_set_path）
    tauri::async_runtime::spawn_blocking(move || reindex_vault_op(&state))
        .await
        .map_err(|e| format!("重索引任务失败: {e}"))?
}

#[tauri::command]
pub async fn tree_list(state: State<'_, Arc<AppState>>) -> CmdResult<Vec<Node>> {
    let state = state.inner().clone();
    // 全 vault 目录遍历挪出主线程（大库下冻 UI 同类风险）
    tauri::async_runtime::spawn_blocking(move || tree_list_op(&state))
        .await
        .map_err(|e| format!("目录树任务失败: {e}"))?
}

#[tauri::command]
pub fn note_create(state: State<Arc<AppState>>, dir: String, name: String) -> CmdResult<Node> {
    note_create_op(state.inner(), &dir, &name)
}

#[tauri::command]
pub fn folder_create(state: State<Arc<AppState>>, dir: String, name: String) -> CmdResult<Node> {
    folder_create_op(state.inner(), &dir, &name)
}

#[tauri::command]
pub fn entry_rename(state: State<Arc<AppState>>, path: String, new_name: String) -> CmdResult<String> {
    entry_rename_op(state.inner(), &path, &new_name)
}

#[tauri::command]
pub fn entry_move(state: State<Arc<AppState>>, path: String, new_dir: String) -> CmdResult<String> {
    entry_move_op(state.inner(), &path, &new_dir)
}

#[tauri::command]
pub fn entry_delete(state: State<Arc<AppState>>, path: String) -> CmdResult<String> {
    entry_delete_op(state.inner(), &path)
}

#[tauri::command]
pub fn note_read(state: State<Arc<AppState>>, path: String) -> CmdResult<NoteContent> {
    note_read_op(state.inner(), &path)
}

#[tauri::command]
pub fn note_write(state: State<Arc<AppState>>, path: String, content: String) -> CmdResult<WriteResult> {
    note_write_op(state.inner(), &path, &content)
}

#[tauri::command]
pub fn search(state: State<Arc<AppState>>, query: String) -> CmdResult<Vec<SearchHit>> {
    search_op(state.inner(), &query)
}

#[tauri::command]
pub fn recents_list(state: State<Arc<AppState>>) -> CmdResult<Vec<(String, String)>> {
    recents_list_op(state.inner())
}

#[tauri::command]
pub fn favorites_list(state: State<Arc<AppState>>) -> CmdResult<Vec<(String, String)>> {
    favorites_list_op(state.inner())
}

#[tauri::command]
pub fn favorite_toggle(state: State<Arc<AppState>>, path: String) -> CmdResult<bool> {
    favorite_toggle_op(state.inner(), &path)
}

#[tauri::command]
pub fn asset_save(state: State<Arc<AppState>>, data_base64: String, ext: String) -> CmdResult<String> {
    asset_save_op(state.inner(), &data_base64, &ext)
}

// ---------- 命令层集成测试 ----------

#[cfg(test)]
mod e2e_tests {
    //! 验收主链路：建目录 → 写图文笔记 → 搜索到它 → 重命名 → 最近/收藏 → 删除回收站。
    //! 走 UI 实际调用的 _op 函数（与 IPC 封装仅差一层 3 行转发）。
    use super::*;
    use base64::Engine;
    use tempfile::TempDir;

    fn opened_vault() -> (TempDir, Arc<AppState>) {
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        (dir, state)
    }

    #[test]
    fn acceptance_flow_folder_note_image_search_rename_delete() {
        let (dir, state) = opened_vault();
        let s = &state;

        // 1. 建目录
        let folder = folder_create_op(s, "", "工作").unwrap();
        assert_eq!(folder.path, "工作");
        assert!(dir.path().join("工作").is_dir());

        // 2. 写图文笔记（附件落盘 + 正文引用）
        let note = note_create_op(s, "工作", "会议 纪要").unwrap();
        assert_eq!(note.path, "工作/会议-纪要.md"); // 空格规范化为 -
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"fake-png-bytes");
        let asset = asset_save_op(s, &b64, "png").unwrap();
        assert!(asset.starts_with("assets/"));
        assert!(asset.ends_with(".png"));
        assert!(dir.path().join(&asset).exists());
        let content = format!("# 会议纪要\n\n讨论内容 很重要\n\n![]({})\n", asset);
        let wr = note_write_op(s, &note.path, &content).unwrap();
        assert!(!wr.hash.is_empty());
        let on_disk = std::fs::read_to_string(dir.path().join(&note.path)).unwrap();
        assert_eq!(on_disk, content); // 文件内容与写入一致

        // 3. 搜索到它（中文正文）
        let hits = search_op(s, "很重要").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, note.path);
        assert!(hits[0].snippet.contains("很重要"));

        // 4. 文件夹重命名 → 子笔记索引跟着走，搜索仍命中新路径
        let new_folder = entry_rename_op(s, "工作", "研发").unwrap();
        assert_eq!(new_folder, "研发");
        assert!(dir.path().join("研发/会议-纪要.md").exists());
        let hits2 = search_op(s, "很重要").unwrap();
        assert_eq!(hits2.len(), 1);
        assert_eq!(hits2[0].path, "研发/会议-纪要.md");

        // 5. 最近 / 收藏
        let read = note_read_op(s, "研发/会议-纪要.md").unwrap();
        assert!(read.content.contains("很重要"));
        let recents = recents_list_op(s).unwrap();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].0, "研发/会议-纪要.md");
        assert!(favorite_toggle_op(s, "研发/会议-纪要.md").unwrap());
        assert_eq!(favorites_list_op(s).unwrap().len(), 1);

        // 6. 删除 → 回收站，索引与收藏清空
        let trash = entry_delete_op(s, "研发/会议-纪要.md").unwrap();
        assert!(trash.starts_with(".lanmark/trash/"));
        assert!(dir.path().join(&trash).exists());
        assert!(!dir.path().join("研发/会议-纪要.md").exists());
        assert!(search_op(s, "很重要").unwrap().is_empty());
        assert!(recents_list_op(s).unwrap().is_empty());
        assert!(favorites_list_op(s).unwrap().is_empty());
    }

    #[test]
    fn create_note_sanitizes_and_uniquifies() {
        let (_dir, state) = opened_vault();
        let s = &state;
        let a = note_create_op(s, "", "a/b?:*").unwrap();
        assert_eq!(a.path, "a-b.md"); // 非法字符剔除 + 连续 - 合并 + 首尾修剪
        let b = note_create_op(s, "", "a/b?:*").unwrap();
        assert_eq!(b.path, "a-b-2.md"); // 同名自动 -2
        let c = note_create_op(s, "", "CON").unwrap();
        assert_eq!(c.path, "n-CON.md"); // Windows 保留名防护
    }

    #[test]
    fn rename_note_preserves_extension_and_updates_index() {
        let (_dir, state) = opened_vault();
        let s = &state;
        let note = note_create_op(s, "", "旧名字").unwrap();
        note_write_op(s, &note.path, "正文 内容").unwrap();
        let new_path = entry_rename_op(s, &note.path, "新名字").unwrap();
        assert_eq!(new_path, "新名字.md"); // 不带 .md 提交也保留扩展名
        let hits = search_op(s, "正文").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, new_path);
        assert_eq!(hits[0].title, "新名字"); // 标题随文件名更新
    }

    #[test]
    fn folder_move_updates_children_and_trash() {
        let (dir, state) = opened_vault();
        let s = &state;
        let f1 = folder_create_op(s, "", "a").unwrap();
        let f2 = folder_create_op(s, "", "b").unwrap();
        let note = note_create_op(s, &f1.path, "n.md").unwrap();
        note_write_op(s, &note.path, "移动测试").unwrap();

        let moved = entry_move_op(s, &f1.path, &f2.path).unwrap();
        assert_eq!(moved, "b/a");
        assert!(dir.path().join("b/a/n.md").exists());
        let hits = search_op(s, "移动测试").unwrap();
        assert_eq!(hits[0].path, "b/a/n.md");
    }

    #[test]
    fn commands_fail_gracefully_without_vault() {
        let state = Arc::new(AppState::default());
        let s = &state;
        assert!(tree_list_op(s).is_err());
        assert!(note_create_op(s, "", "x").is_err());
        assert!(search_op(s, "x").is_err());
        assert!(note_read_op(s, "x").is_err());
    }

    #[test]
    fn create_mode_rejects_dir_with_notes() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("existing.md"), "x").unwrap();
        let state = Arc::new(AppState::default());
        let err = pick_and_set_op(&state, dir.path(), "create").unwrap_err();
        assert!(err.contains("已包含"));
        // open 模式则放行
        assert!(open_vault_at(&state, dir.path()).is_ok());
    }

    #[test]
    fn perf_guardrail_500_notes_reindex_and_search() {
        //! 设计文档声称 LIKE 搜索可撑到 ~1e4 笔记；此处用 500 笔记验证量级安全。
        use std::time::Instant;

        let dir = TempDir::new().unwrap();
        for i in 0..500 {
            let sub = format!("dir{}", i % 5);
            std::fs::create_dir_all(dir.path().join(&sub)).unwrap();
            let content = format!("# 笔记 {i}\n\n编号 {i} 的正文，关键词 kw{i:03}。{}\n", "填充内容。".repeat(10));
            std::fs::write(dir.path().join(format!("{sub}/笔记-{i:03}.md")), content).unwrap();
        }

        let state = Arc::new(AppState::default());
        let t0 = Instant::now();
        open_vault_at(&state, dir.path()).unwrap(); // 含全量 reindex
        let index_ms = t0.elapsed().as_millis();

        let t1 = Instant::now();
        let exact = search_op(&state, "kw499").unwrap();
        let prefix = search_op(&state, "kw12").unwrap(); // 命中 kw120..kw129
        let search_ms = t1.elapsed().as_millis();

        assert_eq!(exact.len(), 1);
        assert_eq!(prefix.len(), 10);
        eprintln!("perf: 500 笔记 reindex={index_ms}ms, 两次搜索={search_ms}ms");
        assert!(index_ms < 10_000, "reindex 过慢: {index_ms}ms");
        assert!(search_ms < 1_000, "搜索过慢: {search_ms}ms");
    }
}
