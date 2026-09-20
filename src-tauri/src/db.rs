//! SQLite 数据层：files 索引（含正文缓存，供搜索）、最近笔记、收藏。
//! 数据的唯一事实源是 vault 里的文件；DB 是可重建的索引/缓存。

use rusqlite::{params, Connection, OptionalExtension, Result};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS files (
    path     TEXT PRIMARY KEY,   -- vault 相对路径，'/' 分隔
    title    TEXT NOT NULL,
    body     TEXT NOT NULL DEFAULT '',
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    hash     TEXT NOT NULL DEFAULT '',
    is_note  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_isnote ON files(is_note);
CREATE TABLE IF NOT EXISTS recents (
    path      TEXT PRIMARY KEY,
    opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
    path     TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
);
"#;

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)
}

pub fn upsert_file(
    conn: &Connection,
    path: &str,
    title: &str,
    body: &str,
    mtime_ms: i64,
    hash: &str,
    is_note: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO files(path,title,body,mtime_ms,hash,is_note) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(path) DO UPDATE SET title=?2, body=?3, mtime_ms=?4, hash=?5, is_note=?6",
        params![path, title, body, mtime_ms, hash, is_note as i64],
    )?;
    Ok(())
}

/// 精确删除一条索引
pub fn remove_path(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM files WHERE path=?1", params![path])?;
    conn.execute("DELETE FROM recents WHERE path=?1", params![path])?;
    conn.execute("DELETE FROM favorites WHERE path=?1", params![path])?;
    Ok(())
}

/// 前缀删除（目录级操作）：自身 + 子树。不用 LIKE，避免路径里的 %/_ 干扰。
pub fn remove_prefix(conn: &Connection, prefix: &str) -> Result<()> {
    let with_slash = format!("{prefix}/");
    conn.execute(
        "DELETE FROM files WHERE path=?1 OR substr(path,1,?2)=?3",
        params![prefix, with_slash.chars().count() as i64, with_slash],
    )?;
    conn.execute(
        "DELETE FROM recents WHERE path=?1 OR substr(path,1,?2)=?3",
        params![prefix, with_slash.chars().count() as i64, with_slash],
    )?;
    conn.execute(
        "DELETE FROM favorites WHERE path=?1 OR substr(path,1,?2)=?3",
        params![prefix, with_slash.chars().count() as i64, with_slash],
    )?;
    Ok(())
}

/// 列出前缀（自身 + 子树）下的全部索引笔记路径。M3b tombstone 文件夹展开用。
/// 同 remove_prefix：substr 按字符计数，不用 LIKE。
pub fn list_prefix_paths(conn: &Connection, prefix: &str) -> Result<Vec<String>> {
    let with_slash = format!("{prefix}/");
    let chars = with_slash.chars().count() as i64;
    let mut stmt = conn.prepare(
        "SELECT path FROM files WHERE is_note=1 AND (path=?1 OR substr(path,1,?2)=?3)",
    )?;
    let out = stmt
        .query_map(params![prefix, chars, with_slash], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>>>()?;
    Ok(out)
}

/// 前缀重命名（重命名/移动目录时，自身 + 子树路径改写）。
/// 不用 LIKE，避免路径里的 %/_ 干扰；substr 按字符计数。
pub fn rename_paths(conn: &Connection, old_prefix: &str, new_prefix: &str) -> Result<()> {
    let old_slash = format!("{old_prefix}/");
    let old_chars = old_slash.chars().count() as i64;
    // 自身
    conn.execute(
        "UPDATE files SET path=?2 WHERE path=?1",
        params![old_prefix, new_prefix],
    )?;
    // 子树：old_slash 整体被 new_prefix 替换，需补回分隔斜杠
    conn.execute(
        "UPDATE files SET path = ?2 || '/' || substr(path, ?3 + 1)
         WHERE substr(path, 1, ?3) = ?1",
        params![old_slash, new_prefix, old_chars],
    )?;
    for table in ["recents", "favorites"] {
        conn.execute(
            &format!("UPDATE {table} SET path=?2 WHERE path=?1"),
            params![old_prefix, new_prefix],
        )?;
        conn.execute(
            &format!("UPDATE {table} SET path = ?2 || '/' || substr(path, ?3 + 1) WHERE substr(path, 1, ?3) = ?1"),
            params![old_slash, new_prefix, old_chars],
        )?;
    }
    Ok(())
}

#[allow(dead_code)] // M3 同步引擎将使用（按路径查索引）
pub fn get_file(
    conn: &Connection,
    path: &str,
) -> Result<Option<(String, String, i64, String)>> {
    conn.query_row(
        "SELECT title, body, mtime_ms, hash FROM files WHERE path=?1",
        params![path],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
}

// ---------- 最近 ----------

pub fn record_recent(conn: &Connection, path: &str, now_ms: i64, keep: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO recents(path, opened_at) VALUES(?1,?2)
         ON CONFLICT(path) DO UPDATE SET opened_at=?2",
        params![path, now_ms],
    )?;
    conn.execute(
        "DELETE FROM recents WHERE path IN (
            SELECT path FROM recents ORDER BY opened_at DESC LIMIT -1 OFFSET ?1)",
        params![keep],
    )?;
    Ok(())
}

pub fn list_recents(conn: &Connection, limit: i64) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT r.path, COALESCE(f.title, r.path) FROM recents r
         LEFT JOIN files f ON f.path = r.path
         ORDER BY r.opened_at DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------- 收藏 ----------

pub fn favorite_toggle(conn: &Connection, path: &str, now_ms: i64) -> Result<bool> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM favorites WHERE path=?1",
            params![path],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        conn.execute("DELETE FROM favorites WHERE path=?1", params![path])?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO favorites(path, added_at) VALUES(?1,?2)",
            params![path, now_ms],
        )?;
        Ok(true)
    }
}

pub fn list_favorites(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT v.path, COALESCE(f.title, v.path) FROM favorites v
         LEFT JOIN files f ON f.path = v.path
         ORDER BY v.added_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------- 搜索 ----------

fn escape_like(q: &str) -> String {
    q.chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            c => vec![c],
        })
        .collect()
}

pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

/// M1 用 LIKE 子串匹配（中文友好、零分词依赖）；数据量级到 1e4 后再上 FTS5 trigram。
pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let pat = format!("%{}%", escape_like(q));
    let mut stmt = conn.prepare(
        "SELECT path, title, body FROM files
         WHERE is_note=1 AND (title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\')
         ORDER BY (title LIKE ?1 ESCAPE '\\') DESC, mtime_ms DESC
         LIMIT ?2",
    )?;
    let mut hits = stmt
        .query_map(params![pat, limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(hits
        .drain(..)
        .map(|(path, title, body)| {
            let snippet = make_snippet(&body, q).unwrap_or_else(|| body.chars().take(60).collect());
            SearchHit { path, title, snippet }
        })
        .collect())
}

/// 取第一次命中的位置 ±40 字符
fn make_snippet(body: &str, q: &str) -> Option<String> {
    let lower_body = body.to_lowercase();
    let lower_q = q.to_lowercase();
    let byte_idx = lower_body.find(&lower_q)?;
    let chars: Vec<char> = body.chars().collect();
    // 字符位置在**小写化串**内计算（byte_idx 对 lower_body 合法），
    // 再映射回原串时 clamp：to_lowercase 可让单字符展开（İ→i̇），
    // 原串字符数可能略少——直接用小写字节位置切原串会落 char 边界外
    // 而 panic（发生在持 DB 锁期间，release panic=abort 直接杀进程）
    let char_idx = lower_body[..byte_idx].chars().count().min(chars.len());
    let start = char_idx.saturating_sub(40);
    let end = (char_idx + lower_q.chars().count() + 40).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s = format!("{s}…");
    }
    Some(s.replace('\n', " "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    #[test]
    fn upsert_and_get() {
        let c = mem();
        upsert_file(&c, "a.md", "a", "内容", 1, "h", true).unwrap();
        upsert_file(&c, "a.md", "a2", "内容2", 2, "h2", true).unwrap();
        let (title, body, mtime, hash) = get_file(&c, "a.md").unwrap().unwrap();
        assert_eq!((title.as_str(), body.as_str(), mtime, hash.as_str()), ("a2", "内容2", 2, "h2"));
    }

    #[test]
    fn chinese_search_with_snippet() {
        let c = mem();
        upsert_file(&c, "读书.md", "读书", "这是一段关于 Rust 异步编程 的记录", 1, "", true).unwrap();
        upsert_file(&c, "其他.md", "其他", "无关内容", 1, "", true).unwrap();
        let hits = search(&c, "异步编程", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "读书.md");
        assert!(hits[0].snippet.contains("异步编程"));
        // 标题命中排在正文命中前
        upsert_file(&c, "异步编程.md", "异步编程", "正文没有关键词", 2, "", true).unwrap();
        let hits = search(&c, "异步编程", 20).unwrap();
        assert_eq!(hits[0].path, "异步编程.md");
    }

    /// 回归：小写化单字符展开（İ→i̇，1→2 字符）使 lower 串位置超过原串
    /// 长度——旧实现用小写字节索引切原串，落 char 边界外/越界 → panic
    /// （发生在 with_db 持锁期间，release panic=abort 直接杀进程）
    #[test]
    fn snippet_survives_lowercase_expansion() {
        let s = make_snippet("İİ X", "X").unwrap();
        assert!(s.contains("X"));
        let s2 = make_snippet("前 İİİ 后文", "后文").unwrap();
        assert!(s2.contains("后文"));
        // 命中小写化展开形态本身
        let s3 = make_snippet("İİ X", "i̇").unwrap();
        assert!(!s3.is_empty());
        // 正常路径不变
        let s4 = make_snippet("hello world", "WORLD").unwrap();
        assert!(s4.contains("hello world"));
    }

    #[test]
    fn like_wildcards_escaped() {
        let c = mem();
        upsert_file(&c, "a.md", "a", "100% 完成", 1, "", true).unwrap();
        assert_eq!(search(&c, "100%", 10).unwrap().len(), 1);
        assert_eq!(search(&c, "1__", 10).unwrap().len(), 0);
    }

    #[test]
    fn recents_capped_and_ordered() {
        let c = mem();
        for i in 0..60 {
            record_recent(&c, &format!("{i}.md"), i, 50).unwrap();
        }
        let recent = list_recents(&c, 20).unwrap();
        assert_eq!(recent.len(), 20);
        assert_eq!(recent[0].0, "59.md"); // 最新在前
    }

    #[test]
    fn favorites_toggle() {
        let c = mem();
        assert!(favorite_toggle(&c, "a.md", 1).unwrap());
        assert!(!favorite_toggle(&c, "a.md", 2).unwrap());
        assert_eq!(list_favorites(&c).unwrap().len(), 0);
    }

    #[test]
    fn rename_and_remove_prefix() {
        let c = mem();
        upsert_file(&c, "目录/子/笔记.md", "t", "b", 1, "", true).unwrap();
        upsert_file(&c, "目录/顶.md", "t", "b", 1, "", true).unwrap();
        record_recent(&c, "目录/子/笔记.md", 1, 50).unwrap();
        rename_paths(&c, "目录", "新目录").unwrap();
        assert!(get_file(&c, "新目录/子/笔记.md").unwrap().is_some());
        assert!(get_file(&c, "新目录/顶.md").unwrap().is_some());
        assert!(get_file(&c, "目录/顶.md").unwrap().is_none());
        remove_prefix(&c, "新目录").unwrap();
        assert!(get_file(&c, "新目录/顶.md").unwrap().is_none());
        assert!(list_recents(&c, 10).unwrap().is_empty());
    }
}
