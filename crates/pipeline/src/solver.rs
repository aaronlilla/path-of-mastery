//! The build solver: from a goal (main skill, named targets, level, playable limits) it
//! searches class/ascendancy, gem setup and passive tree with the real calc as the only judge, and keeps up to eight
//! builds along the trade-off between the targets. Local search with parallel engine sessions: every candidate is a
//! node list (`Session::eval_nodes`, the optimizer's fast path) or a whole edited build text (`eval_xml_stats`).
//!
//! Layers: class/ascendancy candidates for the skill, gems (main skill supports, auras, curse, guard, movement), tree
//! (from the class start, masteries with their effect, 8 ascendancy points), then gems and tree again until nothing
//! improves. Items (`solver_items.rs`): every slot, flasks, the tree jewel and the anoint, made of rollable
//! modifiers (or allowed uniques), in the same loop. Build texts are put together from a per-class template (no XML
//! parsing per candidate).

use crate::edit::{set_config_input, ConfigValue};
use crate::edit_skills::skills_edit;
use crate::session::{nodes_in_xml, set_nodes_in_xml, Session};
use crate::treeclick::TreePaths;
use crate::treeedit::{compose, with_mastery_attr};
use pom_engine::fxhash::{HashMap, HashSet};
use pom_skills::data as gd;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

#[path = "solver_items.rs"]
mod items;
#[path = "solver_parts.rs"]
mod parts;
use items::{BaseInfo, Gear, ItemRules, SlotDef, SlotKind, UniqueInfo};
#[path = "solver_sens.rs"]
mod sens;
#[path = "solver_beam.rs"]
mod beam;
#[path = "solver_gearparts.rs"]
mod gearparts;
#[path = "solver_config.rs"]
mod config;
#[path = "solver_recheck.rs"]
mod recheck;
#[path = "solver_sockets.rs"]
mod sockets;
#[path = "solver_wealth.rs"]
mod wealth;
#[path = "solver_leads.rs"]
mod leads;
#[path = "solver_clear.rs"]
pub mod clear;
#[path = "solver_mechscan.rs"]
pub mod mechscan;
#[path = "solver_mode.rs"]
mod mode;
pub use mode::PlayMode;
#[path = "solver_checklist.rs"]
mod checklist;
#[path = "solver_basics.rs"]
mod basics;
#[path = "solver_plan.rs"]
mod plan;
#[path = "solver_finish.rs"]
mod finish;
pub use finish::finish;
pub use recheck::honest_measure;
#[path = "solver_synergy.rs"]
pub mod synergy;
pub use wealth::Wealth;
#[cfg(test)]
#[path = "solver_legal_tests.rs"]
mod legal_tests;
#[cfg(test)]
#[path = "solver_finish_tests.rs"]
mod finish_tests;
#[cfg(test)]
#[path = "solver_pass_tests.rs"]
mod pass_tests;
#[cfg(test)]
#[path = "solver_scaling_tests.rs"]
mod scaling_tests;
#[cfg(test)]
#[path = "solver_tree_tests.rs"]
mod tree_tests;
#[cfg(test)]
#[path = "solver_replay_tests.rs"]
mod replay_tests;

// ---------------------------------------------------------------------------------------------------------------
// Goal

#[derive(Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Goal {
    /// Main skill: gem name ("Poisonous Concoction") or gem id.
    pub skill: String,
    /// Optional ascendancy ("Pathfinder"); otherwise the solver tries the classes that fit the skill.
    pub ascendancy: Option<String>,
    /// Optional class ("Templar"): only that class's ascendancies are tried (`ascendancy` narrows further).
    pub class_name: Option<String>,
    /// Character level (default: the build's).
    pub level: Option<i64>,
    pub targets: Vec<Target>,
    pub limits: Limits,
    pub gems: GemRules,
    /// Item rules (allowed rarities, must/never uniques, slot locks). Stored and echoed; the items layer (#47) reads them.
    pub items: Value,
    pub assume: Assume,
    /// Override of the bandit the solver picks ("None", "Oak", "Kraityn", "Alira").
    pub bandit: Option<String>,
    /// Overrides of the point counts the level gives.
    pub passive_points: Option<i64>,
    pub ascendancy_points: Option<i64>,
    /// Optional order hint (Jev's shortlist): which candidates to test first. Never removes one.
    pub priority: Priority,
    /// How crafted rares roll: "typical" (default, the middle of the top two tiers) or "perfect" (best tier, top roll).
    pub rolls: Rolls,
    /// How rich the player is ("league-start" | "mid-league" | "rich" | "mirror", solver_wealth.rs): the gear lines and
    /// uniques the solver may use. None: no limit (mirror); the app asks the player every time.
    pub wealth: Option<Wealth>,
    /// Live unique prices in divine orbs (the app's poe.ninja feed); missing names fall back to engine-data/wealth_prices.json.
    pub unique_prices: std::collections::HashMap<String, f64>,
    /// Keystones every class context starts its tree with (a plan lead's, solver_plan.rs); the search may still give them back.
    pub keystones: Vec<String>,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Rolls {
    #[default]
    Typical,
    Perfect,
}

impl Default for Goal {
    fn default() -> Self {
        Goal { skill: String::new(), ascendancy: None, class_name: None, level: None, targets: Vec::new(), limits: Limits::default(), gems: GemRules::default(), items: Value::Null, assume: Assume::default(), bandit: None, passive_points: None, ascendancy_points: None, priority: Priority::default(), rolls: Rolls::default(), wealth: None, unique_prices: Default::default(), keystones: Vec::new() }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Target {
    pub name: String,
    /// combined (default) | hit | dot | boss | full | minion | ehp | maxhit:<fire|cold|lightning|chaos|physical> | pool | life | es |
    /// resist:<fire|cold|lightning|chaos> | stat:<output key>
    pub metric: String,
    /// The value the player wants; none: as high as possible.
    pub value: Option<f64>,
    pub weight: Option<f64>,
}

impl Goal {
    /// A damage target on one enemy (a bare DPS, boss, hit, dot, full, minion) makes the goal single target: kills and
    /// the charges they give count only for a goal that scores clear alone.
    pub fn settle(mut self) -> Goal {
        let st = |m: &str| matches!(m.trim(), "" | "combined" | "dps" | "boss" | "bossdps" | "hit" | "dot" | "full" | "minion");
        if self.targets.iter().any(|t| st(&t.metric)) || self.targets.is_empty() {
            self.assume.single_target = true;
            if self.assume.play_mode.is_none_or(|m| m == PlayMode::Mapping) {
                self.assume.flask_uptime = FlaskUptime::Bossing;
            }
        }
        self
    }
}

fn d75() -> Option<f64> {
    Some(75.0)
}
fn dpool() -> Option<f64> {
    Some(DEFAULT_POOL)
}
/// Utility skills the player presses (curse, guard, movement, warcry, debuff, offering) at most; auras and golems are set and forget.
const PRESS_CAP: usize = 5;
/// While mapping the player runs through packs pressing the main skill: one or two other buttons at most.
const PRESS_CAP_MAPPING: usize = 2;

/// An item whose "Socketed Gems are Supported by Level N <support>" names a support that adds SkillType Blessing
/// (Divine Blessing): an aura socketed there is a timed buff the player presses.
fn blessing_item(p: &items::Piece) -> bool {
    items::active_lines(&p.xml).iter().any(|l| {
        let l = l.to_lowercase();
        let Some(rest) = l.split("socketed gems are supported by level ").nth(1) else { return false };
        let name = rest.split_once(' ').map_or("", |x| x.1).trim();
        gd::game_data().gems.values().any(|g| g.name.as_deref().is_some_and(|n| n.to_lowercase().trim_end_matches(" support") == name) && gd::gem_primary_effect(g).is_some_and(|ge| gd::add_skill_types(ge).contains(&pom_skills::skill_type::BLESSING)))
    })
}
/// The delivery a "Socketed Gems are Supported by Level N <support>" line gives the gems socketed there: the trap, mine,
/// totem or trigger skill types its support adds (game data `addSkillTypes`: Trap adds Trapped, sup_dex.lua 4089).
pub(crate) fn socketed_delivery(line: &str) -> Vec<i64> {
    use pom_skills::skill_type as ty;
    let l = line.to_lowercase();
    let Some(rest) = l.split("socketed gems are supported by level ").nth(1) else { return Vec::new() };
    let name = rest.split_once(' ').map_or("", |x| x.1).trim();
    let Some(ge) = gd::game_data().gems.values().find(|g| g.name.as_deref().is_some_and(|n| n.to_lowercase().trim_end_matches(" support") == name)).and_then(gd::gem_primary_effect) else { return Vec::new() };
    gd::add_skill_types(ge).into_iter().filter(|t| [ty::TRAPPED, ty::REMOTE_MINED, ty::SUMMONS_TOTEM, ty::TRIGGERED].contains(t)).collect()
}

/// Tries a solve gets per second of its time budget when the goal sets none: what a quiet 6-thread PC made
/// (about 150k in 240 s).
const DEFAULT_EVALS_PER_SEC: u64 = 625;
/// Share of the tries and the time kept back for the finishing passes: the search stops this much early.
const FINAL_RESERVE_PCT: u64 = 8;
/// Kick chains per final (solver.rs `run`): each from its own seed, the final the best of them.
const KICK_CHAINS: usize = 3;
/// Percent of the time budget the leads phase may take on a slow machine before the clock stops it.
const LEADS_WALL: u64 = 30;
/// Evaluations the leads phase gives each class context (sensitivity, screen, weapons). Measured on 6 free threads,
/// a Templar's three spent about 10k.
const LEAD_CTX_EVALS: u64 = 4000;
/// A playable character survives a hit or two: life plus energy shield at least this unless the goal says otherwise.
/// Not asked for: the floor is the wealth tier's (3000 without a tier). Any other value, 3000 included, is honoured.
pub const DEFAULT_POOL: f64 = -1.0;
fn dms() -> Option<f64> {
    Some(DEFAULT_MOVEMENT)
}
/// A player moves at least 30% faster than the base 100%: boots (or a sustained Quicksilver) cover it.
pub const DEFAULT_MOVEMENT: f64 = 30.0;
fn dtrue() -> bool {
    true
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    /// Elemental resistances at least this (null: off).
    #[serde(default = "d75")]
    pub resists: Option<f64>,
    /// Life plus energy shield at least this (null: off).
    #[serde(default = "dpool")]
    pub pool: Option<f64>,
    #[serde(default = "dtrue")]
    pub attributes: bool,
    #[serde(default = "dtrue")]
    pub reservation: bool,
    #[serde(default = "dtrue")]
    pub warnings: bool,
    #[serde(default = "dtrue")]
    pub cost: bool,
    /// Movement speed at least this many percent (flasks that are sustained count; null: off).
    #[serde(default = "dms")]
    pub movement: Option<f64>,
    /// Limits the goal adds: `{stat, min?, max?, name?}`.
    pub extra: Vec<ExtraLimit>,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { resists: d75(), pool: dpool(), attributes: true, reservation: true, warnings: true, cost: true, movement: dms(), extra: Vec::new() }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ExtraLimit {
    pub name: Option<String>,
    pub stat: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// How likely each candidate is to matter for the build (0..1, from the app's shortlister): supports and uniques by
/// name, modifier families by words of their text (or their mod group). Candidates without a number count as 0.5.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Priority {
    pub supports: std::collections::HashMap<String, f64>,
    pub uniques: std::collections::HashMap<String, f64>,
    pub mod_groups: std::collections::HashMap<String, f64>,
}

impl Priority {
    fn is_empty(&self) -> bool {
        self.supports.is_empty() && self.uniques.is_empty() && self.mod_groups.is_empty()
    }

    fn of(map: &std::collections::HashMap<String, f64>, name: &str) -> f64 {
        map.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map_or(0.5, |(_, v)| *v)
    }

    /// A modifier family's number: the best key that is its mod group or a phrase of its text.
    fn of_family(&self, group: &str, text: &str) -> f64 {
        let t = text.to_ascii_lowercase();
        self.mod_groups.iter().filter(|(k, _)| k.eq_ignore_ascii_case(group) || t.contains(&k.to_ascii_lowercase())).map(|(_, v)| *v).reduce(f64::max).unwrap_or(0.5)
    }
}

/// `v` reordered by `p`, higher first; ties keep their order (same candidates, only the order changes).
fn by_priority<T>(v: &mut Vec<T>, p: impl Fn(&T) -> f64) {
    let mut keyed: Vec<(f64, T)> = v.drain(..).map(|x| (p(&x), x)).collect();
    keyed.sort_by(|a, b| b.0.total_cmp(&a.0));
    v.extend(keyed.into_iter().map(|(_, x)| x));
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct GemRules {
    /// Gem names or ids that must be in the setup / must never be.
    pub require: Vec<String>,
    pub ban: Vec<String>,
}

/// Config the solver may assume (normal uptime only). Everything else stays as the build has it.
#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Assume {
    /// Flasks count when the build sustains them (charges generated and gained on critical strikes over the flask's
    /// duration cover its charges per use; kills count too in the default mapping uptime, not when bossing). False: no flask counts.
    pub flasks: bool,
    /// Every flask counts as always on, sustained or not.
    #[serde(rename = "flasksAlways", alias = "flasks_always")]
    pub flasks_always: bool,
    /// The enemy has the ailments the main skill applies.
    pub ailments: bool,
    /// Charges the build can generate. Not assumed yet: the solver cannot tell which charges a build generates.
    pub charges: bool,
    /// Buffs and debuffs the setup keeps up (Withered from a Wither totem, Plague Bearer infecting, Lifetap).
    pub buffs: bool,
    /// "mapping" (default): kills refill flasks too; "bossing": only charges the build generates.
    #[serde(rename = "flaskUptime", alias = "flask_uptime")]
    pub flask_uptime: FlaskUptime,
    /// The play focus, asked every time: no default, the solver refuses to run without it (kill-based sources count only
    /// while mapping; playstyle values differ, solver_config.rs).
    #[serde(rename = "playMode", alias = "play_mode")]
    pub play_mode: Option<PlayMode>,
    /// Config switch keys the player turned on (offers taken): set on every candidate, never turned off by the solver.
    #[serde(rename = "configOn", alias = "config_on")]
    pub config_on: Vec<String>,
    /// Set by `Goal::settle`: a target scores one enemy in a fight without kills, so kill-fed effects and flask charges
    /// from kills do not count whatever the play focus.
    #[serde(skip)]
    pub single_target: bool,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FlaskUptime {
    #[default]
    Mapping,
    Bossing,
}

/// Flask charges per second that kills give each flask while mapping (before its charge gain modifiers). Upstream has no
/// kill rate; a kill gives every flask 1 charge (normal monster), 3.5 (magic), 6 (rare), 11 (unique), so this is about
/// five normal monsters a second. It keeps base Granite/Quicksilver/Sulphur flasks (30-40 charges over 6-8 s) just up.
/// Shortcut: one fixed rate for every build; a goal-level kill rate if players ask for clear-speed tiers.
pub(crate) const MAPPING_KILL_CHARGES: f64 = 5.0;

impl Default for Assume {
    fn default() -> Self {
        Assume { flasks: true, flasks_always: false, ailments: true, charges: false, buffs: true, flask_uptime: FlaskUptime::Mapping, play_mode: None, config_on: Vec::new(), single_target: false }
    }
}

impl Assume {
    /// Flasks count only when sustained (the default): the evaluation turns unsustained flasks off.
    fn sustained(&self) -> bool {
        self.flasks && !self.flasks_always
    }

    /// The solver stat for the share of time a flask-charge-spending skill part is fed under the goal's flask setting.
    fn drain_stat(&self) -> &'static str {
        match self.uptime() {
            FlaskUptime::Mapping => DRAIN_MAP,
            FlaskUptime::Bossing => DRAIN_BOSS,
        }
    }

    /// The solver stat for flask n's uptime under the goal's flask setting.
    fn uptime_stat(&self, n: usize) -> String {
        match self.uptime() {
            FlaskUptime::Mapping => format!("Solver.FlaskUptimeMap{n}"),
            FlaskUptime::Bossing => format!("Solver.FlaskUptime{n}"),
        }
    }

    /// A mapping goal scored on one enemy (`Goal::settle`): its damage reads the fight's flask uptime, but the player
    /// still runs the map, where kills refill flasks, so movement speed and clear read the mapping uptime (`MAP_SIDE`).
    fn map_side(&self) -> bool {
        self.sustained() && self.single_target && self.mode() == PlayMode::Mapping && self.uptime() == FlaskUptime::Bossing
    }
}

/// Stats a single-target mapping goal mixes its flasks into at the mapping uptime (`Assume::map_side`).
const MAP_SIDE: [&str; 2] = ["EffectiveMovementSpeedMod", "Solver.ClearDPS"];

// ---------------------------------------------------------------------------------------------------------------
// Stats the solver derives from the calc (`stat_value` reads them as `Solver.<key>`)

/// `FlaskUptime<n>`: average uptime of the flask in slot "Flask n" in a fight without kills (1 or more = sustained;
/// 0 without a flask there); `FlaskUptimeMap<n>` the same while mapping (kills refill it too). `SelfHitPerSecond`: the damage the main skill deals to its user per second (Trauma,
/// Scold's Bridle, ...). `FlaskMask` / `FlaskBroken` are filled in by the solver's worker.
pub(crate) fn solver_stat(env: &crate::Env, key: &str) -> Option<f64> {
    if key == "FlaskDrainUptime" || key == "FlaskDrainUptimeMap" {
        return Some(crate::solver_drain::uptime_stat(env, key.ends_with("Map")));
    }
    if let Some(n) = key.strip_prefix("FlaskUptimeMap") {
        return Some(flask_uptime(env, n.parse().ok()?, MAPPING_KILL_CHARGES).unwrap_or(0.0));
    }
    if let Some(n) = key.strip_prefix("FlaskUptime") {
        return Some(flask_uptime(env, n.parse().ok()?, 0.0).unwrap_or(0.0));
    }
    if let Some(f) = key.strip_prefix("Flag.") {
        return Some(if env.player.flag(None, &[pom_engine::sym::Sym::new(f)]) { 1.0 } else { 0.0 });
    }
    let o = |k: &str| env.output.get(k).copied().filter(|v| v.is_finite());
    match key {
        "SelfHitPerSecond" => Some(o("SelfHitDamage").unwrap_or(0.0) * o("Speed").unwrap_or(0.0) * o("HitChance").unwrap_or(100.0) / 100.0),
        // Life the main skill's Sacrifice support takes per second: a share of the life it has left, which upstream reads at full life.
        "SacrificedLifePerSecond" => {
            let s = crate::offence::select_main_skill(&env.xml_text, &env.active_skills)?;
            let pct: f64 = s.skill_mod_list.iter().filter(|m| m.ty == pom_engine::modifier::ModType::Base && m.name == pom_engine::sym!("Multiplier:SacrificePercent")).filter_map(|m| if let pom_engine::value::Value::Num(v) = m.value { Some(v) } else { None }).sum();
            Some(pct / 100.0 * o("LifeUnreserved").unwrap_or(0.0) * o("Speed").unwrap_or(0.0))
        }
        "AttackTimeShare" => Some(attack_time_share(&o)),
        "SingleDPS" => Some(crate::solver_boss::single_dps(&with_moving_ground(env, &o))),
        "BossDPS" => Some(crate::solver_boss::boss_dps(&with_moving_ground(env, &o), attack_time_share(&o))),
        "BossPresetShortfall" => Some(crate::solver_boss::preset_shortfall(&crate::solver_boss::presets(), &o)),
        "BossPresetMinRatio" => Some(crate::solver_boss::preset_min_ratio(&crate::solver_boss::presets(), &o)),
        // The weakest type's max hit against the boss's own hit of that type (the engine's configured enemy damage).
        "BossHitRatio" | "BossHitType" | "BossHitValue" | "BossMaxHit" => {
            let w = crate::solver_boss::worst_hit(&o, &|t| crate::solver_boss::boss_hit_of(&env.config_input, &env.config_placeholder, t));
            Some(match key {
                "BossHitRatio" => w.map_or(crate::solver_boss::NO_HIT_RATIO, |w| w.ratio),
                "BossHitType" => w.map_or(0.0, |w| w.ty as f64),
                "BossHitValue" => w.map_or(0.0, |w| w.boss_hit),
                _ => w.map_or(0.0, |w| w.max_hit),
            })
        }
        "ClearDPS" | "ClearTargets" => clear::solver_stat(env, key),
        "LifeRegenNet" => life_regen_net(&o),
        k if k.starts_with("SustainMargin") => {
            let r = &k["SustainMargin".len()..];
            let extra = if r == "Life" { solver_stat(env, "SelfHitPerSecond").unwrap_or(0.0) + solver_stat(env, "SacrificedLifePerSecond").unwrap_or(0.0) } else { 0.0 };
            Some(sustain_margin(r, &o) + SUSTAIN_MARGIN * extra.max(0.0))
        }
        "MainSkillOff" => Some(if main_skill_off(env) { 1.0 } else { 0.0 }),
        "OwnSkillShare" => Some(own_skill_share(&o)),
        "Pool" => {
            let ci = env.player.flag(None, &[pom_engine::sym::Sym::new("ChaosInoculation")]);
            let life = o("Life").unwrap_or(0.0);
            Some(pool_of(life, o("LifeUnreserved").unwrap_or(life), o("EnergyShield").unwrap_or(0.0), env.player.flag(None, &[pom_engine::sym::Sym::new("EnergyShieldProtectsMana")]), ci, o("LowLifePercentage").unwrap_or(50.0)))
        }
        k if k.starts_with("Check") => checklist::stat(env, k),
        _ => None,
    }
}

/// The share of the combined damage the asked skill deals itself: what the Decay a support adds deals is not the skill
/// (Decay Support's own DoT, offence_dps.rs 679), and neither is the Decay of the Mirage Archers. The mirage's own split
/// is not in the output (its DecayDPS goes into MirageDPS, offence_dps.rs 949), so it is taken as the player's.
pub(crate) fn own_skill_share(o: &dyn Fn(&str) -> Option<f64>) -> f64 {
    let combined = o("CombinedDPS").unwrap_or(0.0);
    let player = combined - o("MirageDPS").unwrap_or(0.0);
    let decay = o("DecayDPS").unwrap_or(0.0);
    if combined <= 0.0 || player <= 0.0 || decay <= 0.0 {
        return 1.0;
    }
    (1.0 - decay / player).clamp(0.0, 1.0)
}

/// The asked skill deals at least this share of the damage it is scored on (`own_skill_share`).
pub(crate) const OWN_SHARE: f64 = 0.4;
const OWN_SHARE_LIMIT: &str = "The asked skill deals at least 40% of its damage (a support's own Decay does not count)";

/// `o` plus `MovingGroundDPS`: the Burning Ground a mod drops as the player moves (`DropsBurningGround`, the class by
/// its engine mod, not by item), when it is what sets the sheet's ground damage (the ignite's own ground is not it).
fn with_moving_ground<'a>(env: &'a crate::Env, o: &'a dyn Fn(&str) -> Option<f64>) -> impl Fn(&str) -> Option<f64> + 'a {
    let drops = env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("DropsBurningGround")]) > 0.0;
    let ground = if drops && o("BurningGroundFromIgnite") == Some(0.0) { o("BurningGroundDPS").unwrap_or(0.0).max(o("MirageBurningGroundDPS").unwrap_or(0.0)) } else { 0.0 };
    move |k: &str| if k == "MovingGroundDPS" { Some(ground) } else { o(k) }
}

/// Life recovery per second net of the build's own degeneration (Righteous Fire, Flame-Touched, ...). The engine splits
/// the burn across life, mana (Mind Over Matter) and shield (CalcDefence.lua 3471-3512); a pool counts only for the share
/// its own recovery pays: a pool that cannot pay its share runs dry and the rest lands on life, and a pool's surplus never
/// refills life. Without degen: the life regeneration.
pub(crate) fn life_regen_net(o: &dyn Fn(&str) -> Option<f64>) -> Option<f64> {
    match o("TotalBuildDegen").filter(|d| *d > 0.0) {
        Some(_) => match o("NetLifeRegen") {
            Some(life) => Some(life + o("NetManaRegen").unwrap_or(0.0).min(0.0) + o("NetEnergyShieldRegen").unwrap_or(0.0).min(0.0)),
            None => Some(o("TotalNetRegen")? - o("NetManaRegen").unwrap_or(0.0).max(0.0)),
        },
        None => o("LifeRegenRecovery"),
    }
}

/// A modifier line the engine reads only in part (or not at all) whose text names a cost: the read half is an upside or
/// a token (the Chaos Mastery's "Lose 10% of Life and Energy Shield when you use a Chaos Skill" reads as "-10 Life",
/// ModCache.lua 17462), and the dropped half is what the player pays. Free in every score, so never picked.
pub(crate) fn unpriced_downside(line: &str) -> bool {
    let line = line.trim();
    let mut t = line;
    while t.starts_with('{') {
        let Some(e) = t.find('}') else { break };
        t = &t[e + 1..];
    }
    let (mods, rest) = pom_engine::modparser::parse_mod(t);
    let rest = match (&mods, rest) {
        (Some(_), Some(r)) if !r.trim().is_empty() => r.to_ascii_lowercase(),
        (None, _) => t.to_ascii_lowercase(),
        _ => return false,
    };
    let lower = t.to_ascii_lowercase();
    const COST: [&str; 7] = ["lose ", "take ", "taken", "sacrific", "degenerat", "inflicted with", "you are cursed"];
    COST.iter().any(|c| rest.contains(c)) || ["lose ", "take ", "sacrifice "].iter().any(|v| lower.starts_with(v))
}

/// The passives (by id) and mastery effects (by effect id) of tree `ver` that carry an `unpriced_downside` line.
pub(crate) fn downside_passives(ver: &str) -> Arc<(HashSet<i64>, HashSet<i64>)> {
    static MEMO: std::sync::OnceLock<Mutex<HashMap<String, Arc<(HashSet<i64>, HashSet<i64>)>>>> = std::sync::OnceLock::new();
    let memo = MEMO.get_or_init(Default::default);
    if let Some(v) = memo.lock().unwrap().get(ver) {
        return v.clone();
    }
    let (mut nodes, mut effects) = (HashSet::default(), HashSet::default());
    if let Ok(t) = crate::cached_tree(ver) {
        for (&id, n) in t.nodes.iter() {
            if n.get("stats").map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default().iter().any(|l| unpriced_downside(l)) {
                nodes.insert(id);
            }
            for e in n.get("masteryEffects").map(|v| t.deref(v)).and_then(|v| v.as_array()).into_iter().flatten().map(|x| t.deref(x)) {
                let lines = e.get("stats").map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default();
                if let Some(id) = e.get("effect").and_then(|v| v.as_i64()).filter(|_| lines.iter().any(|l| unpriced_downside(l))) {
                    effects.insert(id);
                }
            }
        }
    }
    let v = Arc::new((nodes, effects));
    memo.lock().unwrap().insert(ver.to_string(), v.clone());
    v
}

/// Share of a resource's spend per second (cost, degeneration, self-damage) its recovery must cover on top: what is left
/// for the damage the build takes. Break-even is not sustain: a map mod or one curse flips it.
pub(crate) const SUSTAIN_MARGIN: f64 = 0.1;

/// `SUSTAIN_MARGIN` of what resource `r` ("Life", "Mana", "ES") spends a second.
fn sustain_margin(r: &str, o: &dyn Fn(&str) -> Option<f64>) -> f64 {
    let g = |k: &str| o(k).unwrap_or(0.0).max(0.0);
    let spend = g(&format!("{r}PerSecondCost")) + if r == "Life" { g("TotalBuildDegen") } else { 0.0 };
    SUSTAIN_MARGIN * spend
}

/// The main skill switched off by its own conditions: the calc disabled it, or a mod of its own gem is gated on a stat
/// threshold the build fails (Righteous Fire's burn, damage and buff need 2 unreserved life, so under Chaos Inoculation
/// it does nothing). Read from the skill's mods, never from its name.
pub(crate) fn main_skill_off(env: &crate::Env) -> bool {
    use pom_engine::value::Value;
    let Some(s) = crate::offence::select_main_skill(&env.xml_text, &env.active_skills) else { return false };
    if s.disable_reason.is_some() || s.skill_flags.contains("disable") {
        return true;
    }
    let own = format!("Skill:{}", s.granted_effect_id);
    let sym = pom_engine::sym::Sym::new;
    let stat = |v: &Value| match v {
        Value::Str(k) => env.output.get(&**k).copied().filter(|x| x.is_finite()),
        _ => None,
    };
    s.skill_mod_list.iter().filter(|m| m.source.as_deref() == Some(own.as_str())).flat_map(|m| m.tags.iter()).filter(|t| t.kind == sym("StatThreshold")).any(|t| {
        let Some(have) = stat(t.get(sym("stat"))) else { return false };
        let Some(need) = t.get(sym("threshold")).num().or_else(|| stat(t.get(sym("thresholdStat")))) else { return false };
        if t.get(sym("upper")).truthy() { have > need } else { have < need }
    })
}

/// Whether the support's required and excluded skill types (Fortify needs Melee) allow the main skill (upstream canGrantedEffectSupportActiveSkill, without
/// the types other supports add).
fn support_fits(support: &str, main: &str) -> bool {
    use pom_skills::active_skill::does_type_expression_match as matches;
    let ge = |id: &str| gd::game_data().gems.get(id).and_then(gd::gem_primary_effect);
    let (Some(sge), Some(mge)) = (ge(support), ge(main)) else { return true };
    let types = gd::skill_types(mge);
    let (exclude, require) = (gd::skill_type_expr(sge, "excludeSkillTypes"), gd::skill_type_expr(sge, "requireSkillTypes"));
    (exclude.is_empty() || !matches(&exclude, &types, None)) && (require.is_empty() || matches(&require, &types, None))
}

/// The pool the floor checks, as a player counts it: the life left unreserved for a life build; plus the energy shield
/// for an energy shield build (Chaos Inoculation, most of the pool in shield, or Low Life: unreserved life at or under
/// the low-life share upstream uses, CalcPerform.lua:77-78, with the shield carrying the pool, at least twice that life). Life
/// reserved by Blood Magic auras is not there to take hits, and a little shield beside it does not make an energy
/// shield build. Under Eldritch Battery the shield protects mana, not life, so it is never part of the pool.
fn pool_of(life: f64, unreserved: f64, es: f64, es_protects_mana: bool, ci: bool, low_life_pct: f64) -> f64 {
    let low_life = life > 0.0 && unreserved <= life * low_life_pct / 100.0 && es >= 2.0 * unreserved;
    if es_protects_mana || !(ci || es > life || low_life) {
        unreserved
    } else {
        unreserved + es
    }
}

/// The share of time the player spends using the main skill when every exerting warcry upstream counts is cast again as
/// soon as it can be: a cast takes `<Cry>CryCastTime`, then the player attacks until the cooldown is over and the
/// exerted attacks are used. Upstream counts the exert uptime but not the time spent shouting, which matters once the
/// cooldown is gone (Howlcrack: "Non-Instant Warcries ignore their Cooldown").
fn attack_time_share(o: &dyn Fn(&str) -> Option<f64>) -> f64 {
    let speed = o("Speed").unwrap_or(0.0);
    let mut shout = 0.0;
    for (p, exerts) in [("Ancestral", "AncestralExertsCount"), ("Infernal", "InfernalExertsCount"), ("Intimidating", "IntimidatingExertsCount"), ("Rallying", "RallyingExertsCount"), ("Seismic", "SeismicExertsCount"), ("BattleMage", "BattleCryExertsCount")] {
        let cast = o(&format!("{p}CryCastTime")).unwrap_or(0.0);
        if cast <= 0.0 {
            continue;
        }
        let cd = o(&format!("{p}CryCooldown")).unwrap_or(0.0);
        let attacking = if speed > 0.0 { o(exerts).unwrap_or(0.0) / speed } else { 0.0 };
        shout += cast / (cast + cd.max(attacking).max(1e-3));
    }
    (1.0 - shout).max(0.05)
}

/// Charges a flask's own modifiers give it per critical strike ("Recharges 1 Charge when you deal a Critical Strike",
/// "35% chance to gain a Flask Charge when you deal a Critical Strike").
fn local_crit_charges(item: &pom_item::Item) -> f64 {
    let mut n = 0.0;
    for l in item.implicit_mod_lines.iter().chain(&item.explicit_mod_lines) {
        let t = l.line.to_ascii_lowercase();
        if !t.contains("when you deal a critical strike") {
            continue;
        }
        let num = t.split(|c: char| !c.is_ascii_digit() && c != '.').find(|s| !s.is_empty()).and_then(|s| s.parse::<f64>().ok());
        if t.starts_with("recharges") {
            n += num.unwrap_or(1.0);
        } else if t.contains("chance to gain a flask charge") {
            n += num.unwrap_or(0.0) / 100.0;
        }
    }
    n
}

/// A flask line that uses the flask only when something happens (frozen, bleeding, a savage hit, a block, a guard or
/// travel skill used, a rare or unique hit, a life flask used): the flask is up only then, so it does not count.
fn flask_fires_on_event(line: &str) -> bool {
    let t = line.to_ascii_lowercase();
    ["used when you become", "used when you start", "used when you take", "used when you block", "used when you hit a rare", "used when you use a life flask"].iter().any(|p| t.starts_with(p)) || t.contains("guard skill") || t.contains("travel skill")
}

/// Charges a second the flask in slot "Flask n" gains: `kills` (from kills) plus the build's generation and critical
/// strikes, times the flask's own and global charge gain modifiers. Regardless of the flask being drunk.
pub(crate) fn flask_gen(env: &crate::Env, n: usize, kills: f64) -> Option<f64> {
    use pom_engine::modifier::ModType as T;
    let id = *env.slot_items.get(&format!("Flask {n}"))?;
    let item = env.items.get(&id)?;
    let fd = item.flask_data.as_ref()?;
    let g = |k: &str| fd.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let info = pom_calc::data::flask_base_info(item.base_name.as_deref()?)?;
    let p = &env.player;
    let sum = |t: T, name: &str| p.sum(t, None, &[pom_engine::sym::Sym::new(name)]);
    let kind = if info.is_life {
        "LifeFlaskChargesGenerated"
    } else if info.is_mana {
        "ManaFlaskChargesGenerated"
    } else {
        "UtilityFlaskChargesGenerated"
    };
    let empty = (1..=5).filter(|i| !env.slot_items.contains_key(&format!("Flask {i}"))).count() as f64;
    let mut gen = kills + sum(T::Base, "FlaskChargesGenerated") + sum(T::Base, kind) + sum(T::Base, "FlaskChargesGeneratedPerEmptyFlask") * empty;
    // Critical strikes: the main skill's crits per second times the charges each gives (the flask's own modifiers, and
    // global ones that do not come from a flask).
    let o = |k: &str| env.output.get(k).copied().filter(|v| v.is_finite());
    let crits = o("Speed").unwrap_or(0.0) * o("HitChance").unwrap_or(100.0) / 100.0 * o("CritChance").unwrap_or(0.0) / 100.0;
    if crits > 0.0 {
        let flask_src: Vec<String> = (1..=5).filter_map(|i| env.slot_items.get(&format!("Flask {i}")).map(|id| format!("Item:{id}:"))).collect();
        let global: f64 = p
            .tabulate(Some(T::Base), None, &[pom_engine::sym::Sym::new("FlaskChargeOnCritChance")])
            .into_iter()
            .filter(|(_, m)| unsafe { (**m).source.as_deref() }.is_none_or(|s| !flask_src.iter().any(|f| s.starts_with(f.as_str()))))
            .filter_map(|(v, _)| v.num())
            .sum::<f64>()
            .min(100.0);
        gen += crits * (local_crit_charges(item) + global / 100.0);
    }
    gen *= g("gainMod").max(0.0) * (1.0 + sum(T::Inc, "FlaskChargesGained") / 100.0);
    Some(gen)
}

/// Average uptime of the flask in slot "Flask n": upstream's flask uptime (charges generated over the flask's duration
/// against its charges per use, chance not to consume charges) plus the charges critical strikes give, without
/// charges from kills unless `kills` (charges per second from kills) says so; Mageblood's flasks are always on.
fn flask_uptime(env: &crate::Env, n: usize, kills: f64) -> Option<f64> {
    use pom_engine::modifier::ModType as T;
    let slot = format!("Flask {n}");
    let id = *env.slot_items.get(&slot)?;
    let item = env.items.get(&id)?;
    let fd = item.flask_data.as_ref()?;
    let g = |k: &str| fd.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let info = pom_calc::data::flask_base_info(item.base_name.as_deref()?)?;
    let p = &env.player;
    let sum = |t: T, name: &str| p.sum(t, None, &[pom_engine::sym::Sym::new(name)]);
    let slot_no = |s: &str| s.rsplit(' ').next().and_then(|x| x.parse::<usize>().ok()).unwrap_or(99);
    // Mageblood: the leftmost / rightmost magic utility flasks constantly apply.
    if env.magic_utility_flasks.iter().any(|f| f.0 == slot) {
        let (left, right) = (sum(T::Base, "LeftActiveMagicUtilityFlasks").max(0.0) as usize, sum(T::Base, "RightActiveMagicUtilityFlasks").max(0.0) as usize);
        let mut order: Vec<usize> = env.magic_utility_flasks.iter().map(|f| slot_no(&f.0)).collect();
        order.sort_unstable();
        let k = order.iter().position(|&x| x == n).unwrap_or(0);
        if k < left || (right > 0 && k + right >= order.len()) {
            return Some(1.0);
        }
    }
    let mut dur = g("duration") * (1.0 + sum(T::Inc, "FlaskDuration") / 100.0);
    if info.is_life || info.is_mana {
        let (rate, inst) = if info.is_life { ("FlaskLifeRecoveryRate", "LifeFlaskInstantRecovery") } else { ("FlaskManaRecoveryRate", "ManaFlaskInstantRecovery") };
        dur = dur / (1.0 + sum(T::Inc, "FlaskRecoveryRate") / 100.0) / (1.0 + sum(T::Inc, rate) / 100.0) / p.more(None, &[pom_engine::sym::Sym::new(rate)]);
        if g("instantPerc") + sum(T::Base, inst) >= 100.0 {
            dur = 0.0;
        }
    }
    // A flask used only when something happens (frozen, bleeding, a savage hit, a block, a guard skill, a rare or unique
    // hit, a life flask used) is up only then: it does not count.
    if item.enchant_mod_lines.iter().chain(&item.implicit_mod_lines).chain(&item.explicit_mod_lines).any(|l| flask_fires_on_event(&l.line)) {
        return Some(0.0);
    }
    let used = g("chargesUsed") * (1.0 + sum(T::Inc, "FlaskChargesUsed") / 100.0);
    if dur <= 0.0 || used <= 0.0 || g("chargesMax") < used {
        return Some(0.0);
    }
    let not_consume = sum(T::Base, "FlaskChanceNotConsumeCharges").clamp(0.0, 100.0);
    if not_consume >= 100.0 {
        return Some(1.0);
    }
    let gen = flask_gen(env, n, kills)?;
    let r = gen * dur / (used * (1.0 - not_consume / 100.0));
    // "Gains no Charges during Effect" (Enkindling / Instilling enchants, some suffixes): no charges while active, so the flask
    // is up for dur out of dur + the time to regain the charges it used.
    let no_charges = item.implicit_mod_lines.iter().chain(&item.explicit_mod_lines).chain(&item.enchant_mod_lines).any(|l| l.line.eq_ignore_ascii_case("Gains no Charges during Effect"));
    Some(if no_charges { r / (1.0 + r) } else { r })
}

/// The flask slots (bit n-1 for "Flask n") a build text marks active.
fn flask_flags(xml: &str) -> u8 {
    let mut mask = 0u8;
    for (i, _) in xml.match_indices("<Slot ") {
        let end = xml[i..].find('>').map_or(xml.len(), |e| i + e);
        let t = &xml[i..end];
        let Some(n) = slot_tag_flask(t) else { continue };
        if t.contains("active=\"true\"") {
            mask |= 1 << (n - 1);
        }
    }
    mask
}

/// The flask number of a `<Slot ...` tag naming "Flask n" (not a swap slot).
fn slot_tag_flask(t: &str) -> Option<usize> {
    let a = t.find(" name=\"Flask ")? + " name=\"Flask ".len();
    let rest = &t[a..];
    let q = rest.find('"')?;
    rest[..q].parse::<usize>().ok().filter(|n| (1..=5).contains(n))
}

/// `xml` with flask slot n active exactly when bit n-1 of `mask` is set.
fn set_flask_flags(xml: &str, mask: u8) -> String {
    let mut out = String::with_capacity(xml.len() + 64);
    let mut at = 0;
    for (i, _) in xml.match_indices("<Slot ") {
        let end = xml[i..].find('>').map_or(xml.len(), |e| i + e);
        let t = &xml[i..end];
        let Some(n) = slot_tag_flask(t) else { continue };
        let on = mask & (1 << (n - 1)) != 0;
        let mut nt = t.replace(" active=\"true\"", "").replace(" active=\"false\"", "");
        if on {
            let cut = if nt.ends_with('/') { nt.len() - 1 } else { nt.len() };
            nt.insert_str(cut, " active=\"true\"");
        }
        out.push_str(&xml[at..i]);
        out.push_str(&nt);
        at = end;
    }
    out.push_str(&xml[at..]);
    out
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Options {
    pub time_budget_ms: Option<u64>,
    /// Ends the solve after about this many evaluations instead of by the clock (the time budget then only scales
    /// the phase fractions). Same input, same work, whatever else the machine is doing. Unset: DEFAULT_EVALS_PER_SEC
    /// for each second of the time budget.
    pub max_evals: Option<u64>,
    /// The kicks' random start (the same goal and seed give the same result).
    pub seed: Option<u64>,
    pub threads: Option<usize>,
}

/// The engine stats a metric reads (summed when more than one) and whether it sets the enemy to a pinnacle boss.
fn metric_stats(metric: &str) -> Result<(Vec<String>, bool), String> {
    let m = metric.trim();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let cap = |t: &str| {
        let mut c = t.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    Ok(match m {
        // (a bare DPS and boss are single target: no culling, solver_boss.rs single_dps; "combined" is upstream's Combined DPS as is,
        // except on a single-target goal, where Scorer::new reads it as "dps")
        "" | "dps" => (s(&[SINGLE_DPS]), false),
        "combined" => (s(&["CombinedDPS"]), false),
        "hit" => (s(&["TotalDPS"]), false),
        "dot" => (s(&["TotalDotDPS"]), false),
        "boss" => (s(&[SINGLE_DPS]), true),
        // (bossing mode, solver_boss.rs: DPS against the Pinnacle and the lowest-max-hit ratio)
        "bossdps" => (s(&["Solver.BossDPS"]), true),
        "bossdef" => (s(&["Solver.BossHitRatio"]), false),
        // (pack clear: solver_clear.rs; scored only when a target names it)
        "clear" => (s(&["Solver.ClearDPS"]), false),
        // (the main group counts in Full DPS)
        "full" => (s(&["FullDPS"]), false),
        // (a minion skill's minion: what upstream shows as the minion's DPS, read without the Full DPS pass)
        "minion" => (s(&["Minion.CombinedDPS"]), false),
        // (mapping: how fast the player gets around, flasks and boots included)
        "movement" => (s(&["EffectiveMovementSpeedMod"]), false),
        "ehp" => (s(&["TotalEHP"]), false),
        "pool" => (s(&["Life", "EnergyShield"]), false),
        "life" => (s(&["Life"]), false),
        "es" => (s(&["EnergyShield"]), false),
        _ => {
            if let Some(t) = m.strip_prefix("maxhit:") {
                (vec![format!("{}MaximumHitTaken", cap(t))], false)
            } else if let Some(t) = m.strip_prefix("resist:") {
                (vec![format!("{}Resist", cap(t))], false)
            } else if let Some(t) = m.strip_prefix("stat:") {
                (vec![t.to_string()], false)
            } else {
                return Err(format!("unknown metric {m:?}"));
            }
        }
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring: weighted objective over the targets, limits as a penalty (search) and as constraints (trade-off set).

#[derive(Clone)]
enum Check {
    AtLeast(usize, f64),
    AtMost(usize, f64),
    /// the sum of stats a >= the sum of stats b
    Ge(Vec<usize>, Vec<usize>),
}

#[derive(Clone)]
struct LimitDef {
    name: String,
    check: Check,
    /// Divides the shortfall so limits are comparable.
    scale: f64,
    /// A skill-cost limit (the gem layer may repair it with a cost fixer).
    cost: bool,
    /// A floor the later layers repair (resists, chaos resistance, the pool, attributes, movement): it counts at
    /// `Scorer::ramp` of its penalty until the first lead cut (solver_leads.rs), so the early tree does not spend
    /// every point on resists.
    soft: bool,
}

#[derive(Clone)]
struct TargetDef {
    name: String,
    metric: String,
    stats: Vec<usize>,
    value: Option<f64>,
    weight: f64,
    /// The player's own damage: scaled by the share of time spent using the skill (`Solver.AttackTimeShare`).
    share: Option<usize>,
    /// Both mode: this is the clear copy of the damage target at that index (the boss one); the two count as their weaker.
    pair: Option<usize>,
}

/// Score weight of the mapping movement speed target (`ln(EffectiveMovementSpeedMod)`; damage counts 1).
const MOVEMENT_WEIGHT: f64 = 0.5;

/// What a soft checklist basic missed in full costs in score: about 3% of damage at the default damage weight (score
/// counts ln(damage)), so it is taken when it is cheap and never bought with real damage. Part-way counts its share.
const SOFT_NUDGE: f64 = 0.03;

/// Wherever TotalEHP enters a score or a target it counts as at most this many times the weakest type's maximum hit
/// so a huge regeneration or recoup figure cannot swamp the score; the number shown stays upstream's.
const EHP_MAX_HIT_MULT: f64 = 20.0;

#[derive(Clone)]
pub struct Scorer {
    names: Vec<String>,
    targets: Vec<TargetDef>,
    limits: Vec<LimitDef>,
    /// The five per-type maximum hit stats, read when an EHP target caps its credit (empty without one).
    hit_idx: Vec<usize>,
    /// Soft checklist goals: (item id, check, scale); each item missed costs up to SOFT_NUDGE.
    nudges: Vec<(String, Check, f64)>,
    /// Weight of the limits' shortfall against the targets' log gains.
    penalty: f64,
    /// Share of a soft limit's shortfall that counts (0.2 until the first lead cut, then 1).
    ramp: f64,
    /// EHP knee (an open EHP target beside an open damage target): above it, EHP counts a tenth (ln(min(x, K)) +
    /// 0.1 ln(x / K)), so 6M EHP no longer outranks 100x the damage. Set at the first lead cut.
    knee: Option<f64>,
    /// Both mode: (clear bar, boss bar), each side's damage divided by its bar before the weaker is taken. Set at the first
    /// lead cut to the leads' median on each side; until then 1, so the raw numbers compete.
    bars: Option<(f64, f64)>,
}

/// How many times over a bossing build must survive its worst counted boss skill before extra EHP stops paying.
const BOSS_SAFE: f64 = 1.5;
const DOT_CAP: f64 = 35_791_394.0;
/// Filled in by the worker: the flask slots the evaluated text counts (bit n-1 = "Flask n") and how many of them are
/// not sustained.
const FLASK_MASK: &str = "Solver.FlaskMask";
/// Share of the time the main skill's flask-charge-spending part is fed (1 when it spends none): fight / mapping.
const SINGLE_DPS: &str = "Solver.SingleDPS";
const DRAIN_BOSS: &str = "Solver.FlaskDrainUptime";
/// 1 when the main skill's own conditions switch it off (`main_skill_off`).
const MAIN_OFF: &str = "Solver.MainSkillOff";
const MAIN_ON: &str = "Main skill switched on";
const DRAIN_MAP: &str = "Solver.FlaskDrainUptimeMap";
const GOLEM_LIMIT: &str = "ActiveGolemLimit";
const FLASK_BROKEN: &str = "Solver.FlaskBroken";
/// Filled in by the worker: 1 when the evaluated text has the "Have you Crit Recently?" switched on because the main
/// skill all but always crits, else 0.
const CRIT_RECENT: &str = "Solver.CritRecently";
const CRIT_RECENT_INPUT: &str = "conditionCritRecently";
/// `NoFlask:<stat>`: the stat with every flask off (the worker evaluates the text once more without them).
const NO_FLASK: &str = "NoFlask:";

/// Whether the main skill lands a crit within 4 s almost surely (P >= 0.9): hits per second x 4 s of tries at the crit chance.
fn crit_near_certain(env: &crate::Env) -> bool {
    let o = |k: &str| crate::stat_value(env, k).filter(|v| v.is_finite());
    let tries = o("Speed").unwrap_or(0.0) * o("HitChance").unwrap_or(100.0) / 100.0 * 4.0;
    let c = (o("CritChance").unwrap_or(0.0) / 100.0).clamp(0.0, 1.0);
    tries > 0.0 && 1.0 - (1.0 - c).powf(tries) >= 0.9
}

fn crit_flag_on(xml: &str) -> bool {
    xml.contains("name=\"conditionCritRecently\" boolean=\"true\"")
}

fn set_crit_flag(xml: &str, on: bool) -> String {
    set_config_input(xml, CRIT_RECENT_INPUT, on.then_some(&ConfigValue::Bool(true))).unwrap_or_else(|_| xml.to_string())
}

/// A warning list key as plain words: "LifePercentCostPercentCostWarningList" reads "Life cost not payable".
fn warning_name(k: &str) -> String {
    let r = k.trim_end_matches("WarningList").trim_end_matches("PercentCostPercentCost").trim_end_matches("Cost");
    format!("{} cost not payable", r.trim_end_matches("Percent"))
}

impl Scorer {
    fn new(goal: &Goal) -> Result<(Scorer, bool), String> {
        let mut names: Vec<String> = Vec::new();
        let mut idx = |n: &str| -> usize {
            if let Some(i) = names.iter().position(|x| x == n) {
                return i;
            }
            names.push(n.to_string());
            names.len() - 1
        };
        let mut boss = false;
        let mut targets = Vec::new();
        let mut tlist: Vec<Target> = if goal.targets.is_empty() { vec![Target { name: "DPS".into(), metric: "dps".into(), ..Default::default() }] } else { goal.targets.clone() };
        // Both: each default damage target also gets a clear copy, read on the mapping enemy (`MAP` stats), paired with its boss one.
        let both = goal.assume.mode() == PlayMode::Both;
        let copies: Vec<(usize, Target)> = if both { tlist.iter().enumerate().filter(|(_, t)| matches!(t.metric.trim(), "" | "combined" | "dps" | "hit" | "dot" | "full")).map(|(i, t)| {
            // (the default damage target is pack clear; hit, dot and full keep their metric, read on the mapping enemy)
            let default = matches!(t.metric.trim(), "" | "combined" | "dps");
            (i, Target { name: format!("Clear {}", t.name), metric: if default { "clear".into() } else { t.metric.clone() }, ..t.clone() })
        }).collect() } else { Vec::new() };
        if goal.assume.mode() != PlayMode::Mapping {
            for t in tlist.iter_mut().filter(|t| matches!(t.metric.trim(), "" | "combined" | "dps" | "boss" | "full" | "hit" | "dot")) {
                t.metric = "bossdps".into();
            }
            tlist.push(Target { name: "Max hit against the boss hit".into(), metric: "bossdef".into(), weight: Some(0.5), ..Default::default() });
        }
        // Mapping gets around the map: movement speed counts half as much as damage in log terms (+40% is worth about
        // +20% damage), so a Quicksilver flask or movement boots earns its slot.
        if goal.assume.mode() != PlayMode::Bossing && !tlist.iter().any(|t| t.metric.trim() == "movement") {
            tlist.push(Target { name: "Movement speed".into(), metric: "movement".into(), weight: Some(MOVEMENT_WEIGHT), ..Default::default() });
        }
        let pairs: Vec<Option<usize>> = (0..tlist.len()).map(|_| None).chain(copies.iter().map(|(i, _)| Some(*i))).collect();
        tlist.extend(copies.into_iter().map(|(_, t)| t));
        // A minion skill's own CombinedDPS is the player's (0 for Holy Relic, Spectres, ...): its combined DPS counts the minion too.
        let minion_main = find_gem(&goal.skill).and_then(|id| gd::game_data().gems.get(id)).is_some_and(|g| g.tags.get("minion").copied().unwrap_or(false));
        // (a skill whose damage is its minions' alone, solver_sens.rs `minion_actor`: the player's own figure is the
        // boots' ground and the like, which the skill does not deal, so only the minions' counts)
        let minion_actor = find_gem(&goal.skill).is_some_and(sens::minion_actor);
        for (ti, t) in tlist.iter().enumerate() {
            // (one enemy: culling, from a support, a node or config, only finishes what other hits nearly killed)
            let metric = if goal.assume.single_target && t.metric.trim() == "combined" { "dps" } else { t.metric.as_str() };
            let (mut stats, b) = metric_stats(metric)?;
            if minion_main && matches!(t.metric.trim(), "" | "combined" | "dps" | "boss" | "bossdps") {
                if minion_actor {
                    stats.clear();
                }
                stats.push("Minion.CombinedDPS".into());
            }
            boss |= b;
            let own_damage = matches!(t.metric.trim(), "" | "combined" | "dps" | "hit" | "dot" | "boss" | "full" | "clear");
            let clear_copy = pairs[ti].is_some();
            let mapped = |n: &str| if clear_copy { format!("{}{n}", mode::MAP) } else { n.to_string() };
            let share = own_damage.then(|| idx(&mapped("Solver.AttackTimeShare")));
            let stats = stats.iter().map(|s| idx(&mapped(s))).collect();
            targets.push(TargetDef { name: if t.name.is_empty() { t.metric.clone() } else { t.name.clone() }, metric: if t.metric.is_empty() { "combined".into() } else { t.metric.clone() }, stats, value: t.value.filter(|v| *v > 0.0), weight: t.weight.unwrap_or(1.0).max(0.0), share, pair: pairs[ti] });
        }
        // (read by the golem utility layer, never scored)
        idx(GOLEM_LIMIT);
        // (the player's own damage, read by the finish's actor check, solver_finish.rs `off_actor_nodes`)
        idx("CombinedDPS");
        idx(CRIT_RECENT);
        let mut limits = Vec::new();
        // Survival: TotalEHP is upstream's number, but it runs to the billions once regeneration, recoup and guard skills outpace the
        // damage it assumes. The EHP target is credited at most 20x the weakest type's maximum hit (`target_value`).
        let hit_idx: Vec<usize> = if targets.iter().any(|t| t.metric.trim() == "ehp") { ["Physical", "Lightning", "Cold", "Fire", "Chaos"].iter().map(|d| idx(&format!("{d}MaximumHitTaken"))).collect() } else { Vec::new() };
        let l = &goal.limits;
        if goal.assume.flasks {
            for s in ["FireResist", "ColdResist", "LightningResist", "ChaosResist", "Solver.Pool"] {
                idx(s);
            }
        }
        // Resistances and the pool hold without flask effects: a flask is up part of the time at best.
        let hard = |s: &str| if goal.assume.flasks { format!("{NO_FLASK}{s}") } else { s.to_string() };
        if let Some(r) = l.resists {
            for e in ["Fire", "Cold", "Lightning"] {
                limits.push(LimitDef { name: format!("{e} resistance {r}%"), check: Check::AtLeast(idx(&hard(&format!("{e}Resist"))), r), scale: 100.0, cost: false, soft: true });
            }
        }
        if let Some(p) = l.pool.map(|p| if p == DEFAULT_POOL { goal.wealth.map_or(3000.0, |w| w.pool_floor()) } else { p }) {
            // (steep: every tenth of the floor missing costs more than doubling a target is worth, so the search stays near it)
            limits.push(LimitDef { name: format!("Life at least {p}"), check: Check::AtLeast(idx(&hard("Solver.Pool")), p), scale: (p / 10.0).max(1.0), cost: false, soft: true });
        }
        // Chaos resistance stays at 0 or more (a chaos-immune build reads 100), the floor a player keeps unless the goal drops the resistance limits.
        if l.resists.is_some() {
            let floor = checklist::chaos_floor(goal);
            limits.push(LimitDef { name: format!("Chaos resistance {floor}%"), check: Check::AtLeast(idx(&hard("ChaosResist")), floor), scale: 100.0, cost: false, soft: true });
        }
        if let Some(m) = l.movement.map(|m| checklist::movement_floor(goal, m)) {
            // (the stat reads 1.3 for +30%)
            limits.push(LimitDef { name: format!("Movement speed at least {m}%"), check: Check::AtLeast(idx("EffectiveMovementSpeedMod"), 1.0 + m / 100.0), scale: 1.0, cost: false, soft: true });
        }
        // (read by the totem limit of the gem layer, never scored)
        idx("ActiveTotemLimit");
        if l.attributes {
            for (a, n) in [("Str", "Strength"), ("Dex", "Dexterity"), ("Int", "Intelligence")] {
                limits.push(LimitDef { name: format!("{n} requirement met"), check: Check::Ge(vec![idx(a)], vec![idx(&format!("Req{a}"))]), scale: 100.0, cost: false, soft: true });
            }
        }
        if l.reservation {
            limits.push(LimitDef { name: "Mana reservation fits".into(), check: Check::AtLeast(idx("ManaUnreserved"), 0.0), scale: 200.0, cost: false, soft: false });
            limits.push(LimitDef { name: "Life reservation fits".into(), check: Check::AtLeast(idx("LifeUnreserved"), 1.0), scale: 500.0, cost: false, soft: false });
        }
        if l.warnings {
            for k in ["LifeCostWarningList", "ManaCostWarningList", "RageCostWarningList", "ESCostWarningList", "LifePercentCostPercentCostWarningList", "ManaPercentCostPercentCostWarningList"] {
                limits.push(LimitDef { name: format!("No warning: {}", warning_name(k)), check: Check::AtMost(idx(k), 0.0), scale: 2.0, cost: true, soft: false });
            }
            limits.push(LimitDef { name: "No warning: DoT DPS over the game's cap".into(), check: Check::AtMost(idx("TotalDotDPS"), DOT_CAP), scale: DOT_CAP, cost: false, soft: false });
            // A hit of the skill on its user (Trauma, ...) never takes the whole pool.
            limits.push(LimitDef { name: "Self-damage per hit below life and energy shield".into(), check: Check::Ge(vec![idx("Life"), idx("EnergyShield")], vec![idx("SelfHitDamage")]), scale: 0.0, cost: false, soft: false });
        }
        // A main skill its own conditions switch off (solver_stat MainSkillOff) does nothing, whatever the sheet says: the
        // full shortfall, and `archive_add` never lists it.
        limits.push(LimitDef { name: MAIN_ON.into(), check: Check::AtMost(idx(MAIN_OFF), 0.0), scale: 0.1, cost: false, soft: false });
        // The asked skill deals the damage it is scored on: a support's own damage over time is no Lightning Arrow build.
        if !minion_main && targets.iter().any(|t| t.share.is_some()) {
            limits.push(LimitDef { name: OWN_SHARE_LIMIT.into(), check: Check::AtLeast(idx("Solver.OwnSkillShare"), OWN_SHARE), scale: 0.1, cost: false, soft: false });
        }
        // Flasks count only when sustained: the evaluation turns the others off; a tree change that loses a flask's
        // sustain is a shortfall until the build is evaluated again.
        if goal.assume.sustained() {
            limits.push(LimitDef { name: "Counted flasks are sustained".into(), check: Check::AtMost(idx(FLASK_BROKEN), 0.0), scale: 1.0, cost: false, soft: false });
            idx(FLASK_MASK);
            for n in 1..=5 {
                idx(&goal.assume.uptime_stat(n));
            }
            if goal.assume.map_side() {
                for n in 1..=5 {
                    idx(&format!("Solver.FlaskUptimeMap{n}"));
                }
            }
            // a skill part that spends flask charges is fed only as long as they last (solver_drain.rs)
            idx(&goal.assume.drain_stat());
        }
        if l.cost {
            // Sustained the way players sustain it: regeneration (auras like Clarity included), leech and gain on hit,
            // against the main skill's cost per second. Not recoup: upstream averages it over the damage of its EHP
            // calculation, damage the player does not take while clearing. Mana cost moved to life (Lifetap, Blood Magic)
            // shows up as life cost.
            // Damage the skill does to its user (Trauma, Scold's Bridle) and the build's degeneration are paid from the
            // same life recovery.
            for r in ["Mana", "Life", "ES"] {
                // (life regeneration net of the build's own degeneration: Righteous Fire, Flame-Touched, ...; the shield
                // pays a skill's cost under Eldritch Battery: it recharges, regenerates and leeches, solver_boss.rs sustain_rate)
                let regen = if r == "Life" { "Solver.LifeRegenNet".to_string() } else if r == "ES" { "EnergyShieldRecharge".to_string() } else { format!("{r}RegenRecovery") };
                let leech = if r == "ES" { "EnergyShieldLeechGainRate".to_string() } else { format!("{r}LeechGainRate") };
                let mut rec = vec![idx(&regen), idx(&leech)];
                if r == "ES" {
                    rec.push(idx("EnergyShieldRegenRecovery"));
                }
                // (recovery covers the spend plus a margin for the damage taken: break-even is not sustain)
                let mut spend = vec![idx(&format!("{r}PerSecondCost")), idx(&format!("Solver.SustainMargin{r}"))];
                if r == "Life" {
                    // (the degeneration on both sides: the margin stays the net regeneration, and the shortfall reads as a
                    // share of the burn, so every regeneration bought shows; alone on the regeneration side it sat at the cap)
                    rec.push(idx("TotalBuildDegen"));
                    spend.push(idx("TotalBuildDegen"));
                    spend.push(idx("Solver.SelfHitPerSecond"));
                    // (Sacrifice scales off current life, but upstream scores it at full life: it only holds when the life comes back)
                    spend.push(idx("Solver.SacrificedLifePerSecond"));
                }
                let name = match r {
                    "Life" => "Life cost and self-damage sustainable".to_string(),
                    "ES" => "Energy shield cost sustainable".to_string(),
                    _ => format!("{r} cost sustainable"),
                };
                limits.push(LimitDef { name, check: Check::Ge(rec, spend), scale: 0.0, cost: true, soft: false });
            }
        }
        // The checklist's hard cells for the goal's mode and tier (solver_checklist.rs), and every stat its report reads.
        for c in checklist::limits(goal) {
            let i = idx(&c.stat);
            let check = if c.at_least { Check::AtLeast(i, c.value) } else { Check::AtMost(i, c.value) };
            limits.push(LimitDef { name: c.name, check, scale: c.scale, cost: false, soft: true });
        }
        // The checklist's soft cells: a small cost each when missed (SOFT_NUDGE), never a limit.
        let mut nudges: Vec<(String, Check, f64)> = Vec::new();
        for c in checklist::nudges(goal) {
            let i = idx(&c.stat);
            nudges.push((c.name, if c.at_least { Check::AtLeast(i, c.value) } else { Check::AtMost(i, c.value) }, c.scale));
        }
        for n in checklist::stat_names() {
            idx(&n);
        }
        for e in &l.extra {
            let i = idx(&e.stat);
            let name = e.name.clone().unwrap_or_else(|| e.stat.clone());
            if let Some(m) = e.min {
                limits.push(LimitDef { name: format!("{name} at least {m}"), check: Check::AtLeast(i, m), scale: m.abs().max(1.0), cost: false, soft: false });
            }
            if let Some(m) = e.max {
                limits.push(LimitDef { name: format!("{name} at most {m}"), check: Check::AtMost(i, m), scale: m.abs().max(1.0), cost: false, soft: false });
            }
        }
        // A Pinnacle hit that one-shots the build is no bossing build: below the boss's hit the shortfall costs 5 per
        // full hit missing (a 60% build pays 2, more than doubling the damage is worth).
        if goal.assume.mode() != PlayMode::Mapping {
            limits.push(LimitDef { name: "Every max hit at least the boss's hit of that type".into(), check: Check::AtLeast(idx("Solver.BossHitRatio"), 1.0), scale: 0.2, cost: false, soft: true });
            // Boss skills (the config's preset list) that would one-shot the build: a soft cost by how far short it is.
            limits.push(LimitDef { name: "Survives every boss skill".into(), check: Check::AtMost(idx("Solver.BossPresetShortfall"), 0.0), scale: 0.5, cost: false, soft: true });
            // (read for result text, chips and the bossing EHP knee)
            for k in ["Solver.BossPresetMinRatio", "Solver.BossHitType", "Solver.BossHitValue", "Solver.BossMaxHit"] {
                idx(k);
            }
        }
        // (shown with every result)
        idx("Life");
        idx("EnergyShield");
        Ok((Scorer { names, targets, limits, hit_idx, nudges, penalty: 1.0, ramp: 1.0, knee: None, bars: None }, boss))
    }

    fn get(v: &[Option<f64>], i: usize) -> f64 {
        v.get(i).copied().flatten().unwrap_or(0.0)
    }

    /// The target's stats as the sidebar reads them once the build is applied: no shouting time.
    fn shown_value(&self, t: &TargetDef, v: &[Option<f64>]) -> f64 {
        t.stats.iter().map(|&i| Self::get(v, i)).sum()
    }

    /// The weakest type against the boss's hit, from an evaluation's stored numbers (None: the boss hits for nothing).
    fn boss_worst(&self, v: &[Option<f64>]) -> Option<crate::solver_boss::Worst> {
        let at = |n: &str| self.names.iter().position(|x| x == n).map(|k| Self::get(v, k));
        let ratio = at("Solver.BossHitRatio")?;
        (ratio < crate::solver_boss::NO_HIT_RATIO).then(|| crate::solver_boss::Worst { ratio, ty: at("Solver.BossHitType").unwrap_or(0.0) as usize, boss_hit: at("Solver.BossHitValue").unwrap_or(0.0), max_hit: at("Solver.BossMaxHit").unwrap_or(0.0) })
    }

    /// The damage target's value: the first one that scales by time spent attacking, or the boss DPS in bossing mode.
    fn damage_value(&self, v: &[Option<f64>]) -> f64 {
        self.targets.iter().find(|t| t.share.is_some() || t.metric == "bossdps").map_or(0.0, |t| self.target_value(t, v))
    }

    /// Stats the limits read and no target does.
    fn limit_only(&self) -> Vec<String> {
        let read: HashSet<usize> = self.targets.iter().flat_map(|t| t.stats.iter().copied().chain(t.share)).collect();
        let mut out: Vec<String> = Vec::new();
        for l in &self.limits {
            let ix: Vec<usize> = match &l.check {
                Check::AtLeast(i, _) | Check::AtMost(i, _) => vec![*i],
                Check::Ge(a, b) => a.iter().chain(b).copied().collect(),
            };
            for i in ix.into_iter().filter(|i| !read.contains(i)) {
                if !out.contains(&self.names[i]) {
                    out.push(self.names[i].clone());
                }
            }
        }
        out
    }

    fn target_value(&self, t: &TargetDef, v: &[Option<f64>]) -> f64 {
        let share = t.share.map_or(1.0, |i| v.get(i).copied().flatten().unwrap_or(1.0));
        let x = (t.stats.iter().map(|&i| Self::get(v, i)).sum::<f64>()).max(0.0) * share;
        // (EHP: credited up to 20x the true weakest max hit; no max hit read means uncapped)
        match self.hit_idx.iter().filter_map(|&i| v.get(i).copied().flatten()).reduce(f64::min) {
            Some(m) if t.metric.trim() == "ehp" => x.min(m * EHP_MAX_HIT_MULT),
            _ => x,
        }
    }

    /// Each limit's shortfall, normalised (0 = met).
    fn deficits(&self, v: &[Option<f64>]) -> Vec<f64> {
        self.limits
            .iter()
            .map(|l| {
                let d = match &l.check {
                    Check::AtLeast(i, need) => (need - Self::get(v, *i)) / l.scale,
                    Check::AtMost(i, cap) => (Self::get(v, *i) - cap) / l.scale,
                    Check::Ge(a, b) => {
                        let (x, y) = (a.iter().map(|&i| Self::get(v, i)).sum::<f64>(), b.iter().map(|&i| Self::get(v, i)).sum::<f64>());
                        (y - x) / if l.scale > 0.0 { l.scale } else { y.abs().max(1.0) }
                    }
                };
                if d > 1e-9 {
                    // (capped at 10, not 3: a build far under a life floor still gains by closing it)
                    d.min(10.0) * if l.soft { self.ramp } else { 1.0 }
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// Bossing: the EHP at which the worst counted boss skill is survived at `BOSS_SAFE` times and the Pinnacle hit at 1
    /// (max hits scale with EHP). None outside bossing.
    fn boss_need(&self, v: &[Option<f64>], ehp: f64) -> Option<f64> {
        let at = |n: &str| self.names.iter().position(|x| x == n).and_then(|k| v.get(k).copied().flatten());
        let (pr, hr) = (at("Solver.BossPresetMinRatio")?, at("Solver.BossHitRatio")?);
        Some(ehp * (BOSS_SAFE / pr.max(1e-3)).max(1.0 / hr.max(1e-3)))
    }

    /// (score, total shortfall). Each target adds weight * ln(value / target) below its target and a hundredth of that
    /// above it; without a target the plain log, so every target counts by relative change.
    fn score(&self, v: &[Option<f64>], weights: &[f64]) -> (f64, f64) {
        let mut s = 0.0;
        // A target without a number ("as high as possible") yields to a stated one: its log counts in proportion to how
        // far the stated targets have got, so the goal is pursued first and the open targets break ties once it is met.
        let goal_reached = self.targets.iter().filter_map(|t| t.value.map(|tv| (self.target_value(t, v).max(1e-3) / tv).min(1.0))).fold(1.0, f64::min);
        let open_damage = self.targets.iter().any(|t| t.value.is_none() && (t.share.is_some() || matches!(t.metric.trim(), "minion" | "bossdps")));
        let mut rs = Vec::with_capacity(self.targets.len());
        for t in self.targets.iter() {
            let x = self.target_value(t, v).max(1e-3);
            // (Both: an open damage target counts over its side's bar)
            let k = rs.len();
            let x = match (self.bars, t.value) {
                (Some((c, _)), None) if t.pair.is_some() => x / c.max(1e-3),
                (Some((_, b)), None) if self.targets.iter().any(|c| c.pair == Some(k)) => x / b.max(1e-3),
                _ => x,
            };
            let r = match t.value {
                Some(tv) => {
                    let r = (x / tv).ln();
                    if r > 0.0 {
                        // Surplus above a target is worth (near) nothing: a floor, not something to trade DPS for.
                        0.01 * r
                    } else {
                        r
                    }
                }
                // Bossing: once every counted boss skill is survived at BOSS_SAFE and the Pinnacle hit at 1, extra EHP (and
                // extra Pinnacle margin) counts a tenth; below that point it counts in full.
                None if t.metric.trim() == "bossdef" => (x.min(1.0).ln() + 0.1 * x.max(1.0).ln()) * goal_reached,
                None if open_damage && t.metric.trim() == "ehp" && self.boss_need(v, x).is_some() => {
                    let kn = self.boss_need(v, x).unwrap_or(x);
                    (x.min(kn).ln() + 0.1 * (x / kn).max(1.0).ln()) * goal_reached
                }
                None => match self.knee.filter(|_| open_damage && t.metric.trim() == "ehp") {
                    Some(kn) => (x.min(kn).ln() + 0.1 * (x / kn).max(1.0).ln()) * goal_reached,
                    None => x.ln() * goal_reached,
                },
            };
            rs.push(r);
        }
        for (k, t) in self.targets.iter().enumerate() {
            if t.pair.is_some() {
                continue;
            }
            // Both: the clear copy and the boss target count as the weaker of the two.
            let r = self.targets.iter().position(|c| c.pair == Some(k)).map_or(rs[k], |c| rs[k].min(rs[c]));
            s += weights.get(k).copied().unwrap_or(t.weight) * r;
        }
        let viol: f64 = self.deficits(v).iter().sum();
        (s - self.penalty * viol - SOFT_NUDGE * self.soft_missed(v), viol)
    }

    /// How much of the soft goals is missed: per item the largest share short over its stats (0-1), summed.
    fn soft_missed(&self, v: &[Option<f64>]) -> f64 {
        let mut items: Vec<(&str, f64)> = Vec::new();
        for (id, c, scale) in &self.nudges {
            let d = match c {
                Check::AtLeast(i, need) => (need - Self::get(v, *i)) / scale,
                Check::AtMost(i, cap) => (Self::get(v, *i) - cap) / scale,
                Check::Ge(..) => 0.0,
            }
            .clamp(0.0, 1.0);
            match items.iter_mut().find(|(n, _)| n == id) {
                Some(e) => e.1 = e.1.max(d),
                None => items.push((id, d)),
            }
        }
        items.iter().map(|(_, d)| d).sum()
    }

    /// Both mode: (clear score, boss score, "clear" or "boss" for the weaker): each side's damage over its bar. None outside Both.
    fn both_sides(&self, v: &[Option<f64>]) -> Option<(f64, f64, &'static str)> {
        let clear = self.targets.iter().find(|t| t.pair.is_some())?;
        let boss = self.targets.get(clear.pair?)?;
        let (bc, bb) = self.bars.unwrap_or((1.0, 1.0));
        let (c, b) = (self.target_value(clear, v) / bc.max(1e-3), self.target_value(boss, v) / bb.max(1e-3));
        Some((c, b, if c < b { "clear" } else { "boss" }))
    }

    /// Both mode: bars from a build's two sides (each at least 1) while none are set, so the first leads are scored on
    /// bar units too. The first lead cut replaces them with the leads' median.
    fn provisional_bars(&mut self, v: &[Option<f64>]) {
        let Some(c) = self.targets.iter().find(|t| t.pair.is_some()).filter(|t| t.value.is_none()) else { return };
        if self.bars.is_some() {
            return;
        }
        let Some(b) = c.pair.and_then(|k| self.targets.get(k)) else { return };
        self.bars = Some((self.target_value(c, v).max(1.0), self.target_value(b, v).max(1.0)));
    }

    /// The score as if every skill-cost limit were met: what a setup would be worth once its cost is fixed.
    fn score_cost_free(&self, v: &[Option<f64>], weights: &[f64]) -> f64 {
        let (s, _) = self.score(v, weights);
        let cost: f64 = self.deficits(v).iter().zip(&self.limits).filter(|(_, l)| l.cost).map(|(d, _)| d).sum();
        s + self.penalty * cost
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Parallel evaluation: persistent workers, each with its own engine session.

#[derive(Clone)]
enum Cand {
    /// The build text `base` with its active node list replaced (and one mastery choice added).
    Nodes { base: Arc<String>, nodes: Vec<i64>, mastery: Option<(i64, i64)>, pin: Vec<i64> },
    /// A whole build text.
    Xml(Arc<String>),
    /// The open build's text: its own flasks stay as they are (the sidebar's numbers), not the sustained ones.
    Open(Arc<String>),
}

type Vals = Vec<Option<f64>>;

struct Task {
    i: usize,
    cand: Cand,
    names: Arc<Vec<String>>,
    tx: mpsc::Sender<(usize, Option<Vals>)>,
    cancel: Arc<AtomicBool>,
}

struct Pool {
    tx: Option<mpsc::Sender<Task>>,
    handles: Vec<std::thread::JoinHandle<()>>,
    threads: usize,
}

const WORKER_STACK: usize = 64 * 1024 * 1024;

thread_local! {
    /// A worker's last node-list base with flasks up part of the time: (the base, held so its address is not reused by
    /// another text, those flasks, the stat names, per flask each stat without it and with it).
    static FLASK_RATIO: RefCell<Option<(Arc<String>, u8, Vec<String>, Vec<Vec<(Option<f64>, Option<f64>)>>)>> = const { RefCell::new(None) };
    /// The same for the flasks a single-target mapping goal counts at the mapping uptime (`MAP_SIDE`).
    static FLASK_RATIO_MAP: RefCell<Option<(Arc<String>, u8, Vec<String>, Vec<Vec<(Option<f64>, Option<f64>)>>)>> = const { RefCell::new(None) };
    /// A worker's last node-list base with a flask-charge-spending part: (the base, the stat names, each stat on the
    /// fallback part and on the spending part).
    static DRAIN_RATIO: RefCell<Option<(Arc<String>, Vec<String>, Vec<(Option<f64>, Option<f64>)>)>> = const { RefCell::new(None) };
    /// A worker's stats read only by limits (`Scorer::limit_only`): they keep the sustained flasks alone, no uptime mix.
    static LIMIT_ONLY: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn eval_one(session: &mut Option<Session>, cand: &Cand, names: &[&str]) -> Result<Vals, String> {
    let game = pom_calc::data::game_data();
    // Flasks count when sustained (the goal's default): the names then ask for the flask mask and shortfall.
    let fm = names.iter().position(|n| *n == FLASK_MASK);
    let fb = names.iter().position(|n| *n == FLASK_BROKEN);
    let pos = |s: String| names.iter().position(|n| *n == s);
    let up: Vec<Option<usize>> = (1..=5).map(|k| pos(format!("Solver.FlaskUptime{k}")).or_else(|| pos(format!("Solver.FlaskUptimeMap{k}")))).collect();
    // (both uptimes asked: a single-target mapping goal, Assume::map_side; its MAP_SIDE stats mix at the mapping one)
    let up_map: Vec<Option<usize>> = (1..=5).map(|k| pos(format!("Solver.FlaskUptime{k}")).and(pos(format!("Solver.FlaskUptimeMap{k}")))).collect();
    let map_stat = |n: &str| up_map.iter().any(Option::is_some) && MAP_SIDE.contains(&n);
    let sustained_mask = |v: &Vals| -> u8 { up.iter().enumerate().filter(|(_, i)| i.and_then(|i| v[i]).is_some_and(|u| u >= 0.999)).fold(0u8, |m, (k, _)| m | (1 << k)) };
    let cr = names.iter().position(|n| *n == CRIT_RECENT);
    // (a `NoFlask:` stat reads its own stat; the whole-text path evaluates it again with the flasks off)
    let nf: Vec<(usize, Option<usize>)> = names.iter().enumerate().filter_map(|(i, n)| n.strip_prefix(NO_FLASK).map(|s| (i, names.iter().position(|m| *m == s)))).collect();
    let flasks_on = |v: &mut Vals| {
        for &(i, s) in &nf {
            v[i] = s.and_then(|s| v[s]);
        }
    };
    // A flask kept up part of the time counts at its own uptime u: u x the stats with it on + (1 - u) x without it, each
    // flask measured alone and the changes added (a 2% Replica Rumi's next to 98% life flasks counts at 2%, not their mean).
    // Out: the flasks that are not on and are up some of the time (their mask) and each one's (bit, uptime).
    // (`full`: a flask the text has off that is sustained on this uptime counts whole; the mapping side's flasks are off
    // whenever the fight cannot sustain them)
    let partial_on = |v: &Vals, have: u8, up: &[Option<usize>], full: bool| -> Option<(u8, Vec<(u8, f64)>)> {
        fm?;
        let ups: Vec<(u8, f64)> = up.iter().enumerate().filter(|(k, _)| have & (1 << k) == 0).filter_map(|(k, i)| Some((1u8 << k, i.and_then(|i| v[i])?))).filter(|(_, u)| *u > 0.0 && (full || *u < 0.999)).map(|(b, u)| (b, u.min(1.0))).collect();
        (!ups.is_empty()).then(|| (ups.iter().fold(0u8, |m, (b, _)| m | b), ups))
    };
    let partial = |v: &Vals, have: u8| partial_on(v, have, &up, false);
    let partial_map = |v: &Vals, have: u8| partial_on(v, have, &up_map, true);
    let limit_only = LIMIT_ONLY.with(|l| l.borrow().clone());
    let mixed = |n: &str| !map_stat(n) && (n == SINGLE_DPS || !n.starts_with("Solver.")) && !n.starts_with(NO_FLASK) && !limit_only.iter().any(|l| l == n);
    // A skill part that spends flask charges is fed `u` of the time (solver_drain.rs); the rest of it plays the part it falls
    // back to (part 1). The scored damage is the mix.
    let dr = names.iter().position(|n| *n == DRAIN_BOSS || *n == DRAIN_MAP);
    let drain_mixed = |n: &str| mixed(n) || n == "Solver.BossDPS" || n == "Solver.ClearDPS";
    let fed = |v: &Vals| dr.and_then(|d| v[d]).filter(|u| *u < 1.0);
    // (the text with the main socket group's gem that has a skill part on part 1)
    let unfed = |t: &str| -> Option<String> {
        let b = t.find("<Build ")?;
        let n: usize = t[b..b + t[b..].find('>')?].split("mainSocketGroup=\"").nth(1)?.split('"').next()?.parse().ok()?;
        let start = t.match_indices("<Skill ").nth(n.max(1) - 1)?.0;
        let end = start + t[start..].find("</Skill>")?;
        let g = start + t[start..end].match_indices("<Gem ").find(|(i, _)| t[start + i..end].split('>').next().is_some_and(|x| x.contains(" skillPart=\"")))?.0;
        let at = g + t[g..].find(" skillPart=\"")? + " skillPart=\"".len();
        let q = at + t[at..].find('"')?;
        Some(format!("{}1{}", &t[..at], &t[q..]))
    };
    let finish = |v: &mut Vals, have: u8| {
        if let (Some(a), Some(b)) = (fm, fb) {
            let want = sustained_mask(v);
            v[a] = Some(have as f64);
            v[b] = Some((have & !want).count_ones() as f64);
        }
    };
    match cand {
        Cand::Nodes { base, nodes, mastery, pin } => {
            if session.as_ref().is_none_or(|s| s.xml() != base.as_str()) {
                *session = Some(Session::new(base.to_string(), game));
            }
            let mut v = session.as_mut().unwrap().eval_nodes_with(nodes, names, pin, *mastery)?;
            // (flasks up part of the time: the base text's own stats with and without them, measured once per base; a
            // stat moves by their ratio, or by their difference where the base has none of it)
            // (the fight's uptime for the scored stats, then the mapping uptime for MAP_SIDE on a single-target mapping goal)
            let sides: [(_, _, &dyn Fn(&str) -> bool); 2] = [(&FLASK_RATIO, partial(&v, flask_flags(base)), &mixed), (&FLASK_RATIO_MAP, partial_map(&v, flask_flags(base)), &map_stat)];
            for (cache, part, pick) in sides {
                let Some((mask, ups)) = part else { continue };
                let hit = cache.with(|c| c.borrow().as_ref().filter(|r| Arc::ptr_eq(&r.0, base) && r.1 == mask && r.2.iter().map(|s| s.as_str()).eq(names.iter().copied())).map(|r| r.3.clone()));
                let ratios = match hit {
                    Some(r) => r,
                    None => {
                        let s = session.as_mut().unwrap();
                        let read = |env: &crate::Env| names.iter().map(|n| crate::stat_value(env, n)).collect::<Vals>();
                        let off = s.eval_xml(base, false, read)?;
                        let mut r = Vec::new();
                        for (b, _) in &ups {
                            let on = s.eval_xml(&set_flask_flags(base, flask_flags(base) | b), false, read)?;
                            r.push(off.iter().copied().zip(on).collect::<Vec<(Option<f64>, Option<f64>)>>());
                        }
                        cache.with(|c| *c.borrow_mut() = Some((base.clone(), mask, names.iter().map(|s| s.to_string()).collect(), r.clone())));
                        r
                    }
                };
                for (i, n) in names.iter().enumerate() {
                    let Some(a) = v[i].filter(|_| pick(n)) else { continue };
                    let mut out = a;
                    for ((_, u), ratio) in ups.iter().zip(&ratios) {
                        if let (Some(x), Some(y)) = ratio[i] {
                            out += if x != 0.0 { a * u * (y / x - 1.0) } else { u * y };
                        }
                    }
                    v[i] = Some(out);
                }
            }
            if let (Some(u), Some(off_base)) = (fed(&v), unfed(base)) {
                let hit = DRAIN_RATIO.with(|c| c.borrow().as_ref().filter(|r| Arc::ptr_eq(&r.0, base) && r.1.iter().map(|s| s.as_str()).eq(names.iter().copied())).map(|r| r.2.clone()));
                let ratio = match hit {
                    Some(r) => r,
                    None => {
                        let s = session.as_mut().unwrap();
                        let read = |env: &crate::Env| names.iter().map(|n| crate::stat_value(env, n)).collect::<Vals>();
                        let (off, on) = (s.eval_xml(&off_base, false, read)?, s.eval_xml(base, false, read)?);
                        let r: Vec<(Option<f64>, Option<f64>)> = off.into_iter().zip(on).collect();
                        DRAIN_RATIO.with(|c| *c.borrow_mut() = Some((base.clone(), names.iter().map(|s| s.to_string()).collect(), r.clone())));
                        r
                    }
                };
                for (i, n) in names.iter().enumerate() {
                    if let (true, Some(a), (Some(x), Some(y))) = (drain_mixed(n), v[i], ratio[i]) {
                        v[i] = Some(if y != 0.0 { a * (u + (1.0 - u) * x / y) } else { a + (1.0 - u) * (x - y) });
                    }
                }
            }
            finish(&mut v, flask_flags(base));
            // shortcut: a tree-only change reads its flask-free stats with the flasks on; the whole evaluation of the
            // state (rebase, results) reads them without. Evaluate without flasks here too if tree moves start to lean on them.
            flasks_on(&mut v);
            Ok(v)
        }
        Cand::Xml(x) | Cand::Open(x) => {
            if session.is_none() {
                *session = Some(Session::new(x.to_string(), game));
            }
            // (read like a node-list candidate's stats, so a warning list counts its entries)
            let full = names.iter().any(|n| matches!(*n, "SkillDPS" | "FullDPS" | "FullDotDPS"));
            let s = session.as_mut().unwrap();
            let mut text = std::borrow::Cow::Borrowed(x.as_str());
            let (mut v, likely) = s.eval_xml(&text, full, |env| (names.iter().map(|n| crate::stat_value(env, n)).collect::<Vals>(), crit_near_certain(env)))?;
            let mut crit_on = crit_flag_on(&text);
            // A build that all but always crits has crit recently; one that does not has not (re-checked on every text).
            if cr.is_some() && !matches!(cand, Cand::Open(_)) && likely != crit_on {
                crit_on = likely;
                text = std::borrow::Cow::Owned(set_crit_flag(&text, likely));
                v = s.eval_xml(&text, full, |env| names.iter().map(|n| crate::stat_value(env, n)).collect())?;
            }
            if fm.is_some() && !matches!(cand, Cand::Open(_)) {
                // The flasks the build sustains are the ones that count: turn the others off (and on the ones the text
                // left off that it sustains), evaluate again, until it settles.
                for _ in 0..3 {
                    let (have, want) = (flask_flags(&text), sustained_mask(&v));
                    if have == want {
                        break;
                    }
                    text = std::borrow::Cow::Owned(set_flask_flags(&text, want));
                    v = s.eval_xml(&text, full, |env| names.iter().map(|n| crate::stat_value(env, n)).collect())?;
                }
            }
            let sides: [(_, &dyn Fn(&str) -> bool); 2] = [(partial(&v, flask_flags(&text)), &mixed), (partial_map(&v, flask_flags(&text)), &map_stat)];
            for (ups, pick) in sides.into_iter().filter_map(|(p, pick)| p.map(|(_, ups)| (ups, pick))).filter(|_| !matches!(cand, Cand::Open(_))) {
                let a0 = v.clone();
                for (bit, u) in ups {
                    let w: Vals = s.eval_xml(&set_flask_flags(&text, flask_flags(&text) | bit), full, |env| names.iter().map(|n| crate::stat_value(env, n)).collect())?;
                    for (i, n) in names.iter().enumerate() {
                        if let (true, Some(a), Some(b), Some(cur)) = (pick(n), a0[i], w[i], v[i]) {
                            v[i] = Some(cur + u * (b - a));
                        }
                    }
                }
            }
            if let (Some(u), Some(off_text)) = (fed(&v).filter(|_| !matches!(cand, Cand::Open(_))), unfed(&text)) {
                let w: Vals = s.eval_xml(&off_text, full, |env| names.iter().map(|n| crate::stat_value(env, n)).collect())?;
                for (i, n) in names.iter().enumerate() {
                    if let (true, Some(a), Some(b)) = (drain_mixed(n), v[i], w[i]) {
                        v[i] = Some(b + u * (a - b));
                    }
                }
            }
            finish(&mut v, flask_flags(&text));
            if let Some(i) = cr {
                v[i] = Some(crit_on as u8 as f64);
            }
            flasks_on(&mut v);
            if !nf.is_empty() && flask_flags(&text) != 0 && !matches!(cand, Cand::Open(_)) {
                let inner: Vec<&str> = nf.iter().map(|&(i, _)| &names[i][NO_FLASK.len()..]).collect();
                let w: Vals = s.eval_xml(&set_flask_flags(&text, 0), false, |env| inner.iter().map(|n| crate::stat_value(env, n)).collect())?;
                for (&(i, _), x) in nf.iter().zip(w) {
                    v[i] = x;
                }
            }
            Ok(v)
        }
    }
}

/// The share of time a buff skill is up when it is cast again as soon as it can be: its duration over its cooldown, or
/// over duration + cooldown when the cooldown does not recover during the buff (Arcane Cloak: 3 s up, 4 s cooldown = 3/7).
/// `None` for a skill with no cooldown or one that can stay up. Base duration and cooldown, at the gem's top level.
fn buff_uptime(id: &str) -> Option<f64> {
    let ge = gd::gem_primary_effect(gd::game_data().gems.get(id)?)?;
    let dur = gd::stat_value(ge, 20.0, 0.0, "base_skill_effect_duration") / 1000.0;
    let cd = ge.levels.get(19).or(ge.levels.last()).and_then(|l| gd::level_num(l, "cooldown")).unwrap_or(0.0);
    if dur <= 0.0 || cd <= 0.0 {
        return None;
    }
    let u = if ge.stats.iter().any(|s| s == "display_this_skill_cooldown_does_not_recover_during_buff") { dur / (dur + cd) } else { dur / cd };
    (u < 1.0).then_some(u)
}

/// Where the first gem `name` in `text` has its tag (None when there is none, or it is off already).
fn gem_live(text: &str, name: &str) -> Option<(usize, usize)> {
    let open = format!("<Gem nameSpec=\"{name}\"");
    let i = text.find(&open)?;
    let end = i + text[i..].find('>')?;
    (!text[i..end].contains("enabled=\"false\"")).then_some((i, end))
}

/// The build text with the gem tag at `(i, end)` switched off.
fn gem_off(text: &str, (i, end): (usize, usize)) -> String {
    let tag = &text[i..end];
    let new = if tag.contains("enabled=\"true\"") { tag.replacen("enabled=\"true\"", "enabled=\"false\"", 1) } else { format!("{} enabled=\"false\"", tag.trim_end_matches('/')) + if tag.ends_with('/') { "/" } else { "" } };
    format!("{}{}{}", &text[..i], new, &text[end..])
}

/// A worker's last measured "gem off over gem on" ratio per stat, for one buff gem and one stat list.
/// A node-list base's own buff ratio (its stats without the buff over with it), held with the base so no other text
/// at the same address reads it.
struct Blend {
    base: Arc<String>,
    gem: String,
    names: Vec<String>,
    ratio: Vals,
}

/// `eval_one`, with each flickering buff skill the text has counted for its uptime: the stats are the uptime-weighted
/// mix of the build with it and without it (the solver's own bookkeeping stats stay as the full build has them). A
/// whole text is measured without the buff for real; a node list moves by its base's own ratio (a buff moves a build's
/// stats by a near-constant share), measured once per base, so whichever worker takes a candidate gives the same
/// numbers.
fn eval_blended(session: &mut Option<Session>, session_off: &mut Option<Session>, blend: &mut Option<Blend>, cand: &Cand, names: &[&str], flicker: &[(String, f64)]) -> Result<Vals, String> {
    let mut v = eval_one(session, cand, names)?;
    let text = match cand {
        Cand::Nodes { base, .. } => base.as_str(),
        Cand::Xml(x) | Cand::Open(x) => x.as_str(),
    };
    let Some((gem, span, u)) = flicker.iter().find_map(|(n, u)| Some((n, gem_live(text, n)?, *u))) else { return Ok(v) };
    let mix = |v: &mut Vals, ratio: &Vals| {
        for (i, n) in names.iter().enumerate() {
            if let (false, Some(a), Some(r)) = (n.starts_with("Solver."), v[i], ratio[i]) {
                v[i] = Some(a * (u + (1.0 - u) * r));
            }
        }
    };
    if let Cand::Nodes { base, .. } = cand {
        let hit = blend.as_ref().filter(|b| Arc::ptr_eq(&b.base, base) && b.gem == *gem && b.names.iter().map(|s| s.as_str()).eq(names.iter().copied())).map(|b| b.ratio.clone());
        let ratio = match hit {
            Some(r) => r,
            None => {
                let own = crate::session::nodes_in_xml(base)?;
                let on = eval_one(session, &Cand::Nodes { base: base.clone(), nodes: own.clone(), mastery: None, pin: Vec::new() }, names)?;
                let off = eval_one(session_off, &Cand::Nodes { base: Arc::new(gem_off(text, span)), nodes: own, mastery: None, pin: Vec::new() }, names)?;
                // (a stat the build has none of keeps no ratio; the buff then adds nothing to it in the mix either)
                let r: Vals = on.iter().zip(&off).map(|(a, b)| match (a, b) {
                    (Some(a), Some(b)) if *a != 0.0 => Some(b / a),
                    _ => None,
                }).collect();
                *blend = Some(Blend { base: base.clone(), gem: gem.clone(), names: names.iter().map(|s| s.to_string()).collect(), ratio: r.clone() });
                r
            }
        };
        mix(&mut v, &ratio);
        return Ok(v);
    }
    let off = Arc::new(gem_off(text, span));
    let cand_off = match cand {
        Cand::Nodes { nodes, mastery, pin, .. } => Cand::Nodes { base: off, nodes: nodes.clone(), mastery: *mastery, pin: pin.clone() },
        Cand::Xml(_) => Cand::Xml(off),
        Cand::Open(_) => Cand::Open(off),
    };
    let w = eval_one(session_off, &cand_off, names)?;
    for (i, n) in names.iter().enumerate() {
        if let (false, Some(a), Some(b)) = (n.starts_with("Solver."), v[i], w[i]) {
            v[i] = Some(u * a + (1.0 - u) * b);
        }
    }
    Ok(v)
}

/// `eval_blended`, and for the `Map:<stat>` names (Both mode's clear side) the same text on the mapping enemy: the
/// `Map:` entries read that second evaluation, everything else the first (the bossing one, which is the text's own).
fn eval_dual(session: &mut Option<Session>, session_off: &mut Option<Session>, blend: &mut Option<Blend>, map: &mut (Option<Session>, Option<Session>, Option<Blend>), cand: &Cand, names: &[&str], flicker: &[(String, f64)]) -> Result<Vals, String> {
    if !names.iter().any(|n| n.starts_with(mode::MAP)) {
        return eval_blended(session, session_off, blend, cand, names, flicker);
    }
    let plain: Vec<&str> = names.iter().map(|n| n.strip_prefix(mode::MAP).unwrap_or(n)).collect();
    let mut v = eval_blended(session, session_off, blend, cand, &plain, flicker)?;
    let mapped = |x: &Arc<String>| Arc::new(mode::mapping_text(x));
    let cand_map = match cand {
        Cand::Nodes { base, nodes, mastery, pin } => Cand::Nodes { base: mapped(base), nodes: nodes.clone(), mastery: *mastery, pin: pin.clone() },
        Cand::Xml(x) => Cand::Xml(mapped(x)),
        Cand::Open(x) => Cand::Open(mapped(x)),
    };
    let w = eval_blended(&mut map.0, &mut map.1, &mut map.2, &cand_map, &plain, flicker)?;
    for (i, n) in names.iter().enumerate() {
        if n.starts_with(mode::MAP) {
            v[i] = w[i];
        }
    }
    Ok(v)
}

impl Pool {
    /// `flicker`: buff skills that are not up all the time, `(gem name, uptime)`; a build that has one is scored as the
    /// uptime-weighted mix of itself with and without the skill.
    /// `limit_only`: stats only limits read, evaluated without the flasks that are up part of the time.
    fn new(threads: usize, flicker: Arc<Vec<(String, f64)>>, limit_only: Arc<Vec<String>>) -> Pool {
        let (tx, rx) = mpsc::channel::<Task>();
        let rx = Arc::new(Mutex::new(rx));
        let mut handles = Vec::new();
        for t in 0..threads {
            let rx = rx.clone();
            let flicker = flicker.clone();
            let limit_only = limit_only.clone();
            if let Ok(h) = std::thread::Builder::new().name(format!("solve-{t}")).stack_size(WORKER_STACK).spawn(move || {
                crate::set_item_cache_max(256);
                LIMIT_ONLY.with(|l| *l.borrow_mut() = limit_only.to_vec());
                // (text rules read unread lines in solver evaluations only, solver_clear.rs)
                pom_engine::modparser::text_rules::set_active(true);
                let mut session: Option<Session> = None;
                let mut session_off: Option<Session> = None;
                let mut blend: Option<Blend> = None;
                // (Both: the same texts on the mapping enemy, for the `Map:` stats)
                let mut map_sessions: (Option<Session>, Option<Session>, Option<Blend>) = (None, None, None);
                loop {
                    let task = match rx.lock() {
                        Ok(r) => match r.recv() {
                            Ok(t) => t,
                            Err(_) => return,
                        },
                        Err(_) => return,
                    };
                    if task.cancel.load(Ordering::Relaxed) {
                        let _ = task.tx.send((task.i, None));
                        continue;
                    }
                    let names: Vec<&str> = task.names.iter().map(|s| s.as_str()).collect();
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| eval_dual(&mut session, &mut session_off, &mut blend, &mut map_sessions, &task.cand, &names, &flicker)));
                    let v = match r {
                        Ok(Ok(v)) => Some(v),
                        Ok(Err(_)) => None,
                        Err(_) => {
                            session = None;
                            session_off = None;
                            blend = None;
                            map_sessions = (None, None, None);
                            None
                        }
                    };
                    let _ = task.tx.send((task.i, v));
                }
            }) {
                handles.push(h);
            }
        }
        let threads = handles.len();
        Pool { tx: Some(tx), handles, threads }
    }

    /// One batch to the workers.
    fn send(&self, cands: Vec<Cand>, names: &Arc<Vec<String>>, cancel: &Arc<AtomicBool>) -> Vec<Option<Vals>> {
        let n = cands.len();
        let (rtx, rrx) = mpsc::channel();
        if let Some(tx) = &self.tx {
            for (i, cand) in cands.into_iter().enumerate() {
                let _ = tx.send(Task { i, cand, names: names.clone(), tx: rtx.clone(), cancel: cancel.clone() });
            }
        }
        drop(rtx);
        let mut out = vec![None; n];
        for (i, v) in rrx {
            out[i] = v;
        }
        out
    }

    fn eval(&self, cands: Vec<Cand>, names: &Arc<Vec<String>>, cancel: &Arc<AtomicBool>) -> Vec<Option<Vals>> {
        self.send(cands, names, cancel)
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.tx = None;
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Build text helpers

/// `text` with the Withered stack count set to `n` (none below one stack).
fn with_wither(text: &str, n: f64) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"<Input name="multiplierWitheredStackCount" number="[^"]*"/>"#).unwrap());
    let t = re.replace_all(text, "").into_owned();
    if n < 1.0 {
        return t;
    }
    t.replacen("</Config>", &format!("<Input name=\"multiplierWitheredStackCount\" number=\"{n}\"/></Config>"), 1)
}

/// `xml` with attribute `name` of the first `<tag ...>` set.
fn set_tag_attr(xml: &str, tag: &str, name: &str, value: &str) -> Result<String, String> {
    let open = format!("<{tag}");
    let mut from = 0;
    let start = loop {
        let i = from + xml[from..].find(&open).ok_or_else(|| format!("build has no <{tag}>"))?;
        let next = xml[i + open.len()..].chars().next().unwrap_or(' ');
        if next == ' ' || next == '>' || next == '/' || next == '\t' || next == '\n' || next == '\r' {
            break i;
        }
        from = i + open.len();
    };
    let end = start + xml[start..].find('>').ok_or("bad tag")?;
    let t = &xml[start..end];
    let key = format!(" {name}=\"");
    let new_tag = match t.find(&key) {
        Some(i) => {
            let vs = i + key.len();
            let ve = vs + t[vs..].find('"').ok_or("bad attribute")?;
            format!("{}{}{}", &t[..vs], crate::edit::esc(value), &t[ve..])
        }
        None => {
            let cut = if t.ends_with('/') { t.len() - 1 } else { t.len() };
            format!("{} {name}=\"{}\"{}", &t[..cut], crate::edit::esc(value), &t[cut..])
        }
    };
    Ok(format!("{}{}{}", &xml[..start], new_tag, &xml[end..]))
}

/// The build text without the player's config switches. They describe the open build's setup, and a new setup that
/// cannot meet them was scored on them (Bloodlust with "enemy is bleeding", 100 rage on a class without rage): kept
/// are the enemy, bandit, pantheon and act penalty.
fn player_config_off(xml: &str) -> Result<String, String> {
    let keep = |n: &str| n.starts_with("enemy") || matches!(n, "bandit" | "pantheonMajorGod" | "pantheonMinorGod" | "resistancePenalty");
    let names: Vec<String> = {
        let doc = roxmltree::Document::parse(xml).map_err(|e| format!("build xml: {e}"))?;
        doc.descendants().filter(|n| n.has_tag_name("Config")).flat_map(|c| c.descendants().filter(|n| n.has_tag_name("Input"))).filter_map(|n| n.attribute("name")).filter(|n| !keep(n)).map(String::from).collect()
    };
    let mut x = xml.to_string();
    for n in names {
        x = set_config_input(&x, &n, None)?;
    }
    Ok(x)
}

fn tag_attr(xml: &str, tag: &str, name: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let n = doc.descendants().find(|n| n.has_tag_name(tag))?;
    n.attribute(name).map(|s| s.to_string())
}

/// A new, empty build (the app's `blankBuildXml`), for a solve that starts from nothing.
pub fn blank_build_xml(level: i64) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
	<Build level="{level}" targetVersion="3_0" bandit="None" className="Scion" ascendClassName="None" mainSocketGroup="1" viewMode="TREE" pantheonMajorGod="None" pantheonMinorGod="None">
	</Build>
	<Import />
	<Calcs />
	<Skills sortGemsByDPSField="CombinedDPS" activeSkillSet="1" sortGemsByDPS="true" defaultGemQuality="nil" defaultGemLevel="nil">
		<SkillSet id="1" />
	</Skills>
	<Tree activeSpec="1">
		<Spec treeVersion="3_29" classId="0" ascendClassId="0" masteryEffects="" nodes="">
		</Spec>
	</Tree>
	<Notes>

	</Notes>
	<TreeView searchStr="" zoomY="0" showHeatMap="nil" zoomLevel="3" showStatDifferences="true" zoomX="0" />
	<Items activeItemSet="1" useSecondWeaponSet="nil">
		<ItemSet useSecondWeaponSet="nil" id="1" />
	</Items>
	<Config />
</PathOfBuilding>
"#
    )
}

const MK: [&str; 8] = ["@@SOLVE_SKILLS@@", "@@SOLVE_ITEMS@@", "@@SOLVE_NODES@@", "@@SOLVE_MASTERY@@", "@@SOLVE_SOCKETS@@", "@@SOLVE_BANDIT@@", "@@SOLVE_CONFIG@@", "@@SOLVE_BLOODLINE@@"];

/// A class's build text cut at the parts a candidate changes: socket groups, items, the node list, mastery choices,
/// tree sockets and the bandit. `parts.len() == holes.len() + 1`; holes index `MK`.
struct Template {
    parts: Vec<String>,
    holes: Vec<usize>,
    len: usize,
}

/// The template of `xml` and its `<Skills>` start tag (active skill set 1).
fn make_template(xml: &str) -> Result<(Template, String), String> {
    let mut x = set_tag_attr(xml, "Build", "mainSocketGroup", "1")?;
    x = set_config_input(&x, "bandit", Some(&ConfigValue::Str(MK[5].into())))?;
    x = crate::treeedit::set_spec_attr(&x, "nodes", MK[2])?;
    x = crate::treeedit::set_spec_attr(&x, "masteryEffects", MK[3])?;
    x = crate::treeedit::set_spec_attr(&x, "secondaryAscendClassId", MK[7])?;
    // (makes sure the active spec has a <Sockets>)
    x = crate::edit::set_jewel_socket(&x, 0, 0)?;
    // Config the setup decides (last, so it wins over the build's own input of the same name).
    if x.matches("</Config>").count() != 1 {
        return Err("build has no single <Config>".into());
    }
    x = x.replacen("</Config>", &format!("{}</Config>", MK[6]), 1);
    let (open, mut cuts) = {
        let doc = roxmltree::Document::parse(&x).map_err(|e| format!("xml: {e}"))?;
        let root = doc.root_element();
        fn child<'a, 'i>(n: roxmltree::Node<'a, 'i>, t: &str) -> Option<roxmltree::Node<'a, 'i>> {
            n.children().find(|c| c.has_tag_name(t))
        }
        let skills = child(root, "Skills").ok_or("build has no <Skills>")?;
        let items = child(root, "Items").ok_or("build has no <Items>")?;
        let tree = child(root, "Tree").ok_or("build has no <Tree>")?;
        let active = tree.attribute("activeSpec").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
        let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
        let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("build has no <Spec>")?;
        let sockets = child(*spec, "Sockets").ok_or("spec has no <Sockets>")?;
        let sr = skills.range();
        let open_end = sr.start + x[sr.start..].find('>').ok_or("bad <Skills>")? + 1;
        let mut open = x[sr.start..open_end].to_string();
        if open.ends_with("/>") {
            open = format!("{}>", &open[..open.len() - 2]);
        }
        open = set_tag_attr(&open, "Skills", "activeSkillSet", "1")?;
        let mut cuts = vec![(sr, MK[0]), (items.range(), MK[1]), (sockets.range(), MK[4])];
        // Upstream refuses a blank <URL> ("element missing content"); the nodes= attribute already carries the tree.
        for u in doc.descendants().filter(|n| n.has_tag_name("URL") && n.text().map_or(true, |t| t.trim().is_empty())) {
            cuts.push((u.range(), ""));
        }
        (open, cuts)
    };
    cuts.sort_by_key(|(r, _)| std::cmp::Reverse(r.start));
    for (r, m) in cuts {
        x.replace_range(r, m);
    }
    let mut found: Vec<(usize, usize)> = Vec::new();
    for (k, m) in MK.iter().enumerate() {
        let p = x.find(m).ok_or_else(|| format!("template: {m} missing"))?;
        found.push((p, k));
    }
    found.sort_unstable();
    let (mut parts, mut holes, mut at) = (Vec::new(), Vec::new(), 0);
    for (p, k) in found {
        parts.push(x[at..p].to_string());
        holes.push(k);
        at = p + MK[k].len();
    }
    parts.push(x[at..].to_string());
    let len = parts.iter().map(|p| p.len()).sum();
    Ok((Template { parts, holes, len }, open))
}

fn gem_name(id: &str) -> String {
    // (an aura linked to Generosity is "<aura id>+<Generosity id>")
    if id.contains('+') {
        return id.split('+').map(gem_name).collect::<Vec<_>>().join(" + ");
    }
    gd::game_data().gems.get(id).and_then(|g| g.name.clone()).unwrap_or_else(|| id.to_string())
}

/// The gem a utility entry stands for (an aura linked to Generosity counts as the aura).
fn util_root(id: &str) -> &str {
    id.split('+').next().unwrap_or(id)
}

/// Skills the gear grants ("Grants Level 10 <skill> Skill"), lower case.
fn granted_skills(gear: &Gear) -> Vec<String> {
    gear.pieces.iter().flatten().flat_map(|p| items::active_lines(&p.xml)).filter_map(|l| {
        let l = l.trim().to_lowercase();
        let rest = l.strip_prefix("grants level ")?;
        let (_, name) = rest.split_once(' ')?;
        name.strip_suffix(" skill").map(String::from)
    }).collect()
}

/// A utility set a player can run: one banner at a time (placing one spends all Valour and ends the last), and no gem
/// for a skill an item already grants (`granted`, lower case).
fn utils_ok(utils: &[&'static str], granted: &[String]) -> bool {
    let tag = |u: &str, k: &str| gd::game_data().gems.get(util_root(u)).is_some_and(|g| g.tags.get(k).copied().unwrap_or(false));
    utils.iter().filter(|u| tag(u, "banner")).count() <= 1 && !utils.iter().any(|u| granted.contains(&gem_name(util_root(u)).to_lowercase()))
}

// ---------------------------------------------------------------------------------------------------------------
// Gem catalog

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Support,
    Aura,
    Curse,
    Guard,
    Movement,
    /// Warcries.
    Utility,
    /// Skills that debuff the enemy for the main skill (Wither on a totem, Plague Bearer).
    Debuff,
    /// Offerings (buff the minions; need corpses).
    MinionBuff,
    /// Permanent minions that buff their owner (gem tag "golem"); as many as the build's golem limit.
    Golem,
    /// A guard skill or curse linked to the support that fires it by itself (Cast when Damage Taken, Blasphemy, Mark On Hit):
    /// set and forget, not pressed by hand. Its root gem's kind says which slot (guard, curse) it fills.
    Auto,
    Other,
}

struct GemInfo {
    id: &'static str,
    name: String,
    kind: Kind,
}

fn gem_kind(g: &'static pom_engine::data::gems::GemData, support: bool) -> Kind {
    let t = |k: &str| g.tags.get(k).copied().unwrap_or(false);
    if support {
        Kind::Support
    } else if t("mine") || t("trap") || t("totem") {
        // (Pyroclast Mine carries the aura tag, but a mine is thrown by hand: not a set-and-forget aura)
        Kind::Other
    } else if (t("aura") || t("herald")) && gd::gem_primary_effect(g).is_some_and(|ge| gd::skill_types(ge).contains(&pom_skills::skill_type::HAS_RESERVATION)) {
        Kind::Aura
    } else if t("aura") || t("herald") {
        // (a buff that comes from using the skill, Smite's or a banner's, reserves nothing: pressed like a warcry)
        Kind::Utility
    } else if t("curse") {
        Kind::Curse
    } else if t("guard") {
        Kind::Guard
    } else if t("movement") || t("travel") || t("blink") {
        Kind::Movement
    } else if t("warcry") {
        Kind::Utility
    } else {
        Kind::Other
    }
}

/// A skill cast only to debuff the enemy for the main skill (Wither): its skill data's `debuff` flag, no damage of its own,
/// not a curse, mark or brand (those have their own slot), and a totem or trigger can cast it for the player.
fn debuff_skill(gem: &pom_engine::data::gems::GemData, ge: &pom_engine::data::gems::GrantedEffect) -> bool {
    use pom_skills::skill_type as ty;
    let t = |k: &str| gem.tags.get(k).copied().unwrap_or(false);
    let types = gd::skill_types(ge);
    let debuff = gd::extra(ge, "baseMods").and_then(|v| v.as_array()).is_some_and(|a| a.iter().any(|m| m.get("value").and_then(|v| v.get("key")).and_then(|k| k.as_str()) == Some("debuff")));
    debuff && !t("curse") && !t("mark") && !t("brand") && !types.contains(&ty::DAMAGE) && !types.contains(&ty::DAMAGE_OVER_TIME) && (types.contains(&ty::TOTEMABLE) || types.contains(&ty::TRIGGERABLE))
}

/// A gem that inflicts Withered by itself (its `active_skill_withered_base_duration_ms` stat): its stacks go in the config.
fn withering(id: &str) -> bool {
    gd::game_data().gems.get(id).and_then(gd::gem_primary_effect).and_then(|ge| gd::extra(ge, "constantStats")).and_then(|v| v.as_array()).is_some_and(|a| a.iter().any(|s| s.get(0usize).and_then(|x| x.as_str()) == Some("active_skill_withered_base_duration_ms")))
}

/// A support whose charges come from the mana its skill spends (its `*_charge_on_mana_spent_%` constant stat:
/// Inspiration's `gain_righteous_charge_on_mana_spent_%`, sup_str.lua 4629).
fn mana_spent_charges(id: &str) -> bool {
    gd::game_data().gems.get(id).and_then(gd::gem_primary_effect).and_then(|ge| gd::extra(ge, "constantStats")).and_then(|v| v.as_array()).is_some_and(|a| a.iter().any(|s| s.get(0usize).and_then(|x| x.as_str()).is_some_and(|k| k.contains("_charge_on_mana_spent"))))
}

/// The support that has a totem cast a spell for the player: its `base_skill_is_totemified` stat, the Spell type required.
fn spell_totem() -> Option<&'static str> {
    gd::sorted_gems().iter().find(|&&(k, g)| {
        !["AltX", "AltY", "AltZ"].iter().any(|s| k.ends_with(s))
            && gd::gem_primary_effect(g).is_some_and(|ge| gd::is_support(ge) && !gd::extra(ge, "hideFromGemList").and_then(|v| v.as_bool()).unwrap_or(false) && ge.stats.iter().any(|s| s == "base_skill_is_totemified") && gd::skill_type_expr(ge, "requireSkillTypes").contains(&pom_skills::skill_type::SPELL))
    }).map(|&(k, _)| k)
}

/// Gems a character of `level` can use: not hidden, legacy, Vaal or transfigured (unless the goal names them; awakened and
/// exceptional supports are in, their level requirement keeps them out below 72), first level's requirement met, not banned.
fn catalog(level: i64, goal: &Goal) -> Vec<GemInfo> {
    let matches = |list: &[String], id: &str, name: &str| list.iter().any(|x| x.eq_ignore_ascii_case(id) || x.eq_ignore_ascii_case(name));
    let mut out = Vec::new();
    for (key, gem) in gd::sorted_gems() {
        let Some(ge) = gd::gem_primary_effect(gem) else { continue };
        let name = gem.name.clone().or_else(|| ge.name.clone()).unwrap_or_default();
        if matches(&goal.gems.ban, key, &name) {
            continue;
        }
        let required = matches(&goal.gems.require, key, &name);
        let hidden = gd::extra(ge, "hideFromGemList").and_then(|v| v.as_bool()).unwrap_or(false);
        let legacy = gd::extra(ge, "legacy").and_then(|v| v.as_bool()).unwrap_or(false);
        let transfigured = ["AltX", "AltY", "AltZ"].iter().any(|s| key.ends_with(s));
        // (Ambush: its crit buff lasts one attack per cooldown in the game, upstream counts it on every hit)
        if !required && (hidden || legacy || gem.vaal_gem || transfigured || name == "Ambush") {
            continue;
        }
        if ge.levels.first().and_then(|l| l.level_requirement).unwrap_or(1.0) > level as f64 {
            continue;
        }
        // An awakened or exceptional gem the market does not sell is out below the tier that takes unpriced items.
        let bought = ["awakened", "exceptional"].iter().any(|t| gem.tags.get(*t).copied().unwrap_or(false));
        if bought && !required && Wealth::gem_price(&name).is_none() && goal.wealth.is_some_and(|w| Wealth::of_price(None) > w) {
            continue;
        }
        let support = gd::is_support(ge);
        // A mark curses one enemy: while mapping it is not on the pack the build fights, so the solver does not add one.
        let mark = !support && gem.tags.get("mark").copied().unwrap_or(false);
        if mark && !required && goal.assume.mode() == PlayMode::Mapping && !name.eq_ignore_ascii_case(goal.skill.trim()) {
            continue;
        }
        let kind = if !support && debuff_skill(gem, ge) {
            Kind::Debuff
        } else if !support && name.ends_with(" Offering") {
            Kind::MinionBuff
        } else if !support && gem.tags.get("golem").copied().unwrap_or(false) {
            Kind::Golem
        } else {
            gem_kind(gem, support)
        };
        out.push(GemInfo { id: key, name, kind });
    }
    out
}

/// The gem ids of the build's enabled gems: the active skill set's enabled groups only (`SkillsTabClass:LoadSkill`: a group
/// is on when `enabled` or `active` is "true"; a gem unless `enabled="false"`).
fn own_gems(xml: &str) -> HashSet<&'static str> {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return HashSet::default() };
    let Some(skills) = crate::edit::elements(doc.root_element(), "Skills").next() else { return HashSet::default() };
    crate::edit::active_socket_groups(skills)
        .into_iter()
        .filter(|g| g.attribute("enabled") == Some("true") || g.attribute("active") == Some("true"))
        .flat_map(|g| g.children().filter(|n| n.has_tag_name("Gem") && n.attribute("enabled") != Some("false")))
        .filter_map(|n| n.attribute("nameSpec"))
        .filter_map(find_gem)
        .collect()
}

/// The gem id for a name or id (active gems first).
fn find_gem(s: &str) -> Option<&'static str> {
    let all = gd::sorted_gems();
    if let Some((k, _)) = all.iter().find(|(k, _)| k.eq_ignore_ascii_case(s)) {
        return Some(k);
    }
    let named = |support: bool| {
        all.iter().find(|(_, g)| {
            g.name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(s)) && gd::gem_primary_effect(g).is_some_and(|ge| gd::is_support(ge) == support && !gd::extra(ge, "hideFromGemList").and_then(|v| v.as_bool()).unwrap_or(false))
        })
    };
    named(false).or_else(|| named(true)).map(|(k, _)| *k)
}

// ---------------------------------------------------------------------------------------------------------------
// Tree context per class/ascendancy

struct ClassCtx {
    label: String,
    class_id: i64,
    asc_id: i64,
    class_name: String,
    asc_name: Option<String>,
    /// The base build with this class, ascendancy and an empty tree (no gems yet).
    xml: String,
    paths: std::rc::Rc<TreePaths>,
    adj: HashMap<i64, Vec<i64>>,
    root: i64,
    asc_root: Option<i64>,
    asc_internal: Option<String>,
    /// Bloodlines (the tree's secondary ascendancies): internal name -> (secondaryAscendClassId, start node).
    blood: HashMap<String, (i64, i64)>,
    /// Passive points an allocated node grants ("Grants N Passive Skill Points").
    granted: HashMap<i64, usize>,
    tpl: Template,
    /// Ailments the enemy is assumed to have in this context (`AILMENTS` bits): one lead's, not the whole solve's.
    ailments: u8,
}

/// The enemy ailments a lead may assume (bit k = `AILMENTS[k]`): config input, label, the main skill's DPS stat.
const AILMENTS: [(&str, &str, &str); 3] = [("conditionEnemyPoisoned", "Poisoned", "PoisonDPS"), ("conditionEnemyIgnited", "Ignited", "IgniteDPS"), ("conditionEnemyBleeding", "Bleeding", "BleedDPS")];

fn adjacency(paths: &TreePaths) -> HashMap<i64, Vec<i64>> {
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::default();
    for (&id, n) in &paths.nodes {
        for &l in &n.linked {
            if paths.nodes.contains_key(&l) && l != id {
                let e = adj.entry(id).or_default();
                if !e.contains(&l) {
                    e.push(l);
                }
                let e = adj.entry(l).or_default();
                if !e.contains(&id) {
                    e.push(id);
                }
            }
        }
    }
    for v in adj.values_mut() {
        v.sort_unstable();
    }
    adj
}

impl ClassCtx {
    fn kind(&self, id: i64) -> &str {
        self.paths.nodes.get(&id).map(|n| n.kind.as_str()).unwrap_or("")
    }
    fn is_main(&self, id: i64) -> bool {
        self.paths.nodes.get(&id).is_some_and(|n| n.ascendancy.is_none() && n.kind != "ClassStart" && n.kind != "AscendClassStart")
    }
    /// A node of the context's ascendancy or of a bloodline (both spend ascendancy points).
    fn is_asc(&self, id: i64) -> bool {
        self.paths.nodes.get(&id).is_some_and(|n| n.ascendancy.as_ref().is_some_and(|a| Some(a) == self.asc_internal.as_ref() || self.blood.contains_key(a)) && n.kind != "AscendClassStart")
    }
    fn blood_of(&self, id: i64) -> Option<(i64, i64)> {
        self.paths.nodes.get(&id)?.ascendancy.as_ref().and_then(|a| self.blood.get(a)).copied()
    }
    /// The bloodline the nodes are in: (secondaryAscendClassId, start node). One per build.
    fn blood_in(&self, nodes: &[i64]) -> Option<(i64, i64)> {
        nodes.iter().find_map(|&n| self.blood_of(n))
    }
    /// The ascendancy search's starts: the ascendancy's, and the allocated bloodline's (every bloodline's while none is).
    fn asc_roots(&self, alloc: &HashSet<i64>) -> Vec<i64> {
        let mut v: Vec<i64> = self.asc_root.into_iter().collect();
        match alloc.iter().find_map(|&n| self.blood_of(n)) {
            Some((_, s)) => v.push(s),
            None => v.extend(self.blood.values().map(|b| b.1)),
        }
        v.sort_unstable();
        v
    }
    /// The main tree's starts: the class start, and every allocated ascendancy node linked straight into the main tree
    /// (an Ascendant's extra start points), the way upstream lets a path leave an allocated ascendancy node.
    fn main_roots(&self, alloc: &HashSet<i64>) -> Vec<i64> {
        let mut v: Vec<i64> = alloc.iter().copied().filter(|&n| self.is_asc(n) && self.adj.get(&n).is_some_and(|l| l.iter().any(|&m| self.is_main(m)))).collect();
        v.sort_unstable();
        v.insert(0, self.root);
        v
    }
    /// A node the search may allocate in the main tree.
    fn allowed_main(&self, id: i64) -> bool {
        self.paths.nodes.get(&id).is_some_and(|n| n.ascendancy.is_none() && !matches!(n.kind.as_str(), "ClassStart" | "AscendClassStart") && n.other_options.is_empty() && id < 65536 && !n.leap)
    }
    fn allowed_asc(&self, id: i64) -> bool {
        self.is_asc(id) && self.paths.nodes.get(&id).is_some_and(|n| n.other_options.is_empty())
    }
    /// A multiple-choice option (tree data isMultipleChoiceOption, read through its siblings: every choice has two or
    /// more): one pick of the notable it hangs from, which costs no point.
    fn is_option(&self, id: i64) -> bool {
        self.paths.nodes.get(&id).is_some_and(|n| !n.other_options.is_empty())
    }
    /// The picks of ascendancy notable `id` (empty for a notable without a choice).
    fn options_of(&self, id: i64) -> Vec<i64> {
        self.adj.get(&id).map_or(Vec::new(), |l| l.iter().copied().filter(|&o| self.is_asc(o) && self.is_option(o)).collect())
    }

    /// BFS from the allocated set over allowed nodes: each reached node's distance and predecessor. A mastery is only an
    /// endpoint.
    fn bfs(&self, alloc: &HashSet<i64>, asc: bool) -> HashMap<i64, (usize, i64)> {
        self.bfs_avoiding(alloc, asc, &HashSet::default())
    }

    /// `bfs` that never walks through `avoid` (passives the build gave back: a path goes around them or not at all).
    fn bfs_avoiding(&self, alloc: &HashSet<i64>, asc: bool, avoid: &HashSet<i64>) -> HashMap<i64, (usize, i64)> {
        let roots = if asc { self.asc_roots(alloc) } else { self.main_roots(alloc) };
        if roots.is_empty() {
            return HashMap::default();
        }
        let mut seen: HashMap<i64, (usize, i64)> = HashMap::default();
        let mut q: VecDeque<i64> = VecDeque::new();
        let mut srcs: Vec<i64> = alloc.iter().copied().filter(|&id| if asc { self.is_asc(id) } else { self.is_main(id) }).collect();
        srcs.extend(roots.iter().copied());
        srcs.sort_unstable();
        srcs.dedup();
        let mut visited: HashSet<i64> = srcs.iter().copied().collect();
        for s in srcs {
            if !roots.contains(&s) && self.kind(s) == "Mastery" {
                continue;
            }
            q.push_back(s);
        }
        while let Some(u) = q.pop_front() {
            let d = if visited.contains(&u) && !seen.contains_key(&u) { 0 } else { seen[&u].0 };
            if d > 0 && self.kind(u) == "Mastery" {
                continue;
            }
            for &v in self.adj.get(&u).map_or(&[][..], |v| v.as_slice()) {
                if visited.contains(&v) {
                    continue;
                }
                let ok = if asc { self.allowed_asc(v) } else { self.allowed_main(v) };
                if !ok || avoid.contains(&v) {
                    continue;
                }
                visited.insert(v);
                seen.insert(v, (d + 1, u));
                q.push_back(v);
            }
        }
        seen
    }

    /// Steiner tree from the class start (and the extra starts `alloc` opens, see `main_roots`) over `terminals` (main
    /// tree), same routine as smart pathing; None if one is unreachable. The extra starts are not in the result.
    fn tree_for(&self, terminals: &[i64], alloc: &[i64]) -> Option<HashSet<i64>> {
        let roots = self.main_roots(&alloc.iter().copied().collect());
        let mut t = crate::optimizer::steiner_from(&self.paths, &self.adj, &roots, terminals, 0, None, &HashSet::default())?;
        t.retain(|n| *n == self.root || !roots.contains(n));
        Some(t)
    }

    fn path_to(&self, reach: &HashMap<i64, (usize, i64)>, target: i64) -> Vec<i64> {
        let mut out = Vec::new();
        let mut cur = target;
        while let Some(&(_, p)) = reach.get(&cur) {
            out.push(cur);
            cur = p;
        }
        out
    }

    /// Nodes of `nodes` still joined to the class start (main), or to the ascendancy or a bloodline start. The main
    /// tree also starts from the ascendancy nodes in `nodes` that open one (`main_roots`).
    fn connected(&self, nodes: &HashSet<i64>, asc: bool) -> HashSet<i64> {
        let roots: Vec<i64> = if asc { self.asc_root.into_iter().chain(self.blood.values().map(|b| b.1)).collect() } else { self.main_roots(nodes) };
        let mut seen: HashSet<i64> = roots.iter().copied().collect();
        let mut stack = roots.clone();
        while let Some(u) = stack.pop() {
            if !roots.contains(&u) && self.kind(u) == "Mastery" {
                continue;
            }
            for &v in self.adj.get(&u).map_or(&[][..], |v| v.as_slice()) {
                if nodes.contains(&v) && seen.insert(v) {
                    stack.push(v);
                }
            }
        }
        seen
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Search state

#[derive(Clone)]
struct State {
    class: usize,
    /// Allocated main and ascendancy nodes (no start nodes).
    nodes: Vec<i64>,
    masteries: Vec<(i64, i64)>,
    main: Vec<&'static str>,
    utils: Vec<&'static str>,
    bandit: String,
    gear: Arc<Gear>,
    /// The text node-list candidates are evaluated against (re-made when anything but the node list changes).
    base: Arc<String>,
    vals: Vals,
    score: f64,
    viol: f64,
    /// The expert parts this state was realized from, each with the beam gain it measured (empty for greedy states).
    parts: Arc<Vec<(String, f64)>>,
    /// Withered stacks the Wither totem keeps up (15 until `rebase` has read the build's own Wither group).
    wither: f64,
    /// The lead this state grew from (`Solver::book`, solver_leads.rs).
    lead: Option<u16>,
    /// Utility gems held below the character's gem level (solver_finish.rs: a lower level needs fewer attributes).
    gem_levels: Vec<(&'static str, u32)>,
}

struct Entry {
    /// The record id: the sha256 of the result XML. Fixed by the content, so it survives any re-sort.
    id: String,
    xml: Arc<String>,
    vals: Vals,
    score: f64,
    viol: f64,
    label: String,
    class_name: String,
    asc_name: Option<String>,
    points: usize,
    asc_points: usize,
    main: Vec<String>,
    utils: Vec<String>,
    bandit: String,
    gear: Arc<Gear>,
    /// The open build as it was (always listed).
    start: bool,
    parts: Arc<Vec<(String, f64)>>,
    /// Config switches the result sets, and close calls offered with what each adds (solver_config.rs).
    switches: Vec<config::On>,
    offers: Vec<(config::On, f64, String)>,
    /// Boss skill presets that one-shot the result (info only; bossing goals).
    boss_chips: Vec<String>,
    /// The lead's label ("poison · The Scourge · Hierophant"), when the result grew from one.
    lead: Option<String>,
    /// The pack-clear breakdown line (mapping clear target only, solver_clear.rs).
    clear: Option<String>,
    /// The independent re-check under conservative config (solver_recheck.rs); None for the open build.
    honest: Option<recheck::Check>,
}

/// sha256 of a result XML, lowercase hex: the result's `xmlHash` and its record id.
pub fn xml_hash(xml: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(xml.as_bytes()))
}

pub struct Shared {
    pub snapshot: Value,
    pub results: Vec<Arc<String>>,
    /// Every result ever published, by record id; a later re-sort or a worse round never drops one.
    pub by_id: std::collections::HashMap<String, Arc<String>>,
    pub version: u64,
    pub done: bool,
}

pub struct Handle {
    pub shared: Arc<(Mutex<Shared>, std::sync::Condvar)>,
    pub cancel: Arc<AtomicBool>,
    /// Leads the player's AI sent into the running solve (`add_leads`); a plan run picks them up between lead rounds.
    pub inbox: Arc<Mutex<Vec<Value>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Handle {
    /// Waits up to `budget_ms` for a newer snapshot (or the end) and returns the latest.
    pub fn step(&self, budget_ms: u64, seen: u64) -> (Value, u64) {
        let (m, cv) = &*self.shared;
        let deadline = Instant::now() + std::time::Duration::from_millis(budget_ms);
        let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
        while g.version <= seen && !g.done {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            g = cv.wait_timeout(g, deadline - now).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
        }
        (g.snapshot.clone(), g.version)
    }
    /// A published record's build text by its id (`xml_hash`); stays readable for the life of the solve.
    pub fn result_xml_by_id(&self, id: &str) -> Option<String> {
        let g = self.shared.0.lock().unwrap_or_else(|e| e.into_inner());
        g.by_id.get(id).map(|x| x.to_string())
    }
    pub fn result_xml(&self, index: usize) -> Option<String> {
        let g = self.shared.0.lock().unwrap_or_else(|e| e.into_inner());
        g.results.get(index).map(|x| x.to_string())
    }
    pub fn cancel(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
    /// Queues plan leads (a JSON array of `SolvePlanLead`) for the running solve. Returns how many were queued and
    /// whether the solve still runs (a finished solve never reads them).
    pub fn add_leads(&self, leads_json: &str) -> Result<Value, String> {
        let leads: Vec<Value> = serde_json::from_str(leads_json).map_err(|e| format!("leads json: {e}"))?;
        let n = leads.len();
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).extend(leads);
        let running = !self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).done;
        Ok(json!({ "queued": n, "running": running }))
    }
    pub fn join(&mut self) {
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        // (the solve thread notices within one batch and exits on its own; it is not joined here so a drop never blocks)
    }
}

/// Default worker count: every core but two.
pub fn default_threads() -> usize {
    std::thread::available_parallelism().map(|c| c.get()).unwrap_or(1).saturating_sub(2).max(1)
}

/// 1.1M, 210k, 950.
fn short_num(x: f64) -> String {
    if x >= 1e6 {
        format!("{:.1}M", x / 1e6)
    } else if x >= 1e3 {
        format!("{:.0}k", x / 1e3)
    } else {
        format!("{x:.0}")
    }
}

/// Starts a solve of `goal` on the build text `xml` in the background.
pub fn start(xml: String, goal_json: &str, options_json: &str) -> Result<Handle, String> {
    let goal: Goal = serde_json::from_str(goal_json).map_err(|e| format!("goal json: {e}"))?;
    let opts: Options = if options_json.trim().is_empty() { Options::default() } else { serde_json::from_str(options_json).map_err(|e| format!("options json: {e}"))? };
    // The play focus is asked every time and has no default (solver_mode.rs).
    if goal.assume.play_mode.is_none() {
        return Err(mode::NEED_MODE.into());
    }
    if find_gem(&goal.skill).is_none() {
        return Err(format!("unknown skill {:?}", goal.skill));
    }
    Scorer::new(&goal.clone().settle())?;
    clear::load_text_rules();
    // A plan from the player's AI, or no time budget (run until met or stalled): solver_plan.rs drives one solve per lead.
    let planned = plan::wanted(goal_json, &opts);
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({ "active": true, "done": false, "layer": "starting", "evaluations": 0, "elapsedMs": 0, "results": [] }), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let cancel = Arc::new(AtomicBool::new(false));
    let inbox = Arc::new(Mutex::new(Vec::new()));
    let (sh, ca, ib) = (shared.clone(), cancel.clone(), inbox.clone());
    let goal_json_owned = goal_json.to_string();
    let thread = std::thread::Builder::new()
        .name("solve".into())
        .stack_size(WORKER_STACK)
        .spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                pom_engine::modparser::text_rules::set_active(true);
                if planned {
                    return plan::drive(xml, goal_json_owned, opts, sh.clone(), ca, ib);
                }
                let mut s = Solver::new(xml, goal, opts, sh.clone(), ca)?;
                s.run()
            }));
            let err = match r {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(_) => Some("the solver stopped on an internal error".to_string()),
            };
            let (m, cv) = &*sh;
            let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
            g.done = true;
            g.version += 1;
            if let Some(o) = g.snapshot.as_object_mut() {
                o.insert("done".into(), json!(true));
                o.insert("active".into(), json!(false));
                if let Some(e) = err {
                    o.insert("error".into(), json!(e));
                }
            }
            cv.notify_all();
        })
        .map_err(|e| format!("cannot start the solver thread: {e}"))?;
    Ok(Handle { shared, cancel, inbox, thread: Some(thread) })
}

// ---------------------------------------------------------------------------------------------------------------
// The solver

struct Solver {
    goal: Goal,
    scorer: Scorer,
    weights: Vec<f64>,
    names: Arc<Vec<String>>,
    pool: Pool,
    cancel: Arc<AtomicBool>,
    started: Instant,
    budget_ms: u64,
    max_evals: u64,
    evals: AtomicU64,
    prof_pool_us: AtomicU64,
    prof_batches: AtomicU64,
    shared: Arc<(Mutex<Shared>, std::sync::Condvar)>,
    session: Session,
    level: i64,
    points: usize,
    asc_points: usize,
    /// The player's build with the solver's level, gem defaults and config assumptions, tree reset.
    base_xml: String,
    /// The player's own tree, used to seed the candidate of the build's class.
    seed: Option<(i64, i64, Vec<i64>, Vec<(i64, i64)>)>,
    ctx: Vec<ClassCtx>,
    gems: Vec<GemInfo>,
    main_gem: &'static str,
    required: Vec<&'static str>,
    archive: Vec<Entry>,
    layer: String,
    /// Every layer the solve has published in, with the budget spent when it first did.
    layers: Vec<(String, u64)>,
    current: String,
    assumptions: Vec<String>,
    // ----- build text assembly
    skills_open: String,
    group_memo: RefCell<HashMap<String, String>>,
    /// The joint sensitivity axes every measurement takes (solver_sens.rs `sensitivity_full`).
    live_axes: RefCell<Vec<usize>>,
    /// The main tree's jewel sockets.
    tree_sockets: Vec<i64>,
    // ----- items layer (solver_items.rs)
    rules: ItemRules,
    slots: Vec<SlotDef>,
    start_gear: Arc<Gear>,
    item_level: u32,
    weapon_types: Option<HashSet<String>>,
    uniques: Vec<Arc<UniqueInfo>>,
    bases: RefCell<HashMap<String, Arc<BaseInfo>>>,
    slot_base_memo: RefCell<HashMap<SlotKind, Vec<String>>>,
    gear_enum_memo: RefCell<Option<Vec<gearparts::GearPart>>>,
    gear_all_memo: RefCell<HashMap<String, Vec<gearparts::GearPart>>>,
    /// Last measured gain of each modifier family per (slot, base), for the quick rounds.
    ranks: HashMap<(usize, String), Vec<f64>>,
    /// Lead axes the slot plan primes for (a beam leaf's, while it is realized); empty: the state's convex axes.
    lead_hint: Vec<usize>,
    /// The lead axes the last slot plan used.
    plan_lead: Vec<usize>,
    /// Set while the last results are finished past the time budget (see `archive_add`).
    ignore_budget: std::cell::Cell<bool>,
    /// `stop` also holds at this `spent` mark (a phase's own end, e.g. one class's scouting share).
    phase_end: std::cell::Cell<u64>,
    /// The kicks' random start (`Options::seed`).
    rng_seed: u64,
    /// The clock ran ahead of the evaluations at some point: later phases were shortened (said in the assumptions).
    behind: std::cell::Cell<bool>,
    /// Set during the leads phase: `spent` counts its tries only, so a slow machine still screens every ascendancy;
    /// `stop` then holds at LEADS_WALL of the time budget instead.
    leads_tries: std::cell::Cell<bool>,
    /// Set for the finishing passes: `stop` then cuts at the full budget, so they can still use the reserve.
    finalizing: std::cell::Cell<bool>,
    /// How far `grow` looks for a notable or keystone (0: the usual six). The package fallback's regrowth looks further.
    notable_reach: std::cell::Cell<usize>,
    /// Passives the package fallback gave back: `grow` neither ends on them (`banned`) nor walks through them. Only the
    /// fallback fills it, so every other growth paths as before.
    avoid: RefCell<HashSet<i64>>,
    /// The open build on the goal's terms, when the solve did not start from a blank build.
    start_xml: Option<String>,
    /// The open build's item per slot (seeds the items layer).
    player_pieces: Vec<Option<items::Piece>>,
    /// Cost fixers the gem layer may add to keep supports a skill's cost holds back: (supports, utility skills).
    fixers: (Vec<&'static str>, Vec<&'static str>),
    /// The best setup the cost held back that no cost fixer saved, with its cost-free score (`sustain_buy` pays for it).
    blocked: RefCell<Option<(f64, State)>>,
    /// Setups (`main` and `utils`) `sustain_buy` already tried.
    sustain_tried: RefCell<HashSet<Vec<&'static str>>>,
    /// Spell Totem: Wither is cast by a totem.
    totem: Option<&'static str>,
    /// Passive nodes (name, lowercase stat text) by id, read once.
    node_memo: RefCell<HashMap<i64, Rc<(String, String)>>>,
    /// The main skill's part the solver scores (index from 1, name): a part fed only by gear the build wears (a flask), set
    /// on the first whole evaluation (`gear_fed_part`); part 1 until then and when the skill has none.
    main_part: std::cell::OnceCell<(usize, String)>,
    /// The goal's keystones' tree per class context (`keystone_seed`).
    keystone_memo: RefCell<HashMap<usize, Vec<i64>>>,
    /// Nodes `grow` must not take (a keystone the review gave back).
    banned: RefCell<HashSet<i64>>,
    /// The gems the open build has .
    own_gems: HashSet<&'static str>,
    /// The outer tree sockets that take a large cluster jewel, and the passives a cluster jewel adds in each.
    large_sockets: Vec<i64>,
    cluster_ids: RefCell<HashMap<String, (Vec<i64>, Vec<i64>)>>,
    /// The sockets inside each outer tree socket (for cluster jewels placed in a cluster jewel).
    sub_sockets: HashMap<i64, Vec<i64>>,
    // ----- config switches (solver_config.rs)
    /// Item texts matched against the switches' source lines.
    cfg_items: RefCell<HashMap<String, Arc<Vec<(usize, usize, String)>>>>,
    /// Switches the size guard turned off, per lead (None: before leads).
    cfg_flagged: RefCell<HashSet<(Option<u16>, String)>>,
    /// The tree's lines matched against the switches' sources (once per solve).
    cfg_tree: std::cell::OnceCell<&'static config::TreeHits>,
    // ----- lead search (solver_leads.rs)
    gens: Vec<leads::CtxGen>,
    book: leads::LeadBook,
    /// The gear every lead starts from (its own weapon swapped in).
    lead_gear: Option<Arc<Gear>>,
    /// DPS and EHP of the best result's tree and gems with nothing equipped (`no_gear_baseline`).
    baseline: Option<(f64, f64)>,
    /// The final pick (solver_plan.rs pick_final): the picked result's id, the extreme one's, and whether no result met a stated target.
    picked: Option<(String, Option<String>, bool)>,
}

const EPS: f64 = 1e-7;
/// `grow` plans its picks two at a time (`plan_pick`) once at most this many points are free, measuring the best few pairs.
const PLAN_FREE: usize = 8;
const PLAN_TRIES: usize = 4;
/// `asc_sets` measures the whole ascendancy only when it has at most this many ways to fill it.
const ASC_SETS_MAX: usize = 400;
/// `slot_moves` tries at most this many of the nearest slot-opening nodes per call.
const SLOT_MOVES_MAX: usize = 4;

impl Solver {
    fn new(xml: String, goal: Goal, opts: Options, shared: Arc<(Mutex<Shared>, std::sync::Condvar)>, cancel: Arc<AtomicBool>) -> Result<Solver, String> {
        let goal = goal.settle();
        let game = pom_calc::data::game_data();
        // A goal for another skill than the open build plays is a new build: it starts blank (the open build's class,
        // tree and gear are neither forced in nor kept as a result).
        let own = own_gems(&xml);
        let other_skill = !own.is_empty() && find_gem(&goal.skill).is_some_and(|m| !own.contains(m));
        let xml = if other_skill { blank_build_xml(goal.level.or_else(|| tag_attr(&xml, "Build", "level").and_then(|v| v.parse().ok())).unwrap_or(90)) } else { xml };
        let (mut scorer, _) = Scorer::new(&goal)?;
        // (read by the config switch rules, never scored)
        for k in &config::data().stats {
            if !scorer.names.contains(k) {
                scorer.names.push(k.clone());
            }
        }
        // (read by the completion beam: a resist line past the cap, solver_finish.rs)
        for k in finish::OVERCAP.iter().map(|e| if goal.assume.flasks { format!("{NO_FLASK}{e}") } else { e.to_string() }).chain(["TotalEHP".to_string(), "FrenzyCharges".to_string()]) {
            if !scorer.names.contains(&k) {
                scorer.names.push(k);
            }
        }
        let weights = scorer.targets.iter().map(|t| t.weight).collect();
        let names = Arc::new(scorer.names.clone());
        let threads = opts.threads.unwrap_or_else(default_threads).clamp(1, default_threads());
        let budget_ms = opts.time_budget_ms.unwrap_or(600_000).max(1000);
        let mut session = Session::new(xml.clone(), game);
        session.ensure_node_list()?;
        let xml = session.xml().to_string();
        let build_level: i64 = tag_attr(&xml, "Build", "level").and_then(|v| v.parse().ok()).unwrap_or(90);
        let level = goal.level.unwrap_or(build_level).clamp(1, 100);
        let mut assumptions = Vec::new();
        let mut base = set_tag_attr(&xml, "Build", "level", &level.to_string())?;
        base = set_tag_attr(&base, "Skills", "defaultGemLevel", "characterLevel")?;
        base = set_tag_attr(&base, "Skills", "defaultGemQuality", "20")?;
        assumptions.push(format!("Gems at the highest level a level {level} character can use, 20% quality"));
        let ilvl = if items::ItemRules::from_value(&goal.items).is_ok_and(|r| r.craft_top()) { level.clamp(1, 100).max(86) } else { level.clamp(1, 100) };
        let ilvl = goal.wealth.map_or(ilvl, |w| ilvl.min(w.item_level() as i64));
        if let Some(w) = goal.wealth {
            assumptions.push(w.assumption(!goal.unique_prices.is_empty()));
        }
        assumptions.push(match goal.rolls {
            Rolls::Typical => format!("Crafted rares roll typically: every modifier at the middle of the top two tiers item level {ilvl} allows"),
            Rolls::Perfect => format!("Crafted rares are perfect: every modifier at the best tier item level {ilvl} allows, at its top roll"),
        });
        // The play focus sets the enemy, not the metric (solver_mode.rs): mapping is never scored against a pinnacle boss.
        base = set_config_input(&base, "enemyIsBoss", Some(&ConfigValue::Str(goal.assume.mode().profile().enemy_boss.into())))?;
        if goal.assume.mode() != PlayMode::Mapping {
            crate::solver_boss::set_presets(crate::solver_boss::preset_table(&base));
        }
        assumptions.push(goal.assume.mode().assumption().into());
        if goal.assume.mode() != PlayMode::Mapping {
            // 2 = "Unlucky" in the config list (1 Average, 4 Very Unlucky): block, dodge and suppression count as the worse of two rolls, so they cannot hide a one-shot; 4 would price every fight at its worst luck
            base = set_config_input(&base, "EHPUnluckyWorstOf", Some(&ConfigValue::Num(2.0)))?;
            assumptions.push("Defences are read unlucky: block, dodge and suppression count as the worse of two rolls".into());
        }
        if goal.assume.mode() == PlayMode::Both && goal.targets.iter().any(|t| t.metric.trim() == "boss") {
            assumptions.push("The boss DPS target is scored against the boss only: it has no clear side".into());
        }
        if goal.assume.mode() == PlayMode::Mapping && goal.targets.iter().any(|t| t.metric.trim() == "boss") {
            assumptions.push("The boss DPS target is scored against map monsters: the play focus is mapping".into());
        }
        if goal.assume.flasks_always {
            base = set_config_input(&base, "conditionUsingFlask", Some(&ConfigValue::Bool(true)))?;
            assumptions.push("Flasks are always on (the goal says so)".into());
        } else {
            // (upstream counts "using a flask" from the active flasks; the player's own switch would count it without one)
            base = set_config_input(&base, "conditionUsingFlask", None)?;
            if goal.assume.flasks {
                if goal.limits.resists.is_some() || goal.limits.pool.is_some() {
                    let mut parts = Vec::new();
                    if goal.limits.resists.is_some() {
                        parts.push("Resistances (chaos included)");
                    }
                    if goal.limits.pool.is_some() {
                        parts.push("the life floor (energy shield too for an energy shield build)");
                    }
                    assumptions.push(format!("{} hold with every flask off; flasks used only when something happens to you (frozen, bleeding, a savage hit, a block, a guard skill, hitting a rare, using a life flask, a travel skill) do not count", parts.join(" and ")));
                }
                assumptions.push(match goal.assume.uptime() {
                    FlaskUptime::Mapping => format!("Flask uptime for mapping: a flask counts when kills (about {MAPPING_KILL_CHARGES} charges a second, five normal monsters), charges generated and critical strikes cover its charges per use; each result lists its flasks"),
                    FlaskUptime::Bossing => "Flask uptime for bossing: a flask counts only when the build sustains it: charges generated and gained on critical strikes over its duration cover its charges per use (no charges from kills); each result lists its flasks".into(),
                });
            } else {
                assumptions.push("No flask counts (the goal turns flasks off)".into());
            }
        }
        if goal.assume.buffs {
            assumptions.push("Buffs the setup keeps up: the Withered stacks a Wither totem keeps up (its casts a second times the debuff duration, at most 15), the Lifetap buff, Feeding Frenzy with its support, an Offering (with corpses to offer)".into());
        }
        if scorer.targets.iter().any(|t| t.metric.trim() == "ehp") {
            assumptions.push(format!("EHP is TotalEHP, the number the sidebar shows. Scoring credits it at most {EHP_MAX_HIT_MULT} times the weakest of the five maximum hits (physical, fire, cold, lightning, chaos), so a build that one-shots on a type earns no more for extra EHP"));
        }
        if goal.limits.pool == Some(DEFAULT_POOL) {
            assumptions.push(format!("Life floor not set: {} unreserved life applies{}", goal.wealth.map_or(3000.0, |w| w.pool_floor()), if goal.wealth.is_some() { " (the wealth tier's floor)" } else { "" }));
        }
        if scorer.targets.iter().any(|t| t.share.is_some() || t.metric == "bossdps") {
            assumptions.push("Damage counts the time spent casting warcries again (the calculation counts their exerted attacks, not the time shouting)".into());
            assumptions.push("Mirage Archers and the main skill's own minions count in the damage".into());
        }
        // The player's tree: kept as the seed of its own class.
        let paths = session.paths()?;
        let mut seed = None;
        let alloc: Vec<i64> = nodes_in_xml(&xml)?.into_iter().filter(|id| paths.nodes.get(id).is_some_and(|n| n.kind != "ClassStart" && n.kind != "AscendClassStart")).collect();
        if !alloc.is_empty() {
            seed = Some((paths.class_id, paths.ascend_class_id, alloc, paths.mastery_selections.clone()));
        }
        // The open build on the goal's terms (level, assumptions): kept as a result so none is worse than it.
        let start_xml = (seed.is_some() || xml.contains("<Slot ")).then(|| base.clone());
        if other_skill {
            assumptions.push(format!("Your open build plays another skill: a new {} build, started blank (not from your class, tree or gear)", goal.skill));
        }
        let base = player_config_off(&base)?;
        assumptions.push(format!("Utility skills (aura, herald, curse, guard, warcry, banner, buff) beyond the ones your build uses are added as far as mana reservation and sockets allow: the calculation counts every buff as always up"));
        assumptions.push("Your build's config switches (conditions, charges, rage, buffs) are not carried over: each result sets the ones its own setup earns, listed with the result".into());
        assumptions.push(match goal.assume.mode() {
            PlayMode::Mapping => "Config switches are set for mapping (kill-based effects count). DPS is scored single target (the sidebar number). Pack clear DPS is shown beside it in each result and scores only when a target names it".into(),
            PlayMode::Bossing => "Config switches are set for bossing (no kill-based effects)".into(),
            PlayMode::Both => "Config switches are set for bossing (no kill-based effects); the clear side reads the same setup on a normal map monster in a pack of five, scored as pack clear. Limits are both modes' limits together".into(),
        });
        let reset = match crate::treeedit::reset_tree(&base, &paths)? {
            Ok(x) => x,
            Err(_) => base.clone(),
        };
        let main_gem = find_gem(&goal.skill).ok_or_else(|| format!("unknown skill {:?}", goal.skill))?;
        let mut gems = catalog(level, &goal);
        // Jev's shortlist: likely supports are tried first (the others still are).
        by_priority(&mut gems, |g| if g.kind == Kind::Support { Priority::of(&goal.priority.supports, &g.name) } else { 0.5 });
        if !goal.priority.is_empty() {
            assumptions.push("A shortlist (Jev's or a plan lead's supports) set the order candidates are tried in; every candidate is still tested and the engine's numbers decide".into());
        }
        // A minion skill's auras can be linked to Generosity (more effect on the minions, none on the player): each
        // aura is offered both ways, as "<aura>+<Generosity>".
        let minion = gd::game_data().gems.get(main_gem).is_some_and(|g| g.tags.get("minion").copied().unwrap_or(false));
        if let Some(gen) = gems.iter().find(|g| g.name == "Generosity" && g.kind == Kind::Support).map(|g| g.id) {
            if minion {
                let auras: Vec<(&'static str, String)> = gems.iter().filter(|g| g.kind == Kind::Aura && gd::game_data().gems.get(g.id).is_some_and(|x| x.tags.get("aura").copied().unwrap_or(false))).map(|g| (g.id, g.name.clone())).collect();
                for (id, name) in auras {
                    let v: &'static str = Box::leak(format!("{id}+{gen}").into_boxed_str());
                    gems.push(GemInfo { id: v, name: format!("{name} + Generosity"), kind: Kind::Aura });
                }
            }
        }
        // A guard skill is fired by Cast when Damage Taken, a hex by Blasphemy (an aura that curses nearby; a mark by Mark On Hit, which needs a rare or
        // unique target: bossing only), so a player does not press them by hand. The trigger needs the skill's level
        // requirement within the support's cap and the damage taken to fill its threshold, both true for a mapping build.
        {
            let sup = |n: &str| gems.iter().find(|g| g.kind == Kind::Support && g.name == n).map(|g| (g.id, g.name.clone()));
            let bossing = goal.assume.mode() != PlayMode::Mapping;
            let mut autos: Vec<GemInfo> = Vec::new();
            for g in gems.iter().filter(|g| matches!(g.kind, Kind::Guard | Kind::Curse)) {
                let supports: Vec<&str> = if g.kind == Kind::Guard { vec!["Cast when Damage Taken"] } else if bossing { vec!["Blasphemy", "Mark On Hit"] } else { vec!["Blasphemy"] };
                for n in supports {
                    let Some((sid, sname)) = sup(n) else { continue };
                    if !support_fits(sid, g.id) {
                        continue;
                    }
                    let v: &'static str = Box::leak(format!("{}+{sid}", g.id).into_boxed_str());
                    autos.push(GemInfo { id: v, name: format!("{} + {sname}", g.name), kind: Kind::Auto });
                }
            }
            gems.extend(autos);
        }
        let mut required = Vec::new();
        for r in &goal.gems.require {
            let id = find_gem(r).ok_or_else(|| format!("unknown gem {r:?}"))?;
            if id != main_gem {
                required.push(id);
            }
        }
        let bandit_extra = if goal.bandit.as_deref().unwrap_or("None") == "None" { 1 } else { 0 };
        let points = goal.passive_points.unwrap_or(level - 1 + 23 + bandit_extra).max(0) as usize;
        let asc_points = goal.ascendancy_points.unwrap_or(8).max(0) as usize;
        let flicker: Vec<(String, f64)> = gems.iter().filter(|g| matches!(g.kind, Kind::Guard | Kind::Debuff | Kind::MinionBuff) && g.id != main_gem).filter_map(|g| Some((g.name.clone(), buff_uptime(g.id)?))).collect();
        let pool = Pool::new(threads, Arc::new(flicker), Arc::new(scorer.limit_only()));
        let weapon_types = gd::game_data().gems.get(main_gem).and_then(gd::gem_primary_effect).and_then(gd::weapon_types);
        // A utility skill that needs a weapon the main skill cannot use (Mirror Arrow's bow under Flicker Strike) never works.
        // (a main skill that needs no weapon, a spell or a totem, leaves no weapon for an attack utility skill either)
        let fits = |id: &str| {
            let u = gd::game_data().gems.get(id).and_then(gd::gem_primary_effect).and_then(gd::weapon_types);
            match (&weapon_types, u) {
                (_, None) => true,
                (Some(w), Some(u)) => u.iter().any(|t| w.contains(t)),
                (None, Some(_)) => false,
            }
        };
        gems.retain(|g| g.kind == Kind::Support || g.id.contains('+') || required.contains(&g.id) || fits(g.id));
        let mut s = Solver { goal, scorer, weights, names, pool, cancel, started: Instant::now(), budget_ms, max_evals: opts.max_evals.unwrap_or(budget_ms * DEFAULT_EVALS_PER_SEC / 1000).max(1), evals: AtomicU64::new(0), prof_pool_us: AtomicU64::new(0), prof_batches: AtomicU64::new(0), shared, session, level, points, asc_points, base_xml: reset, seed, ctx: Vec::new(), gems, main_gem, required, archive: Vec::new(), layer: "starting".into(), layers: Vec::new(), current: String::new(), assumptions, skills_open: String::new(), group_memo: RefCell::new(HashMap::default()), tree_sockets: Vec::new(), rules: ItemRules::default(), slots: Vec::new(), start_gear: Arc::new(Gear::default()), item_level: level.clamp(1, 100) as u32, weapon_types, uniques: Vec::new(), bases: RefCell::new(HashMap::default()), slot_base_memo: RefCell::new(HashMap::default()), gear_enum_memo: RefCell::new(None), gear_all_memo: RefCell::new(HashMap::default()), ranks: HashMap::default(), lead_hint: Vec::new(), plan_lead: Vec::new(), ignore_budget: std::cell::Cell::new(false), phase_end: std::cell::Cell::new(u64::MAX), start_xml, player_pieces: Vec::new(), fixers: (Vec::new(), Vec::new()), blocked: Default::default(), sustain_tried: Default::default(), totem: spell_totem(), node_memo: Default::default(), main_part: Default::default(), keystone_memo: Default::default(), banned: Default::default(), own_gems: own_gems(&xml), large_sockets: Vec::new(), cluster_ids: RefCell::new(HashMap::default()), sub_sockets: HashMap::default(), live_axes: Default::default(), cfg_items: Default::default(), cfg_flagged: Default::default(), cfg_tree: Default::default(), gens: Vec::new(), book: Default::default(), lead_gear: None, baseline: None, picked: None, rng_seed: opts.seed.unwrap_or(0), behind: Default::default(), leads_tries: Default::default(), finalizing: Default::default(), notable_reach: Default::default(), avoid: Default::default() };
        s.fixers = s.cost_fixers();
        s.setup_items(&xml)?;
        Ok(s)
    }

    /// Pressed utility skills the goal's play mode allows besides the main skill.
    fn press_cap(&self) -> usize {
        if self.goal.assume.mode() == PlayMode::Mapping {
            PRESS_CAP_MAPPING
        } else {
            PRESS_CAP
        }
    }

    /// The buttons `st` has the player press besides the main skill (blessings counted).
    fn presses(&self, st: &State) -> usize {
        let blessed = self.blessed(st);
        st.utils.iter().filter(|u| self.pressed(u) || blessed.contains(u)).count()
    }

    /// Utility auras that the gear makes blessings: the item they sit in has "Socketed Gems are Supported by Level N
    /// <support>" with a support that adds SkillType Blessing (Divine Blessing: a timed buff the player presses, not a
    /// standing aura).
    fn blessed(&self, st: &State) -> Vec<&'static str> {
        let at = self.assign_groups(&st.gear, &self.gem_groups(&st.main, &st.utils));
        st.utils
            .iter()
            .enumerate()
            .filter(|(k, u)| self.gems.iter().any(|g| g.id == **u && g.kind == Kind::Aura) && at.get(k + 1).copied().flatten().and_then(|i| st.gear.pieces.get(i).cloned().flatten()).is_some_and(|p| blessing_item(&p)))
            .map(|(_, u)| *u)
            .collect()
    }

    /// A utility skill the player has to press (curse, guard, movement, warcry, debuff, offering); auras, heralds and golems are set and forget.
    fn pressed(&self, u: &str) -> bool {
        self.gems.iter().any(|g| g.id == u && !matches!(g.kind, Kind::Aura | Kind::Golem | Kind::Support | Kind::Auto))
    }

    /// Drops pressed utility skills past `PRESS_CAP`, the one whose loss costs the score least first. The movement skill and
    /// the goal's required gems stay.
    fn trim_pressed(&self, st: &mut State) -> Result<bool, String> {
        let mut trimmed = false;
        let dmg = self.damage_curses();
        loop {
            if self.stop() {
                break;
            }
            // (an aura made a blessing by its item's support is pressed too; one blessing at most)
            let blessed = self.blessed(st);
            // (a blessing is up only while pressed: resistances and ailment immunity, read from the aura's stat ids,
            // cannot rest on one)
            let guard: Vec<&str> = blessed
                .iter()
                .copied()
                .filter(|u| gd::game_data().gems.get(*u).and_then(gd::gem_primary_effect).is_some_and(|ge| ge.stats.iter().any(|s| s.contains("resist") || s.contains("immune"))))
                .collect();
            let two = blessed.len() > 1;
            if !two && guard.is_empty() && st.utils.iter().filter(|u| self.pressed(u) || blessed.contains(u)).count() <= self.press_cap() {
                break;
            }
            let mut texts = Vec::new();
            let mut states = Vec::new();
            for i in 0..st.utils.len() {
                let u = st.utils[i];
                let here = if !guard.is_empty() { guard.contains(&u) } else if two { blessed.contains(&u) } else { self.pressed(u) || blessed.contains(&u) };
                // (the damage curse a DPS goal wears stays too)
                if !here || self.required.contains(&u) || dmg.as_ref().is_some_and(|d| d.contains(&util_root(u))) || self.gems.iter().any(|g| g.id == u && g.kind == Kind::Movement) {
                    continue;
                }
                let mut s = st.clone();
                s.utils.remove(i);
                self.price_gems(&mut s);
                texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
                states.push(s);
            }
            let mut best: Option<(f64, usize, Vals)> = None;
            for (i, v) in self.eval(texts.clone()).into_iter().enumerate() {
                let Some(v) = v else { continue };
                let (s, _) = self.score(&v);
                if best.as_ref().is_none_or(|b| s > b.0) {
                    best = Some((s, i, v));
                }
            }
            let Some((s, i, v)) = best else { break };
            let mut n = states.swap_remove(i);
            if let Cand::Xml(x) = &texts[i] {
                n.base = x.clone();
            }
            n.score = s;
            n.viol = self.score(&v).1;
            n.vals = v;
            self.settle(&mut n);
            *st = n;
            trimmed = true;
        }
        Ok(trimmed)
    }

    /// Gems that buy sustain, among the gems the goal allows, by what their granted effect does (game data, never names):
    /// supports for the main skill that lower or move its cost or leech or regenerate the resource (Inspiration,
    /// Lifetap, Arcane Surge), and auras that regenerate life or mana or raise a maximum resistance (Clarity, Vitality,
    /// the Purity of the degeneration's element).
    fn cost_fixers(&self) -> (Vec<&'static str>, Vec<&'static str>) {
        let stats = |id: &str| -> Vec<String> {
            let Some(ge) = gd::game_data().gems.get(id).and_then(gd::gem_primary_effect) else { return Vec::new() };
            let constant = ge.extra.get("constantStats").and_then(|c| c.as_array()).into_iter().flatten().filter_map(|p| p.get(0).and_then(|n| n.as_str()).map(str::to_string));
            ge.stats.iter().cloned().chain(constant).collect()
        };
        let sup = |s: &str| s.contains("cost") || s.contains("mana_regeneration") || s.contains("leech");
        let aura = |s: &str| s.contains("regeneration_rate") || (s.contains("maximum_") && s.contains("damage_resistance"));
        let pick = |kind: Kind, f: &dyn Fn(&str) -> bool| -> Vec<&'static str> { self.gems.iter().filter(|g| g.kind == kind && g.id != self.main_gem && stats(g.id).iter().any(|s| f(s))).map(|g| g.id).collect() };
        // (only supports the main skill may take: one that hands it to a trigger, Cast on Death, has no cost to pay)
        let ok = self.support_candidates();
        (pick(Kind::Support, &sup).into_iter().filter(|g| ok.contains(g)).collect(), pick(Kind::Aura, &aura))
    }

    /// A link whose cost is paid in life (Lifetap, Blood Magic) spends no mana, so a "mana spent" support (Arcane Surge) never triggers.
    fn mana_clash(&self, main: &[&'static str]) -> bool {
        let has = |n: &str| main.iter().any(|g| self.gem_named(g, n));
        has("Arcane Surge") && (has("Lifetap") || has("Blood Magic"))
    }

    fn gem_named(&self, id: &str, name: &str) -> bool {
        self.gems.iter().any(|g| g.id == id && g.name == name)
    }

    /// A Withered skill the build's spell totem casts: the only one that keeps stacks up at its own cast rate
    /// (`wither_stacks`). A skill the player uses withers only while it lasts (Withering Step: enemies entering its area
    /// while its buff is up, act_dex.lua 17320-17344), so it holds no stacks in the config.
    fn wither_totem(&self, id: &str) -> bool {
        withering(id) && self.totemed(id)
    }

    /// The main skill's charges from mana spent never come: a support that gains its charges from the mana the skill
    /// spends (`mana_spent_charges`) on a skill that spends none (its cost on life, Blood Magic, or no cost), read from
    /// evaluation `vals` (`None` before one).
    fn unfed_charges(&self, st: &State, vals: &Vals) -> Option<bool> {
        if !st.main.iter().any(|g| mana_spent_charges(g)) {
            return Some(false);
        }
        let i = self.scorer.names.iter().position(|n| n == "ManaPerSecondCost")?;
        let cost = vals.get(i).copied().flatten()?;
        Some(cost <= 0.0)
    }

    /// A debuff skill the build's spell totem casts (it goes in one group with the totem support).
    fn totemed(&self, id: &str) -> bool {
        let totemable = || gd::game_data().gems.get(id).and_then(gd::gem_primary_effect).is_some_and(|ge| gd::skill_types(ge).contains(&pom_skills::skill_type::TOTEMABLE));
        self.totem.is_some() && self.gems.iter().any(|g| g.id == id && g.kind == Kind::Debuff) && totemable()
    }

    /// Config inputs that follow from the setup at normal uptime: 15 Withered stacks with a Wither totem, the Lifetap
    /// buff when Lifetap supports the main skill. (Plague Bearer stays incubating: infecting lasts only while the stored
    /// damage does.)
    fn setup_config(&self, st: &State) -> String {
        self.setup_config_with(st, &st.vals)
    }

    /// `setup_config` with the config switches read from evaluation `vals` (solver_config.rs).
    fn setup_config_with(&self, st: &State, vals: &Vals) -> String {
        let mut o = self.config_for(st, vals).xml();
        // (Withered: the totem's stacks plus what the main skill's own chance on hit keeps up)
        let totem = if self.goal.assume.buffs && st.utils.iter().any(|u| self.wither_totem(u)) { st.wither } else { 0.0 };
        let on_hit = if self.goal.assume.ailments { self.wither_on_hit(st, &st.nodes, vals) } else { 0.0 };
        if totem + on_hit > 0.0 {
            o.push_str(&format!("<Input name=\"multiplierWitheredStackCount\" number=\"{}\"/>", (totem + on_hit).min(15.0)));
        }
        if self.unfed_charges(st, vals) == Some(true) {
            o.push_str("<Input name=\"overrideInspirationCharges\" number=\"0\"/>");
        }
        if !self.goal.assume.buffs {
            return o;
        }
        if st.main.iter().any(|u| self.gem_named(u, "Lifetap")) {
            o.push_str("<Input name=\"buffLifetap\" boolean=\"true\"/>");
        }
        // (the minions keep Feeding Frenzy up while they fight)
        if st.main.iter().any(|u| self.gem_named(u, "Feeding Frenzy")) {
            o.push_str("<Input name=\"feedingFrenzyFeedingFrenzyActive\" boolean=\"true\"/>");
        }
        o
    }

    /// The switches the solver's own code sets in a result's text (not config-sources.json), with their reasons.
    fn owned_switches(&self, xml: &str) -> Vec<(&'static str, String)> {
        let mut out = Vec::new();
        if crit_flag_on(xml) {
            out.push((CRIT_RECENT_INPUT, "the main skill lands a critical strike within 4 seconds at least 9 times in 10".to_string()));
        }
        for (k, why) in [("multiplierWitheredStackCount", "Wither totem and the main skill's chance on hit"), ("buffLifetap", "Lifetap support"), ("feedingFrenzyFeedingFrenzyActive", "Feeding Frenzy support"), ("overrideInspirationCharges", "the main skill spends no mana, so a support that gains charges from mana spent gets none")] {
            if xml.contains(&format!("<Input name=\"{k}\"")) {
                out.push((k, why.to_string()));
            }
        }
        out
    }

    /// What a result assumes beyond the solve's own list: each flask, counted or not, with its uptime.
    /// Boss DPS, EHP and the lowest max hit of a bossing result, in one line (None outside bossing mode).
    fn boss_breakdown_text(&self, e: &Entry) -> Option<String> {
        let sc = &self.scorer;
        let dps = sc.targets.iter().find(|t| t.metric == "bossdps")?;
        let ehp = sc.names.iter().position(|x| x == "TotalEHP").map(|k| Scorer::get(&e.vals, k))?;
        let boss = crate::solver_boss::BossBreakdown::from_parts(sc.target_value(dps, &e.vals), ehp, sc.boss_worst(&e.vals)).text();
        let Some((_, _, weaker)) = sc.both_sides(&e.vals) else { return Some(boss) };
        let clear = sc.targets.iter().find(|t| t.pair.is_some())?;
        Some(format!("Clear {} · Boss {}, limited by {weaker} (vs typical builds). {boss}", short_num(sc.target_value(clear, &e.vals)), short_num(sc.target_value(dps, &e.vals))))
    }

    /// One-shot chips: the build under each boss skill preset of the config's list (data `bossSkillsList`). The same
    /// evaluations set the "Survives every boss skill" stat in `vals` (the search reads a pen-only estimate from the
    /// Pinnacle evaluation, which misses a preset that changes the hit's kind), so a chip and a met limit never both show.
    fn boss_check(&self, xml: &Arc<String>, vals: &mut Vals) -> Vec<String> {
        if self.goal.assume.mode() == PlayMode::Mapping {
            return Vec::new();
        }
        let names = crate::solver_boss::preset_names();
        let worst: Vec<Option<crate::solver_boss::Worst>> = names
            .iter()
            .map(|preset| {
                if self.cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let x = set_config_input(xml, "presetBossSkills", Some(&ConfigValue::Str(preset.clone()))).ok()?;
                self.evals.fetch_add(1, Ordering::Relaxed);
                let v = self.pool.eval(vec![Cand::Xml(Arc::new(x))], &self.names, &self.cancel).pop().flatten()?;
                self.scorer.boss_worst(&v)
            })
            .collect();
        // (a long wind-up preset keeps its chip but not its shortfall)
        let short: f64 = names.iter().zip(&worst).filter(|(n, _)| !crate::solver_boss::long_windup(n)).filter_map(|(_, w)| *w).map(|w| (1.0 - w.ratio).max(0.0)).sum();
        if let Some(Some(v)) = self.names.iter().position(|n| n == "Solver.BossPresetShortfall").and_then(|k| vals.get_mut(k)) {
            *v = v.max(short);
        }
        crate::solver_boss::boss_chips(&names, &|p| names.iter().position(|n| n == p).and_then(|k| worst[k]))
    }

    fn entry_assumptions(&self, e: &Entry) -> Vec<String> {
        let mut out: Vec<String> = AILMENTS.iter().filter(|a| e.xml.contains(&format!("name=\"{}\" boolean=\"true\"", a.0))).map(|a| format!("Enemy is {} (the main skill applies it)", a.1)).collect();
        out.extend(e.switches.iter().map(|o| format!("{}: {}", config::short_label(&o.label), o.reason)));
        out.extend(e.honest.iter().filter_map(|c| c.detail()).filter(|h| h.flagged()).map(|h| h.text()));
        let label = |k: &str| config::data().sw.iter().find(|s| s.key == k).map(|s| config::short_label(&s.label)).unwrap_or_else(|| k.to_string());
        out.extend(self.owned_switches(&e.xml).into_iter().map(|(k, why)| format!("{}: {why}", label(k))));
        if let (Some(w), false) = (self.goal.wealth, e.start) {
            let budget = w.budget().map_or(String::new(), |b| format!(" (budget {b})"));
            let cost = self.gear_cost(&e.gear);
            let over = w.budget().filter(|b| cost > b + 1e-9).map_or(String::new(), |b| format!("; over budget by {:.1} (gems and must-use pieces alone cost {:.1})", cost - b, e.gear.gems + e.gear.pieces.iter().zip(&self.slots).filter(|(_, d)| d.locked).filter_map(|(p, _)| p.as_ref()).map(|p| self.piece_cost(p)).sum::<f64>()));
            out.push(format!("Gear to buy costs about {cost:.1} divine{budget}{over}"));
        }
        if let Some((_, name)) = self.main_part.get().filter(|p| p.0 > 1) {
            out.push(if self.goal.assume.flasks { format!("Main skill scored on its \"{name}\" part: it adds damage from gear the build wears") } else { format!("Main skill's \"{name}\" part adds damage only from gear the build wears; flasks are off, so a flask it reads adds nothing") });
            if let Some(u) = self.scorer.names.iter().position(|x| x == self.goal.assume.drain_stat()).and_then(|k| e.vals.get(k).copied().flatten()).filter(|u| *u < 1.0) {
                let when = if self.goal.assume.uptime() == FlaskUptime::Mapping { "while mapping".to_string() } else { format!("in a {}-second fight without kills", crate::solver_drain::FIGHT_SECS) };
                out.push(format!("The \"{name}\" part spends flask charges: the worn life flasks feed it {}% of the time {when}; the rest of the damage is the part it falls back to", (u * 100.0).round()));
            }
        }
        let Some(mask) = self.flask_mask_of(&e.vals) else { return out };
        for (i, d) in self.slots.iter().enumerate() {
            if d.kind != SlotKind::Flask {
                continue;
            }
            let Some(p) = e.gear.pieces.get(i).cloned().flatten() else { continue };
            let n: usize = d.name.rsplit(' ').next().and_then(|x| x.parse().ok()).unwrap_or(1);
            let up = self.scorer.names.iter().position(|x| *x == self.goal.assume.uptime_stat(n)).and_then(|k| e.vals.get(k).copied().flatten()).unwrap_or(0.0);
            let name = p.unique_name().map(|u| u.to_string()).or_else(|| p.base().map(|b| b.name.clone())).unwrap_or_else(|| p.label.split(" (").next().unwrap_or("").to_string());
            let name = name.replace("&apos;", "'").replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
            let pct = (up * 100.0).min(100.0).round();
            let map_up = self.scorer.names.iter().position(|x| self.goal.assume.map_side() && *x == format!("Solver.FlaskUptimeMap{n}")).and_then(|k| e.vals.get(k).copied().flatten()).unwrap_or(0.0);
            out.push(if mask & (1 << (n - 1)) != 0 {
                format!("{} ({name}) counts: sustained, {pct}% uptime", d.name)
            } else if map_up > 0.0 {
                format!("{} ({name}) counts for movement speed and clear only: {}% uptime while mapping, {pct}% without charges from kills", d.name, (map_up * 100.0).min(100.0).round())
            } else {
                format!("{} ({name}) does not count: {pct}% uptime {}", d.name, if self.goal.assume.uptime() == FlaskUptime::Mapping { "while mapping" } else { "without charges from kills" })
            });
        }
        out
    }

    fn elapsed(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    /// Budget used so far in ms: the evaluations scaled onto the budget (a fixed number of tries: the same work on any
    /// machine). Every phase mark reads this; the clock is only the hard cut in `stop`.
    fn spent(&self) -> u64 {
        (self.evals.load(Ordering::Relaxed).saturating_mul(self.budget_ms) / self.max_evals).min(u64::MAX / 2)
    }
    /// The reserve for finishing, in ms of budget (and of tries, scaled the same way).
    fn reserve_ms(&self) -> u64 {
        self.budget_ms * FINAL_RESERVE_PCT / 100
    }
    fn stop(&self) -> bool {
        if self.cancel.load(Ordering::Relaxed) || self.ignore_budget.get() {
            return self.cancel.load(Ordering::Relaxed);
        }
        let limit = if self.finalizing.get() { self.budget_ms } else { self.budget_ms - self.reserve_ms() };
        if self.spent() >= limit.min(self.phase_end.get()) {
            return true;
        }
        // (the clock cuts: the time budget, or the leads phase's wall share; the result says so)
        let clock = self.elapsed();
        let cut = clock >= limit || (self.leads_tries.get() && clock >= self.budget_ms * LEADS_WALL / 100);
        if cut {
            self.behind.set(true);
        }
        cut
    }

    fn eval(&self, cands: Vec<Cand>) -> Vec<Option<Vals>> {
        if cands.is_empty() || self.stop() {
            return vec![None; cands.len()];
        }
        self.evals.fetch_add(cands.len() as u64, Ordering::Relaxed);
        let t = Instant::now();
        let r = self.pool.eval(cands, &self.names, &self.cancel);
        self.prof_pool_us.fetch_add(t.elapsed().as_micros() as u64, Ordering::Relaxed);
        self.prof_batches.fetch_add(1, Ordering::Relaxed);
        r
    }

    fn score(&self, v: &[Option<f64>]) -> (f64, f64) {
        self.scorer.score(v, &self.weights)
    }

    // ----- classes

    fn class_ctx(&mut self, class_id: i64, asc_id: i64) -> Result<usize, String> {
        self.class_ctx_with(class_id, asc_id, 0)
    }

    /// The class context with the enemy ailments of `mask` assumed (memoised per class, ascendancy and mask).
    pub(super) fn class_ctx_with(&mut self, class_id: i64, asc_id: i64, mask: u8) -> Result<usize, String> {
        if let Some(i) = self.ctx.iter().position(|c| c.class_id == class_id && c.asc_id == asc_id && c.ailments == mask) {
            return Ok(i);
        }
        let mut base_xml = self.base_xml.clone();
        for (k, (var, _, _)) in AILMENTS.iter().enumerate() {
            if mask & (1 << k) != 0 {
                base_xml = set_config_input(&base_xml, var, Some(&ConfigValue::Bool(true)))?;
            }
        }
        let p0 = self.session.paths_for_xml(&base_xml)?;
        let class = p0.classes.get(&class_id).ok_or("unknown class")?;
        let root = class.start_node_id;
        let asc = class.ascendancies.get(&asc_id);
        let asc_root = asc.and_then(|a| a.start_node_id);
        let mut start = vec![root];
        start.extend(asc_root);
        let mut xml = compose(&base_xml, (class_id, asc_id, 0), &start, &[])?;
        xml = set_tag_attr(&xml, "Build", "className", &class.name)?;
        xml = set_tag_attr(&xml, "Build", "ascendClassName", asc.map(|a| a.name.as_str()).unwrap_or("None"))?;
        let paths = self.session.paths_for_xml(&xml)?;
        let adj = adjacency(&paths);
        let (tpl, open) = make_template(&xml)?;
        self.skills_open = open;
        if self.tree_sockets.is_empty() {
            let mut socks: Vec<i64> = paths.nodes.iter().filter(|(&id, n)| n.kind == "Socket" && n.ascendancy.is_none() && id < 65536).map(|(&id, _)| id).collect();
            socks.sort_unstable();
            self.tree_sockets = socks;
            let ver = tag_attr(&xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into());
            if let Ok(tree) = crate::cached_tree(&ver) {
                let large = |id: &i64| tree.nodes.get(id).and_then(|n| n.get("expansionJewel")).is_some_and(|e| !e.is_null() && e.get("size").and_then(|v| v.as_i64()) == Some(2) && e.get("parent").is_none_or(|p| p.is_null()));
                self.large_sockets = self.tree_sockets.iter().copied().filter(large).collect();
                // Each outer socket's own sockets (a cluster jewel there links to some of them).
                for (&k, n) in tree.nodes.iter() {
                    if let Some(p) = n.get("expansionJewel").and_then(|e| e.get("parent")).and_then(|p| p.as_str().and_then(|x| x.parse::<i64>().ok()).or_else(|| p.as_i64())) {
                        self.sub_sockets.entry(p).or_default().push(k);
                    }
                }
                for v in self.sub_sockets.values_mut() {
                    v.sort_unstable();
                }
            }
        }
        let label = match asc {
            Some(a) => format!("{} ({})", a.name, class.name),
            None => class.name.clone(),
        };
        let blood: HashMap<String, (i64, i64)> = paths.alternate_ascendancies.iter().filter_map(|(&id, a)| Some((a.internal_id.clone()?, (id, a.start_node_id?)))).collect();
        let granted: HashMap<i64, usize> = crate::cached_tree(&tag_attr(&xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into()))
            .map(|t| t.nodes.iter().filter_map(|(&id, n)| n.get("grantedPassivePoints").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).map(|v| (id, v as usize))).collect())
            .unwrap_or_default();
        self.ctx.push(ClassCtx { label, class_id, asc_id, class_name: class.name.clone(), asc_name: asc.map(|a| a.name.clone()), xml, paths, adj, root, asc_root, asc_internal: asc.and_then(|a| a.internal_id.clone()), blood, granted, tpl, ailments: mask });
        Ok(self.ctx.len() - 1)
    }

    /// The classes whose start fits the skill's main attribute, each with its ascendancies (or the goal's ascendancy).
    fn candidates(&mut self) -> Result<Vec<usize>, String> {
        let p0 = self.session.paths_for_xml(&self.base_xml)?;
        let mut out = Vec::new();
        let mut cids: Vec<i64> = p0.classes.keys().copied().collect();
        cids.sort_unstable();
        let class_want = self.goal.class_name.clone().filter(|c| !c.trim().is_empty());
        if let Some(cw) = &class_want {
            cids.retain(|cid| p0.classes[cid].name.eq_ignore_ascii_case(cw.trim()));
            if cids.is_empty() {
                return Err(format!("unknown class {cw:?}"));
            }
        }
        if let Some(want) = self.goal.ascendancy.clone() {
            for &cid in &cids {
                let c = &p0.classes[&cid];
                for (&aid, a) in &c.ascendancies {
                    if a.name.eq_ignore_ascii_case(&want) || a.internal_id.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(&want)) {
                        out.push(self.class_ctx(cid, aid)?);
                    }
                }
                if c.name.eq_ignore_ascii_case(&want) {
                    out.push(self.class_ctx(cid, 0)?);
                }
            }
            if out.is_empty() {
                return Err(format!("unknown ascendancy {want:?}{}", class_want.map(|c| format!(" for class {c:?}")).unwrap_or_default()));
            }
            return Ok(out);
        }
        let g = gd::game_data().gems.get(self.main_gem).ok_or("main gem")?;
        let attr = if g.req_str >= g.req_dex && g.req_str >= g.req_int {
            "str"
        } else if g.req_dex >= g.req_int {
            "dex"
        } else {
            "int"
        };
        let fits = |name: &str| -> bool {
            let a: &[&str] = match name {
                "Marauder" => &["str"],
                "Ranger" => &["dex"],
                "Witch" => &["int"],
                "Scion" => &["str", "dex", "int"],
                "Duelist" => &["str", "dex"],
                "Templar" => &["str", "int"],
                "Shadow" => &["dex", "int"],
                _ => &[],
            };
            a.contains(&attr)
        };
        for &cid in &cids {
            let c = p0.classes[&cid].clone();
            if class_want.is_none() && !fits(&c.name) {
                continue;
            }
            let mut aids: Vec<i64> = c.ascendancies.keys().copied().filter(|a| *a != 0).collect();
            aids.sort_unstable();
            for aid in aids {
                out.push(self.class_ctx(cid, aid)?);
            }
        }
        // The build's own class and ascendancy, when it has a tree, is always tried (its tree is the seed).
        if let Some((cid, aid, _, _)) = self.seed.clone().filter(|(cid, ..)| class_want.is_none() || cids.contains(cid)) {
            let i = self.class_ctx(cid, aid)?;
            if !out.contains(&i) {
                out.insert(0, i);
            } else {
                out.retain(|x| *x != i);
                out.insert(0, i);
            }
        }
        Ok(out)
    }

    // ----- state

    fn full_nodes(&self, st: &State) -> Vec<i64> {
        let c = &self.ctx[st.class];
        let mut v = vec![c.root];
        v.extend(c.asc_root);
        v.extend(c.blood_in(&st.nodes).map(|b| b.1));
        v.extend(st.nodes.iter().copied());
        v.extend(st.gear.cluster_nodes(&st.nodes));
        v
    }

    /// A socket group's `<Skill>` element as the skills edit writes it (gem level and quality from the build's defaults).
    fn group_text(&self, gems: &[&'static str], label: &str) -> Result<String, String> {
        let key = format!("{label}|{}", gems.join(","));
        if let Some(t) = self.group_memo.borrow().get(&key) {
            return Ok(t.clone());
        }
        let mini = format!("<PathOfBuilding><Build level=\"{}\"/>{}<SkillSet id=\"1\"/></Skills></PathOfBuilding>", self.level, self.skills_open);
        let list: Vec<Value> = gems.iter().map(|g| json!({ "gemId": g })).collect();
        let x = skills_edit(&mini, &json!({"kind": "addGroup", "group": {"gems": list, "label": label}}))?.ok_or("skills edit not handled")?;
        let a = x.find("<Skill ").ok_or("no socket group written")?;
        let b = x.rfind("</Skill>").map(|i| i + "</Skill>".len()).ok_or("no socket group written")?;
        let mut t = x[a..b].to_string();
        // The main skill counts in Full DPS (a minion skill's damage of all its minions).
        if label == "Main" {
            t = set_tag_attr(&t, "Skill", "includeInFullDPS", "true")?;
        }
        self.group_memo.borrow_mut().insert(key, t.clone());
        Ok(t)
    }

    /// A passive node's name and lowercase stat lines.
    /// The passives and mastery effects of class `ci`'s tree with an `unpriced_downside` line.
    pub(super) fn downside(&self, ci: usize) -> Arc<(HashSet<i64>, HashSet<i64>)> {
        downside_passives(&tag_attr(&self.ctx[ci].xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into()))
    }

    fn node_info(&self, id: i64) -> Rc<(String, String)> {
        if let Some(i) = self.node_memo.borrow().get(&id) {
            return i.clone();
        }
        let ver = tag_attr(&self.base_xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into());
        let info = crate::cached_tree(&ver)
            .ok()
            .and_then(|t| {
                let n = t.nodes.get(&id)?;
                let name = n.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let stats = n.get("stats").map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default();
                Some((name, stats.join("\n").to_lowercase()))
            })
            .unwrap_or_default();
        let info = Rc::new(info);
        self.node_memo.borrow_mut().insert(id, info.clone());
        info
    }

    fn allocated(&self, st: &State, name: &str) -> bool {
        st.nodes.iter().any(|&n| self.node_info(n).0 == name)
    }

    /// A node whose effect the setup cannot use: ailment nodes under Elemental Focus (no elemental ailments), critical
    /// nodes under Resolute Technique (no critical strikes). Upstream does not model every such block, so it scores them as gains.
    fn node_dead(&self, st: &State, id: i64) -> bool {
        if self.banned.borrow().contains(&id) || self.downside(st.class).0.contains(&id) {
            return true;
        }
        let info = self.node_info(id);
        let text = &info.1;
        let main_has = |n: &str| st.main.iter().any(|g| self.gem_named(g, n));
        if main_has("Elemental Focus") && ["ignite", "shock", "freeze", "chill", "scorch", "brittle", "sap", "ailment"].iter().any(|a| text.contains(a)) {
            return true;
        }
        // A skill triggered only against a rare or unique enemy (Deathmarked's mark) is not on the pack while mapping, the
        // way the gem catalog leaves marks out there; upstream keeps it up on every enemy.
        if self.goal.assume.mode() == PlayMode::Mapping && text.contains("trigger") && text.contains("rare or unique enemy") {
            return true;
        }
        // (an allocated keystone's "Never ..." / "Cannot ..." line switches off what nodes naming that stat give:
        // Resolute Technique's and Precise Technique's critical strikes, Unwavering Stance's evasion)
        let words: Vec<&str> = text.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty()).collect();
        !self.keystone_stems(st).into_iter().filter(|(k, _)| *k != id).all(|(_, stem)| !words.iter().any(|w| w.starts_with(stem.as_str())))
    }

    /// The stats each allocated keystone switches off, as a word stem (3 letters): from its lines that start "never" or
    /// "cannot", the first word after the verb ("Never deal Critical Strikes": "cri"; "Cannot Evade enemy Attacks":
    /// "eva"; "Cannot be Stunned": "stu"). Damage itself is never one (Ancestral Bond's totems still use it).
    pub(super) fn keystone_stems(&self, st: &State) -> Vec<(i64, String)> {
        let Ok(tree) = crate::cached_tree(&tag_attr(&self.base_xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())) else { return Vec::new() };
        let mut out = Vec::new();
        for &id in st.nodes.iter().filter(|id| tree.nodes.get(id).and_then(|n| n.get("isKeystone")).and_then(|v| v.as_bool()).unwrap_or(false)) {
            for line in self.node_info(id).1.lines() {
                let mut w = line.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty());
                // (only a whole switch-off: "Cannot Recover Energy Shield to above Armour" or "... while ..." is a condition)
                if line.split_whitespace().count() > 4 || !matches!(w.next(), Some("never" | "cannot")) {
                    continue;
                }
                if let Some(stem) = w.find(|x| !matches!(*x, "deal" | "be" | "use" | "have" | "gain" | "take" | "you" | "your")).filter(|x| x.len() >= 3 && !x.starts_with("dam")) {
                    out.push((id, stem[..3].to_string()));
                }
            }
        }
        out
    }

    /// Totems a setup puts out: a main skill with a totem, a Wither cast by a Spell Totem, each totem skill.
    fn totem_count(&self, main: &[&'static str], utils: &[&'static str]) -> usize {
        let tag = |id: &str| gd::game_data().gems.get(id).is_some_and(|g| g.tags.get("totem").copied().unwrap_or(false));
        main.iter().any(|g| tag(g)) as usize + utils.iter().filter(|u| self.totemed(u) || u.split('+').any(|x| tag(x))).count()
    }

    fn render(&self, st: &State) -> Result<String, String> {
        self.render_with(st, "")
    }

    /// `render` with `probe` (a custom modifier block, see solver_sens.rs) added to the config.
    fn render_with(&self, st: &State, probe: &str) -> Result<String, String> {
        let c = &self.ctx[st.class];
        let t = &c.tpl;
        let mut out = String::with_capacity(t.len + 16 * 1024);
        for (i, part) in t.parts.iter().enumerate() {
            out.push_str(part);
            let Some(&h) = t.holes.get(i) else { break };
            match h {
                0 => {
                    out.push_str(&self.skills_open);
                    out.push_str("<SkillSet id=\"1\">");
                    // The item slot each group sits in (`slot=`), so the item's own gem effects (a Sire's chain, a
                    // helmet's Sadism) reach it; gems no socket holds are cut (the main link) or left off (`group_homes`).
                    let homes = self.group_homes(&st.gear, &self.gem_groups(&st.main, &st.utils));
                    let put = |out: &mut String, t: String, g: usize| -> Result<(), String> {
                        let (slot, n) = homes.get(g).copied().unwrap_or((None, 1));
                        let t = if n == 0 { set_tag_attr(&t, "Skill", "enabled", "false")? } else { t };
                        out.push_str(&match slot {
                            Some(i) => set_tag_attr(&t, "Skill", "slot", &self.slots[i].name)?,
                            None => t,
                        });
                        Ok(())
                    };
                    if !st.main.is_empty() {
                        let n = homes.first().map_or(st.main.len(), |h| h.1).clamp(1, st.main.len());
                        let mut g = self.group_text(&st.main[..n], "Main")?;
                        if let Some((k, _)) = self.main_part.get().filter(|p| p.0 > 1) {
                            g = g.replacen("<Gem ", &format!("<Gem skillPart=\"{k}\" "), 1);
                        }
                        put(&mut out, g, 0)?;
                    }
                    for (k, u) in st.utils.iter().enumerate() {
                        let t = match self.totem {
                            Some(t) if self.totemed(u) => self.group_text(&[u, t], "")?,
                            _ if u.contains('+') => {
                                let parts: Vec<&'static str> = (*u).split('+').collect();
                                self.group_text(&parts, "")?
                            }
                            _ => self.group_text(&[u], "")?,
                        };
                        let t = st.gem_levels.iter().filter(|(g, _)| u.split('+').any(|x| x == *g)).fold(t, |t, (g, l)| finish::set_gem_level(&t, g, *l));
                        put(&mut out, t, k + 1)?;
                    }
                    out.push_str("</SkillSet></Skills>");
                }
                1 => {
                    let mut lines: Vec<Option<String>> = vec![None; self.slots.len()];
                    for sp in self.socket_plan(&st.gear, &self.gem_groups(&st.main, &st.utils)) {
                        lines[sp.slot] = sp.line;
                    }
                    out.push_str(&items::items_xml(&self.slots, &st.gear, &lines))
                }
                2 => out.push_str(&self.full_nodes(st).iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",")),
                3 => {
                    let m: Vec<(i64, i64)> = st.masteries.iter().copied().filter(|(n, _)| st.nodes.contains(n)).collect();
                    out.push_str(&crate::treeedit::mastery_attr(&m));
                }
                4 => out.push_str(&items::sockets_xml(&self.slots, &st.gear, &self.tree_sockets)),
                6 => {
                    out.push_str(&self.setup_config(st));
                    out.push_str(probe);
                }
                7 => out.push_str(&c.blood_in(&st.nodes).map_or(0, |b| b.0).to_string()),
                _ => out.push_str(&crate::edit::esc(&st.bandit)),
            }
        }
        Ok(out)
    }

    /// The main skill's part fed only by gear the build wears (Poisonous Concoction's "Life": damage from the worn life
    /// flask): the last part that scores what part 1 does on `st` with no gear, part 1 hitting. Stage and mode parts differ
    /// without gear and stay off. `None` until part 1 hits on the bare build (then (1, "") when no part is gear-fed).
    fn gear_fed_part(&self, st: &State) -> Option<(usize, String)> {
        let names: Vec<String> = gd::game_data().gems.get(self.main_gem).and_then(gd::gem_primary_effect).and_then(gd::parts).map(|a| a.iter().map(|p| p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string()).collect()).unwrap_or_default();
        if names.len() < 2 {
            return Some((1, String::new()));
        }
        let mut bare = st.clone();
        bare.gear = Arc::new(Gear { pieces: vec![None; self.slots.len()], sockets: Vec::new(), ..(*st.gear).clone() });
        bare.utils = Vec::new();
        let text = self.render(&bare).ok()?;
        let dps = |k: usize| eval_one(&mut None, &Cand::Xml(Arc::new(text.replacen("<Gem ", &format!("<Gem skillPart=\"{k}\" "), 1))), &["CombinedDPS"]).ok().and_then(|v| v[0]);
        let one = dps(1).filter(|d| *d > 0.0)?;
        Some((2..=names.len()).rev().find(|&k| dps(k).is_some_and(|d| (d - one).abs() <= 1e-9 * one)).map_or((1, String::new()), |k| (k, names[k - 1].clone())))
    }

    /// Withered stacks the build's Wither totem keeps up: min(15, casts a second x Withered duration x totems), read from
    /// the Wither group evaluated as the main skill (`None` when the build has none).
    pub(crate) fn wither_stacks(&self, xml: &str) -> Option<f64> {
        let groups: Vec<&str> = xml.split("<Skill ").skip(1).collect();
        // (a group no socket holds is written disabled: it keeps no stacks up)
        let names: Vec<String> = self.gems.iter().filter(|g| g.kind == Kind::Debuff && withering(g.id)).map(|g| format!("nameSpec=\"{}\"", g.name)).collect();
        let at = groups.iter().position(|g| !g.split('>').next().unwrap_or("").contains("enabled=\"false\"") && g.split("</Skill>").next().is_some_and(|g| names.iter().any(|n| g.contains(n.as_str()))))?;
        let x = set_tag_attr(xml, "Build", "mainSocketGroup", &(at + 1).to_string()).ok()?;
        let v = eval_one(&mut None, &Cand::Xml(Arc::new(x)), &["Speed", "Duration", "ActiveTotemLimit"]).ok()?;
        let totems = v[2].unwrap_or(1.0).max(1.0);
        Some((v[0]? * v[1]? * totems).clamp(0.0, 15.0))
    }

    /// Re-makes the state's base text and evaluates it (whole build).
    /// What `main` and `utils` cost to buy, in divine orbs: awakened and exceptional gems at their market price (other
    /// gems the player levels) and the main skill's links on the crafting bench.
    fn gems_cost(&self, main: &[&'static str], utils: &[&'static str]) -> f64 {
        let bought = |id: &str| gd::game_data().gems.get(id).is_some_and(|g| ["awakened", "exceptional"].iter().any(|t| g.tags.get(*t).copied().unwrap_or(false)));
        let gems: f64 = main.iter().copied().chain(utils.iter().flat_map(|u| u.split('+'))).filter(|id| bought(id)).filter_map(|id| Wealth::gem_price(&gem_name(id))).sum();
        gems + Wealth::links_divines(main.len())
    }

    /// Records the state's gem cost on its gear (`Gear::gems`).
    /// Also records the sockets they need (`Gear::sockets_need`; a Wither totem's group holds two gems).
    fn price_gems(&self, st: &mut State) {
        let c = self.gems_cost(&st.main, &st.utils);
        let n = st.main.len() + st.utils.iter().map(|u| if self.totemed(u) { 2 } else { u.split('+').count() }).sum::<usize>();
        let need = (n, st.main.len());
        let groups = self.gem_groups(&st.main, &st.utils);
        if (st.gear.gems - c).abs() > 1e-9 || st.gear.sockets_need != need || st.gear.groups != groups {
            let mut g = (*st.gear).clone();
            g.gems = c;
            g.sockets_need = need;
            g.groups = groups;
            st.gear = Arc::new(g);
        }
    }

    fn rebase(&self, st: &mut State) -> Result<(), String> {
        self.price_gems(st);
        if self.main_part.get().is_none() {
            if let Some(p) = self.gear_fed_part(st) {
                let _ = self.main_part.set(p);
            }
        }
        let mut text = self.render(st)?;
        if self.goal.assume.buffs && st.utils.iter().any(|u| self.wither_totem(u)) {
            if let Some(n) = self.wither_stacks(&text).filter(|n| (n - st.wither).abs() > 1e-9) {
                st.wither = n;
                text = self.render(st)?;
            }
        }
        let x = Arc::new(text);
        st.base = x.clone();
        let mut first = self.eval(vec![Cand::Xml(x.clone())]).pop();
        let mut x = x;
        if let Some(Some(v)) = first.as_ref() {
            // (charges from mana spent: the switch follows the evaluation's own cost)
            if self.unfed_charges(st, v).is_some() && self.unfed_charges(st, v) != self.unfed_charges(st, &st.vals).or(Some(false)) {
                let old = std::mem::replace(&mut st.vals, v.clone());
                let t = Arc::new(self.render(st)?);
                st.vals = old;
                if let Some(Some(v2)) = self.eval(vec![Cand::Xml(t.clone())]).pop() {
                    st.base = t.clone();
                    x = t;
                    first = Some(Some(v2));
                }
            }
        }
        if let Some(Some(v)) = first {
            st.base = self.with_crit_flag(&x, &v);
            let (s, viol) = self.score(&v);
            st.vals = v;
            st.score = s;
            st.viol = viol;
            self.settle(st);
        }
        Ok(())
    }

    /// The flask slots a whole evaluation counted (it turns unsustained flasks off).
    /// `xml` with the crit-recently switch the evaluation `v` of it settled on.
    fn with_crit_flag(&self, xml: &Arc<String>, v: &Vals) -> Arc<String> {
        let Some(i) = self.scorer.names.iter().position(|n| n == CRIT_RECENT) else { return xml.clone() };
        match v.get(i).copied().flatten() {
            Some(on) if (on > 0.5) != crit_flag_on(xml) => Arc::new(set_crit_flag(xml, on > 0.5)),
            _ => xml.clone(),
        }
    }

    fn flask_mask_of(&self, v: &Vals) -> Option<u8> {
        let i = self.scorer.names.iter().position(|n| n == FLASK_MASK)?;
        v.get(i).copied().flatten().map(|m| m as u8)
    }

    /// After a whole evaluation: the state keeps the flasks that evaluation counted, so its base text (and every
    /// node-list candidate made from it) has them.
    fn settle(&self, st: &mut State) {
        let Some(m) = self.flask_mask_of(&st.vals) else { return };
        if flask_flags(&st.base) != m {
            st.base = Arc::new(set_flask_flags(&st.base, m));
        }
        if st.gear.flask_mask != m {
            let mut g = (*st.gear).clone();
            g.flask_mask = m;
            st.gear = Arc::new(g);
        }
    }

    fn used(&self, st: &State) -> (usize, usize) {
        let c = &self.ctx[st.class];
        let granted: usize = st.nodes.iter().filter_map(|n| c.granted.get(n)).sum();
        let main = (st.nodes.iter().filter(|&&n| c.is_main(n)).count() + st.gear.cluster_nodes(&st.nodes).len()).saturating_sub(granted);
        // (a multiple-choice pick costs no point, as PassiveSpec counts them)
        let asc = st.nodes.iter().filter(|&&n| c.is_asc(n) && !c.is_option(n)).count();
        (main, asc)
    }

    fn publish(&mut self) {
        if !self.layers.iter().any(|(l, _)| *l == self.layer) {
            self.layers.push((self.layer.clone(), self.spent()));
        }
        let elapsed = self.elapsed();
        let evals = self.evals.load(Ordering::Relaxed);
        let results: Vec<Value> = self.archive.iter().enumerate().map(|(i, e)| self.entry_json(i, e)).collect();
        let snap = json!({
            "active": true,
            "done": false,
            "layer": self.layer,
            "layers": self.layers.iter().map(|(l, ms)| json!({ "layer": l, "atMs": ms })).collect::<Vec<_>>(),
            "candidate": self.current,
            "evaluations": evals,
            "elapsedMs": elapsed,
            "evalsPerSec": if elapsed > 0 { (evals as f64 * 1000.0 / elapsed as f64).round() } else { 0.0 },
            "threads": self.pool.threads,
            "budgetMs": self.budget_ms,
            "level": self.level,
            "passivePoints": self.points,
            "ascendancyPoints": self.asc_points,
            "assumptions": self.assumptions,
            "honestSummary": recheck::summary(self.archive.iter().filter_map(|e| e.honest.as_ref().and_then(|c| c.detail()))),
            "itemRules": self.goal.items,
            "prof": { "poolMs": self.prof_pool_us.load(Ordering::Relaxed) / 1000, "batches": self.prof_batches.load(Ordering::Relaxed) },
            "results": results,
            "leads": self.book.leads.iter().map(|l| json!({ "id": l.id, "label": l.label, "status": l.status.word(), "score": if l.best.is_finite() { json!(l.best) } else { Value::Null } })).collect::<Vec<_>>(),
            "baseline": self.baseline.map(|(d, e)| json!({ "dps": d, "ehp": e })),
            "pickMiss": self.picked.as_ref().map(|p| p.2),
        });
        let (m, cv) = &*self.shared;
        let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
        g.snapshot = snap;
        g.results = self.archive.iter().map(|e| e.xml.clone()).collect();
        for e in &self.archive {
            g.by_id.entry(e.id.clone()).or_insert_with(|| e.xml.clone());
        }
        g.version += 1;
        cv.notify_all();
    }

    /// The required-basics checklist for one result (solver_checklist.rs).
    fn checks_json(&self, e: &Entry) -> Vec<Value> {
        let mut checks = self.checks_for(&e.vals, &e.main, &e.utils, &e.xml);
        // (why the finish pass could not fill a missing basic: "no free socket", ...)
        for c in checks.iter_mut().filter(|c| c["status"] == "unmet") {
            let note = c["id"].as_str().and_then(|id| basics::note_for(&e.xml, id));
            c["note"] = json!(note);
        }
        checks
    }

    fn checks_for(&self, vals: &Vals, main: &[String], utils: &[String], xml: &str) -> Vec<Value> {
        // (an entry's gems are shown by name; "aura + Generosity" counts as the aura)
        let kind = |name: &str, k: Kind| self.gems.iter().any(|g| g.name == name.split(" + ").next().unwrap_or(name) && g.kind == k);
        let has = |k: Kind| main.iter().chain(utils).any(|u| kind(u, k));
        let set = |attr: &str| xml.find(attr).is_some_and(|i| !xml[i + attr.len()..].starts_with("None"));
        let facts = checklist::Facts { movement_skill: has(Kind::Movement), guard_skill: has(Kind::Guard), pantheon: set("pantheonMajorGod=\"") || set("pantheonMinorGod=\"") };
        let get = |n: &str| self.scorer.names.iter().position(|x| x == n).map(|k| Scorer::get(vals, k));
        checklist::report(&self.goal, &get, &facts)
    }

    /// The result row, marked `pick` / `extreme` once the final pick is made.
    fn entry_json(&self, i: usize, e: &Entry) -> Value {
        let mut j = self.entry_row(i, e);
        j["pick"] = json!(self.picked.as_ref().is_some_and(|p| p.0 == e.id));
        j["extreme"] = json!(self.picked.as_ref().is_some_and(|p| p.1.as_deref() == Some(e.id.as_str())));
        j
    }

    fn entry_row(&self, i: usize, e: &Entry) -> Value {
        let sc = &self.scorer;
        // The open build's numbers next to each result, so a result below it says so (it can be listed for meeting
        // limits the open build misses).
        let start = self.archive.iter().find(|a| a.start && !e.start);
        let mut below = false;
        let targets: Vec<Value> = sc
            .targets
            .iter()
            .map(|t| {
                let v = sc.target_value(t, &e.vals);
                // What the sidebar shows for the same stats once the build is applied: `value` also takes off the
                // warcry shouting time and the Mirage Archers that stay behind, so it can be lower.
                let shown = sc.shown_value(t, &e.vals);
                let sv = start.map(|s| sc.target_value(t, &s.vals));
                below |= sv.is_some_and(|s| v < s * (1.0 - 1e-3));
                json!({ "name": t.name, "metric": t.metric, "stats": t.stats.iter().map(|&k| sc.names[k].clone()).collect::<Vec<_>>(), "value": v, "shown": shown, "target": t.value, "met": t.value.is_none_or(|tv| v >= tv), "startValue": sv })
            })
            .collect();
        let defs = sc.deficits(&e.vals);
        let limits: Vec<Value> = sc
            .limits
            .iter()
            .zip(&defs)
            .map(|(l, d)| {
                let (value, need) = match &l.check {
                    Check::AtLeast(k, n) => (Scorer::get(&e.vals, *k), *n),
                    Check::AtMost(k, n) => (Scorer::get(&e.vals, *k), *n),
                    Check::Ge(a, b) => (a.iter().map(|&k| Scorer::get(&e.vals, k)).sum(), b.iter().map(|&k| Scorer::get(&e.vals, k)).sum()),
                };
                json!({ "name": l.name, "value": value, "need": need, "met": *d <= 0.0, "shortfall": d })
            })
            .collect();
        let worst = sc.limits.iter().zip(&defs).filter(|(_, d)| **d > 0.0).max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal));
        let blocking = if let Some((l, d)) = worst {
            json!({ "kind": "limit", "name": l.name, "shortfall": d })
        } else {
            let t = sc.targets.iter().filter_map(|t| t.value.map(|tv| (t, sc.target_value(t, &e.vals) / tv))).filter(|(_, r)| *r < 1.0).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            match t {
                Some((t, r)) => json!({ "kind": "target", "name": t.name, "reached": r }),
                None => Value::Null,
            }
        };
        json!({
            "index": i,
            "id": e.id,
            "xmlHash": e.id,
            "engine": env!("CARGO_PKG_VERSION"),
            "label": e.label,
            "className": e.class_name,
            "ascendancy": e.asc_name,
            "score": e.score,
            "targets": targets,
            "limits": limits,
            "limitsMet": e.viol <= 0.0,
            "checks": self.checks_json(e),
            "blocking": blocking,
            "points": e.points,
            "ascendancyPointsUsed": e.asc_points,
            "gems": { "main": e.main, "utility": e.utils },
            "items": self.gear_json(&e.gear),
            // (estimated, solver_wealth.rs: uniques at market price, rares by their mod tiers; the player's own items free)
            "costDivines": if e.start { 0.0 } else { self.gear_cost(&e.gear) },
            // (what of it the gems and links take, and the armour/jewellery slots left without a line: the end message names
            // the budget as the limit only when the gear, not a bare slot beside a luxury, holds it)
            "gemsDivines": e.gear.gems,
            "bareSlots": if e.start { 0 } else { self.bare_slots(&e.gear) },
            "lead": e.lead.as_ref().map(|l| json!({ "label": l })),
            "life": self.scorer.names.iter().position(|n| n == "Life").map(|k| Scorer::get(&e.vals, k)),
            "energyShield": self.scorer.names.iter().position(|n| n == "EnergyShield").map(|k| Scorer::get(&e.vals, k)),
            "bandit": e.bandit,
            "start": e.start,
            "belowStart": below,
            "assumptions": self.entry_assumptions(e),
            "bossBreakdown": self.boss_breakdown_text(e),
            "bossChips": e.boss_chips,
            "clear": e.clear,
            "honest": e.honest.as_ref().map(|c| c.json()),
            // (gain: what the part added to the beam's relaxed score, in the build the solver went on from)
            "parts": e.parts.iter().map(|(p, g)| json!({ "part": p, "gain": g })).collect::<Vec<_>>(),
            "configOn": e.switches.iter().map(|o| json!({ "key": o.key, "label": config::short_label(&o.label), "reason": o.reason, "player": o.player })).collect::<Vec<_>>(),
            "offers": e.offers.iter().map(|(o, d, t)| json!({ "key": o.key, "label": config::short_label(&o.label), "reason": o.reason, "delta": d, "text": t })).collect::<Vec<_>>(),
        })
    }

    /// The pack-clear breakdown of a result's text when a target scores clear ("Hits 5.0 of a 5-monster pack ...").
    fn clear_line(&mut self, xml: &str) -> Option<String> {
        // (Both: the clear side is scored on the mapping enemy, so its breakdown is read there too)
        let x = if self.goal.assume.mode() == PlayMode::Both { mode::mapping_text(xml) } else { xml.to_string() };
        (self.goal.assume.mode() == PlayMode::Mapping || self.scorer.targets.iter().any(|t| t.metric == "clear")).then(|| self.session.eval_xml(&x, false, clear::clear_text).ok().flatten()).flatten()
    }

    /// Adds the state (evaluated whole) to the trade-off set: constrained Pareto over the targets, at most eight.
    fn archive_add(&mut self, st: &State) -> Result<(), String> {
        self.archive_add_written(st).map(|_| ())
    }

    /// `archive_add`, returning what was written: the result text and its evaluation (vals, score, viol). None when
    /// nothing was listed (fake defence, already listed, dominated, main skill off, cancelled).
    pub(super) fn archive_add_written(&mut self, st: &State) -> Result<Option<(Arc<String>, Vals, f64, f64)>, String> {
        // (gear the game would not give its numbers to never becomes a result, whatever path made it)
        if self.fake_defence(&st.gear) {
            return Ok(None);
        }
        // A result spends every ascendancy point, past the time budget too.
        let filled;
        let st = if self.used(st).1 < self.asc_points && !self.cancel.load(Ordering::Relaxed) {
            let mut s = st.clone();
            let (layer, saved) = (self.layer.clone(), self.ignore_budget.replace(true));
            let r = self.grow(&mut s, true);
            self.ignore_budget.set(saved);
            self.layer = layer;
            r?;
            filled = s;
            &filled
        } else {
            st
        };
        // A result never spends more passive points than the goal grants.
        let trimmed;
        let st = if self.used(st).0 > self.points && !self.cancel.load(Ordering::Relaxed) {
            let mut s = st.clone();
            let saved = self.ignore_budget.replace(true);
            let r = self.trim(&mut s, false);
            self.ignore_budget.set(saved);
            r?;
            trimmed = s;
            &trimmed
        } else {
            st
        };
        let xml = Arc::new(self.render(st)?);
        if self.archive.iter().any(|e| *e.xml == *xml) {
            return Ok(None);
        }
        // (past the time budget too, so the last improvements still reach the results; a cancel stops it)
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        self.evals.fetch_add(1, Ordering::Relaxed);
        let Some(Some(vals)) = self.pool.eval(vec![Cand::Xml(xml.clone())], &self.names, &self.cancel).pop() else { return Ok(None) };
        // (a result the list already beats is not measured: its switches only lower it; a main skill switched off by its
        // own conditions is never a result)
        if self.dominated(&vals) || self.main_off(&vals) {
            return Ok(None);
        }
        // The free basics a player fills in himself (a movement and a guard skill, a pantheon), only for a result that
        // makes the list (solver_basics.rs): the filled build is measured again.
        let (basic, mut notes) = self.fill_basics(st)?;
        let st = basic.as_ref().unwrap_or(st);
        let names = |g: &[&'static str]| g.iter().map(|g| gem_name(g)).collect::<Vec<_>>();
        let base_text = if basic.is_some() { self.render(st)? } else { xml.to_string() };
        let (text, pantheon_notes) = self.fill_pantheon(base_text, &names(&st.main), &names(&st.utils))?;
        notes.extend(pantheon_notes);
        let (xml, vals) = if text != *xml {
            let x = Arc::new(text);
            match self.pool.eval(vec![Cand::Xml(x.clone())], &self.names, &self.cancel).pop() {
                Some(Some(v)) => (x, v),
                _ => (xml, vals),
            }
        } else {
            (xml, vals)
        };
        let (xml, vals, switches, offers) = self.settle_config(st, xml, vals);
        let (_, viol) = self.score(&vals);
        // Shown scores use the goal's own weights.
        let score = self.scorer.score(&vals, &self.scorer.targets.iter().map(|t| t.weight).collect::<Vec<_>>()).0;
        // (the result carries the flasks the evaluation counted)
        let xml = self.with_crit_flag(&xml, &vals);
        let (xml, gear) = match self.flask_mask_of(&vals) {
            Some(m) if m != flask_flags(&xml) => {
                let mut g = (*st.gear).clone();
                g.flask_mask = m;
                (Arc::new(set_flask_flags(&xml, m)), Arc::new(g))
            }
            _ => (xml, st.gear.clone()),
        };
        if self.archive.iter().any(|e| *e.xml == *xml) {
            return Ok(None);
        }
        basics::remember(&xml, notes);
        let clear = self.clear_line(&xml);
        let c = &self.ctx[st.class];
        let (points, asc_points) = self.used(st);
        let mut vals = vals;
        let boss_chips = self.boss_check(&xml, &mut vals);
        let (_, viol) = self.score(&vals);
        let score = self.scorer.score(&vals, &self.scorer.targets.iter().map(|t| t.weight).collect::<Vec<_>>()).0;
        let honest = Some(self.honest_check(&xml, &vals));
        let e = Entry { id: xml_hash(&xml), honest, boss_chips, clear, xml, vals, score, viol, label: c.label.clone(), class_name: c.class_name.clone(), asc_name: c.asc_name.clone(), points, asc_points, main: st.main.iter().map(|g| gem_name(g)).collect(), utils: st.utils.iter().map(|g| gem_name(g)).collect(), bandit: st.bandit.clone(), gear, start: false, parts: st.parts.clone(), switches, offers, lead: st.lead.and_then(|l| self.book.leads.get(l as usize)).map(|l| leads::worn_label(&l.label, &st.gear)) };
        let written = (e.xml.clone(), e.vals.clone(), e.score, e.viol);
        self.archive_insert(e);
        Ok(Some(written))
    }

    /// Evaluation `v` has the main skill switched off by its own conditions (`main_skill_off`).
    fn main_off(&self, v: &Vals) -> bool {
        self.names.iter().position(|n| n == MAIN_OFF).is_some_and(|i| Scorer::get(v, i) > 0.0)
    }

    /// Some listed result beats evaluation `v` (the archive's own dominance).
    fn dominated(&self, v: &Vals) -> bool {
        let sc = &self.scorer;
        let viol = self.score(v).1;
        let tv: Vec<f64> = sc.targets.iter().map(|t| sc.target_value(t, v)).collect();
        self.archive.iter().any(|a| {
            let (fa, fb) = (a.viol <= 0.0, viol <= 0.0);
            if fa != fb {
                return fa;
            }
            let va: Vec<f64> = sc.targets.iter().map(|t| sc.target_value(t, &a.vals)).collect();
            va.iter().zip(&tv).all(|(x, y)| x >= y) && a.viol <= viol && (va.iter().zip(&tv).any(|(x, y)| x > y) || a.viol < viol)
        })
    }

    /// The open build as it is, scored on the goal: a result, so the best result is never worse than it.
    fn archive_start(&mut self) -> Result<(), String> {
        let Some(x) = self.start_xml.clone() else { return Ok(()) };
        let xml = Arc::new(x);
        self.evals.fetch_add(1, Ordering::Relaxed);
        let Some(Some(vals)) = self.pool.eval(vec![Cand::Open(xml.clone())], &self.names, &self.cancel).pop() else { return Ok(()) };
        self.scorer.provisional_bars(&vals);
        let (_, viol) = self.score(&vals);
        let score = self.scorer.score(&vals, &self.scorer.targets.iter().map(|t| t.weight).collect::<Vec<_>>()).0;
        let xml = match self.flask_mask_of(&vals) {
            Some(m) if m != flask_flags(&xml) => Arc::new(set_flask_flags(&xml, m)),
            _ => xml,
        };
        let class_name = tag_attr(&xml, "Build", "className").unwrap_or_default();
        let asc_name = tag_attr(&xml, "Build", "ascendClassName").filter(|a| a != "None");
        let (mut points, mut asc_points) = (0, 0);
        if let Some((cid, aid, nodes, _)) = self.seed.clone() {
            let i = self.class_ctx(cid, aid)?;
            points = nodes.iter().filter(|&&n| self.ctx[i].is_main(n)).count();
            asc_points = nodes.iter().filter(|&&n| self.ctx[i].is_asc(n)).count();
        }
        let mut gear = Gear { pieces: self.player_pieces.clone(), ..Default::default() };
        gear.ready = true;
        let label = format!("Your build ({})", asc_name.clone().unwrap_or_else(|| class_name.clone()));
        let clear = self.clear_line(&xml);
        let e = Entry { id: xml_hash(&xml), honest: None, boss_chips: Vec::new(), clear, xml, vals, score, viol, label, class_name, asc_name, points, asc_points, main: Vec::new(), utils: Vec::new(), bandit: String::new(), gear: Arc::new(gear), start: true, parts: Arc::default(), switches: Vec::new(), offers: Vec::new(), lead: None };
        self.archive_insert(e);
        self.publish();
        Ok(())
    }

    fn archive_insert(&mut self, e: Entry) {
        let tv = |e: &Entry| -> Vec<f64> { self.scorer.targets.iter().map(|t| self.scorer.target_value(t, &e.vals)).collect() };
        // a dominates b: feasible beats infeasible, less shortfall beats more, then Pareto on the targets.
        let dominates = |a: &Entry, b: &Entry| -> bool {
            let (fa, fb) = (a.viol <= 0.0, b.viol <= 0.0);
            if fa != fb {
                return fa;
            }
            let (va, vb) = (tv(a), tv(b));
            let ge = va.iter().zip(&vb).all(|(x, y)| x >= y) && a.viol <= b.viol;
            let gt = va.iter().zip(&vb).any(|(x, y)| x > y) || a.viol < b.viol;
            ge && gt
        };
        // A feasible lead's best stays listed even when another lead's build dominates it, so the results differ by
        // lead (weapon, route, ascendancy), not only by trade-off.
        let other_lead = |a: &Entry, b: &Entry| a.viol <= 0.0 && a.lead.is_some() && a.lead != b.lead;
        if self.archive.iter().any(|a| dominates(a, &e)) {
            if e.lead.is_none() || e.viol > 0.0 || self.archive.iter().any(|a| a.lead == e.lead && a.score >= e.score) {
                return;
            }
            self.archive.retain(|a| a.lead != e.lead);
        }
        // (the open build stays listed as the reference)
        self.archive.retain(|a| a.start || !dominates(&e, a) || other_lead(a, &e));
        self.archive.push(e);
        if self.archive.len() > 8 {
            // Keep the best score and the best of each target, then the best scores.
            let n = self.scorer.targets.len();
            let mut keep: Vec<usize> = (0..self.archive.len()).filter(|&i| self.archive[i].start).collect();
            let best = (0..self.archive.len()).max_by(|&a, &b| self.archive[a].score.partial_cmp(&self.archive[b].score).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(0);
            if !keep.contains(&best) {
                keep.push(best);
            }
            for k in 0..n {
                if let Some(i) = (0..self.archive.len()).max_by(|&a, &b| tv(&self.archive[a])[k].partial_cmp(&tv(&self.archive[b])[k]).unwrap_or(std::cmp::Ordering::Equal)) {
                    if !keep.contains(&i) {
                        keep.push(i);
                    }
                }
            }
            let mut rest: Vec<usize> = (0..self.archive.len()).filter(|i| !keep.contains(i)).collect();
            rest.sort_by(|&a, &b| self.archive[b].score.partial_cmp(&self.archive[a].score).unwrap_or(std::cmp::Ordering::Equal));
            // (each lead's best before a second build of a lead already kept)
            let mut seen: Vec<Option<String>> = keep.iter().map(|&i| self.archive[i].lead.clone()).collect();
            let (firsts, seconds): (Vec<usize>, Vec<usize>) = rest.into_iter().partition(|&i| {
                let l = self.archive[i].lead.clone();
                let first = l.is_some() && !seen.contains(&l);
                if first {
                    seen.push(l);
                }
                first
            });
            keep.extend(firsts);
            keep.extend(seconds);
            keep.truncate(8);
            let mut old: Vec<Option<Entry>> = std::mem::take(&mut self.archive).into_iter().map(Some).collect();
            self.archive = keep.into_iter().filter_map(|i| old[i].take()).collect();
        }
        self.archive.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    }

    // ----- gem layer

    /// Evaluates gem setups (whole build texts) and returns the best that beats `st`, if any.
    fn try_setups(&self, st: &State, setups: Vec<(Vec<&'static str>, Vec<&'static str>)>) -> Result<Option<State>, String> {
        self.try_setups_with(st, setups, true)
    }

    fn try_setups_plain(&self, st: &State, setups: Vec<(Vec<&'static str>, Vec<&'static str>)>) -> Result<Option<State>, String> {
        self.try_setups_with(st, setups, false)
    }

    fn try_setups_with(&self, st: &State, setups: Vec<(Vec<&'static str>, Vec<&'static str>)>, repair: bool) -> Result<Option<State>, String> {
        let mut texts = Vec::new();
        let mut states = Vec::new();
        let mut dear = std::collections::HashSet::new();
        // (only as many totems as the build may have out at once)
        let totems = self.names.iter().position(|n| n == "ActiveTotemLimit").and_then(|i| st.vals.get(i).copied().flatten()).map_or(1, |v| (v as usize).max(1)).max(self.totem_count(&st.main, &st.utils));
        let granted = granted_skills(&st.gear);
        for (main, utils) in setups.into_iter().filter(|(m, u)| !self.mana_clash(m) && self.totem_count(m, u) <= totems && utils_ok(u, &granted)) {
            let mut s = st.clone();
            s.main = main;
            s.utils = utils;
            // (the goal's wealth budget covers the gems and links too)
            self.price_gems(&mut s);
            if !self.sockets_ok(&s.gear, Some(&st.gear)) {
                continue;
            }
            // (over budget: kept aside, measured with the full gear; a good one is tried against cheaper gear below)
            if !self.affordable(&s.gear, Some(&st.gear)) {
                if repair && s.gear.gems > st.gear.gems + 1e-9 {
                    dear.insert(states.len());
                    texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
                    states.push(s);
                }
                continue;
            }
            // A Wither totem keeps up the stacks its own cast rate gives, not the 15 a state starts with.
            let wither = |u: &[&'static str]| self.goal.assume.buffs && u.iter().any(|g| self.wither_totem(g));
            if wither(&s.utils) && !wither(&st.utils) {
                if let Some(n) = self.wither_stacks(&self.render(&s)?) {
                    s.wither = n;
                }
            }
            texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
            states.push(s);
        }
        let r = self.eval(texts.clone());
        let swap_def: Vec<Option<Vec<f64>>> = r.iter().map(|v| v.as_ref().map(|v| self.scorer.deficits(v))).collect();
        let mut best: Option<(f64, usize, Vals)> = None;
        let mut blocked: Vec<(f64, usize)> = Vec::new();
        let mut dear_scores: Vec<(f64, usize)> = Vec::new();
        for (i, v) in r.into_iter().enumerate() {
            let Some(v) = v else { continue };
            let (s, _) = self.score(&v);
            if dear.contains(&i) {
                dear_scores.push((s, i));
                continue;
            }
            if s > st.score + EPS && best.as_ref().is_none_or(|b| s > b.0) {
                best = Some((s, i, v.clone()));
            }
            let free = self.scorer.score_cost_free(&v, &self.weights);
            if free > st.score + EPS && free > s + EPS {
                blocked.push((free, i));
            }
        }
        // Budget goes where it buys the most score: a setup whose gems the budget cannot hold beside the gear (and that
        // beats what is kept) is weighed against the same build with one crafted piece stepped down to the cheaper
        // tiers that make room; the swap wins only when the gem gain outweighs the tiers lost.
        dear_scores.retain(|&(s, _)| s > best.as_ref().map_or(st.score, |b| b.0.max(st.score)) + EPS);
        dear_scores.sort_by(|a, b| b.0.total_cmp(&a.0));
        if !dear_scores.is_empty() && !self.stop() {
            let (mut sq_s, mut sq_t, mut sq_i) = (Vec::new(), Vec::new(), Vec::new());
            for &(_, i) in dear_scores.iter().take(3) {
                for k in 0..self.slots.len() {
                    let mut n = states[i].clone();
                    let mut g = (*n.gear).clone();
                    if !matches!(g.pieces[k].as_ref().map(|p| &p.design), Some(items::Design::Craft { .. })) || !self.step_to_budget(&mut g, k, &st.gear) || !self.sockets_ok(&g, Some(&st.gear)) {
                        continue;
                    }
                    n.gear = Arc::new(g);
                    sq_t.push(Cand::Xml(Arc::new(self.render(&n)?)));
                    sq_s.push(n);
                    sq_i.push(i);
                }
            }
            let kept = best.as_ref().map_or(st.score, |b| b.0.max(st.score));
            let mut win: Option<(f64, usize, Vals)> = None;
            for (j, v) in self.eval(sq_t.clone()).into_iter().enumerate() {
                let Some(v) = v else { continue };
                let (s, _) = self.score(&v);
                // (a failed limit is closed before damage is bought: no gem gain pays for a limit the swap met with the full gear and the stepped gear newly fails)
                let Some(old_def) = swap_def[sq_i[j]].as_ref() else { continue };
                let opens = self.scorer.deficits(&v).iter().zip(old_def).any(|(n, o)| *n > 1e-9 && *o <= 1e-9);
                if s > kept + EPS && !opens && win.as_ref().is_none_or(|w| s > w.0) {
                    win = Some((s, j, v));
                }
            }
            if let Some((s, j, v)) = win {
                let mut n = sq_s.swap_remove(j);
                if let Cand::Xml(x) = &sq_t[j] {
                    n.base = x.clone();
                }
                n.score = s;
                n.viol = self.score(&v).1;
                n.vals = v;
                self.settle(&mut n);
                return Ok(Some(n));
            }
        }
        // Setups that only the skill's cost holds back are tried again with a cost fixer: a support that lowers or
        // moves the cost (Inspiration, Lifetap, ...) in a free link or in place of another support, or a regeneration
        // aura (Clarity), the way a player keeps the supports and pays for them.
        if repair && best.is_none() && !blocked.is_empty() && !self.stop() {
            blocked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut fixed = Vec::new();
            for &(_, i) in blocked.iter().take(6) {
                let (main, utils) = (states[i].main.clone(), states[i].utils.clone());
                for &f in &self.fixers.0 {
                    if main.contains(&f) {
                        continue;
                    }
                    if main.len() < 6 {
                        let mut m = main.clone();
                        m.push(f);
                        fixed.push((m, utils.clone()));
                    } else {
                        for j in 1..main.len() {
                            if !self.required.contains(&main[j]) {
                                let mut m = main.clone();
                                m[j] = f;
                                fixed.push((m, utils.clone()));
                            }
                        }
                    }
                }
                for &u in &self.fixers.1 {
                    if !utils.contains(&u) {
                        let mut v = utils.clone();
                        v.push(u);
                        fixed.push((main.clone(), v));
                    }
                }
            }
            fixed.sort();
            fixed.dedup();
            let r = self.try_setups_plain(st, fixed)?;
            // (no fixer alone pays for it: `sustain_buy` tries the best one with regeneration bought on the tree and gear)
            if r.is_none() {
                let (free, i) = blocked[0];
                let mut b = self.blocked.borrow_mut();
                if b.as_ref().is_none_or(|(f, _)| free > *f) {
                    *b = Some((free, states[i].clone()));
                }
            }
            return Ok(r);
        }
        Ok(best.map(|(s, i, v)| {
            let mut n = states.swap_remove(i);
            if let Cand::Xml(x) = &texts[i] {
                n.base = x.clone();
            }
            n.score = s;
            n.viol = self.score(&v).1;
            n.vals = v;
            self.settle(&mut n);
            n
        }))
    }

    /// With a DPS target, the curses that raise the damage taken of the main skill's damage types (EHP comes from gear and tree, not curses).
    /// Read from the gems: the skill's damage-type tags against each curse's own resistance / damage-taken stats. None: no DPS target, or no curse fits the skill (defensive ones stay).
    fn damage_curses(&self) -> Option<Vec<&'static str>> {
        let dps = self.goal.targets.is_empty() || self.goal.targets.iter().any(|t| matches!(t.metric.trim(), "" | "combined" | "dps" | "hit" | "dot" | "boss" | "full"));
        if !dps {
            return None;
        }
        const TYPES: [&str; 5] = ["physical", "fire", "cold", "lightning", "chaos"];
        let gems = &gd::game_data().gems;
        let types: Vec<&str> = TYPES.iter().copied().filter(|t| gems.get(self.main_gem).is_some_and(|x| x.tags.get(*t).copied().unwrap_or(false))).collect();
        let hits = |id: &str| {
            let stats = gems.get(id).and_then(|g| g.granted_effect.as_ref()).map(|e| e.stats.as_slice()).unwrap_or(&[]);
            types.iter().any(|t| stats.iter().any(|s| *s == format!("base_{t}_damage_resistance_%") || *s == format!("{t}_damage_taken_+%") || (*s == "base_resist_all_elements_%" && matches!(*t, "fire" | "cold" | "lightning"))))
        };
        let v: Vec<&'static str> = self.gems.iter().filter(|g| g.kind == Kind::Curse && hits(g.id)).map(|g| g.id).collect();
        (!v.is_empty()).then_some(v)
    }

    /// Whether a utility gem (or an auto-fired one, by its root) is a curse the DPS goal turns down for a damage curse.
    fn defensive_curse(&self, id: &str, dmg: &Option<Vec<&'static str>>) -> bool {
        dmg.as_ref().is_some_and(|d| !d.contains(&util_root(id)) && self.gems.iter().any(|g| g.id == util_root(id) && g.kind == Kind::Curse))
    }

    /// The supports the main skill may take: no support that hands it to a trigger, trap, mine or totem
    /// (Cast when Stunned, Locus Mine, Trap, Spell Totem, ...) unless the goal requires it or the skill already is
    /// one; those make the calc assume events and throw rates instead of the player's own use.
    fn support_candidates(&self) -> Vec<&'static str> {
        let tag = |id: &str, t: &str| gd::game_data().gems.get(id).is_some_and(|g| g.tags.get(t).copied().unwrap_or(false));
        let delivery = |id: &str| ["trigger", "trap", "mine", "totem"].iter().any(|t| tag(id, t) && !tag(self.main_gem, t));
        self.gems.iter().filter(|g| g.kind == Kind::Support && g.id != self.main_gem && (!delivery(g.id) || self.required.contains(&g.id)) && (support_fits(g.id, self.main_gem) || self.required.contains(&g.id))).map(|g| g.id).collect()
    }

    /// Each support swapped for every other one (or dropped); the best swap that beats the state is kept.
    fn swap_supports(&mut self, st: &mut State, supports: &[&'static str]) -> Result<bool, String> {
        let mut improved = false;
        let mut i = 1;
        while i < st.main.len() && !self.stop() {
            if self.required.contains(&st.main[i]) {
                i += 1;
                continue;
            }
            let setups: Vec<_> = supports
                .iter()
                .filter(|s| !st.main.contains(s))
                .map(|s| {
                    let mut m = st.main.clone();
                    m[i] = s;
                    (m, st.utils.clone())
                })
                .chain(std::iter::once({
                    let mut m = st.main.clone();
                    m.remove(i);
                    (m, st.utils.clone())
                }))
                .collect();
            if let Some(n) = self.try_setups(st, setups)? {
                *st = n;
                improved = true;
            }
            i += 1;
        }
        Ok(improved)
    }

    /// The finished build's support swaps, run past the clock (a few hundred tries): the gem layer last ran before the
    /// tree and items matured, and a swap that pays on the finished build (a damage support the early weapon and tree
    /// scored low) was never tried again.
    fn final_support_swap(&mut self, st: &mut State) -> Result<bool, String> {
        let saved = self.ignore_budget.replace(true);
        self.layer = "final gems".into();
        let supports = self.support_candidates();
        let mut any = false;
        let r = (|| -> Result<(), String> {
            for _ in 0..3 {
                if !self.swap_supports(st, &supports)? {
                    break;
                }
                any = true;
            }
            Ok(())
        })();
        self.ignore_budget.set(saved);
        r?;
        Ok(any)
    }

    /// Gem setup: supports for the main skill up to a 6-link, then auras/heralds, a curse, a guard skill, a warcry and
    /// a movement skill, each kept only when the goal's score improves (the movement skill when it costs nothing).
    fn gem_layer(&mut self, st: &mut State, thorough: bool) -> Result<bool, String> {
        self.layer = "gems".into();
        self.publish();
        let mut improved = false;
        self.blocked.borrow_mut().take();
        // A second banner, or a gem for a skill the gear now grants, goes first (even when the score drops: the engine
        // would count what the player cannot run).
        let granted = granted_skills(&st.gear);
        if !utils_ok(&st.utils, &granted) {
            let mut u: Vec<&'static str> = Vec::new();
            for &x in &st.utils {
                let mut t = u.clone();
                t.push(x);
                if utils_ok(&t, &granted) {
                    u = t;
                }
            }
            st.utils = u;
            self.rebase(st)?;
            improved = true;
        }
        let supports = self.support_candidates();
        // Add supports.
        while st.main.len() < 6 && !self.stop() {
            let setups = supports.iter().filter(|s| !st.main.contains(s)).map(|s| {
                let mut m = st.main.clone();
                m.push(s);
                (m, st.utils.clone())
            });
            match self.try_setups(st, setups.collect())? {
                Some(n) => {
                    *st = n;
                    improved = true;
                }
                None => break,
            }
        }
        // Swap each support for every other one.
        if thorough {
            improved |= self.swap_supports(st, &supports)?;
        }
        // A support the cost alone held back gets its sustain bought before it is turned down (solver_basics.rs).
        improved |= self.sustain_buy(st)?;
        // A DPS goal wears the damage curse: a defensive one the log score preferred gives way to it.
        let dmg = self.damage_curses();
        if st.utils.iter().any(|u| !self.required.contains(u) && self.defensive_curse(u, &dmg)) {
            st.utils.retain(|u| self.required.contains(u) || !self.defensive_curse(u, &dmg));
            self.rebase(st)?;
            improved = true;
        }
        // Utility skills.
        for kind in [Kind::Aura, Kind::Curse, Kind::Guard, Kind::Utility, Kind::Debuff, Kind::MinionBuff, Kind::Golem] {
            let limit = match kind {
                Kind::Aura => 6,
                Kind::Debuff => 2,
                // the engine's golem limit once one is out (1, the game's base, before)
                Kind::Golem => self.scorer.names.iter().position(|n| n == GOLEM_LIMIT).and_then(|i| st.vals.get(i).copied().flatten()).map_or(1, |v| (v as usize).max(1)),
                _ => 1,
            };
            loop {
                if self.stop() {
                    break;
                }
                let have = st.utils.iter().filter(|u| self.gems.iter().any(|g| g.id == util_root(u) && g.kind == kind)).count();
                if have >= limit {
                    break;
                }
                let setups: Vec<_> = self
                    .gems
                    .iter()
                    .filter(|g| (g.kind == kind || (g.kind == Kind::Auto && self.gems.iter().any(|r| r.id == util_root(g.id) && r.kind == kind))) && g.id != self.main_gem && !self.defensive_curse(g.id, &dmg) && !st.utils.iter().any(|u| util_root(u) == util_root(g.id)))
                    .map(|g| {
                        let mut u = st.utils.clone();
                        u.push(g.id);
                        (st.main.clone(), u)
                    })
                    .collect();
                match self.try_setups(st, setups)? {
                    Some(n) => {
                        *st = n;
                        improved = true;
                    }
                    None => break,
                }
            }
        }
        // Each utility skill swapped for another of its kind (an aura taken early for the resistances gives way to one
        // that pays more once the items cover them, an aura to the same aura linked to Generosity, ...).
        if thorough {
            let mut i = 0;
            while i < st.utils.len() && !self.stop() {
                let u = st.utils[i];
                let kind = self.gems.iter().find(|g| g.id == u).map(|g| g.kind);
                if self.required.contains(&u) || kind.is_none_or(|k| k == Kind::Movement) {
                    i += 1;
                    continue;
                }
                let setups: Vec<_> = self
                    .gems
                    .iter()
                    .filter(|g| Some(g.kind) == kind && g.id != u && !self.defensive_curse(g.id, &dmg) && !st.utils.iter().enumerate().any(|(k, x)| k != i && util_root(x) == util_root(g.id)))
                    .map(|g| {
                        let mut v = st.utils.clone();
                        v[i] = g.id;
                        (st.main.clone(), v)
                    })
                    .collect();
                if let Some(n) = self.try_setups(st, setups)? {
                    *st = n;
                    improved = true;
                }
                i += 1;
            }
        }
        // A utility skill that no longer pays (a tree change moved the reservation) is dropped.
        if thorough && !st.utils.is_empty() {
            let setups: Vec<_> = (0..st.utils.len())
                .filter(|&i| !self.required.contains(&st.utils[i]) && !(checklist::movement_skill_hard(&self.goal) && self.moves(st.utils[i]) && !st.main.iter().chain(st.utils.iter()).enumerate().any(|(k, x)| k != st.main.len() + i && self.moves(x))))
                .map(|i| {
                    let mut u = st.utils.clone();
                    u.remove(i);
                    (st.main.clone(), u)
                })
                .collect();
            if let Some(n) = self.try_setups(st, setups)? {
                *st = n;
                improved = true;
            }
        }
        // A movement skill, when one costs the goal nothing.
        // (the main skill counts: Flicker Strike is one)
        let has_move = st.main.iter().chain(st.utils.iter()).any(|u| self.moves(u));
        if !has_move && !self.stop() {
            let moves: Vec<&'static str> = self.gems.iter().filter(|g| g.kind == Kind::Movement).map(|g| g.id).collect();
            let mut texts = Vec::new();
            let mut states = Vec::new();
            for m in moves {
                let mut s = st.clone();
                s.utils.push(m);
                self.price_gems(&mut s);
                if !self.sockets_ok(&s.gear, Some(&st.gear)) {
                    continue;
                }
                texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
                states.push(s);
            }
            let r = self.eval(texts.clone());
            let mut best: Option<(f64, usize, Vals)> = None;
            for (i, v) in r.into_iter().enumerate() {
                let Some(v) = v else { continue };
                let (s, viol) = self.score(&v);
                // (a movement skill the checklist requires is kept at a small cost, never at a new shortfall)
                if (s >= st.score - EPS || (checklist::movement_skill_hard(&self.goal) && viol <= st.viol + EPS)) && best.as_ref().is_none_or(|b| s > b.0) {
                    best = Some((s, i, v));
                }
            }
            if let Some((s, i, v)) = best {
                let mut n = states.swap_remove(i);
                if let Cand::Xml(x) = &texts[i] {
                    n.base = x.clone();
                }
                n.score = s;
                n.viol = self.score(&v).1;
                n.vals = v;
                self.settle(&mut n);
                *st = n;
            }
        }
        improved |= self.trim_pressed(st)?;
        Ok(improved)
    }

    // ----- tree layer

    /// Node-list candidates of `st`, scored; returns (score, vals) per candidate.
    fn eval_nodes(&self, st: &State, cands: &[(Vec<i64>, Option<(i64, i64)>)]) -> Vec<Option<(f64, f64, Vals)>> {
        let c = &self.ctx[st.class];
        let head: Vec<i64> = std::iter::once(c.root).chain(c.asc_root).collect();
        // A candidate that adds or drops a Withered-on-hit node gets the stacks its own tree keeps up (the base text has
        // the state's).
        let have: HashSet<i64> = st.nodes.iter().copied().collect();
        let withers = |n: i64| self.node_info(n).1.contains("inflict withered");
        let totem = if self.goal.assume.buffs && st.utils.iter().any(|u| self.wither_totem(u)) { st.wither } else { 0.0 };
        let list: Vec<Cand> = cands
            .iter()
            .map(|(nodes, m)| {
                let mut full = head.clone();
                full.extend(nodes.iter().copied());
                full.extend(st.gear.cluster_nodes(nodes));
                let set: HashSet<i64> = nodes.iter().copied().collect();
                let moved = self.goal.assume.ailments && (nodes.iter().any(|&n| !have.contains(&n) && withers(n)) || st.nodes.iter().any(|&n| !set.contains(&n) && withers(n)));
                let base = if moved { Arc::new(with_wither(&st.base, (totem + self.wither_on_hit(st, nodes, &st.vals)).min(15.0))) } else { st.base.clone() };
                Cand::Nodes { base, nodes: full, mastery: *m, pin: Vec::new() }
            })
            .collect();
        self.eval(list)
            .into_iter()
            .map(|v| {
                v.map(|v| {
                    let (s, viol) = self.score(&v);
                    (s, viol, v)
                })
            })
            .collect()
    }

    /// Spends free points: each step adds the path (to a notable or keystone up to six nodes away, a plain node up to
    /// two away, or a mastery with its best effect) with the best gain per point. `asc` works on the ascendancy.
    fn grow(&mut self, st: &mut State, asc: bool) -> Result<bool, String> {
        let mut improved = false;
        // (an empty ascendancy is measured whole first)
        if asc && !st.nodes.iter().any(|&n| self.ctx[st.class].is_asc(n) && self.ctx[st.class].blood_of(n).is_none()) && !self.stop() {
            improved |= self.asc_sets(st)?;
        }
        loop {
            if self.stop() {
                break;
            }
            if asc {
                improved |= self.pick_options(st)?;
            }
            let (used_main, used_asc) = self.used(st);
            let free = if asc { self.asc_points.saturating_sub(used_asc) } else { self.points.saturating_sub(used_main) };
            if free == 0 {
                break;
            }
            let c = &self.ctx[st.class];
            let alloc: HashSet<i64> = st.nodes.iter().copied().collect();
            let reach = c.bfs_avoiding(&alloc, asc, &self.avoid.borrow());
            let used_effects: HashSet<i64> = st.masteries.iter().filter(|(n, _)| alloc.contains(n)).map(|(_, e)| *e).collect();
            let downside = self.downside(st.class);
            let jewel = st.gear.pieces.iter().zip(&self.slots).any(|(p, d)| d.kind == SlotKind::TreeJewel && p.as_ref().is_some_and(|p| matches!(&p.design, items::Design::Craft { mods, .. } if !mods.is_empty())));
            let mut cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = Vec::new();
            let mut costs: Vec<usize> = Vec::new();
            let mut notable: Vec<bool> = Vec::new();
            let mut ids: Vec<(&i64, &(usize, i64))> = reach.iter().collect();
            ids.sort_unstable_by_key(|(id, _)| **id);
            let far = self.notable_reach.get().max(6);
            for (&id, &(d, _)) in ids {
                if d > free {
                    continue;
                }
                let kind = c.kind(id);
                if self.node_dead(st, id) {
                    continue;
                }
                let ok = match kind {
                    "Notable" | "Keystone" => d <= far,
                    "Normal" => d <= 2,
                    "Mastery" => d == 1,
                    // (with a tree jewel that has modifiers, or a jewel of its own there)
                    "Socket" => d <= 6 && (jewel || st.gear.sockets.iter().any(|x| x.node == id)),
                    _ => false,
                };
                if !ok {
                    continue;
                }
                let path = c.path_to(&reach, id);
                // (a cluster jewel's socket brings its passives along: they cost points too)
                let d = d + st.gear.cluster_nodes(&path).len();
                if d > free {
                    continue;
                }
                let mut nodes = st.nodes.clone();
                nodes.extend(path.iter().copied());
                if kind == "Mastery" {
                    for &e in &c.paths.nodes[&id].mastery_effects {
                        if !used_effects.contains(&e) && !downside.1.contains(&e) {
                            cands.push((nodes.clone(), Some((id, e))));
                            costs.push(d);
                            notable.push(false);
                        }
                    }
                } else {
                    // (a notable with a choice is offered with each pick too: the pick costs no point)
                    for o in if asc { c.options_of(id) } else { Vec::new() } {
                        let mut n = nodes.clone();
                        n.push(o);
                        cands.push((n, None));
                        costs.push(d);
                        notable.push(true);
                    }
                    cands.push((nodes, None));
                    costs.push(d);
                    notable.push(matches!(kind, "Notable" | "Keystone"));
                }
            }
            if cands.is_empty() {
                break;
            }
            let r = self.eval_nodes(st, &cands);
            let mut best: Option<(f64, usize)> = None;
            for (i, v) in r.iter().enumerate() {
                let Some((s, _, _)) = v else { continue };
                let gain = (s - st.score) / costs[i] as f64;
                // (every ascendancy point the goal grants is spent, even on a node that adds nothing)
                // (a tie goes to the notable: a plain node that adds nothing waits until no notable is within reach)
                if (gain > EPS || asc) && best.is_none_or(|b| gain > b.0 + EPS || (gain > b.0 - EPS && notable[i] && !notable[b.1])) {
                    best = Some((gain, i));
                }
            }
            if free <= PLAN_FREE {
                if let Some(i) = self.plan_pick(st, &cands, &costs, &r, free, asc) {
                    best = Some((0.0, i));
                }
            }
            let Some((_, i)) = best else { break };
            let (s, viol, v) = r[i].clone().unwrap();
            let (nodes, m) = cands.swap_remove(i);
            st.nodes = nodes;
            st.score = s;
            st.viol = viol;
            st.vals = v;
            if let Some((n, e)) = m {
                st.masteries.retain(|(x, _)| *x != n);
                st.masteries.push((n, e));
                // A mastery choice lives in the base text.
                self.rebase(st)?;
            }
            improved = true;
            self.publish();
        }
        Ok(improved)
    }

    /// With few points left, gain per point can spend them on two cheap picks and leave no room for one dearer pick
    /// worth more (an ascendancy's far notable, a damage cluster past a plain node). Plans of one pick, or two picks on
    /// separate nodes, that fit the free points are ranked by their gains added; the best few pairs are measured
    /// together. Returns the best plan's first pick (the larger gain), or None when no plan gains (ascendancy: none at all).
    fn plan_pick(&self, st: &State, cands: &[(Vec<i64>, Option<(i64, i64)>)], costs: &[usize], r: &[Option<(f64, f64, Vals)>], free: usize, asc: bool) -> Option<usize> {
        let k = st.nodes.len();
        let gain: Vec<f64> = r.iter().map(|v| v.as_ref().map_or(f64::NEG_INFINITY, |v| v.0 - st.score)).collect();
        let clash = |i: usize, j: usize| {
            let (a, b) = (&cands[i], &cands[j]);
            a.0[k..].iter().any(|n| b.0[k..].contains(n)) || matches!((a.1, b.1), (Some(x), Some(y)) if x.0 == y.0 || x.1 == y.1)
        };
        let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
        for i in 0..cands.len() {
            for j in i + 1..cands.len() {
                if gain[i].is_finite() && gain[j].is_finite() && costs[i] + costs[j] <= free && !(cands[i].1.is_some() && cands[j].1.is_some()) && !clash(i, j) {
                    pairs.push((gain[i] + gain[j], i, j));
                }
            }
        }
        pairs.sort_by(|a, b| b.0.total_cmp(&a.0));
        pairs.truncate(PLAN_TRIES);
        let joint: Vec<(Vec<i64>, Option<(i64, i64)>)> = pairs.iter().map(|&(_, i, j)| (cands[i].0.iter().chain(&cands[j].0[k..]).copied().collect(), cands[i].1.or(cands[j].1))).collect();
        let mut best: Option<(f64, usize)> = (0..cands.len()).filter(|&i| gain[i].is_finite()).map(|i| (gain[i], i)).max_by(|a, b| a.0.total_cmp(&b.0));
        for (&(_, i, j), v) in pairs.iter().zip(self.eval_nodes(st, &joint)) {
            let Some((s, _, _)) = v else { continue };
            if best.is_none_or(|b| s - st.score > b.0 + EPS) {
                best = Some((s - st.score, if gain[i] >= gain[j] { i } else { j }));
            }
        }
        best.filter(|b| asc || b.0 > EPS).map(|b| b.1)
    }

    /// An allocated ascendancy notable with a choice and no pick yet gets its best pick (it costs no point), unless every
    /// pick lowers the score.
    fn pick_options(&mut self, st: &mut State) -> Result<bool, String> {
        let c = &self.ctx[st.class];
        let alloc: HashSet<i64> = st.nodes.iter().copied().collect();
        let mut cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = Vec::new();
        for &p in &st.nodes {
            let opts = c.options_of(p);
            if opts.iter().any(|o| alloc.contains(o)) {
                continue;
            }
            for o in opts {
                let mut n = st.nodes.clone();
                n.push(o);
                cands.push((n, None));
            }
        }
        if cands.is_empty() {
            return Ok(false);
        }
        let r = self.eval_nodes(st, &cands);
        let best = r.into_iter().enumerate().filter_map(|(i, v)| v.map(|v| (i, v))).filter(|(_, v)| v.0 > st.score - EPS).max_by(|a, b| a.1 .0.total_cmp(&b.1 .0));
        let Some((i, (s, viol, v))) = best else { return Ok(false) };
        st.nodes = cands.swap_remove(i).0;
        st.score = s;
        st.viol = viol;
        st.vals = v;
        Ok(true)
    }

    /// The ascendancy is small enough to measure whole: every set of its notables that fills the points it has (paths
    /// from its start, each pick of a choice), the best kept when it beats the state's. Gain per point cannot see
    /// notables that pay only together (a node that pays during a flask, beside the nodes that keep the flask up).
    /// Bloodline nodes stay as they are. Returns whether the ascendancy changed.
    fn asc_sets(&mut self, st: &mut State) -> Result<bool, String> {
        let c = &self.ctx[st.class];
        let Some(root) = c.asc_root else { return Ok(false) };
        let mine = |n: i64| c.is_asc(n) && c.blood_of(n).is_none();
        // Each notable's path from the start (the ascendancy is a tree).
        let mut prev: HashMap<i64, i64> = HashMap::default();
        let mut q: VecDeque<i64> = VecDeque::from([root]);
        while let Some(u) = q.pop_front() {
            for &v in c.adj.get(&u).map_or(&[][..], |l| l.as_slice()) {
                if v != root && !prev.contains_key(&v) && mine(v) && c.allowed_asc(v) {
                    prev.insert(v, u);
                    q.push_back(v);
                }
            }
        }
        let path = |mut n: i64| {
            let mut p = vec![n];
            while let Some(&u) = prev.get(&n).filter(|&&u| u != root) {
                p.push(u);
                n = u;
            }
            p
        };
        let mut notables: Vec<(i64, Vec<i64>)> = prev.keys().copied().filter(|&n| c.kind(n) == "Notable" && !self.node_dead(st, n)).map(|n| (n, path(n))).collect();
        notables.sort_unstable();
        let keep: Vec<i64> = st.nodes.iter().copied().filter(|&n| !mine(n)).collect();
        let free = self.asc_points.saturating_sub(keep.iter().filter(|&&n| c.is_asc(n) && !c.is_option(n)).count());
        // Maximal sets (no other notable fits), by depth-first search over the notables in order.
        let mut sets: Vec<Vec<i64>> = Vec::new();
        let mut stack: Vec<(usize, Vec<i64>)> = vec![(0, Vec::new())];
        while let Some((from, set)) = stack.pop() {
            let fits = |p: &[i64]| set.len() + p.iter().filter(|n| !set.contains(n)).count() <= free;
            if !notables.iter().any(|(n, p)| !set.contains(n) && fits(p)) {
                sets.push(set.clone());
            }
            for (k, (n, p)) in notables.iter().enumerate().skip(from) {
                if !set.contains(n) && fits(p) {
                    let mut s2 = set.clone();
                    s2.extend(p.iter().copied().filter(|x| !set.contains(x)));
                    stack.push((k + 1, s2));
                }
            }
            if sets.len() > ASC_SETS_MAX {
                return Ok(false);
            }
        }
        sets.sort_unstable_by_key(|s| {
            let mut s = s.clone();
            s.sort_unstable();
            s
        });
        sets.dedup();
        // (each pick of a choice in the set)
        let mut cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = Vec::new();
        for set in sets {
            let mut full: Vec<Vec<i64>> = vec![keep.iter().copied().chain(set.iter().copied()).collect()];
            for &n in &set {
                let opts = c.options_of(n);
                if !opts.is_empty() {
                    full = full.into_iter().flat_map(|f| opts.iter().map(move |&o| f.iter().copied().chain([o]).collect())).collect();
                }
            }
            cands.extend(full.into_iter().map(|f| (f, None)));
        }
        if cands.len() > ASC_SETS_MAX {
            return Ok(false);
        }
        let r = self.eval_nodes(st, &cands);
        let best = r.into_iter().enumerate().filter_map(|(i, v)| v.map(|v| (i, v))).max_by(|a, b| a.1 .0.total_cmp(&b.1 .0));
        let Some((i, (s, viol, v))) = best.filter(|b| b.1 .0 > st.score + 1e-6) else { return Ok(false) };
        st.nodes = cands.swap_remove(i).0;
        st.score = s;
        st.viol = viol;
        st.vals = v;
        self.publish();
        Ok(true)
    }

    /// The slot a main-tree node opens for a gem the setup lacks, read from the engine modifiers of its lines: a curse
    /// slot (`EnemyCurseLimit`) or aura room (less reservation, more reservation efficiency).
    fn slot_kind(&self, id: i64) -> Option<Kind> {
        let text = self.node_info(id).1.clone();
        let names: Vec<String> = text.lines().flat_map(|l| pom_engine::modparser::parse_mod(l).0.unwrap_or_default().into_iter().map(|m| m.name)).collect();
        if names.iter().any(|n| n == "EnemyCurseLimit") {
            Some(Kind::Curse)
        } else if names.iter().any(|n| n.contains("Reserv")) {
            Some(Kind::Aura)
        } else {
            None
        }
    }

    /// Nodes that pay only with a gem the setup lacks (a second curse, another aura): alone they measure nothing, so
    /// gain per point never takes them. Each such notable or keystone within reach is tried as one move: the cheapest
    /// groups go back to pay for its path, every curse or aura the setup lacks is tried in, and what is left over is
    /// grown again. The best move is kept when it beats the state.
    fn slot_moves(&mut self, st: &mut State) -> Result<bool, String> {
        let c = &self.ctx[st.class];
        let alloc: HashSet<i64> = st.nodes.iter().copied().collect();
        let reach = c.bfs(&alloc, false);
        let mut targets: Vec<(usize, i64, Kind)> = reach.iter().filter(|(&id, &(d, _))| d <= 6 && matches!(c.kind(id), "Notable" | "Keystone")).filter_map(|(&id, &(d, _))| self.slot_kind(id).map(|k| (d, id, k))).filter(|&(_, id, _)| !self.node_dead(st, id)).collect();
        targets.sort_unstable_by_key(|t| (t.0, t.1));
        targets.truncate(SLOT_MOVES_MAX);
        if targets.is_empty() {
            return Ok(false);
        }
        let groups = self.removal_groups(st, false, 8);
        let gcands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(st, g).nodes, None)).collect();
        let r = self.eval_nodes(st, &gcands);
        let mut order: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().map(|v| ((st.score - v.0) / groups[i].len() as f64, i))).collect();
        order.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut best: Option<State> = None;
        for (d, id, kind) in targets {
            if self.stop() {
                break;
            }
            let c = &self.ctx[st.class];
            let path = c.path_to(&reach, id);
            let (used_main, _) = self.used(st);
            let mut need = (used_main + d).saturating_sub(self.points);
            let mut give: Vec<i64> = Vec::new();
            for &(_, gi) in &order {
                if need == 0 {
                    break;
                }
                if !groups[gi].iter().any(|x| give.contains(x)) {
                    give.extend(groups[gi].iter().copied());
                    need = need.saturating_sub(groups[gi].len());
                }
            }
            let mut s = Self::without(st, &give);
            s.nodes.extend(path.iter().copied());
            // (the path must still hang from the tree once the groups are gone)
            let set: HashSet<i64> = s.nodes.iter().copied().filter(|&x| c.is_main(x) || c.is_asc(x)).collect();
            let conn = c.connected(&set, false);
            if need > 0 || s.nodes.iter().any(|&x| c.is_main(x) && !conn.contains(&x)) {
                continue;
            }
            s.score = f64::NEG_INFINITY;
            self.rebase(&mut s)?;
            let setups: Vec<(Vec<&'static str>, Vec<&'static str>)> = self.gems.iter().filter(|g| g.kind == kind && !s.utils.contains(&g.id)).map(|g| (s.main.clone(), s.utils.iter().copied().chain([g.id]).collect())).collect();
            let Some(mut s2) = self.try_setups(&s, setups)? else { continue };
            self.grow(&mut s2, false)?;
            if s2.score > best.as_ref().map_or(st.score, |b| b.score) + 1e-6 {
                best = Some(s2);
            }
        }
        let Some(b) = best else { return Ok(false) };
        *st = b;
        self.publish();
        Ok(true)
    }

    /// Crafted mods the finished tree makes dead (crit lines under Resolute Technique, ...) are given back and the
    /// slot's affixes chosen again: the finished build keeps no line the engine counts for nothing.
    fn dead_mod_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let keystones = self.allocated_keystones(st);
        if keystones.is_empty() {
            return Ok(false);
        }
        let mut changed = false;
        for i in 0..st.gear.pieces.len().min(self.slots.len()) {
            let Some(items::Design::Craft { base, mods, anoint }) = st.gear.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
            let keep: Vec<usize> = mods.iter().copied().filter(|&m| !parts::line_is_dead(&keystones, &base.fams[m].lines.join("\n"))).collect();
            if keep.len() == mods.len() {
                continue;
            }
            let piece = items::craft_piece(&base, keep, anoint, self.item_level);
            if let Some(g) = self.with_piece(&st.gear, i, Some(piece)) {
                st.gear = Arc::new(g);
                changed = true;
            }
        }
        if changed {
            let saved = self.ignore_budget.replace(true);
            let r = self.rebase(st).and_then(|_| self.items_layer(st, false).map(|_| ()));
            self.ignore_budget.set(saved);
            r?;
        }
        Ok(changed)
    }

    /// The finish's honesty pass: the ailments the build applies read again from the engine (a support taken late,
    /// such as one with `cannot_inflict_status_ailments`, can stop the main skill applying them, and their conditions
    /// go), pressed skills trimmed to the cap with blessings counted, then dead pieces given back.
    fn finish_checks(&mut self, st: &mut State) -> Result<(), String> {
        let saved = self.ignore_budget.replace(true);
        let r = self.assume_ailments(st).and_then(|_| self.trim_pressed(st));
        self.ignore_budget.set(saved);
        r?;
        self.dead_piece_pass(st)?;
        Ok(())
    }

    /// A movement skill by its game tags (a main skill like Flicker Strike counts: the setup needs no second one). A
    /// support with the tag (Minion Speed) moves no player.
    fn moves(&self, id: &str) -> bool {
        gd::game_data().gems.get(util_root(id)).is_some_and(|g| !gd::gem_primary_effect(g).is_some_and(gd::is_support) && gem_kind(g, false) == Kind::Movement)
    }

    /// Pieces the finished build carries for nothing: a utility or support gem, a passive group or a crafted mod whose
    /// removal moves no target, limit or checklist score (measured by removal, engine-driven). Each is given back, one
    /// at a time and checked again, and the freed points are spent where they gain. The only movement skill stays
    /// (the checklist asks for one); gems the goal requires stay.
    fn dead_piece_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let saved = self.ignore_budget.replace(true);
        let r = self.dead_piece_inner(st);
        self.ignore_budget.set(saved);
        r
    }

    fn dead_piece_inner(&mut self, st: &mut State) -> Result<bool, String> {
        let same = |t: &State, cur: &State| t.score >= cur.score - EPS && t.viol <= cur.viol + EPS;
        let mut cur = st.clone();
        // Gems: utilities, then the main link's supports.
        let utils: Vec<&'static str> = cur.utils.clone();
        for u in utils {
            let others_move = cur.main.iter().chain(cur.utils.iter()).any(|x| *x != u && self.moves(x));
            if self.required.contains(&u) || (self.moves(u) && !others_move) {
                continue;
            }
            let mut t = cur.clone();
            t.utils.retain(|x| *x != u);
            t.score = f64::NEG_INFINITY;
            self.rebase(&mut t)?;
            if same(&t, &cur) {
                cur = t;
            }
        }
        let sups: Vec<&'static str> = cur.main.iter().skip(1).copied().collect();
        for g in sups {
            if self.required.contains(&g) {
                continue;
            }
            let mut t = cur.clone();
            t.main.retain(|x| *x != g);
            t.score = f64::NEG_INFINITY;
            self.rebase(&mut t)?;
            if same(&t, &cur) {
                cur = t;
            }
        }
        // Passive groups (a node and what only it holds on): screened in one batch, then given back one at a time.
        let groups = self.removal_groups(&cur, false, 8);
        let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(&cur, g).nodes, None)).collect();
        let r = self.eval_nodes(&cur, &cands);
        let mut freed = false;
        for (g, v) in groups.iter().zip(r) {
            let Some((s, viol, _)) = v else { continue };
            if s < cur.score - EPS || viol > cur.viol + EPS || !g.iter().all(|n| cur.nodes.contains(n)) {
                continue;
            }
            let mut t = Self::without(&cur, g);
            // (an earlier removal can leave this one stranding a node)
            let c = &self.ctx[t.class];
            let set: HashSet<i64> = t.nodes.iter().copied().filter(|&n| c.is_main(n) || c.is_asc(n)).collect();
            let conn = c.connected(&set, false);
            if t.nodes.iter().any(|&n| c.is_main(n) && !conn.contains(&n)) {
                continue;
            }
            t.score = f64::NEG_INFINITY;
            self.rebase(&mut t)?;
            if same(&t, &cur) {
                cur = t;
                freed = true;
            }
        }
        if freed {
            self.grow(&mut cur, false)?;
        }
        // Crafted mods (a unique's lines come with it).
        for i in 0..cur.gear.pieces.len().min(self.slots.len()) {
            let Some(items::Design::Craft { base, mods, anoint }) = cur.gear.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
            let mut keep = mods.clone();
            for m in mods {
                let k: Vec<usize> = keep.iter().copied().filter(|&x| x != m).collect();
                let Some(g) = self.with_piece(&cur.gear, i, Some(items::craft_piece(&base, k.clone(), anoint.clone(), self.item_level))) else { continue };
                let mut t = cur.clone();
                t.gear = Arc::new(g);
                t.score = f64::NEG_INFINITY;
                self.rebase(&mut t)?;
                if same(&t, &cur) {
                    cur = t;
                    keep = k;
                }
            }
        }
        let changed = cur.main != st.main || cur.utils != st.utils || cur.nodes != st.nodes || !Arc::ptr_eq(&cur.gear, &st.gear);
        if changed {
            *st = cur;
        }
        Ok(changed)
    }

    /// Keystones the finished build cannot use. Resolute Technique with crit gear: the build is tried without it, its
    /// gear made again, and the engine's DPS picks. Mind over Matter without the mana to draw on: given back
    /// (the engine's EHP counts mana the skills spend), unless that costs more than a tenth of the score.
    fn keystone_review(&mut self, st: &mut State) -> Result<bool, String> {
        let saved = self.ignore_budget.replace(true);
        let r = self.keystone_review_inner(st);
        self.ignore_budget.set(saved);
        r
    }

    fn keystone_review_inner(&mut self, st: &mut State) -> Result<bool, String> {
        let stat = |s: &Solver, st: &State, n: &str| s.names.iter().position(|x| x == n).and_then(|i| st.vals.get(i).copied().flatten());
        let mut changed = false;
        for name in ["Resolute Technique", "Mind over Matter"] {
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            let Some(id) = st.nodes.iter().copied().find(|&n| self.node_info(n).0.eq_ignore_ascii_case(name)) else { continue };
            let mom = name == "Mind over Matter";
            // (Mind over Matter draws 40% of the damage from unreserved mana: worth having with a third of the life in mana)
            if mom && stat(self, st, "ManaUnreserved").zip(stat(self, st, "Life")).is_none_or(|(m, l)| m >= l / 3.0) {
                continue;
            }
            let Some(group) = self.removal_groups(st, false, 12).into_iter().find(|g| g.contains(&id)) else { continue };
            self.banned.borrow_mut().insert(id);
            let mut s = Self::without(st, &group);
            self.rebase(&mut s)?;
            self.grow(&mut s, false)?;
            if !mom {
                self.items_layer(&mut s, false)?;
                self.grow(&mut s, false)?;
            }
            let ok = if mom { s.score > st.score - 0.1 && s.viol <= st.viol + 1e-9 } else { s.score > st.score + 1e-6 };
            if ok {
                *st = s;
                changed = true;
            } else {
                self.banned.borrow_mut().remove(&id);
            }
        }
        Ok(changed)
    }

    /// A result that misses a limit by a little (72 of 75 lightning resistance) gets one more pass with the shortfall
    /// weighted up, gear first, then tree; what stays short is reported by the result's limits.
    fn repair_limits(&mut self, st: &mut State) -> Result<(), String> {
        self.repair_limits_with(st, &[10.0, 100.0], true)
    }

    /// `repair_limits` at these penalty factors; `past_budget`: it may run past the time budget.
    fn repair_limits_with(&mut self, st: &mut State, factors: &[f64], past_budget: bool) -> Result<(), String> {
        if st.viol <= 1e-9 || self.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let (penalty, saved) = (self.scorer.penalty, if past_budget { self.ignore_budget.replace(true) } else { self.ignore_budget.get() });
        let r = (|| -> Result<(), String> {
            for &k in factors {
                self.scorer.penalty = penalty * k;
                self.rebase(st)?;
                // (sustain gems first: an aura or support that pays a failed life or mana limit, solver_basics.rs)
                if !self.stop() {
                    self.sustain_gems(st)?;
                }
                self.items_layer(st, false)?;
                self.refine_tree(st, false)?;
                if st.viol <= 1e-9 {
                    break;
                }
            }
            Ok(())
        })();
        self.scorer.penalty = penalty;
        let r2 = self.rebase(st);
        self.ignore_budget.set(saved);
        r.and(r2)
    }

    /// The groups the tree can give back: a node and everything only it holds on, at most `max` nodes.
    fn removal_groups(&self, st: &State, asc: bool, max: usize) -> Vec<Vec<i64>> {
        let c = &self.ctx[st.class];
        let mine: Vec<i64> = st.nodes.iter().copied().filter(|&n| if asc { c.is_asc(n) } else { c.is_main(n) }).collect();
        // (the main tree's extra starts are ascendancy nodes: they stay in the set)
        let set: HashSet<i64> = if asc { mine.iter().copied().collect() } else { st.nodes.iter().copied().filter(|&n| c.is_main(n) || c.is_asc(n)).collect() };
        let mut out: Vec<Vec<i64>> = Vec::new();
        let mut seen: HashSet<Vec<i64>> = HashSet::default();
        for &x in &mine {
            let mut s = set.clone();
            s.remove(&x);
            let conn = c.connected(&s, asc);
            let mut g: Vec<i64> = mine.iter().copied().filter(|n| *n == x || !conn.contains(n)).collect();
            g.sort_unstable();
            if g.len() <= max && seen.insert(g.clone()) {
                out.push(g);
            }
        }
        out
    }

    fn without(st: &State, g: &[i64]) -> State {
        let mut s = st.clone();
        s.nodes.retain(|n| !g.contains(n));
        s
    }

    /// Trims a tree that has more points than the goal allows (a player's tree on a lower level), cheapest first.
    fn trim(&mut self, st: &mut State, asc: bool) -> Result<(), String> {
        loop {
            let (m, a) = self.used(st);
            let over = if asc { a > self.asc_points } else { m > self.points };
            if !over || self.stop() {
                return Ok(());
            }
            let groups = self.removal_groups(st, asc, 1);
            let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(st, g).nodes, None)).collect();
            let r = self.eval_nodes(st, &cands);
            let best = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().map(|v| (v.0, i))).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let Some((_, i)) = best else { return Ok(()) };
            let (s, viol, v) = r[i].clone().unwrap();
            st.nodes = cands[i].0.clone();
            st.score = s;
            st.viol = viol;
            st.vals = v;
        }
    }

    /// Point-neutral swaps: give back the group that costs the least, spend the points again with `grow`, keep it when
    /// the goal's score improves. Also re-picks mastery effects. Returns whether anything improved.
    fn refine_tree(&mut self, st: &mut State, asc: bool) -> Result<bool, String> {
        self.layer = if asc { "ascendancy".into() } else { "tree".into() };
        let mut improved = asc && !self.stop() && self.asc_sets(st)?;
        let mut rounds = 0;
        while !self.stop() && rounds < 40 {
            rounds += 1;
            let groups = self.removal_groups(st, asc, if asc { 4 } else { 8 });
            if groups.is_empty() {
                break;
            }
            let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(st, g).nodes, None)).collect();
            let r = self.eval_nodes(st, &cands);
            let mut order: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().map(|v| ((st.score - v.0) / groups[i].len() as f64, i))).collect();
            order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut took = false;
            for &(_, gi) in order.iter().take(if asc { 4 } else { 6 }) {
                if self.stop() {
                    break;
                }
                let (s0, viol0, v0) = r[gi].clone().unwrap();
                let mut s = Self::without(st, &groups[gi]);
                s.score = s0;
                s.viol = viol0;
                s.vals = v0;
                self.grow(&mut s, asc)?;
                if s.score > st.score + 1e-6 {
                    *st = s;
                    took = true;
                    improved = true;
                    self.publish();
                    break;
                }
            }
            // No one group frees enough for a pick further away (a damage cluster past the defence the gear now covers,
            // an ascendancy's far notable): the cheapest groups go back together, and what that strands with them.
            if !took && !self.stop() {
                let want = if asc { 4 } else { 14 };
                let mut give: Vec<i64> = Vec::new();
                let mut n = 0;
                for &(_, gi) in &order {
                    if give.len() >= want {
                        break;
                    }
                    if !groups[gi].iter().any(|x| give.contains(x)) {
                        give.extend(groups[gi].iter().copied());
                        n += 1;
                    }
                }
                if n >= 2 {
                    let mut s = Self::without(st, &give);
                    let c = &self.ctx[s.class];
                    let set: HashSet<i64> = s.nodes.iter().copied().filter(|&x| c.is_main(x) || c.is_asc(x)).collect();
                    let conn = c.connected(&set, asc);
                    s.nodes.retain(|&x| !(if asc { c.is_asc(x) } else { c.is_main(x) }) || conn.contains(&x));
                    s.score = f64::NEG_INFINITY;
                    self.rebase(&mut s)?;
                    self.grow(&mut s, asc)?;
                    if s.score > st.score + 1e-6 {
                        *st = s;
                        took = true;
                        improved = true;
                        self.publish();
                    }
                }
            }
            if !took {
                break;
            }
        }
        if !asc && !self.stop() {
            improved |= self.slot_moves(st)?;
        }
        // Mastery effects.
        if !asc && !self.stop() {
            let c = &self.ctx[st.class];
            let alloc: HashSet<i64> = st.nodes.iter().copied().collect();
            let used: HashSet<i64> = st.masteries.iter().filter(|(n, _)| alloc.contains(n)).map(|(_, e)| *e).collect();
            let mut cands = Vec::new();
            let downside = self.downside(st.class);
            for &(n, cur) in st.masteries.iter().filter(|(n, _)| alloc.contains(n)) {
                for &e in c.paths.nodes.get(&n).map_or(&[][..], |x| x.mastery_effects.as_slice()) {
                    if e != cur && !used.contains(&e) && !downside.1.contains(&e) {
                        cands.push((st.nodes.clone(), Some((n, e))));
                    }
                }
            }
            let r = self.eval_nodes(st, &cands);
            let best = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().map(|v| (v.0, i))).filter(|(s, _)| *s > st.score + 1e-6).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            if let Some((_, i)) = best {
                let (n, e) = cands[i].1.unwrap();
                st.masteries.retain(|(x, _)| *x != n);
                st.masteries.push((n, e));
                self.rebase(st)?;
                improved = true;
            }
        }
        Ok(improved)
    }

    // ----- bandit

    /// "Kill all" gives a passive point; each other bandit is tried with the tree's cheapest node given back.
    fn bandit_pass(&mut self, st: &mut State) -> Result<(), String> {
        if self.goal.bandit.is_some() || self.goal.passive_points.is_some() || self.stop() {
            return Ok(());
        }
        self.layer = "bandit".into();
        let groups = self.removal_groups(st, false, 1);
        let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(st, g).nodes, None)).collect();
        let r = self.eval_nodes(st, &cands);
        let Some((_, i)) = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().map(|v| (v.0, i))).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)) else { return Ok(()) };
        let mut texts = Vec::new();
        let mut states = Vec::new();
        for b in ["Oak", "Kraityn", "Alira"] {
            let mut s = Self::without(st, &groups[i]);
            s.bandit = b.into();
            texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
            states.push(s);
        }
        let r = self.eval(texts.clone());
        let mut best: Option<(f64, usize, Vals)> = None;
        for (k, v) in r.into_iter().enumerate() {
            let Some(v) = v else { continue };
            let (s, _) = self.score(&v);
            if s > st.score + EPS && best.as_ref().is_none_or(|b| s > b.0) {
                best = Some((s, k, v));
            }
        }
        if let Some((s, k, v)) = best {
            let mut n = states.swap_remove(k);
            if let Cand::Xml(x) = &texts[k] {
                n.base = x.clone();
            }
            n.score = s;
            n.viol = self.score(&v).1;
            n.vals = v;
            self.settle(&mut n);
            *st = n;
            self.points -= 1;
        }
        Ok(())
    }

    // ----- driver

    /// The shortest tree from the class start to the goal's keystones (by name, read from the tree data) in context
    /// `class`; a name that is not a keystone of this tree is skipped.
    fn keystone_seed(&self, class: usize) -> Vec<i64> {
        if let Some(v) = self.keystone_memo.borrow().get(&class) {
            return v.clone();
        }
        let c = &self.ctx[class];
        let ids: Vec<i64> = crate::cached_tree(&tag_attr(&c.xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into()))
            .map(|tree| {
                tree.nodes
                    .iter()
                    .filter(|(id, n)| c.kind(**id) == "Keystone" && n.get("name").and_then(|v| v.as_str()).is_some_and(|name| self.goal.keystones.iter().any(|k| k.trim().eq_ignore_ascii_case(name))))
                    .map(|(id, _)| *id)
                    .collect()
            })
            .unwrap_or_default();
        let v: Vec<i64> = if ids.is_empty() { Vec::new() } else { c.tree_for(&ids, &[]).map(|t| t.into_iter().filter(|&n| c.is_main(n)).collect()).unwrap_or_default() };
        self.keystone_memo.borrow_mut().insert(class, v.clone());
        v
    }

    fn initial_state(&mut self, class: usize, gems: Option<(Vec<&'static str>, Vec<&'static str>)>, gear: Option<Arc<Gear>>) -> Result<State, String> {
        let (main, utils) = gems.unwrap_or_else(|| {
            let mut m = vec![self.main_gem];
            let mut u = Vec::new();
            for &r in &self.required {
                if self.gems.iter().any(|g| g.id == r && g.kind == Kind::Support) || gd::game_data().gems.get(r).and_then(gd::gem_primary_effect).is_some_and(gd::is_support) {
                    m.push(r);
                } else {
                    u.push(r);
                }
            }
            (m, u)
        });
        let c = &self.ctx[class];
        let (mut nodes, mut masteries) = (Vec::new(), Vec::new());
        if let Some((cid, aid, n, m)) = &self.seed {
            if *cid == c.class_id && *aid == c.asc_id {
                nodes = n.iter().copied().filter(|&x| c.is_main(x) || c.is_asc(x)).collect();
                masteries = m.clone();
            }
        }
        if nodes.is_empty() && !self.goal.keystones.is_empty() {
            nodes = self.keystone_seed(class);
        }
        let gear = gear.unwrap_or_else(|| self.start_gear.clone());
        let mut st = State { class, nodes, masteries, main, utils, bandit: self.goal.bandit.clone().unwrap_or_else(|| "None".into()), gear, base: Arc::new(String::new()), vals: Vec::new(), score: f64::NEG_INFINITY, viol: 0.0, parts: Arc::default(), wither: 15.0, lead: None, gem_levels: Vec::new() };
        self.rebase(&mut st)?;
        Ok(st)
    }

    /// The enemy ailments the main skill does damage with in this build text (its DPS above zero), as `AILMENTS`
    /// bits; 0 when the goal does not assume ailments. Shock and chill need an effect value too, so they are left as
    /// the build has them.
    pub(super) fn ailment_mask(&mut self, xml: &str) -> Result<u8, String> {
        if !self.goal.assume.ailments {
            return Ok(0);
        }
        let names: Vec<&str> = AILMENTS.iter().map(|a| a.2).collect();
        let v = self.session.eval_xml_stats(xml, &names, false)?;
        Ok((0..AILMENTS.len()).filter(|&k| v[k].unwrap_or(0.0) > 0.0).fold(0, |m, k| m | (1 << k)))
    }

    /// `st` moved to the context of its class with the ailments its build applies assumed (re-evaluated when that
    /// changes the context). Each lead gets its own: a bleed lead never counts "enemy poisoned".
    pub(super) fn assume_ailments(&mut self, st: &mut State) -> Result<(), String> {
        let mask = self.ailment_mask(&st.base.clone())?;
        let (cid, aid) = (self.ctx[st.class].class_id, self.ctx[st.class].asc_id);
        let ci = self.class_ctx_with(cid, aid, mask)?;
        if ci != st.class {
            st.class = ci;
            self.rebase(st)?;
        }
        Ok(())
    }

    /// Gems, ascendancy and tree in turn until none of them improves.
    fn converge(&mut self, st: &mut State) -> Result<(), String> {
        loop {
            if self.stop() {
                return Ok(());
            }
            let mut any = self.gem_layer(st, true)?;
            self.archive_add(st)?;
            any |= self.items_layer(st, true)?;
            self.archive_add(st)?;
            any |= self.refine_tree(st, true)?;
            any |= self.refine_tree(st, false)?;
            self.archive_add(st)?;
            self.publish();
            if !any {
                return Ok(());
            }
        }
    }

    /// One kick turn of a final: every chain kicks once from its own state with its own seed, grows and refines again,
    /// and keeps the result when it beats that chain. Kicks of three kinds in turn: a fifth of the tree, two fifths, or
    /// one item made again (then a small tree kick).
    fn kick_turn(&mut self, chains: &mut [(State, u64)], round: usize) -> Result<(), String> {
        self.layer = "kick".into();
        for c in 0..chains.len() {
            let (from, mut crng) = chains[c].clone();
            let r = round + c;
            let mut s = match r % 4 {
                2 => {
                    crng ^= crng << 13;
                    crng ^= crng >> 7;
                    crng ^= crng << 17;
                    let s = self.item_kick(&from, crng)?;
                    self.kick(&s, &mut crng, 1)?
                }
                3 => self.kick(&from, &mut crng, 2)?,
                _ => self.kick(&from, &mut crng, 1)?,
            };
            chains[c].1 = crng;
            self.grow(&mut s, true)?;
            self.grow(&mut s, false)?;
            self.refine_tree(&mut s, false)?;
            if r % 3 == 0 {
                self.gem_layer(&mut s, true)?;
            }
            if r % 3 == 1 {
                self.items_layer(&mut s, false)?;
            }
            if s.score > from.score + 1e-6 {
                self.converge(&mut s)?;
                chains[c].0 = s;
            }
        }
        Ok(())
    }

    /// `st` with about a fifth of its passive points given back in random removable groups, and one ascendancy group
    /// one time in three.
    fn kick(&mut self, st: &State, rng: &mut u64, size: usize) -> Result<State, String> {
        let mut next = || {
            *rng ^= *rng << 13;
            *rng ^= *rng >> 7;
            *rng ^= *rng << 17;
            *rng
        };
        let mut s = st.clone();
        let want = (self.points / 5).max(3) * size;
        let mut freed = 0;
        while freed < want {
            let groups = self.removal_groups(&s, false, 8);
            if groups.is_empty() {
                break;
            }
            let g = &groups[(next() % groups.len() as u64) as usize];
            freed += g.len();
            s = Self::without(&s, g);
        }
        if next() % 3 == 0 {
            let groups = self.removal_groups(&s, true, 4);
            if !groups.is_empty() {
                let g = groups[(next() % groups.len() as u64) as usize].clone();
                s = Self::without(&s, &g);
            }
        }
        let r = self.eval_nodes(&s, &[(s.nodes.clone(), None)]);
        if let Some(Some((sc, viol, v))) = r.into_iter().next() {
            s.score = sc;
            s.viol = viol;
            s.vals = v;
        }
        Ok(s)
    }

    fn run(&mut self) -> Result<(), String> {
        let cands = self.candidates()?;
        self.archive_start()?;
        let b = self.budget_ms;
        // Soft limits count a fifth until cut 1 (PLAN 5d).
        self.scorer.ramp = 0.2;
        // Phase G (to 8%): a screen per class context, then the leads. The best root's gems and gear seed every lead
        // (to 14%), each lead swapping its own weapon in.
        self.layer = "leads".into();
        // Phase G: LEAD_CTX_EVALS tries per class context, so every ascendancy is screened, on the clock only past
        // LEADS_WALL of the time budget.
        let g0 = self.spent();
        let quota = cands.len() as u64 * LEAD_CTX_EVALS;
        self.leads_tries.set(true);
        let root = self.generate_leads(&cands, (g0 + quota * b / self.max_evals).min(b * LEADS_WALL / 100));
        self.leads_tries.set(false);
        let root = root?;
        // The rest keeps its fractions of the time the leads left (on schedule, `at(x)` is x% of the budget).
        let g = self.spent();
        let at = |x: u64| g + b.saturating_sub(g) * (x - 8) / 92;
        let mut root = match root {
            Some(r) => r,
            None => self.initial_state(cands[0], None, None)?,
        };
        self.assume_ailments(&mut root)?;
        self.phase_end.set(at(14));
        let r = (|| -> Result<bool, String> {
            self.layer = "gems".into();
            self.gem_layer(&mut root, false)?;
            self.items_layer(&mut root, false)
        })();
        self.phase_end.set(u64::MAX);
        r?;
        // Both: the root's two sides are the bars until cut 1 (unless the open build set them), and the root is scored on them.
        self.scorer.provisional_bars(&root.vals);
        (root.score, root.viol) = self.score(&root.vals);
        self.archive_add(&root)?;
        let gear = root.gear.clone();
        self.lead_gear = Some(gear.clone());
        // Rung 1 (to 30%): the first leads that fit at about 5 s each, an equal share each; the rest wait in reserve.
        let r1_end = at(30);
        let n = self.book.leads.len().min((r1_end.saturating_sub(self.spent()) / 5000).max(1) as usize);
        let ids = self.rung_one(n);
        for (k, &id) in ids.iter().enumerate() {
            if self.stop() || self.spent() >= r1_end {
                break;
            }
            let share = r1_end.saturating_sub(self.spent()) / (ids.len() - k) as u64;
            self.lead_start(id, &gear, share)?;
        }
        // Cut 1 (to 33%), then the survivors grow their trees in full (to 38%, an equal share each; the expert phase
        // needs the time after it).
        let mut scouted = self.cut_one(at(33))?;
        if scouted.is_empty() {
            // (no lead ran: the root alone goes on)
            self.grow(&mut root, true)?;
            self.grow(&mut root, false)?;
            self.archive_add(&root)?;
            scouted.push(root);
        }
        let grow_until = at(38);
        let ns = scouted.len();
        for (k, st) in scouted.iter_mut().enumerate() {
            if self.stop() || self.spent() >= grow_until {
                break;
            }
            self.current = st.lead.and_then(|l| self.book.leads.get(l as usize)).map_or_else(|| self.ctx[st.class].label.clone(), |l| l.label.clone());
            self.phase_end.set(self.spent() + grow_until.saturating_sub(self.spent()) / (ns - k) as u64);
            let r = self.grow(st, false);
            self.phase_end.set(u64::MAX);
            r?;
            self.archive_add(st)?;
        }
        scouted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        // Expert phase over the survivors' roots (each keeps its weapon held): beam leaves made into real
        // builds compete with the survivors for the three finals by full score.
        let mut pool = self.expert(&scouted)?;
        pool.extend(scouted);
        // The finals are the best build of each of the best three leads.
        let mut pool = leads::one_per_lead(pool);
        // The open build's lead is always among the best three.
        let own = self.seed.as_ref().map(|(c, a, _, _)| (*c, *a));
        if let Some(k) = own.and_then(|(c, a)| pool.iter().position(|s| self.ctx[s.class].class_id == c && self.ctx[s.class].asc_id == a)) {
            if k >= 3 {
                let st = pool.remove(k);
                pool.insert(2, st);
            }
        }
        // Refine the best three: gems <-> tree until nothing improves, then kicks, then the finish: shares of the time the
        // expert phase left (it ends at up to 60%, past fixed marks: then only the first final was refined and no kick ran).
        let e = self.spent();
        let after = |pct: u64| e + b.saturating_sub(e) * pct / 100;
        let converge_until = after(20);
        let mut finals: Vec<State> = Vec::new();
        let picked: Vec<State> = pool.into_iter().take(3).collect();
        let n = picked.len();
        for (k, mut st) in picked.into_iter().enumerate() {
            if let Some(l) = st.lead {
                self.book.leads[l as usize].status = leads::Status::Final;
            }
            if self.stop() || (!finals.is_empty() && self.spent() >= converge_until) {
                finals.push(st);
                continue;
            }
            self.current = self.ctx[st.class].label.clone();
            if let Some(l) = st.lead {
                let spent = self.spent();
                self.book.record(l, spent, st.score);
            }
            // (an equal share each, so the first final does not take the others' refinement)
            self.phase_end.set(self.spent() + converge_until.saturating_sub(self.spent()) / (n - k) as u64);
            let r = self.converge(&mut st);
            self.phase_end.set(u64::MAX);
            r?;
            // (the stall check counts from here)
            if let Some(l) = st.lead {
                let spent = self.spent();
                self.book.record(l, spent, st.score);
            }
            finals.push(st);
        }
        // Then kicks until most of the time is used: give back a fifth of the tree (and sometimes an ascendancy
        // notable) at random, grow it again and refine; keep the result when it beats that final. A final whose best
        // stalls steps back (solver_leads.rs `step_back`): the next weapon, the next route, or a reserve lead; when
        // that does not beat it, the final is frozen and its kicks go to the others.
        // Each final's kicks run as KICK_CHAINS chains from its start, each from its own seed (derived from the goal's); a
        // turn kicks every chain once, and the final is the best of them, so one chain stuck below the others does not
        // decide the result (and the stall check reads whole turns).
        // (to 45% of what the expert left: the finish below takes the rest, so it starts early enough to end inside it)
        let kick_until = after(45);
        let mut rng: u64 = 0x9E37_79B9_7F4A_7C15 ^ self.rng_seed;
        let mut round = 0usize;
        let mut frozen = vec![false; finals.len()];
        let chain_seed = |k: usize, c: usize| (0x9E37_79B9_7F4A_7C15 ^ self.rng_seed).wrapping_add(((k * KICK_CHAINS + c + 1) as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9)) | 1;
        let mut chains: Vec<Vec<(State, u64)>> = finals.iter().enumerate().map(|(k, f)| (0..KICK_CHAINS).map(|c| (f.clone(), chain_seed(k, c))).collect()).collect();
        while !finals.is_empty() && !self.stop() && self.spent() < kick_until {
            let live: Vec<usize> = (0..finals.len()).filter(|&k| !frozen[k]).collect();
            let k = if live.is_empty() { round % finals.len() } else { live[round % live.len()] };
            round += 1;
            self.current = finals[k].lead.and_then(|l| self.book.leads.get(l as usize)).map_or_else(|| self.ctx[finals[k].class].label.clone(), |l| l.label.clone());
            // A final that stalled (in its refinement or its last kick) steps back before it is kicked again, so a step
            // can fire even when only one kick round fits.
            if let Some(id) = finals[k].lead.filter(|_| !frozen[k]) {
                let spent = self.spent();
                if self.book.stalled(id, spent, b) {
                    match self.step_back(&finals[k], id, &mut rng)? {
                        Some(c) if c.score > finals[k].score + 1e-6 => {
                            if let Some(nl) = c.lead {
                                self.book.leads[nl as usize].status = leads::Status::Final;
                            }
                            // (every chain starts again from the stepped-back final)
                            for ch in chains[k].iter_mut() {
                                ch.0 = c.clone();
                            }
                            finals[k] = c;
                        }
                        c => {
                            if let Some(nl) = c.and_then(|c| c.lead).filter(|&nl| nl != id) {
                                self.book.leads[nl as usize].status = leads::Status::Dropped;
                            }
                            frozen[k] = true;
                        }
                    }
                    self.publish();
                    continue;
                }
            }
            self.kick_turn(&mut chains[k], round)?;
            if let Some(best) = chains[k].iter().map(|c| &c.0).max_by(|a, b| a.score.total_cmp(&b.score)).filter(|c| c.score > finals[k].score + 1e-6).cloned() {
                finals[k] = best;
                self.archive_add(&finals[k])?;
            }
            let Some(id) = finals[k].lead else {
                self.publish();
                continue;
            };
            let spent = self.spent();
            self.book.record(id, spent, finals[k].score);
            self.publish();
        }
        // (every final gets the finishing passes inside the reserve, and the limit repair may run past it)
        finals.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        self.finalizing.set(true);
        self.assumptions.push(format!("Finishing reserve: {} of {} tries, {} finals", self.max_evals * FINAL_RESERVE_PCT / 100, self.max_evals, finals.len()));
        for (k, f) in finals.iter_mut().enumerate() {
            let e0 = self.evals.load(Ordering::Relaxed);
            let mut rec = self.finishing(f)?;
            // (the record is the build as listed: the listing's own changes are its last step)
            if let Some(w) = self.archive_add_written(f)? {
                let step = self.written_step(f, &w)?;
                rec["after"] = step["after"].clone();
                let mut kept = rec["kept"].as_array().cloned().unwrap_or_default();
                kept.push(step);
                rec["kept"] = Value::Array(kept);
            }
            self.assumptions.push(format!("Finishing pass for final {}: {} tries", k + 1, self.evals.load(Ordering::Relaxed) - e0));
            self.assumptions.extend(finish::record_lines(k + 1, &rec));
        }
        self.finalizing.set(false);
        finals.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        // The floor: the best final's tree, gems and weapon with nothing else equipped.
        if let Some(best) = finals.first().cloned() {
            let saved = self.ignore_budget.replace(true);
            let r = self.no_gear_baseline(&best);
            self.ignore_budget.set(saved);
            self.baseline = r.ok();
        }
        // The trade-off: lean the best build toward each target in turn.
        if let Some(best) = finals.first().cloned() {
            let n = self.scorer.targets.len();
            if n > 1 {
                for k in 0..n {
                    for f in [3.0, 0.33, 10.0, 0.1] {
                        if self.stop() {
                            break;
                        }
                        self.layer = format!("trade-off: {}", self.scorer.targets[k].name);
                        let saved = self.weights.clone();
                        self.weights[k] *= f;
                        let mut s = best.clone();
                        let (sc, viol) = self.score(&s.vals);
                        s.score = sc;
                        s.viol = viol;
                        self.refine_tree(&mut s, false)?;
                        self.items_layer(&mut s, false)?;
                        self.weights = saved;
                        self.archive_add(&s)?;
                        self.publish();
                    }
                }
            }
            let mut b = best;
            self.bandit_pass(&mut b)?;
            self.archive_add(&b)?;
        }
        if self.behind.get() {
            let n = self.evals.load(Ordering::Relaxed);
            self.assumptions.push(format!("Stopped at the time limit after {n} of {} tries: this PC ran slower than the solve plans for, so the later steps were shortened", self.max_evals));
        }
        self.apply_pick();
        self.layer = "done".into();
        self.publish();
        Ok(())
    }

    /// The final pick (solver_plan.rs `pick_final`): the picked result goes first, the highest-figure one is marked `extreme`.
    fn apply_pick(&mut self) {
        let sc = &self.scorer;
        let (Some(main_t), Some(first)) = (sc.targets.first(), self.archive.first()) else { return };
        let single = self.goal.targets.len() <= 1 && main_t.metric.trim() != "ehp";
        let rule = if sc.both_sides(&first.vals).is_some() { plan::PickRule::Main } else if single { plan::PickRule::Trade } else { plan::PickRule::Score };
        let ehp = sc.names.iter().position(|x| x == "TotalEHP");
        let hits: Vec<usize> = ["Physical", "Lightning", "Cold", "Fire", "Chaos"].iter().filter_map(|d| sc.names.iter().position(|x| *x == format!("{d}MaximumHitTaken"))).collect();
        let ix: Vec<usize> = (0..self.archive.len()).filter(|&i| !self.archive[i].start).collect();
        let cands: Vec<plan::Cand> = ix
            .iter()
            .map(|&i| {
                let e = &self.archive[i];
                let main = sc.both_sides(&e.vals).map_or_else(|| sc.target_value(main_t, &e.vals), |(c, b, _)| c.min(b));
                let weakest = hits.iter().filter_map(|&k| e.vals.get(k).copied().flatten()).reduce(f64::min);
                let credit = |x: f64| weakest.map_or(x, |m| x.min(m * EHP_MAX_HIT_MULT));
                plan::Cand { main, other: ehp.map_or(0.0, |k| credit(Scorer::get(&e.vals, k))), met: sc.targets.iter().all(|t| t.value.is_none_or(|tv| sc.target_value(t, &e.vals) >= tv)), hard: e.viol <= 0.0, survives: e.boss_chips.is_empty(), score: e.score }
            })
            .collect();
        let Some(p) = plan::pick_final(&cands, rule) else { return };
        let (pick, extreme) = (ix[p.pick], p.extreme.map(|x| ix[x]));
        self.picked = Some((self.archive[pick].id.clone(), extreme.map(|x| self.archive[x].id.clone()), p.miss));
        let e = self.archive.remove(pick);
        self.archive.insert(0, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_gems_skips_disabled_groups_and_other_skill_sets() {
        let xml = r#"<PathOfBuilding><Skills activeSkillSet="2">
            <SkillSet id="1"><Skill enabled="true"><Gem nameSpec="Hatred" enabled="true"/></Skill></SkillSet>
            <SkillSet id="2">
                <Skill enabled="true"><Gem nameSpec="Arc" enabled="true"/><Gem nameSpec="Wrath" enabled="false"/></Skill>
                <Skill enabled="false"><Gem nameSpec="Grace" enabled="true"/></Skill>
            </SkillSet></Skills></PathOfBuilding>"#;
        let own = own_gems(xml);
        assert!(own.contains(find_gem("Arc").unwrap()));
        for name in ["Grace", "Hatred", "Wrath"] {
            assert!(!own.contains(find_gem(name).unwrap()), "{name} is not in the active set's enabled groups");
        }
        // older builds: <Skill> straight under <Skills>, no <SkillSet>
        let old = own_gems(r#"<PathOfBuilding><Skills><Skill enabled="true"><Gem nameSpec="Grace"/></Skill><Skill enabled="false"><Gem nameSpec="Hatred"/></Skill></Skills></PathOfBuilding>"#);
        assert!(old.contains(find_gem("Grace").unwrap()) && !old.contains(find_gem("Hatred").unwrap()));
    }

    #[test]
    fn template_drops_blank_url() {
        let xml = blank_build_xml(90).replace("nodes=\"\">", "nodes=\"\"><URL>
</URL>");
        assert!(xml.contains("<URL>"));
        let (t, _) = make_template(&xml).unwrap();
        assert!(!t.parts.concat().contains("URL"));
        assert!(!blank_build_xml(90).contains("URL"));
    }

    /// Mapping counts movement speed (a Quicksilver flask, boots); bossing does not.
    #[test]
    fn mapping_values_movement_speed() {
        let score = |mode: &str, ms: f64| {
            let g: Goal = serde_json::from_str(&format!(r#"{{"skill":"Cleave","assume":{{"playMode":"{mode}"}},"limits":{{"movement":null}}}}"#)).unwrap();
            let (s, _) = Scorer::new(&g).unwrap();
            let mut v: Vals = vec![None; s.names.len()];
            v[s.names.iter().position(|x| x == "Solver.SingleDPS" || x == "Solver.BossDPS").unwrap()] = Some(1e6);
            if let Some(i) = s.names.iter().position(|x| x == "EffectiveMovementSpeedMod") {
                v[i] = Some(ms);
            }
            s.score(&v, &[]).0
        };
        let gain = score("mapping", 1.4) - score("mapping", 1.0);
        assert!((gain - MOVEMENT_WEIGHT * 1.4f64.ln()).abs() < 1e-9, "{gain}");
        assert_eq!(score("bossing", 1.4), score("bossing", 1.0));
    }

    #[test]
    fn goal_defaults_and_scoring() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Poisonous Concoction","level":90,"targets":[{"name":"DPS","metric":"combined","value":5000000},{"name":"EHP","metric":"ehp","value":100000}],"assume":{"flasks":false},"limits":{"resists":null}}"#).unwrap();
        assert!(g.limits.resists.is_none() && g.limits.attributes && g.assume.ailments);
        let (s, boss) = Scorer::new(&g).unwrap();
        assert!(!boss);
        let w = vec![1.0, 1.0];
        let mut v: Vals = vec![None; s.names.len()];
        let i = |n: &str| s.names.iter().position(|x| x == n).unwrap();
        v[i(SINGLE_DPS)] = Some(500_000.0);
        v[i("TotalEHP")] = Some(10_000.0);
        v[i("LifeUnreserved")] = Some(1000.0);
        v[i("EffectiveMovementSpeedMod")] = Some(1.5);
        for d in ["Physical", "Lightning", "Cold", "Fire", "Chaos"] {
            v[i(&format!("{d}MaximumHitTaken"))] = Some(1e6);
        }
        // Life below the default floor is a shortfall.
        v[i("Solver.Pool")] = Some(2000.0);
        assert!(s.score(&v, &w).1 > 0.0);
        v[i("Solver.Pool")] = Some(4000.0);
        let (a, viol) = s.score(&v, &w);
        assert_eq!(viol, 0.0);
        // Time spent shouting comes off the damage; Mirage Archers count (CombinedDPS already holds them).
        v[i("Solver.AttackTimeShare")] = Some(0.5);
        assert!((s.target_value(&s.targets[0], &v) - 250_000.0).abs() < 1e-6);
        // The row shows what the sidebar will show: the engine value before the time share.
        assert!((s.shown_value(&s.targets[0], &v) - 500_000.0).abs() < 1e-6);
        v[i("Solver.AttackTimeShare")] = None;
        v[i(SINGLE_DPS)] = Some(1_000_000.0);
        let (b, _) = s.score(&v, &w);
        assert!((b - a - 2f64.ln()).abs() < 1e-9);
        // Skill cost: regeneration alone falls short, leech makes up the rest; the cost-free score ignores it.
        v[i("ManaPerSecondCost")] = Some(100.0);
        v[i("ManaRegenRecovery")] = Some(10.0);
        let (c, viol) = s.score(&v, &w);
        assert!(viol > 0.0 && (s.score_cost_free(&v, &w) - b).abs() < 1e-9 && c < b);
        v[i("ManaLeechGainRate")] = Some(95.0);
        assert_eq!(s.score(&v, &w).1, 0.0);
        // An unmet attribute requirement is a shortfall.
        v[i("ReqDex")] = Some(100.0);
        let (_, viol) = s.score(&v, &w);
        assert!(viol > 0.0);
        let d: Goal = serde_json::from_str(r#"{"skill":"x"}"#).unwrap();
        assert_eq!(d.limits.resists, Some(75.0));
    }

    /// EHP is upstream's TotalEHP and is shown as such; the score and targets credit at most 20x the weakest max hit.
    #[test]
    fn ehp_is_total_ehp_and_credit_is_capped() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Summon Raging Spirit","level":90,"targets":[{"name":"EHP","metric":"ehp"}],"limits":{"resists":null}}"#).unwrap();
        let (s, _) = Scorer::new(&g).unwrap();
        let mut v: Vals = vec![None; s.names.len()];
        let i = |n: &str| s.names.iter().position(|x| x == n).unwrap();
        v[i("TotalEHP")] = Some(300_000.0);
        for d in ["Physical", "Lightning", "Cold", "Fire", "Chaos"] {
            v[i(&format!("{d}MaximumHitTaken"))] = Some(50_000.0);
        }
        v[i("FireMaximumHitTaken")] = Some(10_000.0);
        assert_eq!(s.target_value(&s.targets[0], &v), 200_000.0);
        assert_eq!(s.shown_value(&s.targets[0], &v), 300_000.0);
        assert!(s.limits.iter().all(|l| !l.name.contains("maximum hit")), "no max-hit limit left");
        v[i("FireMaximumHitTaken")] = Some(50_000.0);
        assert_eq!(s.target_value(&s.targets[0], &v), 300_000.0);
    }

    /// The stated number is the goal: an open "as high as possible" target must not buy its way past it.
    #[test]
    fn stated_goal_outranks_open_target() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Summon Raging Spirit","level":90,"targets":[{"name":"DPS","metric":"combined","value":1500000},{"name":"EHP","metric":"ehp"}],"limits":{"resists":null}}"#).unwrap();
        let (s, _) = Scorer::new(&g).unwrap();
        let w = vec![1.0, 1.0];
        let mut v: Vals = vec![None; s.names.len()];
        let i = |n: &str| s.names.iter().position(|x| x == n).unwrap();
        v[i("LifeUnreserved")] = Some(1000.0);
        v[i("Solver.Pool")] = Some(4000.0);
        // A: little damage, huge EHP (what the search used to prefer). B: goal reached, modest EHP.
        v[i(SINGLE_DPS)] = Some(200_000.0);
        v[i("TotalEHP")] = Some(1.0e9);
        let a = s.score(&v, &w).0;
        v[i(SINGLE_DPS)] = Some(2_000_000.0);
        v[i("TotalEHP")] = Some(3.0e5);
        let b = s.score(&v, &w).0;
        assert!(b > a, "goal met ({b}) must beat EHP at the goal's expense ({a})");
        // With the goal met the open target still counts in full: more EHP is better.
        v[i("TotalEHP")] = Some(6.0e5);
        assert!((s.score(&v, &w).0 - b - 2f64.ln()).abs() < 1e-9);
        // No stated number anywhere: unchanged equal-weight log.
        let h: Goal = serde_json::from_str(r#"{"skill":"x","targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"limits":{"resists":null}}"#).unwrap();
        let (t, _) = Scorer::new(&h).unwrap();
        let mut u: Vals = vec![None; t.names.len()];
        let j = |n: &str| t.names.iter().position(|x| x == n).unwrap();
        u[j("LifeUnreserved")] = Some(1000.0); u[j("Solver.Pool")] = Some(4000.0);
        u[j(SINGLE_DPS)] = Some(1000.0); u[j("TotalEHP")] = Some(1000.0);
        let c = t.score(&u, &w).0;
        u[j(SINGLE_DPS)] = Some(2000.0);
        assert!((t.score(&u, &w).0 - c - 2f64.ln()).abs() < 1e-9);
    }

    #[test]
    #[ignore]
    fn crit_recently_on_for_crit_build() {
        let path = std::env::var("POM_CRIT_BUILD_XML").expect("POM_CRIT_BUILD_XML: a solved Molten Strike build");
        let xml = std::fs::read_to_string(path).unwrap();
        let names = ["CombinedDPS", "CritChance", CRIT_RECENT];
        let mut sess: Option<Session> = None;
        // as the solver left it: switch off, the "haven't crit recently" bonuses count
        let before = eval_one(&mut sess, &Cand::Open(Arc::new(xml.clone())), &names).unwrap();
        let after = eval_one(&mut sess, &Cand::Xml(Arc::new(xml.clone())), &names).unwrap();
        println!("before: DPS {:?} crit {:?}
after: DPS {:?} crit {:?} switch {:?}", before[0], before[1], after[0], after[1], after[2]);
        assert_eq!(after[2], Some(1.0), "crit build gets conditionCritRecently");
        assert!(after[0].unwrap() < before[0].unwrap() * 0.95, "DPS drops once the haven't-crit bonuses are gone");
    }

    #[test]
    fn warcry_time_share() {
        use std::collections::HashMap;
        let run = |m: &[(&str, f64)]| {
            let h: HashMap<&str, f64> = m.iter().copied().collect();
            attack_time_share(&|k: &str| h.get(k).copied())
        };
        assert_eq!(run(&[("Speed", 3.0)]), 1.0);
        // Howlcrack: no cooldown, 0.5 s shout, 2 exerts at 4/s: half the time shouting.
        assert!((run(&[("Speed", 4.0), ("IntimidatingCryCastTime", 0.5), ("IntimidatingCryCooldown", 0.0), ("IntimidatingExertsCount", 2.0)]) - 0.5).abs() < 1e-9);
        // An 8 s cooldown costs a little.
        let s = run(&[("Speed", 4.0), ("SeismicCryCastTime", 0.5), ("SeismicCryCooldown", 8.0), ("SeismicExertsCount", 3.0)]);
        assert!((s - (1.0 - 0.5 / 8.5)).abs() < 1e-9);
    }

    /// Flask slots are switched on and off in the build text; a flask that gains a charge a second is not sustained
    /// (its uptime stat is between 0 and 1), and a slot without a flask reads 0.
    #[test]
    fn flask_flags_and_uptime() {
        let x = blank_build_xml(90).replace(
            "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\">
		<ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />",
            "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\"><Item id=\"1\">Rarity: MAGIC
Diamond Flask
Item Level: 90
Quality: 20
LevelReq: 27
Implicits: 0</Item><Item id=\"2\">Rarity: RARE
Test Ring
Iron Ring
Item Level: 90
LevelReq: 1
Implicits: 0
Flasks gain 3 Charges every 3 seconds</Item><ItemSet useSecondWeaponSet=\"nil\" id=\"1\"><Slot name=\"Flask 1\" itemId=\"1\" active=\"true\"/><Slot name=\"Ring 1\" itemId=\"2\"/></ItemSet>",
        );
        assert_eq!(flask_flags(&x), 1);
        let off = set_flask_flags(&x, 0);
        assert_eq!(flask_flags(&off), 0);
        assert_eq!(flask_flags(&set_flask_flags(&off, 1)), 1);
        let mut s = Session::new(x.clone(), pom_calc::data::game_data());
        let v: Vals = s.eval_xml(&x, false, |env| ["Solver.FlaskUptime1", "Solver.FlaskUptime2", "Solver.FlaskUptimeMap1", "Solver.FlaskUptimeMap2"].iter().map(|n| crate::stat_value(env, n)).collect()).unwrap();
        // Bossing: 1 charge a second over the flask's duration, against 20 charges per use.
        assert!(v[0].is_some_and(|u| u > 0.05 && u < 1.0), "{v:?}");
        assert_eq!(v[1], Some(0.0));
        // Mapping: kills add MAPPING_KILL_CHARGES a second (same charge gain), so the Diamond Flask is up; no flask, no uptime.
        let (boss, map) = (v[0].unwrap(), v[2].unwrap());
        assert!(map >= 1.0 && (map / boss - (1.0 + MAPPING_KILL_CHARGES)).abs() < 1e-6, "{v:?}");
        assert_eq!(v[3], Some(0.0));
        // The goal setting picks the stat: mapping by default, bossing on request.
        let g: Goal = serde_json::from_str(r#"{"skill":"Cleave"}"#).unwrap();
        assert_eq!((g.assume.flask_uptime, g.assume.uptime_stat(1).as_str()), (FlaskUptime::Mapping, "Solver.FlaskUptimeMap1"));
        let g: Goal = serde_json::from_str(r#"{"skill":"Cleave","assume":{"flaskUptime":"bossing"}}"#).unwrap();
        assert_eq!(g.assume.uptime_stat(2), "Solver.FlaskUptime2");
    }

    #[test]
    fn bossing_mode_flask_credit_uses_boss_uptime() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Cleave","assume":{"playMode":"bossing"}}"#).unwrap();
        assert_eq!(g.assume.uptime_stat(1), "Solver.FlaskUptime1");
    }


    const BOSS_G: &str = r#"{"skill":"Flicker Strike","assume":{"playMode":"bossing"},"targets":[{"name":"DPS","metric":"full"},{"name":"EHP","metric":"ehp"}]}"#;

    /// Bossing: a Pinnacle hit that one-shots (60% of the reference hit) loses to a safe build with half the damage.
    #[test]
    fn bossing_one_shot_build_loses() {
        let (sc, _) = Scorer::new(&serde_json::from_str(BOSS_G).unwrap()).unwrap();
        let w: Vec<f64> = sc.targets.iter().map(|t| t.weight).collect();
        let risky = vals_for(&sc, &[("Solver.BossDPS", 2e6), ("TotalEHP", 1e5), ("Solver.BossHitRatio", 0.6)]);
        let safe = vals_for(&sc, &[("Solver.BossDPS", 1e6), ("TotalEHP", 1e5), ("Solver.BossHitRatio", 1.1)]);
        let (a, b) = (sc.score(&risky, &w).0, sc.score(&safe, &w).0);
        assert!(a < b, "one-shot build {a:.3} must lose to {b:.3}");
    }

    /// Bossing: of two builds with equal damage and the same Pinnacle margin, the one that survives Sirus Meteor wins.
    #[test]
    fn bossing_surviving_a_boss_skill_scores_higher() {
        let presets = [crate::solver_boss::PresetHit { name: "Sirus Meteor".into(), hit: [31_261.0, 0.0, 0.0, 0.0, 0.0], pen: [0.0; 5] }];
        let shortfall = |phys: f64| {
            let m: std::collections::HashMap<&str, f64> = [("PhysicalMaximumHitTaken", phys), ("FireMaximumHitTaken", 50_000.0)].into_iter().collect();
            crate::solver_boss::preset_shortfall(&presets, &|k| m.get(k).copied())
        };
        let (safe, weak) = (shortfall(40_000.0), shortfall(12_859.0));
        assert_eq!(safe, 0.0);
        assert!((weak - (1.0 - 12_859.0 / 31_261.0)).abs() < 1e-9, "{weak}");
        let (sc, _) = Scorer::new(&serde_json::from_str(BOSS_G).unwrap()).unwrap();
        let w: Vec<f64> = sc.targets.iter().map(|t| t.weight).collect();
        let v = |s: f64| vals_for(&sc, &[("Solver.BossDPS", 1e6), ("TotalEHP", 1e5), ("Solver.BossHitRatio", 3.0), ("Solver.BossPresetShortfall", s)]);
        let (a, b) = (sc.score(&v(safe), &w).0, sc.score(&v(weak), &w).0);
        assert!(a > b, "survives {a:.3} vs one-shot {b:.3}");
    }

    /// Bossing: every damage metric (full, hit, dot too) reads BossDPS and the defence target is always there.
    #[test]
    fn bossing_maps_every_damage_metric() {
        for m in ["full", "hit", "dot", "combined", "boss"] {
            let g = BOSS_G.replace("\"full\"", &format!("\"{m}\""));
            let (sc, boss) = Scorer::new(&serde_json::from_str(&g).unwrap()).unwrap();
            assert!(boss && sc.targets[0].metric == "bossdps" && sc.targets.iter().any(|t| t.metric == "bossdef"), "{m}");
        }
        let (sc, _) = Scorer::new(&serde_json::from_str(r#"{"skill":"x","assume":{"playMode":"bossing"},"targets":[{"name":"EHP","metric":"ehp"}]}"#).unwrap()).unwrap();
        assert!(sc.targets.iter().any(|t| t.metric == "bossdef"));
    }

    /// The no-gear baseline reads the bossing damage target, not 0.
    #[test]
    fn bossing_baseline_reads_boss_dps() {
        let (sc, _) = Scorer::new(&serde_json::from_str(BOSS_G).unwrap()).unwrap();
        let v = vals_for(&sc, &[("Solver.BossDPS", 123.0), ("TotalEHP", 5.0)]);
        assert_eq!(sc.damage_value(&v), 123.0);
    }

    const BOTH_G: &str = r#"{"skill":"Flicker Strike","assume":{"playMode":"both"},"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}]}"#;

    /// Both: the score is the weaker of the clear and the boss side (each over its bar); the stronger side adds nothing.
    #[test]
    fn both_scores_the_weaker_of_clear_and_boss() {
        let (mut sc, _) = Scorer::new(&serde_json::from_str(BOTH_G).unwrap()).unwrap();
        let w: Vec<f64> = sc.targets.iter().map(|t| t.weight).collect();
        let names = sc.clone();
        let v = |c: f64, b: f64| vals_for(&names, &[("Map:Solver.ClearDPS", c), ("Solver.BossDPS", b), ("TotalEHP", 1e5), ("Solver.BossHitRatio", 3.0), ("Map:Solver.AttackTimeShare", 1.0)]);
        let s = |sc: &Scorer, c: f64, b: f64| sc.score(&v(c, b), &w).0;
        // strong clear, weak boss: scored by the boss side
        assert!((s(&sc, 1e7, 1e5) - s(&sc, 1e6, 1e5)).abs() < 1e-9);
        // weak clear, strong boss: scored by the clear side
        assert!((s(&sc, 1e5, 1e7) - s(&sc, 1e5, 1e6)).abs() < 1e-9);
        assert!(s(&sc, 2e6, 2e6) > s(&sc, 1e6, 1e6));
        // each side over its own bar: a clear bar 10x the boss bar makes equal raw numbers a clear-side score
        sc.bars = Some((1e7, 1e5));
        let b = sc.both_sides(&v(1e6, 1e6)).unwrap();
        assert!(b.0 < b.1 && b.2 == "clear", "{b:?}");
        assert!((s(&sc, 1e6, 1e9) - s(&sc, 1e6, 1e8)).abs() < 1e-9);
    }

    /// Both: hit, dot and full get a clear twin read on the mapping enemy, so they are scored on the weaker side too.
    #[test]
    fn both_pairs_hit_dot_and_full_with_a_clear_twin() {
        for (m, stat) in [("hit", "TotalDPS"), ("dot", "TotalDotDPS"), ("full", "FullDPS")] {
            let (sc, _) = Scorer::new(&serde_json::from_str(&BOTH_G.replace("\"combined\"", &format!("\"{m}\""))).unwrap()).unwrap();
            assert!(sc.targets.iter().any(|t| t.pair.is_some()), "{m} has no clear twin");
            let w: Vec<f64> = sc.targets.iter().map(|t| t.weight).collect();
            let names = sc.clone();
            let v = |c: f64, b: f64| vals_for(&names, &[(&format!("Map:{stat}"), c), ("Solver.BossDPS", b), ("TotalEHP", 1e5), ("Solver.BossHitRatio", 3.0)]);
            let s = |c: f64, b: f64| sc.score(&v(c, b), &w).0;
            assert!((s(1e7, 1e5) - s(1e6, 1e5)).abs() < 1e-9, "{m}: boss side limits");
            assert!((s(1e5, 1e7) - s(1e5, 1e6)).abs() < 1e-9, "{m}: clear side limits");
        }
    }

    /// Both before the first cut: bars from the root's two sides, so a build balanced against the root beats one that is
    /// only larger on the side that happens to have the smaller numbers.
    #[test]
    fn both_provisional_bars_come_from_the_root() {
        let (mut sc, _) = Scorer::new(&serde_json::from_str(BOTH_G).unwrap()).unwrap();
        let w: Vec<f64> = sc.targets.iter().map(|t| t.weight).collect();
        let names = sc.clone();
        let v = |c: f64, b: f64| vals_for(&names, &[("Map:Solver.ClearDPS", c), ("Solver.BossDPS", b), ("TotalEHP", 1e5), ("Solver.BossHitRatio", 3.0)]);
        let (a, b) = (v(2e6, 2e4), v(1e6, 3e4));
        assert!(sc.score(&b, &w).0 > sc.score(&a, &w).0, "raw numbers: the smaller-scale side decides");
        sc.provisional_bars(&v(1e6, 1e4));
        assert_eq!(sc.bars, Some((1e6, 1e4)));
        assert!(sc.score(&a, &w).0 > sc.score(&b, &w).0, "on bars both sides count");
        // a side the root has none of is floored, never zero
        let mut z = Scorer::new(&serde_json::from_str(BOTH_G).unwrap()).unwrap().0;
        z.provisional_bars(&v(0.0, 5.0));
        assert_eq!(z.bars, Some((1.0, 5.0)));
    }

    /// An Enkindled flask ("Gains no Charges during Effect") is up dur / (dur + time to regain its charges), never 100%.
    #[test]
    fn enkindled_flask_uptime_is_below_full() {
        let build = |enchant: &str| {
            blank_build_xml(90).replace(
                "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\">
		<ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />",
                &format!("<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\"><Item id=\"1\">Rarity: MAGIC
Diamond Flask
Item Level: 90
Quality: 20
LevelReq: 27
{enchant}</Item><Item id=\"2\">Rarity: RARE
Test Ring
Iron Ring
Item Level: 90
LevelReq: 1
Implicits: 0
Flasks gain 3 Charges every 3 seconds</Item><ItemSet useSecondWeaponSet=\"nil\" id=\"1\"><Slot name=\"Flask 1\" itemId=\"1\" active=\"true\"/><Slot name=\"Ring 1\" itemId=\"2\"/></ItemSet>"),
            )
        };
        let up = |x: String| {
            let mut s = Session::new(x.clone(), pom_calc::data::game_data());
            let v: Vals = s.eval_xml(&x, false, |env| ["Solver.FlaskUptime1", "Solver.FlaskUptimeMap1"].iter().map(|n| crate::stat_value(env, n)).collect()).unwrap();
            (v[0].unwrap(), v[1].unwrap())
        };
        let (plain, plain_map) = up(build("Implicits: 0"));
        let (ench, ench_map) = up(build("Implicits: 1\n{crafted}Gains no Charges during Effect"));
        println!("plain uptime {plain:.4} (mapping {plain_map:.4}); Enkindled {ench:.4} (mapping {ench_map:.4})");
        assert!(plain_map >= 1.0);
        assert!((ench - plain / (1.0 + plain)).abs() < 1e-9 && ench_map < 1.0, "{ench} {ench_map}");
    }

    /// A flask the build keeps up part of the time counts at its uptime: u x (stats with it on) + (1 - u) x (stats
    /// without it), in a whole text and in a node list on that text alike.
    #[test]
    fn partial_flask_counts_at_its_uptime() {
        let x = blank_build_xml(90).replace(
            "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\">
		<ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />",
            "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\"><Item id=\"1\">Rarity: NORMAL
Granite Flask
Item Level: 90
LevelReq: 27
Implicits: 0</Item><Item id=\"2\">Rarity: RARE
Test Ring
Iron Ring
Item Level: 90
LevelReq: 1
Implicits: 0
Flasks gain 3 Charges every 3 seconds</Item><ItemSet useSecondWeaponSet=\"nil\" id=\"1\"><Slot name=\"Flask 1\" itemId=\"1\" active=\"true\"/><Slot name=\"Ring 1\" itemId=\"2\"/></ItemSet>",
        );
        let names = ["Armour", "Solver.FlaskUptime1", FLASK_MASK, FLASK_BROKEN];
        let mut s = Session::new(x.clone(), pom_calc::data::game_data());
        let arm = |s: &mut Session, t: &str| s.eval_xml(t, false, |env| crate::stat_value(env, "Armour")).unwrap().unwrap();
        let (on, off) = (arm(&mut s, &set_flask_flags(&x, 1)), arm(&mut s, &set_flask_flags(&x, 0)));
        let v = eval_one(&mut None, &Cand::Xml(Arc::new(x.clone())), &names).unwrap();
        let u = v[1].unwrap();
        println!("Granite uptime {u:.3}: armour on {on:.0}, off {off:.0}, scored {:.0}", v[0].unwrap());
        assert!(u > 0.05 && u < 0.999 && on > off, "{v:?}");
        let want = off + u * (on - off);
        assert!((v[0].unwrap() - want).abs() <= 1e-6 * want, "whole text: {} vs {want}", v[0].unwrap());
        let base = Arc::new(set_flask_flags(&x, 0));
        let w = eval_one(&mut None, &Cand::Nodes { base, nodes: nodes_in_xml(&x).unwrap(), mastery: None, pin: Vec::new() }, &names).unwrap();
        assert!((w[0].unwrap() - want).abs() <= 1e-6 * want, "node list: {} vs {want}", w[0].unwrap());
    }

    /// A mapping goal with a DPS target scores damage at the fight's flask uptime (no kills), but the player still runs
    /// the map: a Quicksilver refilled by kills counts for movement speed at the mapping uptime. It had
    /// vanished from every result once the DPS target switched the whole goal to the fight's uptime.
    #[test]
    fn single_target_mapping_goal_counts_quicksilver_for_movement() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Cleave","assume":{"playMode":"mapping"},"targets":[{"name":"DPS","metric":"combined"}]}"#).unwrap();
        let (sc, _) = Scorer::new(&g.settle()).unwrap();
        let has = |n: &str| sc.names.iter().any(|x| x == n);
        assert!(has("Solver.FlaskUptime1") && has("Solver.FlaskUptimeMap1"), "the goal asks for both uptimes");
        let x = blank_build_xml(90).replace(
            "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\">
		<ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />",
            "<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\"><Item id=\"1\">Rarity: NORMAL
Quicksilver Flask
Item Level: 90
LevelReq: 4
Implicits: 0</Item><ItemSet useSecondWeaponSet=\"nil\" id=\"1\"><Slot name=\"Flask 1\" itemId=\"1\" active=\"true\"/></ItemSet>",
        );
        let names = ["EffectiveMovementSpeedMod", "Solver.FlaskUptime1", "Solver.FlaskUptimeMap1", FLASK_MASK, FLASK_BROKEN];
        let mut s = Session::new(x.clone(), pom_calc::data::game_data());
        let ms = |s: &mut Session, t: &str| s.eval_xml(t, false, |env| crate::stat_value(env, "EffectiveMovementSpeedMod")).unwrap().unwrap();
        let (on, off) = (ms(&mut s, &set_flask_flags(&x, 1)), ms(&mut s, &set_flask_flags(&x, 0)));
        let v = eval_one(&mut None, &Cand::Xml(Arc::new(x.clone())), &names).unwrap();
        let (boss, map) = (v[1].unwrap(), v[2].unwrap());
        println!("Quicksilver uptime fight {boss:.3}, mapping {map:.3}: movement on {on:.3}, off {off:.3}, scored {:.3}", v[0].unwrap());
        assert!(boss < 0.999 && map > 0.0 && on > off, "{v:?}");
        let want = off + map.min(1.0) * (on - off);
        assert!((v[0].unwrap() - want).abs() <= 1e-9, "whole text: {} vs {want}", v[0].unwrap());
        let base = Arc::new(set_flask_flags(&x, 0));
        let w = eval_one(&mut None, &Cand::Nodes { base, nodes: nodes_in_xml(&x).unwrap(), mastery: None, pin: Vec::new() }, &names).unwrap();
        assert!((w[0].unwrap() - want).abs() <= 1e-9, "node list: {} vs {want}", w[0].unwrap());
    }

    #[test]
    fn priority_orders_without_removing() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","priority":{"supports":{"Pulverise":0.95,"Arcane Surge":0.02,"Ruthless":0.9},"modGroups":{"Physical Damage":0.9,"Cast Speed":0.1}}}"#).unwrap();
        let plain = catalog(90, &g);
        let mut ordered = catalog(90, &g);
        by_priority(&mut ordered, |x| if x.kind == Kind::Support { Priority::of(&g.priority.supports, &x.name) } else { 0.5 });
        let ids = |v: &[GemInfo]| v.iter().map(|x| x.id).collect::<Vec<_>>();
        let (a, b) = (ids(&plain), ids(&ordered));
        assert_ne!(a, b, "the order changes");
        let (mut sa, mut sb) = (a.clone(), b.clone());
        sa.sort_unstable();
        sb.sort_unstable();
        assert_eq!(sa, sb, "the candidate set does not");
        let pos = |n: &str| ordered.iter().position(|x| x.name == n).unwrap();
        assert!(pos("Pulverise") < pos("Ruthless") && pos("Ruthless") < pos("Arcane Surge"));
        // Unscored candidates keep their relative order (stable).
        let rest = |v: &[GemInfo]| v.iter().filter(|x| !["Pulverise", "Ruthless", "Arcane Surge"].contains(&x.name.as_str())).map(|x| x.id).collect::<Vec<_>>();
        assert_eq!(rest(&plain), rest(&ordered));
        // Modifier families by a phrase of their text (or their group); none named: 0.5.
        assert_eq!(g.priority.of_family("PhysicalDamage", "Adds 10 to 20 Physical Damage to Attacks"), 0.9);
        assert_eq!(g.priority.of_family("IncreasedCastSpeed", "20% increased Cast Speed"), 0.1);
        assert_eq!(g.priority.of_family("IncreasedLife", "+100 to maximum Life"), 0.5);
        // No priority: the order is exactly today's.
        let none: Goal = serde_json::from_str(r#"{"skill":"Boneshatter"}"#).unwrap();
        let mut same = catalog(90, &none);
        by_priority(&mut same, |x| if x.kind == Kind::Support { Priority::of(&none.priority.supports, &x.name) } else { 0.5 });
        assert_eq!(ids(&same), a);
    }

    /// A keystone 10+ steps from the class start: the Steiner tree is connected and as long as the BFS distance.
    #[test]
    fn tree_for_keystone_is_shortest_connected() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","level":90}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let i = s.class_ctx(1, 0).unwrap();
        let c = &s.ctx[i];
        let reach = c.bfs(&HashSet::default(), false);
        let mut ks: Vec<(usize, i64)> = reach.iter().filter(|(&id, &(d, _))| d >= 10 && c.kind(id) == "Keystone").map(|(&id, &(d, _))| (d, id)).collect();
        ks.sort_unstable();
        let (d, k) = ks[0];
        let t = c.tree_for(&[k], &[]).expect("keystone reachable");
        assert_eq!(t.len(), d + 1, "path nodes + class start");
        assert_eq!(c.connected(&t, false).len(), t.len(), "tree is connected to the class start");
    }

    fn solver_for(goal: &str) -> Solver {
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// Scion (Ascendant) is a candidate class for a skill of any attribute.
    #[test]
    fn ascendant_is_a_candidate() {
        let mut s = solver_for(r#"{"skill":"Boneshatter","level":90}"#);
        let c = s.candidates().unwrap();
        assert!(c.iter().any(|&i| s.ctx[i].asc_name.as_deref() == Some("Ascendant")), "{:?}", c.iter().map(|&i| &s.ctx[i].label).collect::<Vec<_>>());
    }

    fn solver_on_flicker(goal: &str) -> Solver {
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let xml = std::fs::read_to_string(format!("{}/testdata/finish-flicker.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(xml, goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// A goal for another skill than the open build's (Templar Flicker Strike open, Poisonous Concoction asked, no class):
    /// the open build's class is not forced in and its build is not a result; the same skill still seeds its class first.
    #[test]
    fn other_skill_does_not_force_the_open_class() {
        let mut s = solver_on_flicker(r#"{"skill":"Poisonous Concoction","level":90}"#);
        let c = s.candidates().unwrap();
        let names: Vec<&str> = c.iter().map(|&i| s.ctx[i].class_name.as_str()).collect();
        assert!(!names.contains(&"Templar"), "{names:?}");
        assert!(s.start_xml.is_none(), "the Flicker Strike build is not a Poisonous Concoction result");
        let mut s = solver_on_flicker(r#"{"skill":"Flicker Strike","level":90}"#);
        let c = s.candidates().unwrap();
        assert_eq!(s.ctx[c[0]].asc_name.as_deref(), Some("Inquisitor"));
    }

    /// an awakened support is in the catalog at level 90, and out below its level requirement.
    #[test]
    fn awakened_support_in_catalog() {
        let g: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","level":90}"#).unwrap();
        assert!(catalog(90, &g).iter().any(|x| x.name.starts_with("Awakened ") && x.kind == Kind::Support));
        assert!(!catalog(60, &g).iter().any(|x| x.name.starts_with("Awakened ")));
    }

    /// a setup with two new auras is evaluated (it used to be skipped for more than one new utility skill).
    #[test]
    fn two_new_auras_accepted() {
        let mut s = solver_for(r#"{"skill":"Boneshatter","level":90}"#);
        let c = s.candidates().unwrap();
        let st = s.initial_state(c[0], None, None).unwrap();
        let (h, a) = (find_gem("Hatred").unwrap(), find_gem("Anger").unwrap());
        let before = s.evals.load(Ordering::Relaxed);
        s.try_setups_plain(&st, vec![(st.main.clone(), vec![h, a])]).unwrap();
        assert!(s.evals.load(Ordering::Relaxed) > before, "the two-aura setup was evaluated");
    }

    fn vals_for(sc: &Scorer, set: &[(&str, f64)]) -> Vals {
        let mut v: Vals = vec![None; sc.names.len()];
        for (n, x) in set {
            let i = sc.names.iter().position(|m| m == n).unwrap_or_else(|| panic!("{n} not read"));
            v[i] = Some(*x);
        }
        v
    }

    /// PLAN 5c: with the EHP knee at 100k, 1.94M DPS / 55k EHP clearly outranks 16.6k DPS / 6.2M EHP (they score about
    /// the same without it); a stated EHP value is scored as before.
    #[test]
    fn ehp_knee_dps_wins() {
        let open = r#"{"skill":"Flicker Strike","targets":[{"name":"DPS"},{"name":"EHP","metric":"ehp"}],"limits":{"resists":null,"pool":null,"attributes":false,"reservation":false,"warnings":false,"cost":false,"movement":null}}"#;
        let (mut sc, _) = Scorer::new(&serde_json::from_str(open).unwrap()).unwrap();
        let w = [1.0, 1.0];
        let bleed = vals_for(&sc, &[(SINGLE_DPS, 1.94e6), ("TotalEHP", 55e3)]);
        let tank = vals_for(&sc, &[(SINGLE_DPS, 16.6e3), ("TotalEHP", 6.2e6)]);
        sc.knee = Some(100e3);
        let (a, b) = (sc.score(&bleed, &w).0, sc.score(&tank, &w).0);
        assert!(a - b > 1.0, "knee: {a:.3} vs {b:.3}");
        let stated = r#"{"skill":"Flicker Strike","targets":[{"name":"DPS"},{"name":"EHP","metric":"ehp","value":50000}],"limits":{"resists":null,"pool":null,"attributes":false,"reservation":false,"warnings":false,"cost":false,"movement":null}}"#;
        let (mut sc2, _) = Scorer::new(&serde_json::from_str(stated).unwrap()).unwrap();
        let before = sc2.score(&tank, &w).0;
        sc2.knee = Some(100e3);
        assert_eq!(sc2.score(&tank, &w).0, before, "a stated EHP value keeps its rule");
    }

    /// Bossing: two safe builds with equal ln(DPS)+ln(EHP): the one with 2.5x the damage wins (extra EHP past the need buys little).
    #[test]
    fn bossing_safe_builds_prefer_damage() {
        let (sc, _) = Scorer::new(&serde_json::from_str(BOSS_G).unwrap()).unwrap();
        let w: Vec<f64> = sc.targets.iter().map(|t| t.weight).collect();
        let v = |d: f64, e: f64, pr: f64, hr: f64| vals_for(&sc, &[("Solver.BossDPS", d), ("TotalEHP", e), ("Solver.BossHitRatio", hr), ("Solver.BossPresetMinRatio", pr)]);
        let dps = v(2.5e6, 40e3, 1.6, 1.3);
        let tank = v(1e6, 100e3, 4.0, 3.25);
        let (a, b) = (sc.score(&dps, &w).0, sc.score(&tank, &w).0);
        assert!(a > b + 0.3, "damage {a:.3} vs tank {b:.3}");
        // below the need, EHP still counts in full
        let weak = v(2.5e6, 20e3, 0.8, 0.65);
        assert!(sc.score(&weak, &w).0 < a);
    }

    /// PLAN 5d: a chaos-resistance shortfall costs a fifth of its penalty while `ramp` is 0.2 and all of it at 1; the
    /// mana reservation shortfall costs the same either way.
    #[test]
    fn soft_limits_ramp() {
        let g = r#"{"skill":"Flicker Strike","targets":[{"name":"DPS"}],"assume":{"flasks":false}}"#;
        let (mut sc, _) = Scorer::new(&serde_json::from_str(g).unwrap()).unwrap();
        let v = vals_for(&sc, &[("ChaosResist", -30.0), ("ManaUnreserved", -100.0)]);
        let at = |sc: &Scorer, name: &str| sc.limits.iter().position(|l| l.name == name).map(|i| sc.deficits(&v)[i]).unwrap();
        sc.ramp = 0.2;
        let (chaos_early, res_early) = (at(&sc, "Chaos resistance 0%"), at(&sc, "Mana reservation fits"));
        sc.ramp = 1.0;
        let (chaos, res) = (at(&sc, "Chaos resistance 0%"), at(&sc, "Mana reservation fits"));
        assert!(chaos > 0.0 && (chaos_early - 0.2 * chaos).abs() < 1e-9, "{chaos_early} vs {chaos}");
        assert!(res > 0.0 && res_early == res, "{res_early} vs {res}");
    }

    #[test]
    fn tag_attr_edit() {
        let x = blank_build_xml(90);
        let y = set_tag_attr(&x, "Skills", "defaultGemQuality", "20").unwrap();
        assert!(y.contains("defaultGemQuality=\"20\""));
        let y = set_tag_attr(&y, "Build", "level", "77").unwrap();
        assert_eq!(tag_attr(&y, "Build", "level").as_deref(), Some("77"));
        assert!(metric_stats("maxhit:fire").unwrap().0 == vec!["FireMaximumHitTaken".to_string()]);
    }
    /// Budgeted by evaluation count, not the clock, so machine load cannot change what the solve gets done.
    /// A short solve from blank spends all 8 ascendancy points; solving again from its result keeps that build listed
    /// (as the start) and returns nothing worse than it on the goal's score. Both solves run the expert beam.
    #[test]
    fn open_build_kept_and_ascendancy_full() {
        let goal = r#"{"assume":{"playMode":"mapping"},"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":1000000},{"name":"EHP","metric":"ehp","value":50000}],"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        let run = |xml: String| {
            let mut h = start(xml, goal, r#"{"timeBudgetMs":600000,"maxEvals":40000,"threads":4}"#).unwrap();
            h.join();
            let (snap, _) = h.step(0, 0);
            assert!(snap.get("error").is_none(), "{snap}");
            println!("layers: {}", snap["layers"]);
            assert!(snap["layers"].as_array().unwrap().iter().any(|l| l["layer"] == "expert: beam"), "{}", snap["layers"]);
            for r in snap["results"].as_array().unwrap() {
                println!("result {} score {:.4} parts {}", r["label"], r["score"].as_f64().unwrap_or(0.0), r["parts"]);
            }
            let x = h.result_xml(0).unwrap();
            (snap, x)
        };
        let (a, xml) = run(blank_build_xml(90));
        let r = &a["results"][0];
        assert_eq!(r["ascendancyPointsUsed"], 8, "{r}");
        assert!(r["items"].as_array().is_some_and(|i| i.len() >= 10), "{r}");
        let (b, _) = run(xml);
        let res = b["results"].as_array().unwrap();
        let start = res.iter().find(|e| e["start"] == true).expect("the open build is listed");
        assert!(res[0]["score"].as_f64().unwrap() >= start["score"].as_f64().unwrap() - 1e-9);
        assert!(res.iter().filter(|e| e["start"] != true).all(|e| e["ascendancyPointsUsed"] == 8));
        assert_eq!(b["results"][0]["className"], "Duelist");
    }

    /// "A Templar with a unique weapon with Flicker Strike": className keeps the solver to Templar ascendancies and
    /// items.slotRarities makes Weapon 1 a unique (a crafted rare never sits there).
    #[test]
    fn class_and_unique_weapon_kept() {
        let goal = r#"{"assume":{"playMode":"mapping"},"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS"}],"items":{"slotRarities":{"Weapon 1":["unique"]}}}"#;
        let mut h = start(blank_build_xml(90), goal, r#"{"timeBudgetMs":600000,"maxEvals":40000,"threads":2}"#).unwrap();
        h.join();
        let (snap, _) = h.step(0, 0);
        assert!(snap.get("error").is_none(), "{snap}");
        let res = snap["results"].as_array().unwrap();
        assert!(!res.is_empty());
        for (i, r) in res.iter().enumerate() {
            let x = h.result_xml(i).unwrap();
            let id = x.split("<Slot name=\"Weapon 1\" itemId=\"").nth(1).and_then(|t| t.split('"').next()).unwrap_or("0").to_string();
            let item = x.split(&format!("<Item id=\"{id}\"")).nth(1).and_then(|t| t.split('>').nth(1)).unwrap_or("").trim_start().to_string();
            println!("result {i}: {} / {} weapon: {}", r["className"], r["ascendancy"], item.lines().next().unwrap_or(""));
            assert_eq!(r["className"], "Templar", "{r}");
            assert!(item.starts_with("Rarity: UNIQUE"), "Weapon 1 is not a unique: {item:.80}");
        }
    }

    /// Config switches per candidate (config-sources.json): a Flicker Strike link with Fortify is Fortified (with the
    /// reason), one without any fortify source is not; the melee strike stands 15 units from the enemy; a close call
    /// comes back as an offer with what it adds (engine delta).
    #[test]
    fn config_switches_follow_the_build() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS"}],"items":{"mustUse":["Starforge"]},"assume":{"configOn":["useFrenzyCharges"]}}"#);
        let c = s.candidates().unwrap();
        let fortify = find_gem("Fortify").unwrap();
        let mut with = s.initial_state(c[0], Some((vec![s.main_gem, fortify], vec![])), None).unwrap();
        // (Slayer's Headsman: attack speed after killing a rare or unique enemy, a close call while mapping)
        let reach = s.ctx[c[0]].bfs(&HashSet::default(), true);
        with.nodes = s.ctx[c[0]].path_to(&reach, 3184);
        s.rebase(&mut with).unwrap();
        let without = s.initial_state(c[0], Some((vec![s.main_gem], vec![])), None).unwrap();
        let cw = s.config_for(&with, &with.vals);
        let f = cw.on.iter().find(|o| o.key == "buffFortification").unwrap_or_else(|| panic!("Fortified is on: {:?}", cw.on.iter().map(|o| &o.key).collect::<Vec<_>>()));
        assert_eq!(f.reason, "Fortify support");
        assert!(!s.config_for(&without, &without.vals).on.iter().any(|o| o.key == "buffFortification"), "no fortify source, not Fortified");
        let md = cw.on.iter().find(|o| o.key == "meleeDistance").expect("melee distance set");
        assert!(md.xml.contains("number=\"15\""), "{}", md.xml);
        let xml = Arc::new(s.render(&with).unwrap());
        assert!(xml.contains("<Input name=\"buffFortification\" boolean=\"true\"/>"));
        let vals = s.eval(vec![Cand::Xml(xml.clone())]).pop().flatten().unwrap();
        let before = s.evals.load(Ordering::Relaxed);
        let (_, _, on, offers) = s.settle_config(&with, xml, vals);
        println!("settle evals: {}", s.evals.load(Ordering::Relaxed) - before);
        for o in &on {
            println!("on  {} = {}  [{}]", o.key, o.reason, o.xml);
        }
        for (o, d, t) in &offers {
            println!("offer {} ({}) {t} {d:.3}", o.key, o.reason);
        }
        assert!(on.iter().any(|o| o.key == "buffFortification" && o.reason == "Fortify support"));
        assert!(offers.iter().any(|(o, d, t)| !data_high(&o.key) && d.abs() >= 0.005 && t.contains('%')), "a close call is offered with its delta");
    }

    fn data_high(key: &str) -> bool {
        let raw: Value = serde_json::from_str(include_str!("../../../engine-data/config-sources.json")).unwrap();
        raw["switches"].as_array().unwrap().iter().any(|s| s["key"] == key && s["confidence"] == "high")
    }
}
