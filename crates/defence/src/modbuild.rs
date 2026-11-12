//! Small helpers for `modDB:NewMod(name, type, value, source, ...tags)` calls, the shape
//! `calcs.defence`/`calcs.resistances` use to add mods to a live ModDB mid-calculation (resistance
//! conversion mods, `ArmourAppliesToPhysicalDamageTaken`). Same shape as
//! `crates/calc/src/modbuild.rs`, copied rather than shared: this crate depends only on
//! `pom-engine`, never on a sibling crate.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use std::sync::Arc;

pub fn tag(kind: &str, fields: &[(&str, Value)]) -> Tag {
    Tag { kind: Sym::new(kind), fields: fields.iter().map(|(k, v)| (Sym::new(*k), v.clone())).collect() }
}
pub fn sv(s: &str) -> Value { Value::Str(Arc::from(s)) }
pub fn multiplier(var: &str) -> Tag { tag("Multiplier", &[("var", sv(var))]) }

/// `modDB:NewMod(name, type, value, source)` - numeric value, no flags/tags.
pub fn m(name: &str, ty: ModType, value: f64, source: &str) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}
/// `modDB:NewMod(name, type, value, source, ...tags)`
pub fn mt(name: &str, ty: ModType, value: f64, source: &str, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}
/// `modDB:NewMod(name, "FLAG", true, source, ...tags)` - boolean value.
pub fn mb(name: &str, source: &str) -> Mod {
    Mod { name: Sym::new(name), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}
