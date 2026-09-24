mod bridge;
mod commands;
mod db;
mod fs_ops;
mod mobile;
mod protocol;
mod sanitize;
mod settings;
mod settings_cmd;
mod sync;
mod sync_client;
mod sync_server;
mod vault;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Emitter;
use tauri::Manager;
use vault::AppState;

/// M0 双向桥演示保留（ping 的事件模式将被同步引擎复用）
#[tauri::command]
fn ping(app: tauri::AppHandle, message: String) -> Result<bridge::EchoPayload, String> {
    let payload = bridge::build_echo(&message, bridge::now_unix_ms(), "lanmark-core");
    app.emit(bridge::ECHO_EVENT, payload.clone())
        .map_err(|e| e.to_string())?;
    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(vault::AppState::default());
    let protocol_state = Arc::clone(&state);
    let app = tauri::Builder::default()
        // vault:// 协议：笔记内相对路径（图片等）→ vault 内真实文件
        .register_asynchronous_uri_scheme_protocol("vault", move |_ctx, request, responder| {
            let state = Arc::clone(&protocol_state);
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                let file = tauri::async_runtime::spawn_blocking(move || protocol::resolve(&state, &path))
                    .await
                    .ok()
                    .flatten();
                responder.respond(protocol::respond(file));
            });
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // M2 移动端小插件：vault 目录选择（SAF + 全部文件访问授权），见 src/mobile.rs
        .plugin(mobile::init())
        // 日志：stdout（无头 E2E / 终端可见 WebView console）+ 日志文件
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lanmark".to_string()),
                    }),
                ])
                .build(),
        )
        .manage(state.clone())
        // 启动时自动打开上次配置的 vault（重索引 + 恢复 DB）
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Arc<AppState>>().inner().clone();
            // M3f：同步服务器改动 vault（push 落盘/delete 生效）→ 推事件让前端刷新。
            // 手机端是服务器、无客户端循环（桌面 runRound 回合后自行刷新，且桌面不启动服务器）
            if let Ok(mut slot) = state.sync_notify.lock() {
                let nh = handle.clone();
                *slot = Some(Arc::new(move || {
                    let _ = nh.emit(
                        sync_server::VAULT_CHANGED_EVENT,
                        serde_json::json!({ "source": "sync" }),
                    );
                }));
            }
            tauri::async_runtime::spawn(async move {
                let cfg = vault::load_config(&handle);
                if let Some(p) = cfg.vault_path.filter(|p| !p.is_empty()) {
                    let path = PathBuf::from(p);
                    if path.is_dir() {
                        // open_vault_at 含全量 reindex：直接跑在 async worker 上
                        // 会阻塞该 worker，拖慢同 runtime 的 IPC 命令
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(e) = commands::open_vault_at(&state, &path) {
                                eprintln!("自动打开 vault 失败: {e}");
                            }
                        })
                        .await
                        .ok();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            settings_cmd::settings_get,
            settings_cmd::settings_patch,
            settings_cmd::settings_reset,
            commands::vault_status,
            commands::vault_set_path,
            commands::vault_set_sync_auto,
            commands::vault_ensure_dir,
            commands::vault_open_path,
            commands::reindex_vault,
            commands::tree_list,
            commands::note_create,
            commands::folder_create,
            commands::entry_rename,
            commands::entry_move,
            commands::entry_delete,
            commands::folder_colors,
            commands::folder_color_set,
            commands::note_read,
            commands::note_write,
            commands::search,
            commands::recents_list,
            commands::favorites_list,
            commands::favorite_toggle,
            commands::asset_save,
            sync_server::sync_pairing_info,
            sync_server::sync_server_start,
            sync_server::sync_conflict_count,
            sync_client::sync_discover,
            sync_client::sync_pair,
            sync_client::sync_servers,
            sync_client::sync_server_remove,
            sync_client::sync_now,
            sync_client::sync_probe,
            sync_client::sync_server_set_url,
            mobile::vault_picker_has_all_files_access,
            mobile::vault_picker_request_all_files_access,
            mobile::vault_picker_app_dir,
            mobile::vault_picker_pick_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Android：上滑划掉 Activity 会触发 tao 的 process::exit(0) 连前台服务一起杀
    // （tauri#15671）——必须 prevent_exit 保住同步服务器进程；
    // 划掉后重开白屏（新 activity 的窗口拿不到绑定，webview 永不创建，真机 2026-09-18
    // 验收复现）。ExitRequested = activity 销毁的确定信号（置标志），下一次 Resumed
    // 销毁残留旧窗口 + 重建（经 next_available_activity 绑定到新 activity）。
    // 普通切后台恢复不经过 ExitRequested → 不动窗口，无副作用。
    #[cfg(target_os = "android")]
    static ACTIVITY_LOST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    #[cfg(target_os = "android")]
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            api.prevent_exit();
            ACTIVITY_LOST.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        tauri::RunEvent::Resumed { .. } => {
            if ACTIVITY_LOST.swap(false, std::sync::atomic::Ordering::Relaxed) {
                use tauri::WebviewUrl;
                let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
                for label in labels {
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.destroy();
                    }
                }
                let _ =
                    tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::default()).build();
            }
        }
        _ => {}
    });
    #[cfg(not(target_os = "android"))]
    app.run(|_app, _event| {});
}
