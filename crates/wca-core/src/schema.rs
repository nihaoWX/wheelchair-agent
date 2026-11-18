//! The tiny validator from `src/shared/schema.js`, moved into the binary.
//!
//! The accepted shapes, defaults and rejection messages are part of the public contract: callers
//! assert on the message text. `schema-check` takes one validator description and one JSON value and
//! returns either the parsed value or the exact `SchemaError` message.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::util;

/// One validator description, as built by the JS wrappers.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ValidatorSpec {
    Text(TextOptions),
    Integer(IntegerOptions),
    Records(RecordsOptions),
    Object(ObjectOptions),
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextOptions {
    #[serde(default)]
    pub fallback_present: bool,
    #[serde(default)]
    pub fallback: Option<Value>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegerOptions {
    #[serde(default)]
    pub fallback_present: bool,
    #[serde(default)]
    pub fallback: Option<Value>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObjectField {
    pub key: String,
    pub validator: ValidatorSpec,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObjectOptions {
    #[serde(default)]
    pub shape: Vec<ObjectField>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecordsOptions {
    #[serde(default)]
    pub fallback: Option<Vec<Value>>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub extra: Vec<ObjectField>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SchemaCheckRequest {
    pub validator: ValidatorSpec,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SchemaCheckResult {
    pub defined: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

/// Evaluate one validator against one value.
pub fn check(request: &SchemaCheckRequest) -> Result<SchemaCheckResult, (String, String)> {
    match evaluate(&request.validator, &request.value) {
        Ok(Some(value)) => Ok(SchemaCheckResult {
            defined: true,
            value: Some(value),
        }),
        Ok(None) => Ok(SchemaCheckResult {
            defined: false,
            value: None,
        }),
        Err(message) => Err(("schema_error".to_string(), message)),
    }
}

/// Return the parsed value, `None` for JavaScript `undefined`, or the exact `SchemaError` message.
fn evaluate(spec: &ValidatorSpec, value: &Value) -> Result<Option<Value>, String> {
    match spec {
        ValidatorSpec::Text(options) => text(options, value).map(Some),
        ValidatorSpec::Integer(options) => integer(options, value).map(Some),
        ValidatorSpec::Records(options) => records(options, value),
        ValidatorSpec::Object(options) => object(options, value).map(Some),
    }
}

fn text(options: &TextOptions, value: &Value) -> Result<Value, String> {
    let min = options.min.unwrap_or(0.0);
    let max = options.max.unwrap_or(f64::INFINITY);
    let fallback = if options.fallback_present {
        options.fallback.clone().unwrap_or(Value::Null)
    } else {
        Value::String(String::new())
    };
    let rendered = match value {
        Value::Null => String::new(),
        other => util::js_string(other),
    };
    let text = rendered.trim().to_string();
    if text.is_empty() {
        if fallback != Value::String(String::new()) {
            return Ok(fallback);
        }
        if min > 0.0 {
            return Err(format!(
                "a non-empty string of at least {} characters is required",
                util::js_number(min)
            ));
        }
        return Ok(Value::String(String::new()));
    }
    let length = text.encode_utf16().count() as f64;
    if length < min {
        return Err(format!(
            "must be at least {} characters",
            util::js_number(min)
        ));
    }
    if length > max {
        return Err(format!(
            "must be at most {} characters",
            util::js_number(max)
        ));
    }
    Ok(Value::String(text))
}

fn integer(options: &IntegerOptions, value: &Value) -> Result<Value, String> {
    let missing =
        matches!(value, Value::Null) || matches!(value, Value::String(text) if text.is_empty());
    if missing {
        if !options.fallback_present {
            return Err("a number is required".to_string());
        }
        return Ok(options.fallback.clone().unwrap_or(Value::Null));
    }
    let number = util::js_to_number(value);
    if !number.is_finite() || number.fract() != 0.0 {
        return Err("must be an integer".to_string());
    }
    let min = options.min.unwrap_or(f64::NEG_INFINITY);
    let max = options.max.unwrap_or(f64::INFINITY);
    if number < min || number > max {
        return Err(format!(
            "must be between {} and {}",
            util::js_number(min),
            util::js_number(max)
        ));
    }
    Ok(util::json_number(number))
}

fn records(options: &RecordsOptions, value: &Value) -> Result<Option<Value>, String> {
    if matches!(value, Value::Null) {
        if options.optional {
            return Ok(None);
        }
        let fallback = options.fallback.clone().unwrap_or_default();
        return Ok(Some(Value::Array(
            fallback.iter().map(spread).collect::<Vec<_>>(),
        )));
    }
    let Value::Array(items) = value else {
        return Err("must be a list".to_string());
    };
    let id_spec = ValidatorSpec::Text(TextOptions {
        fallback_present: false,
        fallback: None,
        min: Some(1.0),
        max: Some(200.0),
    });
    let mut parsed = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(map) = item else {
            return Err("every entry must be an object".to_string());
        };
        let raw_id = map.get("id").cloned().unwrap_or(Value::Null);
        let id = evaluate(&id_spec, &raw_id)?.unwrap_or_else(|| Value::String(String::new()));
        let mut result = map.clone();
        result.insert("id".to_string(), id);
        for field in &options.extra {
            if let Some(current) = result.get(&field.key).cloned() {
                match evaluate(&field.validator, &current)? {
                    Some(checked) => {
                        result.insert(field.key.clone(), checked);
                    }
                    None => {
                        result.remove(&field.key);
                    }
                }
            }
        }
        parsed.push(Value::Object(result));
    }
    Ok(Some(Value::Array(parsed)))
}

fn object(options: &ObjectOptions, value: &Value) -> Result<Value, String> {
    let empty = Map::new();
    let input = match value {
        Value::Object(map) => map,
        _ => &empty,
    };
    let mut result = Map::new();
    for field in &options.shape {
        let raw = input.get(&field.key).cloned().unwrap_or(Value::Null);
        if let Some(checked) =
            evaluate(&field.validator, &raw).map_err(|error| format!("{}: {}", field.key, error))?
        {
            result.insert(field.key.clone(), checked);
        }
    }
    Ok(Value::Object(result))
}

/// JavaScript object spread for a fallback entry: objects are copied, other JSON values become an
/// empty object (the only arrays used as fallbacks are lists of records).
fn spread(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.clone()),
        _ => Value::Object(Map::new()),
    }
}
