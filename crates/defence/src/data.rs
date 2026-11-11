//! Loads `pom_engine::data::GameData` once per process, for `data.misc` (`data_misc.json`) and
//! the ailment-type lists `Modules/Data.lua` declares (`data.ailmentTypeList`,
//! `data.elementalAilmentTypeList`, `data.nonElementalAilmentTypeList`).
use pom_engine::data::GameData;
use std::path::Path;
use std::sync::OnceLock;

pub fn game_data() -> &'static GameData {
    pom_engine::data::shared()
}

/// `data.misc["key"]`. Panics on an unknown key: every key this crate reads is a fixed literal
/// taken straight from CalcDefence.lua, so a miss means the export or the port drifted.
pub fn misc(key: &str) -> f64 {
    game_data().misc.get(key).unwrap_or_else(|| panic!("data.misc missing key {key:?}"))
}

/// `data.monsterPhysConversionMultiTable[level]` (a flat, 1-indexed, 100-entry array;
/// `engine-data/data_monsterPhysConversionMultiTable.json`), read by `estimations::enemy_damage`
/// (Modules/CalcDefence.lua:1795) for the physical-to-X skill-conversion level bonus.
pub fn monster_phys_conversion_multi(level: f64) -> f64 {
    let arr = game_data().extra.get("monsterPhysConversionMultiTable").ok().flatten().unwrap_or_else(|| panic!("missing monsterPhysConversionMultiTable"));
    let idx = (level.max(1.0) as usize).saturating_sub(1);
    arr.as_array().and_then(|a| a.get(idx)).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// `Modules/Data.lua` line 419: `data.ailmentTypeList`.
pub const AILMENT_TYPE_LIST: &[&str] = &["Bleed", "Poison", "Ignite", "Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"];
/// Line 420: `data.elementalAilmentTypeList`.
pub const ELEMENTAL_AILMENT_TYPE_LIST: &[&str] = &["Ignite", "Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"];
/// Line 422: `data.nonElementalAilmentTypeList`.
pub const NON_ELEMENTAL_AILMENT_TYPE_LIST: &[&str] = &["Bleed", "Poison"];
