// Flat lookups out of pom_engine::data::GameData for the tables CalcOffence.lua reads as
// `data.*`/`env.data.*`. Loaded once per process (same OnceLock pattern as crates/calc/src/data.rs).
use pom_engine::data::GameData;
use std::path::Path;
use std::sync::OnceLock;

/// The game-data fixes that differ from upstream calculation run unless `POM_STRICT_COMPAT=1`, which gives the
/// original numbers exactly (used for answer-key grading).
pub fn pom_fixes_on() -> bool {
    !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1")
}

pub fn game_data() -> &'static GameData {
    pom_engine::data::shared()
}

/// `data.misc["key"]`.
pub fn misc(key: &str) -> f64 {
    game_data().misc.get(key).unwrap_or_else(|| panic!("data.misc missing key {key:?}"))
}

/// `data.monsterAllyLifeTable[level]` (1-based in Lua; `data_monsterAllyLifeTable.json` is the
/// same array with a 0-based JSON index, so `level` maps to `level - 1`, clamped).
pub fn monster_ally_life_table(level: i64) -> f64 {
    let v = game_data().extra.get("monsterAllyLifeTable").expect("monsterAllyLifeTable missing").expect("monsterAllyLifeTable parse failed");
    let arr = v.as_array().expect("monsterAllyLifeTable is not an array");
    let idx = (level - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(0.0)
}

/// `data.monsterLifeTable[level]`, same 1-based/0-based mapping as above.
pub fn monster_life_table(level: i64) -> f64 {
    let v = game_data().extra.get("monsterLifeTable").expect("monsterLifeTable missing").expect("monsterLifeTable parse failed");
    let arr = v.as_array().expect("monsterLifeTable is not an array");
    let idx = (level - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(0.0)
}

/// `data.totemLifeMult[totemId]` (Lua table keyed by the numeric totem skill id; the JSON export
/// keys it by the id's decimal string). Missing id -> 1 (Lua `nil` read as a multiplier reads 1
/// via `or 1` at every call site in CalcOffence.lua).
pub fn totem_life_mult(totem_id: i64) -> f64 {
    let v = game_data().extra.get("totemLifeMult").expect("totemLifeMult missing").expect("totemLifeMult parse failed");
    v.get(totem_id.to_string()).and_then(|x| x.as_f64()).unwrap_or(1.0)
}

/// `data.monsterVarietyLifeMult[variety]`, `or 1` default (CalcOffence.lua:1474/1480).
pub fn monster_variety_life_mult(variety: &str) -> f64 {
    let v = game_data().extra.get("monsterVarietyLifeMult").expect("monsterVarietyLifeMult missing").expect("monsterVarietyLifeMult parse failed");
    v.get(variety).and_then(|x| x.as_f64()).unwrap_or(1.0)
}

/// `data.mapLevelLifeMult[enemyLevel]`, `or 1` default (CalcOffence.lua:1474/1481).
pub fn map_level_life_mult(enemy_level: i64) -> f64 {
    let v = game_data().extra.get("mapLevelLifeMult").expect("mapLevelLifeMult missing").expect("mapLevelLifeMult parse failed");
    v.get(enemy_level.to_string()).and_then(|x| x.as_f64()).unwrap_or(1.0)
}

/// `activeSkill.activeEffect.grantedEffect.castTime`, keyed by `skillGrantedEffectId`
/// (`data_skills.json`'s top-level `id`/key, e.g. "SummonRagingSpirit") - not part of `skillData`
/// (unlike `damageEffectiveness`/`baseMultiplier`, nothing copies it there at setup time), so this
/// crate reads it straight from the same static gem/skill export `crates/calc` and the passives
/// crate already load sections of. `None` when the id is missing from the export (never seen in the
/// 200-build sample, but the Lua itself would error on a truly missing skill, so this is a
/// should-not-happen case, not a modeled "absent" one).
pub fn skill_cast_time(skill_granted_effect_id: &str) -> Option<f64> {
    let v = game_data().extra.get("skills").ok().flatten()?;
    v.get(skill_granted_effect_id)?.get("castTime")?.as_f64()
}

/// `data.monsterAilmentThresholdTable[enemyLevel]` (Data/Misc.lua:15), 1-based array, clamped like
/// `monster_ally_life_table`.
pub fn monster_ailment_threshold_table(enemy_level: i64) -> f64 {
    let v = game_data().extra.get("monsterAilmentThresholdTable").expect("monsterAilmentThresholdTable missing").expect("monsterAilmentThresholdTable parse failed");
    let arr = v.as_array().expect("monsterAilmentThresholdTable is not an array");
    let idx = (enemy_level - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(0.0)
}

/// `data.mapLevelBossLifeMult[enemyLevel]` (Data/Misc.lua:473), 1-based array indexed directly by
/// `enemyLevel` (unlike `mapLevelLifeMult`, which is a sparse dict keyed 66..90 - this one is a
/// dense array 1..90; only ever read for `enemyLevel >= 66` at the Lua call site, but the array
/// itself covers 1..90).
pub fn map_level_boss_life_mult(enemy_level: i64) -> f64 {
    let v = game_data().extra.get("mapLevelBossLifeMult").expect("mapLevelBossLifeMult missing").expect("mapLevelBossLifeMult parse failed");
    let arr = v.as_array().expect("mapLevelBossLifeMult is not an array");
    let idx = (enemy_level - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(1.0)
}

/// `data.mapLevelBossAilmentMult[enemyLevel]` (Data/Misc.lua:474), same shape as
/// `map_level_boss_life_mult`.
pub fn map_level_boss_ailment_mult(enemy_level: i64) -> f64 {
    let v = game_data().extra.get("mapLevelBossAilmentMult").expect("mapLevelBossAilmentMult missing").expect("mapLevelBossAilmentMult parse failed");
    let arr = v.as_array().expect("mapLevelBossAilmentMult is not an array");
    let idx = (enemy_level - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(1.0)
}

/// `data.characterConstants[key]` (Data/Global.lua), e.g. `impaled_debuff_base_duration_ms`.
pub fn character_constant(key: &str) -> f64 {
    let v = game_data().extra.get("characterConstants").expect("characterConstants missing").expect("characterConstants parse failed");
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
