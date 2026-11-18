//! Validator parity: defaults, coercion and the exact `SchemaError` message text.

use serde_json::{json, Value};
use wca_core::schema::{self, SchemaCheckRequest, SchemaCheckResult};

fn check(validator: Value, value: Value) -> Result<SchemaCheckResult, (String, String)> {
    let request: SchemaCheckRequest = serde_json::from_value(json!({
        "validator": validator,
        "value": value,
    }))
    .expect("a valid schema-check request");
    schema::check(&request)
}

fn ok_value(validator: Value, value: Value) -> Value {
    check(validator, value)
        .expect("valid")
        .value
        .expect("defined")
}

#[test]
fn text_defaults_fallbacks_lengths_and_messages() {
    assert_eq!(ok_value(json!({"kind":"text"}), json!("  hi  ")), "hi");
    assert_eq!(ok_value(json!({"kind":"text"}), Value::Null), "");
    assert_eq!(
        ok_value(json!({"kind":"text","fallbackPresent":true,"fallback":"x"}), json!("   ")),
        "x"
    );
    assert_eq!(
        check(json!({"kind":"text","min":2}), json!("a")).unwrap_err(),
        (
            "schema_error".to_string(),
            "must be at least 2 characters".to_string()
        )
    );
    assert_eq!(
        check(json!({"kind":"text","min":1}), json!("   ")).unwrap_err(),
        (
            "schema_error".to_string(),
            "a non-empty string of at least 1 characters is required".to_string()
        )
    );
    assert_eq!(
        check(json!({"kind":"text","max":2}), json!("abc")).unwrap_err(),
        (
            "schema_error".to_string(),
            "must be at most 2 characters".to_string()
        )
    );
}

#[test]
fn integer_coerces_like_number_and_uses_the_same_messages() {
    assert_eq!(ok_value(json!({"kind":"integer"}), json!("5")), 5);
    assert_eq!(ok_value(json!({"kind":"integer"}), json!(true)), 1);
    assert_eq!(
        ok_value(json!({"kind":"integer","fallbackPresent":true,"fallback":2}), Value::Null),
        2
    );
    assert_eq!(
        ok_value(
            json!({"kind":"integer","fallbackPresent":true,"fallback":null}),
            Value::Null
        ),
        Value::Null,
        "an explicit null fallback is returned, not treated as absent"
    );
    assert_eq!(
        check(json!({"kind":"integer"}), Value::Null).unwrap_err(),
        (
            "schema_error".to_string(),
            "a number is required".to_string()
        )
    );
    assert_eq!(
        check(json!({"kind":"integer"}), json!(1.5)).unwrap_err(),
        ("schema_error".to_string(), "must be an integer".to_string())
    );
    assert_eq!(
        check(json!({"kind":"integer","min":1,"max":3}), json!(0)).unwrap_err(),
        (
            "schema_error".to_string(),
            "must be between 1 and 3".to_string()
        )
    );
}

#[test]
fn records_fallbacks_optional_and_extra_fields() {
    let fallback = ok_value(
        json!({"kind":"records","fallback":[{"id":"a","x":1}]}),
        Value::Null,
    );
    assert_eq!(fallback, json!([{"id":"a","x":1}]));

    let result = check(json!({"kind":"records","optional":true}), Value::Null).unwrap();
    assert!(!result.defined, "optional missing records are undefined");

    let error = check(json!({"kind":"records"}), json!([{}])).unwrap_err();
    assert_eq!(
        error.1,
        "a non-empty string of at least 1 characters is required"
    );

    let parsed = ok_value(
        json!({
            "kind":"records",
            "extra":[{"key":"n","validator":{"kind":"integer","fallbackPresent":true,"fallback":7}}]
        }),
        json!([{"id":"a","n":"5"},{"id":"b"}]),
    );
    assert_eq!(parsed, json!([{"id":"a","n":5},{"id":"b"}]));
}

#[test]
fn object_drops_unknown_keys_and_prefixes_errors() {
    let parsed = ok_value(
        json!({
            "kind":"object",
            "shape":[
                {"key":"a","validator":{"kind":"text","fallbackPresent":true,"fallback":"x"}},
                {"key":"b","validator":{"kind":"integer","fallbackPresent":true,"fallback":2}},
                {"key":"c","validator":{"kind":"records","optional":true}}
            ]
        }),
        json!({"a":" y ", "b":"5", "extra":"dropped"}),
    );
    assert_eq!(parsed, json!({"a":"y","b":5}));

    let error = check(
        json!({
            "kind":"object",
            "shape":[{"key":"count","validator":{"kind":"integer"}}]
        }),
        json!({}),
    )
    .unwrap_err();
    assert_eq!(error.1, "count: a number is required");
}
