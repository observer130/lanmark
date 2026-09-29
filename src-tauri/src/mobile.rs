//! M2 移动端自研小插件：vault 目录选择 + 全部文件访问授权。
//!
//! Android 的 scoped storage 下 std::fs 直写共享存储需要 MANAGE_EXTERNAL_STORAGE
//! （调研 docs/research/android-vault-dir.md：SAF+路径映射仅在 legacy 视图可行，
//! 侧载 App 用 MANAGE 最简可靠）。插件三命令：
//! - has_all_files_access：检查授权
//! - request_all_files_access：跳系统设置授权页（无回调，返回后前端复查）
//! - pick_folder：SAF 选择器 UI，primary 卷映射回真实路径交给 vault_set_path
//!
//! 结构：插件只负责把 Kotlin 桥（PluginHandle）管理起来；命令挂在 App 命令层
//! （App 自有命令不走 ACL，插件命令则需要 capabilities——省一层配置）。
//!
//! 注意：应用私有外部目录（Android/data/<pkg>）由系统懒创建，std::fs 直接
//! mkdir 包目录会被 FUSE 拒绝（os error 13，全新安装必现，2026-09-23 真机
//! 复现）——必须走 appDir 命令经 getExternalFilesDir 由框架创建，前端不得
//! 硬编码整链路径后自行建目录。

#[cfg(target_os = "android")]
use serde::de::DeserializeOwned;
#[cfg(target_os = "android")]
use serde_json::Value;
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
use tauri::Manager;

/// Kotlin 桥句柄（PluginHandle 可 Clone；app 运行时固定为 Wry）
#[derive(Clone)]
pub struct VaultPickerMobile(
    #[cfg(target_os = "android")] Option<PluginHandle<tauri::Wry>>,
    #[cfg(not(target_os = "android"))] (),
);

/// M4i 返回手势插件（BackPlugin）的桥句柄
#[derive(Clone)]
pub struct BackMobile(
    #[cfg(target_os = "android")] Option<PluginHandle<tauri::Wry>>,
    #[cfg(not(target_os = "android"))] (),
);

/// App 运行时固定 Wry（tauri::Builder::default()）；移动端入口仅 Android
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("vault-picker")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.lanmark.app", "VaultPickerPlugin")?;
                app.manage(VaultPickerMobile(Some(handle)));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(VaultPickerMobile(()));
            }
            Ok(())
        })
        .build()
}

/// 在 blocking 线程上调用 Kotlin 方法（PluginHandle::run_mobile_plugin 会阻塞等待
/// resolve——不能在异步上下文直调，tauri#13063）。
#[cfg(target_os = "android")]
fn call_mobile<T: DeserializeOwned>(
    state: VaultPickerMobile,
    method: &str,
) -> Result<T, String> {
    let handle = state.0.as_ref().ok_or("插件未初始化")?;
    handle
        .run_mobile_plugin(method.to_string(), ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
fn owned_state(state: tauri::State<'_, VaultPickerMobile>) -> VaultPickerMobile {
    state.inner().clone()
}

// ---------- App 命令（lib.rs generate_handler 注册） ----------

/// 是否已获「所有文件访问」授权（Android 11+ MANAGE_EXTERNAL_STORAGE；旧版按 WRITE 权限）
#[tauri::command]
pub async fn vault_picker_has_all_files_access(
    state: tauri::State<'_, VaultPickerMobile>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let st = owned_state(state);
        tauri::async_runtime::spawn_blocking(move || {
            let v: Value = call_mobile(st, "hasAllFilesAccess")?;
            Ok(v.get("granted").and_then(Value::as_bool).unwrap_or(false))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Err("仅 Android 支持".into())
    }
}

/// 跳转系统设置「所有文件访问」授权页；用户返回后前端再查一次授权状态
#[tauri::command]
pub async fn vault_picker_request_all_files_access(
    state: tauri::State<'_, VaultPickerMobile>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let st = owned_state(state);
        tauri::async_runtime::spawn_blocking(move || {
            call_mobile::<Value>(st, "requestAllFilesAccess").map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Err("仅 Android 支持".into())
    }
}

/// 应用私有外部目录（getExternalFilesDir，框架保证创建；未获取到 → None）
#[tauri::command]
pub async fn vault_picker_app_dir(
    state: tauri::State<'_, VaultPickerMobile>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let st = owned_state(state);
        tauri::async_runtime::spawn_blocking(move || {
            let v: Value = call_mobile(st, "appDir")?;
            Ok(v.get("path").and_then(Value::as_str).map(String::from))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Err("仅 Android 支持".into())
    }
}

/// SAF 目录选择器；返回 primary 卷映射后的真实路径（用户取消 → None）
#[tauri::command]
pub async fn vault_picker_pick_folder(
    state: tauri::State<'_, VaultPickerMobile>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let st = owned_state(state);
        tauri::async_runtime::spawn_blocking(move || {
            let v: Value = call_mobile(st, "pickFolder")?;
            Ok(v.get("path").and_then(Value::as_str).map(String::from))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Err("仅 Android 支持".into())
    }
}

/// M4i 返回手势插件，独立 Builder → 独立插件名 `back`。
///
/// 插件名取自 `Builder::new(…)` 而非 Kotlin 类名：`invoke("plugin:<名>|…")`
/// 与 `addPluginListener` 都按它匹配。与 vault-picker 分开注册，避免两个
/// Kotlin 类共用一个名字时互相遮蔽。
pub fn init_back() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("back")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.lanmark.app", "BackPlugin")?;
                app.manage(BackMobile(Some(handle)));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(BackMobile(()));
            }
            Ok(())
        })
        .build()
}

/// BackPlugin 调用（带参数）
#[cfg(target_os = "android")]
fn call_back_with_args<T: DeserializeOwned>(
    state: BackMobile,
    method: &str,
    args: serde_json::Map<String, Value>,
) -> Result<T, String> {
    let handle = state.0.as_ref().ok_or("插件未初始化")?;
    handle
        .run_mobile_plugin(method.to_string(), Value::Object(args))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
fn owned_state_back(state: tauri::State<'_, BackMobile>) -> BackMobile {
    state.inner().clone()
}

/// M4i 返回手势：前端声明「当前返回该做什么」。
///
/// 返回在 Kotlin 侧拦（MainActivity 的 dispatchKeyEvent / OnBackPressedCallback），
/// 但「该关抽屉还是退出」只有前端知道 —— 由前端在浮层开关时下发处理器名：
/// `drawer` / `overlay` / 其它=无浮层（原生不拦截，正常退出）。
/// 事件上行走 DOM CustomEvent（见 BackPlugin.triggerBack），不走插件事件通道：
/// 真机 2510DRK44C / Android 16 实测 addPluginListener 注册后 hasListener=false。
#[tauri::command]
pub async fn set_ui_back_handler(
    state: tauri::State<'_, BackMobile>,
    handler: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let st = owned_state_back(state);
        tauri::async_runtime::spawn_blocking(move || {
            let mut args = serde_json::Map::new();
            args.insert("handler".into(), serde_json::Value::String(handler));
            call_back_with_args::<Value>(st, "setUiBackHandler", args).map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (state, handler);
        Ok(())
    }
}
