//! The required-basics checklist: what a seasoned player never forgets, per play mode
//! and wealth tier. A cell is a hard limit (the solver pays full penalty and the result must meet it), a soft goal or a
//! warning chip (both only reported, with the plain reason when unmet), or off. Every number here is policy (our tuning,
//! not upstream's), kept in the table so one line changes it. Rules are generic: they read output stats and the main skill's
//! tags, never skill or unique names.

use super::{find_gem, gd, Goal, Wealth, DEFAULT_MOVEMENT, DEFAULT_POOL};
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Cell {
    Off,
    /// A warning shown with the result, never scored.
    Chip,
    /// A goal shown when unmet, never scored (scoring soft goals is a later step).
    Soft,
    /// A limit: the search pays for the shortfall and the result must meet it.
    Hard,
}
use Cell::{Chip as C, Hard as H, Off as O, Soft as S};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Mapping,
    Bossing,
    Both,
}

/// Mode from the goal's play mode.
pub fn mode_of(goal: &Goal) -> Mode {
    match goal.assume.mode() {
        super::PlayMode::Bossing => Mode::Bossing,
        super::PlayMode::Both => Mode::Both,
        super::PlayMode::Mapping => Mode::Mapping,
    }
}

#[derive(Clone, Copy)]
struct Row {
    cell: [Cell; 4],
    thr: [f64; 4],
}
const fn row(cell: [Cell; 4], thr: [f64; 4]) -> Row {
    Row { cell, thr }
}
const OFF: Row = row([O; 4], [0.0; 4]);
const fn flat(cell: [Cell; 4], t: f64) -> Row {
    row(cell, [t; 4])
}

#[derive(Clone, Copy, PartialEq)]
enum Rule {
    /// every stat >= the threshold
    AtLeast,
    /// every stat <= the threshold
    AtMost,
    /// sum of stats >= sum of `vs`
    Covers(&'static [&'static str]),
    /// the build has the gem kind / config the name says
    Has(Has),
}

#[derive(Clone, Copy, PartialEq)]
enum Has {
    Movement,
    Guard,
    Pantheon,
}

/// Which main skills the item applies to (gem tags) and which stat flags switch it off.
#[derive(Clone, Copy)]
struct Gate {
    tags: &'static [&'static str],
    not_tags: &'static [&'static str],
    skip_flags: &'static [&'static str],
}
const ANY: Gate = Gate { tags: &[], not_tags: &[], skip_flags: &[] };

struct Item {
    id: &'static str,
    label: &'static str,
    why: &'static str,
    stats: &'static [&'static str],
    rule: Rule,
    mapping: Row,
    bossing: Row,
    gate: Gate,
    /// The solver already enforces this one (Scorer::new); the table only reports it.
    existing: bool,
}

const ELEM_MISSING: &[&str] = &["NoFlask:MissingFireResist", "NoFlask:MissingColdResist", "NoFlask:MissingLightningResist"];
const MAXHIT: &[&str] = &["PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken", "LightningMaximumHitTaken"];
const HH: [Cell; 4] = [H; 4];
const SS: [Cell; 4] = [S; 4];

static ITEMS: &[Item] = &[
    Item { id: "res-ele-cap", label: "Elemental resistances capped", why: "an elemental resistance is below its cap without flasks", stats: ELEM_MISSING, rule: Rule::AtMost, mapping: flat(HH, 0.0), bossing: flat(HH, 0.0), gate: ANY, existing: true },
    Item { id: "res-chaos", label: "Chaos resistance", why: "chaos resistance is below the floor for this tier", stats: &["NoFlask:ChaosResist"], rule: Rule::AtLeast, mapping: row(HH, [0.0, 0.0, 20.0, 30.0]), bossing: row(HH, [0.0, 0.0, 20.0, 30.0]), gate: ANY, existing: true },
    Item { id: "res-totem", label: "Totem resistances capped", why: "the totems' resistances are below their cap", stats: &["MissingTotemFireResist", "MissingTotemColdResist", "MissingTotemLightningResist"], rule: Rule::AtMost, mapping: flat([S, H, H, H], 0.0), bossing: flat([S, H, H, H], 0.0), gate: Gate { tags: &["totem"], not_tags: &[], skip_flags: &[] }, existing: false },
    Item { id: "res-overcap", label: "Resistance buffer over the cap", why: "no spare resistance over the cap against penetration and -max res", stats: &["FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap"], rule: Rule::AtLeast, mapping: row(SS, [0.0, 5.0, 5.0, 10.0]), bossing: row(SS, [0.0, 5.0, 10.0, 15.0]), gate: ANY, existing: false },
    Item { id: "res-max", label: "Raised maximum resistance", why: "maximum resistance is not raised for this tier", stats: &["FireResistMax", "ColdResistMax", "LightningResistMax"], rule: Rule::AtLeast, mapping: row([O, O, S, S], [75.0, 75.0, 76.0, 78.0]), bossing: row([O, O, S, S], [75.0, 75.0, 76.0, 78.0]), gate: ANY, existing: false },
    Item { id: "attr-str", label: "Strength requirement met", why: "gear or gems need more Strength", stats: &["Str"], rule: Rule::Covers(&["ReqStr"]), mapping: flat(HH, 0.0), bossing: flat(HH, 0.0), gate: ANY, existing: true },
    Item { id: "attr-dex", label: "Dexterity requirement met", why: "gear or gems need more Dexterity", stats: &["Dex"], rule: Rule::Covers(&["ReqDex"]), mapping: flat(HH, 0.0), bossing: flat(HH, 0.0), gate: ANY, existing: true },
    Item { id: "attr-int", label: "Intelligence requirement met", why: "gear or gems need more Intelligence", stats: &["Int"], rule: Rule::Covers(&["ReqInt"]), mapping: flat(HH, 0.0), bossing: flat(HH, 0.0), gate: ANY, existing: true },
    Item { id: "reserve-mana", label: "Mana reservation fits", why: "auras reserve more mana than there is", stats: &["ManaUnreserved"], rule: Rule::AtLeast, mapping: flat(HH, 0.0), bossing: flat(HH, 0.0), gate: ANY, existing: true },
    Item { id: "reserve-life", label: "Life reservation fits", why: "auras reserve all the life", stats: &["LifeUnreserved"], rule: Rule::AtLeast, mapping: flat(HH, 1.0), bossing: flat(HH, 1.0), gate: ANY, existing: true },
    Item { id: "pool-floor", label: "Life and energy shield pool", why: "life plus energy shield is under the floor for this tier", stats: &["NoFlask:Solver.Pool"], rule: Rule::AtLeast, mapping: row(HH, [3500.0, 4500.0, 5500.0, 6000.0]), bossing: row(HH, [3500.0, 4500.0, 5500.0, 6000.0]), gate: ANY, existing: true },
    Item { id: "mana-sustain", label: "Mana cost sustainable", why: "mana regeneration and leech do not pay for the main skill", stats: &["ManaRegenRecovery", "ManaLeechGainRate"], rule: Rule::Covers(&["ManaPerSecondCost"]), mapping: flat(HH, 0.0), bossing: flat(HH, 0.0), gate: ANY, existing: true },
    Item { id: "dot-cap", label: "Damage over time under the game's cap", why: "damage over time is past the game's cap and is wasted", stats: &["TotalDotDPS"], rule: Rule::AtMost, mapping: flat(HH, 35_791_394.0), bossing: flat(HH, 35_791_394.0), gate: ANY, existing: true },
    Item { id: "movement", label: "Movement speed", why: "movement speed is under the floor for this tier", stats: &["EffectiveMovementSpeedMod"], rule: Rule::AtLeast, mapping: row(HH, [1.30, 1.40, 1.50, 1.60]), bossing: flat(HH, 1.30), gate: ANY, existing: true },
    Item { id: "movement-skill", label: "Movement skill", why: "no movement skill (dash, blink, leap) in the setup", stats: &[], rule: Rule::Has(Has::Movement), mapping: flat(HH, 1.0), bossing: flat(SS, 1.0), gate: ANY, existing: false },
    Item { id: "guard-skill", label: "Guard skill", why: "no guard skill to absorb a big hit", stats: &[], rule: Rule::Has(Has::Guard), mapping: flat(SS, 1.0), bossing: flat(SS, 1.0), gate: ANY, existing: false },
    Item { id: "pantheon", label: "Pantheon picked", why: "no pantheon god is set (free damage and ailment protection)", stats: &[], rule: Rule::Has(Has::Pantheon), mapping: flat(SS, 1.0), bossing: flat(SS, 1.0), gate: ANY, existing: false },
    Item { id: "accuracy", label: "Hit chance", why: "the main attack misses too often", stats: &["Solver.CheckAccuracy"], rule: Rule::AtLeast, mapping: row(HH, [85.0, 90.0, 95.0, 100.0]), bossing: row(HH, [90.0, 95.0, 97.0, 100.0]), gate: Gate { tags: &["attack"], not_tags: &["minion"], skip_flags: &[] }, existing: false },
    Item { id: "avoid-freeze", label: "Freeze avoided", why: "the build can be frozen", stats: &["FreezeAvoidChance"], rule: Rule::AtLeast, mapping: flat([S, H, H, H], 100.0), bossing: flat([S, H, H, H], 100.0), gate: ANY, existing: false },
    Item { id: "avoid-bleed", label: "Bleed answered", why: "no bleed immunity or bleed-removing flask", stats: &["Solver.CheckBleedAnswer"], rule: Rule::AtLeast, mapping: flat(SS, 1.0), bossing: flat([S, H, H, H], 1.0), gate: ANY, existing: false },
    Item { id: "avoid-cb", label: "Corrupted blood answered", why: "no corrupted blood immunity or removing flask", stats: &["Solver.CheckCorruptedBloodAnswer"], rule: Rule::AtLeast, mapping: flat(SS, 1.0), bossing: flat([S, H, H, H], 1.0), gate: ANY, existing: false },
    Item { id: "stun-avoid", label: "Stun avoided", why: "frequent short stuns interrupt the clear", stats: &["StunAvoidChance"], rule: Rule::AtLeast, mapping: flat(SS, 50.0), bossing: OFF, gate: ANY, existing: false },
    Item { id: "stun-boss", label: "Boss hit does not stun", why: "a big boss hit can stun the build", stats: &["SelfStunChance"], rule: Rule::AtMost, mapping: OFF, bossing: row([S, S, H, H], [50.0, 50.0, 25.0, 10.0]), gate: ANY, existing: false },
    Item { id: "max-hit", label: "Survives the biggest hit", why: "the smallest maximum hit is under the hit this tier faces", stats: MAXHIT, rule: Rule::AtLeast, mapping: row(SS, [4000.0, 6000.0, 8000.0, 10000.0]), bossing: row([S, S, H, H], [6000.0, 8000.0, 10000.0, 14000.0]), gate: ANY, existing: false },
    Item { id: "max-hit-chaos", label: "Survives the biggest chaos hit", why: "the maximum chaos hit is too small (chaos hits are 2.5 times smaller)", stats: &["ChaosMaximumHitTaken"], rule: Rule::AtLeast, mapping: row(SS, [1600.0, 2400.0, 3200.0, 4000.0]), bossing: row([S, S, H, H], [2400.0, 3200.0, 4000.0, 5600.0]), gate: ANY, existing: false },
    Item { id: "life-sustain", label: "Life recovery", why: "life regeneration, leech and recoup recover too little per second", stats: &["Solver.CheckRecoveryPct"], rule: Rule::AtLeast, mapping: flat(SS, 1.5), bossing: row([S, S, H, H], [2.0; 4]), gate: Gate { tags: &[], not_tags: &[], skip_flags: &["ChaosInoculation"] }, existing: false },
    Item { id: "life-leech", label: "Life leech", why: "a melee build recovers no life from its hits while mapping", stats: &["Solver.CheckLeechPct"], rule: Rule::AtLeast, mapping: flat(SS, 2.0), bossing: OFF, gate: Gate { tags: &["melee"], not_tags: &["minion"], skip_flags: &["ChaosInoculation"] }, existing: false },
    Item { id: "curses", label: "Curse effect on you", why: "curses on you are at full strength", stats: &["Solver.CheckCurseEffect"], rule: Rule::AtMost, mapping: row([O, S, S, S], [100.0, 70.0, 60.0, 50.0]), bossing: row([O, S, S, S], [100.0, 70.0, 60.0, 50.0]), gate: ANY, existing: false },
    Item { id: "avoid-chill", label: "Chill avoided", why: "chill slows the build", stats: &["ChillAvoidChance"], rule: Rule::AtLeast, mapping: flat([O, O, S, S], 100.0), bossing: flat([O, O, S, S], 100.0), gate: ANY, existing: false },
    Item { id: "avoid-shock", label: "Shock avoided", why: "shock raises the damage taken", stats: &["ShockAvoidChance"], rule: Rule::AtLeast, mapping: flat([O, O, S, S], 100.0), bossing: flat([O, O, S, S], 100.0), gate: ANY, existing: false },
    Item { id: "avoid-ignite", label: "Ignite avoided", why: "ignite burns the build", stats: &["IgniteAvoidChance"], rule: Rule::AtLeast, mapping: flat([O, O, S, S], 100.0), bossing: flat([O, O, S, S], 100.0), gate: ANY, existing: false },
    Item { id: "avoid-poison", label: "Poison avoided", why: "poison is not avoided", stats: &["PoisonAvoidChance"], rule: Rule::AtLeast, mapping: flat([O, O, S, S], 100.0), bossing: flat([O, O, S, S], 100.0), gate: ANY, existing: false },
    Item { id: "suppress", label: "Spell suppression capped", why: "spell suppression is invested but not at the cap", stats: &["Solver.CheckSuppress"], rule: Rule::AtLeast, mapping: flat([O, S, S, S], 100.0), bossing: flat([O, S, S, S], 100.0), gate: ANY, existing: false },
    Item { id: "fortify", label: "Fortify up", why: "no Fortify on a melee build", stats: &["FortificationStacks"], rule: Rule::AtLeast, mapping: flat(SS, 20.0), bossing: flat(SS, 20.0), gate: Gate { tags: &["melee"], not_tags: &["minion"], skip_flags: &[] }, existing: false },
];

/// Stats the table needs on top of the scorer's own (the scorer registers them so every result carries their values).
pub fn stat_names() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for it in ITEMS {
        for s in it.stats.iter().chain(match it.rule {
            Rule::Covers(vs) => vs.iter(),
            _ => [].iter(),
        }) {
            // (a `NoFlask:` stat starts from its plain stat, so that one is read too)
            for n in [s.strip_prefix("NoFlask:").unwrap_or(s), s] {
                if !v.iter().any(|x| x == n) {
                    v.push(n.to_string());
                }
            }
        }
        for f in it.gate.skip_flags {
            let n = format!("Solver.Flag.{f}");
            if !v.contains(&n) {
                v.push(n);
            }
        }
    }
    v
}

/// The main skill's gem tags (as the item gates read them).
fn tags_of(goal: &Goal) -> impl Fn(&str) -> bool {
    let tags = find_gem(&goal.skill).and_then(|id| gd::game_data().gems.get(id)).map(|g| g.tags.clone()).unwrap_or_default();
    move |t: &str| tags.get(t).copied().unwrap_or(false)
}

/// The cell and threshold for the goal's mode and tier (both: the stricter of the two).
fn cell(it: &Item, mode: Mode, tier: Wealth) -> (Cell, f64) {
    let t = tier as usize;
    let (m, b) = (it.mapping, it.bossing);
    let pick = |r: Row| (r.cell[t], r.thr[t]);
    match mode {
        Mode::Mapping => pick(m),
        Mode::Bossing => pick(b),
        Mode::Both => {
            let (cm, tm) = pick(m);
            let (cb, tb) = pick(b);
            let need = match (cm == Cell::Off, cb == Cell::Off) {
                (true, _) => tb,
                (_, true) => tm,
                _ if it.rule == Rule::AtMost => tm.min(tb),
                _ => tm.max(tb),
            };
            (cm.max(cb), need)
        }
    }
}

fn applies(it: &Item, tags: &dyn Fn(&str) -> bool) -> bool {
    it.gate.tags.iter().all(|t| tags(t)) && !it.gate.not_tags.iter().any(|t| tags(t))
}

/// One limit the solver must add: `stat` at least / at most `value`.
pub struct Lim {
    pub name: String,
    pub stat: &'static str,
    pub at_least: bool,
    pub value: f64,
    pub scale: f64,
}

/// The hard limits for the goal's mode and tier that the scorer does not already hold. A goal without a wealth tier
/// gets none (older goals keep their exact limits).
pub fn limits(goal: &Goal) -> Vec<Lim> {
    cells(goal, Cell::Hard)
}

/// The soft goals for the goal's mode and tier that read a stat: the scorer takes a small cost for each one missed
/// (`SOFT_NUDGE`), one per item even when it reads several stats (the item's `name`).
pub fn nudges(goal: &Goal) -> Vec<Lim> {
    cells(goal, Cell::Soft)
}

fn cells(goal: &Goal, want: Cell) -> Vec<Lim> {
    let Some(tier) = goal.wealth else { return Vec::new() };
    let (mode, tags) = (mode_of(goal), tags_of(goal));
    let mut out = Vec::new();
    for it in ITEMS.iter().filter(|it| !it.existing && matches!(it.rule, Rule::AtLeast | Rule::AtMost) && applies(it, &tags) && toggle_on(goal, it.id)) {
        let (c, need) = cell(it, mode, tier);
        if c != want {
            continue;
        }
        if want == Cell::Soft {
            // (a nudge counts the shortfall as a share of what the item wants; one entry per stat, grouped by `name`)
            for s in it.stats {
                out.push(Lim { name: it.id.to_string(), stat: s, at_least: it.rule == Rule::AtLeast, value: need, scale: need.abs().max(1.0) });
            }
            continue;
        }
        let n = need.abs();
        let scale = if n == 0.0 { 100.0 } else if n < 10.0 { n } else if n <= 100.0 { 100.0 } else { n / 2.0 };
        // (flags that switch the item off, e.g. Resolute Technique for accuracy, are folded into the `Solver.Check*` stat)
        for s in it.stats {
            let name = if it.stats.len() == 1 { it.label.to_string() } else { format!("{} ({})", it.label, s.trim_start_matches("NoFlask:")) };
            out.push(Lim { name, stat: s, at_least: it.rule == Rule::AtLeast, value: need, scale });
        }
    }
    out
}

/// The goal's own limit switches also gate the checklist limits that belong to them: resistances off turns off the
/// freeze and totem resistance limits, the pool off turns off the maximum-hit ones.
fn toggle_on(goal: &Goal, id: &str) -> bool {
    match id {
        "avoid-freeze" | "res-totem" => goal.limits.resists.is_some(),
        "max-hit" | "max-hit-chaos" => goal.limits.pool.is_some(),
        _ => true,
    }
}

/// Movement speed percent the goal's limit asks for: the default (30) is raised to the mode's floor for the tier.
pub fn movement_floor(goal: &Goal, asked: f64) -> f64 {
    if goal.wealth.is_none() || (asked - DEFAULT_MOVEMENT).abs() > 1e-9 {
        return asked;
    }
    let it = ITEMS.iter().find(|i| i.id == "movement").expect("movement");
    ((cell(it, mode_of(goal), goal.wealth.expect("checked above")).1 - 1.0) * 100.0).round()
}

/// Chaos resistance floor for the tier (0 at league start and mid-league, higher when rich).
pub fn chaos_floor(goal: &Goal) -> f64 {
    if goal.wealth.is_none() {
        return 0.0;
    }
    let it = ITEMS.iter().find(|i| i.id == "res-chaos").expect("res-chaos");
    cell(it, mode_of(goal), goal.wealth.expect("checked above")).1
}

/// Whether the goal's movement skill is a hard requirement (the utility fill then keeps one even when it costs score).
pub fn movement_skill_hard(goal: &Goal) -> bool {
    goal.wealth.is_some_and(|t| ITEMS.iter().find(|i| i.id == "movement-skill").is_some_and(|it| cell(it, mode_of(goal), t).0 == Cell::Hard))
}

/// Whether item `id` applies to the goal at its tier (not off, main skill passes the gate): the finish pass fills only these.
pub fn wants(goal: &Goal, id: &str) -> bool {
    let (Some(tier), tags) = (goal.wealth, tags_of(goal)) else { return false };
    ITEMS.iter().find(|i| i.id == id).is_some_and(|it| applies(it, &tags) && cell(it, mode_of(goal), tier).0 != Cell::Off)
}

/// What a result has beyond its stat values.
pub struct Facts {
    pub movement_skill: bool,
    pub guard_skill: bool,
    pub pantheon: bool,
}

/// The checklist for one result: every item that applies to the goal's mode, tier and main skill, met or not, with the
/// plain reason when unmet. `get` reads a stat of the result (None: not read).
pub fn report(goal: &Goal, get: &dyn Fn(&str) -> Option<f64>, facts: &Facts) -> Vec<Value> {
    // (no tier asked: nothing was applied, so nothing is reported)
    let Some(tier) = goal.wealth else { return Vec::new() };
    let (mode, tags) = (mode_of(goal), tags_of(goal));
    let explicit_pool = goal.limits.pool.filter(|p| *p != DEFAULT_POOL);
    let mut out = Vec::new();
    for it in ITEMS.iter().filter(|it| applies(it, &tags)) {
        let (c, mut need) = cell(it, mode, tier);
        if c == Cell::Off || it.gate.skip_flags.iter().any(|f| get(&format!("Solver.Flag.{f}")).is_some_and(|v| v > 0.0)) {
            continue;
        }
        if it.id == "pool-floor" {
            need = explicit_pool.unwrap_or(need);
        }
        let s = |k: &str| get(k).unwrap_or(0.0);
        let (met, value) = match it.rule {
            Rule::AtLeast => {
                let v = it.stats.iter().map(|k| s(k)).fold(f64::INFINITY, f64::min);
                (v >= need - 1e-9, v)
            }
            Rule::AtMost => {
                let v = it.stats.iter().map(|k| s(k)).fold(f64::NEG_INFINITY, f64::max);
                (v <= need + 1e-9, v)
            }
            Rule::Covers(vs) => {
                let (a, b) = (it.stats.iter().map(|k| s(k)).sum::<f64>(), vs.iter().map(|k| s(k)).sum::<f64>());
                (a >= b - 1e-9, a - b)
            }
            Rule::Has(h) => {
                let has = match h {
                    Has::Movement => facts.movement_skill,
                    Has::Guard => facts.guard_skill,
                    Has::Pantheon => facts.pantheon,
                };
                (has, has as u8 as f64)
            }
        };
        let level = match c {
            Cell::Hard => "hard",
            Cell::Soft => "soft",
            _ => "chip",
        };
        out.push(json!({ "id": it.id, "label": it.label, "level": level, "status": if met { "met" } else { "unmet" }, "value": value, "need": need, "reason": if met { Value::Null } else { json!(it.why) }, "shown": shown(it, value, need), "missing": missing(it, value, need) }));
    }
    out
}

/// The chip text for an unmet item: names the missing thing ("No corrupted blood answer", "Curse effect on you 94% (wants ≤70%)").
fn missing(it: &Item, value: f64, need: f64) -> String {
    let n = |x: f64| if x.abs() >= 100.0 { format!("{x:.0}") } else { format!("{x:.1}").trim_end_matches(".0").to_string() };
    match it.id {
        "movement-skill" => "No movement skill".into(),
        "guard-skill" => "No guard skill".into(),
        "pantheon" => "No pantheon".into(),
        "avoid-bleed" => "No bleed answer".into(),
        "avoid-cb" => "No corrupted blood answer".into(),
        "fortify" if value <= 0.0 => "No Fortify".into(),
        "curses" => format!("Curse effect on you {}% (wants ≤{}%)", n(value), n(need)),
        "life-sustain" => format!("Life recovery {}% (wants ≥{}%)", n(value), n(need)),
        "stun-avoid" => format!("Stun avoidance {}% (wants ≥{}%)", n(value), n(need)),
        _ => format!("{} ({})", it.label, shown(it, value, need)),
    }
}

/// The value and what the item wants in plain words ("+45%, wants +50%", "none", "short by 12/s").
fn shown(it: &Item, value: f64, need: f64) -> String {
    let n = |x: f64| if x.abs() >= 100.0 { format!("{x:.0}") } else { format!("{x:.1}").trim_end_matches(".0").to_string() };
    match it.rule {
        Rule::Has(_) => if value > 0.0 { "yes".into() } else { "none".into() },
        Rule::Covers(_) if value >= 0.0 => "covered".into(),
        Rule::Covers(_) if it.id == "mana-sustain" => format!("short by {}/s", n(-value)),
        Rule::Covers(_) => format!("short by {}", n(-value)),
        _ => match it.id {
            "movement" => format!("+{}%, wants +{}%", n((value - 1.0) * 100.0), n((need - 1.0) * 100.0)),
            "avoid-bleed" | "avoid-cb" => if value >= 1.0 { "answered".into() } else { "no answer".into() },
            "life-sustain" => format!("{}% of life per second, wants {}%", n(value), n(need)),
            "max-hit" | "max-hit-chaos" | "pool-floor" | "reserve-life" | "reserve-mana" => format!("{}, wants {}", n(value), n(need)),
            "fortify" => format!("{} stacks, wants {}", n(value), n(need)),
            "res-ele-cap" | "res-totem" => if value >= 0.0 { "at cap".into() } else { format!("{}% short", n(-value)) },
            _ => format!("{}%, wants {}%", n(value), n(need)),
        },
    }
}

/// `Solver.Check*` stats: an item's stat after its gates (an attack that cannot be evaded has no accuracy to miss) or
/// a presence read off the build's text.
pub(crate) fn stat(env: &crate::Env, key: &str) -> Option<f64> {
    let o = |k: &str| {
        if k == "FlaskLifeRecoveryPct" {
            // shortcut: a life flask is up about a third of the time (flasks refill from kills and are not drunk on a timer); % of life per second
            let life = env.output.get("Life").copied().unwrap_or(0.0).max(1.0);
            return Some(env.flask_life_per_s / life * 100.0 / 3.0);
        }
        env.output.get(k).copied().filter(|v| v.is_finite())
    };
    // "FlaskBleedImmune": a worn flask's parsed mods carry the removal flag (used when bleeding, and a flask the solver
    // does not count as sustained is off in the build, so the outputs never show it)
    let flag = |f: &str| {
        if f == "FlaskBleedImmune" {
            return env.flask_removes_bleed;
        }
        env.player.flag(None, &[pom_engine::sym::Sym::new(f)])
    };
    check_stat(key, &o, &flag)
}

fn check_stat(key: &str, o: &dyn Fn(&str) -> Option<f64>, flag: &dyn Fn(&str) -> bool) -> Option<f64> {
    match key {
        "CheckAccuracy" => Some(if flag("CannotBeEvaded") { 100.0 } else { o("HitChance").unwrap_or(0.0) }),
        // (the engine's parsed outputs, or a flask that removes bleeding: for a player it answers corrupted blood too)
        "CheckBleedAnswer" => Some((o("BleedAvoidChance").unwrap_or(0.0) >= 100.0 || flag("FlaskBleedImmune")) as u8 as f64),
        "CheckCorruptedBloodAnswer" => Some((o("CorruptedBloodImmunity").unwrap_or(0.0) > 0.0 || flag("FlaskBleedImmune")) as u8 as f64),
        // percent of the pool recovered per second without kills (regeneration, leech with on-hit gain, recoup); an ES
        // build (more energy shield than life) counts its shield recovery over life plus shield, any other build only life
        // percent of life leeched per second
        // (an ES build, as CheckRecoveryPct: its shield leech too, over life plus shield)
        "CheckLeechPct" => {
            let (life, es) = (o("Life").unwrap_or(0.0).max(1.0), o("EnergyShield").unwrap_or(0.0));
            let leech = o("LifeLeechGainRate").unwrap_or(0.0);
            Some(if es > life { (leech + o("EnergyShieldLeechGainRate").unwrap_or(0.0)) / (life + es) * 100.0 } else { leech / life * 100.0 })
        }
        "CheckRecoveryPct" => {
            let (life, es) = (o("Life").unwrap_or(0.0).max(1.0), o("EnergyShield").unwrap_or(0.0));
            let g = |k: &str| o(k).unwrap_or(0.0);
            let life_rec = g("LifeRegenRecovery") + g("LifeLeechGainRate") + g("LifeRecoupRecoveryAvg");
            let flask = g("FlaskLifeRecoveryPct");
            Some(if es > life { (life_rec + g("EnergyShieldRegenRecovery") + g("EnergyShieldLeechGainRate")) / (life + es) * 100.0 + flask * life / (life + es) } else { life_rec / life * 100.0 + flask })
        }
        "CheckCurseEffect" => Some(if o("CurseAvoidChance").unwrap_or(0.0) >= 100.0 { 0.0 } else { o("CurseEffectOnSelf").unwrap_or(100.0) }),
        // only once the build invests in suppression (50%): then the cap is the goal
        "CheckSuppress" => Some(if o("SpellSuppressionChance").unwrap_or(0.0) < 50.0 { 100.0 } else { o("EffectiveSpellSuppressionChance").unwrap_or(0.0) }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn goal(skill: &str, mode: &str, tier: &str) -> Goal {
        serde_json::from_value(serde_json::json!({ "skill": skill, "wealth": tier, "assume": { "playMode": mode } })).expect("goal")
    }
    fn hard_ids(g: &Goal) -> Vec<String> {
        limits(g).into_iter().map(|l| l.name).collect()
    }

    #[test]
    fn mapping_mid_requires_freeze_and_movement_skill() {
        let g = goal("Flicker Strike", "mapping", "mid-league");
        assert!(hard_ids(&g).iter().any(|n| n.starts_with("Freeze avoided")), "{:?}", hard_ids(&g));
        assert!(movement_skill_hard(&g));
        // league start: freeze is only a goal
        assert!(!hard_ids(&goal("Flicker Strike", "mapping", "league-start")).iter().any(|n| n.starts_with("Freeze")));
        // bossing keeps the movement skill soft
        assert!(!movement_skill_hard(&goal("Flicker Strike", "bossing", "mid-league")));
    }

    #[test]
    fn bossing_rich_requires_stun_and_max_hit() {
        let ids = hard_ids(&goal("Flicker Strike", "bossing", "rich"));
        assert!(ids.iter().any(|n| n.starts_with("Boss hit does not stun")), "{ids:?}");
        assert!(ids.iter().any(|n| n.starts_with("Survives the biggest hit")), "{ids:?}");
        let mid = hard_ids(&goal("Flicker Strike", "bossing", "mid-league"));
        assert!(!mid.iter().any(|n| n.starts_with("Survives")), "mid-league max hit is a goal only: {mid:?}");
    }

    #[test]
    fn no_tier_means_no_checklist() {
        let g: Goal = serde_json::from_value(serde_json::json!({ "skill": "Flicker Strike" })).unwrap();
        let get = |_: &str| Some(0.0);
        assert!(report(&g, &get, &Facts { movement_skill: false, guard_skill: false, pantheon: false }).is_empty(), "nothing was applied, nothing is reported");
        assert!(limits(&g).is_empty() && !wants(&g, "pantheon"));
    }

    #[test]
    fn goal_limit_switches_gate_the_checklist() {
        let mut g = goal("Flicker Strike", "mapping", "mid-league");
        g.limits.resists = None;
        assert!(!hard_ids(&g).iter().any(|n| n.starts_with("Freeze")), "resists off drops freeze");
        let mut g = goal("Flicker Strike", "bossing", "rich");
        g.limits.pool = None;
        assert!(!hard_ids(&g).iter().any(|n| n.starts_with("Survives")), "pool off drops max hit");
    }

    fn read(key: &str, vals: &[(&str, f64)]) -> f64 {
        read_with(key, vals, &[])
    }
    fn read_with(key: &str, vals: &[(&str, f64)], flags: &[&str]) -> f64 {
        let o = |k: &str| vals.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
        check_stat(key, &o, &|f| flags.contains(&f)).unwrap()
    }

    #[test]
    fn bleed_answer_reads_parsed_outputs() {
        // BleedAvoidChance (BleedImmune, with a flask's UsingFlask condition, reads 100 there) and CorruptedBloodImmunity
        assert_eq!(read("CheckBleedAnswer", &[("BleedAvoidChance", 100.0)]), 1.0);
        assert_eq!(read("CheckBleedAnswer", &[("BleedAvoidChance", 60.0)]), 0.0);
        assert_eq!(read("CheckCorruptedBloodAnswer", &[("CorruptedBloodImmunity", 1.0)]), 1.0);
        assert_eq!(read("CheckCorruptedBloodAnswer", &[]), 0.0);
        // a bleed-removing flask answers both
        assert_eq!(read_with("CheckBleedAnswer", &[], &["FlaskBleedImmune"]), 1.0);
        assert_eq!(read_with("CheckCorruptedBloodAnswer", &[], &["FlaskBleedImmune"]), 1.0);
    }

    /// The mapping finish (melee, no leech: LifeLeechGainRate 0) reads 0%; a leeching build reads its share of life a second.
    #[test]
    fn leech_reads_life_leeched_a_second() {
        assert_eq!(read("CheckLeechPct", &[("Life", 3654.0), ("LifeLeechGainRate", 0.0)]), 0.0);
        assert!((read("CheckLeechPct", &[("Life", 5585.0), ("LifeLeechGainRate", 1117.0)]) - 20.0).abs() < 1e-9);
        // (an ES build reads its shield leech over life plus shield)
        assert!((read("CheckLeechPct", &[("Life", 1000.0), ("EnergyShield", 5000.0), ("LifeLeechGainRate", 0.0), ("EnergyShieldLeechGainRate", 600.0)]) - 10.0).abs() < 1e-9);
        let it = ITEMS.iter().find(|i| i.id == "life-leech").expect("a leech item");
        assert_eq!(cell(it, Mode::Mapping, Wealth::MidLeague).0, Cell::Soft);
    }

    #[test]
    fn es_build_counts_shield_recovery() {
        let es = read("CheckRecoveryPct", &[("Life", 1000.0), ("EnergyShield", 5000.0), ("LifeRegenRecovery", 10.0), ("EnergyShieldRegenRecovery", 150.0)]);
        assert!((es - 160.0 / 6000.0 * 100.0).abs() < 1e-9, "ES build: shield recovery over life plus shield, got {es}");
        let life = read("CheckRecoveryPct", &[("Life", 1000.0), ("EnergyShield", 500.0), ("LifeRegenRecovery", 10.0), ("EnergyShieldRegenRecovery", 150.0)]);
        assert!((life - 1.0).abs() < 1e-9, "life build: life recovery only, got {life}");
    }

    #[test]
    fn minion_main_skips_accuracy() {
        assert!(hard_ids(&goal("Flicker Strike", "mapping", "mid-league")).iter().any(|n| n.starts_with("Hit chance")));
        assert!(!hard_ids(&goal("Raise Spectre", "mapping", "mid-league")).iter().any(|n| n.starts_with("Hit chance")));
        assert!(!hard_ids(&goal("Fireball", "mapping", "mid-league")).iter().any(|n| n.starts_with("Hit chance")), "a spell has no accuracy");
    }

    #[test]
    fn both_takes_the_stricter_cell() {
        let it = ITEMS.iter().find(|i| i.id == "accuracy").unwrap();
        assert_eq!(cell(it, Mode::Both, Wealth::MidLeague), (Cell::Hard, 95.0));
        let mv = ITEMS.iter().find(|i| i.id == "movement").unwrap();
        assert_eq!(cell(mv, Mode::Both, Wealth::Rich).1, 1.5);
    }

    #[test]
    fn low_life_is_half_of_life() {
        // 3000 life, 1500 unreserved (exactly 50%), 3000 es: low life counts the es; at 35% it would not
        assert_eq!(super::super::pool_of(3000.0, 1500.0, 3000.0, false, false, 50.0), 4500.0);
        assert_eq!(super::super::pool_of(3000.0, 1500.0, 3000.0, false, false, 35.0), 1500.0);
    }

    #[test]
    fn report_lists_unmet_with_reason() {
        let g = goal("Flicker Strike", "mapping", "mid-league");
        let get = |k: &str| match k {
            "FreezeAvoidChance" => Some(0.0),
            "EffectiveMovementSpeedMod" => Some(1.45),
            _ => None,
        };
        let r = report(&g, &get, &Facts { movement_skill: false, guard_skill: false, pantheon: true });
        let by = |id: &str| r.iter().find(|c| c["id"] == id).cloned().unwrap_or(Value::Null);
        assert_eq!(by("avoid-freeze")["status"], "unmet");
        assert_eq!(by("avoid-freeze")["level"], "hard");
        assert_eq!(by("movement")["status"], "met");
        assert_eq!(by("movement-skill")["status"], "unmet");
        assert_eq!(by("pantheon")["status"], "met");
    }
}
