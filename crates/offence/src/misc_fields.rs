// Port of a set of self-contained `output.*` fields from Modules/CalcOffence.lua that don't
// depend on the passList/weapon-base-damage machinery.
// Each function name and doc comment cites its exact source lines.
use crate::area::{calc_area_mod, calc_radius};
use crate::data;
use crate::input::SkillView;
use crate::tools::calc_lib_mod;
use crate::tools::calc_lib_mod_s;
use pom_engine::modifier::ModType;
use pom_engine::sym::Sym;

/// `output.ActiveTrapLimit`, `output.ActiveMineLimit` (CalcOffence.lua:561-562).
pub fn active_trap_mine_limits(skill: &SkillView) -> (f64, f64) {
    let trap = skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("ActiveTrapLimit")]);
    let mine = skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("ActiveMineLimit")]);
    (trap, mine)
}

/// `output.LifeFlaskRecovery`, `output.LifeFlaskCharges` (CalcOffence.lua:565-566): a direct
/// passthrough of `env.itemModDB.multipliers`, not a skill-specific computation.
pub fn life_flask_scaling(env_item_mod_db_life_flask_recovery: f64, env_item_mod_db_life_flask_charges: f64) -> (f64, f64) {
    (env_item_mod_db_life_flask_recovery, env_item_mod_db_life_flask_charges)
}

/// `output.PreciseTechnique = env.keystonesAdded["Precise Technique"]` (CalcOffence.lua:2002):
/// also a direct passthrough (a boolean-as-keystone-added flag), listed here so the field name
/// and its one-line derivation stay documented next to its siblings.
pub fn precise_technique(env_keystones_added_precise_technique: bool) -> bool {
    env_keystones_added_precise_technique
}

/// `output.Repeats`/`output.RepeatCount` (CalcOffence.lua:808-819). `repeatSkillTypesCheck`
/// (808-816) excludes Instant/Channel/Triggered/Retaliation/NonRepeatable skill types and
/// requires Attack or Spell; ids taken from `data_ailmentTypeList`-style SkillType enum values are
/// NOT re-derived here - caller passes the already-evaluated `activeSkillTypes` check result via
/// `eligible_for_repeats` (computed from the skill's own recorded `skillTypes` int set and the
/// fixed SkillType ids, done once by the caller rather than duplicating the enum table here).
pub fn repeats(skill: &SkillView, eligible_for_repeats: bool) -> (f64, Option<f64>) {
    let cannot_repeat = skill.skill_mod_list.flag(skill.skill_cfg, &[pom_engine::sym!("CannotRepeat")]);
    let extra = if eligible_for_repeats && !cannot_repeat {
        skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("RepeatCount")])
    } else {
        0.0
    };
    let repeats = 1.0 + extra;
    let repeat_count = if repeats > 1.0 { Some(repeats) } else { None };
    (repeats, repeat_count)
}

/// Fields set when `activeSkill.skillTypes[SkillType.Totem]` (CalcOffence.lua:1413-1456), minus
/// the placement-speed/time pair (see `totem_placement`) and `TotemLife`/`TotemLifeMod` (see
/// `cooldown::calc_totem_life`). `totems_summoned_override` is `env.modDB:Override(nil,
/// "TotemsSummoned")`, resolved by the caller since it reads the PLAYER's own modDB even when the
/// active skill belongs to a minion.
pub struct TotemLimits {
    pub active_totem_limit: f64,
    pub totems_summoned: f64,
    pub totem_energy_shield: f64,
    pub totem_block_chance: f64,
    pub totem_armour: f64,
}
pub fn totem_limits(skill: &SkillView, totems_summoned_override: Option<f64>) -> TotemLimits {
    let active_totem_limit = skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("ActiveTotemLimit"), pom_engine::sym!("ActiveBallistaLimit")]);
    TotemLimits {
        active_totem_limit,
        totems_summoned: totems_summoned_override.unwrap_or(active_totem_limit),
        totem_energy_shield: skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("TotemEnergyShield")]),
        totem_block_chance: skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("TotemBlockChance")]),
        totem_armour: skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("TotemArmour")]),
    }
}

/// `output.TotemPlacementSpeed`/`TotemPlacementTime` (CalcOffence.lua:1413-1421).
/// `action_speed_mod` is `output.ActionSpeedMod`, computed upstream of `calcs.offence` (by
/// CalcPerform's buff pass) and read here as a recorded input, not re-derived.
pub fn totem_placement(skill: &SkillView, is_ballista: bool, action_speed_mod: f64) -> (f64, f64) {
    let base_name = if is_ballista { "BallistaPlacementTime" } else { "TotemPlacementTime" };
    let base_speed = 1.0 / skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[Sym::new(base_name)]);
    let speed = base_speed * calc_lib_mod_s(skill.skill_mod_list, skill.skill_cfg, &[pom_engine::sym!("TotemPlacementSpeed")]) * action_speed_mod;
    (speed, 1.0 / speed)
}

/// `output.BrandAttachmentRange`/`Metre`, `output.ActiveBrandLimit`, `output.AttachedBrandCount`
/// (CalcOffence.lua:1458-1466, gated on `activeSkill.skillTypes[SkillType.Brand]`).
/// `attached_brand_count` is `skillData.attachedBrandCount` (a direct passthrough, per the Lua).
pub struct BrandFields {
    pub attachment_range: f64,
    pub attachment_range_metre: f64,
    pub active_brand_limit: f64,
    pub attached_brand_count: Option<f64>,
}
pub fn brand_fields(skill: &SkillView) -> BrandFields {
    let range = data::misc("BrandAttachmentRangeBase") * calc_lib_mod_s(skill.skill_mod_list, skill.skill_cfg, &[pom_engine::sym!("BrandAttachmentRange")]);
    BrandFields {
        attachment_range: range,
        attachment_range_metre: range / 10.0,
        active_brand_limit: skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("ActiveBrandLimit")]),
        attached_brand_count: skill.num("attachedBrandCount"),
    }
}

/// `output.CorpseLevel`/`BaseCorpseLife`/`CorpseLifeInc`/`CorpseLife` (CalcOffence.lua:1472-1488,
/// gated on `skillFlags.corpse`). `corpse_monster_variety` is `skillData.corpseMonsterVariety`.
pub struct CorpseFields {
    pub corpse_level: f64,
    pub base_corpse_life: f64,
    pub corpse_life_inc: f64,
    pub corpse_life: f64,
}
pub fn corpse_fields(skill: &SkillView, enemy_level: i64) -> CorpseFields {
    let corpse_level = skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("CorpseLevel")]);
    let level_for_table = if corpse_level != 0.0 { corpse_level as i64 } else { 1 };
    let variety_mult = skill.str("corpseMonsterVariety").map(data::monster_variety_life_mult).unwrap_or(1.0);
    let map_mult = data::map_level_life_mult(enemy_level);
    let base_corpse_life = data::monster_life_table(level_for_table) * variety_mult * map_mult;
    let inc = 1.0 + skill.skill_mod_list.sum(ModType::Inc, skill.skill_cfg, &[pom_engine::sym!("CorpseLife")]) / 100.0;
    CorpseFields { corpse_level, base_corpse_life, corpse_life_inc: inc, corpse_life: base_corpse_life * inc }
}

/// The primary-radius path of `calcAreaOfEffect` (CalcOffence.lua:374-396) only: no
/// `radiusSecondary`/`radiusTertiary`/`radiusIsWeaponRange` (those need `actor.weaponRange1/2`,
/// not ported). `base_radius_extra` is `skillData.radiusExtra` (default 0).
pub struct AreaFields {
    pub area_of_effect_mod: f64,
    pub radius: Option<f64>,
    pub radius_metres: Option<f64>,
}
pub fn area_of_effect_primary(skill: &SkillView, radius_mod: Option<f64>) -> AreaFields {
    let (inc_area, more_area) = crate::tools::calc_lib_mods_s(skill.skill_mod_list, skill.skill_cfg, &[pom_engine::sym!("AreaOfEffect"), pom_engine::sym!("AreaOfEffectPrimary")]);
    if pom_engine::env::var("OFFENCE_DEBUG_AOE").is_ok() {
        eprintln!("DEBUG aoe: inc={inc_area} more={more_area} cfg_flags={:?} cfg_kw={:?}", skill.skill_cfg.map(|c| c.flags), skill.skill_cfg.map(|c| c.keyword_flags));
    }
    let area_mod = calc_area_mod(inc_area, more_area);
    let radius = skill.num("radius").map(|r| {
        let base_radius = r + skill.num_or("radiusExtra", 0.0) + skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("AreaOfEffect")]);
        calc_radius(base_radius, area_mod, radius_mod)
    });
    AreaFields { area_of_effect_mod: area_mod, radius, radius_metres: radius.map(|r| r / 10.0) }
}

/// `output.TrapThrowingSpeed`/`TrapThrowingTime`/`TrapThrowCount` (CalcOffence.lua:1257-1270),
/// the common (non-cooldown) case: `skillData.trapCooldown`/`skillData.cooldown` both absent.
/// `trap_throw_count_override` is `env.modDB:Override(nil, "TrapThrowCount")`.
pub struct TrapThrowFields {
    pub throwing_speed: f64,
    pub throwing_time: f64,
    pub throw_count: f64,
}
pub fn trap_throwing(skill: &SkillView, action_speed_mod: f64, trap_throw_count_override: Option<f64>, has_cooldown: bool) -> TrapThrowFields {
    let base_speed = 1.0 / skill.skill_mod_list.sum(ModType::Base, skill.skill_cfg, &[pom_engine::sym!("TrapThrowingTime")]);
    let time_mod = calc_lib_mod_s(skill.skill_mod_list, skill.skill_cfg, &[pom_engine::sym!("SkillTrapThrowingTime")]);
    let base_speed = if time_mod > 0.0 { base_speed * (1.0 / time_mod) } else { base_speed };
    let mut speed = base_speed * calc_lib_mod_s(skill.skill_mod_list, skill.skill_cfg, &[pom_engine::sym!("TrapThrowingSpeed")]) * action_speed_mod;
    let mut throw_count = crate::tools::calc_lib_val(skill.skill_mod_list, "TrapThrowCount", skill.skill_cfg);
    if has_cooldown {
        throw_count = 1.0;
    }
    throw_count = trap_throw_count_override.unwrap_or(throw_count);
    speed = speed.min(data::misc("ServerTickRate"));
    TrapThrowFields { throwing_speed: speed, throwing_time: 1.0 / speed, throw_count }
}

/// `output.TrapCooldown` (CalcOffence.lua:1293-1301), the `baseCooldown` (has
/// `trapCooldown`/`cooldown`) branch only.
pub fn trap_cooldown(skill: &SkillView, base_cooldown: f64) -> f64 {
    let t = base_cooldown / calc_lib_mod_s(skill.skill_mod_list, skill.skill_cfg, &[pom_engine::sym!("CooldownRecovery")]);
    let tick = data::misc("ServerTickRate");
    (t * tick).ceil() / tick
}
