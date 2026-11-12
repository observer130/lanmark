//! 文件名规范化：
//! 中文原样保留；空格 → `-`；非法字符剔除；跨平台（Windows 保留名）防护。

/// Windows 保留设备名（不区分大小写，不含扩展名的 base 部分）
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const MAX_CHARS: usize = 100;

/// 对不含扩展名的名字做规范化。
/// 规则：空格 → `-`；`/ \ : * ? " < > |` 与控制字符 → 剔除；连续 `-` 合并；
/// 首尾的 `-` 和 `.` 去除；Windows 保留名加 `n-` 前缀；空结果回退「未命名」。
pub fn sanitize_filename(raw: &str) -> String {
    let mapped: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            ' ' | '\t' => '-',
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c => c,
        })
        .collect();

    let mut s = mapped;
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches(|c| c == '-' || c == '.' || c == ' ').to_string();

    let mut s = if is_windows_reserved(&s) {
        format!("n-{s}")
    } else {
        s
    };

    if s.chars().count() > MAX_CHARS {
        s = s.chars().take(MAX_CHARS).collect();
        s = s.trim_end_matches(['-', '.', ' ']).to_string();
    }
    if s.is_empty() {
        s = "未命名".to_string();
    }
    s
}

/// 对「文件名.扩展名」整体规范化：扩展名（最后一个 `.` 后）原样保留，只规范化 stem。
pub fn sanitize_filename_with_ext(raw: &str) -> String {
    match raw.rfind('.') {
        Some(idx) if idx > 0 && idx < raw.len() - 1 => {
            let (stem, ext) = raw.split_at(idx);
            format!("{}{}", sanitize_filename(stem), ext)
        }
        _ => sanitize_filename(raw),
    }
}

fn is_windows_reserved(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or("");
    WINDOWS_RESERVED.contains(&base.to_ascii_uppercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_chinese() {
        assert_eq!(sanitize_filename("我的读书笔记"), "我的读书笔记");
    }

    #[test]
    fn spaces_to_dash() {
        assert_eq!(sanitize_filename("hello world  test"), "hello-world-test");
        assert_eq!(sanitize_filename("a b_c"), "a-b_c"); // 下划线不转
    }

    #[test]
    fn illegal_chars_removed() {
        assert_eq!(sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(sanitize_filename("中文:标题"), "中文-标题");
    }

    #[test]
    fn trims_and_collapses() {
        assert_eq!(sanitize_filename("-  a  - "), "a");
        assert_eq!(sanitize_filename("a---b"), "a-b");
        assert_eq!(sanitize_filename("...a...."), "a");
    }

    #[test]
    fn control_chars_removed() {
        assert_eq!(sanitize_filename("a\u{0007}b"), "ab");
    }

    #[test]
    fn windows_reserved_prefixed() {
        assert_eq!(sanitize_filename("CON"), "n-CON");
        assert_eq!(sanitize_filename("com1"), "n-com1");
        assert_eq!(sanitize_filename("我的CON"), "我的CON"); // 非 base 相等不受影响
    }

    #[test]
    fn empty_fallback() {
        assert_eq!(sanitize_filename("///"), "未命名");
        assert_eq!(sanitize_filename("   "), "未命名");
    }

    #[test]
    fn length_capped() {
        let long = "长".repeat(150);
        let out = sanitize_filename(&long);
        assert_eq!(out.chars().count(), 100);
    }

    #[test]
    fn ext_preserved() {
        assert_eq!(sanitize_filename_with_ext("我的 笔记.md"), "我的-笔记.md");
        assert_eq!(sanitize_filename_with_ext("a?.md"), "a.md");
        assert_eq!(sanitize_filename_with_ext(".md"), "md"); // 纯隐藏文件极端情况
        assert_eq!(sanitize_filename_with_ext("no_ext"), "no_ext");
    }
}
