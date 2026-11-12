//! Test hook (never on in normal runs): replaces the pipeline's own upstream state (player/enemy modDBs, skill mod
//! list, skill flags/data/cfg, weapon data, actor output) right before `calcs.offence` with a recorded state of the
//! original at CalcOffence.lua:518, so the offence code can be checked on its own.
//!
//! `POM_OFFENCE_INPUT=<dir>` with `<dir>/<POM_BUILD_NAME>.json` = the recorded state. The file may hold several
//! records (one per skill calculated for the build); the one for the pipeline's main skill is used.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Actor, ScalarValue};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use serde_json::Value as J;
use pom_engine::fxhash::{HashMap, HashSet};
use std::sync::Arc;

pub fn jval(v: &J) -> Value {
    match v {
        J::Null => Value::Nil,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(0.0)),
        J::String(s) => Value::Str(Arc::from(s.as_str())),
        J::Array(a) => Value::List(Arc::new(a.iter().map(jval).collect())),
        J::Object(o) => {
            if !o.is_empty() && o.keys().all(|k| k.parse::<i64>().is_ok()) {
                let mut items: Vec<(i64, &J)> = o.iter().map(|(k, v)| (k.parse().unwrap(), v)).collect();
                items.sort_by_key(|(k, _)| *k);
                Value::List(Arc::new(items.into_iter().map(|(_, v)| jval(v)).collect()))
            } else {
                Value::Map(Arc::new(o.iter().map(|(k, v)| (Sym::new(k), jval(v))).collect()))
            }
        }
    }
}

fn parse_tag(t: &J) -> Option<Tag> {
    let o = t.as_object()?;
    let kind = o.get("type")?.as_str()?;
    let fields: Vec<(Sym, Value)> = o.iter().filter(|(k, _)| k.as_str() != "type").map(|(k, v)| (Sym::new(k), jval(v))).collect();
    Some(Tag { kind: Sym::new(kind), fields })
}

pub fn parse_mod(m: &J) -> Option<Mod> {
    let o = m.as_object()?;
    let name = o.get("name")?.as_str()?;
    let ty = ModType::parse(o.get("type")?.as_str()?)?;
    let mut tag_items: Vec<(i64, &J)> = o.iter().filter_map(|(k, v)| k.parse::<i64>().ok().map(|i| (i, v))).collect();
    tag_items.sort_by_key(|(i, _)| *i);
    Some(Mod {
        name: Sym::new(name),
        ty,
        value: o.get("value").map(jval).unwrap_or(Value::Nil),
        flags: o.get("flags").and_then(|f| f.as_f64()).unwrap_or(0.0) as u64,
        keyword_flags: o.get("keywordFlags").and_then(|f| f.as_f64()).unwrap_or(0.0) as u64,
        source: o.get("source").and_then(|s| s.as_str()).map(Arc::from),
        tags: tag_items.into_iter().filter_map(|(_, t)| parse_tag(t)).collect(),
    })
}

fn rows(v: &J) -> Vec<Mod> {
    match v {
        J::Array(a) => a.iter().filter_map(parse_mod).collect(),
        J::Object(o) => {
            let mut items: Vec<(i64, &J)> = o.iter().filter_map(|(k, v)| k.parse::<i64>().ok().map(|i| (i, v))).collect();
            items.sort_by_key(|(i, _)| *i);
            items.into_iter().filter_map(|(_, m)| parse_mod(m)).collect()
        }
        _ => Vec::new(),
    }
}

fn bool_map(v: &J) -> HashMap<Sym, bool> {
    v.as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_bool().map(|b| (Sym::new(k), b))).collect()).unwrap_or_default()
}

fn num_map(v: &J) -> HashMap<Sym, f64> {
    v.as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_f64().map(|n| (Sym::new(k), n))).collect()).unwrap_or_default()
}

fn out_map(v: &J) -> HashMap<String, f64> {
    v.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| match v {
                    J::Number(n) => n.as_f64().map(|n| (k.clone(), n)),
                    J::Bool(b) => Some((k.clone(), if *b { 1.0 } else { 0.0 })),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone)]
pub struct RecordedSkillInput {
    pub skill_mods: Vec<Mod>,
    /// The skill's ModList chain, top level first (`skillModList` -> `baseSkillModList` -> ...).
    pub levels: Vec<Vec<Mod>>,
    pub skill_flags: HashSet<String>,
    pub skill_types: HashSet<i64>,
    pub skill_data: HashMap<String, ScalarValue>,
    pub skill_conditions: HashMap<String, bool>,
    pub skill_multipliers: HashMap<String, f64>,
    pub cfg_flags: u64,
    pub cfg_keyword_flags: u64,
    pub cfg_cond: HashMap<String, bool>,
    pub cfg_skill_part: Option<f64>,
    pub cfg_skill_dist: Option<f64>,
    pub weapon1: pom_offence::weapon::WeaponSource,
    pub weapon2: Option<pom_offence::weapon::WeaponSource>,
}

fn weapon_from(v: &J) -> Option<pom_offence::weapon::WeaponSource> {
    let o = v.as_object()?;
    if o.is_empty() {
        return None;
    }
    let mut m: HashMap<Arc<str>, ScalarValue> = HashMap::default();
    for (k, val) in o {
        match val {
            J::Number(n) => {
                m.insert(Arc::from(k.as_str()), ScalarValue::Num(n.as_f64().unwrap_or(0.0)));
            }
            J::String(s) => {
                m.insert(Arc::from(k.as_str()), ScalarValue::Str(Arc::from(s.as_str())));
            }
            J::Bool(b) => {
                m.insert(Arc::from(k.as_str()), ScalarValue::Bool(*b));
            }
            _ => {}
        }
    }
    let mut ws = pom_offence::weapon::WeaponSource::from_map(&m);
    Some(ws)
}

/// Loads the recorded state for `main_name` and applies it to `env`'s player/enemy stores and
/// output; returns the skill-level inputs for `compute_offence`.
pub fn apply(env: &mut crate::Env, main_name: &str) -> Option<RecordedSkillInput> {
    let dir = pom_engine::env::var("POM_OFFENCE_INPUT").ok()?;
    let name = pom_engine::env::var("POM_BUILD_NAME").ok()?;
    let text = std::fs::read_to_string(format!("{dir}/{name}.json")).ok()?;
    let recs: Vec<J> = serde_json::from_str(&text).ok()?;
    let rec = recs.iter().find(|r| r.get("skill").and_then(|s| s.as_str()) == Some(main_name)).or_else(|| recs.first())?;

    let output = out_map(&rec["output"]);
    // player
    let mut player = ModStore::new_db(None, None);
    for m in rows(&rec["player"]) {
        player.add_mod(m);
    }
    player.conditions = bool_map(&rec["cond"]);
    player.multipliers = num_map(&rec["mult"]);
    let old_actor = env.player.actor.clone().map(|a| (*a).clone()).unwrap_or_default();
    player.actor = Some(Arc::new(Actor { output: output.iter().map(|(k, v)| (Sym::new(k), *v)).collect(), ..old_actor }));
    env.player = player;
    // enemy
    let mut enemy = ModStore::new_db(None, None);
    for m in rows(&rec["enemy"]) {
        enemy.add_mod(m);
    }
    enemy.conditions = bool_map(&rec["econd"]);
    enemy.multipliers = num_map(&rec["emult"]);
    enemy.actor = Some(Arc::new(Actor { output: out_map(&rec["eoutput"]).iter().map(|(k, v)| (Sym::new(k), *v)).collect(), ..Default::default() }));
    env.enemy = enemy;
    env.output = output;

    let mut sd: HashMap<String, ScalarValue> = HashMap::default();
    if let Some(o) = rec["sdata"].as_object() {
        for (k, v) in o {
            match v {
                J::Number(n) => {
                    sd.insert(k.clone(), ScalarValue::Num(n.as_f64().unwrap_or(0.0)));
                }
                J::String(s) => {
                    sd.insert(k.clone(), ScalarValue::Str(Arc::from(s.as_str())));
                }
                J::Bool(b) => {
                    sd.insert(k.clone(), ScalarValue::Bool(*b));
                }
                _ => {}
            }
        }
    }
    let skill_flags: HashSet<String> = rec["sflags"].as_object().map(|o| o.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect()).unwrap_or_default();
    let skill_types: HashSet<i64> = rec["stypes"].as_object().map(|o| o.iter().filter(|(_, v)| v.as_bool() == Some(true)).filter_map(|(k, _)| k.parse().ok()).collect()).unwrap_or_default();
    let cfg_cond: HashMap<String, bool> = rec["cfg"]["cond"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b))).collect()).unwrap_or_default();
    Some(RecordedSkillInput {
        skill_mods: rows(&rec["own"]),
        levels: {
            let mut lv: Vec<(i64, &J)> = rec["levels"].as_object().map(|o| o.iter().filter_map(|(k, v)| k.parse::<i64>().ok().map(|i| (i, v))).collect()).unwrap_or_default();
            lv.sort_by_key(|(i, _)| *i);
            lv.into_iter().map(|(_, v)| rows(v)).collect()
        },
        skill_flags,
        skill_types,
        skill_data: sd,
        skill_conditions: rec["scond"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b))).collect()).unwrap_or_default(),
        skill_multipliers: rec["smult"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_f64().map(|n| (k.clone(), n))).collect()).unwrap_or_default(),
        cfg_flags: rec["cfg"]["flags"].as_f64().unwrap_or(0.0) as u64,
        cfg_keyword_flags: rec["cfg"]["kw"].as_f64().unwrap_or(0.0) as u64,
        cfg_cond,
        cfg_skill_part: rec["cfg"]["part"].as_f64(),
        cfg_skill_dist: rec["cfg"]["dist"].as_f64(),
        weapon1: weapon_from(&rec["w1"]).unwrap_or_default(),
        weapon2: weapon_from(&rec["w2"]),
    })
}
