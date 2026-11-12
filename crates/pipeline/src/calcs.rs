//! The Calcs tab's sections from the live engine's finished calc.
//!
//! `pom_breakdown` renders `CalcSections.lua`'s rows, cells and visibility gates from a `BreakdownBuild`: the mod
//! stores, cfgs, skill flags and output of the main actor (recorded from the
//! original). Here the same inputs are built from a finished `Env`: the player/enemy/skill mod stores (converted onto
//! the breakdown crate's own mirror of the mod types), the main skill's cfgs, `skillFlags` and `output`.
//!
//! Computed only when asked (`Session::calcs`), by re-running the build with `offence::CAPTURE_ARMED` set so the offence
//! pass keeps the finished state of the main skill; never on the click path.
use crate::offence::Captured;
use crate::Env;
use pom_breakdown as bd;
use pom_breakdown::modmatch::store::ModStore as BStore;
use pom_breakdown::modmatch::types as bt;
use pom_engine::modstore::store::{Backing, ModStore as EStore};
use pom_engine::modstore::types as et;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const MODFLAG_ATTACK: u64 = 0x1;
const MODFLAG_SPELL: u64 = 0x2;
const MODFLAG_HIT: u64 = 0x4;
const MODFLAG_DOT: u64 = 0x8;
const MODFLAG_MELEE: u64 = 0x100;
const MODFLAG_AREA: u64 = 0x200;
const MODFLAG_PROJECTILE: u64 = 0x400;
const MODFLAG_AILMENT: u64 = 0x800;
const MODFLAG_MELEE_HIT: u64 = 0x1000;
const MODFLAG_WEAPON_MASK: u64 = 0x2FFF0000;
const MODFLAG_WEAPON_1H: u64 = 0x10000000;
const KW_HIT: u64 = 0x40000;
const KW_AILMENT: u64 = 0x80000;
const KW_POISON: u64 = 0x200000;
const KW_BLEED: u64 = 0x400000;
const KW_IGNITE: u64 = 0x800000;
const KW_PHYSICAL_DOT: u64 = 0x1000000;
const KW_LIGHTNING_DOT: u64 = 0x2000000;
const KW_COLD_DOT: u64 = 0x4000000;
const KW_FIRE_DOT: u64 = 0x8000000;
const KW_CHAOS_DOT: u64 = 0x10000000;

// ===== engine -> breakdown mirror conversion =====

fn bsym(s: pom_engine::sym::Sym) -> bd::sym::Sym {
    bd::sym::Sym::new(s.as_str())
}

pub(crate) fn conv_value(v: &pom_engine::value::Value) -> bd::value::Value {
    use pom_engine::value::Value as E;
    use bd::value::Value as B;
    match v {
        E::Nil => B::Nil,
        E::Bool(b) => B::Bool(*b),
        E::Num(n) => B::Num(*n),
        E::Str(s) => B::Str(s.clone()),
        E::List(l) => B::List(Arc::new(l.iter().map(conv_value).collect())),
        E::Map(m) => B::Map(Arc::new(m.iter().map(|(k, v)| (bsym(*k), conv_value(v))).collect())),
    }
}

pub(crate) fn conv_mod(m: &pom_engine::modifier::Mod) -> bd::modifier::Mod {
    bd::modifier::Mod {
        name: bsym(m.name),
        ty: bd::modifier::ModType::parse(m.ty.as_str()).unwrap_or(bd::modifier::ModType::Base),
        value: conv_value(&m.value),
        flags: m.flags,
        keyword_flags: m.keyword_flags,
        source: m.source.clone(),
        tags: m.tags.iter().map(|t| bd::modifier::Tag { kind: bsym(t.kind), fields: t.fields.iter().map(|(k, v)| (bsym(*k), conv_value(v))).collect() }).collect(),
    }
}

fn conv_scalar(v: &et::ScalarValue) -> bt::ScalarValue {
    match v {
        et::ScalarValue::Num(n) => bt::ScalarValue::Num(*n),
        et::ScalarValue::Str(s) => bt::ScalarValue::Str(s.clone()),
        et::ScalarValue::Bool(b) => bt::ScalarValue::Bool(*b),
    }
}

fn conv_item(i: &et::ItemInfo) -> bt::ItemInfo {
    bt::ItemInfo { name: i.name.clone(), rarity: i.rarity.clone(), corrupted: i.corrupted, shaper: i.shaper, elder: i.elder, item_type: i.item_type.clone() }
}

pub(crate) fn conv_cfg(c: &et::Cfg) -> bt::Cfg {
    bt::Cfg {
        flags: c.flags,
        keyword_flags: c.keyword_flags,
        source: c.source.clone(),
        skill_name: c.skill_name.clone(),
        summon_skill_name: c.summon_skill_name.clone(),
        skill_types: c.skill_types.iter().map(|(k, v)| (*k, *v)).collect(),
        skill_cond: c.skill_cond.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        slot_name: c.slot_name.clone(),
        skill_gem: c.skill_gem.as_ref().map(|g| bt::GemInfo { name: g.name.clone(), tags: g.tags.iter().map(|(k, v)| (k.clone(), *v)).collect() }),
        skill_part: c.skill_part,
        skill_dist: c.skill_dist,
        skill_granted_effect_id: c.skill_granted_effect_id.clone(),
        skill_granted_effect_base_flags: c.skill_granted_effect_base_flags.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        base_flags: c.base_flags.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        socket_color: c.socket_color.clone(),
        socket_num: c.socket_num,
        intelligence_gems: c.intelligence_gems,
        dexterity_gems: c.dexterity_gems,
        strength_gems: c.strength_gems,
        item: c.item.as_ref().map(conv_item),
        actor_tag: c.actor_tag.clone(),
        skill_stats: c.skill_stats.iter().map(|(k, v)| (bsym(*k), *v)).collect(),
    }
}

/// Converts engine stores and actors (reference cycles and all) onto the breakdown crate's mirror types, one copy per
/// store/actor however many links reach it.
struct Conv {
    actors: HashMap<usize, Arc<bt::Actor>>,
    stores: HashMap<usize, Arc<BStore>>,
    pending: Vec<(Arc<et::Actor>, Arc<bt::Actor>)>,
}

impl Conv {
    fn new() -> Conv {
        Conv { actors: HashMap::new(), stores: HashMap::new(), pending: Vec::new() }
    }

    fn actor_body(a: &et::Actor, output: Option<&pom_engine::fxhash::HashMap<String, f64>>) -> bt::Actor {
        let out: HashMap<bd::sym::Sym, f64> = match output {
            Some(o) => o.iter().map(|(k, v)| (bd::sym::Sym::new(k), *v)).collect(),
            None => a.output.iter().map(|(k, v)| (bsym(*k), *v)).collect(),
        };
        bt::Actor {
            output: out,
            mana_efficiency: a.mana_efficiency,
            weapon1: a.weapon1.iter().map(|(k, v)| (k.clone(), conv_scalar(v))).collect(),
            weapon2: a.weapon2.iter().map(|(k, v)| (k.clone(), conv_scalar(v))).collect(),
            minion_monster_tags: a.minion_monster_tags.clone(),
            reservations: a.reservations.iter().map(|r| bt::Reservation { buff_names: r.buff_names.clone(), mana_reserved_base: r.mana_reserved_base, life_reserved_base: r.life_reserved_base }).collect(),
            items: a.items.iter().map(|(k, v)| (k.clone(), conv_item(v))).collect(),
            item_search: a.item_search.iter().map(|(k, m)| (k.clone(), m.iter().map(|(k2, v)| (k2.clone(), *v)).collect())).collect(),
            related: std::cell::RefCell::new(HashMap::new()),
        }
    }

    /// `output`: replaces the actor's own output table (the finished `env.output` for the main actor).
    fn actor(&mut self, a: &Arc<et::Actor>, output: Option<&pom_engine::fxhash::HashMap<String, f64>>) -> Arc<bt::Actor> {
        let key = Arc::as_ptr(a) as usize;
        if let Some(b) = self.actors.get(&key) {
            return b.clone();
        }
        let b = Arc::new(Self::actor_body(a, output));
        self.actors.insert(key, b.clone());
        self.pending.push((a.clone(), b.clone()));
        b
    }

    fn store_arc(&mut self, s: &Arc<EStore>) -> Arc<BStore> {
        let key = Arc::as_ptr(s) as usize;
        if let Some(b) = self.stores.get(&key) {
            return b.clone();
        }
        let b = Arc::new(self.store(s));
        self.stores.insert(key, b.clone());
        b
    }

    fn store(&mut self, s: &EStore) -> BStore {
        let parent = s.parent.as_ref().map(|p| self.store_arc(p));
        let actor = s.actor.as_ref().map(|a| self.actor(a, None));
        let mut b = match &s.backing {
            Backing::List(_) => BStore::new_list(parent, actor),
            Backing::Db(_) => BStore::new_db(parent, actor),
        };
        b.conditions = s.conditions.iter().map(|(k, v)| (bsym(*k), *v)).collect();
        b.multipliers = s.multipliers.iter().map(|(k, v)| (bsym(*k), *v)).collect();
        match &s.backing {
            Backing::List(v) => {
                for m in v.iter() {
                    b.add_mod(conv_mod(m));
                }
            }
            Backing::Db(map) => {
                for list in map.values() {
                    for m in list {
                        b.add_mod(conv_mod(m));
                    }
                }
            }
        }
        b
    }

    /// Wires every converted actor's cross-actor links (`related`), converting the stores they reach.
    fn finish(&mut self) {
        while let Some((ea, ba)) = self.pending.pop() {
            let links: Vec<(Arc<str>, Arc<EStore>)> = ea.related.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (role, st) in links {
                let b = self.store_arc(&st);
                ba.related.borrow_mut().insert(role, b);
            }
        }
    }
}

// ===== cfgs =====

fn lua_or(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    if a == Some(true) { a } else { b }
}

const SKILL_COND_KEYS: [&str; 6] = ["CriticalStrike", "SkillIsFocused", "SkillIsTriggered", "usedByMirage", "MainHandAttack", "OffHandAttack"];

/// A fresh ailment cfg (`bleedCfg`/`poisonCfg`/`igniteCfg`, CalcOffence.lua:4414, 4687, 4992) whose `skillCond` is
/// `{CriticalStrike = true}` falling back to `skillCfg.skillCond[key] or cfg.skillCond[key]`.
fn ailment_cfg(skill: &et::Cfg, pass: &et::Cfg, extra_kw: u64) -> et::Cfg {
    let mut cond: pom_engine::fxhash::HashMap<Arc<str>, bool> = Default::default();
    cond.insert(Arc::from("CriticalStrike"), true);
    for k in SKILL_COND_KEYS {
        if k == "CriticalStrike" {
            continue;
        }
        if let Some(v) = lua_or(skill.skill_cond.get(k).copied(), pass.skill_cond.get(k).copied()) {
            cond.insert(Arc::from(k), v);
        }
    }
    et::Cfg {
        flags: MODFLAG_DOT | MODFLAG_AILMENT | (pass.flags & MODFLAG_WEAPON_MASK) | (if pass.flags & MODFLAG_MELEE != 0 { MODFLAG_MELEE_HIT } else { 0 }) | (pass.flags & MODFLAG_WEAPON_1H),
        keyword_flags: (pass.keyword_flags & !KW_HIT) | KW_AILMENT | extra_kw,
        skill_name: skill.skill_name.clone(),
        skill_part: skill.skill_part,
        skill_types: skill.skill_types.clone(),
        summon_skill_name: skill.summon_skill_name.clone(),
        slot_name: skill.slot_name.clone(),
        skill_cond: cond,
        skill_dist: skill.skill_dist,
        ..Default::default()
    }
}

fn plain_cfg(skill: &et::Cfg, flags: u64, keyword_flags: u64) -> et::Cfg {
    et::Cfg { flags, keyword_flags, skill_name: skill.skill_name.clone(), skill_part: skill.skill_part, skill_types: skill.skill_types.clone(), summon_skill_name: skill.summon_skill_name.clone(), slot_name: skill.slot_name.clone(), ..Default::default() }
}

fn sd_truthy(m: &pom_engine::fxhash::HashMap<String, et::ScalarValue>, k: &str) -> bool {
    m.get(k).is_some_and(|v| v.truthy())
}

/// The named cfg tables CalcActiveSkill/CalcOffence leave on the main skill (`activeSkill.<name>Cfg`).
fn skill_cfgs(env: &Env, cap: &Captured, flags: &HashSet<String>) -> HashMap<String, bt::Cfg> {
    let outm = display_output(env, cap);
    let mut out: HashMap<String, bt::Cfg> = HashMap::new();
    let skill = &cap.skill_cfg;
    let out_stats = |prefix: &str| -> pom_engine::fxhash::HashMap<pom_engine::sym::Sym, f64> {
        outm.iter().filter_map(|(k, v)| k.strip_prefix(prefix).filter(|r| !r.contains('.')).map(|r| (pom_engine::sym::Sym::new(r), *v))).collect()
    };
    let mut s_cfg = skill.clone();
    s_cfg.skill_stats = Default::default();
    // The ailment pass leaves `cfg.skillCond.CriticalStrike` false (CalcOffence.lua:4217), or true when the non-damaging
    // ailment loop ran in "Crits Only" ailment mode (5424-5428).
    let ailment_crit = env.config_str.get("ailmentMode").is_some_and(|m| m == "CRIT") && !env.player.flag(None, &[pom_engine::sym::Sym::new("AilmentsAreNeverFromCrit")]);
    let final_crit = |pfx: &str| ailment_crit && ["Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"].iter().any(|a| outm.get(&format!("{pfx}{a}ChanceOnHit")).copied().unwrap_or(0.0) + outm.get(&format!("{pfx}{a}ChanceOnCrit")).copied().unwrap_or(0.0) > 0.0);
    if cap.pass_cfgs.iter().any(|(l, _)| *l == "Skill") && !flags.contains("disable") {
        s_cfg.skill_cond.insert(Arc::from("CriticalStrike"), final_crit(""));
    }
    out.insert("skillCfg".into(), conv_cfg(&s_cfg));
    if flags.contains("disable") {
        return out;
    }
    for (label, name, prefix) in [("MainHand", "weapon1Cfg", "MainHand."), ("OffHand", "weapon2Cfg", "OffHand.")] {
        if let Some((_, c)) = cap.pass_cfgs.iter().find(|(l, _)| *l == label) {
            let mut c = c.clone();
            c.skill_stats = out_stats(prefix);
            c.skill_cond.insert(Arc::from("CriticalStrike"), final_crit(prefix));
            out.insert(name.into(), conv_cfg(&c));
        }
    }
    let sml = &cap.skill_mod_list;
    let can_deal = |c: &et::Cfg, t: &str| pom_offence::ailments::can_deal(sml, Some(c), t);
    let get = |pfx: &str, k: &str| outm.get(&format!("{pfx}{k}")).copied().unwrap_or(0.0);
    for (label, pfx, oh) in [("MainHand", "MainHand.", false), ("OffHand", "OffHand.", true), ("Skill", "", false)] {
        let Some((_, pc)) = cap.pass_cfgs.iter().find(|(l, _)| *l == label) else { continue };
        let pre = if oh { "OH" } else { "" };
        if can_deal(pc, "Physical") && get(pfx, "BleedChanceOnHit") + get(pfx, "BleedChanceOnCrit") > 0.0 {
            out.insert(format!("{pre}bleedCfg"), conv_cfg(&ailment_cfg(skill, pc, KW_BLEED | KW_PHYSICAL_DOT)));
        }
        if can_deal(pc, "Chaos") && get(pfx, "PoisonChanceOnHit") + get(pfx, "PoisonChanceOnCrit") + get(pfx, "ChaosPoisonChance") > 0.0 {
            out.insert(format!("{pre}poisonCfg"), conv_cfg(&ailment_cfg(skill, pc, KW_POISON | KW_CHAOS_DOT)));
        }
        if can_deal(pc, "Fire") && get(pfx, "IgniteChanceOnHit") + get(pfx, "IgniteChanceOnCrit") > 0.0 {
            out.insert(format!("{pre}igniteCfg"), conv_cfg(&ailment_cfg(skill, pc, KW_IGNITE | KW_FIRE_DOT)));
        }
    }
    if flags.contains("hit") && cap.skill_data.contains_key("decay") && can_deal(skill, "Chaos") {
        out.insert("decayCfg".into(), conv_cfg(&plain_cfg(skill, MODFLAG_DOT, (skill.keyword_flags & !KW_HIT) | KW_CHAOS_DOT)));
    }
    // CalcOffence.lua:5772-5812: the generic DoT cfg and its per-damage-type copies.
    let mut dot_flags = MODFLAG_DOT | skill.flags;
    for (bit, key) in [(MODFLAG_AREA, "dotIsArea"), (MODFLAG_PROJECTILE, "dotIsProjectile"), (MODFLAG_SPELL, "dotIsSpell"), (MODFLAG_ATTACK, "dotIsAttack"), (MODFLAG_HIT, "dotIsHit")] {
        if dot_flags & bit != 0 && !sd_truthy(&cap.skill_data, key) {
            dot_flags &= !bit;
        }
    }
    let dot_kw = skill.keyword_flags & !KW_HIT;
    out.insert("dotCfg".into(), conv_cfg(&plain_cfg(skill, dot_flags, dot_kw)));
    for (ty, kw) in [("Physical", KW_PHYSICAL_DOT), ("Lightning", KW_LIGHTNING_DOT), ("Cold", KW_COLD_DOT), ("Fire", KW_FIRE_DOT), ("Chaos", KW_CHAOS_DOT)] {
        out.insert(format!("dot{ty}Cfg"), conv_cfg(&plain_cfg(skill, dot_flags, dot_kw | kw)));
    }
    out
}

// ===== skill flags =====

/// The output of the actor the Calcs tab shows: the player's, or the minion's finished one.
fn display_output<'a>(env: &'a Env, cap: &'a Captured) -> &'a pom_engine::fxhash::HashMap<String, f64> {
    if cap.minion {
        if let Some(i) = &env.minion_info {
            return &i.2;
        }
        return &cap.output;
    }
    &env.output
}

/// `activeSkill.skillFlags` as the Calcs tab reads it: the flags the skill was built with plus the ones CalcOffence and
/// CalcTriggers set while calculating it.
pub(crate) fn skill_flags(env: &Env, cap: &Captured) -> HashSet<String> {
    let outm = display_output(env, cap);
    let mut f: HashSet<String> = cap.main.skill_flags.iter().cloned().collect();
    let out = |k: &str| outm.get(k).copied();
    let has = |k: &str| outm.contains_key(k);
    let pos = |k: &str| out(k).is_some_and(|v| v > 0.0);
    let ins = |f: &mut HashSet<String>, k: &str| {
        f.insert(k.to_string());
    };
    let sml = &cap.skill_mod_list;
    let cfg = &cap.skill_cfg;
    match cap.show_average {
        Some(true) => ins(&mut f, "showAverage"),
        _ => ins(&mut f, "notAverage"),
    }
    if f.contains("disable") {
        // CalcOffence.lua:362-366 ran, then the disabled skill returned.
        return f;
    }
    if has("AreaOfEffectRadius") {
        ins(&mut f, "area");
    }
    // `skillData.triggered` (CalcOffence.lua:518-521): written by `calcs.triggers` for the trigger it found, by CalcPerform.lua:1473
    // for skills triggered on death, and by the mirage copy; an item-granted skill's own `triggered` is the gem's, not this one.
    let trigger_found = !cap.minion && env.trigger_apply.as_ref().is_some_and(|t| t.result.triggered == Some(true));
    let on_death = cap.skill_data.get("triggeredOnDeath").is_some_and(|v| v.truthy()) && !f.contains("minion");
    let mirage = cfg.skill_cond.get("usedByMirage").copied().unwrap_or(false);
    if trigger_found || on_death || mirage {
        ins(&mut f, "triggered");
    }
    if cfg.skill_cond.get("SkillIsFocused").copied().unwrap_or(false) {
        ins(&mut f, "focused");
    }
    if pos("LifeLeechRate") {
        ins(&mut f, "leechLife");
    }
    if pos("EnergyShieldLeechRate") {
        ins(&mut f, "leechES");
    }
    if pos("ManaLeechRate") {
        ins(&mut f, "leechMana");
    }
    let flag = |c: Option<&et::Cfg>, n: &str| sml.flag(c, &[pom_engine::sym::Sym::new(n)]);
    if flag(Some(cfg), "IgniteCanStack") {
        ins(&mut f, "igniteCanStack");
    }
    if flag(Some(cfg), "IgniteToChaos") {
        ins(&mut f, "igniteToChaos");
    }
    if flag(None, "TriggeredBySnipe") {
        ins(&mut f, "channelRelease");
    }
    // Ailments: each flag is set in the block that writes the ailment's own output, in the pass (hand) that inflicts it.
    let prefixes: &[&str] = &["", "MainHand.", "OffHand."];
    let any_pass = |f: &dyn Fn(&str) -> bool| prefixes.iter().any(|p| f(p));
    let get = |k: &str| out(k).unwrap_or(0.0);
    let chance_pass = |p: &str, a: &str| get(&format!("{p}{a}ChanceOnHit")) + get(&format!("{p}{a}ChanceOnCrit")) > 0.0;
    if any_pass(&|p| has(&format!("{p}BleedDPS")) && chance_pass(p, "Bleed")) {
        ins(&mut f, "bleed");
        ins(&mut f, "duration");
    }
    if any_pass(&|p| has(&format!("{p}PoisonDPS")) && (chance_pass(p, "Poison") || get(&format!("{p}ChaosPoisonChance")) > 0.0)) {
        ins(&mut f, "poison");
        ins(&mut f, "duration");
    }
    if any_pass(&|p| has(&format!("{p}IgniteDPS")) && chance_pass(p, "Ignite")) {
        ins(&mut f, "ignite");
    }
    if pom_offence::ailments::can_deal(sml, Some(cfg), "Physical") && any_pass(&|p| get(&format!("{p}ImpaleChance")) + get(&format!("{p}ImpaleChanceOnCrit")) > 0.0) {
        ins(&mut f, "impale");
    }
    for a in ["Shock", "Scorch", "Brittle", "Sap", "Chill"] {
        if any_pass(&|p| has(&format!("{p}{a}Duration")) && chance_pass(p, a)) {
            ins(&mut f, &a.to_lowercase());
        }
    }
    if cap.main.skill_types.contains(&68) || cap.main.skill_types.contains(&67) {
        ins(&mut f, "chill");
    }
    if any_pass(&|p| has(&format!("{p}FreezeDurationMod")) && chance_pass(p, "Freeze")) {
        ins(&mut f, "freeze");
    }
    for a in ["Ignite", "Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"] {
        if any_pass(&|p| chance_pass(p, a)) {
            ins(&mut f, &format!("inflict{a}"));
        }
    }
    let base_sum = |n: &str| sml.sum(pom_engine::modifier::ModType::Base, Some(cfg), &[pom_engine::sym::Sym::new(n)]);
    if base_sum("FireExposureChance") > 0.0 {
        ins(&mut f, "applyFireExposure");
    }
    if base_sum("ColdExposureChance") > 0.0 {
        ins(&mut f, "applyColdExposure");
    }
    if base_sum("LightningExposureChance") > 0.0 {
        ins(&mut f, "applyLightningExposure");
    }
    if ["Physical", "Lightning", "Cold", "Fire", "Chaos"].iter().any(|t| pos(&format!("{t}Dot"))) {
        ins(&mut f, "dot");
    }
    if has("DecayDPS") {
        ins(&mut f, "decay");
    }
    // CalcActiveSkill.lua:247-266: a multipart skill's chosen part sets and clears flags; CalcActiveSkill.lua:645-648.
    let ge = pom_skills::data::all_skills().get(&cap.main.granted_effect_id);
    if let Some(parts) = ge.and_then(pom_skills::data::parts) {
        if parts.len() > 1 {
            ins(&mut f, "multiPart");
            let idx = (cfg.skill_part.unwrap_or(1.0).max(1.0) as usize).min(parts.len());
            if let Some(obj) = parts.get(idx - 1).and_then(|p| p.as_object()) {
                for (k, v) in obj {
                    match v.as_bool() {
                        Some(true) => ins(&mut f, k),
                        Some(false) => {
                            f.remove(k);
                        }
                        None => {}
                    }
                }
            }
        }
    }
    let ge_name: String = ge.and_then(|g| g.name.clone()).unwrap_or_else(|| cap.main.name.clone()).split_whitespace().collect();
    let scorching_part2 = matches!(ge_name.as_str(), "ScorchingRay" | "ScorchingRayofImmolation") && cfg.skill_part == Some(2.0);
    if !scorching_part2 && sml.sum(pom_engine::modifier::ModType::Base, Some(cfg), &[pom_engine::sym::Sym::new(&format!("Multiplier:{ge_name}MaxStages"))]) > 0.0 {
        ins(&mut f, "multiStage");
    }
    // CalcOffence.lua:981-983
    {
        let names = [pom_engine::sym::Sym::new("PhysicalDamageGainAsRandom"), pom_engine::sym::Sym::new("PhysicalDamageConvertToRandom"), pom_engine::sym::Sym::new("PhysicalDamageGainAsColdOrLightning")];
        let sum = |c: &et::Cfg| sml.sum(pom_engine::modifier::ModType::Base, Some(c), &names);
        let weapon = |l: &str| cap.pass_cfgs.iter().find(|(n, _)| *n == l).map(|(_, c)| c);
        if sum(cfg) > 0.0 || weapon("MainHand").is_some_and(|c| sum(c) > 0.0) || weapon("OffHand").is_some_and(|c| sum(c) > 0.0) {
            ins(&mut f, "randomPhys");
        }
    }
    // CalcOffence.lua:1081-1151: projectile skills fork and pierce.
    if f.contains("projectile") {
        if !flag(Some(cfg), "CannotFork") && flag(Some(cfg), "ForkOnce") {
            ins(&mut f, "forking");
        }
        if !flag(Some(cfg), "CannotPierce") {
            let all = flag(Some(cfg), "PierceAllTargets") || env.enemy.flag(None, &[pom_engine::sym::Sym::new("AlwaysPierceSelf")]);
            if all || base_sum("PierceCount") > 0.0 {
                ins(&mut f, "piercing");
            }
        }
    }
    // CalcOffence.lua:5861-5910
    if flag(None, "DotCanStack") || (!flag(None, "dotIsBurningGround") && !flag(None, "dotIsCausticGround") && !flag(None, "dotIsCorruptingBlood") && flag(None, "DotCanStackAsTotems") && f.contains("totem")) {
        ins(&mut f, "DotCanStack");
    }
    // CalcMirages.lua:101, 327
    if !f.contains("disable") && !cfg.skill_cond.get("usedByMirage").copied().unwrap_or(false) {
        if cap.skill_data.get("triggeredByMirageArcher").is_some_and(|v| v.truthy()) {
            ins(&mut f, "mirageArcher");
        } else if cap.skill_data.get("triggeredBySacredWisps").is_some_and(|v| v.truthy()) {
            ins(&mut f, "wisp");
        }
    }
    // CalcTriggers.lua: what `calcs.triggers` wrote onto the main skill.
    if !cap.minion {
        if let Some(t) = &env.trigger_apply {
            if t.result.global_trigger == Some(true) {
                ins(&mut f, "globalTrigger");
            }
            if t.result.disable_reason.is_some() {
                ins(&mut f, "disable");
            }
            if t.result.has_override == Some(true) {
                ins(&mut f, "hasOverride");
            }
            if t.result.skip_effective_rate == Some(true) {
                ins(&mut f, "skipEffectiveRate");
            }
            if t.result.adds_cast_time.is_some() || t.result.main_adds_cast_time_flag {
                ins(&mut f, "addsCastTime");
            }
        }
    }
    // CalcOffence.lua:3860-3873
    if env.config_input.get("PvpScaling").is_some_and(|v| *v != 0.0) || env.config_flags.get("PvpScaling").copied().unwrap_or(false) {
        ins(&mut f, "isPvP");
        if f.contains("attack") {
            ins(&mut f, "attackPvP");
        } else {
            ins(&mut f, "notAttackPvP");
        }
        if f.contains("weapon1Attack") {
            ins(&mut f, "weapon1AttackPvP");
        }
        if f.contains("weapon2Attack") {
            ins(&mut f, "weapon2AttackPvP");
        }
        if f.contains("notAverage") {
            ins(&mut f, "notAveragePvP");
        }
    }
    f
}

// ===== the build =====

pub(crate) fn sections() -> &'static Vec<bd::sections::Section> {
    static S: std::sync::OnceLock<Vec<bd::sections::Section>> = std::sync::OnceLock::new();
    S.get_or_init(bd::sections::load)
}

/// `CalcsTab:Load`: `<Input name="showMinion" boolean=...>` and each `<Section id subsection collapsed>`.
pub(crate) fn calcs_tab_state(xml: &str, secs: &[bd::sections::Section]) -> (bool, HashMap<(String, usize), bool>) {
    let mut show_minion = false;
    let mut collapsed: HashMap<(String, usize), bool> = HashMap::new();
    for s in secs {
        for (i, sub) in s.sub_sections.iter().enumerate() {
            collapsed.insert((s.id.clone(), i), sub.default_collapsed);
        }
    }
    let Ok(doc) = roxmltree::Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }) else { return (show_minion, collapsed) };
    let Some(calcs) = doc.root_element().children().find(|n| n.is_element() && n.tag_name().name() == "Calcs") else { return (show_minion, collapsed) };
    for node in calcs.children().filter(|n| n.is_element()) {
        match node.tag_name().name() {
            "Input" if node.attribute("name") == Some("showMinion") => {
                if let Some(b) = node.attribute("boolean") {
                    show_minion = b == "true";
                }
            }
            "Section" => {
                let (Some(id), Some(sub)) = (node.attribute("id"), node.attribute("subsection")) else { continue };
                if let Some(s) = secs.iter().find(|s| s.id == id) {
                    if let Some(i) = s.sub_sections.iter().position(|ss| ss.label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect::<String>() == sub) {
                        collapsed.insert((s.id.clone(), i), node.attribute("collapsed") == Some("true"));
                    }
                }
            }
            _ => {}
        }
    }
    (show_minion, collapsed)
}

#[derive(Clone)]
pub struct CalcsOut {
    /// `bd::render::render_build`'s sections JSON.
    pub sections: serde_json::Value,
    /// `{name, flags: [...], skillTypes: [...]}` of the displayed actor's main skill.
    pub main_skill: serde_json::Value,
    /// The displayed actor's finished output (`dump`'s `player` object), for checking it against upstream's.
    pub output: Arc<serde_json::Value>,
    /// The inputs the rows were rendered from, kept so the sections can be rendered again (other collapse states, the
    /// popup details) and the popups' modifier tables can be tabulated without calculating again.
    pub build: Arc<bd::record::BreakdownBuild>,
    /// The Calcs tab's skill controls (see `calcs_popup::view_info`).
    pub view: serde_json::Value,
    /// The modifiers behind the buff and debuff lists, for their popups.
    pub list_rows: Arc<crate::calcs_popup::ListRows>,
}

fn build_for(env: &Env, cap: &Captured, minion_display: bool) -> bd::record::BreakdownBuild {
    let mut conv = Conv::new();
    let flags = skill_flags(env, cap);
    let cfgs = skill_cfgs(env, cap, &flags);
    // The finished output of the displayed actor: `dump` shape (strings, bools and `MainHand`/`OffHand` tables included).
    let (out_fx, player_output): (pom_engine::fxhash::HashMap<String, f64>, serde_json::Value) = if minion_display {
        // The minion's finished output as the export wrote it (`Minion` in the dump), without its debugging `_type`.
        let mut o = env.output_extra.get("Minion").cloned().unwrap_or(serde_json::Value::Null);
        if let Some(m) = o.as_object_mut() {
            m.remove("_type");
        }
        let nums = env.minion_info.as_ref().map(|i| i.2.iter().map(|(k, v)| (k.clone(), *v)).collect()).unwrap_or_else(|| cap.output.iter().map(|(k, v)| (k.clone(), *v)).collect());
        (nums, o)
    } else {
        (env.output.iter().map(|(k, v)| (k.clone(), *v)).collect(), crate::dump(env).get("player").cloned().unwrap_or(serde_json::Value::Null))
    };
    let player_store: Arc<BStore> = {
        let src: &EStore = if minion_display { &cap.player } else { &env.player };
        let actor = src.actor.clone();
        if let Some(a) = &actor {
            let b = conv.actor(a, Some(&out_fx));
            // The skill's list chain was built over earlier snapshots of the player: they read the finished actor too.
            let mut s: Option<&EStore> = Some(&cap.skill_mod_list);
            while let Some(st) = s {
                if let Some(a2) = &st.actor {
                    conv.actors.insert(Arc::as_ptr(a2) as usize, b.clone());
                }
                s = st.parent.as_deref();
            }
        }
        Arc::new(conv.store(src))
    };
    let skill_store = Arc::new(conv.store(&cap.skill_mod_list));
    let enemy_store = Arc::new(conv.store(&env.enemy));
    conv.finish();
    let secs = sections();
    let (_, collapsed) = calcs_tab_state(&env.xml_text, secs);
    let skill_flags: HashMap<String, bool> = flags.iter().map(|k| (k.clone(), true)).collect();
    bd::record::BreakdownBuild {
        name: String::new(),
        player_store,
        skill_mod_list_store: Some(skill_store),
        enemy_store: Some(enemy_store),
        cfgs,
        skill_flags,
        sections: serde_json::Value::Null,
        player_output,
        collapsed,
    }
}

/// The rendered Calcs sections and the main skill's flags for a finished env whose offence ran with capture armed.
pub(crate) fn calcs_of(env: &Env, caps: &[Captured]) -> Option<CalcsOut> {
    let secs = sections();
    let (show_minion, _) = calcs_tab_state(&env.xml_text, secs);
    let minion = caps.iter().find(|c| c.minion);
    let cap = if show_minion { minion.or_else(|| caps.iter().find(|c| !c.minion)) } else { caps.iter().find(|c| !c.minion) }?;
    let build = build_for(env, cap, cap.minion);
    let rendered = bd::render::render_build(&build, secs);
    let view = crate::calcs_popup::view_info(env, caps, show_minion, &crate::calcs_popup::calcs_input_string(&env.xml_text, "misc_buffMode").unwrap_or_else(|| "EFFECTIVE".to_string()));
    Some(CalcsOut { sections: rendered, main_skill: main_skill_json(env, cap, build.skill_flags.keys()), output: Arc::new(build.player_output.clone()), build: Arc::new(build.clone()), view, list_rows: Arc::new(crate::calcs_popup::take_list_rows()) })
}

fn main_skill_json<'a>(env: &Env, cap: &Captured, flags: impl Iterator<Item = &'a String>) -> serde_json::Value {
    let mut flags: Vec<&String> = flags.collect();
    flags.sort();
    let mut types: Vec<i64> = cap.main.skill_types.iter().copied().collect();
    types.sort_unstable();
    serde_json::json!({ "name": cap.main.name, "flags": flags, "skillTypes": types, "info": cap.info, "info2": cap.info2, "disableReason": cap.main.disable_reason.clone().or_else(|| env.trigger_apply.as_ref().filter(|_| !cap.minion).and_then(|t| t.result.disable_reason.clone())) })
}

/// `{name, flags, skillTypes}` of the player's main skill in the main calculation (what the sidebar's display stats read:
/// `mainEnv.player.mainSkill`), from a finished env whose offence ran with capture armed.
pub(crate) fn main_skill_of(env: &Env, caps: &[Captured]) -> Option<serde_json::Value> {
    let cap = caps.iter().find(|c| !c.minion)?;
    let flags = skill_flags(env, cap);
    let mut out = main_skill_json(env, cap, flags.iter());
    // `mainEnv.minion.mainSkill`: the sidebar's "Minion:" list reads its flags (`AddDisplayStatList(minionDisplayStats, minion)`).
    if let Some(m) = caps.iter().find(|c| c.minion) {
        let mflags = skill_flags(env, m);
        if let Some(o) = out.as_object_mut() {
            o.insert("minion".to_string(), main_skill_json(env, m, mflags.iter()));
        }
    }
    Some(out)
}
