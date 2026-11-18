//! The file queue of the `spv` Source, moved out of `src/shared/queue.js`.
//!
//! The on-disk contract is unchanged: `pending/` holds task files, `done/` holds consumed and
//! quarantined ones, `outbox/` holds Channel messages and `outbox/read/` holds consumed messages.
//! The rename out of a queue directory is the consumed marker, so every move here is one atomic
//! `fs::rename` with the same destination name the JavaScript used.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::time::{SystemTime, UNIX_EPOCH};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util;

/// Directory name of the queue inside the Source's root, which defaults to `<stateDir>/spv`.
pub const QUEUE_NAME: &str = "spv";

/// The four directories of one queue root.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueDirs {
    pub root: String,
    pub pending: String,
    pub done: String,
    pub outbox: String,
    pub read: String,
}

/// One `queue-op` request.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum QueueRequest {
    Layout { root: String },
    EnsureDirs { dirs: QueueDirs },
    PendingNames { dirs: QueueDirs },
    ReadTask { file: String },
    ConsumeTask { file: String, dirs: QueueDirs },
    QuarantineTask { file: String, dirs: QueueDirs },
    WriteMessage { dirs: QueueDirs, message: Value },
}

/// A queue failure as an envelope code/message pair.
#[derive(Debug)]
pub struct QueueError {
    pub code: String,
    pub message: String,
}

impl QueueError {
    fn io(error: &std::io::Error, detail: &str) -> Self {
        let code = util::errno_name(error)
            .map(str::to_string)
            .unwrap_or_else(|| "EIO".to_string());
        let description = util::errno_description(&code);
        Self {
            message: format!("{}: {}, {}", code, description, detail),
            code,
        }
    }

    fn invalid_json(file: &str, error: &serde_json::Error) -> Self {
        Self {
            code: "invalid_json".to_string(),
            message: format!("{} is not valid JSON: {}", file, error),
        }
    }

    fn other(message: impl Into<String>) -> Self {
        Self {
            code: "queue_failed".to_string(),
            message: message.into(),
        }
    }
}

/// Build the layout; exposed separately so the wrapper can return the exact object shape.
pub fn layout(root: &str) -> QueueDirs {
    let outbox = util::join(root, "outbox");
    QueueDirs {
        root: root.to_string(),
        pending: util::join(root, "pending"),
        done: util::join(root, "done"),
        outbox,
        read: util::join(&util::join(root, "outbox"), "read"),
    }
}

/// Run one queue operation and return its envelope data.
pub fn run(request: &QueueRequest) -> Result<Value, QueueError> {
    match request {
        QueueRequest::Layout { root } => {
            serde_json::to_value(layout(root)).map_err(|error| QueueError::other(error.to_string()))
        }
        QueueRequest::EnsureDirs { dirs } => {
            for directory in [&dirs.root, &dirs.pending, &dirs.done, &dirs.outbox] {
                fs::create_dir_all(directory).map_err(|error| {
                    QueueError::io(&error, &format!("mkdir {}", quote(directory)))
                })?;
            }
            Ok(Value::Null)
        }
        QueueRequest::PendingNames { dirs } => {
            let names = pending_names(dirs)?;
            serde_json::to_value(names).map_err(|error| QueueError::other(error.to_string()))
        }
        QueueRequest::ReadTask { file } => read_task(file),
        QueueRequest::ConsumeTask { file, dirs } => {
            consume_task(file, dirs)?;
            Ok(Value::Null)
        }
        QueueRequest::QuarantineTask { file, dirs } => {
            quarantine_task(file, dirs)?;
            Ok(Value::Null)
        }
        QueueRequest::WriteMessage { dirs, message } => {
            write_message(dirs, message)?;
            Ok(Value::Null)
        }
    }
}

fn quote(path: &str) -> String {
    format!("'{}'", path)
}

fn mtime_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}

/// Names of the task files waiting in `pending/`, oldest first; a missing directory reads as empty.
pub fn pending_names(dirs: &QueueDirs) -> Result<Vec<String>, QueueError> {
    let entries = match fs::read_dir(&dirs.pending) {
        Ok(entries) => entries,
        Err(error) if util::errno_name(&error) == Some("ENOENT") => return Ok(Vec::new()),
        Err(error) => {
            return Err(QueueError::io(
                &error,
                &format!("scandir {}", quote(&dirs.pending)),
            ));
        }
    };
    let mut stamped: Vec<(String, f64)> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let mtime = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .map(mtime_ms)
            .unwrap_or(0.0);
        stamped.push((name, mtime));
    }
    // Task file names are generated hex ids, so byte order and the old `localeCompare` order agree.
    stamped.sort_by(|left, right| {
        left.1
            .partial_cmp(&right.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    Ok(stamped.into_iter().map(|(name, _)| name).collect())
}

/// Read and parse one task file.
pub fn read_task(file: &str) -> Result<Value, QueueError> {
    let bytes =
        fs::read(file).map_err(|error| QueueError::io(&error, &format!("open {}", quote(file))))?;
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str(&text).map_err(|error| QueueError::invalid_json(file, &error))
}

/// Move a consumed task into `done/`.
pub fn consume_task(file: &str, dirs: &QueueDirs) -> Result<(), QueueError> {
    let target = util::join(&dirs.done, &util::basename(file));
    fs::rename(file, &target).map_err(|error| {
        QueueError::io(
            &error,
            &format!("rename {} -> {}", quote(file), quote(&target)),
        )
    })
}

/// Move an unparsable file into `done/` with a `.bad` suffix, dropping it when a rename cannot
/// cross a filesystem boundary.
pub fn quarantine_task(file: &str, dirs: &QueueDirs) -> Result<(), QueueError> {
    let target = util::join(&dirs.done, &format!("{}.bad", util::basename(file)));
    match fs::rename(file, &target) {
        Ok(()) => Ok(()),
        Err(error) => match util::errno_name(&error) {
            // A rename across a full disk or a stale lock is not worth failing the round: drop the
            // file only if it is still there.
            Some("EXDEV") | Some("EPERM") => {
                let _ = fs::remove_file(file);
                Ok(())
            }
            _ => Err(QueueError::io(
                &error,
                &format!("rename {} -> {}", quote(file), quote(&target)),
            )),
        },
    }
}

/// Write one outbox message atomically, keyed by its id so a repeated send overwrites instead of
/// duplicating.
pub fn write_message(dirs: &QueueDirs, message: &Value) -> Result<(), QueueError> {
    fs::create_dir_all(&dirs.outbox)
        .map_err(|error| QueueError::io(&error, &format!("mkdir {}", quote(&dirs.outbox))))?;
    let id = message
        .get("id")
        .map(util::js_string)
        .unwrap_or_else(|| "undefined".to_string());
    let safe = safe_name(&id);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let temporary = util::join(
        &dirs.outbox,
        &format!(".tmp-{}-{}-{}", safe, std::process::id(), stamp),
    );
    let mut text = serde_json::to_string_pretty(message)
        .map_err(|error| QueueError::other(error.to_string()))?;
    text.push('\n');
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(&temporary)
        .map_err(|error| QueueError::io(&error, &format!("open {}", quote(&temporary))))?;
    file.write_all(text.as_bytes())
        .map_err(|error| QueueError::io(&error, &format!("write {}", quote(&temporary))))?;
    drop(file);
    let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644));
    let target = util::join(&dirs.outbox, &format!("{}.json", safe));
    fs::rename(&temporary, &target).map_err(|error| {
        QueueError::io(
            &error,
            &format!("rename {} -> {}", quote(&temporary), quote(&target)),
        )
    })
}

/// `String(message.id).replace(/[^A-Za-z0-9._-]/g, '_')`, including the UTF-16 code-unit behaviour.
fn safe_name(value: &str) -> String {
    let mut out = String::new();
    for unit in value.encode_utf16() {
        let character = char::from_u32(unit as u32).unwrap_or('_');
        if character.is_ascii_alphanumeric()
            || character == '.'
            || character == '_'
            || character == '-'
        {
            out.push(character);
        } else {
            out.push('_');
        }
    }
    out
}
