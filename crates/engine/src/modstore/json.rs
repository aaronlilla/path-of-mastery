//! Decoding of the recorder's JSON encoding of a dynamic value (a "jval": lists tagged `__l`, maps `__m`, NaN and
//! infinity as strings), shared by every crate that reads recorded snapshots.
use crate::sym::Sym;
use crate::value::Value;
use serde_json::Value as J;
use std::sync::Arc;

pub fn jnum(v: &J) -> Option<f64> {
    match v {
        J::Number(n) => n.as_f64(),
        J::String(s) => match s.as_str() { "NaN" => Some(f64::NAN), "Inf" => Some(f64::INFINITY), "-Inf" => Some(f64::NEG_INFINITY), _ => None },
        _ => None,
    }
}
/// Converts a jval()-encoded JSON node into our dynamic `Value` (mod.value / tag fields).
pub fn parse_value(v: &J) -> Value {
    match v {
        J::Null => Value::Nil,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(0.0)),
        J::String(s) => match s.as_str() {
            "NaN" => Value::Num(f64::NAN),
            "Inf" => Value::Num(f64::INFINITY),
            "-Inf" => Value::Num(f64::NEG_INFINITY),
            _ => Value::Str(Arc::from(s.as_str())),
        },
        J::Object(o) => {
            if let Some(J::Array(items)) = o.get("__l") {
                Value::List(Arc::new(items.iter().map(parse_value).collect()))
            } else if let Some(J::Object(m)) = o.get("__m") {
                Value::Map(Arc::new(m.iter().map(|(k, v)| (Sym::new(k), parse_value(v))).collect()))
            } else {
                Value::Nil
            }
        }
        J::Array(_) => Value::Nil, // jval never emits a bare JSON array
    }
}
