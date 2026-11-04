//! vault:// 自定义协议：把笔记里的相对路径（图片等）映射到当前 vault 目录下的真实文件。
//!
//! 编辑器文档树内 image src 用 vault://localhost/<vault相对路径>（显示用），
//! 序列化回 markdown 时由前端还原为相对引用——源文件零侵入。
//! 注册在 lib.rs 的 Builder 链上（tauri 2.x 协议 API 是 Builder 方法）。

use std::path::Path;
use std::sync::Arc;

use tauri::http::{header, Response, StatusCode};

use crate::vault::AppState;

/// 解析 vault 协议请求路径 → 文件内容（或 404）。同步纯逻辑，可单测。
pub fn resolve(state: &Arc<AppState>, raw_path: &str) -> Option<(String, Vec<u8>)> {
    let rel = percent_decode(raw_path.trim_start_matches('/'));
    log::debug!("vault 协议: 收到请求 raw={raw_path} rel={rel}");
    if rel.is_empty() {
        return None;
    }
    // 点目录禁止服务：.lanmark/lanmark.db 含全部正文缓存，
    // .lanmark/sync.json 含配对码与全部 token——webview 内任何 JS 可 fetch
    if crate::fs_ops::has_dot_segment(&rel) {
        return None;
    }
    let vault = state.vault.lock().ok()?.as_ref().cloned()?;
    // resolve_in_vault = safe_join + 符号链接逃逸校验（链接指向 vault 外 → 404）
    let abs = crate::fs_ops::resolve_in_vault(Path::new(&vault), &rel).ok()?;
    if !abs.is_file() {
        return None;
    }
    let bytes = std::fs::read(&abs).ok()?;
    let ct = content_type(abs.extension().and_then(|e| e.to_str()).unwrap_or(""));
    log::debug!("vault 协议: 提供 {rel} ({} bytes, {ct})", bytes.len());
    Some((ct.to_string(), bytes))
}

pub fn respond(file: Option<(String, Vec<u8>)>) -> Response<Vec<u8>> {
    match file {
        Some((ct, bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, ct)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(bytes)
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(b"not found".to_vec())
            .unwrap(),
    }
}

pub fn content_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "css" => "text/css",
        "js" => "text/javascript",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 极简 percent-decode（浏览器对 UTF-8 路径编码为 %XX）
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::open_vault_at;

    fn vault_with_files() -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/图.png"), b"png-bytes").unwrap();
        std::fs::write(dir.path().join("a.md"), b"# hi").unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        (dir, state)
    }

    #[test]
    fn resolve_serves_vault_files() {
        let (_dir, state) = vault_with_files();
        let (ct, bytes) = resolve(&state, "/assets/%E5%9B%BE.png").unwrap();
        assert_eq!(ct, "image/png");
        assert_eq!(bytes, b"png-bytes");
        let (ct2, _) = resolve(&state, "/a.md").unwrap();
        assert_eq!(ct2, "text/plain; charset=utf-8");
    }

    #[test]
    fn resolve_rejects_missing_and_escape() {
        let (_dir, state) = vault_with_files();
        assert!(resolve(&state, "/nope.png").is_none());
        assert!(resolve(&state, "/../outside").is_none());
        assert!(resolve(&state, "/").is_none());
        assert!(resolve(&state, "").is_none());
    }

    /// 回归：点目录（.lanmark/）禁止服务——索引库含全部正文缓存，
    /// sync.json 含配对码与全部 token
    #[test]
    fn resolve_rejects_dot_directories() {
        let (_dir, state) = vault_with_files();
        // open_vault_at 已创建 .lanmark/lanmark.db，确认文件存在再断言 404
        assert!(state.db.lock().unwrap().is_some());
        assert!(resolve(&state, "/.lanmark/lanmark.db").is_none());
        assert!(resolve(&state, "/.lanmark/sync.json").is_none());
        assert!(resolve(&state, "/.obsidian/x").is_none());
    }

    #[test]
    fn resolve_404_without_open_vault() {
        let state = Arc::new(AppState::default());
        assert!(resolve(&state, "/a.md").is_none());
    }

    /// 回归：符号链接指向 vault 外时 vault:// 不得服务外部文件
    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        let (dir, state) = vault_with_files();
        let outside = dir.path().parent().unwrap().join(format!("outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.png"), b"outside-bytes").unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("linkdir")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.png"), dir.path().join("link.png")).unwrap();
        let res = resolve(&state, "/linkdir/secret.png");
        let res2 = resolve(&state, "/link.png");
        assert!(res.is_none(), "目录链接逃逸必须 404: {res:?}");
        assert!(res2.is_none(), "文件链接逃逸必须 404: {res2:?}");
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn percent_decodes_utf8() {
        assert_eq!(percent_decode("assets/%E8%AF%BB%E4%B9%A6.png"), "assets/读书.png");
        assert_eq!(percent_decode("a%20b/c"), "a b/c");
        assert_eq!(percent_decode("no-encoding"), "no-encoding");
        assert_eq!(percent_decode("bad-%4"), "bad-%4"); // 非法序列原样保留
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("png"), "image/png");
        assert_eq!(content_type("PNG"), "image/png");
        assert_eq!(content_type("svg"), "image/svg+xml");
        assert_eq!(content_type("md"), "text/plain; charset=utf-8");
        assert_eq!(content_type("xyz"), "application/octet-stream");
    }
}
