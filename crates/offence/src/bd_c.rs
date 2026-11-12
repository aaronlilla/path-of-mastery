//! Calcs-tab breakdown writes of CalcOffence.lua 1700-2300: costs, the hand combine (`combineStat` CHANCE / CHANCE_AILMENT)
//! and the hit-chance block of the first pass loop (Accuracy, AccuracyHitChance, HitChance).
use crate::bd::{self, ins_s, s, set, tostr};
use crate::bdbuild::{multi_chain, Chain, Link};
use crate::hit::HitChanceOutput;
use crate::sf;
use serde_json::Value;

/// Inputs of `breakdown[costName]` (CalcOffence.lua:1859-1894).
pub struct CostBd<'a> {
    pub cost_name: &'a str,
    pub ty: &'a str,
    pub text: &'a str,
    pub upfront: bool,
    pub percent: bool,
    pub base_cost: f64,
    pub mult: f64,
    pub base_cost_no_mult: f64,
    pub hybrid_life_cost: f64,
    pub additional_life_cost: f64,
    pub additional_es_cost: f64,
    pub life_instead_of_mana: bool,
    pub es_instead_of_mana_or_life: bool,
    pub inc: f64,
    pub more_cost: f64,
    pub more_type: f64,
    pub cost_efficiency: f64,
    pub total_cost: f64,
    pub output_cost: f64,
}

/// The caller guards with `bd::on()` and `hasCost`.
pub fn cost_breakdown(c: &CostBd) {
    let pct = if c.percent { "%%" } else { "" };
    let mut t = Value::Array(vec![]);
    ins_s(&mut t, sf!(&format!("%.2f{pct} ^8(base {} cost)", c.text), c.base_cost));
    if c.mult != 1.0 {
        ins_s(&mut t, sf!("x %.4f ^8(cost multiplier)", c.mult));
    }
    if c.base_cost_no_mult != 0.0 {
        ins_s(&mut t, sf!(&format!("+ %d ^8(additional {} cost)", c.text), c.base_cost_no_mult));
    }
    if c.ty == "Life" && (c.hybrid_life_cost + c.additional_life_cost) != 0.0 && !c.life_instead_of_mana {
        ins_s(&mut t, sf!("x %.2f ^8(mana cost conversion)", c.hybrid_life_cost + c.additional_life_cost));
    }
    if c.ty == "ES" && c.additional_es_cost != 0.0 && !c.life_instead_of_mana && !c.es_instead_of_mana_or_life {
        ins_s(&mut t, sf!("x %.2f ^8(mana cost conversion)", c.additional_es_cost));
    }
    if c.inc != 0.0 {
        ins_s(&mut t, sf!(&format!("x %.2f ^8(increased/reduced {} cost)", c.text), 1.0 + c.inc / 100.0));
    }
    if c.more_cost != 1.0 {
        ins_s(&mut t, sf!("x %.2f ^8(more/less cost)", c.more_cost));
    }
    if c.more_type != 1.0 {
        ins_s(&mut t, sf!(&format!("x %.2f ^8(more/less {} cost)", c.text), c.more_type));
    }
    if c.cost_efficiency != 1.0 {
        ins_s(&mut t, sf!(&format!("/ %.2f ^8({} cost efficiency)", c.text), c.cost_efficiency));
    }
    if c.total_cost != 0.0 {
        ins_s(&mut t, sf!(&format!("%+d ^8(total {} cost)", c.text), c.total_cost));
    }
    if c.ty == "Mana" && c.hybrid_life_cost > 0.0 {
        ins_s(&mut t, sf!("x %.2f ^8(%d%% paid for with life)", 1.0 - c.hybrid_life_cost, c.hybrid_life_cost * 100.0));
    }
    ins_s(&mut t, sf!(&format!("= %{}{pct}", if c.upfront { "d" } else { ".2f" }), c.output_cost));
    bd::cur(|b| set(b, c.cost_name, t));
}

/// `combineStat(stat, "CHANCE", ...)` with both hands present (CalcOffence.lua:2084-2124). `mc`/`oc` are the weights as the
/// original has them at that point (already /10000 for double hits, else the portions); `total` is `output[stat]`.
pub fn combine_chance(stat: &str, double_hits: bool, mv: f64, ov: f64, mc: f64, oc: f64, total: f64) {
    bd::root(|r| {
        let t = bd::t(r, stat);
        let (main_what, off_what) = if double_hits {
            ("chance of main hand", "chance of  off hand")
        } else {
            ("portion of instances created by main hand", "portion of instances created by off hand")
        };
        ins_s(t, "Contribution from Main Hand:");
        ins_s(t, sf!("%.1f", mv));
        ins_s(t, sf!(&format!("x %.3f ^8({main_what})"), mc));
        ins_s(t, sf!("= %.1f", mv * mc));
        ins_s(t, "Contribution from Off Hand:");
        ins_s(t, sf!("%.1f", ov));
        ins_s(t, sf!(&format!("x %.3f ^8({off_what})"), oc));
        ins_s(t, sf!("= %.1f", ov * oc));
        ins_s(t, "Total:");
        ins_s(t, sf!("%.1f + %.1f", mv * mc, ov * oc));
        ins_s(t, sf!("= %.1f", total));
    });
}

/// `combineStat(stat, "CHANCE_AILMENT", ...)` with both hands present (CalcOffence.lua:2139-2154).
pub fn combine_ailment(stat: &str, mv: f64, ov: f64, max_instance: f64, min_instance: f64, max_stacks: f64, total: f64) {
    bd::root(|r| {
        let t = bd::t(r, stat);
        ins_s(t, "");
        ins_s(t, sf!("%.2f%% of ailment stacks use maximum damage", max_stacks * 100.0));
        ins_s(t, sf!("Max Damage comes from %s", if mv >= ov { "Main Hand" } else { "Off Hand" }));
        ins_s(t, sf!("= %.1f", max_instance * max_stacks));
        if max_stacks < 1.0 {
            ins_s(t, sf!("%.2f%% of ailment stacks use non-maximum damage", (1.0 - max_stacks) * 100.0));
            ins_s(t, sf!("= %.1f", min_instance * (1.0 - max_stacks)));
        }
        ins_s(t, "");
        ins_s(t, "Total:");
        if max_stacks < 1.0 {
            ins_s(t, sf!("%.1f + %.1f", max_instance * max_stacks, min_instance * (1.0 - max_stacks)));
        }
        ins_s(t, sf!("= %.1f", total));
    });
}

/// `combineStat(stat, "CHANCE_AILMENT", ...)` when only one hand has the stat (CalcOffence.lua:2158-2161).
pub fn combine_ailment_single(stat: &str, main_has: bool) {
    bd::root(|r| {
        let t = bd::t(r, stat);
        ins_s(t, sf!("All ailment stacks comes from %s", if main_has { "Main Hand" } else { "Off Hand" }));
    });
}

/// Accuracy / AccuracyHitChance / HitChance tables of one pass (CalcOffence.lua:2199-2262). `bd::cur` must be the pass's
/// table. `evadable` = the AccuracyHitChance else-branch ran; `off_hand_override` = the off hand took the stored main-hand
/// accuracy.
pub fn pass_hit(h: &HitChanceOutput, evadable: bool, off_hand_override: bool, enemy_level: f64, level_overridden: bool) {
    bd::cur(|b| {
        let mut t = Value::Array(vec![]);
        multi_chain(
            &mut t,
            &Chain {
                label: None,
                base: Some(Link::n("%g ^8(base)", h.bd_base)),
                links: vec![Link::n("%.2f ^8(increased/reduced)", 1.0 + h.bd_inc / 100.0), Link::n("%.2f ^8(more/less)", h.bd_more)],
                total: Some(sf!("= %g", h.bd_own_accuracy)),
                no_total: false,
            },
        );
        if h.bd_own_accuracy != h.bd_own_accuracy_vs_enemy {
            ins_s(&mut t, "");
            multi_chain(
                &mut t,
                &Chain {
                    label: Some("Effective Accuracy vs Enemy".into()),
                    base: Some(Link::n("%g ^8(base)", h.bd_base_vs_enemy)),
                    links: vec![Link::n("%.2f ^8(increased/reduced)", 1.0 + h.bd_inc_vs_enemy / 100.0), Link::n("%.2f ^8(more/less)", h.bd_more_vs_enemy)],
                    total: Some(sf!("= %g", h.bd_own_accuracy_vs_enemy)),
                    no_total: false,
                },
            );
        }
        set(b, "Accuracy", t);
        if off_hand_override {
            set(b, "Accuracy", Value::Array(vec![s(format!("Using Main Hand Accuracy due to Mastery: {}", tostr(h.accuracy)))]));
        }
        if evadable {
            let lvl = format!("Enemy level: {}{}", tostr(enemy_level), if level_overridden { " ^8(overridden from the Configuration tab" } else { " ^8(can be overridden in the Configuration tab)" });
            set(
                b,
                "AccuracyHitChance",
                Value::Array(vec![s(lvl), s(format!("Enemy evasion: {}", tostr(h.bd_enemy_evasion.unwrap_or(0.0)))), s(format!("Approximate hit chance: {}%", tostr(h.accuracy_hit_chance)))]),
            );
        }
        if h.enemy_block_chance > 0.0 {
            let mut v = vec![];
            if h.accuracy_hit_chance < 100.0 {
                v.push(s(format!("Accuracy Hit Chance: {}%", tostr(h.accuracy_hit_chance))));
            }
            v.push(s(format!("Enemy Block Chance: {}%", tostr(h.enemy_block_chance))));
            v.push(s(format!("Approximate hit chance: {}%", tostr(h.hit_chance))));
            set(b, "HitChance", Value::Array(v));
        }
    });
}
