//! Small helpers for constructing `pom_engine::modifier::Mod`/`Tag` values, matching the call
//! shape of the Lua `modDB:NewMod(name, type, value, source, flags, keywordFlags, ...tags)`
//! (Classes/ModDB.lua; flags, keywordFlags and tags are all optional and default to 0/0/none).
//! `setup.rs` uses these to port the `modDB:NewMod(...)` call sequences in CalcSetup.lua one
//! line at a time, so each Lua line maps to one Rust statement built from these.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use std::sync::Arc;

/// `{ type = kind, k1 = v1, ... }`
pub fn tag(kind: &str, fields: &[(&str, Value)]) -> Tag {
    Tag { kind: Sym::new(kind), fields: fields.iter().map(|(k, v)| (Sym::new(*k), v.clone())).collect() }
}
pub fn sv(s: &str) -> Value { Value::Str(Arc::from(s)) }

/// `{ type = "Condition", var = var }`
pub fn cond(var: &str) -> Tag { tag("Condition", &[("var", sv(var))]) }
/// `{ type = "Condition", var = var, neg = true }`
pub fn cond_neg(var: &str) -> Tag { tag("Condition", &[("var", sv(var)), ("neg", Value::Bool(true))]) }
/// `{ type = "ActorCondition", actor = actor, var = var }`
pub fn actor_cond(actor: &str, var: &str) -> Tag { tag("ActorCondition", &[("actor", sv(actor)), ("var", sv(var))]) }
/// `{ type = "Multiplier", var = var }`
pub fn mult(var: &str) -> Tag { tag("Multiplier", &[("var", sv(var))]) }
/// `{ type = "Multiplier", var = var, limit = limit, div = div }`
pub fn mult_ld(var: &str, limit: f64, div: f64) -> Tag {
    tag("Multiplier", &[("var", sv(var)), ("limit", Value::Num(limit)), ("div", Value::Num(div))])
}
/// `{ type = "Multiplier", var = var, base = base }`
pub fn mult_base(var: &str, base: f64) -> Tag { tag("Multiplier", &[("var", sv(var)), ("base", Value::Num(base))]) }
/// `{ type = "PerStat", stat = stat, div = div }`
pub fn per_stat_div(stat: &str, div: f64) -> Tag { tag("PerStat", &[("stat", sv(stat)), ("div", Value::Num(div))]) }
/// `{ type = "GlobalEffect", effectName = name, effectType = ty }`
pub fn global_effect(name: &str, ty: &str) -> Tag { tag("GlobalEffect", &[("effectName", sv(name)), ("effectType", sv(ty))]) }
/// `{ type = "IgnoreCond" }`
pub fn ignore_cond() -> Tag { tag("IgnoreCond", &[]) }
/// `{ type = "MultiplierThreshold", var = var, threshold = threshold }`
pub fn mult_threshold(var: &str, threshold: f64) -> Tag {
    tag("MultiplierThreshold", &[("var", sv(var)), ("threshold", Value::Num(threshold))])
}

/// `modDB:NewMod(name, type, value, source)` - numeric value, no flags/tags.
pub fn m(name: &str, ty: ModType, value: f64, source: &str) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}
/// `modDB:NewMod(name, type, value, source, ...tags)` - numeric value, tags, no flags.
pub fn mt(name: &str, ty: ModType, value: f64, source: &str, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}
/// `modDB:NewMod(name, type, value, source, flags, ...tags)`
pub fn mf(name: &str, ty: ModType, value: f64, source: &str, flags: u64, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}
/// `modDB:NewMod(name, type, value, source, flags, keywordFlags, ...tags)`
pub fn mfk(name: &str, ty: ModType, value: f64, source: &str, flags: u64, keyword_flags: u64, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value: Value::Num(value), flags, keyword_flags, source: Some(Arc::from(source)), tags: (tags).into() }
}
/// `modDB:NewMod(name, "FLAG", true, source, ...tags)` - boolean value.
pub fn mb(name: &str, source: &str, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}
/// `modDB:NewMod(name, "FLAG", true, source, flags, keywordFlags, ...tags)` - boolean value.
pub fn mbk(name: &str, source: &str, flags: u64, keyword_flags: u64, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty: ModType::Flag, value: Value::Bool(true), flags, keyword_flags, source: Some(Arc::from(source)), tags: (tags).into() }
}
