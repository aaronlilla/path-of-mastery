//! Calcs-mode breakdown tables of CalcOffence.lua 4750-5500: the rest of the Poison section, the Ignite section and the
//! non-damaging ailment loop (Chill / Freeze / Shock / Scorch / Brittle / Sap). Called from `dot::calc_poison`,
//! `dot::calc_ignite` and `offence_dps::pass_ailments`, always behind `bd::on()`; each function takes the values the Lua
//! reads at that line.
use crate::bd::{self, ins, ins_s, row, s, set, tostr};
use crate::bdbuild::{self, Chain, Link};
use crate::sf;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use serde_json::Value;
use std::cell::RefCell;

/// What upstream reads from the pass: `isAttack`, `pass.label`, `ailmentMode`, `(globalOutput.HitTime or output.Time)`.
#[derive(Clone, Default)]
pub struct Ctx {
    pub is_attack: bool,
    /// "Main Hand" / "Off Hand" / "Skill" (upstream's `pass.label`).
    pub pass_label: &'static str,
    pub ailment_mode_crit: bool,
    pub g_hit_time_or_time: Option<f64>,
    /// `output.HasBonechill` of the pass output.
    pub has_bonechill: bool,
}

thread_local! {
    static CTX: RefCell<Ctx> = RefCell::new(Ctx::default());
}

pub fn set_ctx(c: Ctx) {
    CTX.with(|x| *x.borrow_mut() = c);
}

fn ctx() -> Ctx {
    CTX.with(|x| x.borrow().clone())
}

fn mode_line() -> String {
    sf!("Ailment mode: %s ^8(can be changed in the Configuration tab)", if ctx().ailment_mode_crit { "Crits Only" } else { "Average Damage" })
}

/// `breakdown.<Type><Dmg> = { damageTypes = { } }` for the five damage types (CalcOffence.lua:4702-4706, 5007-5011).
fn damage_type_tables(names: [&str; 5]) {
    bd::cur(|b| {
        for k in names {
            let t = bd::reset(b, k);
            set(t, "damageTypes", Value::Array(vec![]));
        }
    });
}

pub fn poison_tables() {
    damage_type_tables(["PoisonPhysical", "PoisonLightning", "PoisonCold", "PoisonFire", "PoisonChaos"]);
}

pub fn ignite_tables() {
    damage_type_tables(["IgnitePhysical", "IgniteLightning", "IgniteCold", "IgniteFire", "IgniteChaos"]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Poison
// ---------------------------------------------------------------------------------------------------------------------

pub struct PoisonStacksBd {
    pub duration: f64,
    pub chance: f64,
    pub hit_chance: f64,
    pub additional: f64,
    pub hit_speed: f64,
    pub dps_mult: f64,
    pub stack_mult: f64,
    pub quantity_mult: f64,
    pub stacks: f64,
    /// `skillModList:Flag(nil, "Condition:NonPoisonedOnly")` at that line.
    pub non_poisoned_flag: bool,
    pub limit: Option<f64>,
    pub uncapped: Option<f64>,
}

/// CalcOffence.lua:4747-4772 (`globalBreakdown.PoisonStacks`).
pub fn poison_stacks(h: &PoisonStacksBd) {
    bd::root(|g| {
        let st = bd::reset(g, "PoisonStacks");
        let mut c = Chain::new();
        c.base = Some(Link::n("%.2fs ^8(poison duration)", h.duration));
        c.links = vec![
            Link::n("%.2f ^8(poison chance)", h.chance),
            Link::n("%.2f ^8(hit chance)", h.hit_chance / 100.0),
            Link::n("%.2f ^8(avg. # of poisons inflicted)", h.additional),
            Link::n("%.2f ^8(hits per second)", h.hit_speed),
            Link::n("%g ^8(dps multiplier for this skill)", h.dps_mult),
            Link::n("%g ^8(stack multiplier for this skill)", h.stack_mult),
            Link::n("%g ^8(quantity multiplier for this skill)", h.quantity_mult),
        ];
        c.total = Some(sf!("= %.2f", h.stacks));
        bdbuild::multi_chain(st, &c);
        if h.non_poisoned_flag {
            ins_s(st, "Assuming 'non-Poisoned' Enemy");
            if h.stacks < h.additional {
                ins_s(st, "^8(time between hits is longer than poison duration)");
            } else {
                ins_s(st, format!("^8(affected by poison stack limit of: {})", tostr(h.additional)));
            }
        } else if let Some(limit) = h.limit.filter(|l| h.stacks >= *l) {
            ins_s(st, format!("^8(affected by poison stack limit of: {})", tostr(limit)));
            if let Some(u) = h.uncapped {
                ins_s(st, format!("^8(uncapped poison stacks: {})", sf!("%.2f", u)));
            }
        }
    });
}

/// CalcOffence.lua:4838-4842.
pub fn poison_mode() {
    let line = mode_line();
    bd::root(|g| ins_s(bd::reset(g, "PoisonDPS"), line));
}

/// `globalBreakdown.<Ailment>EffMult = breakdown.effMult(type, resist, 0, takenInc, effMult, takenMore, sourceRes, true)` when `effMult ~= 1`.
pub fn eff_mult_table(key: &str, enemy_db: &ModStore, cfg: &Cfg, damage_type: &str, resist: f64, taken_names: &[&str], eff: f64, source_res: &str) {
    if eff == 1.0 {
        return;
    }
    let syms: Vec<Sym> = taken_names.iter().map(|n| Sym::new(n)).collect();
    let taken_inc = enemy_db.sum(ModType::Inc, Some(cfg), &syms);
    let taken_more = enemy_db.more(Some(cfg), &syms);
    let v = bdbuild::eff_mult(damage_type, resist, 0.0, taken_inc, eff, taken_more, Some(source_res), true, None, None);
    bd::root(|g| set(g, key, v));
}

pub struct PoisonMain {
    pub base_val: f64,
    pub effect_mod: f64,
    pub rate_mod: f64,
    pub eff: f64,
    pub ruthless: f64,
    pub single_uncapped: f64,
    pub single_capped: f64,
    pub base_min_val: f64,
    pub base_max_val: f64,
    pub dot_dps_cap: f64,
    /// `output.PoisonDotMulti` / `output.CritPoisonDotMulti` before the blend.
    pub dot_multi: Option<f64>,
    pub crit_dot_multi: Option<f64>,
    /// `output.PoisonChanceOnHit` / `OnCrit` (after the chaos chance was folded in), `globalOutput.CritChance`.
    pub chance_on_hit: f64,
    pub chance_on_crit: f64,
    pub global_crit_chance: f64,
    pub show_average: bool,
    pub stacks: f64,
    pub duration: f64,
    pub duration_base: f64,
    pub duration_mod: f64,
    pub debuff_duration_mult: f64,
    pub ground_mult: f64,
    pub caustic_ground_dps: Option<f64>,
}

fn capped_note(out: &mut Value, label: &str, uncapped: f64, capped: f64) {
    ins_s(out, sf!("= %.1f ^8(Uncapped raw %s DPS)", uncapped, label));
    ins_s(out, format!("^8(Raw {label} DPS is ^xDD0022overcapped ^8by^7 {} ^8:^7 {}%^8)", sf!("%.0f", uncapped - capped), sf!("%.1f", (uncapped - capped) / capped * 100.0)));
}

/// CalcOffence.lua:4880-4893 (caustic ground) and the `if breakdown then` block 4903-4986.
pub fn poison_main(m: &PoisonMain) {
    let c = ctx();
    if let Some(cg) = m.caustic_ground_dps {
        let lines = vec![
            sf!("%.1f ^8(single poison damage per second)", m.base_val * m.effect_mod * m.rate_mod),
            sf!("* %.1f%% ^8(percent as Caustic ground)", m.ground_mult),
            sf!("* %.3f ^8(effect mult)", m.eff),
            sf!("= %.1f ^8per second", cg),
        ];
        bd::cur(|b| set(b, "CausticGroundDPS", Value::Array(lines.into_iter().map(s).collect())));
    }
    bd::cur(|b| {
        if let (Some(dm), Some(cm)) = (m.dot_multi, m.crit_dot_multi) {
            if cm != dm {
                let chance_from_hit = m.chance_on_hit / 100.0 * (1.0 - m.global_crit_chance / 100.0);
                let chance_from_crit = m.chance_on_crit / 100.0 * m.global_crit_chance / 100.0;
                let total_from_hit = chance_from_hit / (chance_from_hit + chance_from_crit);
                let total_from_crit = chance_from_crit / (chance_from_hit + chance_from_crit);
                set(b, "PoisonDotMulti", bdbuild::crit_dot(dm, cm, total_from_hit, total_from_crit));
            }
        }
        let min_unc = m.base_min_val * m.effect_mod * m.rate_mod * m.eff;
        let min_cap = min_unc.min(m.dot_dps_cap);
        let max_unc = m.base_max_val * m.effect_mod * m.rate_mod * m.eff;
        let max_cap = max_unc.min(m.dot_dps_cap);
        let t = bd::t(b, "PoisonDPS");
        if m.ruthless != 1.0 {
            ins_s(t, sf!("x %.2f ^8(ruthless blow effect modifier)", m.ruthless));
        }
        ins_s(t, "x 0.30 ^8(poison deals 30% per second)");
        ins_s(t, sf!("= %.1f", m.base_val));
        ins_s(t, "");
        ins_s(t, "Poison DPS:");
        if m.base_val != m.single_uncapped {
            ins_s(t, sf!("%.1f ^8(base damage per second)", m.base_val));
        }
        if m.effect_mod != 1.0 {
            ins_s(t, sf!("x %.2f ^8(ailment effect modifier)", m.effect_mod));
        }
        if m.rate_mod != 1.0 {
            ins_s(t, sf!("x %.2f ^8(damage rate modifier)", m.rate_mod));
        }
        if m.eff != 1.0 {
            ins_s(t, sf!("x %.3f ^8(effective DPS modifier from enemy debuffs)", m.eff));
        }
        if m.single_capped != m.single_uncapped {
            capped_note(t, "Poison", m.single_uncapped, m.single_capped);
            ins_s(t, sf!("= %d ^8(Capped Poison DPS)", m.single_capped));
        } else {
            ins_s(t, sf!("= %.1f ^8per second", m.single_capped));
        }
        ins_s(t, sf!("%.2f%% of Maximum Poison DPS", m.single_capped / max_cap * 100.0));
        ins_s(t, "");
        ins_s(t, "DPS Range:");
        if max_cap == max_unc && min_cap == min_unc {
            ins_s(t, sf!("%.0f to %.0f ^8(Poison DPS Range)", min_unc, max_unc));
        } else {
            ins_s(t, sf!("%.0f to %.0f ^8(Uncapped Poison DPS Range)", min_unc, max_unc));
        }
        if min_cap != min_unc {
            ins_s(t, format!("^8(Raw Min Poison DPS is ^xDD0022overcapped ^8by^7 {} ^8:^7 {}%^8)", sf!("%.0f", min_unc - min_cap), sf!("%.1f", (min_unc - min_cap) / min_cap * 100.0)));
        }
        if max_cap != max_unc {
            ins_s(t, format!("^8(Raw Max Poison DPS is ^xDD0022overcapped ^8by^7 {} ^8:^7 {}%^8)", sf!("%.0f", max_unc - max_cap), sf!("%.1f", (max_unc - max_cap) / max_cap * 100.0)));
        }
        if max_cap != max_unc || min_cap != min_unc {
            ins_s(t, sf!("%.0f to %.0f ^8(Capped Poison DPS Range)", min_cap, max_cap));
        }
        if !m.show_average && m.stacks != 1.0 {
            let unc = m.single_capped * m.stacks;
            let cap = unc.min(m.dot_dps_cap);
            let mut lines = Value::Array(vec![]);
            ins_s(&mut lines, sf!("%.1f ^8single poison damage per second", m.single_capped));
            ins_s(&mut lines, sf!("x %.2f ^8(poison stacks)", m.stacks));
            if cap != unc {
                capped_note(&mut lines, "Poison", unc, cap);
                ins_s(&mut lines, sf!("= %d ^8(Capped Poison DPS)", cap));
            } else {
                ins_s(&mut lines, sf!("= %.1f ^8per second", cap));
            }
            set(b, "TotalPoisonDPS", lines);
        }
        let mut pd = Value::Array(vec![]);
        if c.is_attack {
            ins_s(&mut pd, format!("{}:", c.pass_label));
        }
        ins_s(&mut pd, sf!("%.1f ^8(damage per second)", m.single_capped));
        ins_s(&mut pd, sf!("x %.2fs ^8(poison duration)", m.duration));
        ins_s(&mut pd, sf!("= %.1f ^8damage per poison stack", m.single_capped * m.duration));
        set(b, "PoisonDamage", pd);
    });
    if m.duration != 2.0 {
        bd::root(|g| {
            let t = bd::reset(g, "PoisonDuration");
            ins_s(t, sf!("%.2fs ^8(base duration)", m.duration_base));
            if m.duration_mod != 1.0 {
                ins_s(t, sf!("x %.2f ^8(duration modifier)", m.duration_mod));
            }
            if m.rate_mod != 1.0 {
                ins_s(t, sf!("/ %.2f ^8(damage rate modifier)", m.rate_mod));
            }
            if m.debuff_duration_mult != 1.0 {
                ins_s(t, sf!("/ %.2f ^8(debuff expires slower/faster)", 1.0 / m.debuff_duration_mult));
            }
            ins_s(t, sf!("= %.2fs", m.duration));
        });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ignite
// ---------------------------------------------------------------------------------------------------------------------

pub struct IgniteHead {
    pub max_stacks: f64,
    /// `skillModList:Override(nil, "IgniteStackPotentialOverride")`.
    pub override_raw: Option<f64>,
    pub hit_chance: f64,
    pub ignite_chance: f64,
    pub triggered_on_death: bool,
    pub cooldown: Option<f64>,
    /// `(output.HitTime or output.Time)`.
    pub hit_time_or_time: f64,
    pub hit_speed_or_speed: f64,
    pub dps_multiplier: f64,
    pub duration: f64,
    pub stacks: f64,
    pub stack_potential: f64,
    pub roll_average: f64,
}

/// CalcOffence.lua:5043-5080 (`IgniteStackPotential`) and 5090-5101 (`IgniteRollAverage`).
pub fn ignite_head(h: &IgniteHead) {
    let c = ctx();
    bd::root(|g| {
        let t = bd::reset(g, "IgniteStackPotential");
        ins_s(t, "^x5CF0BBNOTE: Calculation uses a Weighted Avg formula");
        ins_s(t, "");
        if let Some(raw) = h.override_raw {
            if h.max_stacks != 1.0 {
                ins_s(t, sf!("= %d / %d ^8(stack potential override / max ignite stacks)", raw, h.max_stacks));
                ins_s(t, sf!("= %g ^8(stack potential)", h.stack_potential));
            } else {
                ins_s(t, sf!("= %g ^8(stack potential override)", h.stack_potential));
            }
        } else {
            ins_s(t, sf!("%.2f ^8(chance to hit)", h.hit_chance / 100.0));
            ins_s(t, sf!("* %.2f ^8(chance to ignite)", h.ignite_chance));
            if h.triggered_on_death {
                ins_s(t, "* 1 ^8Cast on Death override");
            } else if let Some(cd) = h.cooldown {
                ins_s(t, sf!("* (%.2f / max(%.2f, %.2f) ^8(Ignite Duration / max(Cooldown, Cast Time))", h.duration, cd, h.hit_time_or_time));
            } else if h.hit_speed_or_speed > 0.0 {
                ins_s(t, sf!("* (%.2f / %.2f) ^8(Ignite Duration / Attack Time)", h.duration, c.g_hit_time_or_time.unwrap_or(0.0)));
            }
            if h.dps_multiplier != 1.0 {
                ins_s(t, sf!("* %g ^8(DPS multiplier for this skill)", h.dps_multiplier));
            }
            ins_s(t, sf!("/ %d ^8(max number of stacks)", h.max_stacks));
            ins_s(t, sf!("= %.2f", h.stack_potential));
        }
        let t = bd::reset(g, "IgniteRollAverage");
        ins_s(t, "^x5CF0BBThis is the average roll of an ignite affecting the enemy if you are constantly attacking");
        ins_s(t, sf!("^x5CF0BBIf attacking constantly, your average strongest Ignite currently achieves ^7%.2f%%^x5CF0BB of its max damage", h.roll_average));
        ins_s(t, "");
        ins_s(t, "Average Ignite Roll:");
        if h.stacks >= h.max_stacks {
            ins_s(t, sf!("%.2f - (%.2f - 1)/2", h.stacks, h.max_stacks));
            ins_s(t, sf!("/ (%.2f + 1)", h.stacks));
            ins_s(t, sf!("= %.2f%%", h.roll_average));
        } else {
            ins_s(t, sf!("50%% (averaging <= %d ignites)", h.max_stacks));
        }
    });
}

/// CalcOffence.lua:5170-5195 (`globalBreakdown.IgniteDPS`, the damage derivation).
pub fn ignite_derivation(total_min: f64, total_max: f64, roll_average: f64, dot_multi: f64, crit_dot_multi: f64, source_hit: f64, source_crit: f64, crit_chance: f64) {
    bd::root(|g| {
        let mut t = Value::Array(vec![]);
        let one = source_hit == source_crit || crit_chance == 0.0;
        ins_s(&mut t, if one { "Dmg Derivation:" } else { "Non-Crit Dmg Derivation:" });
        ins_s(&mut t, sf!("%.0f + (%.0f - %.0f) * %.2f%%", total_min, total_max, total_min, roll_average));
        ins_s(&mut t, "^8min combined sources + (max combined sources - min combined sources) * average ignite roll");
        ins_s(&mut t, if one { sf!("* %.2f ^8(Ignite DoT Multi)", dot_multi) } else { sf!("* %.2f ^8(Ignite DoT Multi for Non-Crit)", dot_multi) });
        ins_s(&mut t, sf!("= %.2f", source_hit));
        if !one {
            ins_s(&mut t, "");
            ins_s(&mut t, "Crit Dmg Derivation:");
            ins_s(&mut t, sf!("%.0f + (%.0f - %.0f) * %.2f%%", total_min, total_max, total_min, roll_average));
            ins_s(&mut t, "^8min combined sources + (max combined sources - min combined sources) * average ignite roll");
            ins_s(&mut t, sf!("* %.2f ^8(Ignite DoT Multi for Crit)", crit_dot_multi));
            ins_s(&mut t, sf!("= %.2f", source_crit));
        }
        set(g, "IgniteDPS", t);
    });
}

/// CalcOffence.lua:5222-5232.
pub fn burning_ground(base_effect_rate: f64, ground_mult: f64, fire_eff_mult: f64, dps: f64) {
    bd::root(|g| {
        let t = bd::reset(g, "BurningGroundDPS");
        ins_s(t, sf!("%.1f ^8(ignite damage per second)", base_effect_rate));
        ins_s(t, sf!("* %.1f%% ^8(percent as burning ground)", ground_mult));
        ins_s(t, sf!("* %.3f ^8(effective DPS modifier)", fire_eff_mult));
        ins_s(t, sf!("= %.1f ^8per second", dps));
    });
}

pub struct IgniteMain {
    pub base_val: f64,
    pub ruthless: f64,
    pub effect_mod: f64,
    pub rate_mod: f64,
    pub active_ignites: f64,
    pub eff: f64,
    pub dps_uncapped: f64,
    pub dps_capped: f64,
    pub min_uncapped: f64,
    pub max_uncapped: f64,
    pub dot_dps_cap: f64,
    pub dot_multi: Option<f64>,
    pub crit_dot_multi: Option<f64>,
    /// `output.IgniteChanceOnHit` / `OnCrit`, `globalOutput.CritChance`, `ailmentCritChance`.
    pub chance_on_hit: f64,
    pub chance_on_crit: f64,
    pub global_crit_chance: f64,
    pub ailment_crit_chance: f64,
    pub ignite_can_stack: bool,
    pub duration: f64,
    pub duration_base: f64,
    pub duration_mod: f64,
    pub debuff_duration_mult: f64,
    pub base_duration_const: f64,
}

/// CalcOffence.lua:5249-5329.
pub fn ignite_main(m: &IgniteMain) {
    let c = ctx();
    bd::cur(|b| {
        let min_cap = m.min_uncapped.min(m.dot_dps_cap);
        let max_cap = m.max_uncapped.min(m.dot_dps_cap);
        {
            let t = bd::t(b, "IgniteDPS");
            if m.ruthless != 1.0 {
                ins_s(t, sf!("x %.2f ^8(ruthless blow effect modifier)", m.ruthless));
            }
            ins_s(t, "x 0.9 ^8(ignite deals 90% per second)");
            ins_s(t, sf!("= %.1f", m.base_val));
            ins_s(t, "");
            ins_s(t, "Average Ignite DPS:");
            if m.base_val != m.dps_uncapped {
                ins_s(t, sf!("%.1f ^8(base damage per second)", m.base_val));
            }
            if m.effect_mod != 1.0 {
                ins_s(t, sf!("x %.2f ^8(ailment effect modifier)", m.effect_mod));
            }
            if m.rate_mod != 1.0 {
                ins_s(t, sf!("x %.2f ^8(burn rate modifier)", m.rate_mod));
            }
            if m.active_ignites != 1.0 {
                ins_s(t, sf!("x %.2f ^8(avg ignite stacks)", m.active_ignites));
            }
            if m.eff != 1.0 {
                ins_s(t, sf!("x %.3f ^8(effective DPS modifier from enemy debuffs)", m.eff));
            }
            if m.dps_capped != m.dps_uncapped {
                capped_note(t, "Ignite", m.dps_uncapped, m.dps_capped);
                ins_s(t, sf!("= %d ^8(Capped Ignite DPS)", m.dps_capped));
            } else {
                ins_s(t, sf!("= %.1f ^8per second", m.dps_capped));
            }
            ins_s(t, sf!("%.2f%% of Maximum Ignite DPS", m.dps_capped / max_cap * 100.0));
            ins_s(t, "");
            ins_s(t, "DPS Range:");
            if max_cap == m.max_uncapped && min_cap == m.min_uncapped {
                ins_s(t, sf!("%.0f to %.0f ^8(Ignite DPS Range)", m.min_uncapped, m.max_uncapped));
            } else {
                ins_s(t, sf!("%.0f to %.0f ^8(Uncapped Ignite DPS Range)", m.min_uncapped, m.max_uncapped));
            }
            if min_cap != m.min_uncapped {
                ins_s(t, format!("^8(Raw Min Ignite DPS is ^xDD0022overcapped ^8by^7 {} ^8:^7 {}%^8)", sf!("%.0f", m.min_uncapped - min_cap), sf!("%.1f", (m.min_uncapped - min_cap) / min_cap * 100.0)));
            }
            if max_cap != m.max_uncapped {
                ins_s(t, format!("^8(Raw Max Ignite DPS is ^xDD0022overcapped ^8by^7 {} ^8:^7 {}%^8)", sf!("%.0f", m.max_uncapped - max_cap), sf!("%.1f", (m.max_uncapped - max_cap) / max_cap * 100.0)));
            }
            if max_cap != m.max_uncapped || min_cap != m.min_uncapped {
                ins_s(t, sf!("%.0f to %.0f ^8(Capped Ignite DPS Range)", min_cap, max_cap));
            }
        }
        if let (Some(dm), Some(cm)) = (m.dot_multi, m.crit_dot_multi) {
            if cm != dm {
                let chance_from_hit = m.chance_on_hit / 100.0 * (1.0 - m.global_crit_chance / 100.0);
                let chance_from_crit = m.chance_on_crit / 100.0 * m.ailment_crit_chance / 100.0;
                let total_from_hit = chance_from_hit / (chance_from_hit + chance_from_crit);
                let total_from_crit = chance_from_crit / (chance_from_hit + chance_from_crit);
                set(b, "IgniteDotMulti", bdbuild::crit_dot(dm, cm, total_from_hit, total_from_crit));
            }
        }
        if m.ignite_can_stack {
            let mut t = Value::Array(vec![]);
            if c.is_attack {
                ins_s(&mut t, format!("{}:", c.pass_label));
            }
            ins_s(&mut t, sf!("%.1f ^8(damage per second)", m.dps_capped));
            ins_s(&mut t, sf!("x %.2fs ^8(ignite duration)", m.duration));
            ins_s(&mut t, sf!("= %.1f ^8damage per ignite stack", m.dps_capped * m.duration));
            set(b, "IgniteDamage", t);
        }
    });
    if m.duration != m.base_duration_const {
        bd::root(|g| {
            let t = bd::reset(g, "IgniteDuration");
            ins_s(t, sf!("%.2fs ^8(base duration)", m.duration_base));
            if m.duration_mod != 1.0 {
                ins_s(t, sf!("x %.2f ^8(duration modifier)", m.duration_mod));
            }
            if m.rate_mod != 1.0 {
                ins_s(t, sf!("/ %.2f ^8(burn rate modifier)", m.rate_mod));
            }
            if m.debuff_duration_mult != 1.0 {
                ins_s(t, sf!("/ %.2f ^8(debuff expires slower/faster)", 1.0 / m.debuff_duration_mult));
            }
            ins_s(t, sf!("= %.2fs", m.duration));
        });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Non-damaging ailments (CalcOffence.lua:5332-5513)
// ---------------------------------------------------------------------------------------------------------------------

/// `data.nonDamagingAilment[ailment]`: (min, max, precision, duration).
fn nd_data(ailment: &str) -> (f64, f64, i32, f64) {
    match ailment {
        "Chill" => (5.0, 30.0, 0, 2.0),
        "Shock" => (5.0, 50.0, 0, 2.0),
        "Scorch" => (0.0, 30.0, 0, 4.0),
        "Brittle" => (0.0, 6.0, 2, 4.0),
        _ => (0.0, 20.0, 0, 4.0), // Sap
    }
}

/// `enemyThreshold` (CalcOffence.lua:5334-5343).
pub fn enemy_threshold(enemy_db: &ModStore, enemy_level: f64, is_boss: bool) -> f64 {
    let level = enemy_level as i64;
    let at = crate::data::monster_ailment_threshold_table(level);
    let (mut life_mult, mut ailment_mult) = (1.0, 1.0);
    if enemy_level >= 66.0 {
        life_mult = if is_boss { crate::data::map_level_boss_life_mult(level) } else { crate::data::map_level_life_mult(level) };
        if is_boss {
            ailment_mult = crate::data::map_level_boss_ailment_mult(level);
        }
    }
    let type_mult = if is_boss { 7.68 } else { 1.0 };
    at * type_mult * life_mult * enemy_db.more(None, &[pom_engine::sym!("Life")]) * ailment_mult * enemy_db.more(None, &[pom_engine::sym!("AilmentThreshold")])
}

/// CalcOffence.lua:5377-5397: `breakdown.DotChill` (the string `base` of upstream is never read: `chain.base[2]` of a string is nil).
pub fn dot_chill(skill_mod_list: &ModStore, cfg: &Cfg, chill_source_effect: f64) {
    let inc = skill_mod_list.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("EnemyChillEffect")]);
    let more = skill_mod_list.more(Some(cfg), &[pom_engine::sym!("EnemyChillEffect")]);
    let chill_max = skill_mod_list.override_(None, &[pom_engine::sym!("ChillMax")]).and_then(|v| v.num()).unwrap_or(30.0);
    bd::cur(|b| {
        let t = bd::reset(b, "DotChill");
        let mut c = Chain::new();
        c.label = Some(sf!("Effect of Chill: ^8(capped at %d%%)", chill_max));
        c.links = vec![Link::n("%.2f ^8(increased/reduced effect of chill)", 1.0 + inc / 100.0), Link::n("%.2f ^8(more/less effect of chill)", more)];
        c.total = Some(sf!("= %.0f%%", chill_source_effect));
        bdbuild::multi_chain(t, &c);
    });
}

/// CalcOffence.lua:5398-5414: the Freeze `FreezeDurationMod` mode line and the `FreezeDPS` threshold note.
pub fn freeze(base_val: f64, freeze_duration_mod: Option<f64>) {
    let line = mode_line();
    bd::root(|g| ins_s(bd::reset(g, "FreezeDurationMod"), line));
    if base_val > 0.0 {
        if let Some(fdm) = freeze_duration_mod {
            bd::cur(|b| {
                let t = bd::t(b, "FreezeDPS");
                ins_s(t, sf!("For freeze to apply for the minimum of 0.3 seconds, target must have no more than %.0f Ailment Threshold.", base_val * 20.0 * fdm));
                ins_s(t, "^8(Ailment Threshold is about equal to Life except on bosses where it is about half of their life)");
            });
        }
    }
}

/// CalcOffence.lua:5418-5424: `globalBreakdown[ailment.."EffectMod"]` (the chance of the ailment is above 0).
pub fn nd_mode(ailment: &str) {
    let line = mode_line();
    bd::root(|g| ins_s(bd::reset(g, &format!("{ailment}EffectMod")), line));
}

pub struct NdInputs<'a> {
    pub skill_mod_list: &'a ModStore,
    pub enemy_db: &'a ModStore,
    /// The ailment loop's `cfg` (with `skillCond["CriticalStrike"]` set for the ailment mode).
    pub cfg: &'a Cfg,
    pub damage: f64,
    pub effect_mod: f64,
    pub duration: f64,
    pub debuff_duration_mult: f64,
    pub enemy_threshold: f64,
    /// `globalOutput["Maximum"..ailment]` / `["Current"..ailment]`.
    pub g_maximum: Option<f64>,
    pub g_current: Option<f64>,
    pub is_boss_config: String,
}

/// CalcOffence.lua:5439-5512 (`damage > 0` for this ailment).
pub fn nd_ailment(ailment: &str, i: &NdInputs) {
    let c = ctx();
    let (min, max_data, precision, base_duration) = nd_data(ailment);
    let cfg = Some(i.cfg);
    let inc_dur = i.skill_mod_list.sum(ModType::Inc, cfg, &[Sym::new(&format!("Enemy{ailment}Duration")), pom_engine::sym!("EnemyElementalAilmentDuration"), pom_engine::sym!("EnemyAilmentDuration")])
        + i.enemy_db.sum(ModType::Inc, None, &[Sym::new(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfElementalAilmentDuration"), pom_engine::sym!("SelfAilmentDuration")]);
    let more_dur = i.skill_mod_list.more(cfg, &[Sym::new(&format!("Enemy{ailment}Duration")), pom_engine::sym!("EnemyElementalAilmentDuration"), pom_engine::sym!("EnemyAilmentDuration")])
        * i.enemy_db.more(None, &[Sym::new(&format!("Self{ailment}Duration")), pom_engine::sym!("SelfElementalAilmentDuration"), pom_engine::sym!("SelfAilmentDuration")]);
    let maximum = i.g_maximum.unwrap_or(max_data);
    let current = i.g_current.unwrap_or(0.0).min(maximum).max(0.0);
    let desired = i.enemy_db.sum(ModType::Base, None, &[Sym::new(&format!("Desired{ailment}Val"))]).min(maximum).max(0.0);
    let (mut eff_list, ramping): (Vec<f64>, bool) = match ailment {
        "Chill" => (vec![10.0, 20.0], c.has_bonechill),
        "Shock" => (vec![10.0, 20.0, 40.0], true),
        "Scorch" => (vec![5.0, 10.0, 20.0], true),
        "Brittle" => (vec![2.0, 4.0], true),
        _ => (vec![5.0, 10.0], false),
    };
    let damage = i.damage;
    let em = i.effect_mod;
    let t = i.enemy_threshold;
    let effect = |d: f64, e: f64| -> f64 {
        match ailment {
            "Brittle" => 10.0 * (d / t).powf(0.4) * e,
            "Sap" => (100.0 / 3.0) * (d / t).powf(0.4) * e,
            _ => 50.0 * (d / t).powf(0.4) * e,
        }
    };
    let thresh = |d: f64, v: f64, e: f64| -> f64 {
        match ailment {
            "Brittle" => d * (10.0 * e / v).powf(2.5),
            "Sap" => d * (100.0 / 3.0 * e / v).powf(2.5),
            _ => d * (50.0 * e / v).powf(2.5),
        }
    };
    if min != 0.0 {
        eff_list.push(min);
    }
    if t > 0.0 {
        eff_list.push(effect(damage, em));
    }
    if !eff_list.contains(&maximum) {
        eff_list.push(maximum);
    }
    if current > 0.0 && !eff_list.contains(&current) {
        eff_list.push(current);
    }
    if desired > 0.0 && !eff_list.contains(&desired) && current == 0.0 {
        eff_list.push(desired);
    }
    let label = format!("Resulting ailment effect{}", if current > 0.0 && ramping { sf!(" ^8(with a ^7%s%% ^8%s on the enemy)^7", tostr(current), ailment) } else { String::new() });
    let footer = sf!("^8(ailment threshold is about equal to life, except on bosses that have specific ailment thresholds)\n(the above table shows that when the enemy has X ailment threshold, you ^8%s for Y)", ailment.to_lowercase());
    eff_list.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut rows: Vec<Value> = Vec::new();
    for raw in eff_list {
        let th = thresh(damage, raw, em);
        let dec_check = raw / raw.floor();
        let p10 = 10f64.powi(precision);
        let value = (raw * p10).floor() / p10;
        let value_format = format!("%.{}f%%", precision);
        let mut thresh_string = sf!("%d", th);
        if (th + 0.5).floor() == (i.enemy_threshold + 0.5).floor() {
            thresh_string.push_str(&sf!(" ^8(%s)", i.is_boss_config.as_str()));
        }
        let mut labels: Vec<&str> = vec![];
        if dec_check == 1.0 && value != 0.0 {
            if value == current {
                labels.push("current");
            }
            if value == desired {
                labels.push("desired");
            }
            if value == maximum {
                labels.push("maximum");
            }
            if value == min {
                labels.push("minimum");
            }
        }
        let mut effect_s = bd::sprintf(&value_format, &[bd::A::N(value)]);
        if !labels.is_empty() {
            effect_s.push_str(&format!(" ^8({})", labels.join(", ")));
        }
        rows.push(row(vec![("effect", s(effect_s)), ("thresh", s(thresh_string))]));
    }
    let dur_key = format!("{ailment}Duration");
    bd::cur(|b| {
        let t = bd::t(b, &format!("{ailment}DPS"));
        set(t, "label", s(label));
        set(t, "footer", s(footer));
        let rl = bd::reset(t, "rowList");
        for r in rows {
            ins(rl, r);
        }
        set(t, "colList", Value::Array(vec![row(vec![("label", s("Ailment Threshold")), ("key", s("thresh"))]), row(vec![("label", s(format!("{ailment} Effect"))), ("key", s("effect"))])]));
        if i.duration != base_duration {
            let d = bd::reset(b, &dur_key);
            if c.is_attack {
                ins_s(d, format!("{}:", c.pass_label));
            }
            ins_s(d, sf!("%.2fs ^8(base duration)", base_duration));
            if inc_dur != 0.0 {
                ins_s(d, sf!("x %.2f ^8(increased/reduced duration)", 1.0 + inc_dur / 100.0));
            }
            if more_dur != 1.0 {
                ins_s(d, sf!("x %.2f ^8(more/less duration)", more_dur));
            }
            if i.debuff_duration_mult != 1.0 {
                ins_s(d, sf!("/ %.2f ^8(debuff expires slower/faster)", 1.0 / i.debuff_duration_mult));
            }
            ins_s(d, sf!("= %.2fs", i.duration));
        }
    });
}
