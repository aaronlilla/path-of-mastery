//! Typed shape of `data_gems.json` (Lua `data.gems`, keyed by game id, e.g.
//! "Metadata/Items/Gems/SkillGemFireball").

use crate::cjson::J;
use crate::fxhash::HashMap;

#[derive(Debug, Clone)]
pub struct GemData {
    pub name: Option<String>,
    pub base_type_name: Option<String>,
    pub game_id: Option<String>,
    pub variant_id: Option<String>,
    pub granted_effect_id: Option<String>,
    pub secondary_granted_effect_id: Option<String>,
    pub vaal_gem: bool,
    pub tags: HashMap<String, bool>,
    pub tag_string: Option<String>,
    pub req_str: f64,
    pub req_dex: f64,
    pub req_int: f64,
    pub natural_max_level: Option<i64>,
    pub granted_effect: Option<GrantedEffect>,
    pub secondary_granted_effect: Option<GrantedEffect>,
    /// Runtime-only fields set by `Modules/Data.lua` after the static gem list loads
    /// (`grantedEffectList`, `id`, `secondaryEffectName`) and anything else not listed above.
    pub extra: crate::fxhash::HashMap<String, J>,
}

/// One entry in `GrantedEffect.levels`. Numbered keys ("1", "2", ...) hold per-level values for
/// the stats listed in `GrantedEffect.stats`/`statMap`, at the index the stat is declared at; they
/// land in `values` since which numbered keys exist, and what they mean, differs per skill.
#[derive(Debug, Clone)]
pub struct GemLevel {
    pub level_requirement: Option<f64>,
    pub damage_effectiveness: Option<f64>,
    pub crit_chance: Option<f64>,
    pub cost: Option<HashMap<String, f64>>,
    pub stat_interpolation: Vec<f64>,
    pub values: crate::fxhash::HashMap<String, J>,
}

#[derive(Debug, Clone)]
pub struct GrantedEffect {
    pub id: Option<String>,
    pub name: Option<String>,
    pub base_type_name: Option<String>,
    pub cast_time: Option<f64>,
    pub color: Option<i64>,
    pub base_effectiveness: Option<f64>,
    pub incremental_effectiveness: Option<f64>,
    pub stats: Vec<String>,
    /// `[stat_name, per_quality_value]` pairs; not a flat string list like `stats`.
    pub quality_stats: Vec<J>,
    pub levels: Vec<GemLevel>,
    /// `baseFlags`, `baseMods`, `constantStats`, `statMap`, `skillTypes`, `minionList`, and other
    /// fields whose shape varies per skill type.
    pub extra: crate::fxhash::HashMap<String, J>,
}

crate::de_with_tail!(GemData, extra, {
    name: "name" => opt,
    base_type_name: "baseTypeName" => opt,
    game_id: "gameId" => opt,
    variant_id: "variantId" => opt,
    granted_effect_id: "grantedEffectId" => opt,
    secondary_granted_effect_id: "secondaryGrantedEffectId" => opt,
    vaal_gem: "vaalGem" => def,
    tags: "tags" => def,
    tag_string: "tagString" => opt,
    req_str: "reqStr" => def,
    req_dex: "reqDex" => def,
    req_int: "reqInt" => def,
    natural_max_level: "naturalMaxLevel" => opt,
    granted_effect: "grantedEffect" => opt,
    secondary_granted_effect: "secondaryGrantedEffect" => opt,
});

crate::de_with_tail!(GemLevel, values, {
    level_requirement: "levelRequirement" => opt,
    damage_effectiveness: "damageEffectiveness" => opt,
    crit_chance: "critChance" => opt,
    cost: "cost" => opt,
    stat_interpolation: "statInterpolation" => flex,
});

crate::de_with_tail!(GrantedEffect, extra, {
    id: "id" => opt,
    name: "name" => opt,
    base_type_name: "baseTypeName" => opt,
    cast_time: "castTime" => opt,
    color: "color" => opt,
    base_effectiveness: "baseEffectiveness" => opt,
    incremental_effectiveness: "incrementalEffectiveness" => opt,
    stats: "stats" => flex,
    quality_stats: "qualityStats" => flex,
    levels: "levels" => flex,
});
