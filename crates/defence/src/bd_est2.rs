//! Calcs-mode breakdown tables of `calcs.buildDefenceEstimations` (Modules/CalcDefence.lua 1674-3874), second half: stun,
//! pools, EHP, recoup, max hit, degen and the final taken-hit tables. Same rules as `bd_est`.
use crate::bd_def::{push, put_lines};
use crate::bd_est::{push_row, put_table, table_with_rows};
use crate::pools::{PoolsResult, ResourcesLost, ALLY_LIFE_POOL_LIST, DMG_TYPES};
use pom_engine::fxhash::HashMap;
use pom_offence::bd::{self, ins_s, row, s, set};
use pom_offence::sf;
use serde_json::{json, Value};

const CUSTOM: &str = "^x5CF0BB";
const GEM: &str = "^x1AA29B";
const SCOURGE: &str = "^xFF6E25";
const WARD: &str = "^xFFFF77";
const ES: &str = "^x88FFFF";
const MANA: &str = "^x7070FF";
const LIFE: &str = "^xE05030";
const NEGATIVE: &str = "^xDD0022";

fn g(output: &HashMap<String, f64>, key: &str) -> f64 {
    output.get(key).copied().unwrap_or(0.0)
}

/// `allyLifePoolList[i].label`.
fn ally_label(key: &str) -> &'static str {
    match key {
        "minion" => "Minion Life",
        "radianceSentinel" => "Total Sentinel of Radiance Life",
        "spectres" => "Total Spectre Life",
        "totems" => "Nearest Totem Life",
        "vaalRejuvenationTotems" => "Total Vaal Rejuvenation Totem Life",
        "voidSpawn" => "Total Void Spawn Life",
        "stoneGolem" => "Total Stone Golem Life",
        "soulLink" => "Total Allied Energy shield",
        _ => "Frost Shield Life",
    }
}

/// `breakdown.StunThreshold`, `breakdown.StunAvoidChance` (lines 2186-2196).
pub fn stun_threshold(source: &str, base: f64, threshold_mod: f64, threshold: f64) {
    if !bd::on() {
        return;
    }
    let mut l = vec![sf!("%d ^8(base from %s)", base, source)];
    if threshold_mod != 1.0 {
        l.push(sf!("* %.2f ^8(increased threshold)", threshold_mod));
        l.push(sf!("= %d", threshold));
    }
    put_lines("StunThreshold", l);
    put_lines(
        "StunAvoidChance",
        vec![
            format!("{CUSTOM}NOTE: Having any energy shield when the hit occurs grants 50% chance to avoid stun."),
            format!("{CUSTOM}This modifier only applies when ES > Total incoming damage."),
        ],
    );
}

/// Lines 2199-2230.
pub fn stun_duration(cannot: bool, base: f64, dur: f64, recovery: f64, and_block_recovery: f64, out_stun: f64, out_block: f64) {
    if !bd::on() {
        return;
    }
    if cannot {
        put_lines("StunDuration", vec!["Cannot be Stunned".into()]);
        put_lines("BlockDuration", vec!["Cannot be Stunned".into()]);
        return;
    }
    let mut sd = vec![sf!("%.2fs ^8(base)", base)];
    let mut bl = vec![sf!("%.2fs ^8(base)", base)];
    if dur != 1.0 {
        sd.push(sf!("* %.2f ^8(increased duration)", dur));
        bl.push(sf!("* %.2f ^8(increased duration)", dur));
    }
    if recovery != 1.0 {
        sd.push(sf!("/ %.2f ^8(increased/reduced recovery)", recovery));
    }
    if and_block_recovery != 1.0 {
        bl.push(sf!("/ %.2f ^8(increased/reduced block recovery)", and_block_recovery));
    }
    sd.push("rounded up to nearest server tick".into());
    sd.push(sf!("= %.2fs", out_stun));
    bl.push("rounded up to nearest server tick".into());
    bl.push(sf!("= %.2fs", out_block));
    put_lines("StunDuration", sd);
    put_lines("BlockDuration", bl);
}

/// Lines 2240-2254.
pub fn self_stun(stun_base_mult: f64, effective_enemy_damage: f64, threshold: f64, base_stun_chance: f64, min_needed: f64, not_avoid_chance: f64, out: f64) {
    if !bd::on() {
        return;
    }
    let mut l = vec![sf!("%d%% ^8(stun multiplier)", stun_base_mult), sf!("* %.1f ^8(effective enemy stun damage)", effective_enemy_damage), sf!("/ %d ^8(stun threshold)", threshold)];
    if base_stun_chance < min_needed {
        l.push(sf!("= %.2f%%", base_stun_chance));
        l.push(sf!("Stun Chance has to be more than %d%% to stun.", min_needed));
    } else {
        if not_avoid_chance != 100.0 {
            l.push(sf!("* %.2f ^8(1 - chance to avoid stun)", not_avoid_chance / 100.0));
        }
        l.push(sf!("= %.2f%%", out));
    }
    put_lines("SelfStunChance", l);
}

/// Lines 2291-2319.
pub fn prevented_life_loss(prevented: f64, below_half: f64, initial_below_half: f64, portion_life: f64, total: f64) {
    if !bd::on() {
        return;
    }
    let mut l = vec![String::from("Total life protected:")];
    if prevented != 0.0 {
        l.push(sf!("%.2f ^8(portion taken over 4 seconds instead)", prevented / 100.0));
    }
    if below_half != 0.0 {
        if portion_life != 1.0 {
            if prevented != 0.0 {
                l.push(String::new());
            }
            l.push(sf!("%s%.2f ^8(initial portion taken by petrified blood)", if prevented != 0.0 { "+ " } else { "" }, initial_below_half / 100.0));
            if prevented != 0.0 {
                l.push(sf!("* %.2f ^8(portion not already taken over time)", 1.0 - prevented / 100.0));
            }
            l.push(sf!("* %.2f ^8(portion of life on low life)", portion_life));
            l.push(sf!("= %.2f ^8(final portion taken by petrified blood)", below_half * portion_life / 100.0));
            l.push(String::new());
        } else {
            l.push(sf!("%s%.2f ^8(%s taken by petrified blood)", if prevented != 0.0 { "+ " } else { "" }, initial_below_half / 100.0, if prevented != 0.0 { "initial portion" } else { "portion" }));
            if prevented != 0.0 {
                l.push(sf!("* %.2f ^8(portion not already taken over time)", 1.0 - prevented / 100.0));
                l.push(sf!("= %.2f ^8(final portion taken by petrified blood)", below_half / 100.0));
            }
        }
    }
    l.push(sf!("%.2f ^8(portion taken from life)", 1.0 - total / 100.0));
    put_lines("preventedLifeLossTotal", l);
}

/// The four values of upstream's `calcMoMEBPool` closure (lines 2347-2360).
pub fn calc_mom_eb_pool(output: &HashMap<String, f64>, es_protects_mana: bool, life_pool: f64, mom_effect: f64, es_bypass: f64) -> (f64, f64, f64, f64) {
    let mana = g(output, "ManaUnreserved").max(0.0);
    let max_mom_pool = if mom_effect < 1.0 { life_pool / (1.0 - mom_effect) - life_pool } else { f64::INFINITY };
    let max_mana_usable = mana.min(max_mom_pool).floor();
    let max_es_usable = if es_protects_mana && es_bypass < 1.0 {
        g(output, "EnergyShieldRecoveryCap").min(max_mom_pool * (1.0 - es_bypass)).min((life_pool + max_mana_usable) / (1.0 - (1.0 - es_bypass) * mom_effect) - (life_pool + max_mana_usable)).floor()
    } else {
        0.0
    };
    let mana_used = (max_mom_pool - max_es_usable).min(max_mana_usable).floor();
    (life_pool + mana_used + max_es_usable, max_mana_usable, mana_used, max_es_usable)
}

/// `breakdown["sharedMindOverMatter"]` / `breakdown[type.."MindOverMatter"]` (lines 2372-2385, 2403-2416).
pub fn mind_over_matter(key: &str, output: &HashMap<String, f64>, es_protects_mana: bool, mom_effect: f64, es_bypass: f64) {
    if !bd::on() {
        return;
    }
    let recoverable = g(output, "LifeRecoverable");
    let (pool, max_mana, mana, es) = calc_mom_eb_pool(output, es_protects_mana, recoverable, mom_effect, es_bypass);
    let life_protected = (mana + es) / mom_effect - (mana + es);
    let mut l = vec![
        String::from("Effective life from Mind over Matter:"),
        sf!("%d life (%d life is protected)", recoverable, life_protected),
        sf!("%d mana%s", mana, if mana == max_mana { String::new() } else { sf!(" (%d mana shadowed by energy shield)", max_mana - mana) }),
    ];
    if es_protects_mana {
        l.push(sf!("%d energy shield", es));
    }
    l.push(sf!("%d + %d %s= %d", recoverable, mana, if es_protects_mana { sf!("+ %d ", es) } else { String::new() }, pool));
    put_lines(key, l);
}

/// `breakdown[...GuardAbsorb]` / `breakdown.FrostShieldLife` (lines 2431-2440, 2449-2458, 2493-2500).
pub fn absorb(key: &str, limit_label: &str, portion_label: &str, limit: f64, rate: f64) {
    if !bd::on() {
        return;
    }
    let life_protected = limit / (rate / 100.0) * (1.0 - rate / 100.0);
    put_lines(
        key,
        vec![
            String::from("Total life protected:"),
            sf!("%d ^8(%s)", limit, limit_label),
            sf!("/ %.2f ^8(%s)", rate / 100.0, portion_label),
            sf!("x %.2f ^8(portion taken from life and energy shield)", 1.0 - rate / 100.0),
            sf!("= %d", life_protected),
        ],
    );
}

/// Lines 2598-2609.
pub fn total_pool(damage_type: &str, output: &HashMap<String, f64>, es_protects_mana: bool, mana_text: &str) {
    if !bd::on() {
        return;
    }
    let recoverable = g(output, "LifeRecoverable");
    let mel = g(output, &format!("{damage_type}ManaEffectiveLife"));
    let pool = g(output, &format!("{damage_type}TotalPool"));
    let mut l = vec![sf!("Life: %d", recoverable)];
    if mel != recoverable {
        l.push(sf!("%s through MoM: %d", mana_text, mel - recoverable));
    }
    if !es_protects_mana && g(output, &format!("{damage_type}EnergyShieldBypass")) < 100.0 {
        l.push(sf!("Non-bypassed Energy Shield: %d", pool - mel));
    }
    l.push(sf!("TotalPool: %d", pool));
    put_lines(&format!("{damage_type}TotalPool"), l);
}

/// Lines 2885-2899.
pub fn configured_damage_chance(block_chance: f64, show_block_effect: bool, block_effect: f64, suppression_effect: f64, average_avoid_chance: f64, out: f64, category: &str) {
    if !bd::on() {
        return;
    }
    let mut l = vec![sf!("%.2f ^8(chance for block to fail)", 1.0 - block_chance)];
    if show_block_effect {
        l.push(sf!("x %.2f ^8(block effect)", block_effect / 100.0));
    }
    if suppression_effect != 1.0 {
        l.push(sf!("x %.3f ^8(suppression effect)", suppression_effect));
    }
    if average_avoid_chance > 0.0 {
        l.push(sf!("x %.2f ^8(chance for avoidance to fail)", 1.0 - average_avoid_chance / 100.0));
    }
    let art = if category == "Average" || category == "Untyped" { "n " } else { " " };
    l.push(sf!("= %.1f%% ^8(of damage taken from a%s hit)", out, format!("{art}{category}")));
    put_lines("ConfiguredDamageChance", l);
}

/// Lines 2905-2951: `ConfiguredNotHitChance`, `TotalNumberOfHits`, `TotalEHP`.
pub fn not_hit_chance_tables(output: &HashMap<String, f64>, category: &str, specific_type_avoidance: bool, worst_of: f64) {
    if !bd::on() {
        return;
    }
    let mut l: Vec<String> = vec![];
    let avoid_proj = g(output, "AvoidProjectilesChance");
    if category == "Melee" || category == "Projectile" {
        let ev = g(output, &format!("{category}EvadeChance"));
        if ev > 0.0 {
            l.push(sf!("%.2f ^8(chance for evasion to fail)", 1.0 - ev / 100.0));
        }
        if g(output, "AttackDodgeChance") > 0.0 {
            l.push(sf!("x %.2f ^8(chance for dodge to fail)", 1.0 - g(output, "AttackDodgeChance") / 100.0));
        }
        if category == "Projectile" && !specific_type_avoidance && avoid_proj > 0.0 {
            l.push(sf!("x %.2f ^8(chance for avoidance to fail)", 1.0 - avoid_proj / 100.0));
        }
    } else if category == "Spell" || category == "SpellProjectile" {
        if g(output, "SpellDodgeChance") > 0.0 {
            l.push(sf!("%.2f ^8(chance for dodge to fail)", 1.0 - g(output, "SpellDodgeChance") / 100.0));
        }
        if category == "SpellProjectile" && !specific_type_avoidance && avoid_proj > 0.0 {
            l.push(sf!("x %.2f ^8(chance for avoidance to fail)", 1.0 - avoid_proj / 100.0));
        }
    } else if category == "Average" {
        let (me, pe) = (g(output, "MeleeEvadeChance"), g(output, "ProjectileEvadeChance"));
        if me > 0.0 || pe > 0.0 {
            l.push(sf!("%.2f ^8(chance for evasion to fail, only applies to the attack portion)", 1.0 - (me + pe) / 2.0 / 100.0));
        }
        let (ad, sd) = (g(output, "AttackDodgeChance"), g(output, "SpellDodgeChance"));
        if ad > 0.0 || sd > 0.0 {
            l.push(sf!("x%.2f ^8(chance for dodge to fail)", 1.0 - (ad + sd) / 2.0 / 100.0));
        }
        if !specific_type_avoidance && avoid_proj > 0.0 {
            l.push(sf!("x %.2f ^8(chance for avoidance to fail)", 1.0 - avoid_proj / 2.0 / 100.0));
        }
    }
    let all = g(output, "AvoidAllDamageFromHitsChance");
    if all > 0.0 {
        l.push(sf!("x %.2f ^8(chance for damage avoidance to fail)", 1.0 - all / 100.0));
    }
    if worst_of > 1.0 {
        l.push(sf!("unlucky worst of %d", worst_of));
    }
    let art = if category == "Average" || category == "Untyped" { "n " } else { " " };
    l.push(sf!("= %d%% ^8(chance to be hit by a%s hit)", 100.0 - g(output, "ConfiguredNotHitChance"), format!("{art}{category}")));
    put_lines("ConfiguredNotHitChance", l);
    put_lines(
        "TotalNumberOfHits",
        vec![
            sf!("%.2f ^8(Number of mitigated hits)", g(output, "NumberOfMitigatedDamagingHits")),
            sf!("/ %.2f ^8(Chance to even be hit)", 1.0 - g(output, "ConfiguredNotHitChance") / 100.0),
            sf!("= %.2f ^8(total average number of hits you can take)", g(output, "TotalNumberOfHits")),
        ],
    );
    put_lines(
        "TotalEHP",
        vec![
            sf!("%.2f ^8(total average number of hits you can take)", g(output, "TotalNumberOfHits")),
            sf!("x %d ^8(total incoming damage)", g(output, "totalEnemyDamageIn")),
            sf!("= %d ^8(total damage you can take)", g(output, "TotalEHP")),
        ],
    );
}

/// Lines 2967-2973.
pub fn survival_time(output: &HashMap<String, f64>) {
    if !bd::on() {
        return;
    }
    put_lines(
        "EHPSurvivalTime",
        vec![
            sf!("%.2f ^8(total average number of hits you can take)", g(output, "TotalNumberOfHits")),
            sf!("x %.2f ^8enemy attack/cast time", g(output, "enemySkillTime")),
            sf!("= %.2f seconds ^8(total time it would take to die)", g(output, "EHPSurvivalTime")),
        ],
    );
}

/// Lines 3014-3062, one recoup type. `pseudo` is `output["Total"..type.."PseudoRecoup"]` and `extra` the Pious Path pair.
#[allow(clippy::too_many_arguments)]
pub fn recoup_recovery(output: &HashMap<String, f64>, recoup_type: &str, total_damage: f64, total_elemental_damage: f64, recoup_time: f64, pseudo: f64, pseudo_duration: f64, extra: Option<(f64, f64)>) {
    if !bd::on() {
        return;
    }
    let mut multiple = 0;
    let mut mx: Vec<String> = vec![];
    if g(output, &format!("{recoup_type}Recoup")) > 0.0 {
        mx.push(sf!("%d ^8(total damage taken during ehp calcs)", total_damage));
        mx.push(sf!("* %.2f ^8(percent of damage recouped)", g(output, &format!("{recoup_type}Recoup")) / 100.0));
        multiple += 1;
    }
    let elem = g(output, &format!("Elemental{recoup_type}Recoup"));
    if elem > 0.0 && total_elemental_damage > 0.0 {
        if multiple > 0 {
            mx.push(String::new());
        }
        mx.push(sf!("%s%d ^8(total elemental damage taken during ehp calcs)", if multiple > 0 { "+" } else { "" }, total_damage));
        mx.push(sf!("* %.2f ^8(percent of damage recouped)", elem / 100.0));
        multiple += 1;
    }
    for &dt in DMG_TYPES {
        let r = g(output, &format!("{dt}{recoup_type}Recoup"));
        if r > 0.0 && g(output, &format!("{dt}RecoupableDamageTaken")) > 0.0 {
            if multiple > 0 {
                mx.push(String::new());
            }
            mx.push(sf!("%s%d ^8(total %s damage taken during ehp calcs)", if multiple > 0 { "+" } else { "" }, total_damage, dt));
            mx.push(sf!("* %.2f ^8(percent of damage recouped)", r / 100.0));
            multiple += 1;
        }
    }
    mx.push(sf!("= %d ^8(total damage recoup amount)", g(output, &format!("Total{recoup_type}RecoupRecovery"))));
    let mut avg = mx.clone();
    let survival = g(output, "EHPSurvivalTime");
    mx.push(sf!("/ %.2f ^8(over %d seconds)", recoup_time, recoup_time));
    if pseudo > 0.0 {
        mx.push(sf!("+ %.2f ^8(total damage mitigated pseudo recoup amount)", pseudo));
        mx.push(sf!("/ %.2f ^8(over %d seconds)", pseudo_duration, pseudo_duration));
    }
    if let Some((v, d)) = extra {
        mx.push(sf!("+ %.2f ^8(total damage mitigated pseudo recoup amount)", v));
        mx.push(sf!("/ %.2f ^8(over %d seconds)", d, d));
    }
    mx.push(sf!("= %.2f per second ^8", g(output, &format!("{recoup_type}RecoupRecoveryMax"))));
    avg.push(sf!("/ %.2f ^8(total time of the recoup (survival time + %d seconds))", survival + recoup_time, recoup_time));
    if pseudo > 0.0 {
        avg.push(sf!("+ %.2f ^8(total damage mitigated pseudo recoup amount)", pseudo));
        avg.push(sf!("/ %.2f ^8(total time of the recoup (survival time + %d seconds)", survival + pseudo_duration, pseudo_duration));
    }
    if let Some((v, d)) = extra {
        avg.push(sf!("+ %.2f ^8(total damage mitigated pseudo recoup amount)", v));
        avg.push(sf!("/ %.2f ^8(total time of the recoup (survival time + %d seconds)", survival + d, d));
    }
    avg.push(sf!("= %.2f per second ^8", g(output, &format!("{recoup_type}RecoupRecoveryAvg"))));
    put_lines(&format!("{recoup_type}RecoupRecoveryMax"), mx);
    put_lines(&format!("{recoup_type}RecoupRecoveryAvg"), avg);
}

/// Lines 3071-3092.
pub fn life_loss_lost(output: &HashMap<String, f64>, life_loss_below_half_lost: f64) {
    if !bd::on() {
        return;
    }
    let over_time = g(output, "LifeLossLostOverTime");
    let below = g(output, "LifeBelowHalfLossLostOverTime");
    let mk = |tail: String, out: f64| -> Vec<String> {
        let mut l: Vec<String> = vec![];
        if over_time != 0.0 {
            l.push(sf!("( %d ^8(total damage prevented by Progenesis)", over_time));
        }
        if below != 0.0 {
            l.push(sf!("%s %d ^8(total damage prevented by petrified blood)", if over_time != 0.0 { "+" } else { "(" }, below));
            l.push(sf!("* %.2f ^8(percent of damage taken from petrified blood)", life_loss_below_half_lost));
        }
        l.push(tail);
        l.push(sf!("= %.2f per second", out));
        l
    };
    put_lines("LifeLossLostMax", mk(sf!(") / %.2f ^8(over 4 seconds)", 4.0), g(output, "LifeLossLostMax")));
    put_lines("LifeLossLostAvg", mk(sf!(") / %.2f ^8(total time of the degen (survival time + 4 seconds))", g(output, "EHPSurvivalTime") + 4.0), g(output, "LifeLossLostAvg")));
}

/// Lines 3101-3115.
pub fn net_recoup(output: &HashMap<String, f64>) {
    if !bd::on() {
        return;
    }
    put_lines(
        "netLifeRecoupAndLossLostOverTimeMax",
        vec![
            sf!("%.2f ^8(total life recouped per second)", g(output, "LifeRecoupRecoveryMax")),
            sf!("- %.2f ^8(total life taken over time per second)", g(output, "LifeLossLostMax")),
            sf!("= %.2f per second", g(output, "netLifeRecoupAndLossLostOverTimeMax")),
        ],
    );
    put_lines(
        "netLifeRecoupAndLossLostOverTimeAvg",
        vec![
            sf!("%.2f ^8(total life recouped per second)", g(output, "LifeRecoupRecoveryAvg")),
            sf!("- %.2f ^8(total life taken over time per second)", g(output, "LifeLossLostAvg")),
            sf!("= %.2f per second", g(output, "netLifeRecoupAndLossLostOverTimeAvg")),
        ],
    );
}

/// Lines 3132-3160.
#[allow(clippy::too_many_arguments)]
pub fn pvp(output: &HashMap<String, f64>, t: f64, multiplier: f64, ne1: f64, ne2: f64, e1: f64, e2: f64, pct_non_elemental: f64, pct_elemental: f64, portion_non_elemental: f64, portion_elemental: f64) {
    if !bd::on() {
        return;
    }
    let total = g(output, "totalTakenHit");
    let both = pct_non_elemental > 0.0 && pct_elemental > 0.0;
    let mut l: Vec<String> = vec![];
    l.push(sf!("Pvp Formula is (D/(T*M))^E*T*%s, where D is the damage, T is the time taken,", if both { "M*P" } else { "M" }));
    l.push(sf!(" M is the multiplier%s", if both { ", E is the exponent and P is the percentage of that type (ele or non ele)" } else { " and E is the exponent" }));
    if both {
        l.push(sf!("(M= %.1f for ele and %.1f for non-ele)(E= %.2f for ele and %.2f for non-ele)", e2, ne2, e1, ne1));
        l.push(sf!("(%.1f / (%.2f * %.1f)) ^ %.2f * %.2f * %.1f * %.2f = %.1f", total, t, ne2, ne1, t, ne2, pct_non_elemental, portion_non_elemental));
        l.push(sf!("(%.1f / (%.2f * %.1f)) ^ %.2f * %.2f * %.1f * %.2f = %.1f", total, t, e2, e1, t, e2, pct_elemental, portion_elemental));
        l.push(sf!("(portionNonElemental + portionElemental)%s", if multiplier != 1.0 { " * PvP multiplier" } else { " " }));
        if multiplier != 1.0 {
            l.push(sf!("(%.1f + %.1f) * %g", portion_non_elemental, portion_elemental, multiplier));
        } else {
            l.push(sf!("%.1f + %.1f", portion_non_elemental, portion_elemental));
        }
    } else if pct_elemental <= 0.0 {
        l.push(sf!("(M= %.1f for non-ele)(E= %.2f for non-ele)", ne2, ne1));
        l.push(sf!("(%.1f / (%.2f * %.1f)) ^ %.2f * %.2f * %.1f = %.1f", total, t, ne2, ne1, t, ne2, portion_non_elemental));
        if multiplier != 1.0 {
            l.push(sf!("%.1f * %g ^8(portionNonElemental * PvP multiplier)", portion_non_elemental, multiplier));
        }
    } else if pct_non_elemental <= 0.0 {
        l.push(sf!("(M= %.1f for ele)(E= %.2f for ele)", e2, e1));
        l.push(sf!("(%.1f / (%.2f * %.1f)) ^ %.2f * %.2f * %.1f = %.1f", total, t, e2, e1, t, e2, portion_elemental));
        if multiplier != 1.0 {
            l.push(sf!("%.1f * %g ^8(portionElemental * PvP multiplier)", portion_elemental, multiplier));
        }
    }
    l.push(sf!("= %.1f", g(output, "PvPTotalTakenHit")));
    put_lines("PvPTotalTakenHit", l);
}

/// `incomingDamageBreakdown(breakdownTable, poolsRemaining, output)` (lines 431-477).
pub fn incoming_damage_breakdown(l: &mut Vec<String>, pools: &PoolsResult, output: &HashMap<String, f64>) {
    for ally in ALLY_LIFE_POOL_LIST {
        if let Some(pool) = pools.allies_taken_before_you.get(ally.key) {
            let life = g(output, ally.life);
            l.push(sf!(&format!("\t%d {GEM}{} ^7(%d remaining)", ally_label(ally.key)), life - pool.remaining, pool.remaining));
        }
    }
    for (i, &dt) in DMG_TYPES.iter().enumerate() {
        if let Some(a) = pools.resources_lost[i].aegis {
            l.push(sf!(&format!("\t%d {GEM}%s Aegis charge ^7(%d remaining)"), a, dt, pools.aegis.get(dt).copied().unwrap_or(0.0)));
        }
    }
    let pr_shared_elemental = pools.aegis.get("sharedElemental").copied().unwrap_or(0.0);
    if let Some(se) = output.get("sharedElementalAegis").copied() {
        if se != pr_shared_elemental {
            l.push(sf!(&format!("\t%d {GEM}Elemental Aegis charge ^7(%d remaining)"), se - pr_shared_elemental, pr_shared_elemental));
        }
    }
    if let Some(sa) = output.get("sharedAegis").copied() {
        if sa > 0.0 {
            let rem = pools.aegis.get("shared").copied().unwrap_or(0.0);
            l.push(sf!(&format!("\t%d {GEM}Shared Aegis charge ^7(%d remaining)"), sa - rem, rem));
        }
    }
    for (i, &dt) in DMG_TYPES.iter().enumerate() {
        if let Some(gd) = pools.resources_lost[i].guard {
            l.push(sf!(&format!("\n\t%d {SCOURGE}%s Guard charge ^7(%d remaining)"), gd, dt, pools.guard.get(dt).copied().unwrap_or(0.0)));
        }
    }
    if let Some(sg) = output.get("sharedGuardAbsorb").copied() {
        if sg > 0.0 {
            let rem = pools.guard.get("shared").copied().unwrap_or(0.0);
            l.push(sf!(&format!("\t%d {SCOURGE}Shared Guard charge ^7(%d remaining)"), sg - rem, rem));
        }
    }
    if let Some(ward) = output.get("Ward").copied() {
        if ward > 0.0 {
            l.push(sf!(&format!("\t%d {WARD}Ward"), ward));
        }
    }
    if let Some(cap) = output.get("EnergyShieldRecoveryCap").copied() {
        if cap != pools.energy_shield && cap > 0.0 {
            l.push(sf!(&format!("\t%d {ES}Energy Shield ^7(%d remaining)"), cap - pools.energy_shield, pools.energy_shield));
        }
    }
    if let Some(mu) = output.get("ManaUnreserved").copied() {
        if mu != pools.mana && mu > 0.0 {
            l.push(sf!(&format!("\t%d {MANA}Mana ^7(%d remaining)"), mu - pools.mana, pools.mana));
        }
    }
    if pools.life_loss_lost_over_time + pools.life_below_half_loss_lost_over_time > 0.0 {
        l.push(sf!(&format!("\t%d {LIFE}Life ^7Loss Prevented"), pools.life_loss_lost_over_time + pools.life_below_half_loss_lost_over_time));
    }
    l.push(sf!(&format!("\t%d {LIFE}Life ^7(%d remaining)"), g(output, "LifeRecoverable") - pools.life, pools.life));
    if pools.overkill_damage >= 1.0 {
        l.push(sf!(&format!("\t%d {NEGATIVE}Overkill damage"), pools.overkill_damage));
    }
}

fn lines_to_value(l: Vec<String>) -> Value {
    Value::Array(l.into_iter().map(Value::String).collect())
}

/// Lines 3310-3354: `breakdown[type.."MaximumHitTaken"]`.
pub fn max_hit(damage_type: &str, final_max_hit: f64, enemy_damage_mult: f64, use_conversion_smoothing: bool, shift_table: &HashMap<String, f64>, store: &pom_engine::modstore::store::ModStore, output: &HashMap<String, f64>) {
    if !bd::on() {
        return;
    }
    let (full_taken, mut taken_damages) = crate::pools::taken_hit_from_damage(final_max_hit * enemy_damage_mult, damage_type, shift_table, store, output);
    let full_taken = if full_taken == full_taken { full_taken } else { 0.0 };
    let mut order: Vec<&str> = DMG_TYPES.iter().copied().filter(|&d| d != damage_type).collect();
    order.push(damage_type);
    let mut rows: Vec<Value> = vec![];
    for &t in &order {
        let Some(&amt) = taken_damages.get(t) else { continue };
        let conversion = shift_table.get(t).copied().unwrap_or(0.0);
        let incoming = final_max_hit * enemy_damage_mult * conversion / 100.0;
        let nan_to_zero = if amt == amt { amt } else { 0.0 };
        taken_damages.insert(t.to_string(), nan_to_zero);
        rows.push(row(vec![
            ("type", s(sf!("%d%% as %s", conversion, t))),
            ("pool", s(sf!("%d", g(output, &format!("{t}TotalHitPool"))))),
            ("incoming", s(sf!("%.0f", incoming))),
            ("multi", s(sf!("x%.3f", nan_to_zero / incoming))),
            ("taken", s(sf!("%.0f", nan_to_zero))),
        ]));
    }
    let full_multi = full_taken / final_max_hit / enemy_damage_mult;
    let mut l: Vec<String> = vec![String::from("^8Maximum hit is calculated in reverse -"), String::from("^8from health pools, via damage reductions, to the max hit:"), sf!("%d ^8(used pool)", full_taken)];
    if bd::round(full_multi, 2) != 1.0 {
        l.push(sf!("/ %.2f ^8(modifiers to damage taken)", full_multi));
    }
    if enemy_damage_mult != 1.0 {
        l.push(sf!("/ %.2f ^8(modifiers to enemy damage)", enemy_damage_mult));
    }
    l.push(sf!("= %.0f ^8maximum survivable enemy damage%s", final_max_hit, if use_conversion_smoothing { " (approximate)" } else { "" }));
    l.push(String::from("^8Such a hit would drain the following resources:"));
    let pools = crate::pools::reduce_pools_by_damage(None, &taken_damages, store, output);
    incoming_damage_breakdown(&mut l, &pools, output);
    let mut tbl = serde_json::Map::new();
    for (i, line) in l.into_iter().enumerate() {
        tbl.insert((i + 1).to_string(), Value::String(line));
    }
    tbl.insert("label".into(), s("Maximum hit damage breakdown"));
    tbl.insert("rowList".into(), Value::Array(rows));
    tbl.insert(
        "colList".into(),
        json!([{"label": "Type", "key": "type"}, {"label": "Pool", "key": "pool"}, {"label": "Incoming", "key": "incoming"}, {"label": "Multi", "key": "multi"}, {"label": "Taken", "key": "taken"}]),
    );
    put_table(&format!("{damage_type}MaximumHitTaken"), Value::Object(tbl));
}

/// Lines 3373-3379.
pub fn dot_ehp(damage_type: &str, output: &HashMap<String, f64>) {
    if !bd::on() {
        return;
    }
    put_lines(
        &format!("{damage_type}DotEHP"),
        vec![
            sf!("Total Pool: %d", g(output, &format!("{damage_type}TotalPool"))),
            sf!("Dot Damage Taken modifier: %.2f", g(output, &format!("{damage_type}TakenDotMult"))),
            sf!("Total Effective Dot Pool: %d", g(output, &format!("{damage_type}DotEHP"))),
        ],
    );
}

/// The `{ rowList = { }, colList = { ... } }` tables of the degen sections (no label).
fn degen_table(cols: &[(&str, &str)]) -> Value {
    let col_list: Vec<Value> = cols.iter().map(|(l, k)| json!({ "label": l, "key": k })).collect();
    json!({ "rowList": [], "colList": col_list })
}

/// One degen row: `TotalBuildDegen` / `<type>BuildDegen` (lines 3394-3430) and the enemy twins (3561-3600, 3630-3670).
/// `source` is `Some` for the enemy ones. Creates the tables on first use (`x = x or { ... }`).
#[allow(clippy::too_many_arguments)]
pub fn degen_row(total_key: &str, per_type_key: &str, source: Option<&str>, damage_type: &str, converted_type: &str, base: f64, convert_percent: f64, mult: f64, total: f64) {
    if !bd::on() {
        return;
    }
    let make_total = || {
        if source.is_some() {
            degen_table(&[("Source", "source"), ("Base Type", "type"), ("Final Type", "type2"), ("Base", "base"), ("Taken As Percent", "conv"), ("Multiplier", "mult"), ("Total", "total")])
        } else {
            degen_table(&[("Base Type", "type"), ("Final Type", "type2"), ("Base", "base"), ("Taken As Percent", "conv"), ("Multiplier", "mult"), ("Total", "total")])
        }
    };
    let make_type = || {
        if source.is_some() {
            degen_table(&[("Source", "source"), ("Base Type", "type"), ("Base", "base"), ("Taken As Percent", "conv"), ("Multiplier", "mult"), ("Total", "total")])
        } else {
            degen_table(&[("Base Type", "type"), ("Base", "base"), ("Taken As Percent", "conv"), ("Multiplier", "mult"), ("Total", "total")])
        }
    };
    bd::root(|b| {
        if bd::get(b, total_key).is_none() {
            set(b, total_key, make_total());
        }
        if bd::get(b, per_type_key).is_none() {
            set(b, per_type_key, make_type());
        }
    });
    let mut r1 = vec![];
    let mut r2 = vec![];
    if let Some(src) = source {
        r1.push(("source", s(src)));
        r2.push(("source", s(src)));
    }
    r1.push(("type", s(damage_type)));
    r1.push(("type2", s(converted_type)));
    r2.push(("type", s(damage_type)));
    for rr in [&mut r1, &mut r2] {
        rr.push(("base", s(sf!("%.1f", base))));
        rr.push(("conv", s(sf!("x %.2f%%", convert_percent))));
        rr.push(("mult", s(sf!("x %.2f", mult))));
        rr.push(("total", s(sf!("%.1f", total))));
    }
    push_row(total_key, row(r1));
    push_row(per_type_key, row(r2));
}

/// The three `Net...Regen` tables of the build degen and the comprehensive degen (lines 3445-3530, 3686-3786).
pub struct NetDegen {
    pub comprehensive: bool,
    /// per damage type: (type, life, mana, es)
    pub rows: Vec<(&'static str, f64, f64, f64)>,
    pub total_life: f64,
    pub total_mana: f64,
    pub total_es: f64,
}

pub fn net_regen_tables(n: &NetDegen, output: &HashMap<String, f64>) {
    if !bd::on() {
        return;
    }
    let comp = n.comprehensive;
    let (kl, km, ke, kt) = if comp {
        ("ComprehensiveNetLifeRegen", "ComprehensiveNetManaRegen", "ComprehensiveNetEnergyShieldRegen", "ComprehensiveTotalNetRegen")
    } else {
        ("NetLifeRegen", "NetManaRegen", "NetEnergyShieldRegen", "TotalNetRegen")
    };
    let mk = |label: &str| table_with_rows(label, &[("Type", "type"), ("Degen", "degen")]);
    put_table(kl, mk("Total Life Degen"));
    put_table(km, mk("Total Mana Degen"));
    put_table(ke, mk("Total Energy Shield Degen"));
    for (t, l, m, e) in &n.rows {
        push_row(kl, row(vec![("type", s(*t)), ("degen", s(sf!("%.2f", *l)))]));
        push_row(km, row(vec![("type", s(*t)), ("degen", s(sf!("%.2f", *m)))]));
        push_row(ke, row(vec![("type", s(*t)), ("degen", s(sf!("%.2f", *e)))]));
    }
    let (net_l, net_m, net_e, net_t) = (g(output, kl), g(output, km), g(output, ke), g(output, kt));
    if !comp {
        push(kl, sf!("%.1f ^8(total life regen)", g(output, "LifeRegenRecovery")));
        push(kl, sf!("- %.1f ^8(total life degen)", n.total_life));
        push(kl, sf!("= %.1f", net_l));
        push(km, sf!("%.1f ^8(total mana regen)", g(output, "ManaRegenRecovery")));
        push(km, sf!("- %.1f ^8(total mana degen)", n.total_mana));
        push(km, sf!("= %.1f", net_m));
        push(ke, sf!("%.1f ^8(total energy shield regen)", g(output, "EnergyShieldRegenRecovery")));
        push(ke, sf!("- %.1f ^8(total energy shield degen)", n.total_es));
        push(ke, sf!("= %.1f", net_e));
    } else {
        push(kl, sf!("%.1f ^8(total life regen)", g(output, "LifeRegenRecovery")));
        if g(output, "LifeRecoupRecoveryAvg") != 0.0 {
            push(kl, sf!("+ %.1f ^8(average life recoup)", g(output, "LifeRecoupRecoveryAvg")));
        }
        push(kl, sf!("- %.1f ^8(total life degen)", n.total_life));
        if g(output, "LifeLossLostAvg") != 0.0 {
            push(kl, sf!("- %.1f ^8(average life lost over time)", g(output, "LifeLossLostAvg")));
        }
        push(kl, sf!("= %.1f", net_l));
        push(km, sf!("%.1f ^8(total mana regen)", g(output, "ManaRegenRecovery")));
        if g(output, "ManaRecoupRecoveryAvg") != 0.0 {
            push(km, sf!("+ %.1f ^8(average mana recoup)", g(output, "ManaRecoupRecoveryAvg")));
        }
        push(km, sf!("- %.1f ^8(total mana degen)", n.total_mana));
        push(km, sf!("= %.1f", net_m));
        push(ke, sf!("%.1f ^8(total energy shield regen)", g(output, "EnergyShieldRegenRecovery")));
        if g(output, "EnergyShieldRecoupRecoveryAvg") != 0.0 {
            push(ke, sf!("+ %.1f ^8(average energy shield recoup)", g(output, "EnergyShieldRecoupRecoveryAvg")));
        }
        push(ke, sf!("- %.1f ^8(total energy shield degen)", n.total_es));
        push(ke, sf!("= %.1f", net_e));
    }
    put_lines(
        kt,
        vec![sf!("Net Life Regen: %.1f", net_l), sf!("+ Net Mana Regen: %.1f", net_m), sf!("+ Net Energy Shield Regen: %.1f", net_e), sf!("= Total Net Regen: %.1f", net_t)],
    );
}

/// Lines 3788-3868: `totalTakenHit` rows and drain text, and the per-type `<type>TakenHit` tables.
pub fn taken_hit_tables(output: &HashMap<String, f64>, store: &pom_engine::modstore::store::ModStore) {
    if !bd::on() {
        return;
    }
    let mut taken_hit: HashMap<String, f64> = HashMap::default();
    for &dt in DMG_TYPES {
        let th = g(output, &format!("{dt}TakenHit"));
        if th > 0.0 {
            taken_hit.insert(dt.to_string(), th);
        }
        push_row(
            "totalTakenHit",
            row(vec![
                ("type", s(dt)),
                ("incoming", s(sf!("%.1f incoming damage", g(output, &format!("{dt}TakenDamage"))))),
                ("mult", s(sf!("x %.3f damage mult", g(output, &format!("{dt}TakenHitMult"))))),
                ("value", s(sf!("%d", g(output, &format!("{dt}TakenHit")).ceil()))),
            ]),
        );
    }
    let pools = crate::pools::reduce_pools_by_damage(None, &taken_hit, store, output);
    let mut l: Vec<String> = vec![String::from("Such a hit would drain the following resources:")];
    incoming_damage_breakdown(&mut l, &pools, output);
    bd::root(|b| {
        let t = bd::t(b, "totalTakenHit");
        for line in l {
            ins_s(t, line);
        }
    });
    for (i, &dt) in DMG_TYPES.iter().enumerate() {
        let lost: &ResourcesLost = &pools.resources_lost[i];
        let mut sum = 0.0;
        let mut t: Vec<String> = vec![
            sf!("Final %s Damage taken:", dt),
            sf!("%.1f incoming damage", g(output, &format!("{dt}TakenDamage"))),
            sf!("x %.3f damage mult", g(output, &format!("{dt}TakenHitMult"))),
            sf!("= %.1f", g(output, &format!("{dt}TakenHit"))),
            String::from("This part of the hit drains the following resources:"),
        ];
        for (ai, ally) in ALLY_LIFE_POOL_LIST.iter().enumerate() {
            if let Some(v) = lost.allies[ai] {
                sum += v;
                t.push(sf!(&format!("\t%d {GEM}{}", ally_label(ally.key)), v));
            }
        }
        if let Some(v) = lost.aegis {
            sum += v;
            t.push(sf!(&format!("\t%d {GEM}%s Aegis charge"), v, dt));
        }
        if let Some(v) = lost.shared_elemental_aegis {
            sum += v;
            t.push(sf!(&format!("\t%d {GEM}Elemental Aegis charge"), v));
        }
        if let Some(v) = lost.shared_aegis {
            sum += v;
            t.push(sf!(&format!("\t%d {GEM}Shared Aegis charge"), v));
        }
        if let Some(v) = lost.guard {
            sum += v;
            t.push(sf!(&format!("\n\t%d {SCOURGE}%s Guard charge"), v, dt));
        }
        if let Some(v) = lost.shared_guard {
            sum += v;
            t.push(sf!(&format!("\t%d {SCOURGE}Shared Guard charge"), v));
        }
        if let Some(v) = lost.ward {
            sum += v;
            t.push(sf!(&format!("\t%d {WARD}Ward"), v));
        }
        if let Some(v) = lost.energy_shield {
            sum += v;
            t.push(sf!(&format!("\t%d {ES}Energy Shield"), v));
        }
        if let Some(v) = lost.mana {
            sum += v;
            t.push(sf!(&format!("\t%d {MANA}Mana"), v));
        }
        if let Some(v) = lost.life_loss_prevented {
            if v > 0.0 {
                sum += v;
                t.push(sf!(&format!("\t%d {LIFE}Life ^7Loss Prevented"), v));
            }
        }
        if let Some(v) = lost.life {
            if v > 0.0 {
                sum += v;
                t.push(sf!(&format!("\t%d {LIFE}Life"), v));
            }
        }
        if let Some(v) = lost.overkill {
            sum += v;
            t.push(sf!(&format!("\t%d {NEGATIVE}Overkill damage"), v));
        }
        t.push(sf!("\t^8(%d total)", sum));
        put_table(&format!("{dt}TakenHit"), lines_to_value(t));
    }
}

/// Per-type split of a degen total across life / mana / energy shield (lines 3471-3508, 3712-3734), for the net regen
/// tables. `degens` are the (type, total degen) pairs upstream loops over, in `dmgTypeList` order.
#[allow(clippy::type_complexity)]
pub fn net_degen_rows(output: &HashMap<String, f64>, es_protects_mana: bool, degens: &[(&'static str, f64)], comprehensive: bool) -> NetDegen {
    let es_regen_recovery = g(output, "EnergyShieldRegenRecovery");
    let mut n = NetDegen { comprehensive, rows: vec![], total_life: 0.0, total_mana: 0.0, total_es: 0.0 };
    for &(dt, type_degen) in degens {
        let taken_from_mana = g(output, &format!("{dt}MindOverMatter")) + g(output, "sharedMindOverMatter");
        let es_bypass = g(output, &format!("{dt}EnergyShieldBypass")) / 100.0;
        let (life, mana, es);
        if es_regen_recovery > 0.0 {
            if es_protects_mana {
                life = type_degen * (1.0 - taken_from_mana / 100.0);
                es = type_degen * (1.0 - es_bypass) * (taken_from_mana / 100.0);
            } else {
                life = type_degen * es_bypass * (1.0 - taken_from_mana / 100.0);
                es = type_degen * (1.0 - es_bypass);
            }
            mana = type_degen * es_bypass * (taken_from_mana / 100.0);
        } else {
            life = type_degen * (1.0 - taken_from_mana / 100.0);
            mana = type_degen * (taken_from_mana / 100.0);
            es = 0.0;
        }
        n.total_life += life;
        n.total_mana += mana;
        n.total_es += es;
        n.rows.push((dt, life, mana, es));
    }
    n
}

/// One `actor.allyLifeList[stat]` entry: `{ name, life, count }` (a totem has no count).
#[derive(Clone)]
pub struct AllyEntry {
    pub name: String,
    pub life: f64,
    pub count: Option<f64>,
}

thread_local! {
    /// `env.player.allyLifeList` (CalcPerform.lua:3667-3790), kept only for the Calcs mode's breakdown tables.
    static ALLY_LIFE_LIST: std::cell::RefCell<Vec<(String, Vec<AllyEntry>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub fn ally_list_reset() {
    ALLY_LIFE_LIST.with(|l| l.borrow_mut().clear());
}

/// `t_insert(env.player.allyLifeList[stat], entry)`; returns the entry's index.
pub fn ally_entry(stat: &str, name: &str, life: f64, count: Option<f64>) -> usize {
    if !bd::calcs_mode() {
        return 0;
    }
    ALLY_LIFE_LIST.with(|l| {
        let mut l = l.borrow_mut();
        let i = match l.iter().position(|(s, _)| s == stat) {
            Some(i) => i,
            None => {
                l.push((stat.to_string(), vec![]));
                l.len() - 1
            }
        };
        l[i].1.push(AllyEntry { name: name.to_string(), life, count });
        l[i].1.len() - 1
    })
}

/// `firstSpectre.entry.count += count; firstSpectre.entry.life += life` (CalcPerform.lua:3739-3741).
pub fn ally_entry_add(stat: &str, index: usize, count: f64, life: f64) {
    if !bd::calcs_mode() {
        return;
    }
    ALLY_LIFE_LIST.with(|l| {
        if let Some((_, v)) = l.borrow_mut().iter_mut().find(|(s, _)| s == stat) {
            if let Some(e) = v.get_mut(index) {
                e.count = Some(e.count.unwrap_or(0.0) + count);
                e.life += life;
            }
        }
    });
}

/// Lines 2543-2560: `breakdown[ally.life]` for the pools that have an ally list or a config override.
pub fn ally_life_tables(output: &HashMap<String, f64>, store: &pom_engine::modstore::store::ModStore, shared_minion_life_override: bool) {
    if !bd::on() {
        return;
    }
    let list_ok = bd::current_actor() == 0;
    for ally in ALLY_LIFE_POOL_LIST {
        let Some(&life) = output.get(ally.life) else { continue };
        let entries: Option<Vec<AllyEntry>> = if list_ok { ALLY_LIFE_LIST.with(|l| l.borrow().iter().find(|(s, _)| s == ally.life).map(|(_, v)| v.clone())) } else { None };
        let ov = store.override_(None, &[pom_engine::sym::Sym::new(ally.life)]).and_then(|v| v.num()).is_some() || (ally.life == "TotalMinionLife" && shared_minion_life_override && output.contains_key("TotalMinionLife"));
        if entries.is_none() && !ov {
            continue;
        }
        let mut l: Vec<String> = vec![];
        if ov {
            l.push(sf!("%d ^8(from config)", life));
        } else if let Some(entries) = entries {
            for e in entries {
                let c = match e.count {
                    Some(c) if c > 1.0 => format!("{}x ", bd::tostr(c)),
                    _ => String::new(),
                };
                l.push(sf!("%d ^8(%s%s)", e.life, c, e.name));
            }
        }
        put_lines(ally.life, l);
    }
}
