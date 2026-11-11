//! The minion actor (`env.minion`, `output.Minion`): creation (CalcActiveSkill.lua:668-790),
//! `initMinionModDB` (CalcPerform.lua:1154-1244, via `pom_calc::perform_minions`), the minion half
//! of `doActorAttribsConditions`/`doActorLifeMana` (CalcPerform.lua:1946-1964) and the minion's
//! defence pass (CalcPerform.lua:3491-3495, 3802-3806).

use crate::Env;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modstore::types::{Actor, ScalarValue};
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_skills::assemble::ComputedSkill;
use pom_engine::fxhash::HashMap;

pub struct MinionActor {
    pub ty: String,
    pub level: f64,
    pub is_spectre: bool,
    pub store: ModStore,
    pub output: HashMap<String, f64>,
    /// `minion.weaponData1.type` ("None" unless the minion type names a `weaponType1`).
    pub weapon1_type: String,
    /// `minion.activeSkillList` and the chosen `minion.mainSkill` index.
    pub skills: Vec<ComputedSkill>,
    pub main_index: usize,
    /// `minion.weaponData1/2` when they come from an item (an item's `weaponData` list, hand 1 / hand 2).
    pub weapon1_items: Option<Vec<serde_json::Value>>,
    pub weapon2_items: Option<Vec<serde_json::Value>>,
    /// `minion.itemList`: item-list key -> item id, and each item's type.
    pub item_list: HashMap<String, i64>,
    pub item_armour: HashMap<String, pom_defence::snapshot::ArmourData>,
    /// String and list outputs the minion's offence pass produced (`output.ForkCountString`, warning lists).
    pub output_str: HashMap<String, String>,
    pub output_lists: HashMap<String, Vec<String>>,
}

/// One `<ItemSet>` of the build: (id, useSecondWeaponSet, slot name -> item id).
fn item_sets(xml_text: &str) -> Vec<(i64, bool, HashMap<String, i64>)> {
    pom_skills::xmlskills::memo_sections("item_sets", xml_text, &["Items"], || item_sets_inner(xml_text))
}

fn item_sets_inner(xml_text: &str) -> Vec<(i64, bool, HashMap<String, i64>)> {
    let Some(Ok(doc)) = pom_skills::xmlskills::xml_section(xml_text, "Items").map(roxmltree::Document::parse) else { return Vec::new() };
    let items = doc.root_element();
    items
        .children()
        .filter(|n| n.has_tag_name("ItemSet"))
        .map(|set| {
            let id = set.attribute("id").and_then(|v| v.parse().ok()).unwrap_or(1);
            let second = set.attribute("useSecondWeaponSet") == Some("true");
            let slots = set
                .children()
                .filter(|n| n.has_tag_name("Slot"))
                .filter_map(|n| Some((n.attribute("name")?.to_string(), n.attribute("itemId")?.parse::<i64>().ok()?)))
                .filter(|(_, id)| *id != 0)
                .collect();
            (id, second, slots)
        })
        .collect()
}

/// `minion.uses` / `minion.itemSet` resolution (CalcPerform.lua:1222-1240, CalcActiveSkill.lua:745-768): the items a
/// minion borrows, their slot mod lists, and the weapon data taken from them. Returns the mod lists to add.
fn resolve_gear(env: &Env, main: &ComputedSkill, actor: &mut MinionActor) -> Vec<Vec<Mod>> {
    let mut out = Vec::new();
    let uses = &main.minion_uses;
    if uses.is_empty() && !main.minion_has_item_set {
        return out;
    }
    let sets = item_sets(&env.xml_text);
    let set = if main.minion_has_item_set {
        let want = main.src_skill_minion_item_set;
        sets.iter().find(|(id, _, _)| Some(*id) == want).or_else(|| sets.first())
    } else {
        None
    };
    let mut ordered: Vec<&String> = uses.iter().collect();
    ordered.sort();
    for slot in ordered {
        let is_weapon = slot.starts_with("Weapon");
        let (key, item_id) = match set {
            Some((_, second, slots)) => {
                let key = if is_weapon && *second { format!("{slot} Swap") } else { slot.clone() };
                let id = slots.get(&key).copied();
                (key, id)
            }
            None => (slot.clone(), env.slot_items.get(slot).copied()),
        };
        let Some(item) = item_id.and_then(|id| env.items.get(&id)) else { continue };
        actor.item_list.insert(key.clone(), item_id.unwrap());
        out.push(crate::item_mods_for_slot(item, slot).to_vec());
        if let Some(ad) = crate::armour_data_for(item) {
            actor.item_armour.insert(key, ad);
        }
        match slot.as_str() {
            "Weapon 1" => actor.weapon1_items = item.weapon_data.clone(),
            "Weapon 2" => actor.weapon2_items = item.weapon_data.clone(),
            _ => {}
        }
    }
    out
}

fn s(n: &str) -> Sym {
    Sym::new(n)
}

/// `env.build.spectreList` (Build.lua:987-993): the `<Spectre id=>` children of `<Build>` that name a known minion.
pub(crate) fn spectre_list(xml_text: &str) -> Vec<String> {
    pom_skills::xmlskills::memo_sections("spectre_list", xml_text, &["Build"], || spectre_list_inner(xml_text))
}

fn spectre_list_inner(xml_text: &str) -> Vec<String> {
    let Some(Ok(doc)) = pom_skills::xmlskills::xml_section(xml_text, "Build").map(roxmltree::Document::parse) else { return Vec::new() };
    let build = doc.root_element();
    build
        .children()
        .filter(|n| n.has_tag_name("Spectre"))
        .filter_map(|n| n.attribute("id"))
        .filter(|id| pom_calc::data::minion_raw(id).is_some())
        .map(|id| id.to_string())
        .collect()
}

fn sd_num(map: &HashMap<String, ScalarValue>, k: &str) -> Option<f64> {
    match map.get(k) {
        Some(ScalarValue::Num(n)) => Some(*n),
        _ => None,
    }
}
fn sd_truthy(map: &HashMap<String, ScalarValue>, k: &str) -> bool {
    map.get(k).is_some_and(|v| v.truthy())
}

fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `activeSkill.minionList` (CalcActiveSkill.lua:668-691): a spectre skill's list is the build's spectre list
/// followed by the supports' `addMinionList`.
pub fn full_minion_list(env: &Env, c: &ComputedSkill) -> Vec<String> {
    let mut list = c.minion_list.clone();
    if c.is_spectre {
        let mut l = spectre_list(&env.xml_text);
        l.extend(list);
        list = l;
    }
    list
}

/// CalcActiveSkill.lua:692-702: the chosen minion type and its level, for the main skill.
pub fn select(env: &Env, main: &ComputedSkill) -> Option<(String, f64, bool)> {
    // CalcActiveSkill.lua:510-516: a disabled skill (no usable weapon, a missing shield) returns before `minionList` and
    // `activeSkill.minion` exist, so `env.minion` is nil for it (CalcPerform.lua:1316).
    if main.skill_flags.contains("disable") {
        return None;
    }
    let mut list = main.minion_list.clone();
    if main.is_spectre {
        let mut l = spectre_list(&env.xml_text);
        l.extend(list);
        list = l;
    }
    if list.is_empty() {
        return None;
    }
    let idx = main.src_skill_minion.as_ref().and_then(|t| list.iter().position(|x| x == t)).unwrap_or(0);
    let ty = list[idx].clone();
    let sd = crate::offence::skill_data_map(&env.player, main);
    let support_level = main.minion_support_level.iter().find(|(t, _)| *t == ty).map(|(_, l)| *l);
    let level = if sd_truthy(&sd, "minionLevelIsEnemyLevel") {
        env.enemy_level
    } else if let Some(cap) = sd.get("minionLevelIsPlayerLevel").filter(|v| v.truthy()).map(|v| if let ScalarValue::Num(n) = v { *n } else { f64::INFINITY }) {
        env.character_level.min(cap)
    } else {
        support_level.or(sd_num(&sd, "minionLevel")).unwrap_or(main.granted_level_requirement)
    };
    Some((ty, level.clamp(1.0, 100.0), main.is_spectre))
}

/// `initMinionModDB` (CalcPerform.lua:1154-1244) for the main skill's minion.
pub fn create(env: &Env, main: &ComputedSkill) -> Option<MinionActor> {
    let (ty, level, is_spectre) = select(env, main)?;
    let md = pom_calc::data::minion_data(&ty);
    if md.hostile {
        return None;
    }
    let raw = pom_calc::data::minion_raw(&ty)?;
    let cc = pom_calc::data::CharacterConstants::shared();
    let sd = crate::offence::skill_data_map(&env.player, main);
    let p = &env.player;
    let cfg = crate::buffs::skill_cfg(main);
    // `skillCfg.skillGem = activeEffect.gemData` (CalcActiveSkill.lua:469): "Socketed Travel Skills deal 80% more Damage"
    // (`SocketedIn` + `keyword`) reads the gem's tags, so the ExtraSkillMod lookup needs it.
    let mut extra_cfg = cfg.clone();
    if let Some(gd) = pom_skills::data::gem_for_skill(&main.granted_effect_id).and_then(|key| pom_skills::data::sorted_gems().iter().find(|(k, _)| *k == key).map(|(_, g)| *g)) {
        extra_cfg.skill_gem = Some(pom_engine::modstore::types::GemInfo {
            name: std::sync::Arc::from(gd.name.clone().unwrap_or_default().to_lowercase().as_str()),
            tags: gd.tags.iter().map(|(k, v)| (std::sync::Arc::from(k.as_str()), *v)).collect(),
        });
    }
    let (_, extra_mods) = crate::extra_skill::stats_and_mods(&skill_store(env, main), &extra_cfg);
    let reads = pom_calc::perform_minions::PlayerReads {
        minion_accuracy_equals_accuracy: p.flag(None, &[pom_engine::sym!("MinionAccuracyEqualsAccuracy")]),
        accuracy_val: crate::calc_val(p, "Accuracy"),
        dex_val: crate::calc_val(p, "Dex"),
        dex_acc_bonus_override: p.override_(None, &[pom_engine::sym!("DexAccBonusOverride")]).and_then(|v| v.num()),
        strength_added_to_minions: p.sum(ModType::Base, None, &[pom_engine::sym!("StrengthAddedToMinions")]),
        str_val: crate::calc_val(p, "Str"),
        blink_and_mirror_use_gloves: p.flag(None, &[pom_engine::sym!("BlinkAndMirrorUseGloves")]),
        widow_hail_multiplier: p.sum(ModType::Base, None, &[pom_engine::sym!("WidowHailMultiplier")]),
    };
    let weapon1_type = raw.get("weaponType1").and_then(|v| v.as_str()).unwrap_or("None").to_string();
    let mut actor = MinionActor { ty: ty.clone(), level, is_spectre, store: ModStore::new_list(None, None), output: HashMap::default(), weapon1_type, skills: Vec::new(), main_index: 0, weapon1_items: None, weapon2_items: None, item_list: HashMap::default(), item_armour: HashMap::default(), output_str: HashMap::default(), output_lists: HashMap::default() };
    let borrowed = resolve_gear(env, main, &mut actor);
    // `minion.weaponData1.type` (CalcActiveSkill.lua:735-768): the minion's skills are typed by the weapon it actually holds.
    {
        let player_w1_type = env.weapon_data.get("Weapon 1").and_then(|w| w.first()).and_then(|w| w.get("type")).and_then(|t| t.as_str()).unwrap_or("None").to_string();
        let player_bow = player_w1_type == "Bow";
        let mut ty1 = actor.weapon1_type.clone();
        if (sd_truthy(&sd, "minionUseBowAndQuiver") && player_bow) || sd_truthy(&sd, "minionUseMainHandWeapon") {
            ty1 = player_w1_type.clone();
        }
        if main.minion_uses.iter().any(|u| u == "Weapon 1") {
            if main.minion_has_item_set {
                if let Some(t) = actor.weapon1_items.as_ref().and_then(|w| w.first()).and_then(|w| w.get("type")).and_then(|t| t.as_str()) {
                    ty1 = t.to_string();
                }
            } else {
                ty1 = player_w1_type;
            }
        }
        actor.weapon1_type = ty1;
    }
    // Bow + quiver (+ gloves) borrowed from the player (CalcPerform.lua:1203-1213).
    let player_item = |slot: &str| env.slot_items.get(slot).and_then(|id| env.items.get(id));
    let w1_item = player_item("Weapon 1");
    let weapon1_is_bow = env.weapon_data.get("Weapon 1").and_then(|w| w.first()).and_then(|w| w.get("type")).and_then(|t| t.as_str()) == Some("Bow");
    let quiver = player_item("Weapon 2").filter(|i| i.item_type.as_deref() == Some("Quiver"));
    let input = pom_calc::perform_minions::MinionInput {
        minion_type: ty.clone(),
        level,
        is_spectre,
        enemy_level: env.enemy_level,
        extra_skill_mod_list: extra_mods,
        aegis_mod_list: if env.aegis_mod_list.is_empty() { None } else { Some(env.aegis_mod_list.clone()) },
        iron_mass_mod_list: None,
        minion_use_bow_and_quiver: sd_truthy(&sd, "minionUseBowAndQuiver"),
        minion_use_main_hand_weapon: sd_truthy(&sd, "minionUseMainHandWeapon"),
        weapon1_is_bow,
        weapon1_slot_mod_list: w1_item.map(|i| crate::item_mods_for_slot(i, "Weapon 1").to_vec()).unwrap_or_default(),
        weapon2_is_quiver: quiver.is_some(),
        weapon2_mod_list: quiver.and_then(|i| i.mod_list.clone()).unwrap_or_default(),
        gloves_mod_list: player_item("Gloves").and_then(|i| i.mod_list.clone()),
        borrowed_slot_mod_lists: borrowed,
    };
    actor.store = pom_calc::perform_minions::init_minion_mod_db(&reads, &cc, &input);
    // `minion.itemList["Weapon 3"] = env.aegisItem` (CalcPerform.lua:1202): the player's shield, worn by the minion.
    if !env.aegis_mod_list.is_empty() {
        if let Some(id) = env.slot_items.get("Weapon 2") {
            actor.item_list.insert("Weapon 3".to_string(), *id);
        }
        if let Some(ad) = env.item_armour.get("Weapon 2") {
            actor.item_armour.insert("Weapon 3".to_string(), ad.clone());
        }
    }
    create_skills(env, &mut actor, main);
    Some(actor)
}

/// The main skill's `skillModList` as a standalone store: the skill's own mods with the player's conditions/multipliers.
pub fn skill_store(env: &Env, main: &ComputedSkill) -> ModStore {
    // The player's actor may predate `refresh_actors` here: wire the enemy/player links so `ActorCondition`
    // (`actor = "enemy"`) tags on `MinionModifier` mods resolve.
    let snap = crate::buffs::player_snapshot(&env.player);
    let actor = env.player.actor.as_ref().map(|a| {
        let na = std::sync::Arc::new((**a).clone());
        {
            let mut m = na.related.borrow_mut();
            if !m.contains_key("enemy") {
                m.insert("enemy".into(), crate::buffs::player_snapshot(&env.enemy));
            }
            if !m.contains_key("player") {
                m.insert("player".into(), snap.clone());
            }
        }
        pom_engine::modstore::types::register_links(&na);
        na
    });
    let mut st = ModStore::new_list(Some(snap), actor);
    for m in &main.skill_mod_list {
        st.add_mod(m.clone());
    }
    st.conditions = env.player.conditions.clone();
    st.multipliers = env.player.multipliers.clone();
    st
}

/// `addMinionModifiers(modList, skillCfg, minion)` (CalcPerform.lua:1247-1253) over the main skill's `skillModList`
/// (its own mods first, then the player's modDB as its parent).
fn add_minion_modifiers(env: &Env, main: &ComputedSkill, minion: &mut MinionActor) {
    let cfg = crate::buffs::skill_cfg(main);
    let names = [pom_engine::sym!("MinionModifier")];
    let values = skill_store(env, main).list(Some(&cfg), &names);
    for v in values {
        let Value::Map(fields) = &v else { continue };
        let ty_ok = match fields.iter().find(|(k, _)| k.as_str() == "type") {
            Some((_, Value::Str(t))) => t.as_ref() == minion.ty,
            _ => true,
        };
        if !ty_ok {
            continue;
        }
        if let Some((_, Value::Map(inner))) = fields.iter().find(|(k, _)| k.as_str() == "mod") {
            minion.store.add_mod(crate::extra_skill::map_to_mod(inner));
        }
    }
}

/// Cross-actor links for the minion's own store (`parent` = the player, `enemy`).
pub fn refresh_actor(env: &Env, minion: &mut MinionActor) {
    let output: HashMap<Sym, f64> = minion.output.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
    let old = minion.store.actor.clone().map(|a| (*a).clone()).unwrap_or_default();
    // `actor.minionData.monsterTags` (ModStore.lua:925-950, MonsterTag tags).
    let minion_monster_tags: Option<Vec<std::sync::Arc<str>>> = pom_calc::data::minion_raw(&minion.ty).and_then(|r| r.get("monsterTags")).and_then(|t| t.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(std::sync::Arc::from)).collect());
    let actor = std::sync::Arc::new(Actor { output, minion_monster_tags, ..old });
    minion.store.actor = Some(actor.clone());
    let p = crate::buffs::player_snapshot(&env.player);
    let e = crate::buffs::player_snapshot(&env.enemy);
    let mut m = actor.related.borrow_mut();
    m.clear();
    m.insert("enemy".into(), e);
    m.insert("parent".into(), p.clone());
    m.insert("player".into(), p);
    drop(m);
    pom_engine::modstore::types::register_links(&actor);
}

/// The weapon-derived and armour conditions of `doActorAttribsConditions` (CalcPerform.lua:146-236).
fn weapon_conditions(env: &Env, minion: &mut MinionActor, main: &ComputedSkill) {
    let (w1, w2, _) = weapons(env, minion, main);
    let ty_of = |w: &Option<Vec<serde_json::Value>>, hand: usize| w.as_ref().and_then(|l| l.get(hand)).and_then(|v| v.get("type")).and_then(|t| t.as_str()).map(|t| t.to_string());
    let t1 = ty_of(&w1, 0).unwrap_or_else(|| minion.weapon1_type.clone());
    let t2 = ty_of(&w2, 1);
    let item_type = |key: &str| minion.item_list.get(key).and_then(|id| env.items.get(id)).and_then(|i| i.item_type.clone());
    let has_w2 = minion.item_list.contains_key("Weapon 2");
    let shield = item_type("Weapon 2").as_deref() == Some("Shield") || !env.aegis_mod_list.is_empty();
    let armour: Vec<&str> = ["Helmet", "Body Armour", "Gloves", "Boots"].into_iter().filter(|k| minion.item_list.contains_key(*k)).collect();
    let has_gloves = minion.item_list.contains_key("Gloves");
    let c = &mut minion.store.conditions;
    if shield {
        c.insert(pom_engine::sym!("UsingShield"), true);
    } else if !has_w2 {
        c.insert(pom_engine::sym!("OffHandIsEmpty"), true);
    }
    let mut add = |c: &mut HashMap<Sym, bool>, ty: &str| {
        if let Some(info) = pom_skills::data::weapon_type_info(ty) {
            c.insert(s(&format!("Using{}", info.flag)), true);
            if info.melee {
                c.insert(pom_engine::sym!("UsingMeleeWeapon"), true);
            }
            c.insert(s(if info.one_hand { "UsingOneHandedWeapon" } else { "UsingTwoHandedWeapon" }), true);
        }
    };
    if t1 == "None" {
        c.insert(pom_engine::sym!("Unarmed"), true);
        if !has_w2 && !has_gloves {
            c.insert(pom_engine::sym!("Unencumbered"), true);
        }
    } else {
        add(c, &t1);
    }
    for a in armour {
        c.insert(s(&format!("Using{a}")), true);
    }
    if let Some(t2) = &t2 {
        add(c, t2);
        {
            c.insert(pom_engine::sym!("DualWielding"), true);
            if t1 == "Claw" && t2 == "Claw" {
                c.insert(pom_engine::sym!("DualWieldingClaws"), true);
            }
            if t1 == "Dagger" && t2 == "Dagger" {
                c.insert(pom_engine::sym!("DualWieldingDaggers"), true);
            }
            if t1 != *t2 {
                if let (Some(i1), Some(i2)) = (pom_skills::data::weapon_type_info(&t1), pom_skills::data::weapon_type_info(t2)) {
                    if i1.one_hand && i2.one_hand {
                        c.insert(pom_engine::sym!("WieldingDifferentWeaponTypes"), true);
                    }
                }
            }
        }
    }
}

/// CalcPerform.lua:1946-1964 then `doActorAttribsConditions(env, env.minion)`'s attribute/pool tail.
pub fn attribs_and_pools(env: &mut Env, minion: &mut MinionActor, main: &ComputedSkill) {
    add_minion_modifiers(env, main, minion);
    let keystones = minion.store.list(None, &[pom_engine::sym!("Keystone")]);
    for k in keystones {
        if let Value::Str(name) = k {
            if let Some(mods) = env.keystone_map.get(name.as_ref()) {
                for m in mods.clone() {
                    minion.store.add_mod(m);
                }
            }
        }
    }
    weapon_conditions(env, minion, main);
    if pom_calc::setup::buff_mode().combat {
        if let Some(ms) = minion.skills.get(minion.main_index) {
            let triggered = matches!(crate::offence::skill_data_map(&minion.store, ms).get("triggered"), Some(v) if !matches!(v, ScalarValue::Bool(false)));
            for c in crate::attrib_conds::combat_conditions(ms, triggered) {
                minion.store.conditions.insert(s(&c), true);
            }
        }
        crate::actor_misc::shrine_buffs(&mut minion.store);
    }
    // `env.mode_effective` exposure conditions read `env.player.mainSkill.skillModList` (CalcPerform.lua:397-407).
    if pom_calc::setup::buff_mode().effective {
        let cfg = crate::buffs::skill_cfg(main);
        let st = skill_store(env, main);
        for el in ["Fire", "Cold", "Lightning"] {
            let n = [s(&format!("{el}ExposureChance"))];
            let from_skill = st.sum(ModType::Base, Some(&cfg), &n);
            if from_skill > 0.0 || minion.store.sum(ModType::Base, None, &n) > 0.0 {
                minion.store.conditions.insert(s(&format!("CanApply{el}Exposure")), true);
            }
        }
    }
    let attrs = pom_calc::perform::compute_attributes(&minion.store);
    let out = &mut minion.output;
    out.insert("Str".into(), attrs.str_);
    out.insert("Dex".into(), attrs.dex);
    out.insert("Int".into(), attrs.int_);
    out.insert("LowestAttribute".into(), attrs.str_.min(attrs.dex).min(attrs.int_));
    out.insert("TotalAttr".into(), attrs.str_ + attrs.dex + attrs.int_);
    let (sv, dv, iv) = (attrs.str_, attrs.dex, attrs.int_);
    let mut sorted = [sv, dv, iv];
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for (name, v) in [
        ("TwoHighestAttributesEqual", sorted[1] == sorted[2]),
        ("DexHigherThanInt", dv > iv),
        ("StrHigherThanInt", sv > iv),
        ("IntHigherThanDex", iv > dv),
        ("StrHigherThanDex", sv > dv),
        ("IntHigherThanStr", iv > sv),
        ("DexHigherThanStr", dv > sv),
        ("StrHighestAttribute", sv >= dv && sv >= iv),
        ("IntHighestAttribute", iv >= sv && iv >= dv),
        ("DexHighestAttribute", dv >= sv && dv >= iv),
        ("IntSingleHighestAttribute", iv > sv && iv > dv),
        ("DexSingleHighestAttribute", dv > sv && dv > iv),
    ] {
        minion.store.conditions.insert(s(name), v);
    }
    pom_offence::bd::select_actor(1);
    crate::bd_perform::attribute_tables(&minion.store, attrs.str_, attrs.dex, attrs.int_);
    pom_offence::bd::select_actor(0);
    out.insert("Devotion".into(), minion.store.sum(ModType::Base, None, &[pom_engine::sym!("Devotion")]));
    for m in pom_calc::perform::attribute_bonus_mods(&minion.store, &attrs) {
        minion.store.add_mod(m);
    }
    minion_life_mana(env, minion, false);
}

/// `doActorLifeMana(actor)` (CalcPerform.lua:60-135).
fn minion_life_mana(env: &Env, minion: &mut MinionActor, tables: bool) {
    refresh_actor(env, minion);
    let (life, mana) = pom_calc::perform_reserve::life_mana_pool(&minion.store);
    let out = &mut minion.output;
    out.insert("Life".into(), life);
    out.insert("Mana".into(), mana);
    // Upstream writes the minion's Life and Mana tables only in `calcs.defence` ("Formless Inferno", CalcDefence.lua:673-676).
    if tables {
        pom_offence::bd::select_actor(1);
        crate::bd_perform::life_mana_tables(&minion.store, life, mana);
        pom_offence::bd::select_actor(0);
    }
    if minion.store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) {
        minion.store.conditions.insert(pom_engine::sym!("FullLife"), true);
    }
    out.insert("ChaosInoculation".into(), if minion.store.flag(None, &[pom_engine::sym!("ChaosInoculation")]) { 1.0 } else { 0.0 });
    let low = minion.store.sum(ModType::Base, None, &[pom_engine::sym!("LowLifePercentage")]);
    out.insert("LowLifePercentage".into(), 100.0 * if low > 0.0 { low } else { env.low_pool_threshold });
    let full = minion.store.sum(ModType::Base, None, &[pom_engine::sym!("FullLifePercentage")]);
    out.insert("FullLifePercentage".into(), 100.0 * if full > 0.0 { full } else { 1.0 });
    out.insert("LowestOfMaximumLifeAndMaximumMana".into(), life.min(mana));
    let _ = round;
}

/// `defenceForConditionals`, `doActorCharges`, `doActorMisc` for the minion (CalcPerform.lua:3484-3495).
pub fn misc_pass(env: &mut Env, minion: &mut MinionActor) {
    refresh_actor(env, minion);
    pom_defence::conditionals::defence_for_conditionals(&minion.store, &minion.item_armour, &mut minion.output);
    let charges = pom_calc::perform_charges::compute_charges(&minion.store, false);
    pom_calc::perform_charges::apply_charge_multipliers(&mut minion.store, &charges);
    for (k, v) in pom_calc::perform_charges::output_fields(&charges) {
        minion.output.insert(k.to_string(), v);
    }
    let allied_fortify = if minion.store.flag(None, &[pom_engine::sym!("YourFortifyEqualToParent")]) { env.output.get("FortificationStacks").copied().unwrap_or(0.0) } else { 0.0 };
    crate::actor_misc::do_actor_misc(&mut minion.store, &mut env.enemy, &mut minion.output, &env.active_flask_mods, &env.config_input, None, allied_fortify); // Onslaught reads the player's `env.flasks` (CalcPerform.lua:688)
    // "Check for extra curses" (CalcPerform.lua:3144-3148) runs for `minionCurses` too: Consecrated Ground halves the
    // minion's curse effect on self, in combat mode.
    let combat = pom_calc::setup::buff_mode().combat;
    if combat && minion.store.flag(None, &[pom_engine::sym!("Condition:OnConsecratedGround")]) {
        let effect = 1.0 + minion.store.sum(pom_engine::modifier::ModType::Inc, None, &[pom_engine::sym!("ConsecratedGroundEffect")]) / 100.0;
        minion.store.add_mod(pom_engine::modifier::Mod { name: pom_engine::sym!("CurseEffectOnSelf"), ty: pom_engine::modifier::ModType::Inc, value: pom_engine::value::Value::Num(-50.0 * effect), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Consecrated Ground")), tags: (vec![]).into() });
    }
}

/// `calcs.defence` and `calcs.buildDefenceEstimations` for the minion (CalcPerform.lua:3803-3806).
pub fn defence_pass(env: &mut Env, minion: &mut MinionActor) {
    refresh_actor(env, minion);
    let denv = pom_defence::defence::DefenceEnv {
        enemy_level: env.enemy_level,
        mode_effective: pom_calc::setup::buff_mode().effective,
        necromantic_aegis: false,
        config_input: env.config_input.clone(),
        config_flags: env.config_flags.clone(),
        is_minion: true,
        party_output: crate::party::current().member_output.clone(),
        resist_done: true,
    };
    {
        let inc = |n: &str| minion.store.sum(ModType::Inc, None, &[s(n)]);
        let min_speed = minion.store.max(None, &[pom_engine::sym!("MinimumActionSpeed")]).unwrap_or(0.0);
        let max_reduction = minion.store.max(None, &[pom_engine::sym!("MaximumActionSpeedReduction")]);
        let speed = pom_offence::tools::action_speed_mod(inc("TemporalChainsActionSpeed"), inc("ActionSpeed"), env.temporal_chains_cap, min_speed, max_reduction);
        minion.output.insert("ActionSpeedMod".to_string(), speed);
    }
    // `calcs.resistances(actor)` runs before the Formless Inferno recompute (CalcDefence.lua:663-674), so life/mana
    // that scale with the minion's resist over cap see it; `defence` below skips its own call (`resist_done`).
    let bd_was = pom_offence::bd::set_active(crate::defence_bd_active());
    pom_offence::bd::select_actor(1);
    pom_defence::resist::resistances(&mut minion.store, &mut minion.output);
    pom_offence::bd::set_active(bd_was);
    pom_offence::bd::select_actor(0);
    // `doActorLifeMana(actor)` + `doActorLifeManaReservation(actor)` (CalcDefence.lua:673-676; no reservations on a minion).
    minion_life_mana(env, minion, true);
    for pool in ["Life", "Mana"] {
        let max = minion.output.get(pool).copied().unwrap_or(0.0);
        if max > 0.0 {
            let low = minion.store.sum(ModType::Base, None, &[s(&format!("Low{pool}Percentage"))]);
            let o = &mut minion.output;
            o.insert(format!("{pool}Reserved"), 0.0f64.min(max));
            o.insert(format!("{pool}ReservedPercent"), 0.0);
            o.insert(format!("{pool}Unreserved"), max);
            o.insert(format!("{pool}UnreservedPercent"), 100.0);
            o.insert(format!("{pool}UncancellableReservation"), 0.0);
            o.insert(format!("{pool}CancellableReservation"), 100.0);
            if 1.0 <= if low > 0.0 { low } else { env.low_pool_threshold } {
                minion.store.conditions.insert(s(&format!("Low{pool}")), true);
            }
        }
    }
    let bd_was = pom_offence::bd::set_active(crate::defence_bd_active());
    pom_offence::bd::select_actor(1);
    let out = pom_defence::defence::defence(&mut minion.store, &env.enemy, &minion.item_armour, &denv, &minion.output);
    pom_offence::bd::set_active(bd_was);
    pom_offence::bd::select_actor(0);
    minion.output = out;
    if let (Some(&ms), Some(&asm)) = (minion.output.get("MovementSpeedMod"), minion.output.get("ActionSpeedMod")) {
        minion.output.insert("EffectiveMovementSpeedMod".to_string(), ms * asm);
    }
    refresh_actor(env, minion);
    let specific = pom_defence::pools::DMG_TYPES.iter().any(|dt| minion.output.get(&format!("Avoid{dt}DamageChance")).copied().unwrap_or(0.0) > 0.0);
    let eenv = pom_defence::estimations::EstimationsEnv {
        enemy_level: env.enemy_level,
        config_input: env.config_input.clone(),
        config_flags: env.config_flags.clone(),
        config_str: env.config_str.clone(),
        config_placeholder: env.config_placeholder.clone(),
        config_placeholder_str: env.config_placeholder_str.clone(),
        // `env.modDB` (CalcDefence.lua:2181) is the player's modDB, not the minion's.
        pre_output_bool: [("specificTypeAvoidance".to_string(), specific), ("envEnergyShieldProtectsMana".to_string(), env.player.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]))].into_iter().collect(),
    };
    let bd_was = pom_offence::bd::set_active(crate::defence_bd_active());
    pom_offence::bd::select_actor(1);
    pom_defence::estimations::build_defence_estimations(&mut minion.output, &minion.store, &env.enemy, &eenv);
    pom_offence::bd::set_active(bd_was);
    pom_offence::bd::select_actor(0);
}

/// Writes the minion's output under `Minion` in the dump.
pub fn export(env: &mut Env, minion: &MinionActor) {
    let mut o = serde_json::Map::new();
    let mut keys: Vec<&String> = minion.output.keys().collect();
    keys.sort();
    for k in keys {
        let v = minion.output[k];
        let jv = if crate::is_bool_output_key(k.as_str()) {
            serde_json::json!(v != 0.0)
        } else if v.is_nan() {
            serde_json::json!("NaN")
        } else if v.is_infinite() {
            serde_json::json!(if v > 0.0 { "Inf" } else { "-Inf" })
        } else {
            serde_json::json!(v)
        };
        if let Some((hand, stat)) = k.split_once('.') {
            let e = o.entry(hand.to_string()).or_insert_with(|| serde_json::json!({}));
            if let Some(m) = e.as_object_mut() {
                m.insert(stat.to_string(), jv);
            }
        } else {
            o.insert(k.clone(), jv);
        }
    }
    {
        let name = pom_calc::data::minion_raw(&minion.ty).and_then(|r| r.get("name")).and_then(|v| v.as_str()).unwrap_or(&minion.ty).to_string();
        let part = minion.skills.get(minion.main_index).and_then(|c| pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.name.clone())).unwrap_or_default();
        env.minion_info = Some((name, part, minion.output.clone()));
        if crate::offence::CAPTURE_ARMED.with(|c| c.get()) {
            let mut mods: Vec<Mod> = Vec::new();
            match &minion.store.backing {
                pom_engine::modstore::store::Backing::List(l) => mods.extend(l.iter().cloned()),
                pom_engine::modstore::store::Backing::Db(m) => mods.extend(m.values().flatten().cloned()),
            }
            for s in &minion.skills {
                mods.extend(s.skill_mod_list.iter().cloned());
            }
            env.minion_mods = Some(mods);
        }
    }
    let put = |o: &mut serde_json::Map<String, serde_json::Value>, k: &str, jv: serde_json::Value| {
        if let Some((hand, stat)) = k.split_once('.') {
            let e = o.entry(hand.to_string()).or_insert_with(|| serde_json::json!({}));
            if let Some(m) = e.as_object_mut() {
                m.insert(stat.to_string(), jv);
            }
        } else {
            o.insert(k.to_string(), jv);
        }
    };
    for (k, v) in &minion.output_lists {
        let l: serde_json::Map<String, serde_json::Value> = v.iter().enumerate().map(|(i, n)| ((i + 1).to_string(), serde_json::json!(n))).collect();
        put(&mut o, k, serde_json::Value::Object(l));
    }
    for (k, v) in &minion.output_str {
        put(&mut o, k, serde_json::json!(v));
    }
    // Not part of the reference output; identifies the minion for debugging.
    o.insert("_type".to_string(), serde_json::json!(format!("{} {} {}", minion.ty, minion.level, minion.skills.get(minion.main_index).map(|s| s.granted_effect_id.as_str()).unwrap_or(""))));
    env.output_extra.insert("Minion".to_string(), serde_json::Value::Object(o));
}

/// `addMinionModifiers(modList, env.player.mainSkill.skillCfg, env.minion)` over the flattened player buff mods
/// (CalcPerform.lua:3350).
pub fn add_buff_mods(minion: &mut MinionActor, main: &ComputedSkill, buff_mods: &[Mod]) {
    let mut st = ModStore::new_list(None, None);
    for m in buff_mods {
        st.add_mod(m.clone());
    }
    let cfg = crate::buffs::skill_cfg(main);
    for v in st.list(Some(&cfg), &[pom_engine::sym!("MinionModifier")]) {
        let Value::Map(fields) = &v else { continue };
        let ty_ok = match fields.iter().find(|(k, _)| k.as_str() == "type") {
            Some((_, Value::Str(t))) => t.as_ref() == minion.ty,
            _ => true,
        };
        if !ty_ok {
            continue;
        }
        if let Some((_, Value::Map(inner))) = fields.iter().find(|(k, _)| k.as_str() == "mod") {
            minion.store.add_mod(crate::extra_skill::map_to_mod(inner));
        }
    }
}

/// `ResistanceAddedToMinions` (CalcDefence.lua:666-671), run during the player's `calcs.defence` right after its
/// `calcs.resistances`: the minion gets a share of the player's final resistances.
pub fn resistance_added(env: &Env, minion: &mut MinionActor) {
    let pct = env.player.sum(ModType::Base, None, &[pom_engine::sym!("ResistanceAddedToMinions")]);
    if pct > 0.0 {
        for elem in ["Fire", "Cold", "Lightning", "Chaos"] {
            let fin = env.output.get(&format!("{elem}Resist")).copied().unwrap_or(0.0);
            minion.store.add_mod(Mod { name: s(&format!("{elem}Resist")), ty: ModType::Base, value: Value::Num((fin * pct / 100.0).floor()), flags: 0, keyword_flags: 0, source: Some("Player".into()), tags: (vec![]).into() });
        }
    }
}

/// `calcs.createMinionSkills` (CalcActiveSkill.lua:955-1005).
fn create_skills(env: &Env, minion: &mut MinionActor, main: &ComputedSkill) {
    let raw = pom_calc::data::minion_raw(&minion.ty);
    let mut ids: Vec<String> = raw
        .and_then(|r| r.get("skillList"))
        .and_then(|l| l.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).filter(|id| pom_skills::data::granted_effect_by_skill_id(id).is_some()).map(|s| s.to_string()).collect())
        .unwrap_or_default();
    let cfg = crate::buffs::skill_cfg(main);
    let names = [pom_engine::sym!("ExtraMinionSkill")];
    let extra = skill_store(env, main).list(Some(&cfg), &names);
    for v in extra {
        let Value::Map(f) = &v else { continue };
        let get = |k: &str| f.iter().find(|(n, _)| n.as_str() == k).map(|(_, v)| v);
        let ok = match get("minionList") {
            Some(Value::List(l)) => l.iter().any(|x| matches!(x, Value::Str(t) if t.as_ref() == minion.ty)),
            _ => true,
        };
        if let (true, Some(Value::Str(id))) = (ok, get("skillId")) {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        ids.push("Melee".to_string());
    }
    let fixup = raw.and_then(|r| r.get("damageFixup")).and_then(|v| v.as_f64());
    let sd = crate::offence::skill_data_map(&env.player, main);
    let eff = 1.0 + sd_num(&sd, "minionDamageEffectiveness").unwrap_or(0.0) / 100.0;
    let summon_minion_types = pom_skills::data::granted_effect_by_skill_id(&main.granted_effect_id).and_then(|g| pom_skills::data::minion_skill_types(g));
    // `minion.weaponData2`, whose type decides `weapon2Attack` for the minion's attack skills (an Animated Guardian wielding a
    // dagger in the off hand attacks with both).
    let weapon2: (Option<String>, bool) = {
        let (_, w2, _) = weapons(env, minion, main);
        let off = w2.as_ref().and_then(|l| l.get(1));
        (off.and_then(|v| v.get("type")).and_then(|t| t.as_str()).map(|t| t.to_string()), off.and_then(|v| v.get("countsAsAll1H")).and_then(|v| v.as_bool()).unwrap_or(false))
    };
    for id in ids {
        let Some(ge) = pom_skills::data::granted_effect_by_skill_id(&id) else { continue };
        let mut level = 1.0;
        if ge.levels.len() > 1 {
            for (i, l) in ge.levels.iter().enumerate() {
                if l.level_requirement.unwrap_or(0.0) > minion.level {
                    break;
                }
                level = (i + 1) as f64;
            }
        }
        let mut cs = pom_skills::assemble::build_minion_skill(ge, level, &main.support_list, &minion.weapon1_type, minion.level, fixup, pom_calc::setup::buff_mode().buffs, pom_calc::setup::buff_mode().combat, pom_calc::setup::buff_mode().effective, main.skill_types.clone(), summon_minion_types.clone(), weapon2.clone());
        cs.skill_flags.insert("minion".into());
        cs.skill_flags.insert("minionSkill".into());
        cs.skill_flags.insert("haveMinion".into());
        if main.skill_flags.contains("spectre") {
            cs.skill_flags.insert("spectre".into());
        }
        cs.damage_effectiveness_override = Some(eff);
        cs.summon_skill_name = pom_skills::data::granted_effect_by_skill_id(&main.granted_effect_id).and_then(|g| g.name.clone());
        minion.skills.push(cs);
    }
    let want = main.src_skill_minion_skill.unwrap_or(1);
    minion.main_index = (want.min(minion.skills.len() as i64).max(1) - 1) as usize;
}

/// The names of the skills the minion can use, in the order the Calcs tab lists them (`minionList` of the view).
pub(crate) fn skill_names(minion: &MinionActor) -> Vec<String> {
    minion.skills.iter().map(|s| pom_skills::data::all_skills().get(&s.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| s.name.clone())).collect()
}

/// `minion.weaponData1` for a minion without a borrowed weapon (CalcActiveSkill.lua:729-758).
fn weapon_json(env: &Env, minion: &MinionActor, main: &ComputedSkill) -> serde_json::Value {
    let raw = pom_calc::data::minion_raw(&minion.ty);
    let f = |k: &str| raw.and_then(|r| r.get(k)).and_then(|v| v.as_f64());
    let attack_time = f("attackTime").unwrap_or(1.0);
    let table = if minion.is_spectre { pom_calc::data::monster_damage_table(minion.level) } else { pom_calc::data::monster_ally_damage_table(minion.level) };
    let mut damage = table * f("damage").unwrap_or(0.0);
    if !raw.and_then(|r| r.get("baseDamageIgnoresAttackSpeed")).and_then(|v| v.as_bool()).unwrap_or(false) {
        damage *= attack_time;
    }
    let spread = f("damageSpread").unwrap_or(0.0);
    let rate = 1.0 / attack_time;
    serde_json::json!({
        "type": minion.weapon1_type,
        "AttackRate": rate,
        "CritChance": 5.0,
        "PhysicalMin": round(damage * (1.0 - spread)),
        "PhysicalMax": round(damage * (1.0 + spread)),
        "range": f("attackRange").unwrap_or(0.0),
    })
}

/// `calcs.offence(env, env.minion, env.minion.mainSkill)` (CalcPerform.lua:3807): the player's offence port run with the
/// minion swapped in as the acting actor (its store, output, weapons and single active skill).
pub fn offence_pass(env: &mut Env, minion: &mut MinionActor, main: &ComputedSkill) {
    let Some(ms) = minion.skills.get(minion.main_index).cloned() else { return };
    let mut ms = ms;
    ms.in_main_group = true;
    ms.group_main_active_skill = 1;
    let (w1, w2, player_unarmed) = weapons(env, minion, main);
    let mut w1_list = match (w1, player_unarmed) {
        (Some(l), _) => Some(l),
        (None, true) => None,
        (None, false) => Some(vec![weapon_json(env, minion, main)]),
    };
    // `NonSpectreMinionsUseParentMainHandAttackTime` (CalcActiveSkill.lua:783-788): copy the parent's base attack rate.
    if !minion.is_spectre && skill_store(env, main).flag(Some(&crate::buffs::skill_cfg(main)), &[pom_engine::sym!("NonSpectreMinionsUseParentMainHandAttackTime")]) {
        let rate = env.weapon_data.get("Weapon 1").and_then(|w| w.first()).and_then(|w| w.get("AttackRate")).and_then(|v| v.as_f64()).filter(|r| *r > 0.0);
        if let (Some(rate), Some(first)) = (rate, w1_list.as_mut().and_then(|l| l.first_mut())) {
            first["AttackRate"] = serde_json::json!(rate);
        }
    }
    let range = w1_list.as_ref().and_then(|l| l.first()).and_then(|w| w.get("range")).and_then(|v| v.as_f64());
    // `weaponData2.range` (CalcOffence.lua:1153-1158): an off-hand weapon the minion holds counts too.
    let range2 = w2.as_ref().and_then(|l| l.get(1)).and_then(|w| w.get("range")).and_then(|v| v.as_f64());
    let mut weapon_map: HashMap<String, Vec<serde_json::Value>> = HashMap::default();
    if let Some(l) = w1_list {
        weapon_map.insert("Weapon 1".to_string(), l);
    }
    if let Some(l) = w2 {
        weapon_map.insert("Weapon 2".to_string(), l);
    }
    let parent = crate::buffs::player_snapshot(&env.player);
    // `calcs.triggers(env, env.minion)` (CalcPerform.lua:3807): the minion's own trigger (Holy Relic's Nova). The
    // minion skill's record is built under the minion's store; the source scan and rate caches run on the player's.
    let mut minion_trig = None;
    if pom_skills::data::all_skills().get(&ms.granted_effect_id).and_then(|g| g.name.as_deref()) == Some("Nova") {
        std::mem::swap(&mut env.player, &mut minion.store);
        std::mem::swap(&mut env.output, &mut minion.output);
        let saved_skills = std::mem::replace(&mut env.active_skills, vec![ms.clone()]);
        env.parent_snapshot = Some(crate::buffs::player_snapshot(&minion.store));
        crate::refresh_actors(env);
        let rec = crate::triggers_wire::build_skill_record(env, &ms);
        env.parent_snapshot = None;
        env.active_skills = saved_skills;
        std::mem::swap(&mut env.output, &mut minion.output);
        std::mem::swap(&mut env.player, &mut minion.store);
        crate::refresh_actors(env);
        let xml = env.xml_text.clone();
        minion_trig = crate::triggers_wire::run_minion(env, &xml, rec);
        if let Some(t) = &minion_trig {
            crate::bd_perform::trigger_tables(t, true);
        }
    }
    // CalcOffence.lua:565-566 read `env.itemModDB.multipliers` (the player's), whichever actor is being calculated.
    let flask_out: Vec<(&str, f64)> = ["LifeFlaskRecovery", "LifeFlaskCharges"].into_iter().filter_map(|k| env.player.multipliers.get(&s(k)).map(|v| (k, *v))).collect();
    std::mem::swap(&mut env.player, &mut minion.store);
    // `env.player` now holds the minion's store: the FullDPS parent-level split belongs to the player's modDB only.
    let saved_split = crate::buffs::FULLDPS_PARENT.with(|p| p.borrow_mut().take());
    std::mem::swap(&mut env.output, &mut minion.output);
    let saved_skills = std::mem::replace(&mut env.active_skills, vec![ms]);
    // CalcPerform.lua:3473-3475 (`DisableWeapons` swaps in the unarmed table, crit 0) and CalcSetup.lua:1566-1581.
    let parent_w1_crit = match env.weapon_data.get("Weapon 1").and_then(|w| w.first()) {
        Some(v) if !env.weapons_disabled => v.get("CritChance").and_then(|x| x.as_f64()),
        _ => Some(0.0),
    };
    let saved_parent_crit = std::mem::replace(&mut env.parent_weapon1_crit, parent_w1_crit);
    let saved_weapons = std::mem::replace(&mut env.weapon_data, weapon_map);
    // `DisableWeapons` (The Dancing Dervish) replaces only the player's `weaponData1`; the minion already holds its own table.
    let saved_weapons_disabled = std::mem::replace(&mut env.weapons_disabled, false);
    let saved_range = std::mem::replace(&mut env.weapon_range, range.into_iter().map(|r| ("Weapon 1".to_string(), r)).chain(range2.into_iter().map(|r| ("Weapon 2".to_string(), r))).collect());
    let saved_armour = std::mem::replace(&mut env.item_armour, minion.item_armour.clone());
    let saved_str = std::mem::take(&mut env.output_str);
    let saved_lists = std::mem::take(&mut env.output_lists);
    env.parent_snapshot = Some(parent);
    env.parent_output = Some(minion.output.clone());
    let saved_limit = env.minion_limit.take();
    crate::refresh_actors(env);
    let xml = env.xml_text.clone();
    let saved_trig = std::mem::replace(&mut env.trigger_apply, minion_trig);
    pom_offence::bd::select_actor(1);
    crate::offence::compute_offence(env, &xml);
    pom_offence::bd::select_actor(0);
    env.trigger_apply = saved_trig;
    env.parent_snapshot = None;
    env.parent_output = None;
    env.minion_limit = saved_limit;
    for (k, v) in flask_out {
        env.output.insert(k.to_string(), v);
    }
    std::mem::swap(&mut env.player, &mut minion.store);
    crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = saved_split);
    std::mem::swap(&mut env.output, &mut minion.output);
    env.active_skills = saved_skills;
    env.weapon_data = saved_weapons;
    env.parent_weapon1_crit = saved_parent_crit;
    env.weapons_disabled = saved_weapons_disabled;
    env.weapon_range = saved_range;
    env.item_armour = saved_armour;
    minion.output_str = std::mem::replace(&mut env.output_str, saved_str);
    minion.output_lists = std::mem::replace(&mut env.output_lists, saved_lists);
    crate::refresh_actors(env);
}

/// `minion.weaponData1.range` (`minionData.attackRange`).
fn raw_range(minion: &MinionActor) -> Option<f64> {
    pom_calc::data::minion_raw(&minion.ty).and_then(|r| r.get("attackRange")).and_then(|v| v.as_f64())
}

/// `minion.weaponData1/2` when borrowed from an item (CalcActiveSkill.lua:735-768): (hand-1 data list, Weapon 2 item's
/// data list, weaponData1 is the player's own unarmed table). `None, None, false` means the minion's own default weapon.
fn weapons(env: &Env, minion: &MinionActor, main: &ComputedSkill) -> (Option<Vec<serde_json::Value>>, Option<Vec<serde_json::Value>>, bool) {
    let sd = crate::offence::skill_data_map(&env.player, main);
    let player_w1 = env.weapon_data.get("Weapon 1").cloned();
    let player_bow = player_w1.as_ref().and_then(|w| w.first()).and_then(|w| w.get("type")).and_then(|t| t.as_str()) == Some("Bow");
    let mut w1 = None;
    let mut w2 = None;
    let mut unarmed = false;
    if (sd_truthy(&sd, "minionUseBowAndQuiver") && player_bow) || sd_truthy(&sd, "minionUseMainHandWeapon") {
        unarmed = player_w1.is_none();
        w1 = player_w1.clone();
    }
    if main.minion_uses.iter().any(|u| u == "Weapon 1") {
        if main.minion_has_item_set {
            if minion.weapon1_items.is_some() {
                w1 = minion.weapon1_items.clone();
                unarmed = false;
            }
        } else {
            unarmed = player_w1.is_none();
            w1 = player_w1;
        }
    }
    if main.minion_uses.iter().any(|u| u == "Weapon 2") {
        w2 = if main.minion_has_item_set { minion.weapon2_items.clone() } else { env.weapon_data.get("Weapon 2").cloned() };
    }
    (w1, w2, unarmed)
}
