//! 设备代号（alias，M4h-4）：局域网内标识「这台设备是谁」的一等概念。
//!
//! 灵感与语义对标 LocalSend 的 `alias`：设备列表、授权卡片全程只说代号，
//! IP/端口退到兜底路径。代号是**设备级**偏好（换库不变），落
//! `app_config_dir/config.json` 的 `AppConfig.deviceAlias`（硬约定 10 的分界）；
//! vault 内 `.lanmark/sync.json` 的 `device_name` 保留不动（鉴权与身份仍随库），
//! 展示层从代号读取，`sync.json` 的名字只作旧版回退。
//!
//! 与 LocalSend 的差异：词表是中文（「青柠手机」「晨窗台机」），
//! 重名由 `/api/v1/pair-request` 服务器侧加数字尾缀消解（单用户场景足够）。

use sha2::{Digest, Sha256};

/// 形容词词表（首字相同也算不同代号，UI 全量展示不缩写）
const ADJECTIVES: [&str; 24] = [
    "青柠", "晨窗", "山雾", "晚风", "湖心", "松间", "橘灯", "青瓷",
    "苔原", "稻香", "溪畔", "檐下", "巷口", "轻雷", "萤火", "雪原",
    "苇岸", "青梅", "木纹", "秋千", "星野", "野蜂", "渡口", "纸鸢",
];

/// 名词词表（第二个字已含「手机/台机」角色提示，不再单独存 deviceType）
const NOUNS: [&str; 16] = [
    "手机", "台机", "笔电", "平板", "书房", "客厅", "口袋", "抽屉",
    "竹椅", "石阶", "木桌", "书架", "阁楼", "茶几", "窗台", "门厅",
];

/// 代号长度上限：本地词表生成的最长 4 字（+尾缀 2 位数字 = 6），
/// 用户手输给到 24，mDNS 服务名/配对卡片都放得下
const ALIAS_MAX_CHARS: usize = 24;

/// 生成默认代号：sha256(时间纳秒 + pid + 指针地址) 映射进词表。
/// 与 `gen_pairing_code` / `gen_device_id` 同一熵来源纪律（时间+pid+地址混熵），
/// 同纳秒内两次调用也不会撞同一个词。
pub fn gen_default_alias() -> String {
    let material = format!(
        "alias{}{}{:p}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id(),
        &std::env::temp_dir(),
    );
    let hash = Sha256::digest(material.as_bytes());
    let a = &ADJECTIVES[hash[0] as usize % ADJECTIVES.len()];
    let n = &NOUNS[hash[1] as usize % NOUNS.len()];
    format!("{a}{n}")
}

/// 归一化代号：trim 后按**字符数**限长（中文一字一符，不能按字节截——
/// 半个 UTF-8 字符会 panic 或成乱码），空串回退 `None` 让调用方落默认词表值。
pub fn normalize_alias(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let out: String = s.chars().take(ALIAS_MAX_CHARS).collect();
    Some(out)
}

/// 桌面端专用：带角色默认值。手机端首启默认词表随机代号；
/// 桌面端 HOSTNAME 语义过去一直存在（授权卡片显示 nwj-PC），保留为默认
/// 代号，用户可改。拿不到主机名时回退平台名。
pub fn desktop_default_alias() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .map(|s| normalize_alias(&s).unwrap_or_else(|| s.trim().to_string()))
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "Windows 电脑".into()
            } else if cfg!(target_os = "macos") {
                "Mac 电脑".into()
            } else {
                "Lanmark 电脑".into()
            }
        })
}

// ---------- AppConfig 集成（进程内缓存，避免每次 /info 都读盘） ----------

use std::sync::Mutex;

static ALIAS_CACHE: Mutex<Option<String>> = Mutex::new(None);

/// 当前代号：缓存命中直接返回；未命中时初始化——配置里已有非空值则保留，
/// 没有就生成默认代号并**立即落盘**（与 sync.json 首启落盘同纪律：不落盘
/// 的话两次读会得到两个不同的随机词）。
///
/// `app = None`（HTTP handler / 纯逻辑测试拿不到 AppHandle）：走进程内缓存，
/// 未命中则生成临时默认值并缓存（生产里 `ensure_default_alias` 已在启动时
/// 预热缓存，这条路径实际只服务测试）。
pub fn current_alias(app: Option<&tauri::AppHandle>) -> String {
    if let Ok(guard) = ALIAS_CACHE.lock() {
        if let Some(a) = guard.as_ref() {
            return a.clone();
        }
    }
    let Some(app) = app else {
        let a = gen_default_alias();
        if let Ok(mut g) = ALIAS_CACHE.lock() {
            *g = Some(a.clone());
        }
        return a;
    };
    let mut cfg = crate::vault::load_config(app);
    if cfg.device_alias.trim().is_empty() {
        cfg.device_alias = default_alias_for_platform();
        let _ = crate::vault::save_config(app, &cfg);
    }
    let alias = cfg.device_alias;
    if let Ok(mut g) = ALIAS_CACHE.lock() {
        *g = Some(alias.clone());
    }
    alias
}

/// 平台默认代号：桌面沿用 HOSTNAME 语义（授权卡片显示 nwj-PC 的既有体验），
/// 手机端给词表随机代号（LocalSend 体验）。
fn default_alias_for_platform() -> String {
    if cfg!(target_os = "android") {
        gen_default_alias()
    } else {
        desktop_default_alias()
    }
}

/// 设置代号（设置页改名 / 首启引导）：归一化后落盘 + 刷缓存。
/// 归一化失败（空串）不动现有值。
pub fn set_alias(app: &tauri::AppHandle, raw: &str) -> Result<String, String> {
    let alias = normalize_alias(raw).ok_or_else(|| "代号不能为空".to_string())?;
    let mut cfg = crate::vault::load_config(app);
    cfg.device_alias = alias.clone();
    crate::vault::save_config(app, &cfg).map_err(|e| format!("保存配置失败: {e}"))?;
    if let Ok(mut guard) = ALIAS_CACHE.lock() {
        *guard = Some(alias.clone());
    }
    Ok(alias)
}

/// 启动时预热：配置里还没有代号就落平台默认值，并灌进程内缓存。
/// 缓存预热是必须的——HTTP handler（/info、/pair-request 重名消解、/pair-status）
/// 拿不到 AppHandle，全靠这份缓存说代号。
pub fn ensure_default_alias(app: &tauri::AppHandle) {
    current_alias(Some(app));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_alias_is_from_lexicon() {
        for _ in 0..20 {
            let a = gen_default_alias();
            assert!(a.chars().count() == 4, "词表代号应为 4 字：{a}");
            assert!(ADJECTIVES.iter().any(|x| a.starts_with(*x)), "前缀须在形容词表：{a}");
            assert!(NOUNS.iter().any(|x| a.ends_with(*x)), "后缀须在名词表：{a}");
        }
    }

    #[test]
    fn default_alias_varies() {
        // 概率撞词极低（24×16=384 组合，连出 5 次同词 ~1e-12），连续 5 次相同即判实现坏了
        let a = gen_default_alias();
        let same = (0..5).filter(|_| gen_default_alias() == a).count();
        assert!(same < 5, "连出 5 次同词：{a}");
    }

    #[test]
    fn normalize_trims_and_limits_by_chars() {
        assert_eq!(normalize_alias("  青柠手机 "), Some("青柠手机".into()));
        let long = "字".repeat(30);
        let n = normalize_alias(&long).unwrap();
        assert_eq!(n.chars().count(), ALIAS_MAX_CHARS);
        assert_eq!(normalize_alias("   "), None);
        assert_eq!(normalize_alias(""), None);
    }

    #[test]
    fn desktop_default_prefers_hostname() {
        // 无法在测试里安全注入 env（并发测试会互踩），只验非空与长度约束
        let a = desktop_default_alias();
        assert!(!a.is_empty());
        assert!(a.chars().count() <= ALIAS_MAX_CHARS);
    }
}
