//! `ExtraSkillStat` / `ExtraSkillMod` (CalcActiveSkill.lua:578, 611-614): `skillModList:List(skillCfg,
//! ...)` values that other sources (items, tree) attach to a skill, e.g. "Your Offering Skills also
//! affect you" (`ExtraSkillMod` wrapping a `SkillData buffNotPlayer=false` mod).

use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::value::Value;

pub fn stats_and_mods(store: &ModStore, cfg: &Cfg) -> (Vec<(String, f64)>, Vec<Mod>) {
    let mut stats = Vec::new();
    for v in store.list(Some(cfg), &[pom_engine::sym!("ExtraSkillStat")]) {
        let Value::Map(fields) = &v else { continue };
        let get = |k: &str| fields.iter().find(|(n, _)| n.as_str() == k).map(|(_, v)| v);
        if let (Some(Value::Str(key)), Some(Value::Num(value))) = (get("key"), get("value")) {
            stats.push((key.to_string(), *value));
        }
    }
    let mut mods = Vec::new();
    for v in store.list(Some(cfg), &[pom_engine::sym!("ExtraSkillMod")]) {
        let Value::Map(fields) = &v else { continue };
        if let Some((_, Value::Map(inner))) = fields.iter().find(|(n, _)| n.as_str() == "mod") {
            mods.push(map_to_mod(inner));
        }
    }
    (stats, mods)
}

/// Rebuilds a `Mod` from the `Value::Map` a wrapped `.mod` field parses into (name/type/value/
/// flags/keywordFlags/source, plus positional tags at keys "1", "2", ...).
pub(crate) fn map_to_mod(map: &[(Sym, Value)]) -> Mod {
    let get = |k: &str| map.iter().find(|(mk, _)| mk.as_str() == k).map(|(_, v)| v.clone());
    let name = match get("name") {
        Some(Value::Str(s)) => Sym::new(&s),
        _ => pom_engine::sym!(""),
    };
    let ty = match get("type") {
        Some(Value::Str(s)) => ModType::parse(&s).unwrap_or(ModType::Base),
        _ => ModType::Base,
    };
    let num = |k: &str| match get(k) {
        Some(Value::Num(n)) => n as u64,
        _ => 0,
    };
    let source = match get("source") {
        Some(Value::Str(s)) => Some(s),
        _ => None,
    };
    let mut tags = Vec::new();
    let mut i = 1;
    while let Some(Value::Map(t)) = get(&i.to_string()) {
        if let Some(Value::Str(kind)) = t.iter().find(|(k, _)| k.as_str() == "type").map(|(_, v)| v.clone()) {
            tags.push(Tag { kind: Sym::new(&kind), fields: t.iter().filter(|(k, _)| k.as_str() != "type").cloned().collect() });
        }
        i += 1;
    }
    Mod { name, ty, value: get("value").unwrap_or(Value::Nil), flags: num("flags"), keyword_flags: num("keywordFlags"), source, tags: (tags).into() }
}
