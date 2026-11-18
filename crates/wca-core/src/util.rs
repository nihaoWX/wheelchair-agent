//! Small path/string helpers shared by the planner modules.
//!
//! The JavaScript planner used `node:path` (`resolve`, `join`, `basename`) and a handful of
//! error-message helpers. These are the direct equivalents; keeping them here keeps the gate code
//! readable and makes the parity assumptions explicit.

use std::path::{Path, PathBuf};

/// `path.join(base, name)`, which is how the planner names a direct child of the work root.
///
/// `Path::join` keeps duplicate separators and `.`/`..` segments in the base, while Node's
/// `path.join` normalises them. The record's `path` is meant to be pasteable, so normalise lexically
/// here exactly like `resolve` does (but preserve relative paths instead of anchoring them at cwd).
pub fn join(base: &str, name: &str) -> String {
    let combined = if base.is_empty() {
        name.to_string()
    } else if base.ends_with('/') {
        format!("{}{}", base, name)
    } else {
        format!("{}/{}", base, name)
    };
    normalize(&combined)
}

/// Lexically normalise a path: collapse repeated separators and `.`/`..`, preserving whether it was
/// absolute and keeping leading `..` segments of a relative path.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|part| *part != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{}", joined)
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// `node:path.resolve`, but only lexically: no symlink resolution.
///
/// The planner only uses this to normalise a directory path before looking it up in the open-ticket
/// map, exactly like the JavaScript code did. Absolute paths stay absolute; relative ones resolve
/// against the current directory. `.` and `..` segments are collapsed.
pub fn resolve(path: &str) -> String {
    let joined: PathBuf = if path.starts_with('/') {
        PathBuf::from(path)
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => PathBuf::from(path),
        }
    };
    let text = joined.to_string_lossy();
    let mut parts: Vec<&str> = Vec::new();
    for segment in text.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `node:path.basename`.
pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The first non-empty, trimmed line of git output.
pub fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// A Node-style `error.code` string for an I/O error.
///
/// The planner reports the code (`ENOENT`, `ENOTDIR`, ...) in the few messages that carry it. The
/// numbers are the Linux values; this addon is built for linux-x64.
pub fn error_code(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(1) => "EPERM".to_string(),
        Some(2) => "ENOENT".to_string(),
        Some(3) => "ESRCH".to_string(),
        Some(13) => "EACCES".to_string(),
        Some(20) => "ENOTDIR".to_string(),
        _ => error.to_string(),
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{8,64}$`, which is what makes a directory name
/// ticket-shaped. Hand-written instead of pulling in a regex dependency.
pub fn is_ticket_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    let Some(separator) = name.rfind('-') else {
        return false;
    };
    let prefix = &name[..separator];
    let suffix = &name[separator + 1..];
    if prefix.is_empty() {
        return false;
    }
    if !prefix
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-')
    {
        return false;
    }
    (8..=64).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The JavaScript number-to-string used by the retention reason (`among the newest 2 ...`).
pub fn number(value: f64) -> String {
    if value.is_finite() && value == value.trunc() && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{}", value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_names_match_the_javascript_pattern() {
        assert!(is_ticket_name("alpha-0123456789ab"));
        assert!(is_ticket_name("agent-tool-dsh-install-0312cf6b4046"));
        assert!(is_ticket_name("a-00000000"));
        assert!(is_ticket_name(
            "a-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_ticket_name("state"));
        assert!(!is_ticket_name("-0123456789ab"));
        assert!(!is_ticket_name("alpha-0123456"));
        assert!(!is_ticket_name("alpha-0123456789AB"));
        assert!(!is_ticket_name("alpha-beta"));
        assert!(!is_ticket_name("alpha-0123456789ab\n"));
        assert!(!is_ticket_name("alpha/0123456789ab"));
    }

    #[test]
    fn join_normalizes_like_node_path_join() {
        assert_eq!(
            join("/tmp//wca-diff/root", "clean"),
            "/tmp/wca-diff/root/clean"
        );
        assert_eq!(join("/tmp/./x/../root", "clean"), "/tmp/root/clean");
        assert_eq!(join("a/../..", "b"), "../b");
        assert_eq!(join("", "b"), "b");
        assert_eq!(join("/", "b"), "/b");
    }

    #[test]
    fn resolve_is_lexical() {
        assert_eq!(resolve("/a/b/../c/./d"), "/a/c/d");
        assert_eq!(resolve("/"), "/");
        assert_eq!(resolve("/a//b"), "/a/b");
    }

    #[test]
    fn numbers_render_like_javascript() {
        assert_eq!(number(0.0), "0");
        assert_eq!(number(2.0), "2");
    }
}
