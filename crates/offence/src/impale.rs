// Port of Modules/CalcOffence.lua's Impale section: the chance/modifier calc (5596-5647) and the
// ImpaleDPS combine (6151-6210, non-attack/single-pass branch only - the MainHand/OffHand
// dual-wield branch at 6153-6157 is attack-only, out of this crate's non-attack grading scope; see
// dot.rs's module doc for the isolation rationale). Graded against the "Skill" pass only.
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

/// `calcs.armourReductionF(armour, raw)` (Modules/CalcDefence.lua:67-72) - a tiny, pure formula
/// duplicated here rather than depending on the still-WIP `defence` crate, same call as this
/// crate's other small cross-cutting helpers (`tools.rs`'s `calcLib.mod`/`val`).
/// Lua `round(val, dec)` (Modules/Common.lua:709-715): `math.floor(val * 10^dec + 0.5) / 10^dec`.
fn round_dec(val: f64, dec: i32) -> f64 {
    let factor = 10f64.powi(dec);
    (val * factor + 0.5).floor() / factor
}

pub fn armour_reduction_f(armour: f64, raw: f64) -> f64 {
    if armour == 0.0 && raw == 0.0 {
        0.0
    } else {
        armour / (armour + raw * 5.0) * 100.0
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct ImpaleCalcOutput {
    pub impale_stacks_max: f64,
    pub impale_stacks: f64,
    pub impale_stored_damage: f64,
    pub impale_modifier: f64,
}

/// The Impale chance/modifier calc (CalcOffence.lua:5596-5647). `impale_stored_hit_avg` is
/// `output.impaleStoredHitAvg`, accumulated by the un-ported hit-pass loop (3506-3509) - taken as a
/// recorded input.
#[allow(clippy::too_many_arguments)]
pub fn calc_impale(skill_mod_list: &ModStore, enemy_db: &ModStore, cfg: Option<&Cfg>, can_deal_physical: bool, impale_chance: f64, impale_chance_on_crit: f64, crit_chance: f64, impale_stored_hit_avg: f64) -> Option<ImpaleCalcOutput> {
    if !can_deal_physical || impale_chance + impale_chance_on_crit <= 0.0 {
        return None;
    }
    let crit = crit_chance / 100.0;
    let impale_chance_combined = (impale_chance / 100.0).min(1.0) * (1.0 - crit) + (impale_chance_on_crit / 100.0).min(1.0) * crit;
    let max_stacks = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("ImpaleStacksMax")]) * (1.0 + skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("ImpaleAdditionalDurationChance")]) / 100.0);
    let config_stacks = enemy_db.sum(ModType::Base, cfg, &[pom_engine::sym!("Multiplier:ImpaleStacks")]);
    let impale_stacks = max_stacks.min(config_stacks);

    let base_stored_damage = crate::data::misc("ImpaleStoredDamageBase");
    let stored_expected_damage_inc_on_bleed = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("ImpaleEffectOnBleed")]) * (skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("BleedChance")]) / 100.0).min(1.0);
    let stored_expected_damage_inc = (skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("ImpaleEffect")]) + stored_expected_damage_inc_on_bleed) / 100.0;
    let stored_expected_damage_more = round_dec(skill_mod_list.more(cfg, &[pom_engine::sym!("ImpaleEffect")]), 2);
    let stored_expected_damage_modifier = (1.0 + stored_expected_damage_inc) * stored_expected_damage_more;
    let impale_stored_damage = base_stored_damage * stored_expected_damage_modifier;
    let impale_hit_damage_mod = impale_stored_damage * impale_stacks;

    let enemy_armour = crate::tools::calc_lib_val(enemy_db, "Armour", None).max(0.0);
    let impale_armour_reduction = armour_reduction_f(enemy_armour, impale_hit_damage_mod * impale_stored_hit_avg);
    let mut impale_resist = (enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("PhysicalDamageReduction")]) + skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("EnemyImpalePhysicalDamageReduction")]) + impale_armour_reduction)
        .max(0.0)
        .min(crate::data::misc("EnemyPhysicalDamageReductionCap"));
    if skill_mod_list.flag(cfg, &[pom_engine::sym!("IgnoreEnemyImpalePhysicalDamageReduction")]) {
        impale_resist = 0.0;
    }
    // `impaleTakenCfg = { flags = ModFlag.Hit }` (5619): a fresh, minimal cfg (no skillCond/keywordFlags).
    let impale_taken_cfg = Cfg { flags: 0x00000004, ..Cfg::default() };
    let impale_taken_names = [pom_engine::sym!("DamageTaken"), pom_engine::sym!("PhysicalDamageTaken"), pom_engine::sym!("ReflectedDamageTaken")];
    let impale_taken = (1.0 + enemy_db.sum(ModType::Inc, Some(&impale_taken_cfg), &impale_taken_names) / 100.0) * enemy_db.more(Some(&impale_taken_cfg), &impale_taken_names);
    let impale_dmg_modifier = impale_hit_damage_mod * (1.0 - impale_resist / 100.0) * impale_chance_combined * impale_taken;

    if crate::bd::on() {
        // CalcOffence.lua:5632-5646 (the pass's own `breakdown`; the caller selects the pass table).
        use crate::bd::{ins_s, set};
        use crate::sf;
        crate::bd::cur(|b| {
            let mut t = serde_json::Value::Array(vec![]);
            ins_s(&mut t, "10% ^8(base value)");
            ins_s(&mut t, sf!("x %.2f ^8(increased effectiveness)", stored_expected_damage_modifier));
            ins_s(&mut t, sf!("= %.1f%%", impale_stored_damage * 100.0));
            set(b, "ImpaleStoredDamage", t);
            let mut t = serde_json::Value::Array(vec![]);
            ins_s(&mut t, sf!("%d ^8(number of stacks, can be overridden in the Configuration tab)", impale_stacks));
            ins_s(&mut t, sf!("x %.3f ^8(stored damage)", impale_stored_damage));
            ins_s(&mut t, sf!("x %.2f ^8(impale chance)", impale_chance_combined));
            ins_s(&mut t, sf!("x %.2f ^8(impale enemy physical damage reduction)", 1.0 - impale_resist / 100.0));
            if impale_taken != 1.0 {
                ins_s(&mut t, sf!("x %.2f ^8(impale enemy damage taken)", impale_taken));
            }
            ins_s(&mut t, sf!("= %.3f ^8(impale damage multiplier)", impale_dmg_modifier));
            set(b, "ImpaleModifier", t);
        });
    }
    Some(ImpaleCalcOutput { impale_stacks_max: max_stacks, impale_stacks, impale_stored_damage: impale_stored_damage * 100.0, impale_modifier: 1.0 + impale_dmg_modifier })
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct ImpaleDpsOutput {
    pub impale_dps: f64,
    pub with_impale_dps: f64,
}

/// The non-attack branch of the ImpaleDPS combine (CalcOffence.lua:6159-6174). `impale_modifier`
/// defaults to 1 when Impale wasn't inflicted (`output.ImpaleModifier or 1`, 6159); pass `None` from
/// `calc_impale` returning `None` to get `ImpaleDPS == 0` for free, matching the Lua (the whole
/// block is skipped when `skillFlags.impale` is false, so `output.ImpaleDPS` is never set - callers
/// only call this when Impale was inflicted).
#[allow(clippy::too_many_arguments)]
pub fn calc_impale_dps(impale_stored_hit_avg: f64, impale_modifier: f64, hit_chance: f64, dps_multiplier: f64, impale_duration: f64, show_average: bool, average_damage: f64, total_dps: f64, hit_speed_or_speed: f64, quantity_multiplier: f64) -> ImpaleDpsOutput {
    let mut impale_dps = impale_stored_hit_avg * (impale_modifier - 1.0) * hit_chance / 100.0 * dps_multiplier;
    if impale_duration <= 0.0 {
        impale_dps = 0.0;
    }
    let with_impale_dps = if show_average {
        average_damage + impale_dps
    } else {
        impale_dps *= hit_speed_or_speed;
        total_dps + impale_dps
    };
    if quantity_multiplier > 1.0 {
        impale_dps *= quantity_multiplier;
    }
    ImpaleDpsOutput { impale_dps, with_impale_dps }
}
