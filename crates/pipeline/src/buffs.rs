//! Builds `pom_calc::perform::compute_buffs`' per-skill `SkillBuffs` input from each active skill's resolved
//! `skill_mod_list` (`pom_skills::assemble::ComputedSkill`).
//!
//! `activeSkill.buffList` is built by the tail of `calcs.buildActiveSkillModList` (`Modules/CalcActiveSkill.lua`:804-869,
//! the "Separate global effect modifiers" loop), once per skill when the skill is constructed; the buff loop of
//! `calcs.perform` (`compute_buffs`) only consumes it. `pom-skills` does not port that tail, so
//! `ComputedSkill.skill_mod_list` still carries every `GlobalEffect`-tagged mod, and this module extracts them with
//! the same `Mod`/`Tag` shape upstream loop scans (`tag.type == "GlobalEffect"`).
//!
//! In the stat-map data (`engine-data/data_skillStatMap.json` and `data_skillStatMapPerSkill.json`) no `GlobalEffect`
//! template carries `effectCond`/`effectEnemyCond`/`allowTotemBuff`/`applyNotPlayer`/`applyMinions`/`modCond`; only
//! `effectType`/`effectName` appear. `build_skill_buffs` still reads those fields when present, so a data update that
//! adds one needs no code change. The same goes for `activeSkill.skillData.buffNotPlayer`/`buffMinions`/`buffAllies`/
//! `allowTotemBuff` (the "inherit buff configuration from the active skill" branch, lines 843-846): no `SkillData`
//! LIST mod with one of those keys exists in the stat-map data.
//!
//! Each skill's own `ModStore` (the second element of `compute_buffs`' `(SkillBuffs, ModStore)` pairs) has `env.player`'s
//! mods as its parent (`ModStore::parent`, through a snapshot taken right before buffs run, `player_snapshot`), as
//! `ModList(activeSkill.actor.modDB)` does (`Modules/CalcActiveSkill.lua`:492). A `{BuffName}Effect`-named mod on an
//! item or tree source (summed through `skillModList:Sum(..., buff.name.."Effect")`) therefore resolves through the
//! parent chain, not only from this skill's own mods.
use pom_calc::perform::{SkillBuff, SkillBuffs};
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::{Backing, ModStore};
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

fn tag_str(v: &Value) -> Option<String> {
    if let Value::Str(s) = v {
        Some(s.to_string())
    } else {
        None
    }
}

/// `modLib.compareModParams` (Modules/ModTools.lua:121-134), reimplemented here because
/// `pom_calc::perform::mod_params_match` (the same check) is private to that crate.
fn mod_params_match(a: &Mod, b: &Mod) -> bool {
    a.name == b.name && a.ty == b.ty && a.flags == b.flags && a.keyword_flags == b.keyword_flags && a.tags == b.tags
}

/// `CalcActiveSkill.lua`:850-864's local dedup: a `BASE`/`INC` mod matching an existing entry by
/// `compareModParams` has its value ADDED to the existing one (not replaced, unlike `mergeBuff`'s
/// "keep the larger value" rule - a different, narrower merge used only at extraction time).
fn merge_into_buff_mod_list(dest: &mut Vec<Mod>, m: &Mod) {
    if matches!(m.ty, ModType::Base | ModType::Inc) {
        if let Some(existing) = dest.iter_mut().find(|d| mod_params_match(m, d)) {
            if let (pom_engine::value::Value::Num(a), pom_engine::value::Value::Num(b)) = (&existing.value, &m.value) {
                existing.value = pom_engine::value::Value::Num(a + b);
                return;
            }
        }
    }
    dest.push(m.clone());
}

/// A flat, standalone snapshot of `player`'s current mods/conditions/actor, wrapped for use as
/// every skill's own `ModStore::parent` - see this module's doc comment. `pub(crate)` since
/// `crate::offence` needs the identical parent-chaining for its own per-skill `ModStore`
/// (`ModList(activeSkill.actor.modDB)`'s parent applies to every skill-scoped query throughout
/// `calcs.perform`, not just the buff loop).
pub(crate) fn player_snapshot(player: &ModStore) -> Arc<ModStore> {
    let split = FULLDPS_PARENT.with(|p| p.borrow().as_ref().filter(|(addr, _)| *addr == player as *const ModStore as usize).map(|(_, b)| b.clone()));
    // The split below depends only on the player's list and the parent-level mods. The memo holds both, so a
    // changed player list is a new list (copy-on-write) and misses.
    if let (Backing::List(v), Some(base)) = (&player.backing, &split) {
        let hit = SPLIT_MEMO.with(|m| m.borrow().as_ref().filter(|e| Arc::ptr_eq(&e.0, v) && Arc::ptr_eq(&e.1, base)).map(|e| (e.2.clone(), e.3.clone())));
        if let Some((parent_list, child_list)) = hit {
            let mut parent = ModStore::new_list(None, player.actor.clone());
            parent.backing = Backing::List(parent_list);
            let mut snap = ModStore::new_list(Some(Arc::new(parent)), player.actor.clone());
            snap.backing = Backing::List(child_list);
            snap.conditions = player.conditions.clone();
            snap.multipliers = player.multipliers.clone();
            return Arc::new(snap);
        }
    }
    let mods: Vec<Mod> = match (&player.backing, &split) {
        (Backing::List(_), None) => Vec::new(),
        (Backing::List(v), Some(_)) => v.to_vec(),
        (Backing::Db(m), _) => m.values().flatten().cloned().collect(),
    };
    // While a `calcs.calcFullDPS` run is being replayed, the player modDB has `cachedPlayerDB` as its parent: the
    // mods added before `specCopy` sit one list level down (`More` rounds per level, `Tabulate` orders by level).
    if let Some(base) = split {
        let mut buckets: HashMap<Sym, Vec<Mod>> = HashMap::default();
        for b in base.iter() {
            buckets.entry(b.name).or_default().push(b.clone());
        }
        let mut parent_mods = Vec::new();
        let mut child_mods = Vec::new();
        for m in mods {
            match buckets.get_mut(&m.name).and_then(|bk| bk.iter().position(|b| *b == m).map(|i| bk.remove(i))) {
                Some(_) => parent_mods.push(m),
                None => child_mods.push(m),
            }
        }
        let mut parent = ModStore::new_list(None, player.actor.clone());
        for m in parent_mods {
            parent.add_mod(m);
        }
        let mut snap = ModStore::new_list(Some(Arc::new(parent)), player.actor.clone());
        for m in child_mods {
            snap.add_mod(m);
        }
        if let (Backing::List(v), Some(p), Backing::List(c)) = (&player.backing, snap.parent.as_ref(), &snap.backing) {
            if let Backing::List(pl) = &p.backing {
                SPLIT_MEMO.with(|m| *m.borrow_mut() = Some((v.clone(), base.clone(), pl.clone(), c.clone())));
            }
        }
        snap.conditions = player.conditions.clone();
        snap.multipliers = player.multipliers.clone();
        return Arc::new(snap);
    }
    let mut snap = ModStore::new_list(None, player.actor.clone());
    match &player.backing {
        // Same mods in the same order as adding them one by one, without copying the list.
        Backing::List(v) => snap.backing = Backing::List(v.clone()),
        Backing::Db(_) => for m in mods { snap.add_mod(m); },
    }
    snap.conditions = player.conditions.clone();
    snap.multipliers = player.multipliers.clone();
    Arc::new(snap)
}

thread_local! {
    /// The last FullDPS split: (player list, parent-level mods, parent list, child list).
    static SPLIT_MEMO: std::cell::RefCell<Option<(Arc<pom_engine::modstore::store::ModList>, Arc<Vec<Mod>>, Arc<pom_engine::modstore::store::ModList>, Arc<pom_engine::modstore::store::ModList>)>> = const { std::cell::RefCell::new(None) };
}

thread_local! {
    /// `(address of the player store, parent-level mods)` while `offence_dps::full_dps` replays a skill.
    pub(crate) static FULLDPS_PARENT: std::cell::RefCell<Option<(usize, Arc<Vec<Mod>>)>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn skill_cfg(c: &pom_skills::assemble::ComputedSkill) -> Cfg {
    Cfg {
        flags: c.flags,
        keyword_flags: c.keyword_flags,
        skill_name: Some(Arc::from(c.name.as_str())),
        summon_skill_name: c.summon_skill_name.as_deref().map(Arc::from),
        slot_name: c.slot_name.as_deref().map(Arc::from),
        skill_types: c.skill_types.iter().map(|t| (*t, true)).collect(),
        skill_granted_effect_id: Some(Arc::from(c.granted_effect_id.as_str())),
        socket_color: c.socket_color.map(|ch| Arc::from(ch.to_string())),
        socket_num: c.socket_num.map(|n| n as f64),
        ..Cfg::default()
    }
}

/// `SkillData` LIST mods with a given `.value.key` (`CalcActiveSkill.lua`:660-666's "Extract skill
/// data" loop) - only `auraCannotAffectSelf` is looked up here (the only one of the four
/// `activeSkill.skillData.*` gate fields `compute_buffs` needs that's ever actually set by current
/// game data - see this module's doc comment for the other three).
fn skill_data_flag(mods: &[Mod], key: &str) -> bool {
    // "Extract skill data" assigns `skillData[key] = value` in list order, so the last entry wins.
    mods.iter()
        .filter(|m| m.name.as_str() == "SkillData" && m.ty == ModType::List)
        .filter_map(|m| match &m.value {
            Value::Map(fields) if fields.iter().any(|(k, v)| k.as_str() == "key" && matches!(v, Value::Str(s) if s.as_ref() == key)) => fields.iter().find(|(k, _)| k.as_str() == "value").map(|(_, v)| v.truthy()),
            _ => None,
        })
        .last()
        .unwrap_or(false)
}

fn extra_skill_data(extras: &[(String, bool)], key: &str) -> Option<bool> {
    extras.iter().rev().find(|(k, _)| k == key).map(|(_, v)| *v)
}

/// `activeSkill.skillData[key]` truthiness from the skill's own `SkillData` LIST mods: the last one
/// for the key wins (CalcActiveSkill.lua:660-666), `None` if the key is never set.
fn skill_data_last(mods: &[Mod], key: &str) -> Option<bool> {
    let mut out = None;
    for m in mods {
        if m.name.as_str() != "SkillData" || m.ty != ModType::List {
            continue;
        }
        if let Value::Map(fields) = &m.value {
            if fields.iter().any(|(k, v)| k.as_str() == "key" && matches!(v, Value::Str(s) if s.as_ref() == key)) {
                if let Some((_, v)) = fields.iter().find(|(k, _)| k.as_str() == "value") {
                    out = Some(v.truthy());
                }
            }
        }
    }
    out
}

/// Names of `activeSkill.buffList` (one per distinct `(effectType, effectName)` among the skill's
/// GlobalEffect mods; CalcActiveSkill.lua:818-849), for `ModStore:GetStat`'s reservation lookup.
pub(crate) fn buff_names(c: &pom_skills::assemble::ComputedSkill) -> Vec<String> {
    let full_effect_name = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| c.name.clone());
    let mut seen: Vec<(String, String)> = Vec::new();
    for m in &c.skill_mod_list {
        let Some(tag) = m.tags.iter().find(|t| t.kind.as_str() == "GlobalEffect") else { continue };
        let Some(ty) = tag_str(tag.get(pom_engine::sym!("effectType"))) else { continue };
        let name = tag_str(tag.get(pom_engine::sym!("effectName"))).unwrap_or_else(|| full_effect_name.clone());
        if !seen.iter().any(|(t, n)| *t == ty && *n == name) {
            seen.push((ty, name));
        }
    }
    seen.into_iter().map(|(_, n)| n).collect()
}

/// Builds one active skill's `(SkillBuffs, ModStore)` pair - `None` when the skill produced no
/// buff/aura mods at all (an ordinary damage/utility skill, the common case), matching
/// `compute_buffs`'s own no-op result for a skill with an empty `buffList`.
pub fn build_skill_buffs(c: &pom_skills::assemble::ComputedSkill, player_snap: &Arc<ModStore>, allies_auras_cannot_affect_self: bool, enemy: &ModStore) -> (SkillBuffs, ModStore) {
    let cfg = skill_cfg(c);
    let is_totem = c.skill_flags.contains("totem");
    let own_mod_source: Option<String> = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.extra.get("modSource")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let aura_cannot_affect_self = skill_data_flag(&c.skill_mod_list, "auraCannotAffectSelf");

    // `activeEffect.grantedEffect.name` (CalcActiveSkill.lua:819): the full name, unlike `skillCfg.skillName`
    // which strips "Vaal " (so Vaal Haste and Haste stay separate buffs).
    let full_effect_name = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| c.name.clone());

    // `ExtraSkillMod` LIST mods from the player (support-like "Your Offering skills also affect you"): their inner
    // `SkillData` mods are appended to the skill's mod list (CalcActiveSkill.lua), so they win over the skill's own.
    let skill_data_extras: Vec<(String, bool)> = player_snap
        .list(Some(&cfg), &[pom_engine::sym!("ExtraSkillMod")])
        .iter()
        .filter_map(|v| {
            let Value::Map(outer) = v else { return None };
            let Value::Map(inner) = outer.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v)? else { return None };
            let get = |k: &str| inner.iter().find(|(kk, _)| kk.as_str() == k).map(|(_, v)| v);
            if !matches!(get("name"), Some(Value::Str(n)) if n.as_ref() == "SkillData") {
                return None;
            }
            let Some(Value::Map(kv)) = get("value") else { return None };
            let key = kv.iter().find_map(|(k, v)| if k.as_str() == "key" { if let Value::Str(s) = v { Some(s.to_string()) } else { None } } else { None })?;
            let val = kv.iter().find(|(k, _)| k.as_str() == "value").map(|(_, v)| v.truthy()).unwrap_or(false);
            Some((key, val))
        })
        .collect();

    struct Building {
        ty: String,
        name: String,
        mod_list: Vec<Mod>,
        apply_not_player: bool,
        apply_minions: bool,
        apply_allies: bool,
        allow_totem_buff: bool,
        active_skill_buff: bool,
        cond: Option<String>,
        enemy_cond: Option<String>,
        stack_var: Option<String>,
        stack_limit: Option<f64>,
        stack_limit_var: Option<String>,
    }
    let mut building: Vec<Building> = Vec::new();
    let mut kept: Vec<Mod> = Vec::new();

    for m in &c.skill_mod_list {
        let ge_tag: Option<&Tag> = m.tags.iter().find(|t| t.kind.as_str() == "GlobalEffect");
        let Some(tag) = ge_tag else {
            kept.push(m.clone());
            continue;
        };
        let Some(effect_type) = tag_str(tag.get(pom_engine::sym!("effectType"))) else {
            kept.push(m.clone());
            continue;
        };
        // `effectTag.modCond` (never set by any current template - see doc comment) - ported
        // faithfully anyway, checked against the skill's own full (pre-extraction) mod list.
        if let Some(mod_cond) = tag_str(tag.get(pom_engine::sym!("modCond"))) {
            let mut full = ModStore::new_list(Some(player_snap.clone()), player_snap.actor.clone());
            for mm in &c.skill_mod_list {
                full.add_mod(mm.clone());
            }
            if !full.get_condition(Sym::new(&mod_cond), Some(&cfg), false) {
                continue; // dropped entirely: never reaches a buff or the kept list.
            }
        }
        let effect_name = tag_str(tag.get(pom_engine::sym!("effectName"))).unwrap_or_else(|| full_effect_name.clone());
        let mut allow_totem_buff = tag.get(pom_engine::sym!("allowTotemBuff")).truthy();
        let mut apply_not_player = tag.get(pom_engine::sym!("applyNotPlayer")).truthy();
        let cond = tag_str(tag.get(pom_engine::sym!("effectCond")));
        let enemy_cond = tag_str(tag.get(pom_engine::sym!("effectEnemyCond")));
        let stack_var = tag_str(tag.get(pom_engine::sym!("effectStackVar")));
        let stack_limit = match tag.get(pom_engine::sym!("effectStackLimit")) {
            Value::Num(n) => Some(*n),
            _ => None,
        };
        let stack_limit_var = tag_str(tag.get(pom_engine::sym!("effectStackLimitVar")));
        let active_skill_buff = own_mod_source.as_deref().is_some() && m.source.as_deref() == own_mod_source.as_deref();

        // CalcActiveSkill.lua:840-846: a buff carrying the active skill's own mod source inherits its
        // `skillData.buffNotPlayer`/`allowTotemBuff` (e.g. Offerings: `baseMods = skill("buffNotPlayer", true)`).
        let mut apply_minions = tag.get(pom_engine::sym!("applyMinions")).truthy();
        let mut apply_allies = false;
        let (apply_not_player, allow_totem_buff) = if active_skill_buff {
            apply_minions = apply_minions || extra_skill_data(&skill_data_extras, "buffMinions").or_else(|| skill_data_last(&c.skill_mod_list, "buffMinions")).unwrap_or(false);
            apply_allies = extra_skill_data(&skill_data_extras, "buffAllies").or_else(|| skill_data_last(&c.skill_mod_list, "buffAllies")).unwrap_or(false);
            (apply_not_player || extra_skill_data(&skill_data_extras, "buffNotPlayer").or_else(|| skill_data_last(&c.skill_mod_list, "buffNotPlayer")).unwrap_or(false), extra_skill_data(&skill_data_extras, "allowTotemBuff").or_else(|| skill_data_last(&c.skill_mod_list, "allowTotemBuff")).unwrap_or(false))
        } else {
            (apply_not_player, allow_totem_buff)
        };
        let idx = building.iter().position(|b| b.ty == effect_type && b.name == effect_name).unwrap_or_else(|| {
            building.push(Building { ty: effect_type.clone(), name: effect_name.clone(), mod_list: Vec::new(), apply_not_player, apply_minions, apply_allies, allow_totem_buff, active_skill_buff, cond, enemy_cond, stack_var, stack_limit, stack_limit_var });
            building.len() - 1
        });
        merge_into_buff_mod_list(&mut building[idx].mod_list, m);
    }

    let mut kept_store = ModStore::new_list(Some(player_snap.clone()), player_snap.actor.clone());
    for m in &kept {
        kept_store.add_mod(m.clone());
    }
    // CalcActiveSkill.lua:646-656: every skill (not just the main one) gets its `Multiplier:<Name>Stage` /
    // `...StageAfterFirst` mods, which `effectCond` gates such as Scorching Ray's `MultiplierThreshold` read.
    {
        let name: String = pom_skills::data::granted_effect_by_skill_id(&c.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| c.name.clone()).split_whitespace().collect();
        // `skillCfg.skillPart` (CalcActiveSkill.lua:248-266): only multipart skills have one.
        let mut part_cfg = cfg.clone();
        if let Some(p) = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(pom_skills::data::parts).filter(|p| p.len() > 1) {
            part_cfg.skill_part = Some((c.gem_skill_part.unwrap_or(1).max(1) as usize).min(p.len()) as f64);
        }
        let limit = kept_store.sum(ModType::Base, Some(&part_cfg), &[Sym::new(&format!("Multiplier:{name}MaxStages"))]);
        if limit > 0.0 {
            let min_stage = kept_store.sum(ModType::Base, Some(&cfg), &[Sym::new(&format!("Multiplier:{name}MinimumStage"))]);
            let count = c.stage_count.unwrap_or(limit).max(1.0 + min_stage);
            let mk = |n: String, v: f64| Mod { name: Sym::new(&n), ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(Arc::from("Base")), tags: (vec![]).into() };
            kept_store.add_mod(mk(format!("Multiplier:{name}Stage"), limit.min(count)));
            kept_store.add_mod(mk(format!("Multiplier:{name}StageAfterFirst"), (limit - 1.0).min(count - 1.0)));
        }
    }

    // `extraAuraModList` (CalcPerform.lua:2447-2459), shared by every Aura buff of this skill.
    let mut extra_aura_mods: Vec<Mod> = Vec::new();
    if building.iter().any(|b| b.ty == "Aura") {
        for v in player_snap.list(Some(&cfg), &[pom_engine::sym!("ExtraAuraEffect")]) {
            let Value::Map(outer) = v else { continue };
            let Some((_, Value::Map(inner))) = outer.iter().find(|(k, _)| k.as_str() == "mod") else { continue };
            let m = crate::actor_misc::map_to_mod(inner);
            if let Some(existing) = extra_aura_mods.iter_mut().find(|e| mod_params_match(e, &m)) {
                if let (Value::Num(a), Value::Num(b)) = (&existing.value, &m.value) {
                    existing.value = Value::Num(a + b);
                }
            } else {
                extra_aura_mods.push(m);
            }
        }
    }

    let party = crate::party::current();
    let buff_list: Vec<SkillBuff> = building
        .into_iter()
        .map(|b| {
            // `allyBuffs["Aura"][buff.name]` (CalcPerform.lua:2465): the party member's same-named aura.
            let party_aura = if b.ty == "Aura" { party.list("Aura").iter().find(|(n, _)| *n == b.name).map(|(_, x)| x.effect_mult) } else { None };
            // The buff modes: Buff/Guard/Warcry/Aura/Link branches need `env.mode_buffs`, Debuff/AuraDebuff `env.mode_effective`
            // (CalcPerform.lua:2319-2711); Curse branches test their own mode in `curse_pass`.
            let mode = pom_calc::setup::buff_mode();
            let mode_ok = match b.ty.as_str() {
                "Buff" | "Guard" | "Warcry" | "Aura" | "Link" => mode.buffs,
                "Debuff" | "AuraDebuff" => mode.effective,
                _ => true,
            };
            let gate_ok = mode_ok && b.cond.as_deref().is_none_or(|c| kept_store.get_condition(Sym::new(c), Some(&cfg), false)) && b.enemy_cond.as_deref().is_none_or(|c| enemy.get_condition(Sym::new(c), None, false));
            SkillBuff {
                ty: b.ty,
                name: b.name,
                mod_list: b.mod_list,
                apply_not_player: b.apply_not_player,
                apply_minions: b.apply_minions,
                apply_allies: b.apply_allies,
                allow_totem_buff: b.allow_totem_buff,
                active_skill_buff: b.active_skill_buff,
                gate_ok,
                aura_cannot_affect_self,
                allies_auras_cannot_affect_self_flag: allies_auras_cannot_affect_self,
                has_party_aura: party_aura.is_some(),
                party_aura_effect_mult: party_aura.unwrap_or(0.0),
                extra_aura_mods: extra_aura_mods.clone(),
                stack_var: b.stack_var,
                stack_limit: b.stack_limit,
                stack_limit_var: b.stack_limit_var,
            }
        })
        .collect();

    (SkillBuffs { is_totem, buff_list, cfg }, kept_store)
}

/// The three things the buff loop yields besides `compute_buffs`' own `buffs` map: mods added
/// straight to the player modDB (`NumXExerts`, `Multiplier:ExertingWarcryCount`), and
/// `modDB.conditions["AffectedBy..."]` names.
pub struct BuffLoopExtras {
    /// `#buffs` entries (not `notBuff`): each adds one to `modDB.multipliers["BuffOnSelf"]` (CalcPerform.lua:3344-3348).
    pub buff_on_self: f64,
    pub player_mods: Vec<Mod>,
    pub conditions: Vec<String>,
    /// `modDB.conditions["SelfCast<Curse>"]` values (CalcPerform.lua:2655).
    pub self_cast: Vec<(String, bool)>,
    /// Player-cast curses awaiting slot assignment (`pom_calc::perform_curses`).
    pub curses: Vec<pom_calc::perform_curses::CurseIn>,
    /// `minionCurses` (CalcPerform.lua:2202, 2933-2944, 3144-3190) and its `limit`.
    pub minion_curses: Vec<pom_calc::perform_curses::CurseIn>,
    pub minion_curse_limit: f64,
    /// `minionBuffs` (merged per buff name, flattened) and the `env.minion.modDB.conditions` the loop sets.
    pub minion_mods: Vec<Mod>,
    pub minion_conditions: Vec<String>,
    /// Mods added straight to the enemy modDB by the skill loop (Combustion's FireResist debuff).
    pub enemy_mods: Vec<Mod>,
    /// (skill index, buff index) -> (warcry power, uptime) for each shared Warcry buff (read by the minion half).
    pub warcry_info: HashMap<(usize, usize), (f64, f64)>,
    /// `buffExports` of the skill loop (Export Support), when the build has it switched on.
    pub exports: Option<crate::buff_export::BuffExports>,
}

fn syms(names: &[&str]) -> Vec<Sym> {
    names.iter().map(|n| Sym::new(n)).collect()
}

/// `buff.type == "Warcry"` branch of CalcPerform.lua:2363-2418 (player side only; the minion /
/// party-export halves need an actor this crate doesn't build). Returns per-buff-name merged mods.
fn warcry_pass(
    player: &ModStore,
    pairs: &[(SkillBuffs, ModStore)],
    active_skills: &[pom_skills::assemble::ComputedSkill],
    enemy: &ModStore,
    main_cfg: Option<&Cfg>,
    extras: &mut BuffLoopExtras,
) -> Vec<(String, Vec<Mod>)> {
    let mut out: Vec<(String, Vec<Mod>)> = Vec::new();
    let mut warcry_list: Vec<String> = Vec::new();
    for (si, ((skill, skill_mod_list), c)) in pairs.iter().zip(active_skills.iter()).enumerate() {
        let cfg = &skill.cfg;
        for (bi, b) in skill.buff_list.iter().enumerate() {
            if b.ty != "Warcry" || !b.gate_ok {
                continue;
            }
            let warcry_name = b.name.replace(" Cry", "").replace("'s", "").replace(' ', "");
            let base_exerts = skill_mod_list.sum(ModType::Base, main_cfg, &[Sym::new(&format!("{warcry_name}ExertedAttacks"))]);
            if base_exerts > 0.0 {
                let extra_exertions = skill_mod_list.sum(ModType::Base, None, &[pom_engine::sym!("ExtraExertedAttacks")]);
                let exert_multiplier = skill_mod_list.more(None, &[pom_engine::sym!("ExtraExertedAttacks")]);
                // Keep the expected value of "10% chance to Exert 3 additional Attacks" (0.3) instead of flooring it away (differs from upstream).
                let exerts = if pom_offence::data::pom_fixes_on() { (base_exerts + extra_exertions) * exert_multiplier } else { ((base_exerts + extra_exertions) * exert_multiplier).floor() };
                extras.player_mods.push(Mod { name: Sym::new(&format!("Num{warcry_name}Exerts")), ty: ModType::Base, value: Value::Num(exerts), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
                if !warcry_list.contains(&b.name) {
                    extras.player_mods.push(Mod { name: pom_engine::sym!("Multiplier:ExertingWarcryCount"), ty: ModType::Base, value: Value::Num(1.0), flags: 0, keyword_flags: 0, source: Some(Arc::from(b.name.as_str())), tags: (vec![]).into() });
                    warcry_list.push(b.name.clone());
                }
            }
            if skill_mod_list.flag(None, &[pom_engine::sym!("CannotShareWarcryBuffs")]) {
                continue;
            }
            let wp = pom_engine::sym!("WarcryPower");
            let warcry_power = match player.override_(None, &[wp]) {
                Some(Value::Num(n)) => n,
                _ => (player.sum(ModType::Base, None, &[wp]) * (1.0 + player.sum(ModType::Inc, None, &[wp]) / 100.0)).max(player.sum(ModType::Base, None, &[pom_engine::sym!("MinimumWarcryPower")])),
            };
            let mut mods = b.mod_list.clone();
            let mut bonus: Vec<Option<f64>> = Vec::with_capacity(mods.len());
            for m in &mods {
                let t = m.tags.first();
                let is_warcry = t.map_or(false, |t| tag_str(t.get(pom_engine::sym!("effectType"))).as_deref() == Some("Warcry"));
                let div = t.and_then(|t| if let Value::Num(d) = t.get(pom_engine::sym!("div")) { Some(*d) } else { None });
                bonus.push(match (is_warcry, div) {
                    (true, Some(div)) if div != 0.0 => {
                        let limit = t.and_then(|t| if let Value::Num(l) = t.get(pom_engine::sym!("limit")) { Some(*l) } else { None });
                        Some((limit.map_or(warcry_power, |l| warcry_power.min(l)) / div).floor())
                    }
                    _ => None,
                });
            }
            // `warcryBuff[1].warcryPowerBonus = ...` mutates the shared tag (CalcPerform.lua:2382): every copy of the mod shows it
            if crate::bd_perform::perform_on() {
                for (m, pb) in mods.iter_mut().zip(bonus.iter()) {
                    if let (Some(p), Some(t)) = (pb, m.tags.first().is_some().then(|| &mut m.tags[0])) {
                        t.fields.push((Sym::new("warcryPowerBonus"), Value::Num(*p)));
                    }
                }
            }
            let sd = crate::offence::skill_data_map(player, c);
            let num = |k: &str| match sd.get(k) {
                Some(pom_engine::modstore::types::ScalarValue::Num(n)) => Some(*n),
                _ => None,
            };
            let mine_applies = matches!(sd.get("mineDurationAppliesToSkill"), Some(pom_engine::modstore::types::ScalarValue::Bool(true)));
            let debuff = matches!(sd.get("debuff"), Some(pom_engine::modstore::types::ScalarValue::Bool(true)));
            let full_duration = pom_offence::cooldown::calc_skill_duration_helper(skill_mod_list, Some(cfg), num("duration"), mine_applies, debuff, true, enemy);
            let cd_names = [pom_engine::sym!("CooldownRecovery")];
            let actual_cooldown = match skill_mod_list.override_(Some(cfg), &cd_names) {
                Some(Value::Num(n)) => n,
                _ => (num("cooldown").unwrap_or(0.0) + skill_mod_list.sum(ModType::Base, Some(cfg), &cd_names)) / pom_offence::tools::calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("CooldownRecovery")]),
            };
            let uptime = if player.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) { 1.0 } else { (full_duration / actual_cooldown).min(1.0) };
            extras.warcry_info.insert((si, bi), (warcry_power, uptime));
            if !player.flag(None, &[pom_engine::sym!("CannotGainWarcryBuffs")]) && !b.apply_not_player {
                extras.conditions.push(format!("AffectedBy{warcry_name}"));
                let names = syms(&["BuffEffect", "BuffEffectOnSelf", "BuffEffectOnPlayer"]);
                let inc = skill_mod_list.sum(ModType::Inc, Some(cfg), &names);
                let more = skill_mod_list.more(Some(cfg), &names[..2]);
                let mut src: Vec<Mod> = Vec::new();
                for (m, pb) in mods.drain(..).zip(bonus.iter()) {
                    let mult = (1.0 + inc / 100.0) * more * pb.unwrap_or(1.0) * uptime;
                    src.extend(pom_calc::perform::scale_add_list(std::slice::from_ref(&m), mult));
                }
                if let Some(e) = out.iter_mut().find(|(n, _)| *n == b.name) {
                    pom_calc::perform::merge_buff(&mut e.1, &src);
                } else {
                    let mut dest = Vec::new();
                    pom_calc::perform::merge_buff(&mut dest, &src);
                    out.push((b.name.clone(), dest));
                }
            }
        }
    }
    out
}

/// Builds every active skill's `(SkillBuffs, ModStore)` pair and runs `compute_buffs`, returning
/// the flattened `buffs` map ready to merge into `env.player` (`CalcPerform.lua`:3344-3345's
/// `for _, modList in pairs(buffs) do modDB:AddList(modList) end`, the real point these mods join
/// the player's own mod store - see `run`'s call site), plus the `AffectedBy*` conditions and
/// direct player mods the loop also produces (Warcry branch, Buff/Aura `AffectedBy` conditions).
pub fn compute_and_flatten(player: &ModStore, enemy: &ModStore, active_skills: &[pom_skills::assemble::ComputedSkill], main_cfg: Option<&Cfg>, config_input: &pom_engine::fxhash::HashMap<String, f64>, minion: Option<&ModStore>, weapon1: &HashMap<String, f64>, summon_undamagable: bool, main_is_totem: bool, spectre_list: &[String], minion_ctx: Vec<(Vec<pom_skills::assemble::ComputedSkill>, String, bool, bool, usize)>) -> (Vec<Mod>, BuffLoopExtras) {
    let snap = player_snapshot(player);
    let allies_auras_cannot_affect_self = player.flag(None, &[pom_engine::sym!("AlliesAurasCannotAffectSelf")]);
    let pairs: Vec<(SkillBuffs, ModStore)> = active_skills.iter().map(|c| build_skill_buffs(c, &snap, allies_auras_cannot_affect_self, enemy)).collect();
    let mut buffs = pom_calc::perform::compute_buffs_and_conditions_totem(&snap, &pairs, main_is_totem).0;
    let mut extras = BuffLoopExtras { buff_on_self: 0.0, player_mods: Vec::new(), conditions: Vec::new(), self_cast: Vec::new(), curses: Vec::new(), minion_curses: Vec::new(), minion_curse_limit: 1.0, minion_mods: Vec::new(), minion_conditions: Vec::new(), enemy_mods: Vec::new(), warcry_info: HashMap::default(), exports: None };
    // Active spectres' `AllyModifier`/`PlayerModifier`/`MinionModifier` LIST mods (CalcPerform.lua:2207-2270):
    // player-facing ones become `buffs["Spectre"]`, minion-facing ones `minionBuffs["Spectre"]`.
    {
        let mut active_types: Vec<String> = Vec::new();
        let mut has_spectre_skill = false;
        for c in active_skills {
            if !c.skill_flags.contains("disable") && c.granted_effect_id.starts_with("RaiseSpectre") {
                has_spectre_skill = true;
                let mut list: Vec<String> = Vec::new();
                if c.is_spectre {
                    list.extend(spectre_list.iter().cloned());
                }
                list.extend(c.minion_list.iter().cloned());
                if !list.is_empty() {
                    let idx = c.src_skill_minion.as_ref().and_then(|t| list.iter().position(|x| x == t)).unwrap_or(0);
                    active_types.push(list[idx].clone());
                }
            }
        }
        if has_spectre_skill {
            for id in spectre_list {
                if !active_types.contains(id) {
                    continue;
                }
                let Some(raw) = pom_calc::data::minion_raw(id) else { continue };
                let md = pom_calc::data::minion_data(id);
                if raw.get("monsterTags").and_then(|t| t.as_array()).is_some_and(|a| a.iter().any(|x| x.as_str() == Some("beast"))) {
                    extras.conditions.push("HaveBeastSpectre".to_string());
                }
                let spectre_name = raw.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let source: Arc<str> = Arc::from(format!("Spectre:{spectre_name}").as_str());
                for md_mod in &md.mod_list {
                    let inner: Vec<Mod> = if let Value::Map(vm) = &md_mod.value {
                        vm.iter().filter_map(|(_, v)| if let Value::Map(im) = v { let mut m = crate::actor_misc::map_to_mod(im); m.source = Some(source.clone()); Some(m) } else { None }).collect()
                    } else {
                        Vec::new()
                    };
                    match (md_mod.name.as_str(), md_mod.ty) {
                        ("EnemyCurseLimit", _) => {
                            extras.minion_curse_limit = md_mod.value.num().unwrap_or(0.0) + 1.0;
                            break;
                        }
                        ("AllyModifier", ModType::List) => {
                            buffs.entry("Spectre".to_string()).or_default().extend(inner.iter().cloned());
                            crate::bd_perform::cap_minion("Spectre", &inner); extras.minion_mods.extend(inner);
                        }
                        ("MinionModifier", ModType::List) => { crate::bd_perform::cap_minion("Spectre", &inner); extras.minion_mods.extend(inner) }
                        ("PlayerModifier", ModType::List) => buffs.entry("Spectre".to_string()).or_default().extend(inner),
                        _ => {}
                    }
                }
            }
        }
    }
    // `modDB.conditions["AffectedBy"..name] = true` (CalcPerform.lua:2325, 2470-2475) for every Buff/Aura that applied.
    // `(index of the applying skill in activeSkillList, condition name)`: upstream sets these while walking the skills in
    // order, so a minion aura only sees the conditions of skills at or before its owner's position.
    let mut cond_owner: Vec<(usize, String)> = Vec::new();
    let mut minion_cond_added: Vec<String> = Vec::new();
    for (skill_idx, (skill, _)) in pairs.iter().enumerate() {
        for b in &skill.buff_list {
            if !b.gate_ok {
                continue;
            }
            let applied = match b.ty.as_str() {
                "Buff" => !(skill.is_totem && !b.allow_totem_buff) && !b.apply_not_player,
                "Aura" => !b.aura_cannot_affect_self && buffs.get(&b.name).is_some(),
                _ => false,
            };
            if applied {
                let n = b.name.replace(' ', "");
                cond_owner.push((skill_idx, format!("AffectedBy{n}")));
                if b.ty == "Aura" {
                    extras.conditions.push("AffectedByAura".to_string());
                    if b.name.starts_with("Vaal") {
                        extras.conditions.push(format!("AffectedBy{}", b.name.get(5..).unwrap_or("").replace(' ', "")));
                    }
                }
                extras.conditions.push(format!("AffectedBy{n}"));
            }
        }
    }
    // Guard slots (CalcPerform.lua:3317-3341): same sorted-name stand-in for `pairs(guards)` as
    // `pom_calc::perform::compute_buffs_and_conditions`, which merges the mods themselves.
    let mut guard_names: Vec<&String> = pairs
        .iter()
        .flat_map(|(skill, _)| skill.buff_list.iter().map(move |b| (skill, b)))
        .filter(|(skill, b)| b.gate_ok && b.ty == "Guard" && !(skill.is_totem && !b.allow_totem_buff) && !b.apply_not_player)
        .map(|(_, b)| &b.name)
        .collect();
    guard_names.sort();
    guard_names.dedup();
    let mut guard_slots: Vec<&String> = Vec::new();
    let mut non_vaal = false;
    for name in guard_names {
        if name == "Vaal Molten Shell" {
            guard_slots.clear();
            non_vaal = false;
            guard_slots.push(name);
            break;
        } else if name.starts_with("Vaal") {
            guard_slots.push(name);
        } else if !non_vaal {
            guard_slots.push(name);
            non_vaal = true;
        }
    }
    if non_vaal {
        extras.conditions.push("AffectedByNonVaalGuardSkill".to_string());
    }
    for name in guard_slots {
        extras.conditions.push("AffectedByGuardSkill".to_string());
        extras.conditions.push(format!("AffectedBy{}", name.replace(' ', "")));
    }
    for (name, mods) in warcry_pass(&snap, &pairs, active_skills, enemy, main_cfg, &mut extras) {
        pom_calc::perform::merge_buff(buffs.entry(name).or_default(), &mods);
    }
    if crate::buff_export::EXPORT_ON.with(|c| c.get()) {
        // The minions' own skills (CalcPerform.lua:2777-2990 reads `activeSkill.minion.activeSkillList`): their buffs, built the
        // way the minion pass above builds them, enabled only by a `SkillData` `enable` mod.
        let empty_parent: Arc<ModStore> = Arc::new(ModStore::new_list(None, None));
        let mut minion_skills: Vec<crate::buff_export::MinionSkill> = Vec::new();
        for (mskills, mname, is_spectre, is_main_minion, owner_idx) in &minion_ctx {
            for ms in mskills.iter() {
                if ms.skill_flags.contains("disable") {
                    continue;
                }
                let cfg_ms = skill_cfg(ms);
                let cfg_enable = snap.list(Some(&cfg_ms), &[pom_engine::sym!("SkillData")]).iter().filter_map(|v| {
                    let Value::Map(kv) = v else { return None };
                    if !kv.iter().any(|(k, x)| k.as_str() == "key" && matches!(x, Value::Str(s) if s.as_ref() == "enable")) {
                        return None;
                    }
                    kv.iter().find(|(k, _)| k.as_str() == "value").map(|(_, x)| x.truthy())
                }).last();
                let enable = skill_data_last(&ms.skill_mod_list, "enable").or(cfg_enable).unwrap_or(false);
                let (sb, sml) = build_skill_buffs(ms, &empty_parent, allies_auras_cannot_affect_self, enemy);
                minion_skills.push(crate::buff_export::MinionSkill { owner: *owner_idx, minion_name: mname.clone(), is_spectre: *is_spectre, is_main: *is_main_minion, enable, sb, sml, stack_count: match crate::offence::skill_data_map(&snap, ms).get("stackCount") { Some(pom_engine::modstore::types::ScalarValue::Num(n)) => Some(*n), _ => None } });
            }
        }
        extras.exports = Some(crate::buff_export::collect_skills(&snap, enemy, &pairs, active_skills, &extras.warcry_info, config_input, &minion_skills, minion, weapon1, main_cfg));
    }
    if let Some(minion) = minion {
        minion_buff_pass(&snap, &pairs, minion, main_cfg, weapon1, summon_undamagable, &mut extras);
    }
    // The minion's own skills' Aura buffs reaching the player (CalcPerform.lua:2777-2905, Aura branch, player half;
    // the main skill's minion only, `ExtraAuraEffect` from the minion's modDB and the ally/party checks are not modelled).
    let empty_parent: Arc<ModStore> = Arc::new(ModStore::new_list(None, None));
    let mut totem_aura_seen: Vec<String> = Vec::new();
    for (mskills, mname, is_spectre, is_main_minion, owner_idx) in &minion_ctx {
        let minion_flag = |n: &str| *is_main_minion && minion.is_some_and(|m| m.flag(None, &[Sym::new(n)]));
        for ms in mskills.iter() {
            if ms.skill_flags.contains("disable") {
                continue;
            }
            // CalcPerform.lua:2797/2839: `env.mode_buffs and activeMinionSkill.skillData.enable`; nothing sets
            // `skillData.enable` for a minion skill except a `SkillData` LIST mod (ConfigOptions.lua:589-697).
            let cfg_ms = skill_cfg(ms);
            let cfg_enable = snap.list(Some(&cfg_ms), &[pom_engine::sym!("SkillData")]).iter().filter_map(|v| {
                let Value::Map(kv) = v else { return None };
                if !kv.iter().any(|(k, x)| k.as_str() == "key" && matches!(x, Value::Str(s) if s.as_ref() == "enable")) {
                    return None;
                }
                kv.iter().find(|(k, _)| k.as_str() == "value").map(|(_, x)| x.truthy())
            }).last();
            if !skill_data_last(&ms.skill_mod_list, "enable").or(cfg_enable).unwrap_or(false) {
                continue;
            }
            let (sb, sml) = build_skill_buffs(ms, &empty_parent, allies_auras_cannot_affect_self, enemy);
            for b in &sb.buff_list {
                if !b.gate_ok || b.ty != "Aura" {
                    continue;
                }
                if minion_flag("SelfAurasCannotAffectAllies") || minion_flag("SelfAurasOnlyAffectYou") || minion_flag("SelfAuraSkillsCannotAffectAllies") || sml.flag(Some(&sb.cfg), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")]) {
                    continue;
                }
                let cond_name = format!("AffectedBy{}", b.name.replace(' ', ""));
                // CalcPerform.lua:2895-2925: a totem main skill also gets the aura's EnergyShield/Armour/Evasion/Resist
                // mods as `Totem<name>` (conditions set on the main skill's own skillModList, tracked here).
                if main_is_totem && !totem_aura_seen.contains(&cond_name) {
                    totem_aura_seen.push(cond_name.clone());
                    let sy3 = ["AuraEffect", "BuffEffect", "AuraBuffEffect"].iter().map(|n| Sym::new(n)).collect::<Vec<_>>();
                    let inc = sml.sum(ModType::Inc, Some(&sb.cfg), &sy3);
                    let more = sml.more(Some(&sb.cfg), &sy3);
                    let scale = ((1.0 + inc / 100.0) * more).max(0.0);
                    let mut tsrc: Vec<Mod> = Vec::new();
                    for md in b.extra_aura_mods.iter().chain(b.mod_list.iter()) {
                        let n = md.name.as_str();
                        if n == "EnergyShield" || n == "Armour" || n == "Evasion" || pom_calc::perform::totem_resist_name(n) {
                            let mut tm = md.clone();
                            tm.name = Sym::new(&format!("Totem{n}"));
                            if scale != 1.0 {
                                if let Value::Num(v) = tm.value {
                                    tm.value = Value::Num(if v.floor() == v { (((v * scale) * 100.0 + 0.5).floor() / 100.0).trunc() } else { v * scale });
                                }
                            }
                            tsrc.push(tm);
                        }
                    }
                    if *is_spectre {
                        let source: Arc<str> = Arc::from(format!("Spectre:{}", mname).as_str());
                        for m in tsrc.iter_mut() {
                            m.source = Some(source.clone());
                        }
                    }
                    pom_calc::perform::merge_buff(buffs.entry(format!("Totem {}", b.name)).or_default(), &tsrc);
                }
                let already = cond_owner.iter().any(|(i, c)| i <= owner_idx && *c == cond_name) || minion_cond_added.contains(&cond_name) || player.conditions.get(&Sym::new(&cond_name)).copied().unwrap_or(false);
                if allies_auras_cannot_affect_self || already {
                    continue;
                }
                let sy = |ns: &[&str]| -> Vec<Sym> { ns.iter().map(|n| Sym::new(n)).collect() };
                let inc = sml.sum(ModType::Inc, Some(&sb.cfg), &sy(&["AuraEffect", "BuffEffect", "BuffEffectOnPlayer", "AuraBuffEffect"])) + snap.sum(ModType::Inc, Some(&sb.cfg), &sy(&["BuffEffectOnSelf", "AuraEffectOnSelf"]));
                let more = sml.more(Some(&sb.cfg), &sy(&["AuraEffect", "BuffEffect", "AuraBuffEffect"])) * snap.more(Some(&sb.cfg), &sy(&["BuffEffectOnSelf", "AuraEffectOnSelf"]));
                let mult = (1.0 + inc / 100.0) * more;
                extras.conditions.push("AffectedByAura".to_string());
                if b.name.starts_with("Vaal") {
                    extras.conditions.push(format!("AffectedBy{}", b.name.get(5..).unwrap_or("").replace(' ', "")));
                }
                minion_cond_added.push(cond_name.clone());
                extras.conditions.push(cond_name);
                let mut src = pom_calc::perform::scale_add_list(&b.mod_list, mult);
                src.extend(pom_calc::perform::scale_add_list(&b.extra_aura_mods, mult));
                if *is_spectre {
                    let source: Arc<str> = Arc::from(format!("Spectre:{} - {}", b.name, mname).as_str());
                    for m in src.iter_mut() {
                        m.source = Some(source.clone());
                    }
                }
                pom_calc::perform::merge_buff(buffs.entry(b.name.clone()).or_default(), &src);
            }
            // The minion's own `Curse` skills (CalcPerform.lua:2933-2944): `minionCurses`.
            for b in &sb.buff_list {
                if !b.gate_ok || b.ty != "Curse" {
                    continue;
                }
                if !pom_calc::setup::buff_mode().effective || !(!enemy.flag(None, &[pom_engine::sym!("Hexproof")]) || ms.skill_types.contains(&pom_skills::skill_type::MARK)) {
                    continue;
                }
                let sy = |ns: &[&str]| -> Vec<Sym> { ns.iter().map(|n| Sym::new(n)).collect() };
                let inc = sml.sum(ModType::Inc, Some(&sb.cfg), &sy(&["CurseEffect"])) + enemy.sum(ModType::Inc, None, &sy(&["CurseEffectOnSelf"]));
                let more = sml.more(Some(&sb.cfg), &sy(&["CurseEffect"])) * enemy.more(None, &sy(&["CurseEffectOnSelf"]));
                extras.minion_curses.push(pom_calc::perform_curses::CurseIn {
                    name: b.name.clone(),
                    from_player: false,
                    priority: determine_curse_priority(&b.name, Some(ms)),
                    is_mark: false,
                    ignore_hex_limit: false,
                    socketed_hex_limit: false,
                    skip: false,
                    mod_list: pom_calc::perform::scale_add_list(&b.mod_list, (1.0 + inc / 100.0) * more),
                    buff_mod_list: Vec::new(),
                    minion_buff_mod_list: Vec::new(),
                });
            }
            // The minion's own `Buff` skills (CalcPerform.lua:2794-2830): `applyAllies` buffs reach the player
            // (`buffs`, mergeBuff of the scaled list and then the raw list), and the main minion when
            // `applyMinions` or (`env.minion` and it is the caster or `applyAllies`).
            for b in &sb.buff_list {
                if !b.gate_ok || b.ty != "Buff" {
                    continue;
                }
                let sy = |ns: &[&str]| -> Vec<Sym> { ns.iter().map(|n| Sym::new(n)).collect() };
                let (buff_cfg, store): (Option<&Cfg>, &ModStore) = if b.active_skill_buff {
                    (Some(&sb.cfg), &sml)
                } else if let (true, Some(m)) = (*is_main_minion, minion) {
                    (None, m)
                } else {
                    (None, empty_parent.as_ref())
                };
                if b.apply_allies {
                    extras.conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                    let inc = store.sum(ModType::Inc, buff_cfg, &sy(&["BuffEffect", "BuffEffectOnPlayer"])) + snap.sum(ModType::Inc, None, &sy(&["BuffEffectOnSelf"]));
                    let more = store.more(buff_cfg, &sy(&["BuffEffect", "BuffEffectOnPlayer"])) * snap.more(None, &sy(&["BuffEffectOnSelf"]));
                    let src = pom_calc::perform::scale_add_list(&b.mod_list, (1.0 + inc / 100.0) * more);
                    let dest = buffs.entry(b.name.clone()).or_default();
                    pom_calc::perform::merge_buff(dest, &src);
                    pom_calc::perform::merge_buff(dest, &b.mod_list);
                }
                let env_minion_check = minion.is_some() && (*is_main_minion || b.apply_allies);
                if env_minion_check || (b.apply_minions && *is_main_minion && minion.is_some()) {
                    extras.minion_conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                    let names = if *is_main_minion { sy(&["BuffEffect", "BuffEffectOnSelf"]) } else { sy(&["BuffEffect"]) };
                    let inc = store.sum(ModType::Inc, buff_cfg, &names);
                    let more = store.more(buff_cfg, &names);
                    let mut src = pom_calc::perform::scale_add_list(&b.mod_list, (1.0 + inc / 100.0) * more);
                    let mut merged_src: Vec<Mod> = Vec::new();
                    pom_calc::perform::merge_buff(&mut merged_src, &src);
                    pom_calc::perform::merge_buff(&mut merged_src, &b.mod_list);
                    src = merged_src;
                    crate::bd_perform::cap_minion(&b.name, &src); extras.minion_mods.extend(src);
                }
            }
            // Minion half (2872-2887): `env.minion == activeSkill.minion` here, so only `auraCannotAffectSelf` gates it.
            // Every player skill's minion hands its auras to `env.minion`; `env.minion ~= activeSkill.minion` for the others.
            if let Some(mstore) = minion {
                for b in &sb.buff_list {
                    if !b.gate_ok || b.ty != "Aura" || (*is_main_minion && b.aura_cannot_affect_self) {
                        continue;
                    }
                    if minion_flag("SelfAurasCannotAffectAllies") || minion_flag("SelfAurasOnlyAffectYou") || minion_flag("SelfAuraSkillsCannotAffectAllies") || sml.flag(Some(&sb.cfg), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")]) {
                        continue;
                    }
                    let cond_name = format!("AffectedBy{}", b.name.replace(' ', ""));
                    if mstore.conditions.get(&Sym::new(&cond_name)).copied().unwrap_or(false) || extras.minion_conditions.iter().any(|c| *c == cond_name) {
                        continue;
                    }
                    let sy = |ns: &[&str]| -> Vec<Sym> { ns.iter().map(|n| Sym::new(n)).collect() };
                    let inc = sml.sum(ModType::Inc, Some(&sb.cfg), &sy(&["AuraEffect", "BuffEffect"])) + mstore.sum(ModType::Inc, Some(&sb.cfg), &sy(&["BuffEffectOnSelf", "AuraEffectOnSelf"]));
                    let more = sml.more(Some(&sb.cfg), &sy(&["AuraEffect", "BuffEffect"])) * mstore.more(Some(&sb.cfg), &sy(&["BuffEffectOnSelf", "AuraEffectOnSelf"]));
                    let mult = (1.0 + inc / 100.0) * more;
                    extras.minion_conditions.push(cond_name);
                    extras.minion_conditions.push("AffectedByAura".to_string());
                    let mut src = pom_calc::perform::scale_add_list(&b.mod_list, mult);
                    src.extend(pom_calc::perform::scale_add_list(&b.extra_aura_mods, mult));
                    if *is_spectre {
                        let source: Arc<str> = Arc::from(format!("Spectre:{} - {}", b.name, mname).as_str());
                        for m in src.iter_mut() {
                            m.source = Some(source.clone());
                        }
                    }
                    crate::bd_perform::cap_minion(&b.name, &src); extras.minion_mods.extend(src);
                }
            }
        }
    }
    // Wither (CalcPerform.lua:2756-2763): any skill that can wither raises `WitherEffectStack` (read by doActorMisc).
    for (idx, ((_, skill_mod_list), c)) in pairs.iter().zip(active_skills.iter()).enumerate() {
        // `activeSkill.minion and env.minion and env.minion.modDB:Flag(nil, "Condition:CanWither")`.
        let has_minion = !c.minion_list.is_empty() || c.is_spectre;
        let minion_can_wither = has_minion && minion.is_some_and(|m| m.flag(None, &[pom_engine::sym!("Condition:CanWither")]));
        // `modDB.conditions["SelfCast<Curse>"]` (2655) is set as the curse skills earlier in the loop (and this
        // one) are processed, so a `CanWither` gated on "if you've cast <Curse>" only holds from that skill on.
        let mut wither_cfg = Cfg::default();
        // No `disable` check (CalcPerform.lua:2308): a skill disabled before its mod list is built has no buffs, one
        // disabled later ("supported by more than one trigger", CalcActiveSkill.lua:533) still applies them.
        for ((sk, _), cs) in pairs.iter().zip(active_skills.iter()).take(idx + 1) {
            for b in &sk.buff_list {
                if b.gate_ok && (b.ty == "Curse" || b.ty == "CurseBuff") {
                    let is_aura = cs.skill_types.contains(&pom_skills::skill_type::AURA);
                    let v = !(cs.skill_types.contains(&pom_skills::skill_type::TRIGGERED) || is_aura);
                    wither_cfg.skill_cond.insert(Arc::from(format!("SelfCast{}", b.name.replace(' ', "")).as_str()), v);
                }
            }
        }
        if skill_mod_list.flag(Some(&wither_cfg), &[pom_engine::sym!("Condition:CanWither")]) || minion_can_wither {
            let mut wither_effect = player.sum(ModType::Inc, None, &[Sym::new(if has_minion { "MinionWitherEffect" } else { "WitherEffect" })]);
            if !has_minion && player.flag(None, &[pom_engine::sym!("UnholyMight")]) {
                wither_effect += player.sum(ModType::Inc, None, &[pom_engine::sym!("UnholyMightAlsoWitherEffect")]);
            }
            let effect = (6.0 * (1.0 + wither_effect / 100.0)).floor();
            extras.player_mods.push(Mod { name: pom_engine::sym!("WitherEffectStack"), ty: ModType::Max, value: Value::Num(effect), flags: 0, keyword_flags: 0, source: None, tags: (Vec::new()).into() });
        }
    }
    // Combustion (CalcPerform.lua:2765-2777): the first damaging/attacking skill supported by it debuffs enemy fire resistance.
    if enemy.flag(None, &[pom_engine::sym!("Condition:Ignited")]) {
        for ((skill, skill_mod_list), c) in pairs.iter().zip(active_skills.iter()) {
            if !(c.skill_types.contains(&pom_skills::skill_type::DAMAGE) || c.skill_types.contains(&pom_skills::skill_type::ATTACK)) {
                continue;
            }
            let cfg = Some(&skill.cfg);
            if !skill_mod_list.mods_named(pom_engine::sym!("CombustionFireResist")).next().is_some() {
                continue;
            }
            if !skill_mod_list.flag(cfg, &[pom_engine::sym!("CannotIgnite")]) {
                let value = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("CombustionFireResist")]);
                let tag = |k: &str, fields: Vec<(&str, &str)>| Tag { kind: Sym::new(k), fields: fields.into_iter().map(|(a, b)| (Sym::new(a), Value::Str(Arc::from(b)))).collect() };
                extras.enemy_mods.push(Mod {
                    name: pom_engine::sym!("FireResist"),
                    ty: ModType::Base,
                    value: Value::Num(value),
                    flags: 0,
                    keyword_flags: 0,
                    source: Some(Arc::from("Combustion")),
                    tags: (vec![tag("GlobalEffect", vec![("effectType", "Debuff"), ("effectName", "Combustion")]), tag("Condition", vec![("var", "Ignited")])]).into(),
                });
                break;
            }
        }
    }
    party_buffs(player, minion, &mut buffs, &mut extras);
    extras.curses = curse_pass(player, enemy, active_skills, &pairs, main_cfg, config_input, &mut extras);
    // `buffs[buff.name].notBuff = true` for a skill with `thisIsNotABuff` (Blood Rage; CalcPerform.lua:2330).
    let not_buff: pom_engine::fxhash::HashSet<String> = active_skills
        .iter()
        .zip(pairs.iter())
        .filter(|(c, _)| skill_data_flag(&c.skill_mod_list, "thisIsNotABuff"))
        .flat_map(|(_, (sk, _))| sk.buff_list.iter().map(|b| b.name.clone()))
        .collect();
    extras.buff_on_self = buffs.keys().filter(|k| !not_buff.contains(*k)).count() as f64;
    crate::bd_perform::cap_buffs(buffs.iter());
    (buffs.into_values().flatten().collect(), extras)
}

/// The minion halves of the `Buff` (CalcPerform.lua:2334-2341) and `Aura` (2478-2487) branches: what the player's
/// skills hand to `env.minion` (`minionBuffs`, merged per buff name).
fn minion_buff_pass(player: &Arc<ModStore>, pairs: &[(SkillBuffs, ModStore)], minion: &ModStore, main_cfg: Option<&Cfg>, weapon1: &HashMap<String, f64>, summon_undamagable: bool, extras: &mut BuffLoopExtras) {
    let mut link_applied = false;
    let mut merged: Vec<(String, Vec<Mod>)> = Vec::new();
    let buff_effect = syms(&["BuffEffect"]);
    let on_self = syms(&["BuffEffectOnSelf"]);
    let aura_names = syms(&["AuraEffect", "BuffEffect"]);
    let aura_on_self = syms(&["BuffEffectOnSelf", "AuraEffectOnSelf"]);
    let cannot = ["SelfAurasCannotAffectAllies", "SelfAurasOnlyAffectYou", "SelfAuraSkillsCannotAffectAllies"].iter().any(|f| player.flag(None, &[Sym::new(f)]));
    for (si, (skill, skill_ml)) in pairs.iter().enumerate() {
        for (bi, b) in skill.buff_list.iter().enumerate() {
            if !b.gate_ok {
                continue;
            }
            let cfg = &skill.cfg;
            match b.ty.as_str() {
                "Buff" => {
                    if skill.is_totem && !b.allow_totem_buff {
                        continue;
                    }
                    if !(b.apply_minions || b.apply_allies || skill_ml.flag(None, &[pom_engine::sym!("BuffAppliesToAllies")])) {
                        continue;
                    }
                    let (buff_cfg, mod_store) = if b.active_skill_buff { (Some(cfg), skill_ml) } else { (None, player.as_ref()) };
                    let inc = mod_store.sum(ModType::Inc, buff_cfg, &buff_effect) + minion.sum(ModType::Inc, None, &on_self);
                    let more = mod_store.more(buff_cfg, &buff_effect) * minion.more(None, &on_self);
                    extras.minion_conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                    let src = pom_calc::perform::scale_add_list(&b.mod_list, (1.0 + inc / 100.0) * more);
                    let idx = merged.iter().position(|(n, _)| *n == b.name).unwrap_or_else(|| {
                        merged.push((b.name.clone(), Vec::new()));
                        merged.len() - 1
                    });
                    pom_calc::perform::merge_buff(&mut merged[idx].1, &src);
                }
                "Warcry" => {
                    // CalcPerform.lua:2405-2437: `if env.minion` half of the Warcry branch.
                    let Some(&(warcry_power, uptime)) = extras.warcry_info.get(&(si, bi)) else { continue };
                    let warcry_name = b.name.replace(" Cry", "").replace("'s", "").replace(' ', "");
                    extras.minion_conditions.push(format!("AffectedBy{warcry_name}"));
                    let inc = skill_ml.sum(ModType::Inc, Some(cfg), &buff_effect) + minion.sum(ModType::Inc, Some(cfg), &on_self);
                    let more = skill_ml.more(Some(cfg), &buff_effect) * minion.more(Some(cfg), &on_self);
                    let mut src: Vec<Mod> = Vec::new();
                    for m in &b.mod_list {
                        let t = m.tags.first();
                        let is_warcry = t.map_or(false, |t| tag_str(t.get(pom_engine::sym!("effectType"))).as_deref() == Some("Warcry"));
                        let div = t.and_then(|t| if let Value::Num(d) = t.get(pom_engine::sym!("div")) { Some(*d) } else { None });
                        let pb = match (is_warcry, div) {
                            (true, Some(div)) if div != 0.0 => {
                                let limit = t.and_then(|t| if let Value::Num(l) = t.get(pom_engine::sym!("limit")) { Some(*l) } else { None });
                                Some((limit.map_or(warcry_power, |l| warcry_power.min(l)) / div).floor())
                            }
                            _ => None,
                        };
                        let mult = (1.0 + inc / 100.0) * more * pb.unwrap_or(1.0) * uptime;
                        let mut m2 = m.clone();
                        if let (true, Some(p), Some(t)) = (crate::bd_perform::perform_on(), pb, m2.tags.first().is_some().then(|| 0usize)) {
                            m2.tags[t].fields.push((Sym::new("warcryPowerBonus"), Value::Num(p)));
                        }
                        src.extend(pom_calc::perform::scale_add_list(std::slice::from_ref(&m2), mult));
                    }
                    if b.name == "Rallying Cry" {
                        let power_bonus = (warcry_power.min(30.0) / 5.0).floor();
                        let effect = (skill_ml.sum(ModType::Base, main_cfg, &[pom_engine::sym!("RallyingCryAllyDamageBonusPer5Power")]) * power_bonus).floor();
                        let more_mult = 1.0 + skill_ml.sum(ModType::Base, main_cfg, &[pom_engine::sym!("RallyingCryMinionDamageBonusMultiplier")]);
                        let tags = vec![Tag { kind: pom_engine::sym!("GlobalEffect"), fields: vec![(pom_engine::sym!("effectType"), Value::Str(Arc::from("Warcry"))), (pom_engine::sym!("div"), Value::Num(5.0)), (pom_engine::sym!("limit"), Value::Num(30.0))] }];
                        let mut extra: Vec<Mod> = Vec::new();
                        for dt in ["Physical", "Lightning", "Cold", "Fire", "Chaos"] {
                            for lim in ["Min", "Max"] {
                                let key = format!("{dt}{lim}");
                                if let Some(w) = weapon1.get(&key) {
                                    extra.push(Mod { name: Sym::new(&key), ty: ModType::Base, value: Value::Num(w * effect / 100.0), flags: 0, keyword_flags: pom_engine::modparser::flags::keyword_flag::Attack, source: Some(Arc::from("Rallying Cry")), tags: (tags.clone()).into() });
                                }
                            }
                        }
                        src.extend(pom_calc::perform::scale_add_list(&extra, (1.0 + inc / 100.0) * more_mult * uptime));
                    }
                    let idx = merged.iter().position(|(n, _)| *n == b.name).unwrap_or_else(|| {
                        merged.push((b.name.clone(), Vec::new()));
                        merged.len() - 1
                    });
                    pom_calc::perform::merge_buff(&mut merged[idx].1, &src);
                }
                "Link" => {
                    // CalcPerform.lua:2708-2751 (minion half; the party export is not modelled).
                    let applies = player.flag(None, &[pom_engine::sym!("Condition:CanLinkToMinions")])
                        && player.flag(None, &[pom_engine::sym!("Condition:LinkedToMinion")])
                        && !minion.flag(None, &[pom_engine::sym!("Condition:CannotBeDamaged")])
                        && !summon_undamagable;
                    if link_applied || !applies {
                        continue;
                    }
                    let mut extra_link: Vec<Mod> = Vec::new();
                    for v in player.list(Some(cfg), &[pom_engine::sym!("ExtraLinkEffect")]) {
                        let Value::Map(outer) = v else { continue };
                        let Some((_, Value::Map(inner))) = outer.iter().find(|(k, _)| k.as_str() == "mod") else { continue };
                        let m = crate::actor_misc::map_to_mod(inner);
                        if let Some(existing) = extra_link.iter_mut().find(|e| mod_params_match(e, &m)) {
                            if let (Value::Num(a), Value::Num(bv)) = (&existing.value, &m.value) {
                                existing.value = Value::Num(a + bv);
                            }
                        } else {
                            extra_link.push(m);
                        }
                    }
                    let link_names = syms(&["LinkEffect", "BuffEffect"]);
                    let self_names = syms(&["BuffEffectOnSelf", "LinkEffectOnSelf"]);
                    let inc = skill_ml.sum(ModType::Inc, Some(cfg), &link_names) + minion.sum(ModType::Inc, None, &self_names);
                    let more = skill_ml.more(Some(cfg), &link_names) * minion.more(None, &self_names);
                    let mult = (1.0 + inc / 100.0) * more;
                    extras.minion_conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                    extras.minion_conditions.push("AffectedByLink".to_string());
                    let mut src = pom_calc::perform::scale_add_list(&b.mod_list, mult);
                    src.extend(pom_calc::perform::scale_add_list(&extra_link, mult));
                    let idx = merged.iter().position(|(n, _)| *n == b.name).unwrap_or_else(|| {
                        merged.push((b.name.clone(), Vec::new()));
                        merged.len() - 1
                    });
                    pom_calc::perform::merge_buff(&mut merged[idx].1, &src);
                    link_applied = true;
                }
                "Aura" => {
                    if cannot {
                        continue;
                    }
                    let inc = skill_ml.sum(ModType::Inc, Some(cfg), &aura_names) + minion.sum(ModType::Inc, Some(cfg), &aura_on_self);
                    let more = skill_ml.more(Some(cfg), &aura_names) * minion.more(Some(cfg), &aura_on_self);
                    let mult = (1.0 + inc / 100.0) * more;
                    if b.has_party_aura && b.party_aura_effect_mult / 100.0 > mult {
                        continue;
                    }
                    extras.minion_conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                    extras.minion_conditions.push("AffectedByAura".to_string());
                    let mut src = pom_calc::perform::scale_add_list(&b.mod_list, mult);
                    src.extend(pom_calc::perform::scale_add_list(&b.extra_aura_mods, mult));
                    let idx = merged.iter().position(|(n, _)| *n == b.name).unwrap_or_else(|| {
                        merged.push((b.name.clone(), Vec::new()));
                        merged.len() - 1
                    });
                    pom_calc::perform::merge_buff(&mut merged[idx].1, &src);
                }
                _ => {}
            }
        }
    }
    // Keep the active spectres' `minionBuffs["Spectre"]` mods added before this pass.
    for (n, m) in &merged { crate::bd_perform::cap_minion(n, m); }
    extras.minion_mods.extend(merged.into_iter().flat_map(|(_, m)| m));
}

/// Player-skill `Debuff` buffs (CalcPerform.lua:2586-2652, then `enemyDB:AddList` at 3358): each gated
/// debuff's mods, scaled by `DebuffEffect` and `skillData.stackCount`, merged per buff name, go to the
/// enemy; `AffectedBy<name>` is set on both actors. Returns (enemy mods, condition names).
/// Not ported: `allyBuffs["AuraDebuff"]` from party members, `buffExports`.
pub fn player_debuffs(active_skills: &[pom_skills::assemble::ComputedSkill], player: &ModStore, enemy: &ModStore) -> (Vec<Mod>, Vec<String>) {
    let (m, c, _, _) = all_debuffs(active_skills, player, enemy, &[]);
    (m, c)
}

/// The `Debuff`/`AuraDebuff` branches for both the player's skills (2586-2652) and the skills of every player skill's
/// minion (`activeSkill.minion.activeSkillList`, 2945-2985). `minion_ctx` = (minion skills, is the main skill's minion).
/// Returns (enemy mods, enemy+player conditions, conditions set on `env.minion`, enemy-only conditions).
pub fn all_debuffs(active_skills: &[pom_skills::assemble::ComputedSkill], player: &ModStore, enemy: &ModStore, minion_ctx: &[(Vec<pom_skills::assemble::ComputedSkill>, bool)]) -> (Vec<Mod>, Vec<String>, Vec<String>, Vec<String>) {
    let snap = player_snapshot(player);
    let party = crate::party::current();
    let allies = player.flag(None, &[pom_engine::sym!("AlliesAurasCannotAffectSelf")]);
    let mut merged: std::collections::BTreeMap<String, Vec<Mod>> = std::collections::BTreeMap::new();
    let mut conds = Vec::new();
    let mut minion_conds = Vec::new();
    let mut enemy_conds: pom_engine::fxhash::HashSet<String> = pom_engine::fxhash::HashSet::default();
    let empty_parent: Arc<ModStore> = Arc::new(ModStore::new_list(None, None));
    let mut jobs: Vec<(&pom_skills::assemble::ComputedSkill, bool, bool)> = active_skills.iter().map(|c| (c, false, false)).collect();
    for (skills, is_main) in minion_ctx {
        for ms in skills {
            if ms.skill_flags.contains("disable") {
                continue;
            }
            jobs.push((ms, true, *is_main));
        }
    }
    for (c, from_minion, is_main) in jobs {
        let (sb, kept) = if from_minion { build_skill_buffs(c, &empty_parent, allies, enemy) } else { build_skill_buffs(c, &snap, allies, enemy) };
        for b in &sb.buff_list {
            // CalcPerform.lua:2478-2489: with `AurasAffectEnemies` (and no `SelfAurasAffectYouAndLinkedTarget`
            // on the skill), a player Aura's own mods (plus `ExtraAuraEffect` ones) also land on the enemy,
            // scaled by the same aura effect multiplier as the self copy, merged per buff name into `debuffs`.
            if !from_minion && b.gate_ok && b.ty == "Aura" {
                let flag = |k: &str| player.flag(None, &[Sym::new(k)]);
                // Enclosing guard (2478): not (SelfAurasCannotAffectAllies / SelfAurasOnlyAffectYou / SelfAuraSkillsCannotAffectAllies).
                let allies_ok = !(flag("SelfAurasCannotAffectAllies") || flag("SelfAurasOnlyAffectYou") || flag("SelfAuraSkillsCannotAffectAllies"));
                if allies_ok && flag("AurasAffectEnemies") && !kept.flag(Some(&sb.cfg), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")]) {
                    let names: Vec<Sym> = ["AuraEffect", "BuffEffect"].iter().map(|n| Sym::new(n)).collect();
                    let mult = (1.0 + kept.sum(ModType::Inc, Some(&sb.cfg), &names) / 100.0) * kept.more(Some(&sb.cfg), &names);
                    let mut src = pom_calc::perform::scale_add_list(&b.mod_list, mult);
                    src.extend(pom_calc::perform::scale_add_list(&b.extra_aura_mods, mult));
                    pom_calc::perform::merge_buff(merged.entry(b.name.clone()).or_default(), &src);
                }
                // CalcPerform.lua:2548-2585: an aura with no `AuraDebuff` of its own but with `ExtraAuraDebuffEffect`
                // mods in scope ("Banners also cause Enemies to take 8% increased Damage") debuffs the enemy with
                // just those mods (merged unscaled; the effect multiplier only feeds the party-export table).
                if pom_calc::setup::buff_mode().effective && !flag("SelfAurasOnlyAffectYou") && !kept.flag(Some(&sb.cfg), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")]) && !sb.buff_list.iter().any(|x| x.ty == "AuraDebuff") {
                    let list = player.list(Some(&sb.cfg), &[pom_engine::sym!("ExtraAuraDebuffEffect")]);
                    if !list.is_empty() {
                        let mut extra: Vec<Mod> = Vec::new();
                        for v in list {
                            let Value::Map(outer) = v else { continue };
                            let Some((_, Value::Map(inner))) = outer.iter().find(|(k, _)| k.as_str() == "mod") else { continue };
                            let m = crate::actor_misc::map_to_mod(inner);
                            if let Some(existing) = extra.iter_mut().find(|e| mod_params_match(e, &m)) {
                                if let (Value::Num(a), Value::Num(bv)) = (&existing.value, &m.value) {
                                    existing.value = Value::Num(a + bv);
                                }
                            } else {
                                extra.push(m);
                            }
                        }
                        pom_calc::perform::merge_buff(merged.entry(b.name.clone()).or_default(), &extra);
                    }
                }
                continue;
            }
            if !b.gate_ok || !(b.ty == "Debuff" || b.ty == "AuraDebuff") {
                continue;
            }
            // CalcPerform.lua:2587-2597: `buff.stackVar` counts `Multiplier:<stackVar>` (capped by stackLimit/stackLimitVar),
            // else `activeSkill.skillData.stackCount or 1`.
            let sd = crate::offence::skill_data_map(player, c);
            let stack_data = match sd.get("stackCount") {
                Some(pom_engine::modstore::types::ScalarValue::Num(n)) => Some(*n),
                _ => None,
            };
            let stack = if let Some(var) = &b.stack_var {
                let mut n = kept.sum(ModType::Base, Some(&sb.cfg), &[Sym::new(&format!("Multiplier:{var}"))]);
                if let Some(l) = b.stack_limit {
                    n = n.min(l);
                } else if let Some(lv) = &b.stack_limit_var {
                    n = n.min(kept.sum(ModType::Base, Some(&sb.cfg), &[Sym::new(&format!("Multiplier:{lv}"))]));
                }
                n
            } else {
                stack_data.unwrap_or(1.0)
            };
            if stack <= 0.0 {
                continue;
            }
            let cond_name = format!("AffectedBy{}", b.name.replace(' ', ""));
            let effects = [pom_engine::sym!("AuraEffect"), pom_engine::sym!("BuffEffect"), pom_engine::sym!("DebuffEffect")];
            let mut extra_aura: Vec<Mod> = Vec::new();
            let mult = if from_minion {
                // CalcPerform.lua:2945-2985 (minion skills): no ExtraAuraDebuffEffect; an AuraDebuff already on the enemy adds nothing.
                let mut mult = 1.0;
                if b.ty == "AuraDebuff" {
                    mult = 0.0;
                    if !kept.flag(None, &[pom_engine::sym!("SelfAurasOnlyAffectYou")]) || kept.flag(Some(&sb.cfg), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")]) {
                        mult = (1.0 + kept.sum(ModType::Inc, Some(&sb.cfg), &effects) / 100.0) * kept.more(Some(&sb.cfg), &effects);
                        if enemy_conds.contains(&cond_name) || enemy.conditions.get(&Sym::new(&cond_name)).copied().unwrap_or(false) {
                            mult = 0.0;
                        }
                    }
                }
                if b.ty == "Debuff" {
                    mult = (1.0 + kept.sum(ModType::Inc, Some(&sb.cfg), &[pom_engine::sym!("DebuffEffect")]) / 100.0) * kept.more(Some(&sb.cfg), &[pom_engine::sym!("DebuffEffect")]);
                }
                mult
            } else if b.ty == "AuraDebuff" {
                // ExtraAuraDebuffEffect LIST mods, summed by params (CalcPerform.lua:2606-2618).
                for v in player.list(Some(&sb.cfg), &[pom_engine::sym!("ExtraAuraDebuffEffect")]) {
                    let Value::Map(outer) = v else { continue };
                    let Some((_, Value::Map(inner))) = outer.iter().find(|(k, _)| k.as_str() == "mod") else { continue };
                    let m = crate::actor_misc::map_to_mod(inner);
                    if let Some(existing) = extra_aura.iter_mut().find(|e| mod_params_match(e, &m)) {
                        if let (Value::Num(a), Value::Num(bv)) = (&existing.value, &m.value) {
                            existing.value = Value::Num(a + bv);
                        }
                    } else {
                        extra_aura.push(m);
                    }
                }
                let mult = if player.flag(None, &[pom_engine::sym!("SelfAurasOnlyAffectYou")]) {
                    0.0
                } else {
                    (1.0 + kept.sum(ModType::Inc, Some(&sb.cfg), &effects) / 100.0) * kept.more(Some(&sb.cfg), &effects)
                };
                // CalcPerform.lua:2636: a stronger party AuraDebuff of the same name wins.
                match party.list("AuraDebuff").iter().find(|(n, _)| *n == b.name) {
                    Some((_, pb)) if pb.effect_mult / 100.0 > mult => 0.0,
                    _ => mult,
                }
            } else {
                (1.0 + kept.sum(ModType::Inc, Some(&sb.cfg), &[pom_engine::sym!("DebuffEffect")]) / 100.0) * kept.more(Some(&sb.cfg), &[pom_engine::sym!("DebuffEffect")])
            };
            if from_minion {
                enemy_conds.insert(cond_name.clone());
                if is_main {
                    minion_conds.push(cond_name.clone());
                }
            } else {
                conds.push(cond_name.clone());
            }
            let mut src = pom_calc::perform::scale_add_list(&b.mod_list, mult * stack);
            src.extend(pom_calc::perform::scale_add_list(&extra_aura, mult * stack));
            if stack_data.is_some() || b.stack_var.is_some() {
                // srcList:NewMod("Multiplier:"..buff.name.."Stack", "BASE", stackCount, buff.name) (CalcPerform.lua:2649)
                src.push(Mod { name: Sym::new(&format!("Multiplier:{}Stack", b.name)), ty: ModType::Base, value: Value::Num(stack), flags: 0, keyword_flags: 0, source: Some(Arc::from(b.name.as_str())), tags: (vec![]).into() });
            }
            pom_calc::perform::merge_buff(merged.entry(b.name.clone()).or_default(), &src);
        }
    }
    // Party member AuraDebuffs (CalcPerform.lua:3056-3080).
    for group in [party.list("AuraDebuff"), party.vaal_list("AuraDebuff")].into_iter().filter(|_| pom_calc::setup::buff_mode().effective) {
        for (name, aura) in group {
            let cname = format!("AffectedBy{}", name.replace(' ', ""));
            if !enemy_conds.contains(&cname) && !enemy.conditions.get(&Sym::new(&cname)).copied().unwrap_or(false) {
                enemy_conds.insert(cname.clone());
                conds.push(cname);
                let src = pom_calc::perform::scale_add_list(&aura.mods, aura.effect_mult / 100.0);
                pom_calc::perform::merge_buff(merged.entry(name.clone()).or_default(), &src);
            }
        }
    }
    // Combustion is applied once by `compute_buffs` (`BuffLoopExtras::enemy_mods`, CalcPerform.lua:2764-2775).
    crate::bd_perform::cap_debuffs(merged.iter());
    let out: Vec<Mod> = merged.into_values().flatten().collect();
    (out, conds, minion_conds, enemy_conds.into_iter().collect())
}

/// `data.cursePriority` (Data/Global.lua), embedded from the exported answer-key data.
fn curse_priority_table() -> &'static pom_engine::fxhash::HashMap<String, f64> {
    static T: std::sync::OnceLock<pom_engine::fxhash::HashMap<String, f64>> = std::sync::OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("../../../engine-data/data_cursePriority.json")).unwrap_or_default())
}

/// `determineCursePriority(curseName, activeSkill)` (CalcPerform.lua:587-618). `skill` is `None` for
/// the `ExtraCurse` path (`determineCursePriority(grantedEffect.name)`).
pub(crate) fn determine_curse_priority(curse_name: &str, skill: Option<&pom_skills::assemble::ComputedSkill>) -> f64 {
    let t = curse_priority_table();
    let g = |k: &str| t.get(k).copied();
    let mut source = "";
    let mut slot = String::new();
    let mut socket = 1usize;
    if let Some(s) = skill {
        source = s.group_source.as_deref().unwrap_or("");
        slot = s.group_slot.clone().unwrap_or_default();
        if let Some(k) = s.group_gem_names.iter().position(|n| n == curse_name) {
            socket = (k + 1).min(8);
        }
    }
    let base = g(curse_name).unwrap_or(0.0);
    let socket_priority = socket as f64 * g("SocketPriorityBase").unwrap_or(0.0);
    let mut slot_priority = g(&slot.replace(" Swap", "")).unwrap_or(0.0);
    let mut source_priority = 0.0;
    if skill.is_some_and(|s| s.skill_types.contains(&pom_skills::skill_type::AURA)) {
        source_priority = g("CurseFromAura").unwrap_or(0.0);
    } else if !source.is_empty() {
        source_priority = g("CurseFromEquipment").unwrap_or(0.0);
    }
    if !source.is_empty() && (Some(slot_priority) == g("Ring 2") || Some(slot_priority) == g("Ring 3")) {
        slot_priority = g("Ring 1").unwrap_or(0.0);
    }
    base + socket_priority + slot_priority + source_priority
}

/// The `Curse`/`CurseBuff` branch of the buff loop (CalcPerform.lua:2653-2707) for every active skill:
/// the player-cast `curses` list (slot assignment happens later, `pom_calc::perform_curses`) and the
/// `SelfCast<Name>` conditions it sets on the player modDB.
pub fn curse_pass(
    player: &ModStore,
    enemy: &ModStore,
    active_skills: &[pom_skills::assemble::ComputedSkill],
    pairs: &[(SkillBuffs, ModStore)],
    main_cfg: Option<&Cfg>,
    config_input: &pom_engine::fxhash::HashMap<String, f64>,
    extras: &mut BuffLoopExtras,
) -> Vec<pom_calc::perform_curses::CurseIn> {
    use pom_skills::skill_type as st;
    let mut curses = Vec::new();
    let hexproof = enemy.flag(None, &[pom_engine::sym!("Hexproof")]);
    let ignore_hexproof_all = player.flag(None, &[pom_engine::sym!("CursesIgnoreHexproof")]);
    let self_auras_only_you = player.flag(None, &[pom_engine::sym!("SelfAurasOnlyAffectYou")]);
    // No `disable` check (CalcPerform.lua:2308): see the Wither loop above.
    for ((skill, skill_mod_list), c) in pairs.iter().zip(active_skills.iter()) {
        for b in &skill.buff_list {
            if !b.gate_ok || !(b.ty == "Curse" || b.ty == "CurseBuff") {
                continue;
            }
            let cfg = &skill.cfg;
            let mark = c.skill_types.contains(&st::MARK);
            let is_aura = c.skill_types.contains(&st::AURA);
            let compact = b.name.replace(' ', "");
            extras.self_cast.push((format!("SelfCast{compact}"), !(c.skill_types.contains(&st::TRIGGERED) || is_aura)));
            if !mark && config_input.get(&format!("balanceOfTerrorSelfCast{compact}")).is_some_and(|v| *v != 0.0) {
                continue;
            }
            let ignore_hex_limit_data = skill_data_last(&c.skill_mod_list, "ignoreHexLimit").unwrap_or(false);
            let ignore_hexproof_data = skill_data_last(&c.skill_mod_list, "ignoreHexproof").unwrap_or(false);
            // Hexpass's CursesIgnoreHexproof lands on the skill's own mod list, which upstream's gate never reads.
            let ignore_hexproof_skill = pom_offence::data::pom_fixes_on() && skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("CursesIgnoreHexproof")]);
            if !((pom_calc::setup::buff_mode().effective && (!hexproof || ignore_hexproof_all || ignore_hex_limit_data || ignore_hexproof_data || ignore_hexproof_skill)) || mark) {
                continue;
            }
            let ignore_hex_limit = (player.flag(Some(cfg), &[pom_engine::sym!("CursesIgnoreHexLimit")]) || ignore_hex_limit_data) && !mark;
            let socketed_hex_limit = player.flag(Some(cfg), &[pom_engine::sym!("SocketedCursesAdditionalLimit")]);
            let ce = [pom_engine::sym!("CurseEffect")];
            let ceos = [pom_engine::sym!("CurseEffectOnSelf")];
            let mut inc = skill_mod_list.sum(ModType::Inc, Some(cfg), &ce) + enemy.sum(ModType::Inc, None, &ceos);
            if is_aura && !c.skill_types.contains(&pom_skills::skill_type::REMOTE_MINED) {
                inc += skill_mod_list.sum(ModType::Inc, Some(cfg), &[pom_engine::sym!("AuraEffect")]);
            }
            let mut more = skill_mod_list.more(Some(cfg), &ce);
            if !mark {
                more *= enemy.more(None, &ceos);
            }
            let mult = if (self_auras_only_you || skill_mod_list.flag(Some(cfg), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")])) && is_aura { 0.0 } else { (1.0 + inc / 100.0) * more };
            // Aura-only-affects-you skip (CalcPerform.lua:3230-3238).
            let mut skip = false;
            for ((s2, m2), c2) in pairs.iter().zip(active_skills.iter()) {
                if s2.buff_list.first().is_some_and(|f| f.name == b.name) && c2.skill_types.contains(&st::AURA) {
                    if self_auras_only_you || main_cfg.is_some_and(|mc| m2.flag(Some(mc), &[pom_engine::sym!("SelfAurasAffectYouAndLinkedTarget")])) {
                        skip = true;
                    }
                    break;
                }
            }
            let mut curse = pom_calc::perform_curses::CurseIn {
                name: b.name.clone(),
                from_player: true,
                priority: determine_curse_priority(&b.name, Some(c)),
                is_mark: mark,
                ignore_hex_limit,
                socketed_hex_limit,
                skip,
                mod_list: Vec::new(),
                buff_mod_list: Vec::new(),
                minion_buff_mod_list: Vec::new(),
            };
            if b.ty == "Curse" {
                curse.mod_list = pom_calc::perform::scale_add_list(&b.mod_list, mult);
            } else {
                let temp = pom_calc::perform::scale_add_list(&b.mod_list, mult);
                let cfg_o = Some(cfg);
                let names = [pom_engine::sym!("BuffEffectOnSelf")];
                let buff_inc = player.sum(ModType::Inc, cfg_o, &names);
                let buff_more = player.more(cfg_o, &names);
                curse.buff_mod_list = pom_calc::perform::scale_add_list(&temp, (1.0 + buff_inc / 100.0) * buff_more);
            }
            curses.push(curse);
        }
    }
    // `ExtraCurse` LIST mods (CalcPerform.lua:3143-3190), enemy branch only: curses granted by items / shrines (e.g. "Grants Level
    // 21 Despair Curse Aura during Flask Effect"). `applyToPlayer` curses and the minion's own `ExtraCurse` list are not ported.
    for v in player.list(None, &[pom_engine::sym!("ExtraCurse")]) {
        let Value::Map(f) = &v else { continue };
        let get = |k: &str| f.iter().find(|(n, _)| n.as_str() == k).map(|(_, v)| v);
        let (Some(Value::Str(id)), level) = (get("skillId"), get("level")) else { continue };
        if get("applyToPlayer").is_some_and(|v| v.truthy()) {
            continue;
        }
        let Some(ge) = pom_skills::data::granted_effect_by_skill_id(id) else { continue };
        if hexproof && !ignore_hexproof_all {
            continue;
        }
        let level = match level {
            Some(Value::Num(n)) => *n,
            Some(Value::Str(t)) => t.parse::<f64>().unwrap_or(1.0),
            _ => 1.0,
        };
        let gem_mods = pom_skills::modlist::merge_skill_instance_mods(ge, level, 0.0, None, &[], false);
        let curse_mods: Vec<Mod> = gem_mods.into_iter().filter(|m| m.tags.iter().any(|t| t.kind.as_str() == "GlobalEffect" && tag_str(t.get(pom_engine::sym!("effectType"))).as_deref() == Some("Curse"))).collect();
        let name = ge.name.clone().unwrap_or_default();
        let inc = enemy.sum(ModType::Inc, None, &[pom_engine::sym!("CurseEffectOnSelf")]);
        let more = enemy.more(None, &[pom_engine::sym!("CurseEffectOnSelf")]);
        curses.push(pom_calc::perform_curses::CurseIn {
            priority: determine_curse_priority(&name, None),
            name,
            from_player: true,
            is_mark: false,
            ignore_hex_limit: false,
            socketed_hex_limit: false,
            skip: false,
            mod_list: pom_calc::perform::scale_add_list(&curse_mods, (1.0 + inc / 100.0) * more),
            buff_mod_list: Vec::new(),
            minion_buff_mod_list: Vec::new(),
        });
    }
    curses
}

/// The party member's buffs reaching the player and minion (CalcPerform.lua:2997-3122 without `AuraDebuff`, which
/// `all_debuffs` handles, and 3448-3459 `extraAura`): `otherEffects`, `Aura` (+ `Vaal`), `Warcry`, `Link`.
fn party_buffs(player: &ModStore, minion: Option<&ModStore>, buffs: &mut indexmap::IndexMap<String, Vec<Mod>>, extras: &mut BuffLoopExtras) {
    let party = crate::party::current();
    if party.is_empty() {
        return;
    }
    let has_cond = |extras: &BuffLoopExtras, c: &str| extras.conditions.iter().any(|x| x == c) || player.conditions.get(&Sym::new(c)).copied().unwrap_or(false);
    let on_self = syms(&["BuffEffectOnSelf", "AuraEffectOnSelf"]);
    let comp = |n: &str| n.replace(' ', "");
    for (name, buff) in party.list("otherEffects") {
        extras.conditions.push(format!("AffectedBy{}", comp(name)));
        let inc = player.sum(ModType::Inc, None, &on_self);
        let more = player.more(None, &on_self);
        let src = pom_calc::perform::scale_add_list(&buff.mods, (buff.effect_mult + inc) / 100.0 * more);
        pom_calc::perform::merge_buff(buffs.entry(name.clone()).or_default(), &src);
        if let Some(m) = minion {
            extras.minion_conditions.push(format!("AffectedBy{}", comp(name)));
            let inc = m.sum(ModType::Inc, None, &on_self);
            let more = m.more(None, &on_self);
            let src = pom_calc::perform::scale_add_list(&buff.mods, (buff.effect_mult + inc) / 100.0 * more);
            crate::bd_perform::cap_minion(name, &src);
            extras.minion_mods.extend(src);
        }
    }
    let allies_cannot_affect_self = player.flag(None, &[pom_engine::sym!("AlliesAurasCannotAffectSelf")]);
    let aura_groups: Vec<(bool, &[(String, crate::party::PartyBuff)])> = vec![(false, party.list("Aura")), (true, party.vaal_list("Aura"))];
    for (vaal, group) in aura_groups {
        for (name, aura) in group {
            let cname = format!("AffectedBy{}", comp(name));
            if !allies_cannot_affect_self && !has_cond(extras, &cname) {
                extras.conditions.push("AffectedByAura".to_string());
                if vaal {
                    extras.conditions.push(format!("AffectedBy{}", comp(name.get(5..).unwrap_or(""))));
                }
                extras.conditions.push(cname.clone());
                let src = pom_calc::perform::scale_add_list(&aura.mods, aura.effect_mult / 100.0);
                pom_calc::perform::merge_buff(buffs.entry(name.clone()).or_default(), &src);
            }
            if minion.is_some() && !extras.minion_conditions.iter().any(|c| *c == cname) {
                extras.minion_conditions.push("AffectedByAura".to_string());
                extras.minion_conditions.push(cname);
                let src = pom_calc::perform::scale_add_list(&aura.mods, aura.effect_mult / 100.0);
                crate::bd_perform::cap_minion(name, &src);
                extras.minion_mods.extend(src);
            }
        }
    }
    for (name, warcry) in party.list("Warcry") {
        let cname = format!("AffectedBy{}", comp(name));
        let scaled = |mult_base: f64| -> Vec<Mod> {
            let mut out = Vec::new();
            for m in &warcry.mods {
                let power = match m.tags.first().map(|t| t.get(pom_engine::sym!("warcryPowerBonus"))) {
                    Some(Value::Num(n)) => *n,
                    // Party-tab tags are strings ("warcryPowerBonus=4"); Lua's arithmetic coerces them.
                    Some(Value::Str(s)) => s.trim().parse::<f64>().unwrap_or(1.0),
                    _ => 1.0,
                };
                out.extend(pom_calc::perform::scale_add_list(std::slice::from_ref(m), mult_base * power));
            }
            out
        };
        if !has_cond(extras, &cname) {
            extras.conditions.push("AffectedByWarcry".to_string());
            extras.conditions.push(cname.clone());
            pom_calc::perform::merge_buff(buffs.entry(name.clone()).or_default(), &scaled(warcry.effect_mult / 100.0));
        }
        if minion.is_some() && !extras.minion_conditions.iter().any(|c| *c == cname) {
            extras.minion_conditions.push("AffectedByWarcry".to_string());
            extras.minion_conditions.push(cname);
            let src = scaled(warcry.effect_mult / 100.0);
            crate::bd_perform::cap_minion(name, &src);
            extras.minion_mods.extend(src);
        }
    }
    for (name, link) in party.list("Link") {
        let cname = format!("AffectedBy{}", comp(name));
        if !has_cond(extras, &cname) {
            extras.conditions.push("AffectedByLink".to_string());
            extras.conditions.push(cname);
            let src = pom_calc::perform::scale_add_list(&link.mods, link.effect_mult / 100.0);
            pom_calc::perform::merge_buff(buffs.entry(name.clone()).or_default(), &src);
        }
    }
    // extraAura (CalcPerform.lua:3448-3459): added straight to modDB, scaled by BuffEffectOnSelf/AuraEffectOnSelf.
    for (_, buff) in party.list("extraAura") {
        let inc = player.sum(ModType::Inc, None, &on_self);
        let more = player.more(None, &on_self);
        // Ichimonji ("Allies' Aura Buffs do not affect you") also blocks party extraAura for the player (differs from upstream).
        if !(pom_offence::data::pom_fixes_on() && allies_cannot_affect_self) {
            extras.player_mods.extend(pom_calc::perform::scale_add_list(&buff.mods, (1.0 + inc / 100.0) * more));
        }
        if let Some(m) = minion {
            let inc = m.sum(ModType::Inc, None, &on_self);
            let more = m.more(None, &on_self);
            extras.minion_mods.extend(pom_calc::perform::scale_add_list(&buff.mods, (1.0 + inc / 100.0) * more));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn mk(name: &str, ty: ModType, value: Value) -> Mod {
        Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: 0, source: None, tags: Vec::new().into() }
    }

    /// Returns how many party extraAura Damage mods reach (player, minion).
    fn run(ichimonji: bool) -> (usize, usize) {
        let mut party = crate::party::PartyData::default();
        let buff = crate::party::PartyBuff { effect_mult: 0.0, mods: vec![mk("Damage", ModType::Inc, Value::Num(10.0))], is_mark: false };
        party.lists.insert("extraAura".to_string(), vec![("extraAura".to_string(), buff)]);
        crate::party::set_current(Arc::new(party));
        let mut player = ModStore::new_list(None, None);
        if ichimonji {
            player.add_mod(mk("AlliesAurasCannotAffectSelf", ModType::Flag, Value::Bool(true)));
        }
        let minion = ModStore::new_list(None, None);
        let mut extras = BuffLoopExtras { buff_on_self: 0.0, player_mods: Vec::new(), conditions: Vec::new(), self_cast: Vec::new(), curses: Vec::new(), minion_curses: Vec::new(), minion_curse_limit: 1.0, minion_mods: Vec::new(), minion_conditions: Vec::new(), enemy_mods: Vec::new(), warcry_info: HashMap::default(), exports: None };
        party_buffs(&player, Some(&minion), &mut indexmap::IndexMap::new(), &mut extras);
        let n = |v: &[Mod]| v.iter().filter(|m| m.name.as_str() == "Damage").count();
        (n(&extras.player_mods), n(&extras.minion_mods))
    }

    /// Ichimonji ("Allies' Aura Buffs do not affect you") also blocks imported party extraAura mods for the player only.
    #[test]
    fn ichimonji_blocks_party_extra_aura() {
        assert_eq!(run(false), (1, 1));
        assert_eq!(run(true), (0, 1));
    }
}
