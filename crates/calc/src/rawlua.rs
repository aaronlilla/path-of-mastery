//! Parses the generic Lua-table JSON shape used by the item and passives crates' own recorders
//! which both serialize a `Mod` table
//! with the same free-form `ser()`/`ser2`-style function: `{"name":..,"type":..,"value":..,
//! "flags":N,"keywordFlags":N,"source":..,"1":<tag>,"2":<tag>,...}` - tags are the table's own
//! numeric-key entries (Lua's array part), not a separate `"tags"` field, and a tag itself is
//! `{"type":"Condition","var":"X","neg":true}` (its `type` field IS the tag kind, not wrapped in
//! `{"kind":...,"fields":{...}}` the way this crate's own recorder writes it). This
//! is a different wire shape from `snapshot.rs` (which reads this crate's own recorder), so it
//! gets its own parser rather than sharing `snapshot::parse_mod`.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use serde_json::Value as J;

fn parse_num(v: &J) -> Option<f64> {
    match v {
        J::Number(n) => n.as_f64(),
        J::String(s) => match s.as_str() {
            "NaN" => Some(f64::NAN),
            "Inf" => Some(f64::INFINITY),
            "-Inf" => Some(f64::NEG_INFINITY),
            _ => None,
        },
        _ => None,
    }
}

/// Numeric-string keys "1".."n", sorted, standing in for a Lua table's array part.
fn numeric_keys(o: &serde_json::Map<String, J>) -> Vec<i64> {
    let mut ks: Vec<i64> = o.keys().filter_map(|k| k.parse::<i64>().ok()).filter(|n| *n >= 1).collect();
    ks.sort_unstable();
    ks
}

/// Converts one JSON node from this wire shape into our `Value` (mod.value / tag field values).
/// An object whose keys are exactly `"1"..="n"` (Lua's array-part test, `#t == count`) becomes a
/// `Value::List`; any other object becomes a `Value::Map`.
pub fn parse_raw_value(v: &J) -> Value {
    match v {
        J::Null => Value::Nil,
        J::Bool(b) => Value::Bool(*b),
        J::Number(_) => Value::Num(parse_num(v).unwrap_or(0.0)),
        J::String(s) => match s.as_str() {
            "NaN" => Value::Num(f64::NAN),
            "Inf" => Value::Num(f64::INFINITY),
            "-Inf" => Value::Num(f64::NEG_INFINITY),
            _ => Value::Str(s.as_str().into()),
        },
        J::Array(a) => Value::List(std::sync::Arc::new(a.iter().map(parse_raw_value).collect())),
        J::Object(o) => {
            let keys = numeric_keys(o);
            if !keys.is_empty() && keys.len() == o.len() && keys[0] == 1 && keys.windows(2).all(|w| w[1] == w[0] + 1) {
                Value::List(std::sync::Arc::new(keys.iter().map(|k| parse_raw_value(&o[&k.to_string()])).collect()))
            } else {
                Value::Map(std::sync::Arc::new(o.iter().map(|(k, v)| (Sym::new(k), parse_raw_value(v))).collect()))
            }
        }
    }
}

fn parse_raw_tag(v: &J) -> Tag {
    let o = v.as_object().unwrap_or_else(|| panic!("tag is not an object: {v}"));
    let kind = Sym::new(o.get("type").and_then(|t| t.as_str()).unwrap_or(""));
    let mut fields = Vec::new();
    let mut keys: Vec<&String> = o.keys().filter(|k| k.as_str() != "type").collect();
    keys.sort();
    for k in keys {
        fields.push((Sym::new(k), parse_raw_value(&o[k])));
    }
    Tag { kind, fields }
}

/// One `Mod` table in this wire shape.
pub fn parse_raw_mod(v: &J) -> Mod {
    let o = v.as_object().unwrap_or_else(|| panic!("mod is not an object: {v}"));
    let name = Sym::new(o.get("name").and_then(|x| x.as_str()).unwrap_or(""));
    let ty = ModType::parse(o.get("type").and_then(|x| x.as_str()).unwrap_or("")).unwrap_or(ModType::Base);
    let value = o.get("value").map(parse_raw_value).unwrap_or(Value::Nil);
    let flags = o.get("flags").and_then(parse_num).unwrap_or(0.0) as u64;
    let keyword_flags = o.get("keywordFlags").and_then(parse_num).unwrap_or(0.0) as u64;
    let source = o.get("source").and_then(|s| s.as_str()).map(|s| s.into());
    let tag_keys = numeric_keys(o);
    let tags = tag_keys.iter().map(|k| parse_raw_tag(&o[&k.to_string()])).collect();
    Mod { name, ty, value, flags, keyword_flags, source, tags }
}

/// A JSON array of raw mod tables (a Lua `ModList`/plain array of mods).
pub fn parse_raw_mod_list(v: &J) -> Vec<Mod> {
    v.as_array().map(|a| a.iter().map(parse_raw_mod).collect()).unwrap_or_default()
}
