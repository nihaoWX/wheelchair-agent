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

/// A Node-style `error.code` string for an I/O error, or `None` for an unmapped errno.
///
/// The numbers are the Linux values; this binary is built for linux-x64.
pub fn errno_name(error: &std::io::Error) -> Option<&'static str> {
    match error.raw_os_error() {
        Some(1) => Some("EPERM"),
        Some(2) => Some("ENOENT"),
        Some(3) => Some("ESRCH"),
        Some(12) => Some("ENOMEM"),
        Some(13) => Some("EACCES"),
        Some(17) => Some("EEXIST"),
        Some(18) => Some("EXDEV"),
        Some(20) => Some("ENOTDIR"),
        Some(21) => Some("EISDIR"),
        Some(23) => Some("ENFILE"),
        Some(24) => Some("EMFILE"),
        Some(28) => Some("ENOSPC"),
        Some(30) => Some("EROFS"),
        _ => None,
    }
}

/// The Node-style text for one errno.
pub fn errno_description(code: &str) -> &'static str {
    match code {
        "EPERM" => "operation not permitted",
        "ENOENT" => "no such file or directory",
        "ESRCH" => "no such process",
        "ENOMEM" => "not enough memory",
        "EACCES" => "permission denied",
        "EEXIST" => "file already exists",
        "EXDEV" => "invalid cross-device link",
        "ENOTDIR" => "not a directory",
        "EISDIR" => "illegal operation on a directory",
        "ENFILE" => "too many open files in system",
        "EMFILE" => "too many open files",
        "ENOSPC" => "no space left on device",
        "EROFS" => "read-only file system",
        _ => "i/o error",
    }
}

/// The planner reports the code (`ENOENT`, `ENOTDIR`, ...) in the few messages that carry it.
pub fn error_code(error: &std::io::Error) -> String {
    errno_name(error)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

/// JavaScript's `String(value)` for the JSON values the queue/schema code passes around.
pub fn js_string(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                integer.to_string()
            } else if let Some(integer) = value.as_u64() {
                integer.to_string()
            } else {
                value
                    .as_f64()
                    .map(js_number)
                    .unwrap_or_else(|| "NaN".to_string())
            }
        }
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JavaScript's `Number(value)` for the JSON values `integer()` coerces.
pub fn js_to_number(value: &serde_json::Value) -> f64 {
    use serde_json::Value;
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => js_parse_number(value),
        Value::Array(_) => js_parse_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

fn js_parse_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix)
                .map(|value| value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    match trimmed {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => trimmed.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// A JSON number for an integer-valued `f64`, keeping integers as JSON integers.
pub fn json_number(value: f64) -> serde_json::Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value <= i64::MAX as f64
    {
        serde_json::Value::Number(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null)
    }
}

/// JavaScript number-to-string, including the values serde JSON cannot represent directly.
pub fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == f64::INFINITY {
        return "Infinity".to_string();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    let magnitude = value.abs();
    // ECMAScript switches to exponent notation outside [1e-6, 1e21).
    if magnitude >= 1e21 || magnitude < 1e-6 {
        let text = format!("{:e}", value);
        if let Some((mantissa, exponent)) = text.split_once('e') {
            let exponent: i32 = exponent.parse().unwrap_or(0);
            return if exponent >= 0 {
                format!("{}e+{}", mantissa, exponent)
            } else {
                format!("{}e{}", mantissa, exponent)
            };
        }
        return text;
    }
    if value.fract() == 0.0 && magnitude <= i64::MAX as f64 {
        format!("{}", value as i64)
    } else {
        format!("{}", value)
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
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.23e21), "1.23e+21");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(1e-6), "0.000001");
        assert_eq!(
            js_number(123_456_789_012_345_680_000.0),
            "123456789012345680000"
        );
        assert_eq!(js_number(-0.0), "0");
    }
}
