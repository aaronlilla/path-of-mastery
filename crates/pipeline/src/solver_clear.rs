//! Mapping clear score: how much of a pack the main skill
//! kills, not how hard it hits one monster. Every term is found by mechanic class, read from parsed mods, engine outputs,
//! skill types and gem stat ids (the registry `engine-data/mechanic_classes.json`), never by item, gem or node name, so
//! a new patch's sources of a known class count with no code change.
//!
//! ClearDPS = (hitDPS x Targets_hit + ailmentDPS x Targets_ail + capped cull) + explosions. The scorer multiplies it by
//! the share of time spent attacking, like the single-target damage target. Weights, the pack size and the cover curve
//! are policy.
use pom_engine::fxhash::{HashMap, HashSet};
use pom_skills::data as gd;
use serde_json::Value as J;
use std::sync::OnceLock;

/// Monsters in an engaged pack. The same N as config-sources.json `multiplierNearbyEnemies` (mapping), so "per nearby
/// enemy" mods and the Targets term read one pack (the `pack_matches_config` test pins it).
pub const PACK: f64 = 5.0;
/// Cull counts at most this share on top of the damage (policy).
const CULL_CAP: f64 = 0.15;
/// Splash radius when the engine gives the skill none (policy: about a melee swing's reach).
const SPLASH_RADIUS: f64 = 1.5;

/// Share of the pack an area of `radius_m` metres covers: min(1, (r / 3 m)^2) (policy).
fn cover(radius_m: f64) -> f64 {
    (radius_m.max(0.0) / 3.0).powi(2).min(1.0)
}

/// The class registry: which parsed mod names, flags, stat ids and skill structures belong to which class.
#[derive(Clone, Debug, Default)]
pub struct Registry {
    pub classes: Vec<Class>,
    pub skill_types: HashMap<String, i64>,
    pub keywords: Vec<String>,
    pub inert_prefixes: Vec<String>,
    pub inert_contains: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Class {
    pub class: String,
    pub mod_names: Vec<String>,
    pub flags: Vec<String>,
    pub stat_ids: Vec<String>,
    pub stat_contains: Vec<String>,
    /// Support structure: adds this skill type to skills that require that one (a splash support).
    pub adds: Option<i64>,
    pub requires: Option<i64>,
    /// Constant stats whose id contains this are the class's damage factor (+%, e.g. -40 -> 0.6).
    pub damage_stat: Option<String>,
    /// The engine output the class scales (ailment-spread: IgniteDPS).
    pub output: Option<String>,
    /// Tag vars that carry the class (pack-density-scaling: NearbyEnemies).
    pub tag_vars: Vec<String>,
}

impl Registry {
    pub fn from_json(text: &str) -> Result<Registry, String> {
        let j: J = serde_json::from_str(text).map_err(|e| format!("mechanic_classes.json: {e}"))?;
        let strs = |v: &J| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let skill_types: HashMap<String, i64> = j["skillTypes"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n))).collect()).unwrap_or_default();
        let ty = |v: &J| v.as_str().and_then(|s| skill_types.get(s).copied());
        let classes = j["classes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| Class {
                class: c["class"].as_str().unwrap_or("").to_string(),
                mod_names: strs(&c["modNames"]),
                flags: strs(&c["flags"]),
                stat_ids: strs(&c["statIds"]),
                stat_contains: strs(&c["statContains"]),
                adds: ty(&c["structure"]["adds"]),
                requires: ty(&c["structure"]["requires"]),
                damage_stat: c["damageStat"].as_str().map(String::from),
                output: c["output"].as_str().map(String::from),
                tag_vars: strs(&c["tagVars"]),
            })
            .collect();
        Ok(Registry { classes, skill_types: skill_types.clone(), keywords: strs(&j["keywords"]), inert_prefixes: strs(&j["inertStatPrefixes"]), inert_contains: strs(&j["inertStatContains"]) })
    }

    pub fn class(&self, name: &str) -> Option<&Class> {
        self.classes.iter().find(|c| c.class == name)
    }

    pub fn ty(&self, name: &str) -> i64 {
        self.skill_types.get(name).copied().unwrap_or(-1)
    }

    /// The class a gem stat id belongs to.
    pub fn class_of_stat(&self, id: &str) -> Option<&str> {
        self.classes.iter().find(|c| c.stat_ids.iter().any(|s| s == id) || c.stat_contains.iter().any(|s| id.contains(s.as_str()))).map(|c| c.class.as_str())
    }

    /// The class a parsed mod (name, or a tag var it carries) belongs to.
    pub fn class_of_mod(&self, name: &str, tag_vars: &[String]) -> Option<&str> {
        self.classes.iter().find(|c| c.mod_names.iter().chain(&c.flags).any(|m| m == name) || tag_vars.iter().any(|v| c.tag_vars.contains(v))).map(|c| c.class.as_str())
    }
}

pub fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| Registry::from_json(include_str!("../../../engine-data/mechanic_classes.json")).expect("mechanic_classes.json"))
}

/// One support the main skill has: the structure fields the registry tests and its stats with values.
#[derive(Clone, Debug, Default)]
pub struct Support {
    pub adds: HashSet<i64>,
    pub requires: Vec<i64>,
    pub stats: Vec<(String, f64)>,
}

/// What the clear score reads from one evaluation.
#[derive(Clone, Debug, Default)]
pub struct ClearIn {
    /// Engine outputs (CombinedDPS, CullingDPS, StrikeTargets, ChainMax, PierceCount, ForkCountMax, SplitCount,
    /// ProjectileCount, AreaOfEffectRadiusMetres, IgniteDPS, ...).
    pub out: HashMap<String, f64>,
    /// The main skill's types after its supports.
    pub types: HashSet<i64>,
    /// Projectiles fire one after another at one target (CalcOffence.lua:803-805): upstream already multiplies by the count.
    pub sequential: bool,
    pub pierce_all: bool,
    /// Stat ids of the main skill's own effect, with values.
    pub stats: Vec<(String, f64)>,
    pub supports: Vec<Support>,
    /// (chance 0..1, amount % of life) of every explode-on-kill mod that applies to the main skill.
    pub explode: Vec<(f64, f64)>,
    /// Projectiles the engine already counts as overlapping explosions on one target (crate::proj_overlap); 0 = none.
    pub overlap: f64,
}

/// The clear score and the classes that made it.
#[derive(Clone, Debug, Default)]
pub struct Clear {
    pub value: f64,
    pub targets_hit: f64,
    pub targets_ail: f64,
    /// (class, what it added: extra targets for target classes, DPS for the others).
    pub parts: Vec<(String, f64)>,
    /// A minion main's minion, scored the same way from the minion's own outputs (in `value`).
    pub minion: Option<Box<Clear>>,
}

impl Clear {
    /// One line for result text: "Clears 3.4 of 5 (strike-targets +2, area-of-effect +0.4); explode-on-kill +12k DPS".
    pub fn text(&self) -> String {
        let t: Vec<String> = self.parts.iter().filter(|p| !matches!(p.0.as_str(), "explode-on-kill" | "cull-instant-kill" | "ailment-spread")).map(|(c, v)| format!("{c} +{v:.1}")).collect();
        let d: Vec<String> = self.parts.iter().filter(|p| matches!(p.0.as_str(), "explode-on-kill" | "cull-instant-kill")).map(|(c, v)| format!("{c} +{:.0} DPS", v)).collect();
        let mut s = format!("Hits {:.1} of a {PACK:.0}-monster pack", self.targets_hit);
        if !t.is_empty() {
            s += &format!(" ({})", t.join(", "));
        }
        if self.targets_ail > 1.0 {
            s += &format!("; ailment spreads to {:.1}", self.targets_ail);
        }
        if !d.is_empty() {
            s += &format!("; {}", d.join(", "));
        }
        match self.minion.as_deref() {
            Some(m) if m.parts.is_empty() && m.targets_hit <= 1.0 => s += "; minion: single target (the engine gives no area, chain, pierce or strike targets for it)",
            Some(m) => s += &format!("; minion: {}", m.text()),
            None => {}
        }
        s
    }
}

pub fn clear_score(i: &ClearIn) -> f64 {
    clear(i, registry()).value
}

pub fn clear(i: &ClearIn, reg: &Registry) -> Clear {
    let o = |k: &str| i.out.get(k).copied().filter(|v| v.is_finite()).unwrap_or(0.0);
    let n1 = PACK - 1.0;
    let has = |t: &str| i.types.contains(&reg.ty(t));
    let all_stats = || i.stats.iter().chain(i.supports.iter().flat_map(|s| s.stats.iter()));
    let mut parts: Vec<(String, f64)> = Vec::new();
    let mut extra = 0.0;
    let add = |parts: &mut Vec<(String, f64)>, class: &str, v: f64| {
        if v > 1e-9 {
            parts.push((class.to_string(), v));
        }
        v
    };
    // strike-targets: the engine's own count (every source of AdditionalStrikeTarget).
    extra += add(&mut parts, "strike-targets", (o("StrikeTargets") - 1.0).clamp(0.0, n1));
    // (the engine sets a radius only for skills with one; area cover counts only for area skills)
    let radius = if has("Area") { o("AreaOfEffectRadiusMetres") } else { 0.0 };
    // melee-splash: a support of the registry's structure, or one carrying the class's stat id; its damage factor
    // from its own constant stat.
    let splash = reg.class("melee-splash").and_then(|c| {
        i.supports.iter().find(|s| (c.adds.is_some_and(|a| s.adds.contains(&a)) && c.requires.is_some_and(|r| s.requires.contains(&r))) || s.stats.iter().any(|(id, _)| c.stat_ids.contains(id))).map(|s| {
            let pct: f64 = c.damage_stat.as_deref().map_or(0.0, |d| s.stats.iter().filter(|(id, _)| id.contains(d)).map(|x| x.1).sum());
            (1.0 + pct / 100.0).max(0.0)
        })
    });
    if let Some(f) = splash {
        extra += add(&mut parts, "melee-splash", n1 * cover(if radius > 0.0 { radius } else { SPLASH_RADIUS }) * f);
    } else if has("Area") {
        extra += add(&mut parts, "area-of-effect", n1 * cover(radius));
    }
    // projectile-multihit (chain 1, pierce/fork/split 0.5, extra projectiles 0.25 unless they already hit one target).
    // (an explode-only projectile, by its gem stat, flies to one spot and explodes: no pierce, chain, fork or split)
    let explode_only = reg.class("projectile-explode-only").is_some_and(|c| i.stats.iter().any(|(id, _)| c.stat_ids.contains(id)));
    let pierce = if i.pierce_all { n1 } else { o("PierceCount").min(n1) };
    let travel = if explode_only { 0.0 } else { o("ChainMax").min(n1) + 0.5 * pierce + 0.5 * o("ForkCountMax") + 0.5 * o("SplitCount") };
    // (overlapping explosions are already in CombinedDPS, and each of them splashes the pack through the area term)
    let proj = travel + if i.sequential { 0.0 } else { 0.25 * (o("ProjectileCount") - i.overlap.max(1.0)).max(0.0) };
    extra += add(&mut parts, "projectile-multihit", proj);
    // skill-intrinsic-extra-targets: stat ids upstream drops (no SkillStatMap entry) that name extra targets.
    if let Some(c) = reg.class("skill-intrinsic-extra-targets") {
        let v: f64 = i.stats.iter().filter(|(id, _)| c.stat_ids.contains(id) || c.stat_contains.iter().any(|s| id.contains(s.as_str()))).map(|x| x.1).sum();
        extra += add(&mut parts, "skill-intrinsic-extra-targets", v.min(n1));
    }
    let targets_hit = 1.0 + extra.min(n1);
    // ailment-spread: a stat id of the class (radius in tenths of a metre) spreads the class's ailment output.
    let (mut ail, mut targets_ail) = (0.0, 1.0);
    if let Some(c) = reg.class("ailment-spread") {
        if let Some(r) = all_stats().filter(|(id, _)| c.stat_ids.contains(id) || c.stat_contains.iter().any(|s| id.contains(s.as_str()))).map(|x| x.1).reduce(f64::max) {
            ail = c.output.as_deref().map_or(0.0, o);
            targets_ail = 1.0 + n1 * cover(r / 10.0);
            add(&mut parts, "ailment-spread", targets_ail - 1.0);
        }
    }
    let cull = o("CullingDPS").max(0.0);
    let base = (o("CombinedDPS") - cull).max(0.0);
    // Each enemy a hit strikes gets its own poison, bleed or ignite: x the targets hit. Decay, a skill's own DoT and
    // ground DoT stay on one enemy: x 1. A spread class's ailment reaches the enemies it spreads to, if more.
    // (the parts of TotalDotDPS as offence_dps.rs sums them; scaled down together when the DoT cap cut the total)
    let dot = (o("TotalDotDPS") * i.out.get("ReservationDpsMultiplier").copied().unwrap_or(1.0)).min(base);
    let ignite = i.out.get("TotalIgniteDPS").or(i.out.get("IgniteDPS")).copied().filter(|v| v.is_finite()).unwrap_or(0.0);
    let hit_ail = o("TotalPoisonDPS") + ignite + o("BleedDPS");
    let raw = hit_ail + o("TotalDot") + o("CausticGroundDPS").max(o("MirageCausticGroundDPS")) + o("BurningGroundDPS").max(o("MirageBurningGroundDPS")) + o("CorruptingBloodDPS") + o("DecayDPS");
    let hit_ail = if raw > 0.0 { hit_ail * dot / raw } else { 0.0 };
    let ail = ail.min(hit_ail);
    let cull = add(&mut parts, "cull-instant-kill", cull.min(CULL_CAP * base));
    let direct = (base - dot + hit_ail - ail) * targets_hit + ail * targets_hit.max(targets_ail) + (dot - hit_ail);
    // explode-on-kill: kills per second = direct / monster life, each spreads chance x amount% of a life to the pack
    // members it reaches (min(1, cover + 0.5) of them), so monster life cancels out.
    let per_kill: f64 = i.explode.iter().map(|(c, a)| c * a / 100.0).sum();
    let explode = add(&mut parts, "explode-on-kill", direct * per_kill * n1 * (cover(radius) + 0.5).min(1.0));
    Clear { value: direct + cull + explode, targets_hit, targets_ail, parts, minion: None }
}

/// Stats of a granted effect at a level and quality: its level stats and constant stats.
fn effect_stats(ge: &pom_engine::data::gems::GrantedEffect, level: f64, quality: f64) -> Vec<(String, f64)> {
    let mut ids: Vec<String> = ge.stats.clone();
    if let Some(cs) = gd::extra(ge, "constantStats").and_then(|v| v.as_array()) {
        ids.extend(cs.iter().filter_map(|c| c.as_array().and_then(|a| a.first()).and_then(|s| s.as_str()).map(String::from)));
    }
    ids.dedup();
    ids.into_iter().map(|id| {
        let v = gd::stat_value(ge, level, quality, &id);
        (id, v)
    }).collect()
}

/// The clear inputs of an evaluated build (None without a main skill).
pub fn clear_in(env: &crate::Env) -> Option<ClearIn> {
    use pom_engine::modifier::ModType;
    use pom_engine::sym::Sym;
    let main = crate::offence::select_main_skill(&env.xml_text, &env.active_skills)?;
    let flag = |n: &str| main.skill_mod_list.iter().any(|m| m.name == Sym::new(n));
    let cfg = crate::buffs::skill_cfg(main);
    let explode = env
        .player
        .tabulate(Some(ModType::List), Some(&cfg), &[Sym::new("ExplodeMod")])
        .into_iter()
        .filter_map(|(v, _)| Some((v.get(Sym::new("chance")).num().unwrap_or(1.0), v.get(Sym::new("amount")).num()?)))
        .collect();
    let stats = gd::granted_effect_by_skill_id(&main.granted_effect_id).map(|ge| effect_stats(ge, main.gem_effective.0.max(1.0), main.gem_effective.1)).unwrap_or_default();
    let supports = main
        .effect_list
        .iter()
        .filter_map(|&k| main.support_list.get(k))
        .map(|(ge, level, quality)| Support { adds: gd::add_skill_types(ge), requires: gd::skill_type_expr(ge, "requireSkillTypes"), stats: effect_stats(ge, *level, *quality) })
        .collect();
    let out = env.output.iter().filter(|(_, v)| v.is_finite()).map(|(k, v)| (k.clone(), *v)).collect();
    Some(ClearIn {
        out,
        types: main.skill_types.iter().copied().collect(),
        sequential: flag("SequentialProjectiles") && !flag("OneShotProj") && !flag("NoAdditionalProjectiles") && !flag("TriggeredBySnipe"),
        pierce_all: env.output_str.get("PierceCountString").is_some_and(|s| s == "All targets"),
        stats,
        supports,
        explode,
        overlap: crate::proj_overlap::overlap(&main.granted_effect_id, &main.skill_types, flag("SequentialProjectiles"), env.output.get("ProjectileCount").copied().unwrap_or(1.0), &env.config_input).unwrap_or(0.0),
    })
}

/// A minion main's minion as clear inputs: its own outputs (area when it has a radius); its skill's stats and the
/// player's explode mods are not read.
fn minion_in(env: &crate::Env) -> Option<ClearIn> {
    let (_, _, out) = env.minion_info.as_ref()?;
    let out: HashMap<String, f64> = out.iter().filter(|(_, v)| v.is_finite()).map(|(k, v)| (k.clone(), *v)).collect();
    let area = out.get("AreaOfEffectRadiusMetres").is_some_and(|r| *r > 0.0);
    Some(ClearIn { types: if area { [registry().ty("Area")].into_iter().collect() } else { HashSet::default() }, out, ..Default::default() })
}

/// The build's clear: the main skill's, plus its minion's when the main skill has one.
pub fn clear_env(env: &crate::Env) -> Option<Clear> {
    let mut c = clear(&clear_in(env)?, registry());
    // Only a minion skill's own minion: a support's (Summon Phantasm on a strike) is left out, as upstream's CombinedDPS does.
    let minion_main = crate::offence::select_main_skill(&env.xml_text, &env.active_skills).and_then(|m| gd::granted_effect_by_skill_id(&m.granted_effect_id)).is_some_and(|ge| gd::skill_types(ge).contains(&pom_skills::skill_type::MINION));
    if let Some(m) = minion_in(env).filter(|_| minion_main) {
        let m = clear(&m, registry());
        c.value += m.value;
        c.minion = Some(Box::new(m));
    }
    Some(c)
}

/// `Solver.ClearDPS`, `Solver.ClearTargets`.
pub(crate) fn solver_stat(env: &crate::Env, key: &str) -> Option<f64> {
    let c = clear_env(env)?;
    match key {
        "ClearDPS" => Some(c.value),
        "ClearTargets" => Some(c.targets_hit),
        _ => None,
    }
}

/// The clear breakdown of an evaluated build, for result text.
pub fn clear_text(env: &crate::Env) -> Option<String> {
    Some(clear_env(env)?.text())
}

/// `pom-cli clear-score <build.xml>`: the clear score, its breakdown and single-target DPS of a saved build.
pub fn clear_of_xml(xml: &str) -> Result<String, String> {
    load_text_rules();
    pom_engine::modparser::text_rules::set_active(true);
    let mut s = crate::session::Session::new(xml.to_string(), pom_calc::data::game_data());
    s.eval_xml(xml, false, |env| {
        let c = clear_env(env).ok_or("no main skill")?;
        let o = |k: &str| env.output.get(k).copied().unwrap_or(0.0);
        Ok(format!("ClearDPS {:.0} (x attack share {:.2}), CombinedDPS {:.0}, Targets {:.2}\n{}\nparts: {:?}", c.value, crate::stat_value(env, "Solver.AttackTimeShare").unwrap_or(1.0), o("CombinedDPS"), c.targets_hit, c.text(), c.parts))
    })?
}

/// Loads engine-data/mechanic_text_rules.json into the mod parser (once per process; solves call it at start).
pub fn load_text_rules() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        if pom_engine::modparser::text_rules::loaded().is_none() {
            if let Err(e) = pom_engine::modparser::text_rules::load(include_str!("../../../engine-data/mechanic_text_rules.json")) {
                eprintln!("text rules not loaded: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Session;
    use pom_engine::modparser::text_rules::Rules;
    use pom_engine::modparser::types::PVal;

    /// A blank level-90 build with one socket group (the first gem is the main skill) and optional ring lines.
    fn build(gems: &[&str], ring: &[&str]) -> String {
        let g: String = gems.iter().map(|n| format!("<Gem nameSpec=\"{n}\" level=\"20\" quality=\"0\" enabled=\"true\"/>")).collect();
        let x = super::super::blank_build_xml(90).replace("<SkillSet id=\"1\" />", &format!("<SkillSet id=\"1\"><Skill enabled=\"true\" mainActiveSkill=\"1\">{g}</Skill></SkillSet>"));
        // (a sword: Flicker Strike needs a melee weapon)
        x.replace(
            "<ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />",
            &format!("<Item id=\"1\">Rarity: NORMAL\nCorsair Sword\nItem Level: 90\nLevelReq: 1\nImplicits: 0</Item><Item id=\"2\">Rarity: RARE\nTest Burst Ring\nIron Ring\nItem Level: 90\nLevelReq: 1\nImplicits: 0\n{}</Item><ItemSet useSecondWeaponSet=\"nil\" id=\"1\"><Slot name=\"Weapon 1\" itemId=\"1\"/><Slot name=\"Ring 1\" itemId=\"2\"/></ItemSet>", ring.join("\n")),
        )
    }

    fn eval(x: &str) -> (Clear, f64) {
        let mut s = Session::new(x.to_string(), pom_calc::data::game_data());
        s.eval_xml(x, false, |env| (clear_env(env).expect("main skill"), env.output.get("CombinedDPS").copied().unwrap_or(0.0))).unwrap()
    }

    fn part(c: &Clear, class: &str) -> f64 {
        c.parts.iter().find(|p| p.0 == class).map_or(0.0, |p| p.1)
    }

    fn rules() -> Rules {
        Rules::from_json(include_str!("../../../engine-data/mechanic_text_rules.json")).unwrap()
    }

    /// Flicker Strike hits one monster; an additional-strike-target source (Ancestral Call: the stat id the engine
    /// maps to AdditionalStrikeTarget) adds its count to Targets.
    #[test]
    fn targets_strike_additional() {
        let (alone, _) = eval(&build(&["Flicker Strike"], &[]));
        let (ac, dps) = eval(&build(&["Flicker Strike", "Ancestral Call"], &[]));
        assert!((alone.targets_hit - 1.0).abs() < 1e-9, "{alone:?}");
        assert!((ac.targets_hit - 3.0).abs() < 1e-9 && part(&ac, "strike-targets") == 2.0, "{ac:?}");
        assert!(dps > 0.0 && (ac.value - dps * 3.0).abs() < 1e-6 * dps, "ClearDPS = DPS x Targets: {} vs {dps}", ac.value);
    }

    /// Melee Splash on Flicker: extra targets x cover x the support's own splash damage constant (-40 -> 0.6), read
    /// from gem data; no separate area term on top.
    #[test]
    fn targets_splash_from_gem_data() {
        let (c, _) = eval(&build(&["Flicker Strike", "Melee Splash"], &[]));
        let splash = part(&c, "melee-splash");
        assert!(splash > 0.0 && part(&c, "area-of-effect") == 0.0, "{c:?}");
        let r = (splash / ((PACK - 1.0) * 0.6)).sqrt() * 3.0;
        assert!(r > 0.5 && r <= 3.0, "splash cover reads a radius of {r} m: {c:?}");
    }

    /// Poisonous Concoction's projectile only explodes (gem stat `projectile_behaviour_only_explode`): Pierce gives the
    /// engine a PierceCount, but no second enemy is reached, so it adds no targets.
    #[test]
    fn explode_only_projectile_no_pierce_targets() {
        let unarmed = build(&["Poisonous Concoction", "Pierce"], &[]).replace("<Slot name=\"Weapon 1\" itemId=\"1\"/>", "");
        let (c, dps) = eval(&unarmed);
        assert!(dps > 0.0, "the skill runs unarmed");
        assert_eq!(part(&c, "projectile-multihit"), 0.0, "{c:?}");
    }

    /// The pconc solve's top result re-evaluated: its Pierce support adds no targets. Then with the fakes out (Fortified from a
    /// melee-only line, charges from an enemy with no armour or evasion, the main link in an empty body slot cut to the
    /// gloves' 4-link, Wither + Spell Totem moved from the empty main hand to the boots), printed for the report.
    #[test]
    fn pconc_solve_reevaluated() {
        let x = std::fs::read_to_string(format!("{}/testdata/pconc-result0.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let get = |x: &str| {
            let mut s = Session::new(x.to_string(), pom_calc::data::game_data());
            s.eval_xml(x, false, |env| (clear_env(env).expect("main skill"), crate::stat_value(env, "Solver.AttackTimeShare").unwrap_or(1.0), env.output.get("TotalEHP").copied().unwrap_or(0.0))).unwrap()
        };
        let (c0, share0, ehp0) = get(&x);
        assert_eq!(part(&c0, "projectile-multihit"), 0.0, "{c0:?}");
        let mut h = x.clone();
        for k in ["buffFortification", "useFrenzyCharges", "useEnduranceCharges", "conditionGainedFrenzyChargeRecently"] {
            h = h.replace(&format!("<Input name=\"{k}\" boolean=\"true\"/>"), "");
        }
        h = h.replace("slot=\"Body Armour\"", "slot=\"Gloves\"").replace("slot=\"Weapon 1\"", "slot=\"Boots\"");
        for g in ["Added Chaos Damage", "Pierce"] {
            let a = h.find(&format!("<Gem nameSpec=\"{g}\"")).unwrap();
            let b = a + h[a..].find("/>").unwrap() + 2;
            h.replace_range(a..b, "");
        }
        let (c1, share1, ehp1) = get(&h);
        println!("result0 as written, pierce fixed: ClearDPS {:.0} (x share {share0:.2} = {:.0}), EHP {ehp0:.0}; {}", c0.value, c0.value * share0, c0.text());
        println!("result0 honest: ClearDPS {:.0} (x share {share1:.2} = {:.0}), EHP {ehp1:.0}; {}", c1.value, c1.value * share1, c1.text());
    }

    /// A line the parser reads as ExplodeMod (explode-on-kill) adds the kill-rate term; text rules read the strike-gated
    /// wording and credit it to a strike main only.
    #[test]
    fn explode_and_text_rules() {
        let plain = "Enemies you kill explode, dealing 5% of their life as fire damage";
        assert!(matches!(pom_engine::modparser::text_rules::parse_mod_no_rules(plain), (Some(ref m), None) if m.iter().any(|m| m.name == "ExplodeMod")));
        let (c, _) = eval(&build(&["Flicker Strike"], &[plain]));
        let e = part(&c, "explode-on-kill");
        // (5% x 4 others x min(1, 0 + 0.5) = 0.1 of the direct clear)
        assert!(e > 0.0 && (e / (c.value - e) - 0.1).abs() < 1e-6, "{c:?}");

        // text_rule_strike_targets: unread by the parser, read by the rule (MeleeSingleTarget, not Vaal).
        let st = "Strike Skills target 2 additional nearby Enemies";
        assert!(!matches!(pom_engine::modparser::text_rules::parse_mod_no_rules(st), (Some(_), None)));
        assert!(Rules::default().apply(st).is_none());
        let r = rules();
        let (rule, m) = r.apply(st).expect("rule reads it");
        assert_eq!((rule.id.as_str(), m[0].name.as_str(), &m[0].value), ("strike-targets-text", "AdditionalStrikeTarget", &PVal::Num(2.0)));
        assert!(format!("{:?}", m[0].tags).contains("21"), "{:?}", m[0].tags);

        // text_rule_explode_gate: gated to strike skills; an unknown qualifier reads nothing.
        let gated = "Enemies you kill with Strike Skills explode, dealing 5% of their Life as Fire Damage";
        assert!(!matches!(pom_engine::modparser::text_rules::parse_mod_no_rules(gated), (Some(_), None)));
        assert!(r.apply("Enemies you kill with Spells explode, dealing 5% of their Life as Fire Damage").is_none());
        load_text_rules();
        pom_engine::modparser::text_rules::set_active(true);
        assert!(matches!(pom_engine::modparser::parse_mod(st), (Some(ref m), None) if m[0].name == "AdditionalStrikeTarget"));
        let (strike, _) = eval(&build(&["Flicker Strike"], &[gated]));
        let (spell, _) = eval(&build(&["Fireball"], &[gated]));
        assert!(part(&strike, "explode-on-kill") > 0.0, "{strike:?}");
        assert_eq!(part(&spell, "explode-on-kill"), 0.0, "{spell:?}");
        let (st_build, _) = eval(&build(&["Flicker Strike"], &[st]));
        assert!((st_build.targets_hit - 3.0).abs() < 1e-9, "rule-read strike targets reach Targets: {st_build:?}");
    }

    #[test]
    fn sequential_guard() {
        let mut i = ClearIn { out: [("CombinedDPS".to_string(), 1000.0), ("ProjectileCount".to_string(), 5.0)].into_iter().collect(), ..Default::default() };
        assert_eq!(part(&clear(&i, registry()), "projectile-multihit"), 1.0);
        i.sequential = true;
        assert_eq!(part(&clear(&i, registry()), "projectile-multihit"), 0.0);
    }

    /// One pack size: the mapping value of "# of nearby Enemies" is PACK and it is set by itself (not an offer).
    #[test]
    fn pack_matches_config() {
        let j: J = serde_json::from_str(include_str!("../../../engine-data/config-sources.json")).unwrap();
        let sw = j["switches"].as_array().unwrap().iter().find(|s| s["key"] == "multiplierNearbyEnemies").unwrap();
        assert_eq!((sw["valueRule"]["cases"][0]["mapping"].as_f64(), sw["confidence"].as_str()), (Some(PACK), Some("high")));
    }

    /// A bare "DPS" is single target in every mode (the sidebar number); bossing scores boss DPS; clear is an explicit metric.
    #[test]
    fn mapping_goal_bare_dps_is_single_target() {
        let stats = |g: &str| {
            let g: super::super::Goal = serde_json::from_str(g).unwrap();
            let (sc, _) = super::super::Scorer::new(&g).unwrap();
            sc.targets[0].stats.iter().map(|&k| sc.names[k].clone()).collect::<Vec<_>>()
        };
        assert_eq!(stats(r#"{"skill":"Flicker Strike","targets":[{"name":"DPS"}]}"#), vec!["Solver.SingleDPS".to_string()]);
        assert_eq!(stats(r#"{"skill":"Flicker Strike","assume":{"playMode":"bossing"},"targets":[{"name":"DPS"}]}"#), vec!["Solver.BossDPS".to_string()]);
        assert_eq!(stats(r#"{"skill":"Flicker Strike","targets":[{"name":"DPS","metric":"combined"}]}"#), vec!["CombinedDPS".to_string()]);
        assert_eq!(stats(r#"{"skill":"Flicker Strike","targets":[{"name":"DPS","metric":"dps"}]}"#), vec!["Solver.SingleDPS".to_string()]);
        assert_eq!(stats(r#"{"skill":"Flicker Strike","targets":[{"name":"DPS","metric":"hit"}]}"#), vec!["TotalDPS".to_string()]);
        // Clear stays available by name.
        assert_eq!(stats(r#"{"skill":"Flicker Strike","targets":[{"name":"Clear","metric":"clear"}]}"#), vec!["Solver.ClearDPS".to_string()]);
    }

    /// A minion main's clear counts its minion, from the minion's own outputs.
    #[test]
    fn minion_main_clear() {
        let (c, _) = eval(&build(&["Summon Raging Spirit"], &[]));
        let m = c.minion.as_deref().expect("minion clear");
        assert!(m.value > 0.0 && c.value >= m.value, "{c:?}");
        assert!(c.text().contains("minion"), "{}", c.text());
    }

    /// Decay and other plain DoT stay on the enemy they are on: only hits (and a spread class's ailment) count across
    /// the pack. A player main gets no minion term.
    #[test]
    fn dot_not_times_pack() {
        let x = build(&["Flicker Strike", "Decay", "Greater Ancestral Call"], &[]);
        let mut s = Session::new(x.clone(), pom_calc::data::game_data());
        let (c, cd, dot) = s
            .eval_xml(&x, false, |env| {
                let o = |k: &str| env.output.get(k).copied().unwrap_or(0.0);
                (clear_env(env).expect("main skill"), o("CombinedDPS"), o("TotalDotDPS"))
            })
            .unwrap();
        assert!(dot > 0.0 && c.targets_hit > 1.0, "{c:?} dot {dot}");
        assert!(c.minion.is_none(), "{c:?}");
        assert!((c.value - ((cd - dot) * c.targets_hit + dot)).abs() < 1e-6 * cd, "ClearDPS {} vs hits {} x {} + DoT {dot}", c.value, cd - dot, c.targets_hit);
    }

    /// Each enemy a hit strikes gets its own poison: hit-applied ailment DPS counts x the targets hit.
    #[test]
    fn hit_poison_times_targets() {
        let x = build(&["Flicker Strike", "Chance to Poison", "Ancestral Call"], &[]);
        let mut s = Session::new(x.clone(), pom_calc::data::game_data());
        let (c, cd, dot, poison) = s
            .eval_xml(&x, false, |env| {
                let o = |k: &str| env.output.get(k).copied().unwrap_or(0.0);
                (clear_env(env).expect("main skill"), o("CombinedDPS"), o("TotalDotDPS"), o("TotalPoisonDPS"))
            })
            .unwrap();
        assert!(poison > 0.0 && c.targets_hit > 1.0, "{c:?} poison {poison}");
        let want = (cd - dot + poison) * c.targets_hit + (dot - poison);
        assert!((c.value - want).abs() < 1e-6 * cd, "ClearDPS {} vs (hit {} + poison {poison}) x {} + other DoT {}", c.value, cd - dot, c.targets_hit, dot - poison);
    }

    /// A support's minion on a player main (Summon Phantasm on Flicker Strike) adds nothing: upstream's CombinedDPS leaves
    /// it out, and the score follows the player's skill.
    #[test]
    fn support_minion_not_counted() {
        let x = build(&["Flicker Strike", "Summon Phantasm"], &[]);
        let mut s = Session::new(x.clone(), pom_calc::data::game_data());
        let (c, has_minion) = s.eval_xml(&x, false, |env| (clear_env(env).expect("main skill"), env.minion_info.is_some())).unwrap();
        assert!(has_minion, "the phantasm is the engine's minion here");
        assert!(c.minion.is_none(), "{c:?}");
    }

    /// Text rules read lines only on threads that turned them on (solver evaluations): a build opened anywhere else
    /// parses exactly like upstream, even after a solve loaded the rules.
    #[test]
    fn rules_only_on_solver_threads() {
        let st = "Strike Skills target 2 additional nearby Enemies";
        load_text_rules();
        assert!(!matches!(pom_engine::modparser::parse_mod(st), (Some(_), None)), "rules leaked into a plain parse");
        let (user, _) = eval(&build(&["Flicker Strike"], &[st]));
        assert!((user.targets_hit - 1.0).abs() < 1e-9, "{user:?}");
        let solver = std::thread::Builder::new()
            .stack_size(64 << 20)
            .spawn(move || {
                pom_engine::modparser::text_rules::set_active(true);
                eval(&build(&["Flicker Strike"], &[st])).0
            })
            .unwrap()
            .join()
            .unwrap();
        assert!((solver.targets_hit - 3.0).abs() < 1e-9, "{solver:?}");
    }

    /// The scan: partial parses and unread keyword lines are reported, not counted; a new patch's sources of known
    /// classes (an invented support with the strike-target stat id, an invented ring with an explode line) are found
    /// with no code change, and new unknown ones classify after one data row each.
    #[test]
    fn scan_new_patch_fixture() {
        use super::super::mechscan::{scan, Gem, Line};
        let line = |kind, source: &str, text: &str| Line { kind, source: source.into(), text: text.into() };
        let lines = vec![
            line("unique", "Test Burst Ring", "Enemies you kill explode, dealing (4-5)% of their life as fire damage"),
            line("unique", "Test Cull Ring", "Gain 150 Life on Culling Strike"),
            line("unique", "Test Splash Axe", "Melee Strike Skills deal Splash Damage to surrounding targets"),
            line("unique", "Test Ignite Ring", "Ignites you inflict spread to other Enemies within 1.2 metres"),
            line("node", "Test Notable", "Strike Skills target 2 additional nearby Enemies"),
            line("unique", "Test Cone Axe", "Strike Skills deal Splash Damage to enemies in a cone"),
        ];
        let gems = vec![
            super::super::mechscan::Gem { id: "TestEchoSupport".into(), stats: vec![("melee_attack_number_of_spirit_strikes".into(), 3.0)], ..Default::default() },
            Gem { id: "TestConeSupport".into(), stats: vec![("melee_splash_test".into(), 1.0)], ..Default::default() },
        ];
        let (map, mods) = (Default::default(), Default::default());
        let s = scan(&lines, &gems, &map, &mods, registry(), Some(&rules()));
        let sources = |s: &super::super::mechscan::Scan, c: &str| s.classes.get(c).map(|v| v.iter().map(|h| h["source"].as_str().unwrap().to_string()).collect::<Vec<_>>()).unwrap_or_default();
        let st = sources(&s, "strike-targets");
        assert!(st.contains(&"TestEchoSupport".to_string()) && st.contains(&"Test Notable".to_string()), "{:?}", s.classes);
        assert!(sources(&s, "explode-on-kill").iter().all(|x| x == "Test Burst Ring") && !sources(&s, "explode-on-kill").is_empty(), "{:?}", s.classes);
        let keys: Vec<&str> = s.unclassified.iter().map(|u| u.0.as_str()).collect();
        for k in ["line: gain # life on culling strike", "line: melee strike skills deal splash damage to surrounding targets", "line: ignites you inflict spread to other enemies within # metres", "line: strike skills deal splash damage to enemies in a cone", "stat: melee_splash_test"] {
            assert!(keys.contains(&k), "{k} not reported: {keys:?}");
        }
        // (the explode line's value: max roll 5%)
        assert_eq!(s.classes["explode-on-kill"][0]["value"]["amount"], 5.0);
        // ClearDPS rises with the fixture ring's explode mod.
        let base = ClearIn { out: [("CombinedDPS".to_string(), 1000.0), ("StrikeTargets".to_string(), 4.0)].into_iter().collect(), ..Default::default() };
        let with = ClearIn { explode: vec![(1.0, 5.0)], ..base.clone() };
        assert!(clear_score(&with) > clear_score(&base) && clear(&base, registry()).targets_hit == 4.0);
        // One data row each (a registry stat id, a text rule) and both classify.
        let reg_txt = include_str!("../../../engine-data/mechanic_classes.json").replace("\"statIds\": [\"melee_splash\"]", "\"statIds\": [\"melee_splash\", \"melee_splash_test\"], \"modNames\": [\"MeleeSplashTest\"]");
        let reg2 = Registry::from_json(&reg_txt).unwrap();
        let rules_txt = include_str!("../../../engine-data/mechanic_text_rules.json").replace("\"rules\": [", "\"rules\": [ { \"id\": \"splash-text\", \"class\": \"melee-splash\", \"match\": \"^(?:melee )?strike skills deal splash damage to (?:surrounding targets|enemies in a cone)$\", \"mods\": [ { \"name\": \"MeleeSplashTest\", \"type\": \"FLAG\", \"value\": true } ] },");
        let s2 = scan(&lines, &gems, &map, &mods, &reg2, Some(&Rules::from_json(&rules_txt).unwrap()));
        let keys2: Vec<&str> = s2.unclassified.iter().map(|u| u.0.as_str()).collect();
        assert!(!keys2.iter().any(|k| k.contains("splash")), "{keys2:?}");
        assert_eq!(s2.classes["melee-splash"].len(), 3, "{:?}", s2.classes["melee-splash"]);
    }
}
