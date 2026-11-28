//! The process boundary contract: JSON in, JSON envelope out, non-zero exit on failure, no panic on
//! malformed caller input.

use std::process::{Command, Stdio};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_wheelchair-agent-core")
}

fn run(args: &[&str], input: &str) -> (i32, String, String) {
    let mut child = Command::new(binary())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary starts");
    {
        use std::io::Write;
        child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(input.as_bytes())
            .expect("stdin accepts the request");
    }
    let output = child.wait_with_output().expect("the binary exits");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn malformed_stdin_is_a_clean_envelope_not_a_panic() {
    let (status, stdout, stderr) = run(&["work-plan"], "not json");
    assert_ne!(status, 0, "malformed input must exit non-zero");
    assert!(!stderr.contains("panicked"), "no panic output: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["code"], "invalid_request");
    assert!(
        envelope["message"]
            .as_str()
            .unwrap_or_default()
            .contains("not valid JSON"),
        "the message names the bad JSON: {}",
        envelope["message"]
    );
}

#[test]
fn a_missing_or_wrongly_typed_option_is_a_clean_envelope() {
    let (status, stdout, stderr) = run(&["work-plan"], "{\"root\":42}");
    assert_ne!(status, 0);
    assert!(!stderr.contains("panicked"), "no panic output: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["code"], "invalid_request");
}

#[test]
fn an_empty_root_plans_successfully() {
    let root = std::env::temp_dir().join(format!("wca-cli-empty-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create the work root");
    let request = serde_json::json!({ "root": root.to_string_lossy() });
    let (status, stdout, stderr) = run(&["work-plan"], &request.to_string());
    assert_eq!(status, 0, "stderr: {}", stderr);
    assert!(!stdout.contains("ok\":false"));
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["entries"], serde_json::json!([]));
    assert_eq!(envelope["data"]["reclaimableBytes"], 0.0);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn schema_prints_both_shapes() {
    let (status, stdout, stderr) = run(&["schema"], "");
    assert_eq!(status, 0, "stderr: {}", stderr);
    let schema: serde_json::Value = serde_json::from_str(&stdout).expect("schema is JSON");
    assert!(schema["request"]["properties"]["root"].is_object());
    assert!(schema["response"]["properties"]["ok"].is_object());
    assert!(schema["queue"]["request"]["oneOf"].is_array());
    assert!(schema["queue"]["response"]["properties"]["ok"].is_object());
    assert!(schema["schemaCheck"]["request"]["properties"]["validator"].is_object());
    assert!(schema["schemaCheck"]["response"]["properties"]["ok"].is_object());
    assert!(
        schema["schemaCheck"]["response"]["properties"]["data"].is_object(),
        "the response shape is the envelope the CLI actually prints"
    );
}

#[test]
fn an_unknown_subcommand_is_a_usage_envelope() {
    let (status, stdout, stderr) = run(&["nope"], "");
    assert_eq!(status, 2);
    assert!(stderr.is_empty(), "usage errors stay on stdout");
    let envelope: serde_json::Value = serde_json::from_str(&stdout).expect("envelope");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["code"], "usage");
}

#[test]
fn malformed_stdin_is_clean_for_every_new_subcommand() {
    for command in ["queue-op", "schema-check"] {
        let (status, stdout, stderr) = run(&[command], "not json");
        assert_ne!(status, 0, "{} must exit non-zero", command);
        assert!(
            !stderr.contains("panicked"),
            "{} must not panic: {}",
            command,
            stderr
        );
        let envelope: serde_json::Value =
            serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
        assert_eq!(envelope["ok"], false);
        assert_eq!(envelope["code"], "invalid_request");
    }
}

#[test]
fn schema_check_reports_the_exact_validation_message() {
    let request = serde_json::json!({
        "validator": { "kind": "text", "min": 2 },
        "value": "a"
    });
    let (status, stdout, stderr) = run(&["schema-check"], &request.to_string());
    assert_eq!(status, 1, "stderr: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["code"], "schema_error");
    assert_eq!(envelope["message"], "must be at least 2 characters");
}

#[test]
fn queue_layout_round_trips() {
    let request = serde_json::json!({ "op": "layout", "root": "/tmp/wca-cli-queue//root" });
    let (status, stdout, stderr) = run(&["queue-op"], &request.to_string());
    assert_eq!(status, 0, "stderr: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], true);
    assert_eq!(
        envelope["data"]["pending"],
        "/tmp/wca-cli-queue/root/pending"
    );
    assert_eq!(
        envelope["data"]["read"],
        "/tmp/wca-cli-queue/root/outbox/read"
    );
}

#[test]
fn settings_rejects_malformed_missing_and_out_of_range_requests_cleanly() {
    for input in ["not json", "{\"op\":\"nope\"}", "{\"op\":\"save\"}"] {
        let (status, stdout, stderr) = run(&["settings"], input);
        assert_ne!(status, 0, "input must fail: {}", input);
        assert!(
            !stderr.contains("panicked"),
            "no panic for {}: {}",
            input,
            stderr
        );
        let envelope: serde_json::Value =
            serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
        assert_eq!(envelope["ok"], false, "input: {}", input);
        assert_eq!(envelope["code"], "invalid_request", "input: {}", input);
    }
    let request = serde_json::json!({
        "op": "save",
        "current": 0,
        "values": { "work.keep": -1 }
    });
    let (status, stdout, stderr) = run(&["settings"], &request.to_string());
    assert_ne!(status, 0);
    assert!(!stderr.contains("panicked"), "no panic: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["code"], "SETTINGS_INVALID");
    assert_eq!(envelope["message"], "work.keep must be at least 0, got -1.");
}

#[test]
fn settings_defaults_are_ordered_and_complete() {
    let (status, stdout, stderr) = run(&["settings"], "{\"op\":\"defaults\"}");
    assert_eq!(status, 0, "stderr: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], true);
    let values = envelope["data"]["values"]
        .as_object()
        .expect("defaults values are an object");
    let keys: Vec<&str> = values.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        vec![
            "panel.port",
            "spv.surface",
            "spv.webPort",
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
    assert_eq!(values["webui.style"], "fluid");
    assert_eq!(values["inbox.intervalSeconds"], 60);
    assert_eq!(values["work.sweepOnMount"], true);
}

#[test]
fn hooks_rejects_malformed_requests_and_unknown_events_cleanly() {
    for input in ["not json", "{\"op\":\"nope\"}", "{\"op\":\"payload\"}"] {
        let (status, stdout, stderr) = run(&["hooks"], input);
        assert_ne!(status, 0, "input must fail: {}", input);
        assert!(
            !stderr.contains("panicked"),
            "no panic for {}: {}",
            input,
            stderr
        );
        let envelope: serde_json::Value =
            serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
        assert_eq!(envelope["ok"], false, "input: {}", input);
        assert_eq!(envelope["code"], "invalid_request", "input: {}", input);
    }
    let request = serde_json::json!({
        "op": "eventId",
        "event": "nope",
        "known": false,
        "knownEvents": ["ticket.started"],
        "require": true
    });
    let (status, stdout, stderr) = run(&["hooks"], &request.to_string());
    assert_ne!(status, 0);
    assert!(!stderr.contains("panicked"), "no panic: {}", stderr);
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["code"], "UNKNOWN_EVENT");
    assert_eq!(
        envelope["message"],
        "unknown hook event \"nope\"; known ids are ticket.started."
    );
}
