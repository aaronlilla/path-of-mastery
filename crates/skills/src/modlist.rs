//! Port of `Modules/CalcActiveSkill.lua`'s `calcs.mergeSkillInstanceMods` (lines 53-79) and
//! `calcLib.buildSkillInstanceStats` (`Modules/CalcTools.lua`:192-251), plus the mod-list-assembly
//! half of `calcs.buildActiveSkillModList` (lines 491-628ish: GemLevel/GemQuality, the per-support
//! and per-active-gem `mergeSkillInstanceMods` calls, the `grantedEffectLevel` extra mods, and the
//! `skillData` fields those same lines set directly).
//!
//! The stat -> mod mapping table (`Data/SkillStatMap.lua`, 2374 lines of declarative Lua table
//! literals) is not transcribed here: `engine-data/data_skillStatMap.json` is the exported,
//! already-`ModFlag`/`KeywordFlag`-resolved form of `data.skillStatMap` (the *global* table every
//! `GrantedEffect.statMap` falls through to via its `__index` metatable when a skill's own literal
//! `statMap` doesn't define that stat - `Modules/Data.lua`:1030-1069). A skill *can* have real
//! literal `statMap` entries of its own (e.g. `BloodRage`'s `attack_speed_+%_granted_from_skill`) -
//! `data_skills.json`'s own `statMap` field just can't show them (`ser()`'s `getmetatable(v) and
//! depth>0` check treats any metatabled table as opaque `"<obj>"`, and every `GrantedEffect.statMap`
//! gets one at load time regardless of whether it started non-empty); `data_skillStatMapPerSkill.json`
//! dumps those literal entries directly, from
//! a probe that runs before the metatable's `__index` ever gets a chance to cache a global entry
//! into the same table. This file is a generic *interpreter* over both JSON tables (mirroring
//! `mergeLevelMod`'s substitution rules), not a per-stat-name port - the same shape principle
//! the answer-key readers (`parse_mod`/`parse_value`) already use for the
//! recorder's wire format, adapted to the different (`data_*.json`) raw-Lua-table-dump convention
//! (mixed array+hash keys on one JSON object, numeric string keys forming the array part) instead
//! of the recorder's own `{"__l":[...]}`/`{"__m":{...}}` markers.
//!
//! **Confirmed absent from current game data (not implemented, would be silently wrong if
//! guessed)**: grouped `modOrGroup` stat-map entries (an array entry with no `.name`, requiring a
//! second `ipairs` level) - `grep`-equivalent full scan of `data_skillStatMap.json` found zero
//! (every entry's array part holds only leaf mods with `.name` directly).
use crate::data::engine_data_dir;
use pom_engine::data::gems::GrantedEffect;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modparser::flags::mod_flag;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::value::Value as EValue;
use pom_engine::cjson::{J, JObj};
use pom_engine::fxhash::HashMap;
use std::sync::{Arc, OnceLock};

fn stat_map_table() -> J {
    static DOC: OnceLock<J> = OnceLock::new();
    *DOC.get_or_init(|| pom_engine::cjson::doc(&engine_data_dir().join("data_skillStatMap.json")).unwrap_or_else(|e| panic!("{e}")))
}

/// Per-skill *literal* `statMap` overrides (`Data/Skills/<type>.lua`'s own `statMap = {...}`
/// table literal on a specific `GrantedEffect`, e.g. `BloodRage`'s `attack_speed_+%_granted_
/// from_skill` entry) - `Modules/Data.lua`:1067's `setmetatable(grantedEffect.statMap,
/// data.skillStatMapMeta)` falls through to the *global* `stat_map_table()` only for a stat name
/// this per-skill table doesn't itself define (`grantedEffect.statMap[stat]`, a real Lua
/// `__index` metatable lookup - checked directly against the source, not guessed). Generated from the Lua data
/// (`engine-data/data_skillStatMap.json`
/// itself can't carry this - the exported `data_skills.json`
/// shows `"<obj>"` for every skill's `statMap` field despite ~721 skills having a real one).
fn per_skill_stat_map_table() -> J {
    static DOC: OnceLock<J> = OnceLock::new();
    *DOC.get_or_init(|| pom_engine::cjson::doc(&engine_data_dir().join("data_skillStatMapPerSkill.json")).unwrap_or_else(|e| panic!("{e}")))
}

/// `Modules/Data.lua`:1069-1080 bakes a matching `notMinionStat` `ActorCondition` tag directly
/// into a *per-skill literal* `statMap` entry's mod template, once, at skill-load time (before any
/// build ever runs) - the per-skill dump is taken *after*
/// that loop, so `data_skillStatMapPerSkill.json`'s entries already carry it when applicable. A
/// *global*-table entry (`data_skillStatMap.json`, `data.skillStatMap` itself) never gets this
/// treatment at its own definition (it has no specific `GrantedEffect` to bake a tag for) - the
/// tag is added dynamically, per resolving skill, only via the `__index` metatable's own
/// `processMod` call (`Modules/Data.lua`:1038-1041) - which `merge_skill_instance_mods` reproduces
/// itself, below. Applying that injection to a per-skill entry too would double the tag - the real
/// bug this distinction exists to avoid (confirmed via `SupportInspiration`'s `CritChance`/
/// `ElementalDamage`/`ManaCost` mods, each of which already carries its own literal
/// `ActorCondition` tag).
pub fn stat_map_lookup(ge_id: &str, stat: &str) -> Option<(J, bool)> {
    if let Some(per_skill) = per_skill_stat_map_table().get(ge_id) {
        if let Some(v) = per_skill.get(stat) {
            return Some((v, false));
        }
    }
    stat_map_table().get(stat).map(|v| (v, true))
}

/// `data_skills.json` re-parsed as raw JSON (not the typed `GrantedEffect`) so `levels[N]` can be
/// looked up by its *real* level number, the way Lua's own hash-keyed `t[N]` indexing does. The
/// typed `GrantedEffect.levels: Vec<GemLevel>` (`pom_engine::data::flex::de_flex_vec`)
/// *compacts* a sparse `levels` table (e.g. an item/tree-granted skill fixed at `levels = {[20] =
/// {...}}`, no levels 1-19 at all) down to a length-1 `Vec`, losing which real level number `20`
/// that lone entry belongs to - `ge.levels[(level_num - 1) as usize]` then silently misses it
/// entirely (`level_num=20` needs index 19, out of bounds on a length-1 Vec). Confirmed the hard
/// way (`DeathWalk`, a single-level-20 skill, was missing its `PvpDamageMultiplier` mod this way).
/// Every *dense* 1..N level table (ordinary player-chosen gem levels) still resolves correctly
/// either way, so this only matters for a fixed-level skill - but that's common enough among
/// item/tree/support-granted skills to fix properly rather than special-case.
fn raw_skills_json() -> J {
    crate::data::skills_doc()
}

/// `grantedEffect.levels[level_num]` - an exact hash lookup by the real (possibly non-contiguous)
/// level number, same as Lua's own `t[N]` indexing (see `raw_skills_json`'s doc comment). Returns
/// `None` when that exact level isn't defined (this crate doesn't model `calcLib.validateGemLevel`'s
/// clamp-to-nearest fallback - not exercised by `buildActiveSkillModList`'s own non-disabled path,
/// which indexes `activeGrantedEffect.levels[activeEffect.level]` directly with no clamping call in
/// between).
fn raw_level_map(ge_id: &str, level_num: f64) -> Option<JObj> {
    let ge = raw_skills_json().get(ge_id)?;
    let levels = ge.get("levels")?;
    let n = level_num.round() as i64;
    // A *dense* 1..N `levels` table (the common case - ordinary player-chosen gem levels)
    // exports as a plain JSON array, positionally 0-indexed (array[0] = level 1).
    if let Some(a) = levels.as_array() {
        return a.get((n - 1).max(0) as usize).and_then(|v| v.as_object());
    }
    // A *sparse* table (e.g. an item/tree-granted skill fixed at one level, `levels = {[20] =
    // {...}}`) exports as a JSON object keyed by the real level number string - see this
    // function's doc comment.
    levels.as_object()?.get(&n.to_string()).and_then(|v| v.as_object())
}

/// A numeric field of `activeGrantedEffect.levels[level]` by the real level number (dense array or sparse table).
pub fn raw_level_field(ge_id: &str, level_num: f64, key: &str) -> Option<f64> {
    raw_level_map(ge_id, level_num).and_then(|m| m.get(key)).and_then(jf64)
}

/// `calcLib.validateGemLevel` (CalcTools.lua:42-58) on a granted effect's level table: a level with no
/// entry is clamped to `[1, #levels]` (`#` = the contiguous 1..N border), else any level of the table.
pub fn validate_gem_level(ge_id: &str, level: f64) -> f64 {
    validate_gem_level_nat(ge_id, level, None)
}

/// `validateGemLevel` with `gemInstance.gemData.naturalMaxLevel` (`None` for a bare granted effect).
pub fn validate_gem_level_nat(ge_id: &str, level: f64, natural_max: Option<f64>) -> f64 {
    let Some(levels) = raw_skills_json().get(ge_id).and_then(|g| g.get("levels")) else { return level };
    let keys: Vec<i64> = match (levels.as_array(), levels.as_object()) {
        (Some(a), _) => (1..=a.len() as i64).collect(),
        (_, Some(o)) => o.keys().filter_map(|k| k.parse().ok()).collect(),
        _ => return level,
    };
    let has = |x: f64| x.fract() == 0.0 && keys.contains(&(x as i64));
    let mut l = level;
    if !has(l) {
        l = l.max(1.0);
        let mut border = 0i64;
        while keys.contains(&(border + 1)) {
            border += 1;
        }
        if border > 0 {
            l = l.min(border as f64);
        }
    }
    if !has(l) {
        if let Some(n) = natural_max {
            l = n;
        }
    }
    if !has(l) {
        if let Some(k) = keys.iter().min() {
            l = *k as f64;
        }
    }
    l
}

fn game_constant(name: &str) -> f64 {
    static T: OnceLock<HashMap<String, f64>> = OnceLock::new();
    let table = T.get_or_init(|| {
        let path = engine_data_dir().join("data_gameConstants.json");
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
        serde_json::from_slice(&bytes).unwrap_or_default()
    });
    table.get(name).copied().unwrap_or(0.0)
}

/// A raw `data_*.json`-dumped Lua table mixes an array part (numeric string keys "1","2",...) and
/// a hash part (named keys) on one JSON object; a *pure* array table serializes as a plain JSON
/// array instead. This returns the array part in index order regardless of which JSON shape it
/// came as.
fn array_part(v: J) -> Vec<J> {
    if let Some(a) = v.as_array() {
        return a.iter().collect();
    }
    let Some(o) = v.as_object() else { return Vec::new() };
    let mut entries: Vec<(i64, J)> = o.iter().filter_map(|(k, val)| k.parse::<i64>().ok().map(|n| (n, val))).collect();
    entries.sort_by_key(|(n, _)| *n);
    entries.into_iter().map(|(_, val)| val).collect()
}

fn jf64(v: J) -> Option<f64> {
    v.as_f64()
}

/// Recursively converts a raw JSON node into the engine's dynamic `Value` (used for a mod's own
/// `.value` field, e.g. `SkillData`'s `{key=..., value=...}`). A nested object's array part (if
/// any) is dropped - not exercised by any `.value` table in the current `statMap`/`baseMods` data
/// (checked: every such table is pure hash, `{key=,value=,merge=}`-shaped or a nested `{mod=...}`
/// mod literal, itself handled by `raw_to_mod_value` before recursing here).
fn raw_to_value(v: J) -> EValue {
    if v.is_null() {
        return EValue::Nil;
    }
    if let Some(b) = v.as_bool() {
        return EValue::Bool(b);
    }
    if v.is_number() {
        return EValue::Num(v.as_f64().unwrap_or(0.0));
    }
    if let Some(s) = v.as_str() {
        return EValue::Str(Arc::from(s));
    }
    if let Some(a) = v.as_array() {
        return EValue::List(Arc::new(a.iter().map(raw_to_value).collect()));
    }
    let o = v.as_object().unwrap();
    if !o.is_empty() && o.keys().all(|k| k.parse::<i64>().is_ok()) {
        // A Lua array exported as `{"1": .., "2": ..}` (tag fields such as `varList`,
        // `skillTypeList`, `slotNameList`): the engine's tag evaluation walks `Value::List`.
        let mut items: Vec<(i64, J)> = o.iter().map(|(k, v)| (k.parse::<i64>().unwrap(), v)).collect();
        items.sort_by_key(|(k, _)| *k);
        return EValue::List(Arc::new(items.into_iter().map(|(_, v)| raw_to_value(v)).collect()));
    }
    let map: Vec<(Sym, EValue)> = o.iter().filter(|(k, _)| k.parse::<i64>().is_err()).map(|(k, v)| (Sym::new(k), raw_to_value(v))).collect();
    EValue::Map(Arc::new(map))
}

fn raw_to_tag(v: J) -> Option<Tag> {
    let o = v.as_object()?;
    let kind = Sym::new(o.get("type").and_then(|x| x.as_str()).unwrap_or(""));
    let fields: Vec<(Sym, EValue)> = o.iter().filter(|(k, _)| *k != "type").map(|(k, v)| (Sym::new(k), raw_to_value(v))).collect();
    Some(Tag { kind, fields })
}

/// Builds a `Mod` from a raw template object (a `statMap` leaf entry or a `baseMods` entry),
/// substituting `computed_value` per `mergeLevelMod` (`CalcActiveSkill.lua`:22-50) when given.
/// `computed_value = None` means "use the template's own `.value` as-is" (the `baseMods` case,
/// `modList:AddList` - no substitution at all).
fn build_mod(template: J, computed_value: Option<f64>, default_source: &Arc<str>) -> Mod {
    let obj = template.as_object();
    let name = Sym::new(obj.and_then(|o| o.get("name")).and_then(|x| x.as_str()).unwrap_or(""));
    let ty = ModType::parse(obj.and_then(|o| o.get("type")).and_then(|x| x.as_str()).unwrap_or("BASE")).unwrap_or(ModType::Base);
    let flags = obj.and_then(|o| o.get("flags")).and_then(jf64).unwrap_or(0.0) as u64;
    let keyword_flags = obj.and_then(|o| o.get("keywordFlags")).and_then(jf64).unwrap_or(0.0) as u64;
    let source = obj.and_then(|o| o.get("source")).and_then(|x| x.as_str()).map(Arc::from).unwrap_or_else(|| default_source.clone());
    let tags: Vec<Tag> = array_part(template).into_iter().filter_map(raw_to_tag).collect();

    let template_value = obj.and_then(|o| o.get("value"));
    let value = match (template_value, computed_value) {
        (_, None) => template_value.map(raw_to_value).unwrap_or(EValue::Nil),
        (Some(vo), Some(cv)) if vo.is_object() => {
            let vo = vo.as_object().unwrap();
            // `newMod.value.mod` case (e.g. `minion_always_crit`'s `{mod = {name="CritChance",
            // type="OVERRIDE", ...}}`): the numeric substitution lands on the *nested* mod's own
            // `.value`, not the outer table.
            if let Some(inner_mod) = vo.get("mod").and_then(|m| m.as_object()) {
                let mut inner: Vec<(Sym, EValue)> = inner_mod.iter().map(|(k, v)| (Sym::new(k), raw_to_value(v))).collect();
                inner.push((pom_engine::sym!("value"), EValue::Num(cv)));
                let mut outer: Vec<(Sym, EValue)> = vo.iter().filter(|(k, _)| *k != "mod" && k.parse::<i64>().is_err()).map(|(k, v)| (Sym::new(k), raw_to_value(v))).collect();
                outer.push((pom_engine::sym!("mod"), EValue::Map(Arc::new(inner))));
                EValue::Map(Arc::new(outer))
            } else {
                let mut m: Vec<(Sym, EValue)> = vo.iter().filter(|(k, _)| *k != "value" && k.parse::<i64>().is_err()).map(|(k, v)| (Sym::new(k), raw_to_value(v))).collect();
                m.push((pom_engine::sym!("value"), EValue::Num(cv)));
                EValue::Map(Arc::new(m))
            }
        }
        (_, Some(cv)) => EValue::Num(cv),
    };
    Mod { name, ty, value, flags, keyword_flags, source: Some(source), tags: (tags).into() }
}

/// `stats[name] = (stats[name] or 0) + value` on a table kept in insertion order: the answer key's `pairs(stats)` visits string
/// keys in the order they were first set, and the order of a skill's mods (the Calcs tab's buff popups list them) follows it.
fn stat_add(stats: &mut Vec<(String, f64)>, name: &str, value: f64) {
    if let Some(e) = stats.iter_mut().find(|(n, _)| n == name) {
        e.1 += value;
    } else {
        stats.push((name.to_string(), value));
    }
}

/// `calcLib.buildSkillInstanceStats` (`Modules/CalcTools.lua`:192-251). `level_num` is the gem's
/// 1-based level (`skillInstance.level`); `actor_level` is `skillInstance.actorLevel or
/// level.levelRequirement or 1` - callers pass the already-resolved value (this crate's player-only
/// scope never has a minion actor, so `actorLevel` is always `None` in practice - see call sites).
pub fn build_skill_instance_stats(ge: &GrantedEffect, level_num: f64, quality: f64, actor_level: Option<f64>) -> Vec<(String, f64)> {
    let mut stats: Vec<(String, f64)> = Vec::new();
    if quality > 0.0 {
        for qs in &ge.quality_stats {
            if let Some(arr) = qs.as_array() {
                if let (Some(name), Some(mult)) = (arr.first().and_then(|v| v.as_str()), arr.get(1).and_then(|v| v.as_f64())) {
                    stat_add(&mut stats, name, (mult * quality).trunc());
                }
            }
        }
    }
    let level_idx = level_num.round() as i64;
    let ge_id = ge.id.as_deref().unwrap_or("");
    let level_data = raw_level_map(ge_id, level_num);
    let level_requirement = level_data.and_then(|l| l.get("levelRequirement")).and_then(jf64);
    let actor_level = actor_level.or(level_requirement).unwrap_or(1.0);
    let stat_interp: Vec<f64> = level_data.and_then(|l| l.get("statInterpolation")).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(jf64).collect()).unwrap_or_default();

    let mut available_effectiveness: Option<f64> = None;
    for (i, name) in ge.stats.iter().enumerate() {
        let idx = i + 1;
        let mut stat_value = level_data.and_then(|l| l.get(&idx.to_string())).and_then(jf64).unwrap_or(1.0);
        if let Some(l) = level_data {
            if let Some(&interp) = stat_interp.get(i) {
                if interp == 3.0 {
                    let eff = *available_effectiveness.get_or_insert_with(|| {
                        (game_constant("SkillDamageBaseEffectiveness") + game_constant("SkillDamageIncrementalEffectiveness") * (actor_level - 1.0))
                            * ge.base_effectiveness.unwrap_or(1.0)
                            * (1.0 + ge.incremental_effectiveness.unwrap_or(0.0)).powf(actor_level - 1.0)
                    });
                    let raw = l.get(&idx.to_string()).and_then(jf64).unwrap_or(0.0);
                    stat_value = (eff * raw + 0.5).floor();
                } else if interp == 2.0 {
                    // Linear interpolation across ordered levels (`Modules/CalcTools.lua`:215-241).
                    // This crate's `GrantedEffect.levels` is a *compacted* Vec (gaps in the
                    // original's sparse `levels[N]` table are dropped by `de_flex_vec`, see
                    // `pom_engine::data::flex`), so "ordered levels" here means this
                    // Vec's own 1-based index, not necessarily upstream's real level numbers -
                    // an approximation shared with `data::stat_value`, not new to this file.
                    let n = ge.levels.len();
                    let cur = level_idx.clamp(1, n.max(1) as i64) as usize;
                    if n > 1 {
                        let next = (cur + 1).min(n);
                        let next_req = ge.levels[next - 1].level_requirement.unwrap_or(0.0);
                        let prev_req = ge.levels[next - 2].level_requirement.unwrap_or(0.0);
                        let next_stat = ge.levels[next - 1].values.get(&idx.to_string()).and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let prev_stat = ge.levels[next - 2].values.get(&idx.to_string()).and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let denom = next_req - prev_req;
                        let frac = if denom != 0.0 { (actor_level - prev_req) / denom } else { 0.0 };
                        stat_value = (prev_stat + (next_stat - prev_stat) * frac + 0.5).floor();
                    } else {
                        stat_value = ge.levels[cur - 1].values.get(&idx.to_string()).and_then(|v| v.as_f64()).unwrap_or(0.0).round();
                    }
                }
            }
        }
        stat_add(&mut stats, name, stat_value);
    }
    if let Some(cs) = ge.extra.get("constantStats").and_then(|v| v.as_array()) {
        for c in cs {
            if let Some(arr) = c.as_array() {
                if let Some(name) = arr.first().and_then(|v| v.as_str()) {
                    let val = arr.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
                    stat_add(&mut stats, name, val);
                }
            }
        }
    }
    stats
}

/// (skill, stat) pairs whose game text is "more/less Damage with Hits and Ailments".
fn is_hit_and_ailment_more(ge_id: &str, stat: &str) -> bool {
    match stat {
        "active_skill_hit_ailment_damage_with_projectile_+%_final" => matches!(ge_id, "FrostBlades" | "LightningStrike" | "LightningStrikeAltX" | "MoltenStrike" | "MoltenStrikeAltX" | "VaalMoltenStrike" | "VolcanicFissure"),
        "molten_strike_every_5th_attack_projectiles_damage_+%_final" => ge_id == "MoltenStrikeAltX",
        "hit_and_ailment_damage_+%_final_per_gathering_lightning" => ge_id == "StaticStrikeAltX",
        "flamethrower_trap_damage_+%_final_vs_burning_enemies" => ge_id == "FlamethrowerTrap",
        _ => false,
    }
}

/// `grantedEffect.notMinionStat` (`Modules/Data.lua`:68-92's `processMod`, the `notMinionStat`
/// branch): stat names for which every produced mod gets an extra `{type="ActorCondition",
/// actor="parent", neg=true}` tag, gated on the granted effect being a support or a Buff-type skill.
fn not_minion_stat_names(ge: &GrantedEffect) -> Option<pom_engine::cjson::JArr> {
    ge.extra.get("notMinionStat").and_then(|v| v.as_array())
}

/// `calcs.mergeSkillInstanceMods` (`Modules/CalcActiveSkill.lua`:53-79). `extra_stats` is
/// `activeSkill.skillCfg`'s `ExtraSkillStat` list (only ever non-empty for the active gem's own
/// call, `CalcActiveSkill.lua`:578 - see `build_active_skill_mod_list`).
/// `processMod` (Modules/Data.lua:68-72): `mod.value.mod.source = "Skill:"..grantedEffect.id`.
fn set_inner_source(m: &mut Mod, ge_id: &str) {
    let EValue::Map(outer) = &m.value else { return };
    let Some((_, EValue::Map(inner))) = outer.iter().find(|(k, _)| k.as_str() == "mod") else { return };
    let mut inner_v: Vec<(Sym, EValue)> = inner.iter().filter(|(k, _)| k.as_str() != "source").cloned().collect();
    inner_v.push((pom_engine::sym!("source"), EValue::Str(Arc::from(format!("Skill:{ge_id}").as_str()))));
    let outer_v: Vec<(Sym, EValue)> = outer.iter().map(|(k, v)| if k.as_str() == "mod" { (*k, EValue::Map(Arc::new(inner_v.clone()))) } else { (*k, v.clone()) }).collect();
    m.value = EValue::Map(Arc::new(outer_v));
}

pub fn merge_skill_instance_mods(ge: &GrantedEffect, level_num: f64, quality: f64, actor_level: Option<f64>, extra_stats: &[(String, f64)], is_support_or_buff: bool) -> Vec<Mod> {
    // A pure function of the granted effect (static game data) and these arguments, asked again for every gem on
    // every recalculation: kept per thread, up to 20,000 results.
    type Key = (usize, u64, u64, Option<u64>, Vec<(String, u64)>, bool);
    thread_local! {
        static MEMO: std::cell::RefCell<HashMap<Key, std::rc::Rc<Vec<Mod>>>> = std::cell::RefCell::new(HashMap::default());
    }
    let key: Key = (ge as *const GrantedEffect as usize, level_num.to_bits(), quality.to_bits(), actor_level.map(|a| a.to_bits()), extra_stats.iter().map(|(k, v)| (k.clone(), v.to_bits())).collect(), is_support_or_buff);
    if let Some(v) = MEMO.with(|m| m.borrow().get(&key).cloned()) {
        return (*v).clone();
    }
    let out = merge_skill_instance_mods_live(ge, level_num, quality, actor_level, extra_stats, is_support_or_buff);
    MEMO.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= 20_000 {
            m.clear();
        }
        m.insert(key, std::rc::Rc::new(out.clone()));
    });
    out
}

fn merge_skill_instance_mods_live(ge: &GrantedEffect, level_num: f64, quality: f64, actor_level: Option<f64>, extra_stats: &[(String, f64)], is_support_or_buff: bool) -> Vec<Mod> {
    let mut stats = build_skill_instance_stats(ge, level_num, quality, actor_level);
    for (k, v) in extra_stats {
        stat_add(&mut stats, k, *v);
    }
    let default_source: Arc<str> = Arc::from(ge.extra.get("modSource").and_then(|v| v.as_str()).unwrap_or(""));
    let not_minion: Vec<&str> = not_minion_stat_names(ge).map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
    let ge_id = ge.id.as_deref().unwrap_or("");
    let mut out = Vec::new();
    for (stat, stat_value) in &stats {
        if pom_engine::env::var("POM_DEBUG_STATS").is_ok() { eprintln!("STAT {ge_id} {stat} = {stat_value} found={}", stat_map_lookup(ge_id, stat).is_some()); }
        let Some((map, from_global)) = stat_map_lookup(ge_id, stat) else { continue };
        let map_obj = map.as_object();
        let map_value = map_obj.and_then(|o| o.get("value")).filter(|v| !v.is_null() && v.as_bool() != Some(false));
        let map_mult = map_obj.and_then(|o| o.get("mult")).and_then(jf64).unwrap_or(1.0);
        let map_div = map_obj.and_then(|o| o.get("div")).and_then(jf64).unwrap_or(1.0);
        let map_base = map_obj.and_then(|o| o.get("base")).and_then(jf64).unwrap_or(0.0);
        let computed = map_value.and_then(jf64).unwrap_or_else(|| stat_value * map_mult / map_div + map_base);
        for mod_template in array_part(map) {
            // `modOrGroup` (CalcActiveSkill.lua:64-71): a plain mod uses the map's own value/mult/div/base; a
            // group `{ mod, mod, div = 60 }` (e.g. Rejuvenation Totem's life/mana regen) carries its own.
            let mut pairs: Vec<(J, f64)> = Vec::new();
            if mod_template.get("name").is_some() {
                pairs.push((mod_template, computed));
            } else if let Some(gobj) = mod_template.as_object() {
                let g_value = gobj.get("value").filter(|v| !v.is_null() && v.as_bool() != Some(false));
                let g_mult = gobj.get("mult").and_then(jf64).unwrap_or(1.0);
                let g_div = gobj.get("div").and_then(jf64).unwrap_or(1.0);
                let g_base = gobj.get("base").and_then(jf64).unwrap_or(0.0);
                let g_computed = g_value.and_then(jf64).unwrap_or_else(|| stat_value * g_mult / g_div + g_base);
                for sub in array_part(mod_template) {
                    pairs.push((sub, g_computed));
                }
            }
            for (tpl, value) in pairs {
                if tpl.get("name").is_none() {
                    continue;
                }
                let mut m = build_mod(tpl, Some(value), &default_source);
                set_inner_source(&mut m, ge_id);
                // "more Damage with Hits and Ailments" (game text) is Hit|Ailment (KeywordFlag 262144|524288, as Incinerate's
                // stat map has it); upstream's bit.band(Hit, Ailment) leaves 0, so the mod also scaled Decay.
                // The fixes in this file run unless POM_STRICT_COMPAT=1 (upstream behaviour); the switch is read inline
                // because this crate does not depend on `pom_offence`, where `pom_fixes_on` lives.
                if m.name.as_str() == "Damage" && is_hit_and_ailment_more(ge_id, stat) && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
                    m.keyword_flags = 786432;
                }
                if from_global && is_support_or_buff && not_minion.contains(&stat.as_str()) {
                    m.tags.push(Tag { kind: pom_engine::sym!("ActorCondition"), fields: vec![(pom_engine::sym!("actor"), EValue::Str(Arc::from("parent"))), (pom_engine::sym!("neg"), EValue::Bool(true))] });
                }
                out.push(m);
            }
        }
    }
    if let Some(base_mods) = ge.extra.get("baseMods").and_then(|v| v.as_array()) {
        for bm in base_mods {
            let mut m = build_mod(bm, None, &default_source);
            set_inner_source(&mut m, ge_id);
            // Reave's base maximum stages is 4 (display_reave_base_maximum_stacks, "4 Maximum Stages"); upstream's baseMod says 8.
            // Only this baseMod, not the quality statMap mod of the same name.
            let reave = (ge_id == "Reave" && m.name.as_str() == "Multiplier:ReaveMaxStages") || (ge_id == "ReaveAltX" && m.name.as_str() == "Multiplier:ReaveofRefractionMaxStages");
            if reave && matches!(m.value, EValue::Num(v) if v == 8.0) && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
                m.value = EValue::Num(4.0);
            }
            // These hand-written baseMod radii (added last, CalcActiveSkill.lua:78) override the game-data stat and are stale.
            // Squalls and Holy Sweep: drop it so active_skill_base_area_of_effect_radius (38; 24..28, 28 at level 20) sets the radius.
            // Voltaxic Burst: base radius is 2.6 m since 3.27.0 (was 2.2), so 26.
            if matches!(ge_id, "OrbOfStormsAltX" | "Sweep" | "VoltaxicBurst") && m.name.as_str() == "SkillData" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
                let radius_val = match &m.value {
                    EValue::Map(kv) if kv.iter().any(|(k, v)| k.as_str() == "key" && matches!(v, EValue::Str(s) if &**s == "radius")) => kv.iter().position(|(k, _)| k.as_str() == "value"),
                    _ => None,
                };
                if let (Some(i), EValue::Map(kv)) = (radius_val, &mut m.value) {
                    if ge_id != "VoltaxicBurst" {
                        continue;
                    }
                    Arc::make_mut(kv)[i].1 = EValue::Num(26.0);
                }
            }
            out.push(m);
        }
    }
    // Vaal Firestorm "Impacts have 20% more Area of Effect" and Firestorm "First Impact has 100% more Area of Effect" (part 1) are
    // impact-radius mods; upstream maps them to AreaOfEffectSecondary / AreaOfEffect, which feed the fall-area radius. Rename to AreaOfEffectPrimary.
    if matches!(ge_id, "VaalFirestorm" | "Firestorm") && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut().filter(|m| m.ty == ModType::More) {
            let hit = if ge_id == "VaalFirestorm" { m.name.as_str() == "AreaOfEffectSecondary" } else { m.name.as_str() == "AreaOfEffect" && m.tags.iter().any(|t| t.kind.as_str() == "SkillPart") };
            if hit {
                m.name = Sym::new("AreaOfEffectPrimary");
            }
        }
    }
    // Ensnaring Arrow quality skill_buff_effect_+% is "increased Debuff Effect" (debuff_skill_stat_descriptions); upstream maps it to
    // BuffEffect, which the Ensnare debuff ignores (it scales by DebuffEffect only). Same type and value, only the name.
    if ge_id == "EnsnaringArrow" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut().filter(|m| m.name.as_str() == "BuffEffect") {
            m.name = Sym::new("DebuffEffect");
        }
    }
    // Vampiric Link's "+X% to Maximum total Life Recovery per second from Leech" adds points to the 20 base cap like the base stat
    // (CalcSetup BASE); upstream's statMap makes it INC (20 x 1.058). Same value, type Base.
    if ge_id == "VampiricLink" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut().filter(|m| m.name.as_str() == "MaxLifeLeechRate" && m.ty == ModType::Inc) {
            m.ty = ModType::Base;
        }
    }
    // Vaal Reave's data (baseMod, statMap) writes Multiplier:ReaveMaxStages and reads var ReaveStage, but CalcActiveSkill builds the
    // names from the gem name (VaalReave), so it got no stage limit and no area-per-stage. Rename to the Vaal names. Stage count stays the max.
    if ge_id == "VaalReave" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut() {
            if m.name.as_str() == "Multiplier:ReaveMaxStages" {
                m.name = Sym::new("Multiplier:VaalReaveMaxStages");
            }
            if m.name.as_str() == "AreaOfEffect" && m.ty == ModType::More {
                let tags: Vec<Tag> = m.tags.iter().map(|t| {
                    let stage = t.kind.as_str() == "Multiplier" && matches!(t.get(pom_engine::sym!("var")), EValue::Str(s) if &**s == "ReaveStage");
                    if !stage { return t.clone(); }
                    Tag { kind: t.kind, fields: t.fields.iter().map(|(k, v)| if k.as_str() == "var" { (*k, EValue::Str(Arc::from("VaalReaveStage"))) } else { (*k, v.clone()) }).collect() }
                }).collect();
                m.tags = tags.into();
            }
        }
    }
    // Lightning Tendrils releases a Stronger Pulse every 3rd pulse (lightning_tendrils_channelled_larger_pulse_interval),
    // so Normal (part 2) is -100/3 and Stronger (part 3) is -200/3; upstream's baseMods have the two values swapped.
    if ge_id == "LightningTendrils" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut().filter(|m| m.name.as_str() == "DPS" && m.ty == ModType::More) {
            let part = m.tags.iter().find(|t| t.kind.as_str() == "SkillPart").map(|t| t.get(pom_engine::sym!("skillPart")).clone());
            match part {
                Some(EValue::Num(p)) if p == 2.0 => m.value = EValue::Num(-100.0 / 3.0),
                Some(EValue::Num(p)) if p == 3.0 => m.value = EValue::Num(-200.0 / 3.0),
                _ => {}
            }
        }
    }
    // lightning_tendrils_channelled_larger_pulse_always_crit is stat index 6 but each level row has 3 values, so its value
    // defaults to 1 and the statMap CritChance OVERRIDE (base 100) becomes 101; crit.rs only treats == 100 as a guaranteed crit (no Bifurcate).
    if (ge_id == "LightningTendrils" || ge_id == "LightningTendrilsAltX") && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut().filter(|m| m.name.as_str() == "CritChance" && m.ty == ModType::Override) {
            if matches!(m.value, EValue::Num(v) if v == 101.0) {
                m.value = EValue::Num(100.0);
            }
        }
    }
    // Vaal Double Strike has base_skill_number_of_additional_hits = 1 like Double Strike (dpsMultiplier 2), but no baseMods entry.
    if ge_id == "VaalDoubleStrike" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        let value = EValue::Map(Arc::new(vec![(pom_engine::sym!("key"), EValue::Str(Arc::from("dpsMultiplier"))), (pom_engine::sym!("value"), EValue::Num(2.0))]));
        out.push(Mod { name: Sym::new("SkillData"), ty: ModType::List, value, flags: 0, keyword_flags: 0, source: Some(Arc::from("Skill:VaalDoubleStrike")), tags: Vec::new().into() });
    }
    // "Chance for Trap to Trigger an additional time" (trap_%_chance_to_trigger_twice) has no upstream stat map entry or consumer.
    if !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for (_, v) in stats.iter().filter(|(k, _)| k == "trap_%_chance_to_trigger_twice") {
            out.push(Mod { name: Sym::new("TrapTriggerTwiceChance"), ty: ModType::Base, value: EValue::Num(*v), flags: 0, keyword_flags: 0, source: Some(Arc::from(format!("Skill:{ge_id}"))), tags: Vec::new().into() });
        }
    }
    // Boneshatter of Complex Trauma "more Damage per Trauma, up to 200%" caps the total; upstream caps only the stack count.
    // The stack limit becomes min(lose_all_trauma_at_X_trauma, 200 / per-trauma) so the total stays at or under 200.
    if ge_id == "BoneshatterAltX" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        let max_stacks = stats.iter().find(|(k, _)| k == "lose_all_trauma_at_X_trauma").map(|(_, v)| *v);
        for m in out.iter_mut().filter(|m| m.name.as_str() == "Damage" && m.ty == ModType::More) {
            let (EValue::Num(per), Some(max_stacks)) = (&m.value, max_stacks) else { continue };
            if *per <= 0.0 { continue; }
            let limit = max_stacks.min(200.0 / per);
            let tags: Vec<Tag> = m.tags.iter().map(|t| {
                let trauma = t.kind.as_str() == "Multiplier" && matches!(t.get(pom_engine::sym!("limitVar")), EValue::Str(s) if &**s == "TraumaStacksMax");
                if !trauma { return t.clone(); }
                Tag { kind: t.kind, fields: t.fields.iter().filter(|(k, _)| k.as_str() != "limitVar").cloned().chain([(pom_engine::sym!("limit"), EValue::Num(limit))]).collect() }
            }).collect();
            m.tags = tags.into();
        }
    }
    // Storm Call of Trarthus' boiling blood pool DoT stops when you leave it, which GGG counts as Area damage (is_area_damage); upstream strips Area without dotIsArea.
    if ge_id == "StormCallAltX" && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        let value = EValue::Map(Arc::new(vec![(pom_engine::sym!("key"), EValue::Str(Arc::from("dotIsArea"))), (pom_engine::sym!("value"), EValue::Bool(true))]));
        out.push(Mod { name: Sym::new("SkillData"), ty: ModType::List, value, flags: 0, keyword_flags: 0, source: Some(Arc::from("Skill:StormCallAltX")), tags: Vec::new().into() });
    }
    // Spectral Shield Throw and Shattering throw "a projectile which cannot pierce" (part 1 'Shield'); upstream has no CannotPierce, so
    // external pierce made the shield pierce. Shards (part 2) and Shield Trarthus (AltY, its primary pierces) are untouched. GGG fixed it in 3.28.0.
    if matches!(ge_id, "SpectralShieldThrow" | "SpectralShieldThrowAltX") && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        let tag = Tag { kind: pom_engine::sym!("SkillPart"), fields: vec![(pom_engine::sym!("skillPart"), EValue::Num(1.0))] };
        out.push(Mod { name: Sym::new("CannotPierce"), ty: ModType::Flag, value: EValue::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(format!("Skill:{ge_id}"))), tags: vec![tag].into() });
    }
    // Hexblast's "if Enemy is Hexed" MORE mods (game text "if Enemy is Hexed") need a Hex; upstream gates them
    // on Cursed, which a Mark also sets.
    if ge_id.starts_with("Hexblast") && !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        for m in out.iter_mut().filter(|m| m.name.as_str() == "Damage") {
            let tags: Vec<Tag> = m.tags.iter().map(|t| {
                let cursed = t.kind.as_str() == "ActorCondition" && matches!(t.get(pom_engine::sym!("var")), EValue::Str(s) if &**s == "Cursed");
                if !cursed { return t.clone(); }
                Tag { kind: t.kind, fields: t.fields.iter().map(|(k, v)| if k.as_str() == "var" { (*k, EValue::Str(Arc::from("Hexed"))) } else { (*k, v.clone()) }).collect() }
            }).collect();
            m.tags = tags.into();
        }
    }
    out
}

/// `activeSkill.skillData` fields `buildActiveSkillModList` sets directly (not via a mod) - the
/// subset this file's scope covers (`CalcActiveSkill.lua`:551-618).
#[derive(Default, Clone, Debug)]
pub struct SkillDataOut {
    pub crit_chance: Option<f64>,
    pub attack_time: Option<f64>,
    pub attack_speed_multiplier: Option<f64>,
    pub cooldown: Option<f64>,
    pub stored_uses: Option<f64>,
    pub soul_prevention_duration: Option<f64>,
    pub mana_reservation_percent: Option<f64>,
    pub totem_level: Option<f64>,
    /// `skillData.attachedBrandCount` (CalcPerform.lua:1362), set by the perform stage for Brand skills.
    pub attached_brand_count: Option<f64>,
    /// `SupportedGemProperty` level/quality added to the active effect (`CalcActiveSkill.lua`:559-571).
    pub level_bonus: f64,
    pub quality_bonus: f64,
}

pub struct SupportInstance<'a> {
    pub ge: &'a GrantedEffect,
    pub level: f64,
    pub quality: f64,
    /// `srcInstance.level` (the `GemLevel` mod records this, not the effective `level`).
    pub raw_level: f64,
    /// Quality added on top of `quality` for stats only (matching-socket bonus plus `GemProperty`
    /// quality bonuses); the recorded `GemQuality` stays the raw `quality`.
    pub extra_quality: f64,
    /// The gem's socket colour matches (`GemSocketQuality` mod).
    pub socket_match: bool,
    /// `activeEffect.gemData` is set and not a support gem (CalcActiveSkill.lua:561-562).
    pub has_gem_data: bool,
}

/// `calcs.buildActiveSkillModList`'s mod-list-assembly half (`Modules/CalcActiveSkill.lua`:
/// 491-628ish), given the skill's already-resolved active/support gem instances. Not covered by
/// this function (documented, not faked):
/// - `SupportedGemProperty`/`gemPropertyInfo` (`GemSupport*`/`GemItem*` mods, lines 559-574) - need
///   per-gem-instance item property data this crate's item-crate recording doesn't carry.
/// - The matching-socket-colour `GemSocketQuality` bonus (line 556-558) - `xmlskills::GemInstance`
///   doesn't track `matchesSocket`.
/// - `DisableSkill`/`EnableSkill` (line 505-508) - callers with a real actor `ModStore` should
///   query it themselves (`ModStore::flag(cfg, &[pom_engine::sym!("DisableSkill")])` etc.) since this
///   function has no actor store to query; see `crate::assemble`'s call site.
/// - `ExtraSkillStat`/`ExtraSkillMod` (lines 578, 611-614) - same reason, needs an actor `ModStore`
///   + `Cfg` to query; `extra_skill_stats`/`extra_skill_mods` are accepted as pre-resolved
///   parameters instead so a caller with a real store can supply them.
pub fn build_active_skill_mod_list(active: &SupportInstance, supports: &[SupportInstance], extra_skill_stats: &[(String, f64)], extra_skill_mods: &[Mod], damage_fixup: Option<f64>) -> (Vec<Mod>, SkillDataOut) {
    build_active_skill_mod_list_cfg(active, supports, extra_skill_stats, extra_skill_mods, damage_fixup, None)
}

/// `build_active_skill_mod_list` plus `SupportedGemProperty` handling (`CalcActiveSkill.lua`:
/// 559-571) when the skill's `skillCfg` is supplied: a support's `supported_*_gem_level_+`/
/// `_quality_%` stat raises the active gem's level/quality before its own stats are merged.
pub fn build_active_skill_mod_list_cfg(active: &SupportInstance, supports: &[SupportInstance], extra_skill_stats: &[(String, f64)], extra_skill_mods: &[Mod], damage_fixup: Option<f64>, skill_cfg: Option<&Cfg>) -> (Vec<Mod>, SkillDataOut) {
    build_active_skill_mod_list_actor(active, supports, extra_skill_stats, extra_skill_mods, damage_fixup, skill_cfg, None)
}

/// As `build_active_skill_mod_list_cfg`, with `activeEffect.actorLevel` (CalcActiveSkill.lua:577) for a skill owned by a minion.
pub fn build_active_skill_mod_list_actor(active: &SupportInstance, supports: &[SupportInstance], extra_skill_stats: &[(String, f64)], extra_skill_mods: &[Mod], damage_fixup: Option<f64>, skill_cfg: Option<&Cfg>, actor_level: Option<f64>) -> (Vec<Mod>, SkillDataOut) {
    let mut mods = Vec::new();
    let mut data = SkillDataOut::default();

    if let Some(fixup) = damage_fixup {
        let fixup_source: Arc<str> = Arc::from("Damage Fixup");
        mods.push(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: EValue::Num(-100.0 * fixup), flags: mod_flag::Attack, keyword_flags: 0, source: Some(fixup_source.clone()), tags: (vec![]).into() });
        mods.push(Mod { name: pom_engine::sym!("Speed"), ty: ModType::More, value: EValue::Num(100.0 * fixup), flags: mod_flag::Attack, keyword_flags: 0, source: Some(fixup_source), tags: (vec![]).into() });
    }

    for s in supports {
        // `s.ge` is always a support gem here (`grantedEffect.support` true), so the
        // `notMinionStat` gate's `(support or skillTypes[Buff])` condition is unconditionally true.
        mods.extend(merge_skill_instance_mods(s.ge, s.level, s.quality + s.extra_quality, None, &[], true));
        let ge_id = s.ge.id.as_deref().unwrap_or("");
        if let Some(level) = raw_level_map(ge_id, s.level) {
            let source: Arc<str> = Arc::from(s.ge.extra.get("modSource").and_then(|v| v.as_str()).unwrap_or(""));
            if let Some(mm) = level.get("manaMultiplier").and_then(jf64) {
                mods.push(Mod { name: pom_engine::sym!("SupportManaMultiplier"), ty: ModType::More, value: EValue::Num(mm), flags: 0, keyword_flags: 0, source: Some(source.clone()), tags: (vec![]).into() });
            }
            if let Some(mrp) = level.get("manaReservationPercent").and_then(jf64) {
                data.mana_reservation_percent = Some(mrp);
            }
            if let Some(pvp) = level.get("PvPDamageMultiplier").and_then(jf64) {
                mods.push(Mod { name: pom_engine::sym!("PvpDamageMultiplier"), ty: ModType::More, value: EValue::Num(pvp), flags: 0, keyword_flags: 0, source: Some(source.clone()), tags: (vec![]).into() });
            }
            if let Some(su) = level.get("storedUses").and_then(jf64) {
                data.stored_uses = Some(su);
            }
            if let Some(vsu) = level.get("vaalStoredUses").and_then(jf64) {
                data.stored_uses = Some(data.stored_uses.unwrap_or(vsu)); // Lua: `x or 0 + v` is `x or (0 + v)`
            }
        }
    }

    // GemLevel/GemQuality (`CalcActiveSkill.lua`:552-553).
    let active_source: Arc<str> = Arc::from(active.ge.extra.get("modSource").and_then(|v| v.as_str()).unwrap_or(""));
    mods.push(Mod { name: pom_engine::sym!("GemLevel"), ty: ModType::Base, value: EValue::Num(active.raw_level), flags: 0, keyword_flags: 0, source: Some(Arc::from("Max Level")), tags: (vec![]).into() });
    mods.push(Mod { name: pom_engine::sym!("GemQuality"), ty: ModType::Base, value: EValue::Num(active.quality), flags: 0, keyword_flags: 0, source: Some(Arc::from("Max Quality")), tags: (vec![]).into() });
    if active.socket_match {
        mods.push(Mod { name: pom_engine::sym!("GemSocketQuality"), ty: ModType::Base, value: EValue::Num(10.0), flags: 0, keyword_flags: 0, source: Some(Arc::from("Socket Quality")), tags: (vec![]).into() });
    }

    // `SupportedGemProperty` (`CalcActiveSkill.lua`:559-571).
    let mut active_level = active.level;
    let mut active_extra_quality = active.extra_quality;
    if let Some(cfg) = skill_cfg {
        if mods.iter().any(|m| m.name.as_str() == "SupportedGemProperty") {
            let mut store = ModStore::new_list(None, None);
            for m in &mods {
                store.add_mod(m.clone());
            }
            let found = store.tabulate(Some(ModType::List), Some(cfg), &[pom_engine::sym!("SupportedGemProperty")]);
            for (v, mp) in found {
                let EValue::Map(fields) = &v else { continue };
                let get = |k: &str| fields.iter().find(|(n, _)| n.as_str() == k).map(|(_, v)| v);
                let (Some(EValue::Str(keyword)), Some(EValue::Str(key)), Some(EValue::Num(value))) = (get("keyword"), get("key"), get("value")) else { continue };
                if keyword.as_ref() != "grants_active_skill" || !active.has_gem_data || crate::data::is_support(active.ge) {
                    continue;
                }
                match key.as_ref() {
                    "level" => {
                        active_level += value;
                        data.level_bonus += value;
                    }
                    "quality" => {
                        active_extra_quality += value;
                        data.quality_bonus += value;
                    }
                    _ => {}
                }
                // SAFETY: `mp` points into `store`, which is alive for this whole loop.
                let (source, tag0) = unsafe { ((*mp).source.clone(), (*mp).tags.first().cloned()) };
                let mut cap = key.to_string();
                cap[..1].make_ascii_uppercase();
                mods.push(Mod { name: Sym::new(&format!("GemSupport{cap}")), ty: ModType::Base, value: EValue::Num(*value), flags: 0, keyword_flags: 0, source, tags: tag0.into_iter().collect() });
            }
        }
    }
    // mergeSkillInstanceMods (CalcActiveSkill.lua:54): calcLib.validateGemLevel after the support level bonuses.
    let active_level = validate_gem_level(active.ge.id.as_deref().unwrap_or(""), active_level);
    let active = &SupportInstance { ge: active.ge, level: active_level, raw_level: active.raw_level, quality: active.quality, extra_quality: active_extra_quality, socket_match: active.socket_match, has_gem_data: active.has_gem_data };

    // Active gem's own mods (`CalcActiveSkill.lua`:578).
    let is_buff = active.ge.extra.get("skillTypes").and_then(|v| v.as_object()).map(|o| o.get(&crate::skill_type::BUFF.to_string()).and_then(|b| b.as_bool()).unwrap_or(false)).unwrap_or(false);
    mods.extend(merge_skill_instance_mods(active.ge, active.level, active.quality + active.extra_quality, actor_level, extra_skill_stats, is_buff));

    // Extra mods from the granted effect level (`CalcActiveSkill.lua`:581-607).
    let active_ge_id = active.ge.id.as_deref().unwrap_or("");
    if let Some(level) = raw_level_map(active_ge_id, active.level) {
        data.crit_chance = level.get("critChance").and_then(jf64);
        if let Some(dm) = level.get("damageMultiplier").and_then(jf64) {
            mods.push(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: EValue::Num(dm), flags: mod_flag::Attack, keyword_flags: 0, source: Some(active_source.clone()), tags: (vec![]).into() });
        }
        if let Some(at) = level.get("attackTime").and_then(jf64) {
            data.attack_time = Some(at);
        }
        if let Some(asm) = level.get("attackSpeedMultiplier").and_then(jf64) {
            data.attack_speed_multiplier = Some(asm);
        }
        if let Some(cd) = level.get("cooldown").and_then(jf64) {
            data.cooldown = Some(cd);
        }
        if let Some(su) = level.get("storedUses").and_then(jf64) {
            data.stored_uses = Some(su);
        }
        if let Some(vsu) = level.get("vaalStoredUses").and_then(jf64) {
            data.stored_uses = Some(data.stored_uses.unwrap_or(vsu)); // Lua: `x or 0 + v` is `x or (0 + v)`
        }
        if let Some(spd) = level.get("soulPreventionDuration").and_then(jf64) {
            data.soul_prevention_duration = Some(spd);
        }
        if let Some(pvp) = level.get("PvPDamageMultiplier").and_then(jf64) {
            mods.push(Mod { name: pom_engine::sym!("PvpDamageMultiplier"), ty: ModType::More, value: EValue::Num(pvp), flags: 0, keyword_flags: 0, source: Some(active_source.clone()), tags: (vec![]).into() });
        }
        if let Some(lr) = level.get("levelRequirement").and_then(jf64) {
            data.totem_level = Some(lr);
        }
    }

    mods.extend(extra_skill_mods.iter().cloned());
    (mods, data)
}

/// `DisableSkill`/`EnableSkill` (`CalcActiveSkill.lua`:503-508), given a real actor `ModStore` +
/// the skill's own `Cfg`. Not called anywhere in this crate's own metadata-only pass; exposed for a
/// caller (`pom-pipeline`) that has a real, item/tree-merged actor `ModStore` to query.
pub fn is_disabled_by_mods(actor: &ModStore, cfg: &Cfg) -> bool {
    let disable = actor.flag(Some(cfg), &[pom_engine::sym!("DisableSkill")]);
    if !disable {
        return false;
    }
    !actor.flag(Some(cfg), &[pom_engine::sym!("EnableSkill")])
}
