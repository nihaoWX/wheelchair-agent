//! `wca-core` — the standalone Rust half of the wheelchair-agent toolchain bridge.
//!
//! The crate builds one executable, `wheelchair-agent-core`, which is the single implementation of
//! the ticket-clone reclaim planner (`planWork()` used to live in `src/shared/work.js`). A separate
//! process is deliberate: a Rust panic or abort stays inside this command instead of taking down the
//! dsh service or SPV session.
//!
//! The CLI contract is JSON over stdin/stdout:
//!   - `work-plan` reads one [`WorkPlanRequest`] and writes one [`WorkPlanResponse`] envelope;
//!   - `schema` prints the JSON Schema for both shapes.
//!
//! Exit status is 0 for `{"ok":true,...}` and non-zero for `{"ok":false,...}`. Malformed input is a
//! normal `Result` path, never a panic.

pub mod git;
pub mod hooks;
pub mod plan;
pub mod procscan;
pub mod queue;
pub mod schema;
pub mod settings;
pub mod time;
pub mod util;

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One `work-plan` request: the same options the JavaScript `planWork()` takes.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkPlanRequest {
    pub root: String,
    #[serde(default)]
    pub keep: f64,
    #[serde(default)]
    pub keep_days: f64,
    /// Absolute milliseconds; omitted means "now".
    #[serde(default)]
    pub now: Option<f64>,
    /// Normalised clone directory → open ticket id/title. The JS wrapper adapts the `Map` and applies
    /// `path.resolve()` to the keys, exactly as the old planner did.
    #[serde(default)]
    pub skip_directories: HashMap<String, String>,
    #[serde(default)]
    pub blocked_reason: Option<String>,
}

/// The one JSON envelope: `{"ok":true,"data":…}` or `{"ok":false,"code":…,"message":…}`.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl<T> Envelope<T> {
    pub fn success(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            code: None,
            message: None,
        }
    }

    pub fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            code: Some(code.into()),
            message: Some(message.into()),
        }
    }
}

/// The `work-plan` response shape.
pub type WorkPlanResponse = Envelope<plan::Plan>;

/// Build the plan for one request.
pub fn plan_from_request(request: &WorkPlanRequest) -> Result<plan::Plan, String> {
    let mut options = plan::PlanOptions::new(request.root.clone());
    options.keep = request.keep;
    options.keep_days = request.keep_days;
    options.now = request.now.unwrap_or_else(time::now_ms);
    options.skip_directories = request.skip_directories.clone();
    options.blocked_reason = request.blocked_reason.clone();
    plan::plan(&options)
}

/// The request and response JSON Schemas, as printed by the `schema` subcommand.
pub fn schema_bundle() -> Value {
    serde_json::json!({
        "request": schemars::schema_for!(WorkPlanRequest),
        "response": schemars::schema_for!(WorkPlanResponse),
        "queue": {
            "request": schemars::schema_for!(queue::QueueRequest),
            "response": schemars::schema_for!(Envelope<Value>),
        },
        "schemaCheck": {
            "request": schemars::schema_for!(schema::SchemaCheckRequest),
            "response": schemars::schema_for!(Envelope<schema::SchemaCheckResult>),
        },
        "settings": {
            "request": schemars::schema_for!(settings::SettingsRequest),
            "response": schemars::schema_for!(Envelope<Value>),
        },
        "hooks": {
            "request": schemars::schema_for!(hooks::HooksRequest),
            "response": schemars::schema_for!(Envelope<Value>),
        },
    })
}
