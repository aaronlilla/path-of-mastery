//! Calcs-mode breakdown writers of the ailment loop (CalcOffence.lua:4164 on): `calcAilmentDamage`'s `<Type>Chance` /
//! `<Type>DPS` tables and the bleed section's tables. The caller computes the values; everything here runs only under
//! `bd::on()`.
use crate::bd::{self, ins_s, s, set};
use crate::bdbuild;
use crate::sf;
use serde_json::Value;
use std::cell::Cell;

thread_local! {
    static LABEL: Cell<&'static str> = const { Cell::new("Skill") };
}

/// Top of one iteration of the ailment loop (`for _, pass in ipairs(passList)`): `breakdown = pass.breakdown`.
/// `label` is the Rust pass label ("MainHand" / "OffHand" / "Skill").
pub fn enter_pass(label: &'static str) {
    LABEL.with(|l| l.set(label));
    bd::set_pass(bd::pass_scope(label));
}

/// After the loop: `breakdown` is the actor's table again.
pub fn leave_pass() {
    LABEL.with(|l| l.set("Skill"));
    bd::set_pass(None);
}

/// `pass.label` of upstream ("Main Hand", "Off Hand", "Skill").
pub fn pass_label() -> &'static str {
    match LABEL.with(|l| l.get()) {
        "MainHand" => "Main Hand",
        "OffHand" => "Off Hand",
        _ => "Skill",
    }
}

/// `isAttack`: the passes of an attack are the weapon hands.
pub fn is_attack() -> bool {
    LABEL.with(|l| l.get()) != "Skill"
}

fn has_first(t: &mut Value) -> bool {
    bd::nth(t, 1).is_some()
}

/// The breakdown half of `calcAilmentDamage(type, sourceCritChance, sourceHitDmg, sourceCritDmg, hideFromBreakdown)`
/// (CalcOffence.lua:4339-4398). `output_crit_chance` is `output.CritChance` of the pass; `source_mult` is
/// `skillModList:More(cfg, type.."AsThoughDealing")`.
#[allow(clippy::too_many_arguments)]
pub fn ailment_damage(ty: &str, chance_on_hit: f64, chance_on_crit: f64, source_crit_chance: f64, source_hit_dmg: f64, source_crit_dmg: f64, hide: bool, output_crit_chance: f64, source_mult: f64) {
    if !bd::on() || hide {
        return;
    }
    let chance_from_hit = chance_on_hit * (1.0 - source_crit_chance / 100.0);
    let chance_from_crit = chance_on_crit * source_crit_chance / 100.0;
    let chance = chance_from_hit + chance_from_crit;
    let base_from_hit = source_hit_dmg * chance_from_hit / (chance_from_hit + chance_from_crit);
    let base_from_crit = source_crit_dmg * chance_from_crit / (chance_from_hit + chance_from_crit);
    let base_val = base_from_hit + base_from_crit;
    let attack = is_attack();
    let label = pass_label();
    if chance != 0.0 {
        bd::cur(|b| {
            let t = bd::t(b, &format!("{ty}Chance"));
            if has_first(t) {
                ins_s(t, "");
            }
            if attack {
                ins_s(t, format!("{label}:"));
            }
            ins_s(t, sf!("Chance on Non-crit: %d%%", chance_on_hit));
            ins_s(t, sf!("Chance on Crit: %d%%", chance_on_crit));
            if chance_on_hit != chance_on_crit {
                ins_s(t, "Combined chance:");
                ins_s(t, sf!("%d x (1 - %.4f) ^8(chance from non-crits)", chance_on_hit, source_crit_chance / 100.0));
                ins_s(t, sf!("+ %d x %.4f ^8(chance from crits)", chance_on_crit, source_crit_chance / 100.0));
                let per_hit = chance_on_hit * (1.0 - source_crit_chance / 100.0) + chance_on_crit * source_crit_chance / 100.0;
                ins_s(t, sf!("= %.2f", per_hit));
            }
        });
    }
    if base_val > 0.0 {
        bd::cur(|b| {
            let t = bd::t(b, &format!("{ty}DPS"));
            if has_first(t) {
                ins_s(t, "");
            }
            if attack {
                ins_s(t, format!("{label}:"));
            }
            if source_hit_dmg == source_crit_dmg || output_crit_chance == 0.0 {
                ins_s(t, "Total damage:");
                ins_s(t, sf!("%.1f ^8(source damage)", source_hit_dmg));
                if source_mult > 1.0 {
                    ins_s(t, sf!("x %.2f ^8(inflicting as though dealing more damage)", source_mult));
                    ins_s(t, sf!("= %.1f", base_val * source_mult));
                }
            } else {
                if base_from_hit > 0.0 {
                    ins_s(t, "Damage from Non-crits:");
                    ins_s(t, sf!("%.1f ^8(source damage from non-crits)", source_hit_dmg));
                    ins_s(t, sf!("x %.3f ^8(portion of instances created by non-crits)", chance_from_hit / (chance_from_hit + chance_from_crit)));
                    if source_mult == 1.0 || base_from_crit != 0.0 {
                        ins_s(t, sf!("= %.1f", base_from_hit));
                    }
                }
                if base_from_crit > 0.0 {
                    ins_s(t, "Damage from Crits:");
                    ins_s(t, sf!("%.1f ^8(source damage from crits)", source_crit_dmg));
                    ins_s(t, sf!("x %.3f ^8(portion of instances created by crits)", chance_from_crit / (chance_from_hit + chance_from_crit)));
                    if source_mult == 1.0 || base_from_hit != 0.0 {
                        ins_s(t, sf!("= %.1f", base_from_crit));
                    }
                }
                if base_from_hit > 0.0 && base_from_crit > 0.0 {
                    ins_s(t, "Total damage:");
                    ins_s(t, sf!("%.1f + %.1f", base_from_hit, base_from_crit));
                    if source_mult == 1.0 {
                        ins_s(t, sf!("= %.1f", base_val));
                    }
                }
                if source_mult > 1.0 {
                    ins_s(t, sf!("x %.2f ^8(inflicting as though dealing more damage)", source_mult));
                    ins_s(t, sf!("= %.1f", base_val * source_mult));
                }
            }
        });
    }
}

/// `breakdown.<Type> = { damageTypes = { } }` (the per-damage-type source tables the ailment sections create).
pub fn damage_types_table(key: &str) {
    bd::cur(|b| {
        let mut t = Value::Array(vec![]);
        set(&mut t, "damageTypes", Value::Array(vec![]));
        set(b, key, t);
    });
}

const CUSTOM: &str = "^x5CF0BB";
const NEGATIVE: &str = "^xDD0022";

/// `globalBreakdown.BleedStackPotential` (CalcOffence.lua:4466-4486).
#[allow(clippy::too_many_arguments)]
pub fn bleed_stack_potential(override_potential: Option<f64>, hit_chance: f64, bleed_chance: f64, speed_positive: bool, bleed_duration: f64, hit_time: f64, dps_multiplier: f64, totem: bool, active_totems: f64, max_stacks: f64, potential: f64) {
    bd::root(|g| {
        let t = bd::reset(g, "BleedStackPotential");
        ins_s(t, "Ratio of bleed stacks to maximum active bleeds:");
        if let Some(o) = override_potential {
            ins_s(t, sf!("= %g ^8(stack potential override)", o));
        } else {
            ins_s(t, sf!("%.2f ^8(chance to hit)", hit_chance / 100.0));
            ins_s(t, sf!("* %.2f ^8(chance to bleed)", bleed_chance));
            if speed_positive {
                ins_s(t, sf!("* (%.2f / %.2f) ^8(Bleed duration / Attack Time)", bleed_duration, hit_time));
            }
            if dps_multiplier != 1.0 {
                ins_s(t, sf!("* %g ^8(DPS multiplier for this skill)", dps_multiplier));
            }
            if totem {
                ins_s(t, sf!("* %d ^8(active number of Totems)", active_totems));
            }
            ins_s(t, sf!("/ %d ^8(max number of stacks)", max_stacks));
            ins_s(t, sf!("= %.2f", potential));
        }
    });
}

/// `globalBreakdown.BleedRollAverage` (CalcOffence.lua:4499-4513).
pub fn bleed_roll_average(roll_average: f64, bleed_stacks: f64, max_stacks: f64) {
    bd::root(|g| {
        let t = bd::reset(g, "BleedRollAverage");
        ins_s(t, format!("{CUSTOM}This is the average roll of a Bleed affecting the enemy if you are constantly attacking"));
        ins_s(t, sf!(&format!("{CUSTOM}If attacking constantly, your average strongest bleed currently achieves ^7%.2f%%{CUSTOM} of its max damage"), roll_average));
        ins_s(t, "");
        ins_s(t, "Average Bleed Roll:");
        if bleed_stacks >= max_stacks {
            ins_s(t, sf!("%.2f - (%.2f - 1)/2", bleed_stacks, max_stacks));
            ins_s(t, sf!("/ (%.2f + 1)", bleed_stacks));
            ins_s(t, sf!("= %.2f%%", roll_average));
        } else {
            ins_s(t, sf!("50%% (averaging <= %d bleeds)", max_stacks));
        }
    });
}

/// `breakdown.BleedDPS = { NOTE }` then `globalBreakdown.BleedDPS = { derivation }` (CalcOffence.lua:4538-4572).
#[allow(clippy::too_many_arguments)]
pub fn bleed_dps_derivation(same_dmg: bool, min: f64, max: f64, roll_average: f64, dot_multi: f64, crit_dot_multi: f64, avg_hit: f64, avg_crit: f64) {
    bd::cur(|b| {
        let t = bd::reset(b, "BleedDPS");
        ins_s(t, format!("{CUSTOM}NOTE: Calculation uses new Weighted Avg formula for critical hits"));
    });
    bd::root(|g| {
        let mut t = Value::Array(vec![]);
        if same_dmg {
            ins_s(&mut t, "Dmg Derivation:");
            ins_s(&mut t, sf!("%.0f + (%.0f - %.0f) * %.2f%%", min, max, min, roll_average));
            ins_s(&mut t, "^8min source phys + (max source phys - min source phys) * average bleed roll");
            ins_s(&mut t, sf!("* %.2f ^8(Bleed DoT Multi)", dot_multi));
            ins_s(&mut t, sf!("= %.2f", avg_hit));
        } else {
            ins_s(&mut t, "Non-Crit Dmg Derivation:");
            ins_s(&mut t, sf!("%.0f + (%.0f - %.0f) * %.2f%%", min, max, min, roll_average));
            ins_s(&mut t, "^8min source phys + (max source phys - min source phys) * average bleed roll");
            ins_s(&mut t, sf!("* %.2f ^8(Bleed DoT Multi for Non-Crit)", dot_multi));
            ins_s(&mut t, sf!("= %.0f", avg_hit));
            ins_s(&mut t, "");
            ins_s(&mut t, "Crit Dmg Derivation:");
            ins_s(&mut t, sf!("%.0f + (%.0f - %.0f) * %.2f%%", min, max, min, roll_average));
            ins_s(&mut t, "^8min source phys + (max source phys - min source phys) * average bleed roll");
            ins_s(&mut t, sf!("* %.2f ^8(Bleed DoT Multi for Crit)", crit_dot_multi));
            ins_s(&mut t, sf!("= %.2f", avg_crit));
        }
        set(g, "BleedDPS", t);
    });
}

/// Everything the tail of the bleed section reads (CalcOffence.lua:4574-4680).
pub struct BleedTail {
    pub resist: f64,
    pub taken_inc: f64,
    pub taken_more: f64,
    pub eff_mult: f64,
    pub mode_effective: bool,
    pub base_percent: f64,
    pub effect_mod: f64,
    pub ruthless: f64,
    pub fist_of_war: f64,
    pub warcry: f64,
    pub base_bleed_dps: f64,
    pub rate_mod: f64,
    pub active_bleeds: f64,
    pub bleed_dps_uncapped: f64,
    pub bleed_dps_capped: f64,
    pub min_uncapped: f64,
    pub min_capped: f64,
    pub max_uncapped: f64,
    pub max_capped: f64,
    pub bleed_dps: f64,
    pub duration_base: f64,
    pub duration_mod: f64,
    pub debuff_duration_mult: f64,
    pub bleed_duration: f64,
    pub bleed_dot_multi: f64,
    pub crit_bleed_dot_multi: f64,
    pub chance_on_hit: f64,
    pub chance_on_crit: f64,
    pub global_crit_chance: f64,
    pub ailment_crit_chance: f64,
}

pub fn bleed_tail(x: &BleedTail) {
    if x.mode_effective && x.eff_mult != 1.0 {
        let v = bdbuild::eff_mult("Physical", x.resist, 0.0, x.taken_inc, x.eff_mult, x.taken_more, None, true, None, None);
        bd::root(|g| set(g, "BleedEffMult", v));
    }
    if x.crit_bleed_dot_multi != x.bleed_dot_multi {
        let chance_from_hit = x.chance_on_hit / 100.0 * (1.0 - x.global_crit_chance / 100.0);
        let chance_from_crit = x.chance_on_crit / 100.0 * x.ailment_crit_chance / 100.0;
        let total_from_hit = chance_from_hit / (chance_from_hit + chance_from_crit);
        let total_from_crit = chance_from_crit / (chance_from_hit + chance_from_crit);
        let v = bdbuild::crit_dot(x.bleed_dot_multi, x.crit_bleed_dot_multi, total_from_hit, total_from_crit);
        bd::cur(|b| set(b, "BleedDotMulti", v));
    }
    bd::cur(|b| {
        let t = bd::t(b, "BleedDPS");
        ins_s(t, sf!("x %.2f ^8(bleed deals %d%% per second)", x.base_percent / 100.0, x.base_percent));
        if x.effect_mod != 1.0 {
            ins_s(t, sf!("x %.2f ^8(ailment effect modifier)", x.effect_mod));
        }
        if x.ruthless != 1.0 {
            ins_s(t, sf!("x %.2f ^8(ruthless blow effect modifier)", x.ruthless));
        }
        if x.fist_of_war != 1.0 {
            ins_s(t, sf!("x %.2f ^8(fist of war effect modifier)", x.fist_of_war));
        }
        if x.warcry > 1.0 {
            ins_s(t, sf!("x %.2f ^8(combined ailment warcry effect modifier)", x.warcry));
        }
        ins_s(t, sf!("= %.1f", x.base_bleed_dps));
        ins_s(t, "");
        ins_s(t, "Total Bleed DPS:");
        if x.base_bleed_dps != x.bleed_dps_uncapped {
            ins_s(t, sf!("%.1f ^8(base damage per second)", x.base_bleed_dps));
        }
        if x.effect_mod != 1.0 {
            ins_s(t, sf!("x %.2f ^8(ailment effect modifier)", x.effect_mod));
        }
        if x.rate_mod != 1.0 {
            ins_s(t, sf!("x %.2f ^8(damage rate modifier)", x.rate_mod));
        }
        if x.active_bleeds != 1.0 {
            ins_s(t, sf!("x %.2f ^8(avg bleed stacks)", x.active_bleeds));
        }
        if x.eff_mult != 1.0 {
            ins_s(t, sf!("x %.3f ^8(effective DPS modifier from enemy debuffs)", x.eff_mult));
        }
        if x.bleed_dps != x.bleed_dps_uncapped {
            ins_s(t, sf!("= %.1f ^8(Uncapped raw Bleed DPS)", x.bleed_dps_uncapped));
            ins_s(t, sf!(&format!("^8(Raw Bleed DPS is {NEGATIVE}overcapped ^8by^7 %.0f ^8:^7 %.1f%%^8)"), x.bleed_dps_uncapped - x.bleed_dps_capped, (x.bleed_dps_uncapped - x.bleed_dps_capped) / x.bleed_dps_capped * 100.0));
            ins_s(t, sf!("= %d ^8(Capped Bleed DPS)", x.bleed_dps_capped));
        } else {
            ins_s(t, sf!("= %.1f ^8per second", x.bleed_dps));
        }
        ins_s(t, sf!("%.2f%% of Maximum Bleed DPS", x.bleed_dps / x.max_capped * 100.0));
        ins_s(t, "");
        ins_s(t, "DPS Range:");
        if x.max_capped == x.max_uncapped && x.min_capped == x.min_uncapped {
            ins_s(t, sf!("%.0f to %.0f ^8(Bleed DPS Range)", x.min_uncapped, x.max_uncapped));
        } else {
            ins_s(t, sf!("%.0f to %.0f ^8(Uncapped Bleed DPS Range)", x.min_uncapped, x.max_uncapped));
        }
        if x.min_capped != x.min_uncapped {
            ins_s(t, sf!(&format!("^8(Raw Min Bleed DPS is {NEGATIVE}overcapped ^8by^7 %.0f ^8:^7 %.1f%%^8)"), x.min_uncapped - x.min_capped, (x.min_uncapped - x.min_capped) / x.min_capped * 100.0));
        }
        if x.max_capped != x.max_uncapped {
            ins_s(t, sf!(&format!("^8(Raw Max Bleed DPS is {NEGATIVE}overcapped ^8by^7 %.0f ^8:^7 %.1f%%^8)"), x.max_uncapped - x.max_capped, (x.max_uncapped - x.max_capped) / x.max_capped * 100.0));
        }
        if x.max_capped != x.max_uncapped || x.min_capped != x.min_uncapped {
            ins_s(t, sf!("%.0f to %.0f ^8(Capped Bleed DPS Range)", x.min_capped, x.max_capped));
        }
    });
    if x.bleed_duration != x.duration_base {
        bd::root(|g| {
            let t = bd::reset(g, "BleedDuration");
            ins_s(t, sf!("%.2fs ^8(base duration)", x.duration_base));
            if x.duration_mod != 1.0 {
                ins_s(t, sf!("x %.2f ^8(duration modifier)", x.duration_mod));
            }
            if x.rate_mod != 1.0 {
                ins_s(t, sf!("/ %.2f ^8(damage rate modifier)", x.rate_mod));
            }
            if x.debuff_duration_mult != 1.0 {
                ins_s(t, sf!("/ %.2f ^8(debuff expires slower/faster)", 1.0 / x.debuff_duration_mult));
            }
            ins_s(t, sf!("= %.2fs", x.bleed_duration));
        });
    }
}

// ---- both-hands / TotalDPS tables of the non-ailment part of the slice (CalcOffence.lua:4001-4096)

/// The tail of the attack crit block (CalcOffence.lua:4004-4018): a single-weapon attack copies its hand's crit tables to the
/// actor's table (shared tables in upstream), then `breakdownSource` is stamped on whichever tables exist.
pub fn crit_source(both_weapon_attack: bool, weapon1_attack: bool, hands: &[(&'static str, f64, f64)], combined: (f64, f64)) {
    let hand = if weapon1_attack { "MainHand" } else { "OffHand" };
    let source = format!("{hand}.CritChance");
    bd::root(|b| {
        for (i, key) in ["PreEffectiveCritChance", "CritChance"].into_iter().enumerate() {
            if both_weapon_attack {
                // CalcOffence.lua:3993-4006: the hands' crit tables, one after the other
                let mut out = Value::Array(vec![]);
                ins_s(&mut out, "Both weapons:");
                for (label, pre, crit) in hands {
                    let shown = if *label == "MainHand" { "Main Hand" } else { "Off Hand" };
                    ins_s(&mut out, format!("{shown}:"));
                    let lines: Option<Vec<Value>> = bd::get(b, label).and_then(|h| bd::get(h, key)).map(|v| match v {
                        Value::Array(a) => a.clone(),
                        Value::Object(m) => (1..).map_while(|k| m.get(&k.to_string()).cloned()).collect(),
                        _ => vec![],
                    });
                    match lines {
                        Some(ls) => {
                            for l in ls {
                                bd::ins(&mut out, l);
                            }
                        }
                        None => ins_s(&mut out, sf!("%.2f%%", if i == 0 { *pre } else { *crit })),
                    }
                }
                ins_s(&mut out, sf!("= %.2f%% ^8(average)", if i == 0 { combined.0 } else { combined.1 }));
                set(b, key, out);
            } else {
                let copy = bd::get(b, hand).and_then(|h| bd::get(h, key)).map(|v| v.clone());
                match copy {
                    Some(v) => set(b, key, v),
                    None => {
                        if let Some(o) = b.as_object_mut() {
                            o.remove(key);
                        }
                    }
                }
            }
            if let Some(v) = bd::get(b, key) {
                set(v, "breakdownSource", s(source.clone()));
            }
            if !both_weapon_attack {
                // the table is shared with the hand's own, so the stamp is visible there too
                let stamped = bd::get(b, key).map(|v| v.clone());
                if let (Some(v), Some(h)) = (stamped, bd::get(b, hand)) {
                    set(h, key, v);
                }
            }
        }
    });
}

/// `breakdown.AverageDamage` of a dual-wield attack (CalcOffence.lua:4012-4024).
pub fn both_weapons_average_damage(double_hits: bool, mh: f64, oh: f64, average_damage: f64) {
    bd::root(|b| {
        let t = bd::reset(b, "AverageDamage");
        ins_s(t, "Both weapons:");
        if double_hits {
            ins_s(t, sf!("%.1f + %.1f ^8(skill hits with both weapons at once)", mh, oh));
        } else {
            ins_s(t, sf!("(%.1f + %.1f) / 2 ^8(skill alternates weapons)", mh, oh));
        }
        ins_s(t, sf!("= %.1f", average_damage));
    });
}

/// `breakdown.TotalDPS` (CalcOffence.lua:4046-4076, the non-PvP part).
pub fn total_dps(is_attack: bool, triggered: bool, average_damage: f64, hit_speed: Option<f64>, speed: f64, dps_multiplier: f64, quantity_multiplier: f64, total: f64) {
    bd::root(|b| {
        let mut t = Value::Array(vec![]);
        let rate = |kind: &str| match hit_speed {
            Some(h) => sf!("x %.2f ^8(hit rate)", h),
            None => sf!(&format!("x %.2f ^8({kind} rate)"), speed),
        };
        if is_attack {
            ins_s(&mut t, sf!("%.1f ^8(average damage)", average_damage));
            ins_s(&mut t, rate("attack"));
        } else if triggered {
            ins_s(&mut t, sf!("%.1f ^8(average damage)", average_damage));
            ins_s(&mut t, rate("trigger"));
        } else {
            ins_s(&mut t, sf!("%.1f ^8(average hit)", average_damage));
            ins_s(&mut t, rate("cast"));
        }
        if dps_multiplier != 1.0 {
            ins_s(&mut t, sf!("x %g ^8(DPS multiplier for this skill)", dps_multiplier));
        }
        if quantity_multiplier > 1.0 {
            ins_s(&mut t, sf!("x %g ^8(quantity multiplier for this skill)", quantity_multiplier));
        }
        ins_s(&mut t, sf!("= %.1f", total));
        set(b, "TotalDPS", t);
    });
}
