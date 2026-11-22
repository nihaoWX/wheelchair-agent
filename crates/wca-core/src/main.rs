//! `wheelchair-agent-core` — the process boundary around the moved wheelchair-agent logic.
//!
//! Every subcommand reads one JSON request on stdin and writes one JSON envelope on stdout. Every
//! caller-controlled failure is a `Result` turned into `{"ok":false,...}`; malformed stdin never
//! panics.

use std::io::{Read, Write};
use std::process::ExitCode;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use wca_core::queue::{self, QueueRequest};
use wca_core::schema::{self, SchemaCheckRequest};
use wca_core::{plan_from_request, schema_bundle, Envelope, WorkPlanRequest};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command] if command == "work-plan" => work_plan(),
        [command] if command == "queue-op" => queue_op(),
        [command] if command == "schema-check" => schema_check(),
        [command] if command == "schema" => schema(),
        [] => usage("missing subcommand; expected \"work-plan\", \"queue-op\", \"schema-check\" or \"schema\""),
        [command] => usage(&format!(
            "unknown subcommand {:?}; expected \"work-plan\", \"queue-op\", \"schema-check\" or \"schema\"",
            command
        )),
        _ => usage("expected exactly one subcommand"),
    }
}

fn work_plan() -> ExitCode {
    let request: WorkPlanRequest = match read_request() {
        Ok(request) => request,
        Err(message) => {
            emit_failure("invalid_request", &message);
            return ExitCode::from(1);
        }
    };
    match plan_from_request(&request) {
        Ok(plan) => {
            emit(&Envelope::success(plan));
            ExitCode::SUCCESS
        }
        Err(message) => {
            emit_failure("plan_failed", &message);
            ExitCode::from(1)
        }
    }
}

fn queue_op() -> ExitCode {
    let request: QueueRequest = match read_request() {
        Ok(request) => request,
        Err(message) => {
            emit_failure("invalid_request", &message);
            return ExitCode::from(1);
        }
    };
    match queue::run(&request) {
        Ok(data) => {
            emit(&Envelope::success(data));
            ExitCode::SUCCESS
        }
        Err(error) => {
            emit_failure(&error.code, &error.message);
            ExitCode::from(1)
        }
    }
}

fn schema_check() -> ExitCode {
    let request: SchemaCheckRequest = match read_request() {
        Ok(request) => request,
        Err(message) => {
            emit_failure("invalid_request", &message);
            return ExitCode::from(1);
        }
    };
    match schema::check(&request) {
        Ok(result) => {
            emit(&Envelope::success(result));
            ExitCode::SUCCESS
        }
        Err((code, message)) => {
            emit_failure(&code, &message);
            ExitCode::from(1)
        }
    }
}

fn schema() -> ExitCode {
    match serde_json::to_string_pretty(&schema_bundle()) {
        Ok(text) => {
            let mut stdout = std::io::stdout().lock();
            if writeln!(stdout, "{}", text).is_err() {
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            emit_failure(
                "schema_failed",
                &format!("cannot serialize the schema: {}", error),
            );
            ExitCode::from(1)
        }
    }
}

fn read_request<T: DeserializeOwned>() -> Result<T, String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("cannot read stdin: {}", error))?;
    serde_json::from_str(&input)
        .map_err(|error| format!("the request is not valid JSON: {}", error))
}

fn usage(message: &str) -> ExitCode {
    emit_failure("usage", message);
    ExitCode::from(2)
}

fn emit_failure(code: &str, message: &str) {
    emit(&Envelope::<Value>::failure(code, message));
}

fn emit<T: Serialize>(response: &Envelope<T>) {
    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, response).is_err() {
        return;
    }
    let _ = writeln!(stdout);
}
