// Port of Modules/CalcOffence.lua's damage-over-time sections: Bleed (4412-4682), Poison
// (4685-4988), Ignite (4990-5330), and the TotalDot build/combine (5771-5914, 6250-6257).
// Breakdown-only lines are not reproduced (see leech.rs's module doc for the isolation rationale
// this crate follows throughout: un-ported hit-path/other-crate fields are taken as recorded
// inputs). Graded against the "Skill" pass only (non-attack skills, cfg == skillCfg).
use crate::ailments::{calc_ailment_damage, can_deal};
use crate::conversion::{calc_ailment_source_damage, ConversionTable, DmgTypeFlags};
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

// ModFlag bits (Data/Global.lua:102-131) needed to build a dotCfg.
const MODFLAG_DOT: u64 = 0x00000008;
const MODFLAG_MELEE: u64 = 0x00000100;
const MODFLAG_AILMENT: u64 = 0x00000800;
const MODFLAG_MELEE_HIT: u64 = 0x00001000;
const MODFLAG_WEAPON_MASK: u64 = 0x2FFF0000;
const MODFLAG_WEAPON_1H: u64 = 0x10000000;

// KeywordFlag bits (Data/Global.lua:135-168).
const KEYWORDFLAG_HIT: u64 = 0x00040000;
const KEYWORDFLAG_AILMENT: u64 = 0x00080000;
const KEYWORDFLAG_POISON: u64 = 0x00200000;
const KEYWORDFLAG_BLEED: u64 = 0x00400000;
const KEYWORDFLAG_IGNITE: u64 = 0x00800000;
const KEYWORDFLAG_PHYSICAL_DOT: u64 = 0x01000000;
const KEYWORDFLAG_FIRE_DOT: u64 = 0x08000000;
const KEYWORDFLAG_CHAOS_DOT: u64 = 0x10000000;

/// Builds a Bleed/Poison/Ignite `dotCfg` (CalcOffence.lua:4414-4424/4687-4697/4992-5002).
/// `checkWeapon1HFlags` (4308, called at 4426 etc) ORs `cfg.flags & ModFlag.Weapon1H` in: `WeaponMask` (0x2FFF0000) leaves that bit out. Only
/// valid for the "Skill" pass (non-attack, `cfg == skillCfg`) - see module doc.
fn build_dot_cfg(cfg: &Cfg, extra_keyword_flags: u64) -> Cfg {
    // A genuinely fresh table in the Lua (4414-4424/4687-4697/4992-5002), not a copy of `cfg`: only
    // these fields are ever set, everything else (skillGem, baseFlags, item, skillStats, ...)
    // stays at its default/nil, unlike `cfg` itself which may carry them.
    Cfg {
        flags: MODFLAG_DOT | MODFLAG_AILMENT | (cfg.flags & MODFLAG_WEAPON_MASK) | (cfg.flags & MODFLAG_WEAPON_1H) | (if cfg.flags & MODFLAG_MELEE != 0 { MODFLAG_MELEE_HIT } else { 0 }),
        keyword_flags: (cfg.keyword_flags & !KEYWORDFLAG_HIT) | KEYWORDFLAG_AILMENT | extra_keyword_flags,
        skill_name: cfg.skill_name.clone(),
        summon_skill_name: cfg.summon_skill_name.clone(),
        skill_types: cfg.skill_types.clone(),
        skill_cond: {
            let mut m = cfg.skill_cond.clone();
            m.insert(Arc::from("CriticalStrike"), true);
            m
        },
        slot_name: cfg.slot_name.clone(),
        skill_part: cfg.skill_part,
        skill_dist: cfg.skill_dist,
        ..Cfg::default()
    }
}

fn set_crit_cond(cfg: &mut Cfg, crit: bool) {
    cfg.skill_cond.insert(Arc::from("CriticalStrike"), crit);
}

/// `calcResistForType(damageType, cfg)` (CalcOffence.lua:494-507), minus the "ResistEqualToYours"
/// branches (494-501): those read `env.player.output`/`env.partyMembers`, not captured by this
/// crate's recorder - named gap, falls through to the direct
/// `enemyDB:Sum` branch (503) in that rare case instead.
pub fn calc_resist_for_type(enemy_db: &ModStore, cfg: Option<&Cfg>, damage_type: &str, enemy_max_resist_config: Option<f64>) -> f64 {
    let enemy_max_resist = crate::data::misc("EnemyMaxResist");
    let max_resist_cap = crate::data::misc("MaxResistCap");
    let resist_floor = crate::data::misc("ResistFloor");
    let max_resist = if enemy_db.flag(None, &[pom_engine::sym!("DoNotChangeMaxResFromConfig")]) {
        enemy_max_resist
    } else {
        enemy_max_resist_config.unwrap_or(enemy_max_resist).max(enemy_max_resist).min(max_resist_cap)
    };

    let is_elemental = matches!(damage_type, "Fire" | "Cold" | "Lightning");
    let mut names = vec![format!("{damage_type}Resist")];
    if is_elemental {
        names.push("ElementalResist".to_string());
    }
    let syms: Vec<Sym> = names.iter().map(|s| Sym::new(s)).collect();
    let over = enemy_db.override_(cfg, &[Sym::new(&format!("{damage_type}Resist"))]).and_then(|v| v.num());
    let resist = over.unwrap_or_else(|| enemy_db.sum(ModType::Base, cfg, &syms) * crate::tools::calc_lib_mod(enemy_db, cfg, &names.iter().map(|s| s.as_str()).collect::<Vec<_>>()).max(0.0));
    resist.min(max_resist).max(resist_floor)
}

/// The `takenInc`/`takenMore` -> `effMult` combine every DoT section repeats (Bleed:4581-4584 uses
/// a different, PhysicalDamageReduction-based formula; Poison/Ignite/BurningGround share this one).
fn eff_mult(enemy_db: &ModStore, cfg: Option<&Cfg>, resist: f64, taken_names: &[&str]) -> f64 {
    let syms: Vec<Sym> = taken_names.iter().map(|s| Sym::new(s)).collect();
    let taken_inc = enemy_db.sum(ModType::Inc, cfg, &syms);
    let taken_more = enemy_db.more(cfg, &syms);
    (1.0 - resist / 100.0) * (1.0 + taken_inc / 100.0) * taken_more
}

/// Fields shared by Bleed/Poison/Ignite that come from outside this crate's ported scope: the
/// un-ported hit-pass loop (`CritChance`/`HitChance`/speed/`Ruthless Blow`/`Fist of War`/warcry
/// multipliers - all already-computed `output` fields by the time this section runs) and
/// CalcDefence.lua-adjacent config (`env.configInput`). Taken as recorded inputs throughout, per
/// leech.rs's isolation note.
#[derive(Default)]
pub struct DotExternal {
    pub crit_chance: f64,
    /// `globalOutput.CritChance` (the hand-combined value for attacks), read by the `if breakdown then` crit-DotMulti blend.
    pub global_crit_chance: f64,
    pub hit_chance: f64,
    pub hit_speed_or_speed: f64,
    pub hit_time_or_time: f64,
    pub cooldown: Option<f64>,
    pub ruthless_blow_ailment_effect: f64,
    pub fist_of_war_damage_effect: f64,
    pub ailment_warcry_effect: f64,
    pub dps_multiplier: f64,
    pub quantity_multiplier: f64,
    pub debuff_duration_mult: f64,
    /// `env.configInput["enemy<Type>Resist"]`, e.g. `"enemyChaosResist"`.
    pub enemy_resist_config: HashMap<&'static str, f64>,
    pub mode_effective: bool,
    pub triggered_on_death: bool,
    /// `skillData.duration` and the `bleed/poison` `DurationIsSkillDuration` / `IsSkillEffect` skillData flags (4437-4438, 4709-4710).
    pub skill_data_duration: Option<f64>,
    pub bleed_duration_is_skill_duration: bool,
    pub bleed_is_skill_effect: bool,
    pub poison_duration_is_skill_duration: bool,
    pub poison_is_skill_effect: bool,
    /// `env.configInput.ailmentMode == "CRIT"` (the chaos-poison chance is split per crit branch, see `chaos_poison_chances`).
    pub ailment_mode_crit: bool,
}

/// The `if breakdown then ... output.<Ailment>DotMulti = hit * totalFromHit + crit * totalFromCrit` block
/// (CalcOffence.lua:4604-4609, 4901-4906, 5296-5302). Upstream always has `breakdown` set when the values are
/// displayed (and in the recorder), so the mutation is part of the observable output.
thread_local! {
    /// True while a `calcs.perform` runs without a `breakdown` table (CALCULATOR mode: mirage copies). Upstream blends
    /// the hit and crit DoT multipliers only inside its `if breakdown then` blocks.
    pub static NO_BREAKDOWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn blend_dot_multi(hit_multi: Option<f64>, crit_multi: Option<f64>, chance_on_hit: f64, chance_on_crit: f64, global_crit_chance: f64, ailment_crit_chance: f64) -> Option<f64> {
    let (h, c) = (hit_multi?, crit_multi?);
    if c == h || NO_BREAKDOWN.with(|n| n.get()) {
        return Some(h);
    }
    let chance_from_hit = chance_on_hit / 100.0 * (1.0 - global_crit_chance / 100.0);
    let chance_from_crit = chance_on_crit / 100.0 * ailment_crit_chance / 100.0;
    let total_from_hit = chance_from_hit / (chance_from_hit + chance_from_crit);
    let total_from_crit = chance_from_crit / (chance_from_hit + chance_from_crit);
    Some(h * total_from_hit + c * total_from_crit)
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct BleedOutput {
    pub bleed_physical_min: f64,
    pub bleed_physical_max: f64,
    pub bleed_dot_multi: Option<f64>,
    pub crit_bleed_dot_multi: Option<f64>,
    pub base_bleed_dps: Option<f64>,
    pub bleed_dps: Option<f64>,
    /// `output.BleedChance`: the last `calcAilmentDamage("Bleed", ...)` call's side output (4574).
    pub bleed_chance: Option<f64>,
    /// `globalOutput.*` writes of the section (4436, 4441, 4464, 4496, 4585, 4600-4601).
    pub g_bleed_stacks_max: Option<f64>,
    pub g_bleed_duration: Option<f64>,
    pub g_bleed_stack_potential: Option<f64>,
    pub g_bleed_roll_average: Option<f64>,
    pub g_bleed_eff_mult: Option<f64>,
    pub g_bleed_stacks: Option<f64>,
    pub g_bleed_damage: Option<f64>,
}

/// Bleed (CalcOffence.lua:4412-4682). `chance_on_hit`/`chance_on_crit` are
/// `output.BleedChanceOnHit`/`OnCrit` (ailments.rs). `sub_pass` convention (matching the Lua's own
/// `dotCfg.skillCond["CriticalStrike"] = sub_pass ~= 1` exactly, which is the OPPOSITE of the
/// hit-pass loop's `pass==1` convention): sub_pass 1 = non-crit, sub_pass 2 = crit.
#[allow(clippy::too_many_arguments)]
pub fn calc_bleed(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    env_mod_db: &ModStore,
    mod_db: &ModStore,
    cfg: &Cfg,
    output_map: &HashMap<String, f64>,
    conversion_table: &ConversionTable,
    can_deal_physical: bool,
    chance_on_hit: f64,
    chance_on_crit: f64,
    skill_flags_totem: bool,
    ext: &DotExternal,
) -> BleedOutput {
    if !can_deal_physical || chance_on_hit + chance_on_crit <= 0.0 {
        return BleedOutput::default();
    }
    let mut dot_cfg = build_dot_cfg(cfg, KEYWORDFLAG_BLEED | KEYWORDFLAG_PHYSICAL_DOT);
    if crate::bd::on() {
        crate::bdail::damage_types_table("BleedPhysical");
    }

    let config_stacks = enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("Multiplier:BleedStacks")]);
    let max_stacks = skill_mod_list
        .override_(Some(cfg), &[pom_engine::sym!("BleedStacksMax")])
        .and_then(|v| v.num())
        .unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("BleedStacksMax")]));
    let override_stack_potential = skill_mod_list.override_(None, &[pom_engine::sym!("BleedStackPotentialOverride")]).and_then(|v| v.num()).map(|v| v / max_stacks);
    let duration_base = skill_mod_list.override_(Some(&dot_cfg), &[pom_engine::sym!("BleedDurationBase")]).and_then(|v| v.num()).or_else(|| if ext.bleed_duration_is_skill_duration { ext.skill_data_duration } else { None }).unwrap_or_else(|| crate::data::misc("BleedDurationBase"));
    let duration_mod = (crate::tools::calc_lib_mod(skill_mod_list, Some(&dot_cfg), if ext.bleed_is_skill_effect { &["EnemyBleedDuration", "EnemyAilmentDuration", "DamagingAilmentDuration", "Duration"][..] } else { &["EnemyBleedDuration", "EnemyAilmentDuration", "DamagingAilmentDuration"][..] })
        * crate::tools::calc_lib_mod_s(enemy_db, None, &[pom_engine::sym!("SelfBleedDuration"), pom_engine::sym!("SelfAilmentDuration")])
        / crate::tools::calc_lib_mod_s(enemy_db, Some(&dot_cfg), &[pom_engine::sym!("BleedExpireRate")]))
    .max(0.0);
    let rate_mod = crate::tools::calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("BleedFaster")]) + enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfBleedFaster")]) / 100.0;
    let bleed_duration = duration_base * duration_mod / rate_mod * ext.debuff_duration_mult;

    let bleed_chance = chance_on_hit / 100.0 * (1.0 - ext.crit_chance / 100.0) + chance_on_crit / 100.0 * ext.crit_chance / 100.0;
    let mut bleed_stacks = ext.hit_chance / 100.0 * bleed_chance * ext.dps_multiplier;
    if ext.hit_speed_or_speed > 0.0 {
        bleed_stacks = bleed_stacks * bleed_duration * ext.hit_speed_or_speed;
    }
    let active_totems = env_mod_db
        .override_(None, &[pom_engine::sym!("TotemsSummoned")])
        .and_then(|v| v.num())
        .unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ActiveTotemLimit"), pom_engine::sym!("ActiveBallistaLimit")]));
    if skill_flags_totem {
        bleed_stacks *= active_totems;
    }
    if config_stacks > 0.0 {
        bleed_stacks = config_stacks;
    }

    let bleed_stack_potential = override_stack_potential.unwrap_or(bleed_stacks / max_stacks);
    if crate::bd::on() {
        crate::bdail::bleed_stack_potential(override_stack_potential, ext.hit_chance, bleed_chance, ext.hit_speed_or_speed > 0.0, bleed_duration, ext.hit_time_or_time, ext.dps_multiplier, skill_flags_totem, active_totems, max_stacks, bleed_stack_potential);
    }
    let bleed_roll_average = if bleed_stack_potential > 1.0 { (bleed_stacks - (max_stacks - 1.0) / 2.0) / (bleed_stacks + 1.0) * 100.0 } else { 50.0 };
    if crate::bd::on() {
        crate::bdail::bleed_roll_average(bleed_roll_average, bleed_stacks, max_stacks);
    }

    let dot_multi = |c: &Cfg| -> f64 {
        1.0 + skill_mod_list
            .override_(Some(c), &[pom_engine::sym!("DotMultiplier")])
            .and_then(|v| v.num())
            .unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(c), &[pom_engine::sym!("DotMultiplier")]) + skill_mod_list.sum(ModType::Base, Some(c), &[pom_engine::sym!("PhysicalDotMultiplier")]))
            / 100.0
    };

    // sub_pass 1: CriticalStrike = false
    set_crit_cond(&mut dot_cfg, false);
    let (min1, max1) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Physical", DmgTypeFlags::default(), if crate::bd::on() { Some("BleedPhysical") } else { None });
    let bleed_dot_multi = dot_multi(&dot_cfg);
    let source_min_hit_dmg = min1 * bleed_dot_multi;
    let source_max_hit_dmg = max1 * bleed_dot_multi;
    let avg_hit_bleed_dmg = source_min_hit_dmg + (source_max_hit_dmg - source_min_hit_dmg) * bleed_roll_average / 100.0;

    // sub_pass 2: CriticalStrike = true
    set_crit_cond(&mut dot_cfg, true);
    let (min2, max2) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Physical", DmgTypeFlags::default(), None);
    let bleed_physical_min = min2;
    let bleed_physical_max = max2;
    let crit_bleed_dot_multi = if mod_db.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]) {
        set_crit_cond(&mut dot_cfg, false);
        let v = dot_multi(&dot_cfg);
        set_crit_cond(&mut dot_cfg, true);
        v
    } else {
        dot_multi(&dot_cfg)
    };
    let source_min_crit_dmg = min2 * crit_bleed_dot_multi;
    let source_max_crit_dmg = max2 * crit_bleed_dot_multi;
    let avg_crit_bleed_dmg = source_min_crit_dmg + (source_max_crit_dmg - source_min_crit_dmg) * bleed_roll_average / 100.0;

    let base_percent = crate::data::misc("BleedPercentBase");
    let ailment_crit_chance = 100.0 * (1.0 - (1.0 - ext.crit_chance / 100.0).powf(bleed_stack_potential.max(1.0)));

    if crate::bd::on() {
        crate::bdail::bleed_dps_derivation(avg_hit_bleed_dmg == avg_crit_bleed_dmg || ext.crit_chance == 0.0, bleed_physical_min, bleed_physical_max, bleed_roll_average, bleed_dot_multi, crit_bleed_dot_multi, avg_hit_bleed_dmg, avg_crit_bleed_dmg);
    }
    let (_c2, base_max_val_raw) = calc_ailment_damage(chance_on_hit, chance_on_crit, 100.0, source_max_hit_dmg, source_max_crit_dmg);
    let _base_max_val = base_max_val_raw * base_percent / 100.0 * ext.ruthless_blow_ailment_effect * ext.fist_of_war_damage_effect * ext.ailment_warcry_effect;
    let (_c3, avg_base_bleed_dps) = calc_ailment_damage(chance_on_hit, chance_on_crit, ailment_crit_chance, avg_hit_bleed_dmg, avg_crit_bleed_dmg);
    let base_bleed_dps = avg_base_bleed_dps * base_percent / 100.0 * ext.ruthless_blow_ailment_effect * ext.fist_of_war_damage_effect * ext.ailment_warcry_effect;
    if crate::bd::on() {
        let source_mult = skill_mod_list.more(Some(cfg), &[Sym::new("BleedAsThoughDealing")]);
        crate::bdail::ailment_damage("Bleed", chance_on_hit, chance_on_crit, ailment_crit_chance, avg_hit_bleed_dmg, avg_crit_bleed_dmg, false, ext.crit_chance, source_mult);
    }

    if !(base_bleed_dps > 0.0) {
        return BleedOutput { bleed_physical_min, bleed_physical_max, bleed_dot_multi: Some(bleed_dot_multi), crit_bleed_dot_multi: Some(crit_bleed_dot_multi), base_bleed_dps: None, bleed_dps: None, bleed_chance: Some(_c3), g_bleed_stacks_max: Some(max_stacks), g_bleed_duration: Some(bleed_duration), g_bleed_stack_potential: Some(bleed_stack_potential), g_bleed_roll_average: Some(bleed_roll_average), ..BleedOutput::default() };
    }

    let dot_dps_cap = crate::data::misc("DotDpsCap");
    let mut eff = 1.0;
    let mut g_eff = None;
    if ext.mode_effective {
        let resist = enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalDamageReduction")]).max(0.0).min(crate::data::misc("EnemyPhysicalDamageReductionCap"));
        eff = eff_mult(enemy_db, Some(&dot_cfg), resist, &["DamageTaken", "DamageTakenOverTime", "PhysicalDamageTaken", "PhysicalDamageTakenOverTime"]);
        g_eff = Some(eff);
    }
    let effect_mod = crate::tools::calc_lib_mod_s(skill_mod_list, Some(&dot_cfg), &[pom_engine::sym!("AilmentEffect")]);
    let active_bleeds = bleed_stacks.min(max_stacks);
    let base_bleed_dps_final = base_bleed_dps * effect_mod * rate_mod * active_bleeds * eff;
    let bleed_dps = base_bleed_dps_final.min(dot_dps_cap);
    if crate::bd::on() {
        let taken_names = [pom_engine::sym!("DamageTaken"), pom_engine::sym!("DamageTakenOverTime"), pom_engine::sym!("PhysicalDamageTaken"), pom_engine::sym!("PhysicalDamageTakenOverTime")];
        let resist = enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalDamageReduction")]).max(0.0).min(crate::data::misc("EnemyPhysicalDamageReductionCap"));
        let base_min_val = calc_ailment_damage(chance_on_hit, chance_on_crit, ailment_crit_chance, source_min_hit_dmg, 0.0).1 * base_percent / 100.0;
        let uncapped = |base: f64| base * effect_mod * rate_mod * active_bleeds * eff;
        crate::bdail::bleed_tail(&crate::bdail::BleedTail {
            resist,
            taken_inc: enemy_db.sum(ModType::Inc, Some(&dot_cfg), &taken_names),
            taken_more: enemy_db.more(Some(&dot_cfg), &taken_names),
            eff_mult: eff,
            mode_effective: ext.mode_effective,
            base_percent,
            effect_mod,
            ruthless: ext.ruthless_blow_ailment_effect,
            fist_of_war: ext.fist_of_war_damage_effect,
            warcry: ext.ailment_warcry_effect,
            base_bleed_dps,
            rate_mod,
            active_bleeds,
            bleed_dps_uncapped: base_bleed_dps_final,
            bleed_dps_capped: bleed_dps,
            min_uncapped: uncapped(base_min_val),
            min_capped: uncapped(base_min_val).min(dot_dps_cap),
            max_uncapped: uncapped(_base_max_val),
            max_capped: uncapped(_base_max_val).min(dot_dps_cap),
            bleed_dps,
            duration_base,
            duration_mod,
            debuff_duration_mult: ext.debuff_duration_mult,
            bleed_duration,
            bleed_dot_multi,
            crit_bleed_dot_multi,
            chance_on_hit,
            chance_on_crit,
            global_crit_chance: ext.global_crit_chance,
            ailment_crit_chance,
        });
    }

    BleedOutput {
        bleed_physical_min,
        bleed_physical_max,
        bleed_dot_multi: blend_dot_multi(Some(bleed_dot_multi), Some(crit_bleed_dot_multi), chance_on_hit, chance_on_crit, ext.global_crit_chance, ailment_crit_chance),
        crit_bleed_dot_multi: Some(crit_bleed_dot_multi),
        base_bleed_dps: Some(base_bleed_dps_final),
        bleed_dps: Some(bleed_dps),
        bleed_chance: Some(_c3),
        g_bleed_stacks_max: Some(max_stacks),
        g_bleed_duration: Some(bleed_duration),
        g_bleed_stack_potential: Some(bleed_stack_potential),
        g_bleed_roll_average: Some(bleed_roll_average),
        g_bleed_eff_mult: g_eff,
        g_bleed_stacks: Some(bleed_stacks),
        g_bleed_damage: Some(base_bleed_dps_final * bleed_duration),
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct PoisonOutput {
    pub poison_chaos_min: f64,
    pub poison_chaos_max: f64,
    pub poison_lightning_min: Option<f64>,
    pub poison_lightning_max: Option<f64>,
    pub poison_cold_min: Option<f64>,
    pub poison_cold_max: Option<f64>,
    pub poison_fire_min: Option<f64>,
    pub poison_fire_max: Option<f64>,
    pub poison_physical_min: Option<f64>,
    pub poison_physical_max: Option<f64>,
    pub poison_dot_multi: Option<f64>,
    pub crit_poison_dot_multi: Option<f64>,
    pub poison_dps: Option<f64>,
    pub poison_damage: Option<f64>,
    pub total_poison_dps: Option<f64>,
    pub total_poison_average_damage: Option<f64>,
    pub caustic_ground_dps: Option<f64>,
    /// `globalOutput.PoisonDuration` (4712), `PoisonEffMult` (4855) and `PoisonStacks` (4864).
    pub g_poison_duration: Option<f64>,
    pub g_poison_eff_mult: Option<f64>,
    pub g_poison_stacks: Option<f64>,
    /// `output.PoisonChance` (side output of the last `calcAilmentDamage("Poison", ...)`, 4845).
    pub poison_chance: Option<f64>,
    /// `output.PoisonChanceOnHit/OnCrit` after the chaos-poison chance was folded in (4786-4791).
    pub chance_on_hit_final: Option<f64>,
    pub chance_on_crit_final: Option<f64>,
    /// `Condition:NonPoisonedOnly` would be set on the skill mod list (CalcOffence.lua:4744-4746); the caller adds it and re-runs.
    pub non_poisoned_only: bool,
}

/// Poison (CalcOffence.lua:4685-4988). `chance_on_hit`/`chance_on_crit` are
/// `output.PoisonChanceOnHit`/`OnCrit`; `chaos_poison_chance` is `output.ChaosPoisonChance`
/// (ailments.rs). `hit_avg` supplies `output.ChaosHitAverage` (recorded). Same sub_pass convention
/// as Bleed (1 = non-crit, 2 = crit).
#[allow(clippy::too_many_arguments)]
pub fn calc_poison(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    mod_db: &ModStore,
    cfg: &Cfg,
    output_map: &HashMap<String, f64>,
    conversion_table: &ConversionTable,
    chance_on_hit: f64,
    chance_on_crit: f64,
    chaos_poison_chance: f64,
    hit_avg: &HashMap<&str, f64>,
    show_average: bool,
    stack_multiplier: f64,
    multiplier_poison_on_enemy: f64,
    ext: &DotExternal,
) -> PoisonOutput {
    if !can_deal(skill_mod_list, Some(cfg), "Chaos") || chance_on_hit + chance_on_crit + chaos_poison_chance <= 0.0 {
        return PoisonOutput::default();
    }
    let mut dot_cfg = build_dot_cfg(cfg, KEYWORDFLAG_POISON | KEYWORDFLAG_CHAOS_DOT);
    if crate::bd::on() {
        for k in ["PoisonPhysical", "PoisonLightning", "PoisonCold", "PoisonFire", "PoisonChaos"] {
            crate::bdail::damage_types_table(k);
        }
    }

    let rate_mod = crate::tools::calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("PoisonFaster")]) + enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfPoisonFaster")]) / 100.0;
    let duration_base = skill_mod_list.override_(Some(&dot_cfg), &[pom_engine::sym!("PoisonDurationBase")]).and_then(|v| v.num()).or_else(|| if ext.poison_duration_is_skill_duration { ext.skill_data_duration } else { None }).unwrap_or_else(|| crate::data::misc("PoisonDurationBase"));
    let duration_mod = (crate::tools::calc_lib_mod(skill_mod_list, Some(&dot_cfg), if ext.poison_is_skill_effect { &["EnemyPoisonDuration", "EnemyAilmentDuration", "DamagingAilmentDuration", "Duration"][..] } else { &["EnemyPoisonDuration", "EnemyAilmentDuration", "DamagingAilmentDuration"][..] }) * crate::tools::calc_lib_mod_s(enemy_db, None, &[pom_engine::sym!("SelfPoisonDuration"), pom_engine::sym!("SelfAilmentDuration")])).max(0.0);
    let poison_duration = duration_base * duration_mod / rate_mod * ext.debuff_duration_mult;

    let (chaos_hit_raw, chaos_crit_raw) = chaos_poison_chances(chaos_poison_chance, mod_db.flag(None, &[pom_engine::sym!("AilmentsOnlyFromCrit")]), ext.ailment_mode_crit, mod_db.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]));
    let chaos_hit_average = *hit_avg.get("Chaos").unwrap_or(&0.0);
    let poison_chance_on_hit_eff = (chance_on_hit + if chaos_hit_average > 0.0 { chaos_hit_raw } else { 0.0 }).min(100.0);
    let poison_chance_on_crit_eff = (chance_on_crit + if chaos_hit_average > 0.0 { chaos_crit_raw } else { 0.0 }).min(100.0);
    let poison_chance = poison_chance_on_hit_eff / 100.0 * (1.0 - ext.crit_chance / 100.0) + poison_chance_on_crit_eff / 100.0 * ext.crit_chance / 100.0;

    let additional_poison_stacks = if skill_mod_list.flag(None, &[pom_engine::sym!("CannotMultiplePoison")]) {
        1.0
    } else {
        1.0 + (skill_mod_list.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("AdditionalPoisonChance")]) / 100.0).min(1.0) + skill_mod_list.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("AdditionalPoisonStacks")])
    };
    let poison_stack_limit = skill_mod_list.min(Some(cfg), &[pom_engine::sym!("PoisonStackLimit")]);
    let mut uncapped_poison_stacks: Option<f64> = None;
    let mut poison_stacks = ext.hit_chance / 100.0 * poison_chance * additional_poison_stacks * ext.dps_multiplier * stack_multiplier * ext.quantity_multiplier;
    if ext.hit_speed_or_speed > 0.0 {
        poison_stacks = poison_stacks * poison_duration * ext.hit_speed_or_speed;
        if let Some(limit) = poison_stack_limit {
            if limit > 0.0 && poison_stacks > limit {
                let num_poisoning_hits = (limit / additional_poison_stacks).ceil();
                let max_poison_stacks = num_poisoning_hits * additional_poison_stacks;
                uncapped_poison_stacks = Some(poison_stacks.max(max_poison_stacks));
                poison_stacks = poison_stacks.min(max_poison_stacks);
            }
        }
    }
    // `Condition:NonPoisonedOnly` (CalcOffence.lua:4744-4746, 4861-4863): computed directly instead
    // of round-tripping through a NewMod this crate's immutable ModStore snapshots can't apply.
    let non_poisoned_only = poison_stacks < additional_poison_stacks && multiplier_poison_on_enemy == 0.0;
    if crate::bd::on() {
        crate::bdg::poison_tables();
        crate::bdg::poison_stacks(&crate::bdg::PoisonStacksBd {
            duration: poison_duration,
            chance: poison_chance,
            hit_chance: ext.hit_chance,
            additional: additional_poison_stacks,
            hit_speed: ext.hit_speed_or_speed,
            dps_mult: ext.dps_multiplier,
            stack_mult: stack_multiplier,
            quantity_mult: ext.quantity_multiplier,
            stacks: poison_stacks,
            non_poisoned_flag: skill_mod_list.flag(None, &[pom_engine::sym!("Condition:NonPoisonedOnly")]),
            limit: poison_stack_limit,
            uncapped: uncapped_poison_stacks,
        });
    }

    let dot_multi = |c: &Cfg| -> f64 {
        1.0 + skill_mod_list
            .override_(Some(c), &[pom_engine::sym!("DotMultiplier")])
            .and_then(|v| v.num())
            .unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(c), &[pom_engine::sym!("DotMultiplier")]) + skill_mod_list.sum(ModType::Base, Some(c), &[pom_engine::sym!("ChaosDotMultiplier")]))
            / 100.0
    };

    let mut chance_on_hit_mut = chance_on_hit;
    let mut chance_on_crit_mut = chance_on_crit;
    let mut out = PoisonOutput::default();
    out.non_poisoned_only = non_poisoned_only;
    out.g_poison_duration = Some(poison_duration);
    let (mut source_hit_dmg, mut source_crit_dmg, mut source_max_crit_dmg, mut source_min_hit_dmg, mut source_max_hit_dmg) = (0.0, 0.0, 0.0, 0.0, 0.0);

    for sub_pass in 1..=2 {
        set_crit_cond(&mut dot_cfg, sub_pass != 1);
        let mut total_min = 0.0;
        let mut total_max = 0.0;
        // `sub_pass == 1 and breakdown and breakdown.Poison<Type>`: the damage-type table of the first sub-pass.
        let bdk = |n: &'static str| -> Option<&'static str> { if sub_pass == 1 && crate::bd::on() { Some(n) } else { None } };

        let (cmin, cmax) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Chaos", DmgTypeFlags::default(), bdk("PoisonChaos"));
        out.poison_chaos_min = cmin;
        out.poison_chaos_max = cmax;
        total_min += cmin;
        total_max += cmax;

        let mut non_chaos_mult = 1.0;
        let chaos_pass = if sub_pass == 2 { chaos_crit_raw } else { chaos_hit_raw };
        if chaos_pass > 0.0 && out.poison_chaos_max > 0.0 {
            let current = if sub_pass == 2 { chance_on_crit_mut } else { chance_on_hit_mut };
            let chaos_chance = (current + chaos_pass).min(100.0);
            non_chaos_mult = current / chaos_chance;
            if sub_pass == 2 {
                chance_on_crit_mut = chaos_chance;
            } else {
                chance_on_hit_mut = chaos_chance;
            }
        }
        if can_deal(skill_mod_list, Some(cfg), "Lightning") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("LightningCanPoison")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Lightning", DmgTypeFlags::default().with("Chaos"), bdk("PoisonLightning"));
            out.poison_lightning_min = Some(min);
            out.poison_lightning_max = Some(max);
            total_min += min * non_chaos_mult;
            total_max += max * non_chaos_mult;
        }
        if can_deal(skill_mod_list, Some(cfg), "Cold") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("ColdCanPoison")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Cold", DmgTypeFlags::default().with("Chaos"), bdk("PoisonCold"));
            out.poison_cold_min = Some(min);
            out.poison_cold_max = Some(max);
            total_min += min * non_chaos_mult;
            total_max += max * non_chaos_mult;
        }
        if can_deal(skill_mod_list, Some(cfg), "Fire") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("FireCanPoison")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Fire", DmgTypeFlags::default().with("Chaos"), bdk("PoisonFire"));
            out.poison_fire_min = Some(min);
            out.poison_fire_max = Some(max);
            total_min += min * non_chaos_mult;
            total_max += max * non_chaos_mult;
        }
        if can_deal(skill_mod_list, Some(cfg), "Physical") {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Physical", DmgTypeFlags::default().with("Chaos"), bdk("PoisonPhysical"));
            out.poison_physical_min = Some(min);
            out.poison_physical_max = Some(max);
            total_min += min * non_chaos_mult;
            total_max += max * non_chaos_mult;
        }

        if sub_pass == 2 {
            let crit_poison_dot_multi = if mod_db.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]) {
                set_crit_cond(&mut dot_cfg, false);
                let v = dot_multi(&dot_cfg);
                set_crit_cond(&mut dot_cfg, true);
                v
            } else {
                dot_multi(&dot_cfg)
            };
            out.crit_poison_dot_multi = Some(crit_poison_dot_multi);
            source_crit_dmg = (total_min + total_max) / 2.0 * crit_poison_dot_multi;
            source_max_crit_dmg = total_max * crit_poison_dot_multi;
        } else {
            let poison_dot_multi = dot_multi(&dot_cfg);
            out.poison_dot_multi = Some(poison_dot_multi);
            source_hit_dmg = (total_min + total_max) / 2.0 * poison_dot_multi;
            source_min_hit_dmg = total_min * poison_dot_multi;
            source_max_hit_dmg = total_max * poison_dot_multi;
        }
    }

    if crate::bd::on() {
        crate::bdg::poison_mode();
    }
    let poison_percent_base = crate::data::misc("PoisonPercentBase");
    let (_c1, base_min_val_raw) = calc_ailment_damage(chance_on_hit_mut, chance_on_crit_mut, ext.crit_chance, source_min_hit_dmg, 0.0);
    let _base_min_val = base_min_val_raw * poison_percent_base;
    let (_c2, base_max_val_raw) = calc_ailment_damage(chance_on_hit_mut, chance_on_crit_mut, 100.0, source_max_hit_dmg, source_max_crit_dmg);
    let _base_max_val = base_max_val_raw * poison_percent_base * ext.ruthless_blow_ailment_effect * ext.fist_of_war_damage_effect * ext.ailment_warcry_effect;
    let (_c3, base_val_raw) = calc_ailment_damage(chance_on_hit_mut, chance_on_crit_mut, ext.crit_chance, source_hit_dmg, source_crit_dmg);
    if crate::bd::on() {
        let source_mult = skill_mod_list.more(Some(cfg), &[Sym::new("PoisonAsThoughDealing")]);
        crate::bdail::ailment_damage("Poison", chance_on_hit_mut, chance_on_crit_mut, ext.crit_chance, source_hit_dmg, source_crit_dmg, false, ext.crit_chance, source_mult);
    }
    let base_val = base_val_raw * poison_percent_base * ext.ruthless_blow_ailment_effect * ext.fist_of_war_damage_effect * ext.ailment_warcry_effect;
    out.poison_chance = Some(_c3);

    if !(base_val > 0.0) {
        return out;
    }

    let dot_dps_cap = crate::data::misc("DotDpsCap");
    let mut eff = 1.0;
    if ext.mode_effective {
        let resist = calc_resist_for_type(enemy_db, Some(&dot_cfg), "Chaos", ext.enemy_resist_config.get("Chaos").copied());
        eff = eff_mult(enemy_db, Some(&dot_cfg), resist, &["DamageTaken", "DamageTakenOverTime", "ChaosDamageTaken", "ChaosDamageTakenOverTime"]);
        out.g_poison_eff_mult = Some(eff);
        if crate::bd::on() {
            let source_res = if mod_db.flag(None, &[pom_engine::sym!("EnemyChaosResistEqualToYours")]) { "Your Chaos Resistance" } else { "Chaos" };
            crate::bdg::eff_mult_table("PoisonEffMult", enemy_db, &dot_cfg, "Chaos", resist, &["DamageTaken", "DamageTakenOverTime", "ChaosDamageTaken", "ChaosDamageTakenOverTime"], eff, source_res);
        }
    }
    let mut effective_poison_stacks = poison_stacks;
    if non_poisoned_only {
        effective_poison_stacks = additional_poison_stacks.min(poison_stacks);
    }
    out.g_poison_stacks = Some(effective_poison_stacks);
    let effect_mod = crate::tools::calc_lib_mod_s(skill_mod_list, Some(&dot_cfg), &[pom_engine::sym!("AilmentEffect")]);
    let single_poison_dps_uncapped = (base_val * effect_mod * rate_mod * eff).min(dot_dps_cap);
    let single_poison_dps_capped = single_poison_dps_uncapped.min(dot_dps_cap);
    out.poison_dps = Some(single_poison_dps_capped);
    out.poison_damage = Some(single_poison_dps_capped * poison_duration);
    let (bd_dot_multi, bd_crit_dot_multi) = (out.poison_dot_multi, out.crit_poison_dot_multi);
    out.poison_dot_multi = blend_dot_multi(out.poison_dot_multi, out.crit_poison_dot_multi, chance_on_hit_mut, chance_on_crit_mut, ext.global_crit_chance, ext.global_crit_chance);
    out.chance_on_hit_final = Some(chance_on_hit_mut);
    out.chance_on_crit_final = Some(chance_on_crit_mut);

    let ground_mult = skill_mod_list.max(None, &[pom_engine::sym!("PoisonDpsAsCausticGround")]).unwrap_or(0.0).max(enemy_db.max(None, &[pom_engine::sym!("PoisonDpsAsCausticGround")]).unwrap_or(0.0));
    if ground_mult > 0.0 {
        let caustic_ground_dps_uncapped = base_val * effect_mod * rate_mod * eff * ground_mult / 100.0;
        out.caustic_ground_dps = Some(caustic_ground_dps_uncapped.min(dot_dps_cap));
    }

    if show_average {
        out.total_poison_average_damage = out.poison_damage;
        out.total_poison_dps = out.poison_dps;
    } else {
        let poison_dps_uncapped = single_poison_dps_capped * effective_poison_stacks;
        out.total_poison_dps = Some(poison_dps_uncapped.min(dot_dps_cap));
    }

    if crate::bd::on() {
        crate::bdg::poison_main(&crate::bdg::PoisonMain {
            base_val,
            effect_mod,
            rate_mod,
            eff,
            ruthless: ext.ruthless_blow_ailment_effect,
            single_uncapped: single_poison_dps_uncapped,
            single_capped: single_poison_dps_capped,
            base_min_val: _base_min_val,
            base_max_val: _base_max_val,
            dot_dps_cap,
            dot_multi: bd_dot_multi,
            crit_dot_multi: bd_crit_dot_multi,
            chance_on_hit: chance_on_hit_mut,
            chance_on_crit: chance_on_crit_mut,
            global_crit_chance: ext.global_crit_chance,
            show_average,
            stacks: effective_poison_stacks,
            duration: poison_duration,
            duration_base,
            duration_mod,
            debuff_duration_mult: ext.debuff_duration_mult,
            ground_mult,
            caustic_ground_dps: out.caustic_ground_dps,
        });
    }

    out
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct IgniteOutput {
    pub ignite_physical_min: Option<f64>,
    pub ignite_physical_max: Option<f64>,
    pub ignite_lightning_min: Option<f64>,
    pub ignite_lightning_max: Option<f64>,
    pub ignite_cold_min: Option<f64>,
    pub ignite_cold_max: Option<f64>,
    pub ignite_fire_min: Option<f64>,
    pub ignite_fire_max: Option<f64>,
    pub ignite_chaos_min: Option<f64>,
    pub ignite_chaos_max: Option<f64>,
    pub ignite_total_min: f64,
    pub ignite_total_max: f64,
    pub ignite_dot_multi: Option<f64>,
    pub crit_ignite_dot_multi: Option<f64>,
    pub ignite_dps: Option<f64>,
    pub ignite_damage: Option<f64>,
    pub ignite_stacks_max: Option<f64>,
    pub total_ignite_dps: Option<f64>,
    /// `output.IgniteChance` (side output of the last `calcAilmentDamage("Ignite", ...)`, 5186).
    pub ignite_chance: Option<f64>,
    /// `globalOutput.IgniteChancePerHit` / `IgniteStacksMax` / `IgniteDuration` / `IgniteStackPotential` /
    /// `IgniteRollAverage` (5014-5082, set before the `baseVal > 0` gate) and `IgniteEffMult` (5199+).
    pub g_ignite_chance_per_hit: Option<f64>,
    pub g_ignite_stacks_max: Option<f64>,
    pub g_ignite_duration: Option<f64>,
    pub g_ignite_stack_potential: Option<f64>,
    pub g_ignite_roll_average: Option<f64>,
    pub g_ignite_eff_mult: Option<f64>,
    /// `globalOutput.BurningGroundDPS` (`IgniteDpsAsBurningGround`, 5222-5232); `BurningGroundFromIgnite` is then true.
    pub g_burning_ground_dps: Option<f64>,
}

/// Ignite (CalcOffence.lua:4990-5330). `chance_on_hit`/`chance_on_crit` are
/// `output.IgniteChanceOnHit`/`OnCrit`. Same sub_pass convention as Bleed/Poison.
#[allow(clippy::too_many_arguments)]
pub fn calc_ignite(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    mod_db: &ModStore,
    cfg: &Cfg,
    output_map: &HashMap<String, f64>,
    conversion_table: &ConversionTable,
    chance_on_hit: f64,
    chance_on_crit: f64,
    ignite_to_chaos: bool,
    ext: &DotExternal,
) -> IgniteOutput {
    let mut out = IgniteOutput::default();
    if !can_deal(skill_mod_list, Some(cfg), "Fire") || chance_on_hit + chance_on_crit <= 0.0 {
        return out;
    }
    let mut dot_cfg = build_dot_cfg(cfg, KEYWORDFLAG_IGNITE | KEYWORDFLAG_FIRE_DOT);
    if crate::bd::on() {
        crate::bdg::ignite_tables();
    }

    let ignite_can_stack = skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("IgniteCanStack")]);
    let max_stacks = if ignite_can_stack {
        skill_mod_list.override_(Some(cfg), &[pom_engine::sym!("IgniteStacks")]).and_then(|v| v.num()).unwrap_or_else(|| 1.0 + skill_mod_list.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("IgniteStacks")]))
    } else {
        1.0
    };
    let override_stack_potential = skill_mod_list.override_(None, &[pom_engine::sym!("IgniteStackPotentialOverride")]).and_then(|v| v.num()).map(|v| v / max_stacks);

    let rate_mod = (crate::tools::calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("IgniteBurnFaster")]) + enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfIgniteBurnFaster")]) / 100.0) / crate::tools::calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("IgniteBurnSlower")]);
    let duration_base = skill_mod_list.override_(Some(&dot_cfg), &[pom_engine::sym!("IgniteDurationBase")]).and_then(|v| v.num()).unwrap_or_else(|| crate::data::misc("IgniteDurationBase"));
    let duration_mod = (crate::tools::calc_lib_mod_s(skill_mod_list, Some(&dot_cfg), &[pom_engine::sym!("EnemyIgniteDuration"), pom_engine::sym!("EnemyAilmentDuration"), pom_engine::sym!("EnemyElementalAilmentDuration"), pom_engine::sym!("DamagingAilmentDuration")])
        * crate::tools::calc_lib_mod_s(enemy_db, None, &[pom_engine::sym!("SelfIgniteDuration"), pom_engine::sym!("SelfAilmentDuration"), pom_engine::sym!("SelfElementalAilmentDuration")]))
    .max(0.0);
    let ignite_duration = duration_base * duration_mod / rate_mod * ext.debuff_duration_mult;

    let ignite_chance = chance_on_hit / 100.0 * (1.0 - ext.crit_chance / 100.0) + chance_on_crit / 100.0 * ext.crit_chance / 100.0;
    let mut ignite_stacks = ext.hit_chance / 100.0 * ignite_chance * ext.dps_multiplier;
    if !ext.triggered_on_death {
        if let Some(cooldown) = ext.cooldown {
            ignite_stacks *= ignite_duration / cooldown.max(ext.hit_time_or_time);
        } else if ext.hit_speed_or_speed > 0.0 {
            ignite_stacks = ignite_stacks * ignite_duration * ext.hit_speed_or_speed;
        }
    }
    let ignite_stack_potential = override_stack_potential.unwrap_or(ignite_stacks / max_stacks);
    let ignite_roll_average = if ignite_stack_potential > 1.0 { (ignite_stacks - (max_stacks - 1.0) / 2.0) / (ignite_stacks + 1.0) * 100.0 } else { 50.0 };
    out.g_ignite_chance_per_hit = Some(chance_on_hit * (1.0 - ext.crit_chance / 100.0) + chance_on_crit * ext.crit_chance / 100.0);
    out.g_ignite_stacks_max = Some(max_stacks);
    out.g_ignite_duration = Some(ignite_duration);
    out.g_ignite_stack_potential = Some(ignite_stack_potential);
    out.g_ignite_roll_average = Some(ignite_roll_average);
    if crate::bd::on() {
        crate::bdg::ignite_head(&crate::bdg::IgniteHead {
            max_stacks,
            override_raw: skill_mod_list.override_(None, &[pom_engine::sym!("IgniteStackPotentialOverride")]).and_then(|v| v.num()),
            hit_chance: ext.hit_chance,
            ignite_chance,
            triggered_on_death: ext.triggered_on_death,
            cooldown: ext.cooldown,
            hit_time_or_time: ext.hit_time_or_time,
            hit_speed_or_speed: ext.hit_speed_or_speed,
            dps_multiplier: ext.dps_multiplier,
            duration: ignite_duration,
            stacks: ignite_stacks,
            stack_potential: ignite_stack_potential,
            roll_average: ignite_roll_average,
        });
    }

    let dot_multi = |c: &Cfg| -> f64 {
        if pom_engine::env::var("POM_DEBUG_DOT").is_ok() {
            for (v, m) in skill_mod_list.tabulate(Some(ModType::Base), Some(c), &[pom_engine::sym!("DotMultiplier"), pom_engine::sym!("FireDotMultiplier")]) {
                let m = unsafe { &*m };
                eprintln!("IGNITE DotMulti {:?} {:?} flags={} kw={} tags={:?}", m.source, v, m.flags, m.keyword_flags, m.tags.iter().map(|g| g.kind.as_str().to_string()).collect::<Vec<_>>());
            }
        }
        1.0 + skill_mod_list
            .override_(Some(c), &[pom_engine::sym!("DotMultiplier")])
            .and_then(|v| v.num())
            .unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(c), &[pom_engine::sym!("DotMultiplier")]) + skill_mod_list.sum(ModType::Base, Some(c), &[pom_engine::sym!("FireDotMultiplier")]))
            / 100.0
    };

    let (mut source_hit_dmg, mut source_crit_dmg, mut source_max_crit_dmg, mut source_min_hit_dmg, mut source_max_hit_dmg) = (0.0, 0.0, 0.0, 0.0, 0.0);

    for sub_pass in 1..=2 {
        set_crit_cond(&mut dot_cfg, sub_pass != 1);
        let mut total_min = 0.0;
        let mut total_max = 0.0;
        let fire_flag = DmgTypeFlags::default().with("Fire");
        // `sub_pass == 1 and breakdown and breakdown.Ignite<Type>`: the damage-type table of the first sub-pass.
        let bdk = |n: &'static str| -> Option<&'static str> { if sub_pass == 1 && crate::bd::on() { Some(n) } else { None } };

        if can_deal(skill_mod_list, Some(cfg), "Physical") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("PhysicalCanIgnite")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Physical", fire_flag, bdk("IgnitePhysical"));
            out.ignite_physical_min = Some(min);
            out.ignite_physical_max = Some(max);
            total_min += min;
            total_max += max;
        }
        if can_deal(skill_mod_list, Some(cfg), "Lightning") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("LightningCanIgnite")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Lightning", fire_flag, bdk("IgniteLightning"));
            out.ignite_lightning_min = Some(min);
            out.ignite_lightning_max = Some(max);
            total_min += min;
            total_max += max;
        }
        if can_deal(skill_mod_list, Some(cfg), "Cold") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("ColdCanIgnite")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Cold", fire_flag, bdk("IgniteCold"));
            out.ignite_cold_min = Some(min);
            out.ignite_cold_max = Some(max);
            total_min += min;
            total_max += max;
        }
        if can_deal(skill_mod_list, Some(cfg), "Fire") && !skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("FireCannotIgnite")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Fire", DmgTypeFlags::default(), bdk("IgniteFire"));
            out.ignite_fire_min = Some(min);
            out.ignite_fire_max = Some(max);
            total_min += min;
            total_max += max;
        }
        if can_deal(skill_mod_list, Some(cfg), "Chaos") && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("ChaosCanIgnite")]) {
            let (min, max) = calc_ailment_source_damage(skill_mod_list, output_map, Some(&dot_cfg), conversion_table, "Chaos", fire_flag, bdk("IgniteChaos"));
            out.ignite_chaos_min = Some(min);
            out.ignite_chaos_max = Some(max);
            total_min += min;
            total_max += max;
        }

        if sub_pass == 2 {
            let crit_ignite_dot_multi = if mod_db.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]) {
                set_crit_cond(&mut dot_cfg, false);
                let v = dot_multi(&dot_cfg);
                set_crit_cond(&mut dot_cfg, true);
                v
            } else {
                dot_multi(&dot_cfg)
            };
            out.crit_ignite_dot_multi = Some(crit_ignite_dot_multi);
            source_crit_dmg = (total_min + (total_max - total_min) * ignite_roll_average / 100.0) * crit_ignite_dot_multi;
            source_max_crit_dmg = total_max * crit_ignite_dot_multi;
        } else {
            let ignite_dot_multi = dot_multi(&dot_cfg);
            out.ignite_dot_multi = Some(ignite_dot_multi);
            source_hit_dmg = (total_min + (total_max - total_min) * ignite_roll_average / 100.0) * ignite_dot_multi;
            source_min_hit_dmg = total_min * ignite_dot_multi;
            source_max_hit_dmg = total_max * ignite_dot_multi;
        }
        out.ignite_total_min = total_min;
        out.ignite_total_max = total_max;
    }

    if crate::bd::on() {
        crate::bdg::ignite_derivation(out.ignite_total_min, out.ignite_total_max, ignite_roll_average, out.ignite_dot_multi.unwrap_or(0.0), out.crit_ignite_dot_multi.unwrap_or(0.0), source_hit_dmg, source_crit_dmg, ext.crit_chance);
    }
    let ignite_percent_base = crate::data::misc("IgnitePercentBase");
    let ailment_crit_chance = 100.0 * (1.0 - (1.0 - ext.crit_chance / 100.0).powf(ignite_stacks.max(1.0)));
    let (_c1, base_min_val_raw) = calc_ailment_damage(chance_on_hit, chance_on_crit, ailment_crit_chance, source_min_hit_dmg, 0.0);
    let _base_min_val = base_min_val_raw * ignite_percent_base;
    let (_c2, base_max_val_raw) = calc_ailment_damage(chance_on_hit, chance_on_crit, 100.0, source_max_hit_dmg, source_max_crit_dmg);
    let _base_max_val = base_max_val_raw * ignite_percent_base * ext.ruthless_blow_ailment_effect * ext.fist_of_war_damage_effect * ext.ailment_warcry_effect;
    let (_c3, base_val_raw) = calc_ailment_damage(chance_on_hit, chance_on_crit, ailment_crit_chance, source_hit_dmg, source_crit_dmg);
    if crate::bd::on() {
        let source_mult = skill_mod_list.more(Some(cfg), &[Sym::new("IgniteAsThoughDealing")]);
        crate::bdail::ailment_damage("Ignite", chance_on_hit, chance_on_crit, ailment_crit_chance, source_hit_dmg, source_crit_dmg, false, ext.crit_chance, source_mult);
    }
    let base_val = base_val_raw * ignite_percent_base * ext.ruthless_blow_ailment_effect * ext.fist_of_war_damage_effect * ext.ailment_warcry_effect;
    out.ignite_chance = Some(_c3);

    if !(base_val > 0.0) {
        return out;
    }

    let dot_dps_cap = crate::data::misc("DotDpsCap");
    let mut eff = 1.0;
    if ext.mode_effective {
        let (resist, taken_names): (f64, &[&str]) = if ignite_to_chaos {
            (calc_resist_for_type(enemy_db, Some(&dot_cfg), "Chaos", ext.enemy_resist_config.get("Chaos").copied()), &["DamageTaken", "DamageTakenOverTime", "ChaosDamageTaken", "ChaosDamageTakenOverTime"])
        } else {
            (calc_resist_for_type(enemy_db, Some(&dot_cfg), "Fire", ext.enemy_resist_config.get("Fire").copied()), &["DamageTaken", "DamageTakenOverTime", "FireDamageTaken", "FireDamageTakenOverTime", "ElementalDamageTaken"])
        };
        eff = eff_mult(enemy_db, Some(&dot_cfg), resist, taken_names);
        out.g_ignite_eff_mult = Some(eff);
        if crate::bd::on() {
            let (dt, flag_name, own, other) = if ignite_to_chaos { ("Chaos", "EnemyChaosResistEqualToYours", "Your Chaos Resistance", "Chaos") } else { ("Fire", "EnemyFireResistEqualToYours", "Your Fire Resistance", "Fire") };
            let source_res = if mod_db.flag(None, &[Sym::new(flag_name)]) { own } else { other };
            crate::bdg::eff_mult_table("IgniteEffMult", enemy_db, &dot_cfg, dt, resist, taken_names, eff, source_res);
        }
    }
    let effect_mod = crate::tools::calc_lib_mod_s(skill_mod_list, Some(&dot_cfg), &[pom_engine::sym!("AilmentEffect")]);
    let active_ignites = ignite_stacks.min(max_stacks);
    let ignite_dps_uncapped = base_val * effect_mod * rate_mod * active_ignites * eff;
    let ignite_dps = ignite_dps_uncapped.min(dot_dps_cap);
    out.ignite_dps = Some(ignite_dps);
    let ground_mult = skill_mod_list.max(None, &[pom_engine::sym!("IgniteDpsAsBurningGround")]).unwrap_or(0.0).max(enemy_db.max(None, &[pom_engine::sym!("IgniteDpsAsBurningGround")]).unwrap_or(0.0));
    if ground_mult > 0.0 {
        // Always use the fire effective multiplier (5224-5228).
        let resist = calc_resist_for_type(enemy_db, Some(&dot_cfg), "Fire", ext.enemy_resist_config.get("Fire").copied());
        let fire_eff_mult = eff_mult(enemy_db, Some(&dot_cfg), resist, &["DamageTaken", "DamageTakenOverTime", "FireDamageTaken", "FireDamageTakenOverTime", "ElementalDamageTaken"]);
        out.g_burning_ground_dps = Some((base_val * effect_mod * rate_mod * fire_eff_mult * ground_mult / 100.0).min(dot_dps_cap));
        if crate::bd::on() {
            crate::bdg::burning_ground(base_val * effect_mod * rate_mod, ground_mult, fire_eff_mult, out.g_burning_ground_dps.unwrap_or(0.0));
        }
    }

    let (bd_dot_multi, bd_crit_dot_multi) = (out.ignite_dot_multi, out.crit_ignite_dot_multi);
    out.ignite_dot_multi = blend_dot_multi(out.ignite_dot_multi, out.crit_ignite_dot_multi, chance_on_hit, chance_on_crit, ext.global_crit_chance, ailment_crit_chance);
    out.ignite_damage = Some(ignite_dps * ignite_duration);
    if ignite_can_stack {
        out.ignite_stacks_max = Some(max_stacks);
        out.total_ignite_dps = Some(ignite_dps);
    }
    if crate::bd::on() {
        crate::bdg::ignite_main(&crate::bdg::IgniteMain {
            base_val,
            ruthless: ext.ruthless_blow_ailment_effect,
            effect_mod,
            rate_mod,
            active_ignites,
            eff,
            dps_uncapped: ignite_dps_uncapped,
            dps_capped: ignite_dps,
            min_uncapped: _base_min_val * effect_mod * rate_mod * active_ignites * eff,
            max_uncapped: _base_max_val * effect_mod * rate_mod * active_ignites * eff,
            dot_dps_cap,
            dot_multi: bd_dot_multi,
            crit_dot_multi: bd_crit_dot_multi,
            chance_on_hit,
            chance_on_crit,
            global_crit_chance: ext.global_crit_chance,
            ailment_crit_chance,
            ignite_can_stack,
            duration: ignite_duration,
            duration_base,
            duration_mod,
            debuff_duration_mult: ext.debuff_duration_mult,
            base_duration_const: crate::data::misc("IgniteDurationBase"),
        });
    }

    out
}

// Additional ModFlag/KeywordFlag bits needed for the TotalDot section (Data/Global.lua).
const MODFLAG_AREA: u64 = 0x00000200;
const MODFLAG_PROJECTILE: u64 = 0x00000400;
const MODFLAG_SPELL: u64 = 0x00000002;
const MODFLAG_ATTACK: u64 = 0x00000001;
const MODFLAG_HIT: u64 = 0x00000004;
const KEYWORDFLAG_MINE: u64 = 0x00002000;
const KEYWORDFLAG_TRAP: u64 = 0x00001000;
const KEYWORDFLAG_LIGHTNING_DOT: u64 = 0x02000000;
const KEYWORDFLAG_COLD_DOT: u64 = 0x04000000;
const SKILLTYPE_REMOTE_MINED: i64 = 36;
const SKILLTYPE_AURA: i64 = 39;
const SKILLTYPE_BANNER: i64 = 88;
const SKILLTYPE_BRAND: i64 = 65;

fn keyword_dot_bit(damage_type: &str) -> u64 {
    match damage_type {
        "Physical" => KEYWORDFLAG_PHYSICAL_DOT,
        "Lightning" => KEYWORDFLAG_LIGHTNING_DOT,
        "Cold" => KEYWORDFLAG_COLD_DOT,
        "Fire" => KEYWORDFLAG_FIRE_DOT,
        "Chaos" => KEYWORDFLAG_CHAOS_DOT,
        _ => panic!("keyword_dot_bit: unknown damage type {damage_type}"),
    }
}

/// Per-damage-type generic DoT result (CalcOffence.lua:5809-5859): `output[<Type>Dot]` /
/// `output[<Type>DotEffMult]`, only produced when `baseVal > 0` (this crate's isolation layer
/// assumes `output[<Type>Dot]` was never pre-set by a skill-specific hook - see dot.rs's
/// `calc_total_dot` doc for the named gap this implies).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct DotTypeResult {
    pub dot: f64,
    pub dot_eff_mult: Option<f64>,
    /// The locals the Calcs breakdown of this type needs (only filled while `bd::on()`).
    pub bd: Option<DotBd>,
}

/// `breakdown.dot(...)` / `breakdown.effMult(...)` inputs of one generic DoT type (CalcOffence.lua:5817-5857).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct DotBd {
    pub base_val: f64,
    pub inc: f64,
    pub more: f64,
    pub mult: f64,
    pub aura: f64,
    pub resist: f64,
    pub taken_inc: f64,
    pub taken_more: f64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct TotalDotOutput {
    pub physical: DotTypeResult,
    pub lightning: DotTypeResult,
    pub cold: DotTypeResult,
    pub fire: DotTypeResult,
    pub chaos: DotTypeResult,
    pub total_dot_instance: f64,
    pub total_dot: f64,
    pub total_dot_calc_section: f64,
    pub burning_ground_dps: Option<f64>,
    pub caustic_ground_dps: Option<f64>,
    pub corrupting_blood_dps: Option<f64>,
    /// `output.BurningGroundFromIgnite = false` (5892) was executed.
    pub burning_ground_from_ignite_false: bool,
    /// `output.CausticGroundFromPoison = false` (5899) was executed.
    pub caustic_ground_from_poison_false: bool,
}

/// Inputs to the final `TotalDot`/`TotalDotCalcSection` branch (CalcOffence.lua:5861-5914) that
/// come from outside this crate's scope: `output.Speed`/`MineLayingSpeed`/`TrapThrowingSpeed`
/// (speed/hit-path), `output.Duration` (cooldown.rs, already ported but a *different* skill call's
/// pass - taken as recorded here), `output.AttachedBrandCount` (misc_fields.rs, already ported -
/// same note), `skillData.dpsMultiplier`/`countsAttachedBrandsInDamage`.
pub struct TotalDotTailExternal {
    pub speed: f64,
    pub mine_laying_speed: f64,
    pub trap_throwing_speed: f64,
    pub duration: f64,
    pub attached_brand_count: f64,
    pub dps_multiplier: f64,
    pub quantity_multiplier: f64,
}

/// `skillData.<Type>Dot` raw base values (e.g. `skillData.PhysicalDot`), and the pre-existing
/// ground DPS values Poison/Ignite's own `groundMult` branch may have already set
/// (`output.BurningGroundDPS`/`CausticGroundDPS`, from `calc_ignite`/`calc_poison` above).
pub struct TotalDotInputs {
    pub skill_data_dot: HashMap<&'static str, f64>, // "Physical"/"Lightning"/"Cold"/"Fire"/"Chaos" -> skillData.<Type>Dot
    pub burning_ground_dps_pre: Option<f64>,
    pub caustic_ground_dps_pre: Option<f64>,
    pub skill_types: pom_engine::fxhash::HashSet<i64>,
    pub skill_data_dot_is_area: bool,
    pub skill_data_dot_is_projectile: bool,
    pub skill_data_dot_is_spell: bool,
    pub skill_data_dot_is_attack: bool,
    pub skill_data_dot_is_hit: bool,
    pub skill_data_counts_attached_brands_in_damage: bool,
    pub mode_effective: bool,
}

/// The generic DoT build + final combine (CalcOffence.lua:5771-5914). Only the "else" (brand-count)
/// branch and the three ground/stacking branches are graded meaningfully without the un-ported
/// hit-path `output.Speed`/`Duration` - callers pass those in as recorded (`ext`).
pub fn calc_total_dot(skill_mod_list: &ModStore, enemy_db: &ModStore, cfg: &Cfg, inputs: &TotalDotInputs, ext: &TotalDotTailExternal) -> TotalDotOutput {
    // A fresh table in the Lua (5772-5780), like `build_dot_cfg` above - no `skillCond` field at
    // all here (so no Condition:*-gated mod ever matches against it, matching a nil Lua table).
    let mut dot_cfg = Cfg {
        flags: MODFLAG_DOT | cfg.flags,
        keyword_flags: cfg.keyword_flags & !KEYWORDFLAG_HIT,
        skill_name: cfg.skill_name.clone(),
        summon_skill_name: cfg.summon_skill_name.clone(),
        skill_types: cfg.skill_types.clone(),
        slot_name: cfg.slot_name.clone(),
        skill_part: cfg.skill_part,
        ..Cfg::default()
    };
    let strip_if = |flags: &mut u64, bit: u64, keep: bool| {
        if *flags & bit == bit && !keep {
            *flags &= !bit;
        }
    };
    strip_if(&mut dot_cfg.flags, MODFLAG_AREA, inputs.skill_data_dot_is_area);
    strip_if(&mut dot_cfg.flags, MODFLAG_PROJECTILE, inputs.skill_data_dot_is_projectile);
    strip_if(&mut dot_cfg.flags, MODFLAG_SPELL, inputs.skill_data_dot_is_spell);
    strip_if(&mut dot_cfg.flags, MODFLAG_ATTACK, inputs.skill_data_dot_is_attack);
    strip_if(&mut dot_cfg.flags, MODFLAG_HIT, inputs.skill_data_dot_is_hit);

    let mut dot_taken_cfg = dot_cfg.clone();
    if inputs.skill_data_dot_is_spell {
        dot_taken_cfg.flags &= !MODFLAG_SPELL;
    }

    let mut out = TotalDotOutput::default();
    let dot_dps_cap = crate::data::misc("DotDpsCap");

    for &damage_type in crate::conversion::DMG_TYPES.iter() {
        let mut dot_type_cfg = dot_cfg.clone();
        dot_type_cfg.keyword_flags |= keyword_dot_bit(damage_type);

        let base_val = if can_deal(skill_mod_list, Some(cfg), damage_type) { *inputs.skill_data_dot.get(damage_type).unwrap_or(&0.0) } else { 0.0 };
        if base_val <= 0.0 {
            continue;
        }
        let is_elemental = matches!(damage_type, "Fire" | "Cold" | "Lightning");

        let mut eff_mult_val = 1.0;
        let (mut bd_resist, mut bd_taken_inc, mut bd_taken_more) = (0.0, 0.0, 1.0);
        if inputs.mode_effective {
            let mut taken_names = vec!["DamageTaken".to_string(), "DamageTakenOverTime".to_string(), format!("{damage_type}DamageTaken"), format!("{damage_type}DamageTakenOverTime")];
            let taken_syms: Vec<Sym> = taken_names.iter().map(|s| Sym::new(s)).collect();
            let mut taken_inc = enemy_db.sum(ModType::Inc, Some(&dot_taken_cfg), &taken_syms);
            let mut taken_more = enemy_db.more(Some(&dot_taken_cfg), &taken_syms);
            if is_elemental {
                taken_inc += enemy_db.sum(ModType::Inc, Some(&dot_taken_cfg), &[pom_engine::sym!("ElementalDamageTaken")]);
                taken_more *= enemy_db.more(Some(&dot_taken_cfg), &[pom_engine::sym!("ElementalDamageTaken")]);
            }
            let _ = &mut taken_names;
            let resist = if damage_type == "Physical" {
                enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalDamageReduction")]).min(crate::data::misc("EnemyPhysicalDamageReductionCap")).max(0.0)
            } else {
                calc_resist_for_type(enemy_db, Some(&dot_type_cfg), damage_type, None)
            };
            eff_mult_val = (1.0 - resist / 100.0) * (1.0 + taken_inc / 100.0) * taken_more;
            (bd_resist, bd_taken_inc, bd_taken_more) = (resist, taken_inc, taken_more);
        }

        let mut inc_names = vec!["Damage".to_string(), format!("{damage_type}Damage")];
        if is_elemental {
            inc_names.push("ElementalDamage".to_string());
        }
        let inc_syms: Vec<Sym> = inc_names.iter().map(|s| Sym::new(s)).collect();
        let mut inc = skill_mod_list.sum(ModType::Inc, Some(&dot_type_cfg), &inc_syms);
        if skill_mod_list.flag(None, &[pom_engine::sym!("dotIsHeraldOfAsh")]) {
            inc = (inc - skill_mod_list.sum(ModType::Inc, Some(cfg), &inc_syms)).max(0.0);
        }
        let mut more = skill_mod_list.more(Some(&dot_type_cfg), &inc_syms);
        // Herald of Ash's overkill burn takes only DoT modifiers, so the unflagged MORE Fire/Elemental
        // (Elemental Focus) that upstream leaves in is divided out like the INC pool.
        if crate::data::pom_fixes_on() && skill_mod_list.flag(None, &[pom_engine::sym!("dotIsHeraldOfAsh")]) {
            let hit_more = skill_mod_list.more(Some(cfg), &inc_syms[1..]);
            if hit_more != 0.0 {
                more /= hit_more;
            }
        }
        let mult = skill_mod_list
            .override_(Some(&dot_type_cfg), &[pom_engine::sym!("DotMultiplier")])
            .and_then(|v| v.num())
            .unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(&dot_type_cfg), &[pom_engine::sym!("DotMultiplier")]) + skill_mod_list.sum(ModType::Base, Some(&dot_type_cfg), &[Sym::new(&format!("{damage_type}DotMultiplier"))]));
        let is_aura = inputs.skill_types.contains(&SKILLTYPE_AURA) && !inputs.skill_types.contains(&SKILLTYPE_REMOTE_MINED) && !inputs.skill_types.contains(&SKILLTYPE_BANNER);
        let aura = if is_aura { crate::tools::calc_lib_mod_s(skill_mod_list, Some(&dot_type_cfg), &[pom_engine::sym!("AuraEffect")]) } else { 1.0 };
        let total = base_val * (1.0 + inc / 100.0) * more * (1.0 + mult / 100.0) * aura * eff_mult_val;
        if pom_engine::env::var("POM_DEBUG_DOT_MULT").is_ok() {
            for (_, mp) in skill_mod_list.tabulate(Some(ModType::Base), Some(&dot_type_cfg), &[pom_engine::sym!("DotMultiplier"), Sym::new(&format!("{damage_type}DotMultiplier"))]) {
                let m = unsafe { &*mp };
                eprintln!("DOTMULT {damage_type} {} {:?} src={:?} flags={} kf={} tags={:?}", m.name.as_str(), m.value, m.source, m.flags, m.keyword_flags, m.tags);
            }
            eprintln!("DOTMULT-END flags={} kf={}", dot_type_cfg.flags, dot_type_cfg.keyword_flags);
        }
        if pom_engine::env::var("POM_DEBUG_DOT").is_ok() { eprintln!("DOTCALC {damage_type} base={base_val} inc={inc} more={more} mult={mult} eff={eff_mult_val}"); }

        out.total_dot_instance = (out.total_dot_instance + total).min(dot_dps_cap);
        let bd = if crate::bd::on() { Some(DotBd { base_val, inc, more, mult, aura, resist: bd_resist, taken_inc: bd_taken_inc, taken_more: bd_taken_more }) } else { None };
        let result = DotTypeResult { dot: total, dot_eff_mult: Some(eff_mult_val), bd };
        match damage_type {
            "Physical" => out.physical = result,
            "Lightning" => out.lightning = result,
            "Cold" => out.cold = result,
            "Fire" => out.fire = result,
            "Chaos" => out.chaos = result,
            _ => unreachable!(),
        }
    }

    if skill_mod_list.flag(None, &[pom_engine::sym!("DotCanStack")]) {
        let speed = if dot_cfg.keyword_flags & KEYWORDFLAG_MINE != 0 {
            ext.mine_laying_speed
        } else if dot_cfg.keyword_flags & KEYWORDFLAG_TRAP != 0 {
            ext.trap_throwing_speed
        } else {
            ext.speed
        };
        out.total_dot = (out.total_dot_instance * speed * ext.duration * ext.dps_multiplier * ext.quantity_multiplier).min(dot_dps_cap);
        out.total_dot_calc_section = out.total_dot;
        if crate::bd::on() {
            // CalcOffence.lua:5832-5846 (the actor's own table: this section runs after the pass loop).
            use crate::bd::{ins_s, set};
            use crate::sf;
            let mut t = serde_json::Value::Array(vec![]);
            ins_s(&mut t, sf!("%.1f ^8(Damage per Instance)", out.total_dot_instance));
            ins_s(&mut t, sf!("x %.2f ^8(hits per second)", speed));
            ins_s(&mut t, sf!("x %.2f ^8(skill duration)", ext.duration));
            if ext.dps_multiplier != 1.0 {
                ins_s(&mut t, sf!("x %g ^8(DPS multiplier for this skill)", ext.dps_multiplier));
            }
            if ext.quantity_multiplier > 1.0 {
                ins_s(&mut t, sf!("x %g ^8(quantity multiplier for this skill)", ext.quantity_multiplier));
            }
            ins_s(&mut t, sf!("= %.1f", out.total_dot));
            crate::bd::cur(|b| set(b, "TotalDot", t));
        }
    } else if skill_mod_list.flag(None, &[pom_engine::sym!("dotIsBurningGround")]) {
        out.total_dot = 0.0;
        out.total_dot_calc_section = out.total_dot_instance;
        let pre = inputs.burning_ground_dps_pre.unwrap_or(0.0);
        if inputs.burning_ground_dps_pre.is_none() || pre < out.total_dot_instance {
            out.burning_ground_dps = Some(pre.max(out.total_dot_instance));
        } else {
            out.burning_ground_dps = inputs.burning_ground_dps_pre;
        }
        if inputs.burning_ground_dps_pre.is_none() || pre < out.total_dot_instance {
            out.burning_ground_from_ignite_false = true;
        }
    } else if skill_mod_list.flag(None, &[pom_engine::sym!("dotIsCausticGround")]) {
        out.total_dot = 0.0;
        out.total_dot_calc_section = out.total_dot_instance;
        let pre = inputs.caustic_ground_dps_pre.unwrap_or(0.0);
        if inputs.caustic_ground_dps_pre.is_none() || pre < out.total_dot_instance {
            out.caustic_ground_dps = Some(pre.max(out.total_dot_instance));
        } else {
            out.caustic_ground_dps = inputs.caustic_ground_dps_pre;
        }
        if inputs.caustic_ground_dps_pre.is_none() || pre < out.total_dot_instance {
            out.caustic_ground_from_poison_false = true;
        }
    } else if skill_mod_list.flag(None, &[pom_engine::sym!("dotIsCorruptingBlood")]) {
        out.total_dot = 0.0;
        out.total_dot_calc_section = out.total_dot_instance;
        out.corrupting_blood_dps = Some(out.total_dot_instance.max(0.0));
    } else {
        let attached_brand_count = if inputs.skill_types.contains(&SKILLTYPE_BRAND) && !inputs.skill_data_counts_attached_brands_in_damage { ext.attached_brand_count } else { 1.0 };
        out.total_dot = if attached_brand_count > 1.0 { (out.total_dot_instance * attached_brand_count).min(dot_dps_cap) } else { out.total_dot_instance };
        out.total_dot_calc_section = out.total_dot;
    }

    out
}

/// `output.TotalDotDPS` (CalcOffence.lua:6250-6251): sums every DoT-ish contribution this crate
/// owns, capped. `total_ignite_dps_or_ignite_dps` is `output.TotalIgniteDPS or output.IgniteDPS`
/// (Lua `or`, i.e. the first non-nil/non-zero-as-nil value - callers pass whichever is `Some`).
#[allow(clippy::too_many_arguments)]
pub fn total_dot_dps(total_dot: f64, total_poison_dps: f64, caustic_ground_dps: f64, mirage_caustic_ground_dps: f64, ignite_dps: f64, burning_ground_dps: f64, mirage_burning_ground_dps: f64, bleed_dps: f64, corrupting_blood_dps: f64, decay_dps: f64) -> f64 {
    let dot_dps_cap = crate::data::misc("DotDpsCap");
    (total_dot + total_poison_dps + caustic_ground_dps.max(mirage_caustic_ground_dps) + ignite_dps + burning_ground_dps.max(mirage_burning_ground_dps) + bleed_dps + corrupting_blood_dps + decay_dps).min(dot_dps_cap)
}

/// `DropsBurningGround` block (CalcOffence.lua:5743-5768): returns the new `output.BurningGroundDPS`
/// when it beats `pre` (`output.BurningGroundFromIgnite` is then false).
pub fn calc_drops_burning_ground(mod_db: &ModStore, enemy_db: &ModStore, can_deal_fire: bool, mode_effective: bool, pre: Option<f64>) -> Option<f64> {
    let base = mod_db.sum(ModType::Base, None, &[pom_engine::sym!("DropsBurningGround")]);
    if !(base > 0.0) || !can_deal_fire {
        return None;
    }
    let dot_cfg = Cfg { flags: MODFLAG_DOT, keyword_flags: 0, ..Cfg::default() };
    let mut type_cfg = dot_cfg.clone();
    type_cfg.keyword_flags |= keyword_dot_bit("Fire");
    let mut eff = 1.0;
    if mode_effective {
        let resist = calc_resist_for_type(enemy_db, Some(&type_cfg), "Fire", None);
        eff = eff_mult(enemy_db, Some(&dot_cfg), resist, &["DamageTaken", "DamageTakenOverTime", "FireDamageTaken", "FireDamageTakenOverTime", "ElementalDamageTaken"]);
    }
    let names = [pom_engine::sym!("Damage"), pom_engine::sym!("FireDamage"), pom_engine::sym!("ElementalDamage")];
    let inc = mod_db.sum(ModType::Inc, Some(&type_cfg), &names);
    let more = mod_db.more(Some(&type_cfg), &names);
    let mult = mod_db
        .override_(Some(&type_cfg), &[pom_engine::sym!("DotMultiplier")])
        .and_then(|v| v.num())
        .unwrap_or_else(|| mod_db.sum(ModType::Base, Some(&type_cfg), &[pom_engine::sym!("DotMultiplier")]) + mod_db.sum(ModType::Base, Some(&type_cfg), &[pom_engine::sym!("FireDotMultiplier")]));
    let total = base * (1.0 + inc / 100.0) * more * (1.0 + mult / 100.0) * eff;
    match pre {
        Some(p) if p >= total => None,
        _ => Some(total),
    }
}

/// `(on non-crit hit, on crit)` chaos-poison chance. Upstream adds `ChaosPoisonChance` to both branches
/// (CalcOffence.lua:4714-4717) and zeroes only the other `<Ailment>ChanceOnHit`s (:4289-4302).
pub fn chaos_poison_chances(chaos: f64, only_from_crit: bool, ailment_mode_crit: bool, never_from_crit: bool) -> (f64, f64) {
    // Perfect Agony ("Non-Critical Strikes cannot inflict Ailments") also stops chaos-only poison; upstream does not.
    if crate::data::pom_fixes_on() {
        let hit = if only_from_crit || ailment_mode_crit { 0.0 } else { chaos };
        let crit = if never_from_crit && only_from_crit { 0.0 } else { chaos };
        return (hit, crit);
    }
    (chaos, chaos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perfect_agony_blocks_chaos_poison_on_non_crit() {
        // Perfect Agony: non-crits cannot inflict ailments; upstream still poisons on every hit (60%).
        let (hit, crit) = chaos_poison_chances(60.0, true, false, false);
        assert_eq!((hit, crit), (0.0, 60.0));
        assert_eq!(hit * 0.5 + crit * 0.5, 30.0);
        // + Elemental Overload (ailments are never from crit): nothing left.
        assert_eq!(chaos_poison_chances(60.0, true, false, true), (0.0, 0.0));
        // Elemental Overload alone (even with ailmentMode CRIT): crits keep the chance, as upstream does.
        assert_eq!(chaos_poison_chances(60.0, false, true, true), (0.0, 60.0));
        // No keystone: both branches keep the chance.
        assert_eq!(chaos_poison_chances(60.0, false, false, false), (60.0, 60.0));
    }

    #[test]
    fn herald_of_ash_burn_ignores_elemental_more() {
        use pom_engine::modifier::Mod;
        use pom_engine::value::Value as V;
        let m = |name: &str, ty: ModType, value: V, kf: u64| Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: kf, source: None, tags: Default::default() };
        let mut sml = ModStore::new_list(None, None);
        sml.add_mod(m("dotIsHeraldOfAsh", ModType::Flag, V::Bool(true), 0));
        sml.add_mod(m("FireDamage", ModType::More, V::Num(38.0), KEYWORDFLAG_FIRE_DOT)); // 38% more burning damage
        sml.add_mod(m("ElementalDamage", ModType::More, V::Num(34.0), 0)); // Elemental Focus
        let enemy = ModStore::new_list(None, None);
        let cfg = Cfg { keyword_flags: KEYWORDFLAG_HIT, ..Cfg::default() };
        let mut fire = HashMap::default();
        fire.insert("Fire", 10000.0 * 0.25); // hoaOverkill 10000, 25% per second
        let inputs = TotalDotInputs { skill_data_dot: fire, burning_ground_dps_pre: None, caustic_ground_dps_pre: None, skill_types: Default::default(), skill_data_dot_is_area: false, skill_data_dot_is_projectile: false, skill_data_dot_is_spell: false, skill_data_dot_is_attack: false, skill_data_dot_is_hit: false, skill_data_counts_attached_brands_in_damage: false, mode_effective: false };
        let ext = TotalDotTailExternal { speed: 1.0, mine_laying_speed: 1.0, trap_throwing_speed: 1.0, duration: 1.0, attached_brand_count: 1.0, dps_multiplier: 1.0, quantity_multiplier: 1.0 };
        let out = calc_total_dot(&sml, &enemy, &cfg, &inputs, &ext);
        // Game: only DoT modifiers apply (2500 * 1.38); upstream also applies Elemental Focus (4623).
        assert!((out.total_dot - 3450.0).abs() < 1e-6, "{}", out.total_dot);
    }
}
