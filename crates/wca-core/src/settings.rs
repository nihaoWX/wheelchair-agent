//! The pure-data half of the panel settings, moved out of `src/shared/settings.js`.
//!
//! File IO, template/hook validation and the HTTP handler stay in JavaScript; this module owns the
//! key table and defaults, the value normalisation rules, the `filled` bookkeeping, the layered
//! resolution (`file > config > env > default`) and the optimistic-concurrency check. Every message
//! is byte-for-byte the one the JavaScript produced, because `tests/test-settings.mjs` asserts them.

use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::util;

/// The one file-format version; a file carrying another version falls back to defaults in JS.
pub const SETTINGS_VERSION: i64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Boolean,
    String,
    Integer,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Boolean => "boolean",
            Kind::String => "string",
            Kind::Integer => "integer",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Default {
    Boolean(bool),
    Text(&'static str),
    Integer(i64),
}

impl Default {
    fn value(self) -> Value {
        match self {
            Default::Boolean(value) => Value::Bool(value),
            Default::Text(value) => Value::String(value.to_string()),
            Default::Integer(value) => Value::Number(serde_json::Number::from(value)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Spec {
    key: &'static str,
    kind: Kind,
    default: Default,
    env: Option<&'static str>,
    min: Option<i64>,
    max: Option<i64>,
    options: Option<&'static [&'static str]>,
    label_zh: &'static str,
    label_en: &'static str,
}

/// The key table, in panel/display order. Keep this the single source of truth: the JS side only
/// receives a copy through the `specs` operation so there is no second implementation to drift.
const SPECS: &[Spec] = &[
    Spec {
        key: "panel.port",
        kind: Kind::Integer,
        default: Default::Integer(3080),
        env: Some("SPV_PANEL_PORT"),
        min: Some(1),
        max: Some(65535),
        options: None,
        label_zh: "独立面板端口",
        label_en: "Standalone panel port",
    },
    Spec {
        key: "webui.style",
        kind: Kind::String,
        default: Default::Text("fluid"),
        env: None,
        min: None,
        max: None,
        options: Some(&["minimal", "fluid"]),
        label_zh: "面板样式",
        label_en: "Panel style",
    },
    Spec {
        key: "inbox.intervalSeconds",
        kind: Kind::Integer,
        default: Default::Integer(60),
        env: Some("SPV_INBOX_INTERVAL_SECONDS"),
        min: Some(0),
        max: Some(2147483),
        options: None,
        label_zh: "收件箱刷新间隔（秒）",
        label_en: "Inbox refresh interval (seconds)",
    },
    Spec {
        key: "merge.installRepo",
        kind: Kind::String,
        default: Default::Text("wheelchair-agent"),
        env: Some("SPV_INSTALL_REPO"),
        min: None,
        max: None,
        options: None,
        label_zh: "合并即冷安装的仓库",
        label_en: "Install-target repository",
    },
    Spec {
        key: "merge.autoMerge",
        kind: Kind::Boolean,
        default: Default::Boolean(false),
        env: None,
        min: None,
        max: None,
        options: None,
        label_zh: "交付后自动合并工单 PR",
        label_en: "Auto-merge a ticket PR after delivery",
    },
    Spec {
        key: "injection.intervalMs",
        kind: Kind::Integer,
        default: Default::Integer(1000),
        env: None,
        min: Some(50),
        max: Some(3600000),
        options: None,
        label_zh: "结果注入间隔（毫秒）",
        label_en: "Result injection interval (ms)",
    },
    Spec {
        key: "injection.maxBodyChars",
        kind: Kind::Integer,
        default: Default::Integer(12000),
        env: None,
        min: Some(100),
        max: Some(200000),
        options: None,
        label_zh: "注入正文上限（字符）",
        label_en: "Injected body limit (characters)",
    },
    Spec {
        key: "work.keep",
        kind: Kind::Integer,
        default: Default::Integer(0),
        env: None,
        min: Some(0),
        max: Some(100000),
        options: None,
        label_zh: "work gc 保留最新的目录数",
        label_en: "work gc newest directories to keep",
    },
    Spec {
        key: "work.keepDays",
        kind: Kind::Integer,
        default: Default::Integer(0),
        env: None,
        min: Some(0),
        max: Some(36500),
        options: None,
        label_zh: "work gc 保留最近天数",
        label_en: "work gc retention days",
    },
    Spec {
        key: "work.sweepOnMount",
        kind: Kind::Boolean,
        default: Default::Boolean(true),
        env: None,
        min: None,
        max: None,
        options: None,
        label_zh: "服务启动时自动回收",
        label_en: "Reclaim at mount",
    },
];

fn spec_for(key: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.key == key)
}

fn default_value(spec: &Spec) -> Value {
    spec.default.value()
}

/// One `settings` request. The enum tag is the stable action name the JS wrapper calls.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum SettingsRequest {
    /// The full key table, used by `settings.js` to expose `KEY_SPECS` without a second copy.
    Specs,
    /// Every built-in default plus the `filled` list a fresh file records.
    Defaults,
    /// Normalise the stored `values`/`filled` blocks (used by `saveSettings`).
    Read {
        #[serde(default, deserialize_with = "present_value")]
        values: Option<Value>,
        #[serde(default, deserialize_with = "present_value")]
        filled: Option<Value>,
        #[serde(default, rename = "fillMissing")]
        fill_missing: bool,
    },
    /// Normalise and layer the stored values over config/env for `resolveSettings`.
    Resolve {
        #[serde(default, deserialize_with = "present_value")]
        values: Option<Value>,
        #[serde(default, deserialize_with = "present_value")]
        filled: Option<Value>,
        #[serde(default, rename = "fillMissing")]
        fill_missing: bool,
        #[serde(default)]
        env: Option<Value>,
        #[serde(default)]
        config: Option<Value>,
    },
    /// The optimistic-concurrency rule: a missing/stale revision is a `SETTINGS_CONFLICT`.
    CheckRevision {
        current: i64,
        #[serde(default, rename = "givenPresent")]
        given_present: bool,
        #[serde(default)]
        given: Value,
    },
    /// Merge an optional PUT `values` block and build the full payload values + `filled`.
    Save {
        current: i64,
        #[serde(default)]
        values: Value,
        #[serde(default, deserialize_with = "present_value")]
        patch: Option<Value>,
    },
}

/// Keep `null` distinct from an absent field: the file parser warns about `"values": null`, while an
/// absent block is silently empty.
fn present_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

/// A settings failure as an envelope code/message pair.
#[derive(Debug)]
pub struct SettingsError {
    pub code: String,
    pub message: String,
}

fn invalid(message: impl Into<String>) -> SettingsError {
    SettingsError {
        code: "SETTINGS_INVALID".to_string(),
        message: message.into(),
    }
}

fn conflict(current: i64, given: Option<&Value>) -> SettingsError {
    let why = match given {
        None => "settings revision is required".to_string(),
        Some(value) => format!("settings revision {} is stale", describe(value)),
    };
    SettingsError {
        code: "SETTINGS_CONFLICT".to_string(),
        message: format!(
            "{}: the current revision is {}. Reload the panel and retry; nothing was written.",
            why, current
        ),
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Label {
    zh: String,
    en: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SpecJson {
    #[serde(rename = "type")]
    kind: String,
    default: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<String>>,
    label: Label,
}

/// The file the fill write should produce: all values (raw + appended defaults) and `filled`.
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FillPlan {
    pub values: Map<String, Value>,
    pub filled: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub values: Map<String, Value>,
    pub filled: Vec<String>,
    pub filled_warnings: Vec<String>,
    pub values_warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillPlan>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source: String,
    pub value: Value,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub name: String,
    pub present: bool,
    pub value: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: String,
    pub value: Value,
    pub default: Value,
    pub source: String,
    pub overridden: Vec<Candidate>,
    pub env: Option<EnvInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub values: Map<String, Value>,
    pub filled: Vec<String>,
    pub effective: Map<String, Value>,
    pub rows: Vec<Row>,
    pub filled_warnings: Vec<String>,
    pub values_warnings: Vec<String>,
    pub compose_warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillPlan>,
}

/// Run one `settings` operation and return its envelope data.
pub fn run(request: &SettingsRequest) -> Result<Value, SettingsError> {
    match request {
        SettingsRequest::Specs => {
            let mut specs = Map::new();
            for spec in SPECS {
                let entry = SpecJson {
                    kind: spec.kind.name().to_string(),
                    default: default_value(spec),
                    env: spec.env.map(str::to_string),
                    min: spec.min,
                    max: spec.max,
                    options: spec.options.map(|options| {
                        options.iter().map(|option| (*option).to_string()).collect()
                    }),
                    label: Label {
                        zh: spec.label_zh.to_string(),
                        en: spec.label_en.to_string(),
                    },
                };
                specs.insert(
                    spec.key.to_string(),
                    serde_json::to_value(entry)
                        .map_err(|error| invalid(format!("cannot serialize specs: {}", error)))?,
                );
            }
            let mut data = Map::new();
            data.insert("specs".to_string(), Value::Object(specs));
            Ok(Value::Object(data))
        }
        SettingsRequest::Defaults => {
            let mut values = Map::new();
            for spec in SPECS {
                values.insert(spec.key.to_string(), default_value(spec));
            }
            let filled: Vec<String> = SPECS.iter().map(|spec| spec.key.to_string()).collect();
            Ok(serde_json::json!({ "values": values, "filled": filled }))
        }
        SettingsRequest::Read {
            values,
            filled,
            fill_missing,
        } => {
            let result = read_values_blocks(values.as_ref(), filled.as_ref(), *fill_missing);
            serde_json::to_value(result)
                .map_err(|error| invalid(format!("cannot serialize the result: {}", error)))
        }
        SettingsRequest::Resolve {
            values,
            filled,
            fill_missing,
            env,
            config,
        } => {
            let result = resolve_values(
                values.as_ref(),
                filled.as_ref(),
                *fill_missing,
                env.as_ref(),
                config.as_ref(),
            );
            serde_json::to_value(result)
                .map_err(|error| invalid(format!("cannot serialize the result: {}", error)))
        }
        SettingsRequest::CheckRevision {
            current,
            given_present,
            given,
        } => {
            check_revision(*current, *given_present, given)?;
            Ok(Value::Null)
        }
        SettingsRequest::Save {
            current,
            values,
            patch,
        } => save_values(*current, values, patch.as_ref()),
    }
}

fn read_values_blocks(
    values: Option<&Value>,
    filled: Option<&Value>,
    fill_missing: bool,
) -> ReadResult {
    let mut filled_warnings = Vec::new();
    let mut filled_keys = read_stored_filled(filled, &mut filled_warnings);
    let fill = if fill_missing {
        fill_missing_defaults(values, &mut filled_keys)
    } else {
        None
    };
    let mut values_warnings = Vec::new();
    let values = read_stored_values(values, &filled_keys, &mut values_warnings);
    ReadResult {
        values,
        filled: filled_array(&filled_keys),
        filled_warnings,
        values_warnings,
        fill,
    }
}

fn resolve_values(
    values: Option<&Value>,
    filled: Option<&Value>,
    fill_missing: bool,
    env: Option<&Value>,
    config: Option<&Value>,
) -> ResolveResult {
    let mut filled_warnings = Vec::new();
    let mut filled_keys = read_stored_filled(filled, &mut filled_warnings);
    let fill = if fill_missing {
        fill_missing_defaults(values, &mut filled_keys)
    } else {
        None
    };
    let mut values_warnings = Vec::new();
    let stored_values = read_stored_values(values, &filled_keys, &mut values_warnings);

    let config_object = match config {
        Some(Value::Object(object)) => Some(object),
        _ => None,
    };
    let env_object = match env {
        Some(Value::Object(object)) => Some(object),
        _ => None,
    };
    let mut config_values: Map<String, Value> = Map::new();
    let mut env_values: Map<String, Value> = Map::new();
    let mut env_infos: HashMap<&'static str, Option<EnvInfo>> = HashMap::new();
    let mut compose_warnings = Vec::new();

    for spec in SPECS {
        if let Some(object) = config_object {
            let mut raw = object.get(spec.key);
            if raw.is_none() && spec.key == "inbox.intervalSeconds" {
                // The old host-half config was `{intervalSeconds}`; keep that alias.
                raw = object.get("intervalSeconds");
            }
            if let Some(raw) = raw {
                match normalize(spec.key, raw, false) {
                    Ok(value) => {
                        config_values.insert(spec.key.to_string(), value);
                    }
                    Err(error) => compose_warnings.push(format!(
                        "ignoring the plugin config for {}: {}",
                        spec.key, error.message
                    )),
                }
            }
        }
        match spec.env {
            Some(name) => {
                let raw = env_object.and_then(|object| object.get(name));
                let present = match raw {
                    Some(value) => !value.is_null() && !util::js_string(value).trim().is_empty(),
                    None => false,
                };
                env_infos.insert(
                    spec.key,
                    Some(EnvInfo {
                        name: name.to_string(),
                        present,
                        value: if present {
                            raw.map(util::js_string)
                        } else {
                            None
                        },
                    }),
                );
                if present {
                    if let Some(raw) = raw {
                        match normalize(spec.key, raw, false) {
                            Ok(value) => {
                                env_values.insert(spec.key.to_string(), value);
                            }
                            Err(error) => compose_warnings
                                .push(format!("ignoring {}: {}", name, error.message)),
                        }
                    }
                }
            }
            None => {
                env_infos.insert(spec.key, None);
            }
        }
    }

    let mut effective = Map::new();
    let mut rows = Vec::new();
    for spec in SPECS {
        let mut candidates: Vec<(&'static str, Value)> = Vec::new();
        if let Some(value) = stored_values.get(spec.key) {
            candidates.push(("file", value.clone()));
        }
        if let Some(value) = config_values.get(spec.key) {
            candidates.push(("config", value.clone()));
        }
        if let Some(value) = env_values.get(spec.key) {
            candidates.push(("env", value.clone()));
        }
        let (source, value) = match candidates.first() {
            Some((source, value)) => (*source, value.clone()),
            None => ("default", default_value(spec)),
        };
        effective.insert(spec.key.to_string(), value.clone());
        rows.push(Row {
            key: spec.key.to_string(),
            value,
            default: default_value(spec),
            source: source.to_string(),
            overridden: candidates
                .iter()
                .skip(1)
                .map(|(source, value)| Candidate {
                    source: (*source).to_string(),
                    value: value.clone(),
                })
                .collect(),
            env: env_infos.get(spec.key).cloned().flatten(),
            options: spec
                .options
                .map(|options| options.iter().map(|option| (*option).to_string()).collect()),
        });
    }

    ResolveResult {
        values: stored_values,
        filled: filled_array(&filled_keys),
        effective,
        rows,
        filled_warnings,
        values_warnings,
        compose_warnings,
        fill,
    }
}

fn read_stored_filled(raw: Option<&Value>, warnings: &mut Vec<String>) -> HashSet<String> {
    let mut filled = HashSet::new();
    let Some(raw) = raw else {
        return filled;
    };
    let Value::Array(entries) = raw else {
        warnings.push("ignoring \"filled\": it must be an array of settings keys.".to_string());
        return filled;
    };
    for key in entries {
        match key {
            Value::String(key) if spec_for(key).is_some() => {
                filled.insert(key.clone());
            }
            other => warnings.push(format!(
                "ignoring unknown settings key {} in \"filled\".",
                describe(other)
            )),
        }
    }
    filled
}

fn filled_array(filled: &HashSet<String>) -> Vec<String> {
    SPECS
        .iter()
        .filter(|spec| filled.contains(spec.key))
        .map(|spec| spec.key.to_string())
        .collect()
}

fn read_stored_values(
    raw: Option<&Value>,
    filled: &HashSet<String>,
    warnings: &mut Vec<String>,
) -> Map<String, Value> {
    let mut values = Map::new();
    let Some(raw) = raw else {
        return values;
    };
    let Value::Object(object) = raw else {
        warnings.push("ignoring \"values\": it must be a JSON object of dotted keys.".to_string());
        return values;
    };
    for (key, value) in object {
        let Some(spec) = spec_for(key) else {
            warnings.push(format!(
                "ignoring unknown settings key {} in the file.",
                quote(key)
            ));
            continue;
        };
        match normalize(key, value, true) {
            Ok(normalized) => {
                if filled.contains(key) && normalized == default_value(spec) {
                    continue;
                }
                values.insert(key.clone(), normalized);
            }
            Err(error) => warnings.push(format!("ignoring {} in the file: {}", key, error.message)),
        }
    }
    values
}

fn fill_missing_defaults(raw: Option<&Value>, filled: &mut HashSet<String>) -> Option<FillPlan> {
    let mut values = match raw {
        Some(Value::Object(object)) => object.clone(),
        Some(_) => return None,
        None => Map::new(),
    };
    let mut missing = false;
    for spec in SPECS {
        if values.contains_key(spec.key) {
            continue;
        }
        values.insert(spec.key.to_string(), default_value(spec));
        filled.insert(spec.key.to_string());
        missing = true;
    }
    if !missing {
        return None;
    }
    Some(FillPlan {
        values,
        filled: filled_array(filled),
    })
}

fn check_revision(current: i64, given_present: bool, given: &Value) -> Result<(), SettingsError> {
    let parsed = if given_present {
        non_negative_integer(given)
    } else {
        None
    };
    if parsed != Some(current) {
        return Err(conflict(
            current,
            if given_present { Some(given) } else { None },
        ));
    }
    Ok(())
}

fn non_negative_integer(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else {
        return None;
    };
    if let Some(integer) = number.as_i64() {
        return (integer >= 0).then_some(integer);
    }
    if let Some(integer) = number.as_u64() {
        return i64::try_from(integer).ok().filter(|integer| *integer >= 0);
    }
    let value = number.as_f64()?;
    if value.is_finite() && value.fract() == 0.0 && (0.0..=i64::MAX as f64).contains(&value) {
        Some(value as i64)
    } else {
        None
    }
}

fn save_values(
    current: i64,
    values: &Value,
    patch: Option<&Value>,
) -> Result<Value, SettingsError> {
    let mut explicit = match values {
        Value::Object(object) => object.clone(),
        _ => return Err(invalid("values must be a JSON object of dotted keys.")),
    };
    if let Some(patch) = patch {
        let Value::Object(patch) = patch else {
            return Err(invalid("values must be a JSON object of dotted keys."));
        };
        for (key, raw) in patch {
            let normalized = normalize(key, raw, true)?;
            explicit.insert(key.clone(), normalized);
        }
    }

    let mut payload_values = Map::new();
    let mut filled = Vec::new();
    for spec in SPECS {
        match explicit.get(spec.key) {
            Some(value) => {
                // Re-validate the trusted map so a malformed direct request cannot write a bad file.
                payload_values.insert(spec.key.to_string(), normalize(spec.key, value, true)?);
            }
            None => {
                payload_values.insert(spec.key.to_string(), default_value(spec));
                filled.push(spec.key.to_string());
            }
        }
    }
    Ok(serde_json::json!({
        "revision": current + 1,
        "values": payload_values,
        "filled": filled,
    }))
}

/// JavaScript's `JSON.stringify` for a string, used in the messages that quote a key/value.
fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// JavaScript's `describeValue()`: strings stay JSON-quoted; other values use JSON text; a value JSON
/// cannot render falls back to `String(value)`.
fn describe(value: &Value) -> String {
    match value {
        Value::String(text) => quote(text),
        Value::Number(number) => util::js_number(number.as_f64().unwrap_or(f64::NAN)),
        other => serde_json::to_string(other).unwrap_or_else(|_| util::js_string(other)),
    }
}

fn normalize(key: &str, raw: &Value, strict: bool) -> Result<Value, SettingsError> {
    let Some(spec) = spec_for(key) else {
        return Err(invalid(format!("unknown settings key {}.", quote(key))));
    };
    match spec.kind {
        Kind::Boolean => {
            if let Value::Bool(value) = raw {
                return Ok(Value::Bool(*value));
            }
            if !strict {
                if let Value::String(value) = raw {
                    if value == "true" {
                        return Ok(Value::Bool(true));
                    }
                    if value == "false" {
                        return Ok(Value::Bool(false));
                    }
                }
            }
            Err(invalid(format!(
                "{} must be true or false, got {}.",
                key,
                describe(raw)
            )))
        }
        Kind::String => {
            let Value::String(text) = raw else {
                return Err(invalid(format!(
                    "{} must be a string, got {}.",
                    key,
                    describe(raw)
                )));
            };
            let value = text.trim();
            if let Some(options) = spec.options {
                if !options.iter().any(|option| *option == value) {
                    let list = options
                        .iter()
                        .map(|option| quote(option))
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(invalid(format!(
                        "{} must be one of {}, got {}.",
                        key,
                        list,
                        quote(text)
                    )));
                }
            }
            if key == "merge.installRepo" && !is_install_repo(value) {
                return Err(invalid(format!(
                    "{} must be \"name\" or \"owner/name\" using letters, digits, dot, dash and underscore, got {}.",
                    key,
                    quote(text)
                )));
            }
            Ok(Value::String(value.to_string()))
        }
        Kind::Integer => {
            if matches!(
                raw,
                Value::Bool(_) | Value::Null | Value::Object(_) | Value::Array(_)
            ) {
                return Err(invalid(format!(
                    "{} must be a number, got {}.",
                    key,
                    describe(raw)
                )));
            }
            if let Value::String(text) = raw {
                if text.trim().is_empty() {
                    return Err(invalid(format!(
                        "{} must be a number, got {}.",
                        key,
                        describe(raw)
                    )));
                }
            }
            let value = match raw {
                Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
                Value::String(_) => util::js_to_number(raw),
                _ => f64::NAN,
            };
            if !value.is_finite() {
                return Err(invalid(format!(
                    "{} must be a number, got {}.",
                    key,
                    describe(raw)
                )));
            }
            if value.fract() != 0.0 && (strict || key != "inbox.intervalSeconds") {
                return Err(invalid(format!(
                    "{} must be a whole number, got {}.",
                    key,
                    describe(raw)
                )));
            }
            if let Some(min) = spec.min {
                if value < min as f64 {
                    return Err(invalid(format!(
                        "{} must be at least {}, got {}.",
                        key,
                        min,
                        describe(raw)
                    )));
                }
            }
            if let Some(max) = spec.max {
                if value > max as f64 {
                    return Err(invalid(format!(
                        "{} must be at most {}, got {}.",
                        key,
                        max,
                        describe(raw)
                    )));
                }
            }
            Ok(util::json_number(value))
        }
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)?$` without a regex dependency.
fn is_install_repo(value: &str) -> bool {
    let mut parts = value.split('/');
    let Some(first) = parts.next() else {
        return false;
    };
    let second = parts.next();
    if parts.next().is_some() {
        return false;
    }
    valid_repo_segment(first) && second.map(valid_repo_segment).unwrap_or(true)
}

fn valid_repo_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    match characters.next() {
        Some(character) if character.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("valid JSON")
    }

    fn error_message(result: Result<Value, SettingsError>) -> String {
        match result {
            Ok(value) => panic!("expected a failure, got {}", value),
            Err(error) => error.message,
        }
    }

    #[test]
    fn spec_order_and_defaults_match_the_panel() {
        let keys: Vec<_> = SPECS.iter().map(|spec| spec.key).collect();
        assert_eq!(
            keys,
            vec![
                "panel.port",
                "webui.style",
                "inbox.intervalSeconds",
                "merge.installRepo",
                "merge.autoMerge",
                "injection.intervalMs",
                "injection.maxBodyChars",
                "work.keep",
                "work.keepDays",
                "work.sweepOnMount",
            ]
        );
        assert_eq!(default_value(&SPECS[0]), json("3080"));
        assert_eq!(default_value(&SPECS[1]), json("\"fluid\""));
        assert_eq!(default_value(&SPECS[2]), json("60"));
        assert_eq!(default_value(&SPECS[8]), json("0"));
        assert_eq!(default_value(&SPECS[9]), json("true"));
    }

    #[test]
    fn defaults_operation_is_in_panel_order() {
        let data = run(&SettingsRequest::Defaults).expect("defaults");
        assert_eq!(
            data["values"],
            json(
                "{\"panel.port\":3080,\"webui.style\":\"fluid\",\"inbox.intervalSeconds\":60,\"merge.installRepo\":\"wheelchair-agent\",\"merge.autoMerge\":false,\"injection.intervalMs\":1000,\"injection.maxBodyChars\":12000,\"work.keep\":0,\"work.keepDays\":0,\"work.sweepOnMount\":true}"
            )
        );
        assert_eq!(
            data["filled"],
            json(
                "[\"panel.port\",\"webui.style\",\"inbox.intervalSeconds\",\"merge.installRepo\",\"merge.autoMerge\",\"injection.intervalMs\",\"injection.maxBodyChars\",\"work.keep\",\"work.keepDays\",\"work.sweepOnMount\"]"
            )
        );
    }

    #[test]
    fn integer_normalisation_matches_javascript() {
        assert_eq!(
            normalize("work.keep", &json("\"7\""), true).expect("string integer"),
            json("7")
        );
        assert_eq!(
            normalize("inbox.intervalSeconds", &json("0.02"), false).expect("fraction allowed"),
            json("0.02")
        );
        assert_eq!(
            error_message(normalize("inbox.intervalSeconds", &json("0.02"), true)),
            "inbox.intervalSeconds must be a whole number, got 0.02."
        );
        assert_eq!(
            error_message(normalize("work.keep", &json("0.02"), false)),
            "work.keep must be a whole number, got 0.02."
        );
        assert_eq!(
            error_message(normalize("work.keep", &json("\"  \""), true)),
            "work.keep must be a number, got \"  \"."
        );
        assert_eq!(
            error_message(normalize("work.keep", &json("true"), true)),
            "work.keep must be a number, got true."
        );
        assert_eq!(
            error_message(normalize("work.keep", &json("-1"), true)),
            "work.keep must be at least 0, got -1."
        );
        assert_eq!(
            error_message(normalize("work.keep", &json("100001"), true)),
            "work.keep must be at most 100000, got 100001."
        );
    }

    #[test]
    fn string_boolean_and_unknown_rules_match() {
        assert_eq!(
            normalize("merge.autoMerge", &json("\"true\""), false).expect("non-strict bool"),
            json("true")
        );
        assert_eq!(
            error_message(normalize("merge.autoMerge", &json("\"true\""), true)),
            "merge.autoMerge must be true or false, got \"true\"."
        );
        assert_eq!(
            error_message(normalize("webui.style", &json("\"fancy\""), true)),
            "webui.style must be one of \"minimal\", \"fluid\", got \"fancy\"."
        );
        assert_eq!(
            error_message(normalize("merge.installRepo", &json("\"bad repo\""), true)),
            "merge.installRepo must be \"name\" or \"owner/name\" using letters, digits, dot, dash and underscore, got \"bad repo\"."
        );
        assert_eq!(
            error_message(normalize("no.such", &json("1"), true)),
            "unknown settings key \"no.such\"."
        );
    }

    #[test]
    fn read_skips_filled_defaults_but_keeps_hand_edits() {
        let filled = json("[\"work.keep\",\"work.keepDays\"]");
        let values =
            json("{\"work.keep\":0,\"work.keepDays\":4,\"bad.key\":1,\"work.sweepOnMount\":false}");
        let data = run(&SettingsRequest::Read {
            values: Some(values),
            filled: Some(filled),
            fill_missing: false,
        })
        .expect("read");
        assert_eq!(
            data["values"],
            json("{\"work.keepDays\":4,\"work.sweepOnMount\":false}")
        );
        assert_eq!(
            data["valuesWarnings"],
            json("[\"ignoring unknown settings key \\\"bad.key\\\" in the file.\"]")
        );
    }

    #[test]
    fn fill_missing_defaults_only_adds_missing_keys() {
        let data = run(&SettingsRequest::Read {
            values: Some(json("{\"work.keep\":3}")),
            filled: Some(json("[]")),
            fill_missing: true,
        })
        .expect("read");
        assert_eq!(data["fill"]["values"]["work.keep"], json("3"));
        assert_eq!(data["fill"]["values"]["work.keepDays"], json("0"));
        assert_eq!(
            data["fill"]["filled"],
            json(
                "[\"panel.port\",\"webui.style\",\"inbox.intervalSeconds\",\"merge.installRepo\",\"merge.autoMerge\",\"injection.intervalMs\",\"injection.maxBodyChars\",\"work.keepDays\",\"work.sweepOnMount\"]"
            )
        );
        assert_eq!(data["values"], json("{\"work.keep\":3}"));
    }

    #[test]
    fn resolve_layers_file_over_config_over_env_over_default() {
        let env =
            json("{\"SPV_INBOX_INTERVAL_SECONDS\":\"90\",\"SPV_INSTALL_REPO\":\"acme/inst\"}");
        let config =
            json("{\"intervalSeconds\":0.02,\"work.keep\":5,\"merge.autoMerge\":\"true\"}");
        let data = run(&SettingsRequest::Resolve {
            values: Some(json("{\"work.keep\":7}")),
            filled: Some(json("[]")),
            fill_missing: false,
            env: Some(env),
            config: Some(config),
        })
        .expect("resolve");
        assert_eq!(data["effective"]["work.keep"], json("7"));
        assert_eq!(data["effective"]["inbox.intervalSeconds"], json("0.02"));
        assert_eq!(data["effective"]["merge.autoMerge"], json("true"));
        assert_eq!(
            data["effective"]["merge.installRepo"],
            json("\"acme/inst\"")
        );
        assert_eq!(data["effective"]["webui.style"], json("\"fluid\""));
        let rows = data["rows"].as_array().expect("rows");
        let inbox = rows
            .iter()
            .find(|row| row["key"] == "inbox.intervalSeconds")
            .expect("inbox row");
        assert_eq!(inbox["source"], "config");
        assert_eq!(
            inbox["overridden"],
            json("[{\"source\":\"env\",\"value\":90}]")
        );
        let keep = rows
            .iter()
            .find(|row| row["key"] == "work.keep")
            .expect("keep row");
        assert_eq!(keep["source"], "file");
        assert_eq!(
            keep["overridden"],
            json("[{\"source\":\"config\",\"value\":5}]")
        );
    }

    #[test]
    fn conflict_messages_name_the_current_revision() {
        let error = check_revision(4, true, &json("2")).expect_err("stale");
        assert_eq!(error.code, "SETTINGS_CONFLICT");
        assert_eq!(
            error.message,
            "settings revision 2 is stale: the current revision is 4. Reload the panel and retry; nothing was written."
        );
        let error = check_revision(4, false, &Value::Null).expect_err("missing");
        assert_eq!(
            error.message,
            "settings revision is required: the current revision is 4. Reload the panel and retry; nothing was written."
        );
        check_revision(4, true, &json("4")).expect("matching revision");
    }

    #[test]
    fn save_builds_the_full_values_and_filled_list() {
        let data = run(&SettingsRequest::Save {
            current: 2,
            values: json("{\"work.keep\":5}"),
            patch: Some(json("{\"webui.style\":\"minimal\",\"work.keepDays\":9}")),
        })
        .expect("save");
        assert_eq!(data["revision"], json("3"));
        assert_eq!(data["values"]["webui.style"], json("\"minimal\""));
        assert_eq!(data["values"]["work.keep"], json("5"));
        assert_eq!(data["values"]["work.keepDays"], json("9"));
        assert_eq!(
            data["filled"],
            json(
                "[\"panel.port\",\"inbox.intervalSeconds\",\"merge.installRepo\",\"merge.autoMerge\",\"injection.intervalMs\",\"injection.maxBodyChars\",\"work.sweepOnMount\"]"
            )
        );
    }

    #[test]
    fn malformed_requests_are_results_not_panics() {
        assert_eq!(
            error_message(run(&SettingsRequest::Save {
                current: 0,
                values: Value::Null,
                patch: None,
            })),
            "values must be a JSON object of dotted keys."
        );
        let data = run(&SettingsRequest::Read {
            values: Some(json("[]")),
            filled: Some(json("{}")),
            fill_missing: true,
        })
        .expect("read");
        assert_eq!(
            data["filledWarnings"],
            json("[\"ignoring \\\"filled\\\": it must be an array of settings keys.\"]")
        );
        assert_eq!(
            data["valuesWarnings"],
            json("[\"ignoring \\\"values\\\": it must be a JSON object of dotted keys.\"]")
        );
        assert!(data["fill"].is_null());
    }
}
