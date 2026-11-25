//! The data plane of the hook engine: event payloads and ids, timeout/cwd/env derivation, the append
//! only record and the dedup cursor.
//!
//! Script execution deliberately stays in `src/shared/hooks.js` and `src/spv/hook-runner.js`: spawning
//! `sh`, streaming output and the SIGTERM/SIGKILL grace period are process-control concerns, not data
//! transformations. Everything here is a pure value transformation or an atomic file operation.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::time;
use crate::util::{join, js_string, js_to_number};

const HOOKS_RECORD_FILE: &str = "hooks.jsonl";
const EVENTS_CURSOR_FILE: &str = "events-cursor.json";
const CURSOR_VERSION: u64 = 1;
const HOOK_TIMEOUT_DEFAULT: f64 = 10_000.0;
const HOOK_TIMEOUT_CAP: f64 = 300_000.0;
const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The hook subcommand request. Field names stay camelCase because `src/shared/hooks.js` is the
/// caller; the `op` values are kebab-case like the other core subcommands.
#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum HooksRequest {
    /// Clone an event's documented sample and apply the `now` / `workspace` overrides.
    Payload {
        event: Value,
        #[serde(default)]
        sample: Option<Value>,
        #[serde(default)]
        known_events: Vec<String>,
        #[serde(default)]
        now: Option<Value>,
        #[serde(default)]
        workspace: Option<Value>,
    },
    /// Derive the stable occurrence id, or reject an unknown event.
    #[serde(rename = "eventId")]
    EventId {
        event: Value,
        #[serde(default = "empty_object")]
        payload: Value,
        #[serde(default)]
        known: bool,
        #[serde(default)]
        known_events: Vec<String>,
        #[serde(default)]
        require: bool,
    },
    /// `item.timeoutMs` -> `hooks.scriptTimeoutMs` -> 10000, capped at 300000.
    Timeout {
        #[serde(default = "empty_object")]
        item: Value,
        #[serde(default = "empty_object")]
        hooks: Value,
    },
    /// The cwd a hook for this event runs in.
    Cwd {
        event: Value,
        #[serde(default = "empty_object")]
        payload: Value,
        #[serde(default = "empty_object")]
        opts: Value,
    },
    /// The whitelisted, credential-filtered environment plus the `WCA_*` facts.
    Env {
        event: Value,
        #[serde(default)]
        event_id: Option<Value>,
        #[serde(default = "empty_object")]
        payload: Value,
        #[serde(default)]
        opts_env: Option<Value>,
        #[serde(default = "empty_object")]
        fallback_env: Value,
        #[serde(default)]
        home: Option<Value>,
        #[serde(default)]
        cwd: Option<Value>,
        #[serde(default)]
        now: Option<Value>,
    },
    /// Append one JSON line to `<root>/records/hooks.jsonl`.
    Record {
        root: Option<String>,
        #[serde(default)]
        path_only: bool,
        #[serde(default = "empty_object")]
        record: Value,
    },
    /// Read the JSON-lines record, skipping corrupt lines.
    Records {
        root: Option<String>,
        #[serde(default)]
        tail: Option<Value>,
    },
    /// Read `<root>/records/events-cursor.json`, or just name it.
    CursorRead {
        root: Option<String>,
        #[serde(default)]
        path_only: bool,
    },
    /// Atomically write the cursor.
    CursorWrite {
        root: Option<String>,
        cursor: Value,
        #[serde(default)]
        now: Option<String>,
    },
    /// Truncate queue bodies at a Unicode code-point limit.
    Texts { texts: Vec<String>, limit: usize },
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Debug, Clone)]
pub struct HooksError {
    pub code: String,
    pub message: String,
}

fn invalid(message: impl Into<String>) -> HooksError {
    HooksError {
        code: "HOOKS_INVALID".to_string(),
        message: message.into(),
    }
}

fn unknown_event(event: &Value, known: &[String]) -> HooksError {
    HooksError {
        code: "UNKNOWN_EVENT".to_string(),
        message: format!(
            "unknown hook event {}; known ids are {}.",
            json_string(event),
            known.join(", ")
        ),
    }
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// JavaScript's `String(value ?? '').trim() || undefined`.
fn non_empty(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let text = js_string(value).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn field<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    object.get(name)
}

fn field_non_empty(object: &Map<String, Value>, name: &str) -> Option<String> {
    field(object, name).and_then(non_empty)
}

fn object_of(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

pub fn run(request: &HooksRequest) -> Result<Value, HooksError> {
    match request {
        HooksRequest::Payload {
            event,
            sample,
            known_events,
            now,
            workspace,
        } => payload(
            event,
            sample.as_ref(),
            known_events,
            now.as_ref(),
            workspace.as_ref(),
        ),
        HooksRequest::EventId {
            event,
            payload,
            known,
            known_events,
            require,
        } => event_id(event, payload, *known, known_events, *require),
        HooksRequest::Timeout { item, hooks } => timeout(item, hooks),
        HooksRequest::Cwd {
            event,
            payload,
            opts,
        } => cwd(event, payload, opts),
        HooksRequest::Env {
            event,
            event_id,
            payload,
            opts_env,
            fallback_env,
            home,
            cwd,
            now,
        } => env(
            event,
            event_id.as_ref(),
            payload,
            opts_env.as_ref(),
            fallback_env,
            home.as_ref(),
            cwd.as_ref(),
            now.as_ref(),
        ),
        HooksRequest::Record {
            root,
            path_only,
            record,
        } => append_record(root.as_deref(), *path_only, record),
        HooksRequest::Records { root, tail } => records(root.as_deref(), tail.as_ref()),
        HooksRequest::CursorRead { root, path_only } => cursor_read(root.as_deref(), *path_only),
        HooksRequest::CursorWrite { root, cursor, now } => {
            cursor_write(root.as_deref(), cursor, now.as_deref())
        }
        HooksRequest::Texts { texts, limit } => Ok(texts_result(texts, *limit)),
    }
}

fn texts_result(texts: &[String], limit: usize) -> Value {
    let items: Vec<Value> = texts
        .iter()
        .map(|text| {
            let mut chars = text.chars();
            let kept: String = chars.by_ref().take(limit).collect();
            let truncated = chars.next().is_some();
            json!({ "text": kept, "truncated": truncated })
        })
        .collect();
    json!({ "items": items })
}

fn payload(
    event: &Value,
    sample: Option<&Value>,
    known_events: &[String],
    now: Option<&Value>,
    workspace: Option<&Value>,
) -> Result<Value, HooksError> {
    let event_text = js_string(event);
    if !known_events.iter().any(|known| known == &event_text) {
        return Err(unknown_event(event, known_events));
    }
    let mut value = match sample {
        Some(sample) if !sample.is_null() => sample.clone(),
        _ => json!({}),
    };
    if let Some(now) = now {
        if let Some(object) = value.as_object_mut() {
            object.insert("at".to_string(), now.clone());
        }
    }
    if event_text == "ticket.started" {
        if let (Some(workspace), Some(object)) = (workspace, value.as_object_mut()) {
            object.insert("workspace".to_string(), workspace.clone());
        }
    }
    Ok(json!({ "payload": value }))
}

fn event_id(
    event: &Value,
    payload: &Value,
    known: bool,
    known_events: &[String],
    require: bool,
) -> Result<Value, HooksError> {
    let event_text = js_string(event);
    if require && !known {
        return Err(unknown_event(event, known_events));
    }
    let object = object_of(payload);
    let explicit = object.and_then(|object| field_non_empty(object, "eventId"));
    if let Some(explicit) = explicit {
        return Ok(json!({ "eventId": explicit }));
    }
    if !known {
        let id = object.and_then(|object| field_non_empty(object, "id"));
        return Ok(json!({ "eventId": id }));
    }
    let id = match event_text.as_str() {
        "ticket.acknowledged" | "ticket.delivered" | "ticket.attention" => {
            object.and_then(|object| field_non_empty(object, "messageId"))
        }
        "inbox.approved" | "inbox.issue" => {
            let prefix = event_text.as_str();
            let item = object.and_then(|object| field_non_empty(object, "itemId"));
            if let Some(item) = item {
                let review = object.and_then(|object| field(object, "reviewIndex"));
                let index = match review {
                    Some(value) => js_string(value),
                    None => "latest".to_string(),
                };
                Some(format!("{}:{}:{}", prefix, item, index))
            } else {
                object
                    .and_then(|object| field_non_empty(object, "messageId"))
                    .map(|message| format!("{}:{}", prefix, message))
            }
        }
        "inbox.merged" => object
            .and_then(|object| field_non_empty(object, "itemId"))
            .map(|item| {
                let anchor = object
                    .and_then(|object| {
                        field_non_empty(object, "mergeCommit")
                            .or_else(|| field_non_empty(object, "pulledSha"))
                            .or_else(|| field_non_empty(object, "at"))
                    })
                    .unwrap_or_default();
                if anchor.is_empty() {
                    format!("merge:{}", item)
                } else {
                    format!("merge:{}:{}", item, anchor)
                }
            }),
        "ticket.started" => {
            let ticket = object.and_then(|object| field_non_empty(object, "ticketId"));
            let at = object.and_then(|object| field_non_empty(object, "at"));
            match (ticket, at) {
                (Some(ticket), Some(at)) => Some(format!("{}:{}", ticket, at)),
                _ => None,
            }
        }
        "spv.dispatch" => object
            .and_then(|object| field_non_empty(object, "taskId"))
            .map(|task| format!("dispatch:{}", task)),
        _ => None,
    };
    Ok(json!({ "eventId": id }))
}

fn timeout(item: &Value, hooks: &Value) -> Result<Value, HooksError> {
    let item = object_of(item);
    let hooks = object_of(hooks);
    let candidates = [
        item.and_then(|item| field(item, "timeoutMs")),
        hooks.and_then(|hooks| field(hooks, "scriptTimeoutMs")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_null() {
            continue;
        }
        let value = js_to_number(candidate);
        if !value.is_finite() || value.fract() != 0.0 || value < 1.0 {
            continue;
        }
        return Ok(json!({ "timeoutMs": value.min(HOOK_TIMEOUT_CAP) as i64 }));
    }
    Ok(json!({ "timeoutMs": HOOK_TIMEOUT_DEFAULT as i64 }))
}

fn current_dir() -> String {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

fn cwd(event: &Value, payload: &Value, opts: &Value) -> Result<Value, HooksError> {
    let opts = object_of(opts);
    let base = opts
        .and_then(|opts| field_non_empty(opts, "cwd"))
        .unwrap_or_else(current_dir);
    let event_text = js_string(event);
    if !event_text.starts_with("ticket.") {
        return Ok(json!({ "cwd": base }));
    }
    let workspace = opts
        .and_then(|opts| field_non_empty(opts, "workspace"))
        .or_else(|| object_of(payload).and_then(|payload| field_non_empty(payload, "workspace")));
    Ok(json!({ "cwd": workspace.unwrap_or(base) }))
}

fn env_source<'a>(
    opts_env: Option<&'a Value>,
    fallback_env: &'a Value,
) -> Option<&'a Map<String, Value>> {
    match opts_env {
        Some(value) if is_plain_object(value) => value.as_object(),
        _ => fallback_env.as_object(),
    }
}

fn is_credential(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("GH_")
        || upper.starts_with("GITHUB_")
        || upper.starts_with("DSH_")
        || ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "KEY"]
            .iter()
            .any(|word| upper.contains(word))
}

fn is_allowed_env(name: &str) -> bool {
    matches!(
        name,
        "PATH" | "HOME" | "USER" | "LOGNAME" | "SHELL" | "LANG" | "TZ" | "TERM" | "TMPDIR"
    ) || (name.starts_with("LC_")
        && name.len() > 3
        && name[3..].chars().all(|ch| ch.is_ascii_uppercase()))
}

fn set_env(env: &mut Map<String, Value>, name: &str, value: Value) {
    if let Some(existing) = env.get_mut(name) {
        *existing = value;
    } else {
        env.insert(name.to_string(), value);
    }
}

#[allow(clippy::too_many_arguments)]
fn env(
    event: &Value,
    event_id: Option<&Value>,
    payload: &Value,
    opts_env: Option<&Value>,
    fallback_env: &Value,
    home: Option<&Value>,
    cwd: Option<&Value>,
    now: Option<&Value>,
) -> Result<Value, HooksError> {
    let source = env_source(opts_env, fallback_env);
    let mut env = Map::new();
    if let Some(source) = source {
        for (name, value) in source {
            if value.is_null() {
                continue;
            }
            if !is_allowed_env(name) || is_credential(name) {
                continue;
            }
            env.insert(name.clone(), Value::String(js_string(value)));
        }
    }
    set_env(&mut env, "WCA_EVENT", Value::String(js_string(event)));
    let event_at = object_of(payload)
        .and_then(|payload| {
            field_non_empty(payload, "at").or_else(|| field_non_empty(payload, "eventAt"))
        })
        .unwrap_or_else(|| now_iso(now));
    set_env(&mut env, "WCA_EVENT_AT", Value::String(event_at));
    if let Some(event_id) = event_id {
        if !event_id.is_null() && !js_string(event_id).is_empty() {
            set_env(&mut env, "WCA_EVENT_ID", Value::String(js_string(event_id)));
        }
    }
    if let Some(home) = home {
        set_env(&mut env, "WCA_HOME", Value::String(js_string(home)));
    }
    if let Some(ticket) =
        object_of(payload).and_then(|payload| field_non_empty(payload, "ticketId"))
    {
        set_env(&mut env, "WCA_TICKET", Value::String(ticket));
    }
    if let Some(cwd) = cwd {
        set_env(&mut env, "WCA_CWD", Value::String(js_string(cwd)));
    }
    Ok(json!({ "env": env }))
}

fn now_iso(now: Option<&Value>) -> String {
    match now {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(value) if !value.is_null() => js_string(value),
        _ => time::iso(time::now_ms()),
    }
}

fn records_dir(root: &str) -> String {
    join(root, "records")
}

fn record_path(root: &str) -> String {
    join(&records_dir(root), HOOKS_RECORD_FILE)
}

fn cursor_path(root: &str) -> String {
    join(&records_dir(root), EVENTS_CURSOR_FILE)
}

fn required_root(root: Option<&str>) -> Result<&str, HooksError> {
    root.filter(|root| !root.is_empty())
        .ok_or_else(|| invalid("the data root could not be resolved"))
}

fn append_record(root: Option<&str>, path_only: bool, record: &Value) -> Result<Value, HooksError> {
    let root = required_root(root)?;
    let path = record_path(root);
    if path_only {
        return Ok(json!({ "path": path, "written": false }));
    }
    let line = format!(
        "{}\n",
        serde_json::to_string(record)
            .map_err(|error| { invalid(format!("cannot serialize the hook record: {}", error)) })?
    );
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|error| {
            invalid(format!(
                "cannot create the hook record directory: {}",
                error
            ))
        })?;
    }
    let existed = Path::new(&path).exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o644)
        .open(&path)
        .map_err(|error| invalid(format!("{}", error)))?;
    file.write_all(line.as_bytes())
        .map_err(|error| invalid(format!("{}", error)))?;
    if !existed {
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o644));
    }
    Ok(json!({ "path": path, "written": true }))
}

fn records(root: Option<&str>, tail: Option<&Value>) -> Result<Value, HooksError> {
    let root = required_root(root)?;
    let path = record_path(root);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "records": [] }));
        }
        Err(error) => {
            return Ok(json!({
                "records": [],
                "warning": format!("cannot read the hook record {}: {}", path, error),
            }));
        }
    };
    let mut values = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if is_plain_object(&value) {
                values.push(value);
            }
        }
    }
    let tail = tail.map(js_to_number).filter(|tail| *tail > 0.0);
    if let Some(tail) = tail {
        let keep = tail.trunc() as usize;
        if keep < values.len() {
            values = values.split_off(values.len() - keep);
        }
    }
    Ok(json!({ "records": values }))
}

fn cursor_payload(updated_at: Option<String>, ids: Map<String, Value>) -> Value {
    let mut payload = Map::new();
    payload.insert("version".to_string(), json!(CURSOR_VERSION));
    if let Some(updated_at) = updated_at {
        payload.insert("updatedAt".to_string(), Value::String(updated_at));
    }
    payload.insert("ids".to_string(), Value::Object(ids));
    Value::Object(payload)
}

fn empty_cursor() -> Value {
    cursor_payload(None, Map::new())
}

fn cursor_read(root: Option<&str>, path_only: bool) -> Result<Value, HooksError> {
    let root = required_root(root)?;
    let path = cursor_path(root);
    if path_only {
        return Ok(json!({ "path": path, "cursor": empty_cursor() }));
    }
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "cursor": empty_cursor() }));
        }
        Err(error) => {
            return Ok(json!({
                "cursor": empty_cursor(),
                "warning": format!("cannot read the hook cursor {}: {}; replaying.", path, error),
            }));
        }
    };
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(json!({
                "cursor": empty_cursor(),
                "warning": format!(
                    "the hook cursor {} is not valid JSON ({}); replaying.",
                    path, error
                ),
            }));
        }
    };
    let object = match parsed.as_object() {
        Some(object)
            if object.get("version").and_then(Value::as_f64) == Some(CURSOR_VERSION as f64)
                && object.get("ids").is_some_and(Value::is_object) =>
        {
            object
        }
        _ => {
            return Ok(json!({
                "cursor": empty_cursor(),
                "warning": format!("the hook cursor {} has an unsupported shape; replaying.", path),
            }));
        }
    };
    let mut ids = Map::new();
    if let Some(stored) = object.get("ids").and_then(Value::as_object) {
        for (id, at) in stored {
            let value = if at.is_string() {
                at.clone()
            } else {
                Value::String(EPOCH_ISO.to_string())
            };
            ids.insert(id.clone(), value);
        }
    }
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(json!({ "cursor": cursor_payload(updated_at, ids) }))
}

fn cursor_write(
    root: Option<&str>,
    cursor: &Value,
    now: Option<&str>,
) -> Result<Value, HooksError> {
    let root = required_root(root)?;
    let path = cursor_path(root);
    let object = cursor
        .as_object()
        .ok_or_else(|| invalid("the hook cursor must be an object"))?;
    let mut ids = Map::new();
    if let Some(stored) = object.get("ids") {
        let stored = stored
            .as_object()
            .ok_or_else(|| invalid("the hook cursor ids must be an object"))?;
        for (id, at) in stored {
            ids.insert(id.clone(), at.clone());
        }
    }
    let updated_at = now
        .map(str::to_string)
        .unwrap_or_else(|| time::iso(time::now_ms()));
    let payload = cursor_payload(Some(updated_at), ids);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&payload)
            .map_err(|error| invalid(format!("cannot serialize the hook cursor: {}", error)))?
    );
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|error| {
            invalid(format!(
                "cannot create the hook cursor directory: {}",
                error
            ))
        })?;
    }
    let temporary = format!(
        "{}.tmp-{}-{}-{}",
        path,
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        time::now_ms().trunc() as i64
    );
    let result = (|| -> Result<(), HooksError> {
        fs::write(&temporary, text.as_bytes()).map_err(|error| invalid(format!("{}", error)))?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644))
            .map_err(|error| invalid(format!("{}", error)))?;
        fs::rename(&temporary, &path).map_err(|error| invalid(format!("{}", error)))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(json!({ "cursor": payload }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> Vec<String> {
        vec![
            "ticket.started".to_string(),
            "ticket.acknowledged".to_string(),
            "ticket.delivered".to_string(),
            "ticket.attention".to_string(),
            "inbox.approved".to_string(),
            "inbox.issue".to_string(),
            "inbox.merged".to_string(),
            "spv.dispatch".to_string(),
            "cron.spv_cron".to_string(),
        ]
    }

    fn req(value: Value) -> HooksRequest {
        serde_json::from_value(value).expect("valid hooks request")
    }

    #[test]
    fn payload_clones_the_sample_and_applies_overrides() {
        let request = req(json!({
            "op": "payload",
            "event": "ticket.started",
            "sample": { "ticketId": "t1", "workspace": "/old", "at": "2000-01-01T00:00:00.000Z" },
            "knownEvents": known(),
            "now": "2026-01-02T03:04:05.000Z",
            "workspace": "/new",
        }));
        let data = run(&request).expect("payload");
        assert_eq!(data["payload"]["ticketId"], "t1");
        assert_eq!(data["payload"]["at"], "2026-01-02T03:04:05.000Z");
        assert_eq!(data["payload"]["workspace"], "/new");

        let request = req(json!({
            "op": "payload",
            "event": "inbox.merged",
            "sample": { "itemId": "x" },
            "knownEvents": known(),
            "workspace": "/ignored",
        }));
        let data = run(&request).expect("payload");
        assert!(data["payload"].get("workspace").is_none());
        assert!(data["payload"].get("at").is_none());
    }

    #[test]
    fn payload_rejects_unknown_events() {
        let request = req(json!({
            "op": "payload",
            "event": "nope",
            "knownEvents": known(),
        }));
        let error = run(&request).expect_err("unknown event");
        assert_eq!(error.code, "UNKNOWN_EVENT");
        assert_eq!(
            error.message,
            "unknown hook event \"nope\"; known ids are ticket.started, ticket.acknowledged, ticket.delivered, ticket.attention, inbox.approved, inbox.issue, inbox.merged, spv.dispatch, cron.spv_cron."
        );
    }

    #[test]
    fn event_ids_cover_all_derivation_rules() {
        let cases = [
            (
                "ticket.acknowledged",
                json!({ "messageId": "m1" }),
                Some("m1"),
            ),
            (
                "inbox.approved",
                json!({ "itemId": "i1", "reviewIndex": 3 }),
                Some("inbox.approved:i1:3"),
            ),
            (
                "inbox.issue",
                json!({ "itemId": "i1" }),
                Some("inbox.issue:i1:latest"),
            ),
            (
                "inbox.issue",
                json!({ "messageId": "m2" }),
                Some("inbox.issue:m2"),
            ),
            (
                "inbox.merged",
                json!({ "itemId": "i1", "mergeCommit": "abc" }),
                Some("merge:i1:abc"),
            ),
            ("inbox.merged", json!({ "itemId": "i1" }), Some("merge:i1")),
            (
                "ticket.started",
                json!({ "ticketId": "t1", "at": "2026-01-01T00:00:00.000Z" }),
                Some("t1:2026-01-01T00:00:00.000Z"),
            ),
            ("ticket.started", json!({ "ticketId": "t1" }), None),
            (
                "spv.dispatch",
                json!({ "taskId": "job" }),
                Some("dispatch:job"),
            ),
            ("cron.spv_cron", json!({ "minutes": 5 }), None),
            ("unknown.event", json!({ "id": "raw" }), Some("raw")),
        ];
        for (event, payload, expected) in cases {
            let request = req(json!({
                "op": "eventId",
                "event": event,
                "payload": payload,
                "known": event != "unknown.event",
                "knownEvents": known(),
            }));
            let data = run(&request).expect("event id");
            assert_eq!(data["eventId"].as_str(), expected, "event {}", event);
        }
        let request = req(json!({
            "op": "eventId",
            "event": "inbox.merged",
            "payload": { "eventId": " explicit ", "itemId": "ignored" },
            "known": true,
        }));
        assert_eq!(run(&request).expect("explicit")["eventId"], "explicit");
    }

    #[test]
    fn timeout_prefers_the_row_then_the_script_setting_and_caps() {
        let request = req(json!({
            "op": "timeout",
            "item": { "timeoutMs": 50 },
            "hooks": { "scriptTimeoutMs": 200 },
        }));
        assert_eq!(run(&request).expect("row")["timeoutMs"], 50);

        let request = req(json!({
            "op": "timeout",
            "item": { "timeoutMs": 0 },
            "hooks": { "scriptTimeoutMs": "250" },
        }));
        assert_eq!(run(&request).expect("string")["timeoutMs"], 250);

        let request = req(json!({
            "op": "timeout",
            "item": {},
            "hooks": { "scriptTimeoutMs": 999999 },
        }));
        assert_eq!(run(&request).expect("cap")["timeoutMs"], 300000);

        let request = req(json!({
            "op": "timeout",
            "item": { "timeoutMs": 12.5 },
            "hooks": { "scriptTimeoutMs": "nope" },
        }));
        assert_eq!(run(&request).expect("default")["timeoutMs"], 10000);
    }

    #[test]
    fn cwd_prefers_the_ticket_workspace_and_the_option_cwd() {
        let request = req(json!({
            "op": "cwd",
            "event": "inbox.approved",
            "payload": { "workspace": "/payload" },
            "opts": { "cwd": "/base", "workspace": "/options" },
        }));
        assert_eq!(run(&request).expect("non-ticket")["cwd"], "/base");

        let request = req(json!({
            "op": "cwd",
            "event": "ticket.started",
            "payload": { "workspace": "/payload" },
            "opts": { "cwd": "/base" },
        }));
        assert_eq!(run(&request).expect("payload")["cwd"], "/payload");

        let request = req(json!({
            "op": "cwd",
            "event": "ticket.started",
            "payload": {},
            "opts": { "cwd": "/base", "workspace": "/options" },
        }));
        assert_eq!(run(&request).expect("options")["cwd"], "/options");
    }

    #[test]
    fn env_filters_credentials_keeps_order_and_adds_facts() {
        let request = req(json!({
            "op": "env",
            "event": "ticket.started",
            "eventId": "t1:at",
            "payload": { "at": "2026-01-01T00:00:00.000Z", "ticketId": "t1" },
            "optsEnv": {
                "PATH": "/bin",
                "WCA_EVENT": "old",
                "GITHUB_TOKEN": "no",
                "MY_SECRET": "no",
                "LC_ALL": "C",
                "HOME": "/home",
                "EMPTY": null,
                "COUNT": 3,
            },
            "fallbackEnv": {},
            "home": "/data",
            "cwd": "/work",
        }));
        let data = run(&request).expect("env");
        let env = data["env"].as_object().expect("env object");
        let names: Vec<&String> = env.keys().collect();
        assert_eq!(
            names,
            vec![
                "PATH",
                "LC_ALL",
                "HOME",
                "WCA_EVENT",
                "WCA_EVENT_AT",
                "WCA_EVENT_ID",
                "WCA_HOME",
                "WCA_TICKET",
                "WCA_CWD"
            ]
        );
        assert_eq!(env["WCA_EVENT"], "ticket.started");
        assert_eq!(env["WCA_EVENT_AT"], "2026-01-01T00:00:00.000Z");
        assert_eq!(env["WCA_EVENT_ID"], "t1:at");
        assert_eq!(env["WCA_HOME"], "/data");
        assert_eq!(env["WCA_TICKET"], "t1");
        assert_eq!(env["WCA_CWD"], "/work");
        assert!(!env.contains_key("GITHUB_TOKEN"));
        assert!(!env.contains_key("MY_SECRET"));
    }

    #[test]
    fn env_accepts_a_fixed_now_for_reproducible_tests() {
        let request = req(json!({
            "op": "env",
            "event": "inbox.approved",
            "payload": {},
            "optsEnv": {},
            "fallbackEnv": {},
            "now": "2026-02-03T04:05:06.000Z",
        }));
        let data = run(&request).expect("env");
        assert_eq!(data["env"]["WCA_EVENT_AT"], "2026-02-03T04:05:06.000Z");
    }

    #[test]
    fn cursor_round_trips_without_temporary_files() {
        let root = std::env::temp_dir().join(format!(
            "wca-hooks-test-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let root_text = root.to_string_lossy().into_owned();
        let request = req(json!({
            "op": "cursor-write",
            "root": root_text,
            "cursor": { "ids": { "a": "2026-01-01T00:00:00.000Z", "b": 2 } },
            "now": "2026-01-02T00:00:00.000Z",
        }));
        let written = run(&request).expect("write cursor");
        assert_eq!(written["cursor"]["version"], 1);
        assert_eq!(written["cursor"]["updatedAt"], "2026-01-02T00:00:00.000Z");

        let request = req(json!({ "op": "cursor-read", "root": root_text }));
        let read = run(&request).expect("read cursor");
        assert_eq!(read["cursor"]["ids"]["a"], "2026-01-01T00:00:00.000Z");
        assert_eq!(read["cursor"]["ids"]["b"], EPOCH_ISO);
        let entries: Vec<_> = fs::read_dir(root.join("records"))
            .expect("records dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0], EVENTS_CURSOR_FILE);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn texts_truncate_by_code_point_without_splitting_pairs() {
        let request = req(json!({
            "op": "texts",
            "texts": ["ab😀cd", "ab😀cd"],
            "limit": 3,
        }));
        let data = run(&request).expect("texts");
        assert_eq!(data["items"][0]["text"], "ab😀");
        assert_eq!(data["items"][0]["truncated"], true);
        assert_eq!(data["items"][1]["text"], "ab😀");
        let request = req(json!({ "op": "texts", "texts": ["😀😀"], "limit": 2 }));
        let data = run(&request).expect("texts");
        assert_eq!(data["items"][0]["text"], "😀😀");
        assert_eq!(data["items"][0]["truncated"], false);
    }
}
