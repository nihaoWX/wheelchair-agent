//! `wheelchair-agent-core` — the process boundary around the reclaim planner.
//!
//! Reads one JSON request on stdin and writes one JSON envelope on stdout. Every caller-controlled
//! failure is a `Result` turned into `{"ok":false,...}`; malformed stdin never panics.

use std::io::{Read, Write};
use std::process::ExitCode;

use wca_core::{plan_from_request, schema_bundle, WorkPlanRequest, WorkPlanResponse};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command] if command == "work-plan" => work_plan(),
        [command] if command == "schema" => schema(),
        [] => usage("missing subcommand; expected \"work-plan\" or \"schema\""),
        [command] => usage(&format!(
            "unknown subcommand {:?}; expected \"work-plan\" or \"schema\"",
            command
        )),
        _ => usage("expected exactly one subcommand"),
    }
}

fn work_plan() -> ExitCode {
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        return failure("invalid_request", &format!("cannot read stdin: {}", error));
    }
    let request: WorkPlanRequest = match serde_json::from_str(&input) {
        Ok(request) => request,
        Err(error) => {
            return failure(
                "invalid_request",
                &format!("the request is not valid JSON: {}", error),
            );
        }
    };
    let response = match plan_from_request(&request) {
        Ok(plan) => WorkPlanResponse::success(plan),
        Err(message) => WorkPlanResponse::failure("plan_failed", message),
    };
    let status = if response.ok { 0 } else { 1 };
    emit(&response);
    ExitCode::from(status)
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
        Err(error) => failure(
            "schema_failed",
            &format!("cannot serialize the schema: {}", error),
        ),
    }
}

fn usage(message: &str) -> ExitCode {
    failure("usage", message);
    ExitCode::from(2)
}

fn failure(code: &str, message: &str) -> ExitCode {
    emit(&WorkPlanResponse::failure(code, message));
    ExitCode::from(1)
}

fn emit(response: &WorkPlanResponse) {
    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, response).is_err() {
        return;
    }
    let _ = writeln!(stdout);
}
