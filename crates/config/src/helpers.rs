//! Small constructors used by every handler module, matching Modules/ModTools.lua's
//! modLib.createMod / Classes/ModStore.lua's ModStoreClass:NewMod: `name, type, value, source,
//! tags...`. No apply handler in ConfigOptions.lua passes explicit numeric flags/keywordFlags, so
//! those two always come out 0 here.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use std::sync::Arc;

pub fn s(x: &str) -> Value {
    Value::Str(Arc::from(x))
}
pub fn n(x: f64) -> Value {
    Value::Num(x)
}
pub fn b(x: bool) -> Value {
    Value::Bool(x)
}
pub fn list(items: Vec<Value>) -> Value {
    Value::List(Arc::new(items))
}
/// Builds a `Value::Map`, key order sorted alphabetically as strings - matching the recorder's
/// `jval`, which does `table.sort(keys, function(a,b) return tostring(a) < tostring(b) end)`
/// before emitting a generic Lua table. `Value::Map`'s equality is order-sensitive (it's a plain
/// `Vec`), so every map we build (this fn, `mod_value`, `tag_value`) MUST sort the same way the
/// golden JSON did, or an otherwise-correct mod compares unequal.
pub fn map(fields: &[(&str, Value)]) -> Value {
    let mut sorted: Vec<&(&str, Value)> = fields.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    Value::Map(Arc::new(sorted.into_iter().map(|(k, v)| (Sym::new(k), v.clone())).collect()))
}
/// A nested `Mod` embedded as a LIST-type mod value (e.g. `MinionModifier`'s `{ mod = ... }`).
/// Matches how modLib.createMod's returned table (named fields + positional tag array) serializes
/// generically through the recorder's jval: sorted keys, including the stringified tag indices
/// (which sort before the alphabetic field names, since ASCII digits < letters).
pub fn mod_value(m: &Mod) -> Value {
    let mut fields: Vec<(String, Value)> = vec![
        ("name".into(), s(m.name.as_str())),
        ("type".into(), s(m.ty.as_str())),
        ("value".into(), m.value.clone()),
        ("flags".into(), n(m.flags as f64)),
        ("keywordFlags".into(), n(m.keyword_flags as f64)),
    ];
    if let Some(src) = &m.source {
        fields.push(("source".into(), s(src)));
    }
    for (i, t) in m.tags.iter().enumerate() {
        fields.push(((i + 1).to_string(), tag_value(t)));
    }
    fields.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Map(Arc::new(fields.into_iter().map(|(k, v)| (Sym::new(&k), v)).collect()))
}
fn tag_value(t: &Tag) -> Value {
    let mut fields: Vec<(String, Value)> = vec![("type".into(), s(t.kind.as_str()))];
    for (k, v) in &t.fields {
        fields.push((k.as_str().to_string(), v.clone()));
    }
    fields.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Map(Arc::new(fields.into_iter().map(|(k, v)| (Sym::new(&k), v)).collect()))
}

/// Builds a `Tag`, field order sorted alphabetically - matching the recorder's serialization
/// (`table.sort(fields)` over the tag's non-"type" keys before emitting `fields:{...}`). `Tag`'s
/// equality is order-sensitive, so an otherwise-correct tag with fields in a different order than
/// the golden JSON's would compare unequal.
pub fn tag(kind: &str, fields: &[(&str, Value)]) -> Tag {
    let mut sorted: Vec<&(&str, Value)> = fields.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    Tag { kind: Sym::new(kind), fields: sorted.into_iter().map(|(k, v)| (Sym::new(k), v.clone())).collect() }
}

pub fn new_mod(name: &str, ty: ModType, value: Value, source: &str, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}

/// A `Mod` with no source at all (Lua `nil`), for a `modList:NewMod(...)`/`modLib.createMod(...)`
/// call that omits the trailing source argument entirely - as opposed to `new_mod`, which always
/// sets one.
pub fn mod_no_source(name: &str, ty: ModType, value: Value, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: 0, source: None, tags: (tags).into() }
}

/// The common `MinionModifier`/"LIST" wrapper whose value is `{ mod = <inner> }`
/// (`modList:NewMod("MinionModifier", "LIST", { mod = modLib.createMod(...) })`), for the very
/// common case where the OUTER `NewMod` call itself passes no source argument (stays Lua nil).
pub fn mod_no_source_minion(inner: Mod) -> Mod {
    mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![])
}

/// `string.format("%d", v)` for whole numbers, matching the recorder's own `jnum`/Lua `tostring`
/// convention used when an OptionValue needs stringifying (Lua does not print numbers as "1.0").
pub fn fmt_num(v: f64) -> String {
    if v == v.floor() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}
