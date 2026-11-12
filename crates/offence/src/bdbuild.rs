//! Port of Modules/CalcBreakdown.lua's functions (`breakdown.simple`, `.mod`, `.area`, `.effMult`, `.dot`, `.critDot`,
//! `.leech`, `.multiChain`). `breakdown.slot` is only called from CalcDefence/CalcPerform. Every function returns the
//! table upstream returns (`None` is upstream's `nil`). `store` is the actor's modDB (`modDB` of the module).
use crate::bd::{self, ins_s, num, round, s, set, A};
use crate::sf;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use serde_json::Value;

fn syms(names: &[&str]) -> Vec<Sym> {
    names.iter().map(|n| Sym::new(n)).collect()
}

/// One link of a `multiChain`: `{ fmt, value, extra... }`; `value` is the second element (the number the chain multiplies).
pub struct Link {
    pub fmt: &'static str,
    pub args: Vec<A>,
    pub value: Option<f64>,
}

impl Link {
    /// `{ "%.2f ^8(more)", x }` where the single number is also the multiplier.
    pub fn n(fmt: &'static str, x: f64) -> Link {
        Link { fmt, args: vec![A::N(x)], value: Some(x) }
    }
    /// `{ "%.2f ^8(%s)", x, label }`.
    pub fn ns(fmt: &'static str, x: f64, label: &str) -> Link {
        Link { fmt, args: vec![A::N(x), A::S(label.to_string())], value: Some(x) }
    }
    /// A link whose second element is not a number (upstream skips it: `mult[2] and mult[2] ~= 1`).
    pub fn text(fmt: &'static str, args: Vec<A>) -> Link {
        Link { fmt, args, value: None }
    }
}

pub struct Chain {
    pub label: Option<String>,
    pub base: Option<Link>,
    pub links: Vec<Link>,
    pub total: Option<String>,
    pub no_total: bool,
}

impl Chain {
    pub fn new() -> Chain {
        Chain { label: None, base: None, links: vec![], total: None, no_total: false }
    }
}

fn fmt_link(l: &Link) -> String {
    bd::sprintf(l.fmt, &l.args.iter().map(|a| match a { A::N(v) => A::N(*v), A::S(x) => A::S(x.clone()) }).collect::<Vec<_>>())
}

/// `breakdown.multiChain(out, chain)`; returns the number of non-1 multiplier lines.
pub fn multi_chain(out: &mut Value, chain: &Chain) -> usize {
    let base = chain.base.as_ref().and_then(|b| b.value);
    let mut multiplier = 1.0;
    let mut lines = 0usize;
    if let Some(l) = &chain.label {
        ins_s(out, l.clone());
    }
    if let Some(b) = &chain.base {
        ins_s(out, fmt_link(b));
    }
    if base != Some(0.0) {
        for m in &chain.links {
            if let Some(v) = m.value {
                if v != 1.0 {
                    multiplier *= v;
                    ins_s(out, format!("x {}", fmt_link(m)));
                    lines += 1;
                }
            }
        }
    }
    if let Some(t) = &chain.total {
        ins_s(out, t.clone());
    } else if (!chain.no_total && lines > 0 && base.is_some()) || (lines > 1 && base.is_none()) {
        ins_s(out, sf!("= %.2f", multiplier * base.unwrap_or(1.0)));
    }
    lines
}

/// `breakdown.simple(extraBase, cfg, total, ...)`.
pub fn simple(store: &ModStore, extra_base: Option<f64>, cfg: Option<&Cfg>, total: f64, names: &[&str]) -> Option<Value> {
    let extra = extra_base.unwrap_or(0.0);
    let sy = syms(names);
    let base = store.sum(ModType::Base, cfg, &sy[..1]);
    if base + extra != 0.0 {
        let inc = store.sum(ModType::Inc, cfg, &sy);
        let more = store.more(cfg, &sy);
        if inc != 0.0 || more != 1.0 || (base != 0.0 && extra != 0.0) {
            let mut out = Value::Array(vec![]);
            if base != 0.0 && extra != 0.0 {
                ins_s(&mut out, sf!("(%g + %g) ^8(base)", extra, base));
            } else {
                ins_s(&mut out, sf!("%g ^8(base)", base + extra));
            }
            if inc != 0.0 {
                ins_s(&mut out, sf!("x %.2f ^8(increased/reduced)", 1.0 + inc / 100.0));
            }
            if more != 1.0 {
                ins_s(&mut out, sf!("x %.2f ^8(more/less)", more));
            }
            ins_s(&mut out, sf!("= %g", total));
            return Some(out);
        }
    }
    None
}

/// `breakdown.mod(modList, cfg, ...)`.
pub fn mod_(list: &ModStore, cfg: Option<&Cfg>, names: &[&str]) -> Option<Value> {
    let sy = syms(names);
    let inc = list.sum(ModType::Inc, cfg, &sy);
    let more = list.more(cfg, &sy);
    if inc != 0.0 || more != 1.0 {
        return Some(Value::Array(vec![
            s(sf!("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0)),
            s(sf!("x %.2f ^8(more/less)", more)),
            s(sf!("= %.2f", (1.0 + inc / 100.0) * more)),
        ]));
    }
    None
}

/// `breakdown.area(base, areaMod, total, incBreakpoint, moreBreakpoint, redBreakpoint, lessBreakpoint, label, radiusMod)`.
#[allow(clippy::too_many_arguments)]
pub fn area(base: f64, area_mod: f64, total: f64, bp: Option<(f64, f64, f64, f64)>, label: &str, radius_mod: Option<f64>) -> Value {
    let mut out = Value::Array(vec![]);
    ins_s(&mut out, label);
    if base != total {
        ins_s(&mut out, sf!("%.1fm ^8(base radius)", base / 10.0));
        ins_s(&mut out, sf!("x %.2f ^8(square root of area of effect modifier)", (100.0 * area_mod.sqrt()).floor() / 100.0));
        if let Some(r) = radius_mod {
            if r != 1.0 {
                ins_s(&mut out, sf!("x %.2f ^8(final radius modifier)", r));
            }
        }
        ins_s(&mut out, sf!("= %.1fm", total / 10.0));
    }
    if let Some((inc, more, red, less)) = bp {
        ins_s(&mut out, sf!("^8Next 0.1m breakpoint: %d%% increased AoE / a %d%% more AoE multiplier", inc, more));
        ins_s(&mut out, sf!("^8Previous 0.1m breakpoint: %d%% reduced AoE / a %d%% less AoE multiplier", red, less));
    }
    set(&mut out, "radius", num(total));
    out
}

/// `breakdown.effMult(damageType, resist, pen, taken, mult, takenMore, sourceRes, useRes, invertChance, effectiveResist)`.
#[allow(clippy::too_many_arguments)]
pub fn eff_mult(damage_type: &str, resist: f64, pen: f64, taken: f64, mult: f64, taken_more: f64, source_res: Option<&str>, use_res: bool, invert_chance: Option<f64>, effective_resist: Option<f64>) -> Value {
    let mut out = Value::Array(vec![]);
    let resist_form = if damage_type == "Physical" { "physical damage reduction" } else { "resistance" };
    let effective_resist = effective_resist.unwrap_or(resist - pen);
    if let Some(sr) = source_res.filter(|sr| *sr != damage_type) {
        ins_s(&mut out, sf!("Enemy %s: %d%% ^8(%s)", resist_form, resist, sr));
    } else if resist != 0.0 {
        ins_s(&mut out, sf!("Enemy %s: %d%%", resist_form, resist));
    }
    let inv = invert_chance.unwrap_or(0.0);
    if inv != 0.0 && use_res {
        let normal = resist - pen;
        let inverted = -resist - pen;
        ins_s(&mut out, "Effective resistance:");
        ins_s(&mut out, sf!("%g%% ^8(non-inverted hit after penetration)", normal));
        ins_s(&mut out, sf!("%g%% ^8(inverted hit after penetration)", inverted));
        ins_s(&mut out, sf!("= %g%% ^8(weighted average from %.0f%% inversion chance)", effective_resist, inv * 100.0));
    } else if pen != 0.0 || !use_res {
        ins_s(&mut out, "Effective resistance:");
        ins_s(&mut out, sf!("%d%% ^8(resistance)", resist));
        if pen < 0.0 {
            ins_s(&mut out, sf!("+ %d%% ^8(penetration)", -pen));
        } else if pen > 0.0 {
            ins_s(&mut out, sf!("- %d%% ^8(penetration)", pen));
        }
        if !use_res {
            ins_s(&mut out, sf!("x %d%% ^8(resistance ignored)", 0));
            ins_s(&mut out, sf!("= %d%%", 0));
        } else {
            ins_s(&mut out, sf!("= %d%%", resist - pen));
        }
    }
    if use_res {
        let mut c = Chain::new();
        c.label = Some("Effective DPS modifier:".into());
        c.links = vec![
            Link::ns("%.2f ^8(%s)", 1.0 - effective_resist / 100.0, resist_form),
            Link::n("%.2f ^8(increased/reduced damage taken)", 1.0 + taken / 100.0),
            Link::n("%.2f ^8(more/less damage taken)", taken_more),
        ];
        c.total = Some(sf!("= %.3f", mult));
        multi_chain(&mut out, &c);
    } else {
        ins_s(&mut out, "Effective DPS modifier:");
        ins_s(&mut out, sf!("= %.3f ^8(increased/reduced damage taken)", mult));
    }
    out
}

/// `breakdown.dot(out, baseVal, inc, more, mult, rate, aura, effMult, total)`.
#[allow(clippy::too_many_arguments)]
pub fn dot(out: &mut Value, base_val: f64, inc: f64, more: f64, mult: Option<f64>, rate: f64, aura: f64, eff_mult: f64, total: f64) {
    let mut c = Chain::new();
    c.base = Some(Link::n("%.1f ^8(base damage per second)", base_val));
    c.links = vec![
        Link::n("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0),
        Link::n("%.2f ^8(more/less)", more),
        Link::n("%.2f ^8(multiplier)", 1.0 + mult.unwrap_or(0.0) / 100.0),
        Link::n("%.2f ^8(rate modifier)", rate),
        Link::n("%.3f ^8(aura effect modifier)", aura),
        Link::n("%.3f ^8(effective DPS modifier)", eff_mult),
    ];
    c.total = Some(sf!("= %.1f ^8per second", total));
    multi_chain(out, &c);
}

/// `breakdown.critDot(dotMulti, critMulti, dotChance, critChance)`.
pub fn crit_dot(dot_multi: f64, crit_multi: f64, dot_chance: f64, crit_chance: f64) -> Value {
    let combined = dot_multi * dot_chance + crit_multi * crit_chance;
    let mut out = Value::Array(vec![]);
    if dot_chance > 0.0 {
        ins_s(&mut out, "Contribution from Non-crits:");
        ins_s(&mut out, sf!("%.2f ^8(dot multiplier for non-crits)", dot_multi));
        ins_s(&mut out, sf!("x %.4f ^8(portion of instances created by non-crits)", dot_chance));
        ins_s(&mut out, sf!("= %.2f", dot_multi * dot_chance));
    }
    if crit_chance > 0.0 {
        ins_s(&mut out, "Contribution from Crits:");
        ins_s(&mut out, sf!("%.2f ^8(dot multiplier for crits)", crit_multi));
        ins_s(&mut out, sf!("x %.4f ^8(portion of instances created by crits)", crit_chance));
        ins_s(&mut out, sf!("= %.2f", crit_multi * crit_chance));
    }
    if dot_chance > 0.0 && crit_chance > 0.0 && dot_multi != crit_multi {
        ins_s(&mut out, "Effective DoT Multiplier:");
        ins_s(&mut out, sf!("%.2f + %.2f", dot_multi * dot_chance, crit_multi * crit_chance));
        ins_s(&mut out, sf!("= %.2f", combined));
    }
    out
}

/// `breakdown.leech(instant, instantRate, instances, pool, rate, max, dur, instantLeechProportion, hitRate)`. `rate` is the
/// leech-rate stat name; `show_average` is `actor.mainSkill.skillData.showAverage`. (`skillCfg` is an undefined global in
/// CalcBreakdown.lua, so the rate modifier is read with no cfg.)
#[allow(clippy::too_many_arguments)]
pub fn leech(store: &ModStore, show_average: bool, instant: f64, instant_rate: f64, instances: f64, pool: f64, rate: &str, max: f64, dur: f64, instant_leech_proportion: f64, hit_rate: f64, leech_rate_base: f64) -> Value {
    let mut out = Value::Array(vec![]);
    let rate_mod = || crate::tools::calc_lib_mod(store, None, &[rate]);
    if show_average {
        if instant > 0.0 {
            if instant_leech_proportion != 1.0 {
                ins_s(&mut out, sf!("Instant Leech: %.1f ^8(%d%% x %.1f)", instant, instant_leech_proportion * 100.0, dur * pool * leech_rate_base / (1.0 - instant_leech_proportion)));
            } else {
                ins_s(&mut out, sf!("Instant Leech: %.1f", instant));
            }
        }
        if instances > 0.0 {
            ins_s(&mut out, "Total leeched per instance:");
            ins_s(&mut out, sf!("%d ^8(size of leech destination pool)", pool));
            ins_s(&mut out, sf!("x %.2f ^8(base leech rate is %d%% per second)", leech_rate_base, 100.0 * leech_rate_base));
            let rm = rate_mod();
            if rm != 1.0 {
                ins_s(&mut out, sf!("x %.2f ^8(leech rate modifier)", rm));
            }
            ins_s(&mut out, sf!("x %.2fs ^8(instance duration)", dur));
            ins_s(&mut out, sf!("= %.1f", pool * leech_rate_base * rm * dur));
        }
    } else {
        if instant_rate > 0.0 {
            if instant_leech_proportion != 1.0 {
                ins_s(&mut out, sf!("Instant Leech: %.1f ^8(%d%% x %.1f)", instant, instant_leech_proportion * 100.0, dur * pool * leech_rate_base / (1.0 - instant_leech_proportion)));
            } else {
                ins_s(&mut out, sf!("Instant Leech: %.1f", instant));
            }
            ins_s(&mut out, sf!("Instant Leech per second: %.1f ^8(%.1f x %.2f)", instant_rate, instant, hit_rate));
        }
        if instances > 0.0 {
            ins_s(&mut out, "Rate per instance:");
            ins_s(&mut out, sf!("%d ^8(size of leech destination pool)", pool));
            ins_s(&mut out, sf!("x %.2f ^8(base leech rate is %d%% per second)", leech_rate_base, 100.0 * leech_rate_base));
            let rm = rate_mod();
            if rm != 1.0 {
                ins_s(&mut out, sf!("x %.2f ^8(leech rate modifier)", rm));
            }
            ins_s(&mut out, sf!("= %.1f ^8per second", pool * leech_rate_base * rm));
            ins_s(&mut out, "Maximum leech rate against one target:");
            ins_s(&mut out, sf!("%.1f", pool * leech_rate_base * rm));
            ins_s(&mut out, sf!("x %.2f ^8(average instances)", instances));
            let total = pool * leech_rate_base * rm * instances;
            ins_s(&mut out, sf!("= %.1f ^8per second", total));
            if total <= max {
                ins_s(&mut out, sf!("Time to reach max: %.1fs", dur));
            }
            ins_s(&mut out, sf!("Leech rate cap: %.1f", max));
            if total > max {
                ins_s(&mut out, sf!("Time to reach cap: %.1fs", dur / total * max));
            }
        }
    }
    out
}

/// A `{ label, ... }`-free helper used by several callers: `round(x)` as the recorder would see a number table field.
pub fn rnd(v: f64) -> Value {
    num(round(v, 0))
}
