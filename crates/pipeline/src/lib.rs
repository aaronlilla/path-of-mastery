//! pom-pipeline: turns one build's parsed XML into a `ModStore` for the player and the enemy through the pom-item,
//! pom-passives and pom-config entry points, then runs the calc stages in the order of `calcs.perform`: attributes,
//! buffs, defence, then offence, with triggers wired in by `triggers_wire`.
//!
//! Setup is `calcs.initEnv`. Every mod that gets merged goes through the crate function that produces it, and
//! `crates/calc` is used as a library only.

use pom_engine::data::GameData;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modparser::types::pmod_to_mod;
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use roxmltree::{Document, Node as XmlNode};
use pom_engine::fxhash::HashMap;

mod calcs_popup;
pub mod calcs;
pub mod cluster_import;
pub mod calcs_view;
pub mod actor_misc;
mod equipped_bonus;
pub mod ailments;
pub mod extra_skill;
pub mod attrib_conds;
pub mod buffs;
pub mod buff_export;
pub mod party;
pub mod reset;
pub use reset::reset_build_state;
pub mod enemy_mods;
pub mod minion;
pub mod offence;
pub mod self_hit;
pub mod offence_prep;
pub mod recorded_input;
pub mod offence_dps;
pub mod bd_b;
pub mod bd_perform;
pub mod edit;
pub mod edit_config;
pub mod tabdata_config;
pub mod config_mods;
pub mod edit_skills;
pub mod tabdata_skills;
pub mod session;
pub mod treeclick;
pub mod treeedit;
pub mod nodepower;
pub mod timeless;
#[cfg(test)]
mod timeless_tests;
pub mod optimizer;
pub mod solver;
pub mod solver_boss;
mod solver_drain;
mod lua_sort;
mod skillgeo;
pub mod radius;
pub mod skill_funcs;
pub mod proj_overlap;
pub mod skill_hooks;
pub mod triggers_wire;

pub use pom_defence::snapshot::ArmourData;

/// Slot name -> item info, and search condition -> lowercased slot -> found.
pub type ItemActorInfo = (HashMap<std::sync::Arc<str>, pom_engine::modstore::types::ItemInfo>, HashMap<std::sync::Arc<str>, HashMap<std::sync::Arc<str>, bool>>);

/// The live state `build_env` assembles and `run` mutates - the crate's own stand-in for the
/// original's `env` table, scoped to what's actually ported (player + enemy `ModStore`, plus the
/// handful of plain fields `pom_defence::defence`/`pom_calc::perform` need that aren't mod-store
/// state: `configInput`/`configFlags`, `itemArmour`, active flask mod lists, and the allocated
/// tree nodes `merge_keystones` needs at Perform time).
#[derive(Clone)]
pub struct Env {
    /// A copy of this env taken before `run`, when the build has FullDPS skills (see `build_env`).
    pub pristine: Option<Box<Env>>,
    /// The build has FullDPS rows (their pre-run copy is `pristine`, unless `SKIP_PRISTINE` asked for none).
    pub fulldps_rows: bool,
    /// `buffExports` of the main calculation while the build's Export Support switch is on (see `buff_export`).
    pub buff_exports: Option<buff_export::BuffExports>,
    /// Shared by every copy of this env: frees the actor link cycles once the last copy is gone (`RunLinks`).
    pub run_links: std::rc::Rc<pom_engine::modstore::types::RunLinks>,
    /// `(source, skillId)` of every triggered `ExtraSkill` grant: the gem instance's `triggered` flag.
    pub granted_triggered: Vec<(String, String)>,
    /// `(source, skillId, triggerChance)` of every `ExtraSkill` grant with a trigger chance: `srcInstance.triggerChance`.
    pub granted_trigger_chance: Vec<(String, String, f64)>,
    /// `(slot, source, skillId, level)` of the skills items in the inactive weapon set grant (CalcSetup.lua:826-835 collects
    /// them before the weapon-set skip): upstream saves a socket group for each, which the Skills tab lists but no
    /// calculation uses.
    pub inactive_item_grants: Vec<(String, String, String, f64)>,
    /// Mods `calcs.initEnv` adds before `specCopy` (initModDB, class base, bandit/pantheon, config tab): in the
    /// `calcs.calcFullDPS` runs they live in `env.modDB.parent` (`cachedPlayerDB`), one rounding level below the rest.
    pub parent_level_mods: Vec<Mod>,
    /// Verification harness state (`recorded_input`), only ever set from `POM_OFFENCE_INPUT`.
    pub recorded_override: Option<crate::recorded_input::RecordedSkillInput>,
    /// While the minion's calcs run with the minion swapped into `player`: the real player's store (`actor.parent`).
    pub parent_snapshot: Option<std::sync::Arc<ModStore>>,
    /// The real player's `output` while a minion pass has `env.output` swapped (`env.player.output` in upstream).
    pub parent_output: Option<HashMap<String, f64>>,
    /// Every parsed `<Item>` by id, and the active item set's slot -> item id (Swap slots normalised as in `slots`).
    pub items: HashMap<i64, std::rc::Rc<pom_item::Item>>,
    pub slot_items: HashMap<String, i64>,
    /// The player's main-skill minion `minionData.limit` (empty when it has none), `None` without a minion.
    pub minion_limit: Option<String>,
    /// The parent (player) actor's `weaponData1.CritChance` while a minion pass runs (`actor.parent.weaponData1.CritChance`).
    pub parent_weapon1_crit: Option<f64>,
    /// `env.aegisModList` (CalcSetup.lua:1100-1116): a Shield's non-`SocketedIn` mods when Necromantic
    /// Aegis (node 45175) is allocated - they go to the minion instead of the player.
    pub aegis_mod_list: Vec<Mod>,
    /// `env.weaponModList1` (CalcSetup.lua:1172-1188): The Dancing Dervish's non-`SocketedIn` mods, held back
    /// until CalcPerform.lua:3473 decides whether the weapons are disabled.
    pub weapon_mod_list1: Vec<Mod>,
    /// CalcPerform.lua:3473-3477: `DisableWeapons` swapped `weaponData1` for the unarmed table.
    pub weapons_disabled: bool,
    /// The build's own raw XML, kept for `crate::offence::select_main_skill`'s own re-parse of
    /// `<Skills>` (see that function's doc comment for why `pom_skills::assemble::build_all_skills`'s
    /// flat `Vec<ComputedSkill>` result alone isn't enough to find the main skill).
    pub xml_text: String,
    pub character_level: f64,
    pub tree_version: String,
    pub class_id: i64,
    pub player: ModStore,
    /// `actor.itemList`/`FindModifierSubstring` results for `ItemCondition` tags (see `build_item_actor`).
    pub item_actor_info: ItemActorInfo,
    pub enemy: ModStore,
    pub item_armour: HashMap<String, ArmourData>,
    /// `item.weaponData` (one entry per hand, `[0]`/`[1]` = Lua `[1]`/`[2]`) of the items in the
    /// "Weapon 1"/"Weapon 2" slots - CalcSetup.lua:1566-1581's `env.player.weaponData1/2` source.
    pub weapon_data: HashMap<String, Vec<serde_json::Value>>,
    /// `weaponData1/2` tables read by the `Condition` tag evaluator (Varunastra's `countsAsAll1H` / `AddedUsing*`).
    pub actor_weapons: (HashMap<std::sync::Arc<str>, pom_engine::modstore::types::ScalarValue>, HashMap<std::sync::Arc<str>, pom_engine::modstore::types::ScalarValue>),
    /// Every allocated Keystone node's own real effect mods (`node.kind == "Keystone"`), held
    /// aside from `player` until `run`'s `merge_keystones` step - Setup only ever merges a
    /// keystone's placeholder marker mod (CalcSetup.lua's `buildModListForNode`, matching
    /// `pom_calc::setup`'s own doc comments), never ported here since this crate doesn't need a
    /// separate placeholder-marker representation.
    pub keystone_mods: Vec<Vec<Mod>>,
    /// `env.spec.tree.keystoneMap[name].modList` for every tree Keystone (keyed by display name and
    /// its lowercase form), used by `run`'s `mergeKeystones` for `Keystone` LIST marker mods that
    /// come from items/jewels/config rather than from an allocated node.
    pub keystone_map: HashMap<String, Vec<Mod>>,
    /// `doActorAttribsConditions`'s weapon/armour-slot conditions (see `attrib_conds`).
    pub weapon_conditions: Vec<String>,
    /// Display names of the keystones already merged via `keystone_mods` (`env.keystonesAdded`).
    pub keystones_added: pom_engine::fxhash::HashSet<String>,
    /// Every flask/tincture item actually marked `active` (`<Slot active="true">`) in the active
    /// `ItemSet`, its own combined mod list - `mergeFlasks`'s input (CalcSetup.lua ~1028-1044
    /// excludes these from the normal per-slot item merge).
    pub active_flask_mods: Vec<pom_calc::perform::FlaskInput>,
    /// Over every flask worn, active or not (the solver's checklist, solver_checklist.rs): a flask whose parsed mods carry
    /// the BleedImmune flag, and the life per second the life flasks' base recovery gives over their duration.
    pub flask_removes_bleed: bool,
    pub flask_life_per_s: f64,
    /// Per active flask: (base name, `base.flask.life`, `base.flask.mana`, `flaskData.instantPerc`,
    /// `flaskData.instantLowLifePerc`) - what `getFlaskInstantRecovery`/the flask-condition loop reads.
    pub flask_cond_info: Vec<(String, bool, bool, f64, f64, f64, f64)>,
    /// Active tinctures (CalcSetup.lua:1045 `env.tinctures`), merged by `mergeTinctures` after reservation.
    pub active_tinctures: Vec<TinctureInput>,
    /// (`TinctureEffect` INC, `MagicTinctureEffect` INC, `TinctureLimit`) read at CalcPerform.lua:1851-1853,
    /// before the flask conditions are set.
    pub tincture_params: (f64, f64, f64),
    /// Allocated passive points outside the ascendancy (`spec:CountAllocNodes`, the first value): `EstimatePlayerProgress` reads it.
    pub points_used: i32,
    /// MAGIC utility flasks (not Life/Mana/Hybrid) in `orderedSlots` order, active or not - the
    /// pool Mageblood's `Left/RightActiveMagicUtilityFlasks` activate from (CalcPerform.lua:1577-1600).
    /// Each entry: (slot name, is already active, input, cond info).
    pub magic_utility_flasks: Vec<(String, bool, pom_calc::perform::FlaskInput, (String, bool, bool, f64, f64, f64, f64))>,
    pub config_input: HashMap<String, f64>,
    pub config_flags: HashMap<String, bool>,
    pub config_str: HashMap<String, String>,
    pub config_placeholder: HashMap<String, f64>,
    pub config_placeholder_str: HashMap<String, String>,
    pub enemy_level: f64,
    /// `env.player.activeSkillList`: every active skill this build's socket groups (plus item-
    /// granted synthetics) produce (`pom_skills::assemble::build_all_skills`), each with its own
    /// resolved `skillModList`/`skillData` (`pom_skills::modlist`). Reservation scans every skill's own
    /// `skillTypes`, not only the main one.
    pub active_skills: Vec<pom_skills::assemble::ComputedSkill>,
    /// `calcs.copyActiveSkill` (CalcActiveSkill.lua:167) rebuilds a mirage's skill from `srcInstance.level/quality` with no
    /// `gemPropertyInfo`: the same skills built without item/tree gem-level and quality bonuses or socket-colour quality.
    /// Only built when the build mentions a mirage gem.
    pub raw_skills: Vec<pom_skills::assemble::ComputedSkill>,
    pub output: HashMap<String, f64>,
    /// `output.AreaOfEffectRadiusTertiaryOccurrences` (radius, occurrence count), set by `skillgeo` for Explosive Trap.
    pub tertiary_occ: Vec<(f64, f64)>,
    /// `player.output` keys holding a Lua array of strings (`*CostWarningList`), dumped as `{"1": ..}`.
    pub output_lists: HashMap<String, Vec<String>>,
    /// `player.output.SkillDPS` (`fullDPS.skills`, Calcs.lua:142-352): the ordered rows of the Full DPS roll-up.
    pub skill_dps: Vec<offence_dps::SkillDpsRow>,
    /// `calcs.triggers`' result for the main skill (`triggers_wire`), applied by the offence pass.
    pub trigger_apply: Option<triggers_wire::TrigApply>,
    /// Text-valued outputs (`ChainMaxString` = "Cannot chain", ...); numeric ones live in `output`.
    pub output_str: HashMap<String, String>,
    /// `weaponData1/2.range` keyed by slot name ("Weapon 1"/"Weapon 2"), only for real weapons.
    pub weapon_range: HashMap<String, f64>,
    /// `env.requirementsTable`: every equipped item's and enabled gem's (Str, Dex, Int) requirement
    /// (CalcSetup.lua:1072, 1845). Only the maximum per attribute is ever read, so the source is dropped.
    pub attr_reqs: Vec<[f64; 3]>,
    /// What each `attr_reqs` row came from (the Req tables of the Calcs view name it).
    pub attr_req_srcs: Vec<bd_perform::ReqSrc>,
    /// `output` entries that aren't numbers (`ReqStrString`'s colour-coded text, `Req*Item`'s table
    /// placeholder), emitted verbatim by `dump`.
    pub output_extra: HashMap<String, serde_json::Value>,
    /// The game data this env was built from (FullDPS re-runs whole builds for minion skills).
    pub game: &'static GameData,
    /// `(minionData.name, minion.mainSkill grantedEffect name, minion output)` of the last minion export.
    pub minion_info: Option<(String, String, HashMap<String, f64>)>,
    /// The minion's finished mod store and its skills' base mod lists, kept only while `offence::CAPTURE_ARMED` is set
    /// (the Configuration tab reads which conditions and multipliers they use).
    pub minion_mods: Option<Vec<Mod>>,
    /// Ids of the skills of every player skill's minion (`env.skillsUsed[activeSkill.activeEffect.grantedEffect.id]`, Calcs.lua:452-456).
    pub minion_skill_ids: Vec<String>,
    /// `data.misc.LowPoolThreshold` / `data.misc.TemporalChainsEffectCap`.
    pub low_pool_threshold: f64,
    pub temporal_chains_cap: f64,
    /// Which of `run`'s stages actually executed, in order.
    pub stages_run: Vec<&'static str>,
    /// A snapshot of `REPRESENTATIVE_STATS` (or, at the `attributes`/`defence` stages, whatever is in `output` by
    /// then) taken right after each stage, for finding the first stage where this crate's state differs from another
    /// implementation's. Filled when `POM_STAGE_SNAPSHOTS` is set (`defence_estimations` is always kept).
    pub stage_snapshots: Vec<(&'static str, HashMap<String, f64>)>,
}

/// The stat set `build_env`/`run` snapshot at the `setup`/`flasks` stage boundaries (`calcLib.val`
/// over the live `ModStore`, matching `pom_calc::perform`'s private `calc_val` formula exactly -
/// see `calc_val` below) - broad enough to catch a divergence in attributes, life/mana bases,
/// defensive bases or resistances without dumping the whole `ModStore`.
pub const REPRESENTATIVE_STATS: &[&str] = &["Str", "Dex", "Int", "Life", "Mana", "Evasion", "Armour", "EnergyShield", "FireResist", "ColdResist", "LightningResist", "ChaosResist"];

/// `calcLib.val(modStore, name)` (Modules/CalcTools.lua:32-39, `cfg` always nil here) - the same
/// formula `pom_calc::perform`'s own private `calc_val` ports, reimplemented here (not imported:
/// that one is private to `crate::perform`) so `build_env`'s pre-Perform snapshot doesn't need a
/// public export added to a crate this repo's rules say not to edit beyond one-line `pub` changes.
pub(crate) fn calc_val(store: &ModStore, name: &str) -> f64 {
    let sym = Sym::new(name);
    let base = store.sum(ModType::Base, None, &[sym]);
    if base != 0.0 {
        let inc = 1.0 + store.sum(ModType::Inc, None, &[sym]) / 100.0;
        base * inc * store.more(None, &[sym])
    } else {
        0.0
    }
}

fn snapshot(store: &ModStore) -> HashMap<String, f64> {
    REPRESENTATIVE_STATS.iter().map(|&name| (name.to_string(), calc_val(store, name))).collect()
}

fn attr_i64(n: &XmlNode, name: &str) -> Option<i64> {
    n.attribute(name).and_then(|s| s.parse().ok())
}
fn attr_f64(n: &XmlNode, name: &str) -> Option<f64> {
    n.attribute(name).and_then(|s| s.parse().ok())
}
fn child<'a, 'input>(n: &'a XmlNode<'a, 'input>, name: &str) -> Option<XmlNode<'a, 'input>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}
fn children<'a, 'input>(n: &'a XmlNode<'a, 'input>, name: &'a str) -> impl Iterator<Item = XmlNode<'a, 'input>> + 'a {
    n.children().filter(move |c| c.is_element() && c.tag_name().name() == name)
}
/// `ItemsTab:Load` (ItemsTab.lua:1225-1245) seeds `item.variant`/`variantAlt*` from the `<Item>` attributes before
/// `ParseRaw`; a `Selected Variant`/`Selected Alt Variant*` spec line in the text overrides them. The item parser only
/// reads spec lines, so the attributes are turned into spec lines placed after the last `Variant:` line.
fn inject_variant_attrs(raw: &str, item_el: &XmlNode) -> String {
    let attrs = [("variant", "Selected Variant", None), ("variantAlt", "Selected Alt Variant", Some("Has Alt Variant")), ("variantAlt2", "Selected Alt Variant Two", Some("Has Alt Variant Two")), ("variantAlt3", "Selected Alt Variant Three", Some("Has Alt Variant Three")), ("variantAlt4", "Selected Alt Variant Four", Some("Has Alt Variant Four")), ("variantAlt5", "Selected Alt Variant Five", Some("Has Alt Variant Five"))];
    let mut lines: Vec<String> = raw.lines().map(|l| l.to_string()).collect();
    let Some(last_variant) = lines.iter().rposition(|l| l.trim_start().starts_with("Variant:")) else { return raw.to_string() };
    let mut extra: Vec<String> = Vec::new();
    for (attr, sel, has) in attrs {
        let Some(v) = item_el.attribute(attr) else { continue };
        let Ok(n) = v.trim().parse::<f64>() else { continue };
        if !lines.iter().any(|l| l.trim_start().starts_with(&format!("{sel}:"))) {
            if let Some(h) = has {
                if !lines.iter().any(|l| l.trim_start().starts_with(&format!("{h}:"))) {
                    extra.push(format!("{h}: true"));
                }
            }
            extra.push(format!("{sel}: {}", n as i64));
        }
    }
    if extra.is_empty() {
        return raw.to_string();
    }
    for (k, e) in extra.into_iter().enumerate() {
        lines.insert(last_variant + 1 + k, e);
    }
    lines.join("
")
}

fn concat_text(n: &XmlNode) -> String {
    let mut s = String::new();
    for c in n.children() {
        if c.is_text() {
            if let Some(t) = c.text() {
                s.push_str(t);
            }
        }
    }
    s
}

/// `Weapon 1`/`Weapon 2`/`Ring 1`/`Ring 2`/`Ring 3` -> the `slot_mod_list` index a multi-slot
/// item's mods for that slot live at (`pom_item::item::Item::slot_mod_list`, 2 entries for a
/// weapon, 3 for a ring - see `crates/item/src/buildmod.rs`). Any other slot name is single-slot
/// (`mod_list`).
fn multi_slot_index(slot_name: &str) -> Option<usize> {
    match slot_name {
        "Weapon 1" => Some(0),
        "Weapon 2" => Some(1),
        "Ring 1" => Some(0),
        "Ring 2" => Some(1),
        "Ring 3" => Some(2),
        _ => None,
    }
}

/// One active tincture: what `mergeTinctures`/`calcTinctureMods` (CalcPerform.lua:1862-1930) reads.
#[derive(Clone)]
pub struct TinctureInput {
    pub base_name: String,
    pub title: Option<String>,
    pub unique: bool,
    pub magic: bool,
    pub quality: f64,
    pub effect_inc: f64,
    pub buff_mod_list: Vec<Mod>,
    pub mod_list: Vec<Mod>,
}

fn is_flask_slot(slot_name: &str) -> bool {
    slot_name.starts_with("Flask")
}

pub(crate) fn item_mods_for_slot<'a>(item: &'a pom_item::Item, slot_name: &str) -> &'a [Mod] {
    if let Some(idx) = multi_slot_index(slot_name) {
        if let Some(sml) = &item.slot_mod_list {
            return sml.get(idx).or_else(|| sml.first()).map(|v| v.as_slice()).unwrap_or(&[]);
        }
    }
    item.mod_list.as_deref().unwrap_or(&[])
}

/// `build.latestTree.ascendancyMap[name]` (CalcSetup.lua:1392, 1407): the newest tree's ascendancy
/// node, used when the build's own (older/alternate) tree lacks it. Returns its id and its mods.
fn latest_tree_ascendancy_node(name_lower: &str) -> Option<(i64, Vec<Mod>)> {
    static LATEST: std::sync::OnceLock<Option<pom_passives::treedata::TreeData>> = std::sync::OnceLock::new();
    // (shared by every thread: parsed the way upstream parses it, even on a solver thread with text rules on)
    let tree = LATEST
        .get_or_init(|| {
            let rules = pom_engine::modparser::text_rules::set_active(false);
            let t = pom_passives::load_tree(&engine_data_dir(), "tree_3_29.json").ok();
            pom_engine::modparser::text_rules::set_active(rules);
            t
        })
        .as_ref()?;
    let mut ids: Vec<i64> = tree
        .nodes
        .iter()
        .filter(|(_, v)| v.get("ascendancyName").and_then(|a| a.as_str()).is_some() && v.get("dn").and_then(|d| d.as_str()).map(|d| d.to_lowercase()).as_deref() == Some(name_lower) && matches!(v.get("type").and_then(|t| t.as_str()), Some("Notable") | Some("Normal")))
        .map(|(id, _)| *id)
        .collect();
    ids.sort_unstable();
    let id = *ids.last()?;
    Some((id, tree.node_mods.get(&id)?.iter().map(pmod_to_mod).collect()))
}

/// An `Actor` carrying `env.player.itemList` (`ItemInfo` per slot) and the pre-baked
/// `FindModifierSubstring` results (`pom_item::findmod`) for every `ItemCondition` `searchCond`
/// found on `player`'s mods - the inputs `ModStore`'s `ItemCondition` evaluation reads.
fn build_item_actor(item_list: &[(String, &pom_item::Item)], player: &ModStore, game: &GameData) -> pom_engine::modstore::types::Actor {
    use pom_engine::modstore::types::{Actor, ItemInfo};
    let mut actor = Actor::default();
    for (slot, item) in item_list {
        actor.items.insert(slot.as_str().into(), ItemInfo {
            name: Some(item.name.as_str().into()),
            rarity: Some(item.rarity.as_str().into()),
            corrupted: Some(item.corrupted),
            shaper: Some(item.influence.get("shaper").copied().unwrap_or(false)),
            elder: Some(item.influence.get("elder").copied().unwrap_or(false)),
            item_type: item.item_type.as_deref().map(Into::into),
        });
    }
    let mut conds: Vec<String> = Vec::new();
    let (kind, search) = (pom_engine::sym!("ItemCondition"), pom_engine::sym!("searchCond"));
    let all_mods: &[Mod] = match &player.backing {
        pom_engine::modstore::store::Backing::List(v) => v,
        pom_engine::modstore::store::Backing::Db(_) => &[],
    };
    for m in all_mods {
        for t in &m.tags {
            if t.kind == kind {
                if let pom_engine::value::Value::Str(c) = t.get(search) {
                    let c = c.to_lowercase();
                    if !conds.contains(&c) {
                        conds.push(c);
                    }
                }
            }
        }
    }
    if !conds.is_empty() {
        let tags = pom_item::findmod::ItemTagData::load(game);
        for c in conds {
            let mut per_slot = HashMap::default();
            for (slot, item) in item_list {
                let slot_lower = slot.to_lowercase();
                per_slot.insert(std::sync::Arc::<str>::from(slot_lower.as_str()), pom_item::findmod::find_modifier_substring(item, &c, &slot_lower, &tags));
            }
            actor.item_search.insert(c.as_str().into(), per_slot);
        }
    }
    actor
}

/// The per-item conditions/multipliers `calcs.initEnv` writes to `env.itemModDB` (CalcSetup.lua:
/// 937-941, 1029-1041 flasks; 1082-1098 abyss jewels; 1273-1306 item counts), merged into the modDB
/// at 1385. Socketed-gem counts (1310-1355), the other-ring/Kalandra adjustments and class-restricted
/// title conditions are not ported.
fn item_setup_multipliers(player: &mut ModStore, game: &GameData, slot_name: &str, item: &pom_item::Item) {
    let ty = item.item_type.as_deref().unwrap_or("");
    let base_name = item.base_name.as_deref().unwrap_or("");
    let squash = |s: &str| -> String { s.split_whitespace().collect() };
    let mut add = |player: &mut ModStore, name: &str, v: f64| {
        *player.multipliers.entry(Sym::new(name)).or_insert(0.0) += v;
    };
    if ty == "Flask" {
        player.conditions.insert(Sym::new(&format!("Have{}", squash(base_name))), true);
        let sub = game.item_bases.get(base_name).and_then(|b| b.extra.get("subType")).and_then(|v| v.as_str()).unwrap_or("");
        if sub == "Life" {
            if let Some(fd) = &item.flask_data {
                let g = |k: &str| fd.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                for (name, v) in [("LifeFlaskRecovery", g("lifeTotal")), ("LifeFlaskCharges", g("chargesMax"))] {
                    let e = player.multipliers.entry(Sym::new(name)).or_insert(0.0);
                    if v > *e {
                        *e = v;
                    }
                }
            }
        }
        return;
    }
    if ty == "Tincture" {
        return;
    }
    let rarity_unique = item.rarity == "UNIQUE" || item.rarity == "RELIC";
    if ty == "Jewel" {
        let sub = game.item_bases.get(base_name).and_then(|b| b.extra.get("subType")).and_then(|v| v.as_str()).unwrap_or("");
        if sub == "Abyss" {
            let cond = format!("Have{}", squash(base_name));
            let mult = squash(base_name);
            if !player.conditions.get(&Sym::new(&cond)).copied().unwrap_or(false) {
                player.conditions.insert(Sym::new(&cond), true);
                add(player, "AbyssJewelType", 1.0);
            }
            if let Some(idx) = slot_name.find(" Abyssal Socket ") {
                let parent = &slot_name[..idx];
                player.conditions.insert(Sym::new(&format!("{cond}In{parent}")), true);
                add(player, &format!("{mult}In{parent}"), 1.0);
            }
            add(player, "AbyssJewel", 1.0);
            match item.rarity.as_str() {
                "NORMAL" => add(player, "NormalAbyssJewels", 1.0),
                "MAGIC" => add(player, "MagicAbyssJewels", 1.0),
                "RARE" => add(player, "RareAbyssJewels", 1.0),
                _ if rarity_unique => add(player, "UniqueAbyssJewels", 1.0),
                _ => {}
            }
            add(player, &mult, 1.0);
        }
        return;
    }
    if ty == "Graft" {
        return;
    }
    let key = if rarity_unique {
        if item.foulborn {
            add(player, "FoulbornUniqueItem", 1.0);
        }
        "UniqueItem"
    } else if item.rarity == "RARE" {
        "RareItem"
    } else if item.rarity == "MAGIC" {
        "MagicItem"
    } else {
        "NormalItem"
    };
    add(player, key, 1.0);
    player.conditions.insert(Sym::new(&format!("{key}In{slot_name}")), true);
    let flags = [("CorruptedItem", item.corrupted), ("ShaperItem", item.influence.get("shaper").copied().unwrap_or(false)), ("ElderItem", item.influence.get("elder").copied().unwrap_or(false)), ("WarlordItem", item.influence.get("adjudicator").copied().unwrap_or(false)), ("HunterItem", item.influence.get("basilisk").copied().unwrap_or(false)), ("CrusaderItem", item.influence.get("crusader").copied().unwrap_or(false)), ("RedeemerItem", item.influence.get("eyrie").copied().unwrap_or(false))];
    for (mult, on) in flags {
        add(player, &if on { mult.to_string() } else { format!("Non{mult}") }, 1.0);
    }
    if item.influence.get("shaper").copied().unwrap_or(false) || item.influence.get("elder").copied().unwrap_or(false) {
        add(player, "ShaperOrElderItem", 1.0);
    }
    let squashed = squash(ty);
    let squashed = match squashed.find("Handed") {
        Some(i) if i > 0 => squashed[i + "Handed".len()..].to_string(),
        _ => squashed,
    };
    add(player, &format!("{squashed}Item"), 1.0);
    if ty == "Ring" {
        add(player, &format!("{}Equipped", squash(base_name)), 1.0);
    }
}

pub(crate) fn armour_data_for(item: &pom_item::Item) -> Option<ArmourData> {
    let v = item.armour_data.as_ref()?;
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    Some(ArmourData { armour: f("Armour"), evasion: f("Evasion"), energy_shield: f("EnergyShield"), ward: f("Ward"), block_chance: f("BlockChance") })
}

/// Reproduces `calcs.initEnv`'s constant/base-mod block (Modules/CalcSetup.lua) for as much as
/// `pom_calc::setup` plus the item/passives/config crates' live entry points cover: `initModDB`,
/// player/enemy base mods, item mods (equipped-slot merge, flasks/tinctures held aside), tree mods
/// (allocated nodes, keystones held aside for Perform), the allocated-count mods, and the settled
/// (`OnFrame` x2) config mod list.
/// `ModList:MergeMod(mod, skipNonAdditive)` (Classes/ModList.lua:73-86).
fn merge_mod_into(list: &mut Vec<Mod>, m: &Mod, skip_non_additive: bool) {
    if matches!(m.ty, ModType::Base | ModType::Inc | ModType::More) {
        if let Some(e) = list.iter_mut().find(|d| d.name == m.name && d.ty == m.ty && d.flags == m.flags && d.keyword_flags == m.keyword_flags && d.tags == m.tags) {
            if let (pom_engine::value::Value::Num(a), pom_engine::value::Value::Num(b)) = (&e.value, &m.value) {
                e.value = pom_engine::value::Value::Num(a + b);
            }
            return;
        }
    }
    if !skip_non_additive {
        list.push(m.clone());
    }
}

fn merge_mods_additive(src: &[Mod], _unused: Option<()>) -> Vec<Mod> {
    let mut out: Vec<Mod> = Vec::new();
    for m in src {
        merge_mod_into(&mut out, m, false);
    }
    out
}

/// `ItemsTabClass:IsItemValidForSlot` for a non-jewel-socket slot (ItemsTab.lua:2559-2610).
fn item_valid_for_slot(item: &pom_item::Item, slot: &str, weapon1: Option<&pom_item::Item>, game: &GameData) -> bool {
    let slot_type = match slot.rsplit_once(' ') {
        Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) && !head.is_empty() && head.bytes().all(|b| b.is_ascii_alphabetic() || b == b' ') => head,
        _ => slot,
    };
    let base = |it: &pom_item::Item| it.base_name.as_ref().and_then(|n| game.item_bases.get(n));
    let ity = item.item_type.as_deref().unwrap_or("");
    let one = |t: &str| pom_skills::data::weapon_type_info(t).is_some_and(|w| w.one_hand);
    if ity == slot_type {
        true
    } else if ity == "Tincture" && slot_type == "Flask" {
        true
    } else if ity == "Jewel" && base(item).and_then(|b| b.extra.get("subType")).and_then(|v| v.as_str()) == Some("Abyss") && slot.contains("Abyssal Socket") {
        true
    } else if slot == "Weapon 1" || slot == "Weapon 1 Swap" || slot == "Weapon" {
        base(item).is_some_and(|b| b.weapon.is_some())
    } else if slot == "Weapon 2" || slot == "Weapon 2 Swap" {
        let w1 = weapon1.and_then(|w| base(w)).and_then(|b| b.base_type.as_deref()).unwrap_or("None");
        if w1 == "None" {
            ity == "Shield" || one(ity)
        } else if w1 == "Bow" {
            ity == "Quiver"
        } else if one(w1) {
            ity == "Shield" || (one(ity) && ((w1 == "Wand" && ity == "Wand") || (w1 != "Wand" && ity != "Wand")))
        } else {
            false
        }
    } else {
        false
    }
}

/// The engine mods of a passive node's parsed mod list, converted once per list and kept while it is. Node mod
/// lists are shared `Arc`s (the tree's own, or a conquest's replacement), and setup reads every allocated node's
/// mods at a dozen places per calculation. The entry holds the list, so its address can't be reused while cached.
pub(crate) fn node_mods(p: &std::sync::Arc<Vec<pom_engine::modparser::types::PMod>>) -> std::rc::Rc<Vec<Mod>> {
    type Entry = (std::sync::Arc<Vec<pom_engine::modparser::types::PMod>>, std::rc::Rc<Vec<Mod>>);
    thread_local! {
        static CACHE: std::cell::RefCell<pom_engine::fxhash::HashMap<usize, Entry>> = std::cell::RefCell::new(Default::default());
    }
    let key = std::sync::Arc::as_ptr(p) as usize;
    if let Some(m) = CACHE.with(|c| c.borrow().get(&key).filter(|e| std::sync::Arc::ptr_eq(&e.0, p)).map(|e| e.1.clone())) {
        return m;
    }
    let mods = std::rc::Rc::new(p.iter().map(pmod_to_mod).collect::<Vec<Mod>>());
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= 50_000 {
            c.clear();
        }
        c.insert(key, (p.clone(), mods.clone()));
    });
    mods
}

/// POM_STAGE_SNAPSHOTS=1: keep the per-stage snapshots in `Env::stage_snapshots` (each copies the output map or a
/// store). Only `defence_estimations`, which FullDPS reads, is always kept.
pub(crate) fn stage_snapshots_on() -> bool {
    pom_engine::env::var_os("POM_STAGE_SNAPSHOTS").is_some()
}

/// Per loaded tree: lowercased node `dn` -> ids of the tree nodes with it, and the ids of tree nodes without a `dn`.
fn tree_dn_index(tree: &pom_passives::treedata::TreeData) -> std::rc::Rc<(HashMap<String, Vec<i64>>, Vec<i64>)> {
    thread_local! {
        static INDEX: std::cell::RefCell<HashMap<usize, std::rc::Rc<(HashMap<String, Vec<i64>>, Vec<i64>)>>> = std::cell::RefCell::new(HashMap::default());
    }
    let key = tree as *const _ as usize;
    if let Some(i) = INDEX.with(|c| c.borrow().get(&key).cloned()) {
        return i;
    }
    let mut by_dn: HashMap<String, Vec<i64>> = HashMap::default();
    let mut no_dn = Vec::new();
    for (&id, v) in &tree.nodes {
        match v.get("dn").and_then(|d| d.as_str()) {
            Some(dn) => by_dn.entry(dn.to_lowercase()).or_default().push(id),
            None => no_dn.push(id),
        }
    }
    let i = std::rc::Rc::new((by_dn, no_dn));
    INDEX.with(|c| c.borrow_mut().insert(key, i.clone()));
    i
}

/// A copy of `a` with `output` in place of its output table (which is not copied).
pub(crate) fn actor_with_output(a: Option<&pom_engine::modstore::types::Actor>, output: HashMap<Sym, f64>) -> pom_engine::modstore::types::Actor {
    use pom_engine::modstore::types::Actor;
    let Some(a) = a else { return Actor { output, ..Default::default() } };
    Actor {
        output,
        mana_efficiency: a.mana_efficiency,
        weapon1: a.weapon1.clone(),
        weapon2: a.weapon2.clone(),
        minion_monster_tags: a.minion_monster_tags.clone(),
        reservations: a.reservations.clone(),
        items: a.items.clone(),
        item_search: a.item_search.clone(),
        related: a.related.clone(),
    }
}

thread_local! {
    /// Set by `Session::eval_nodes` when no FullDPS stat is asked for: `build_env` keeps no pre-run copy for the
    /// FullDPS rows (they stay skipped all the same).
    pub(crate) static SKIP_PRISTINE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Set by `Session::eval_nodes` when no requested stat comes from the defence estimations or the cost
    /// warnings (upstream's `skipEHP`); both stages are then skipped.
    pub(crate) static SKIP_OPTIONAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// While `Some`, the output keys those two stages write or change are collected here.
    pub(crate) static OPTIONAL_KEYS: std::cell::RefCell<Option<pom_engine::fxhash::HashSet<String>>> = const { std::cell::RefCell::new(None) };
}

fn record_optional_keys(before: &HashMap<String, f64>, after: &HashMap<String, f64>, lists: &[String]) {
    OPTIONAL_KEYS.with(|k| {
        if let Some(set) = k.borrow_mut().as_mut() {
            for (key, v) in after {
                if before.get(key).map_or(true, |b| b.to_bits() != v.to_bits()) {
                    set.insert(key.clone());
                }
            }
            set.extend(lists.iter().cloned());
        }
    });
}

/// The calc stages `run` can end after, in order (see `stage_end`).
pub(crate) const RUN_STAGES: [&str; 8] = ["merge_keystones", "minion_counts", "flasks", "attributes", "life_mana_charges", "buffs", "defence", "defence_estimations"];

thread_local! {
    /// Set by `Session::eval_nodes`: end `run` after this stage (every requested stat is final by then).
    pub(crate) static STOP_AFTER: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    /// While `Some`: the output as of the last stage end, and for each key the last stage that changed it.
    pub(crate) static LEARN_STAGES: std::cell::RefCell<Option<(HashMap<String, f64>, HashMap<String, usize>)>> = const { std::cell::RefCell::new(None) };
}

/// End of calc stage `i`: records which keys it changed (when learning) and says whether `run` stops here.
fn stage_end(env: &Env, i: usize) -> bool {
    LEARN_STAGES.with(|l| {
        if let Some((prev, last)) = l.borrow_mut().as_mut() {
            for (k, v) in &env.output {
                if prev.get(k).map_or(true, |p| p.to_bits() != v.to_bits()) {
                    last.insert(k.clone(), i);
                }
            }
            *prev = env.output.clone();
        }
    });
    STOP_AFTER.with(|c| c.get()) == Some(i)
}

/// `tree.keystoneMap`'s entries with stat lines, as (name, mods sourced `Tree:<id>`), in map order; per tree.
fn tree_keystone_mods(tree_data: &pom_passives::treedata::TreeData) -> std::rc::Rc<Vec<(String, Vec<Mod>)>> {
    thread_local! {
        static MEMO: std::cell::RefCell<HashMap<usize, std::rc::Rc<Vec<(String, Vec<Mod>)>>>> = std::cell::RefCell::new(HashMap::default());
    }
    let key = tree_data as *const _ as usize;
    if let Some(v) = MEMO.with(|m| m.borrow().get(&key).cloned()) {
        return v;
    }
    let mut out = Vec::new();
    if let Some(km) = tree_data.section("keystoneMap").and_then(|v| v.as_object()) {
        for (name, entry) in km {
            let node = tree_data.deref(entry);
            let Some(sd) = node.get("sd").and_then(|v| v.as_array()) else { continue };
            let sd: Vec<String> = sd.iter().filter_map(|v| v.as_str().map(|x| x.to_string())).collect();
            let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let source: std::sync::Arc<str> = format!("Tree:{id}").into();
            let mods: Vec<Mod> = pom_passives::stats::process_stats(&sd, 0)
                .iter()
                .map(|p| {
                    let mut m = pmod_to_mod(p);
                    m.source = Some(source.clone());
                    m
                })
                .collect();
            out.push((name.to_string(), mods));
        }
    }
    let v = std::rc::Rc::new(out);
    MEMO.with(|m| m.borrow_mut().insert(key, v.clone()));
    v
}

/// Whether `xml_text` contains any of `needles` (none containing `<`, so no match spans the `<Tree>` element's
/// edges). The text outside `<Tree>` is searched once per its key; `<Tree>` itself every time.
fn xml_contains_any(xml_text: &str, needles: &'static [&'static str]) -> bool {
    let Some(tree) = pom_skills::xmlskills::xml_section(xml_text, "Tree") else { return needles.iter().any(|n| xml_text.contains(n)) };
    if needles.iter().any(|n| tree.contains(n)) {
        return true;
    }
    thread_local! {
        static MEMO: std::cell::RefCell<HashMap<((u64, usize), usize), bool>> = std::cell::RefCell::new(HashMap::default());
    }
    let key = (pom_skills::xmlskills::xml_key_without_tree(xml_text), needles.as_ptr() as usize);
    if let Some(v) = MEMO.with(|m| m.borrow().get(&key).copied()) {
        return v;
    }
    let start = tree.as_ptr() as usize - xml_text.as_ptr() as usize;
    let (before, after) = (&xml_text[..start], &xml_text[start + tree.len()..]);
    let v = needles.iter().any(|n| before.contains(n) || after.contains(n));
    MEMO.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() > 1000 {
            m.clear();
        }
        m.insert(key, v);
    });
    v
}

/// What an optimizer evaluation needs to know about a build's allocated passives to take a node away by patching
/// the finished setup (see `Session::eval_nodes`).
#[derive(Clone, Default)]
pub(crate) struct TreeFacts {
    /// Allocated node -> whether taking it away only removes its own mods from the player store (and, for a
    /// notable, lowers the allocated-notable count): a Normal or Notable node, not an ascendancy node, socket,
    /// tattoo or granted node, in no jewel's radius, and with none of the mods that setup reads elsewhere.
    pub simple: pom_engine::fxhash::HashMap<i64, (bool, bool)>,
    /// Allocated node -> its allocated neighbours (links either way).
    pub neighbours: pom_engine::fxhash::HashMap<i64, Vec<i64>>,
    /// Allocated mastery with a selected effect -> its type (the name `allocatedMasteryTypes` counts it under).
    pub mastery_type: pom_engine::fxhash::HashMap<i64, String>,
    /// The spec's allocated notable, keystone and mastery counts.
    pub counts: (usize, usize, usize),
    /// Allocated keystone -> its name (`env.keystone_mods` holds one entry per distinct name, in id order).
    pub keystone: pom_engine::fxhash::HashMap<i64, String>,
    /// Allocated socket -> the plain jewel in it (see `plain_jewel`), whose removal a patch can undo.
    pub jewel: pom_engine::fxhash::HashMap<i64, i64>,
    /// Allocated large socket holding a cluster jewel -> its allocated subgraph nodes (all simple), which go with it.
    pub cluster: pom_engine::fxhash::HashMap<i64, Vec<i64>>,
    /// Nodes items grant (allocated in the calc whether or not the spec has them).
    pub granted: Vec<i64>,
}

/// A socketed jewel whose whole effect on setup is its own mods in the player store, its item counts
/// (`item_setup_multipliers`) and its slot in the item actor: an ordinary Jewel (not abyss, cluster or timeless),
/// with no radius, no "Limited to", not The Adorned, and none of the mods setup reads elsewhere.
fn plain_jewel(item: &pom_item::Item, game: &GameData, adorned: bool, lone: (bool, bool)) -> bool {
    item.cluster_jewel.is_none() && plain_jewel_except_cluster(item, game, adorned, lone)
}

/// `plain_jewel` without the cluster-jewel exclusion.
/// `lone.0`: no other item in the build has this base (setup counts abyss jewel types once per base); `lone.1`: the
/// allocated sockets hold no more jewels with this title than its "Limited to".
fn plain_jewel_except_cluster(item: &pom_item::Item, game: &GameData, adorned: bool, lone: (bool, bool)) -> bool {
    item.item_type.as_deref() == Some("Jewel")
        && item.jewel_radius_index.is_none()
        // ("Limited to": upstream drops copies past the limit, so within it removing one changes nothing else)
        && (item.limit.is_none() || lone.1)
        && !item.name.contains("The Adorned")
        // (a corrupted jewel is scaled only by a socketed The Adorned)
        && (!item.corrupted || !adorned)
        && item.jewel_data.jewel_inc_effect_from_class_start.is_none()
        // (a jewel with a conqueror converts passives, e.g. the abyss conquests in `read_abyss_conquests`)
        && item.jewel_data.conquered_by.is_none()
        && item.base_name.as_deref() != Some("Timeless Jewel")
        && item.base_name.as_deref().and_then(|n| game.item_bases.get(n)).and_then(|b| b.extra.get("subType")).and_then(|v| v.as_str()).is_none_or(|t| t != "Abyss" || lone.0)
        && !item_mods_for_slot(item, "Jewel 0").iter().any(|m| special_node_mod(m.name.as_str()) || m.tags.iter().any(|t| t.kind.as_str() == "ItemCondition"))
}

thread_local! {
    /// Nodes `Session::preview_add_nodes` counts as allocated for one calc (CalcSetup's `override.addNodes`): they join
    /// the granted nodes, which are collected whether or not the spec allocated them.
    pub(crate) static EXTRA_NODES: std::cell::RefCell<Vec<i64>> = const { std::cell::RefCell::new(Vec::new()) };
    /// Nodes `Session::preview_remove_nodes` takes out of the allocated set for one calc (CalcSetup's `override.removeNodes`).
    pub(crate) static REMOVE_NODES: std::cell::RefCell<Vec<i64>> = const { std::cell::RefCell::new(Vec::new()) };
    pub(crate) static CAPTURE_TREE_FACTS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static TREE_FACTS: std::cell::RefCell<Option<TreeFacts>> = const { std::cell::RefCell::new(None) };
}

/// Whether `Session::preview_add_nodes` counts this node as allocated for the calc in progress.
pub(crate) fn extra_node(id: i64) -> bool {
    EXTRA_NODES.with(|e| e.borrow().contains(&id))
}

/// Mods that setup reads outside the player store (item disabling, extra slots, equipment-bonus scaling, explode,
/// granted and supported skills, gem properties, skill disabling), or that feed skills (`Condition:`).
fn special_node_mod(name: &str) -> bool {
    name.starts_with("Condition:")
        || matches!(
            name,
            "CanNotUseItem" | "AdditionalRingSlot" | "EffectOfBonusesFromQuiver" | "EffectOfBonusesFromGloves" | "EffectOfBonusesFromBoots"
                | "CanExplode" | "ExtraSupport" | "ExtraSkill" | "GemProperty" | "SocketProperty" | "ExtraSkillMod" | "ExtraSkillStat"
                | "DisableSkill" | "EnableSkill" | "GrantedPassive" | "GrantedAscendancyNode"
                // (these change other nodes or grant keystones)
                | "ExtraJewelFunc" | "NodeModifier" | "PassiveSkillHasOtherEffect" | "Keystone"
        )
}

fn tree_facts(spec: &pom_passives::spec::PassiveSpec, radius_jewels: &[radius::RadiusJewel], extra_radius_nodes: &[i64], granted: &pom_engine::fxhash::HashSet<i64>) -> TreeFacts {
    let mut facts = TreeFacts::default();
    facts.granted = granted.iter().copied().collect();
    facts.counts = (spec.allocated_notable_count.max(0) as usize, spec.allocated_keystone_count.max(0) as usize, spec.allocated_mastery_count.max(0) as usize);
    let alloc: Vec<&pom_passives::node::Node> = spec.nodes.values().filter(|n| n.alloc).map(|n| &**n).collect();
    let alloc_set: pom_engine::fxhash::HashSet<i64> = alloc.iter().map(|n| n.id).collect();
    for n in &alloc {
        for &l in n.linked_ids.iter() {
            if alloc_set.contains(&l) && l != n.id {
                let e = facts.neighbours.entry(n.id).or_default();
                if !e.contains(&l) {
                    e.push(l);
                }
                let e = facts.neighbours.entry(l).or_default();
                if !e.contains(&n.id) {
                    e.push(n.id);
                }
            }
        }
    }
    for n in &alloc {
        let mastery = n.kind == "Mastery" && spec.mastery_selections.contains_key(&n.id);
        // A keystone's mods reach the calc only through `keystone_mods` (patched by name); setup reads two by name.
        let keystone = n.kind == "Keystone" && !matches!(n.dn.as_str(), "Hollow Palm Technique" | "Necromantic Aegis");
        if n.kind == "Keystone" {
            facts.keystone.insert(n.id, n.dn.to_string());
        }
        let empty_socket = (n.is_jewel_socket || n.expansion_jewel.is_some()) && spec.jewels.get(&n.id).is_none_or(|&i| i <= 0);
        let kind_ok = n.kind == "Normal" || n.kind == "Notable" || mastery || keystone || (n.kind == "Socket" && empty_socket);
        let simple = kind_ok
            && (empty_socket || (!n.is_jewel_socket && n.expansion_jewel.is_none()))
            && !n.is_tattoo
            && n.override_type.is_none()
            && !granted.contains(&n.id)
            && !extra_radius_nodes.contains(&n.id)
            && !radius_jewels.iter().any(|rj| rj.nodes.contains(&n.id))
            && n.intuitive_leap_likes_affecting.is_empty()
            && n.conquered_by.is_none()
            && !n.mods.iter().any(|m| special_node_mod(&m.name));
        facts.simple.insert(n.id, (simple, n.kind == "Notable"));
        if mastery {
            let name = spec.tree.node(n.id).and_then(|t| t.get("dn")).and_then(|d| d.as_str()).map(|s| s.to_string()).unwrap_or_else(|| n.dn.to_string());
            facts.mastery_type.insert(n.id, name);
        }
    }
    facts
}

/// POM_PROF=1: prints the time each calc stage took, in ms, to stderr.
pub(crate) struct Prof(Option<std::time::Instant>);
impl Prof {
    pub(crate) fn new() -> Prof { Prof(pom_engine::env::var_os("POM_PROF").map(|_| std::time::Instant::now())) }
    pub(crate) fn lap(&mut self, label: &str) {
        mem_probe(label);
        if let Some(t) = self.0 {
            eprintln!("PROF {label} {:.1}", t.elapsed().as_secs_f64() * 1000.0);
            self.0 = Some(std::time::Instant::now());
        }
    }
}

thread_local! {
    static ITEM_CACHE_MAX: std::cell::Cell<usize> = const { std::cell::Cell::new(5000) };
}

/// How many parsed items this thread keeps (`parsed_item`). The item ranking workers keep fewer: each would otherwise end
/// up with its own copy of every item it was ever handed, eight copies of the whole unique list.
pub fn set_item_cache_max(n: usize) {
    ITEM_CACHE_MAX.with(|m| m.set(n));
}

/// One saved `<Item>` parsed and its mod lists built. The result depends only on the item's text, id and
/// `<ModRange>` overrides, so it is kept per thread: reloading a build after a tree click, or after changing
/// one item, re-parses only what changed.
fn parsed_item(raw: &str, id: i64, overrides: &[(i64, f64)], game: &'static GameData) -> std::rc::Rc<pom_item::Item> {
    // Keyed by the item text, then (id, overrides); items are shared, not copied, into each build.
    type Entry = (i64, Vec<(i64, u64)>, std::rc::Rc<pom_item::Item>);
    thread_local! {
        static ITEMS: std::cell::RefCell<(usize, HashMap<String, Vec<Entry>>)> = std::cell::RefCell::new((0, HashMap::default()));
    }
    let ov: Vec<(i64, u64)> = overrides.iter().map(|&(i, r)| (i, r.to_bits())).collect();
    if let Some(item) = ITEMS.with(|c| c.borrow().1.get(raw).and_then(|v| v.iter().find(|e| e.0 == id && e.1 == ov).map(|e| e.2.clone()))) {
        return item;
    }
    let mut item = pom_item::parse::parse_raw_with_id(raw, false, Some(id), game);
    if !overrides.is_empty() {
        let buff = item.base_name.as_ref().and_then(|n| game.item_bases.get(n)).and_then(|b| ["flask", "tincture"].iter().find_map(|k| b.extra.get(*k).and_then(|v| v.get("buff")).and_then(|x| x.as_array()).map(|a| a.len() as i64))).unwrap_or(0);
        item = pom_item::parse::parse_raw_with_mod_range_overrides(raw, false, Some(id), game, buff, overrides);
    } else {
        pom_item::buildmod::build_mod_lists(&mut item, game);
    }
    let item = std::rc::Rc::new(item);
    ITEMS.with(|c| {
        let mut c = c.borrow_mut();
        if c.0 > ITEM_CACHE_MAX.with(|m| m.get()) {
            *c = (0, HashMap::default());
        }
        c.0 += 1;
        c.1.entry(raw.to_string()).or_default().push((id, ov, item.clone()));
    });
    item
}

/// The active config set's settled mods (`ConfigTab:BuildModList` twice, as two OnFrame passes settle the
/// placeholders), with the custom-modifier blocks applied to the player list: (player mods, enemy mods, placeholders).
/// It depends only on the config set and the character level, both outside `<Tree>`, so it is kept per build text;
/// setup reads it four times.
type SettledConfig = std::rc::Rc<(Vec<Mod>, Vec<Mod>, HashMap<String, pom_config::types::OwnedOptionValue>)>;
fn settled_config(xml_text: &str, game: &'static GameData, character_level: f64) -> Option<SettledConfig> {
    pom_skills::xmlskills::memo_sections("settled_config", xml_text, &["Config", "Build"], || {
        let config_data = parse_config_memo(xml_text).ok()?;
        let set = config_data.config_sets.get(&config_data.active_config_set_id)?;
        let handlers = pom_config::handler_map();
        let (_m1, _e1, ph1) = pom_config::build_mod_list(&set.input, set.placeholder.clone(), game, character_level as i64, handlers);
        let (mut mods2, enemy2, ph2) = pom_config::build_mod_list(&set.input, ph1, game, character_level as i64, handlers);
        pom_config::xml::apply_custom_mods(&set.custom_mods, &mut mods2);
        Some(std::rc::Rc::new((mods2, enemy2, ph2)))
    })
}

/// `<Items>` as setup reads it: every `<Item>` as (id, text with its variant attributes, legacy `<ModRange>`
/// overrides) in document order, and the active item set as (`useSecondWeaponSet`, its `<Slot>`s as (name,
/// itemId or 0, `active`)). Kept per `<Items>` text, so a tree click or a config edit doesn't re-read it.
#[derive(Default)]
struct ItemsSection {
    items: Vec<(i64, String, Vec<(i64, f64)>)>,
    set: Option<(bool, Vec<(Option<String>, i64, bool)>)>,
}

fn items_section(xml_text: &str) -> std::rc::Rc<ItemsSection> {
    pom_skills::xmlskills::memo_sections("items_section", xml_text, &["Items"], || {
        let mut out = ItemsSection::default();
        let Some(Ok(doc)) = pom_skills::xmlskills::xml_section(xml_text, "Items").map(Document::parse) else { return std::rc::Rc::new(out) };
        let items_el = doc.root_element();
        for item_el in children(&items_el, "Item") {
            let Some(id) = attr_i64(&item_el, "id") else { continue };
            let raw = inject_variant_attrs(&concat_text(&item_el), &item_el);
            // Legacy `<ModRange id range>` children (ItemsTab.lua:1249-1262): overwrite `modLine.range` by
            // global index over the post-sort mod line lists, before `BuildModList`.
            let overrides: Vec<(i64, f64)> = children(&item_el, "ModRange").map(|c| (attr_i64(&c, "id").unwrap_or(0), attr_f64(&c, "range").unwrap_or(1.0))).collect();
            out.items.push((id, raw, overrides));
        }
        let active_set = attr_i64(&items_el, "activeItemSet").unwrap_or(1);
        // Legacy files keep `<Slot>` directly under `<Items>` (ItemsTab.lua:1271-1279); with no `<ItemSet>` at all they
        // become set 1 (Load's `NewItemSet(1)` + `SetActiveItemSet` keeps the slots' selections).
        let set_el = children(&items_el, "ItemSet").find(|s| attr_i64(s, "id").unwrap_or(1) == active_set).or_else(|| children(&items_el, "ItemSet").next()).or_else(|| children(&items_el, "Slot").next().map(|_| items_el));
        if let Some(set_el) = set_el {
            let use_second = set_el.attribute("useSecondWeaponSet") == Some("true");
            let slots = children(&set_el, "Slot").map(|e| (e.attribute("name").map(|s| s.to_string()), attr_i64(&e, "itemId").unwrap_or(0), e.attribute("active") == Some("true"))).collect();
            out.set = Some((use_second, slots));
        }
        std::rc::Rc::new(out)
    })
}

/// `<Build level="...">`, read from `<Build>`'s start tag alone.
fn build_level(xml_text: &str) -> Result<f64, String> {
    pom_skills::xmlskills::memo_sections("build_level", xml_text, &["Build"], || {
        let sec = pom_skills::xmlskills::xml_section(xml_text, "Build").ok_or("missing <Build>")?;
        let tag_end = sec.find('>').ok_or("missing <Build>")? + 1;
        let tag = if sec[..tag_end].ends_with("/>") { sec[..tag_end].to_string() } else { format!("{}</Build>", &sec[..tag_end]) };
        let doc = Document::parse(&tag).map_err(|e| format!("xml: {e}"))?;
        Ok(attr_f64(&doc.root_element(), "level").unwrap_or(1.0))
    })
}

/// Whether any `<Input name="{name}" boolean="true">` appears in the document (item and modifier text is escaped,
/// so a raw `<Input` is always a tag).
fn any_input_true(xml_text: &str, name: &'static str) -> bool {
    // `<Input>` tags sit outside `<Tree>`, so the answer is kept per the text outside it.
    thread_local! {
        static MEMO: std::cell::RefCell<HashMap<((u64, usize), &'static str), bool>> = std::cell::RefCell::new(HashMap::default());
    }
    let key = (pom_skills::xmlskills::xml_key_without_tree(xml_text), name);
    if let Some(v) = MEMO.with(|m| m.borrow().get(&key).copied()) {
        return v;
    }
    let v = any_input_true_live(xml_text, name);
    MEMO.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() > 1000 {
            m.clear();
        }
        m.insert(key, v);
    });
    v
}

fn any_input_true_live(xml_text: &str, name: &str) -> bool {
    let b = xml_text.as_bytes();
    let mut from = 0;
    while let Some(i) = xml_text[from..].find("<Input") {
        let at = from + i;
        from = at + 6;
        if !matches!(b.get(at + 6), Some(b' ' | b'>' | b'/' | b'\t' | b'\r' | b'\n')) {
            continue;
        }
        let Some(end) = xml_text[at..].find('>') else { break };
        let tag = &xml_text[at..at + end + 1];
        if !tag.contains(name) {
            continue;
        }
        let tag = if tag.ends_with("/>") { tag.to_string() } else { format!("{tag}</Input>") };
        if let Ok(doc) = Document::parse(&tag) {
            let n = doc.root_element();
            if n.attribute("name") == Some(name) && n.attribute("boolean") == Some("true") {
                return true;
            }
        }
    }
    false
}

thread_local! {
    /// Set by a session whose XML was already checked whole: its later edits are well-formed splices, and a tree
    /// click's `<Tree>` is parsed anyway.
    pub(crate) static XML_CHECKED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// `pom_config::xml::parse_config`, kept while `<Config>` is unchanged.
fn parse_config_memo(xml_text: &str) -> Result<pom_config::xml::ConfigData, String> {
    pom_skills::xmlskills::memo_sections("parse_config", xml_text, &["Config"], || pom_config::xml::parse_config(xml_text))
}

pub fn build_env(xml_text: &str, game: &'static GameData) -> Result<Env, String> {
    let _key_scope = pom_skills::xmlskills::scope_xml_key(xml_text);
    let run_links = std::rc::Rc::new(pom_engine::modstore::types::RunLinks::default());
    let _links_scope = pom_engine::modstore::types::use_run_links(&run_links);
    let mut pf = Prof::new();
    // Setup reads four parts of the document, each parsed on its own: `<Build>`'s start tag, `<Tree>`, `<Items>`
    // (kept per its text, see `items_section`) and every `<Input>` tag. The whole document is still checked once
    // per distinct text outside `<Tree>`, so a malformed build fails the same way.
    if !XML_CHECKED.with(|c| c.get()) {
        pom_skills::xmlskills::memo_xml("xml_valid", xml_text, || Document::parse(xml_text).map(|_| ()).map_err(|e| format!("xml: {e}")))?;
    }
    pf.lap("xml_parse");
    let character_level = build_level(xml_text)?;

    // ---- passives ----
    let tree_text = pom_skills::xmlskills::xml_section(xml_text, "Tree").ok_or("missing <Tree>")?;
    // The active spec's version, from the spec parse (kept per `<Tree>` text) that the passives need anyway; a
    // `<Tree>` that doesn't parse takes the original path, which reports the error.
    let tree_version = match pom_passives::xmlspec::parse_active_spec(xml_text) {
        Ok(p) => p.tree_version.unwrap_or_else(|| "3_6".to_string()),
        Err(e) if e == "no <Spec> elements" => "3_29".to_string(), // TreeTab:Load: no <Spec> -> latestTreeVersion
        Err(_) => {
            let tree_doc = Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
            let tree_el = tree_doc.root_element();
            let active_spec = attr_i64(&tree_el, "activeSpec").unwrap_or(1).max(1) as usize;
            let specs: Vec<XmlNode> = children(&tree_el, "Spec").collect();
            match specs.get(active_spec - 1).or_else(|| specs.first()) {
                Some(spec_el) => spec_el.attribute("treeVersion").unwrap_or("3_6").to_string(),
                None => "3_29".to_string(),
            }
        }
    };
    let tree_data = cached_tree(&tree_version)?;
    pf.lap("cached_tree");

    // ---- items: parse + build every <Item>, keep by id ----
    let mut items: HashMap<i64, std::rc::Rc<pom_item::Item>> = HashMap::default();
    let items_sec = items_section(xml_text);
    for (id, raw, overrides) in &items_sec.items {
        let item = parsed_item(raw, *id, overrides, game);
        // ItemsTab.lua:1266: an item whose base type isn't in the game data (`item.base == nil`) is dropped.
        if item.base_name.as_ref().is_some_and(|n| game.item_bases.contains_key(n)) {
            items.insert(*id, item);
        }
    }

    pf.lap("tree_and_items");
    // ---- cluster/timeless jewels: build the node id -> ClusterJewelInput map from each socketed jewel's parsed
    // item data (`pom_item::Item::jewel_data`/`cluster_jewel`/`jewel_radius_index`), then call the
    // `_with_jewels_and_timeless` variant of `spec_from_xml`. Without the jewels, a build with a cluster, timeless or
    // radius jewel gets the wrong passive tree. `parse_active_spec`'s own `<Sockets><Socket nodeId itemId/>` read is
    // reused so the node-id/item-id pairing stays in sync with what `spec_from_xml_with_jewels_and_timeless`
    // resolves internally.
    let mut jewel_inputs: HashMap<i64, pom_passives::clusterjewel::ClusterJewelInput> = HashMap::default();
    let mut jewel_sockets: Vec<(i64, i64)> = Vec::new();
    if let Ok(parsed) = pom_passives::xmlspec::parse_active_spec(xml_text) {
        for (node_id, item_id) in &parsed.jewels {
            if let Some(item) = items.get(item_id) {
                jewel_inputs.insert(*node_id, cluster_jewel_input_from_item(item));
            }
        }
        jewel_sockets = parsed.jewels;
    }
    let cj_data = cluster_jewel_data();
    let timeless_data = timeless_jewel_data();
    let jewel_seed = pom_passives::active_spec_jewel_seed(&jewel_sockets);
    // Stats never read the tree's path distances, so skip that search here.
    pom_passives::spec::SKIP_PATHS.with(|c| c.set(true));
    let spec = pom_passives::spec_from_xml_full(tree_data, xml_text, Some(cj_data), &jewel_inputs, timeless_data, Some(&jewel_seed));
    pom_passives::spec::SKIP_PATHS.with(|c| c.set(false));
    let mut spec = spec?;
    // `Session::preview_remove_nodes`: CalcSetup's `override.removeNodes` for this calculation.
    REMOVE_NODES.with(|r| {
        let r = r.borrow();
        if !r.is_empty() {
            spec.remove_for_calc(&r);
        }
    });
    // A conquering jewel in an allocated socket whose table is not installed: its conquered nodes cannot be worked out,
    // so the numbers leave the jewel out. The sidebar shows this (`TimelessDataWarning`) instead of staying quiet.
    let timeless_warning: Option<String> = {
        let mut names: Vec<String> = Vec::new();
        let mut sockets: Vec<(i64, i64)> = spec.jewels.iter().filter(|(_, &i)| i > 0).map(|(&n, &i)| (n, i)).collect();
        sockets.sort_unstable();
        for (node, item_id) in sockets {
            let Some(item) = items.get(&item_id) else { continue };
            let Some(cb) = item.jewel_data.conquered_by.as_ref() else { continue };
            if !spec.nodes.get(&node).is_some_and(|n| n.alloc) {
                continue;
            }
            let Some(jt) = pom_passives::spec::timeless_jewel_type_by_conqueror(&cb.conqueror_type) else { continue };
            if !timeless_data.is_some_and(|d| d.table_present(jt)) {
                let name = item.title.clone().unwrap_or_else(|| item.name.clone());
                let name = name.split(" [").next().unwrap_or(&name).to_string();
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
        (!names.is_empty()).then(|| format!("Timeless jewel data is not installed; numbers for this build leave out {}", names.join(", ")))
    };
    let points_used = spec.count_alloc_nodes().0;
    // `self.jewels` after `ApplyLegacyClusterNodeRemap` (a legacy-format spec can move a jewel to a
    // different socket id); a `0` entry is an empty socket.
    let jewel_sockets: Vec<(i64, i64)> = spec.jewels.iter().filter(|(_, &i)| i > 0).map(|(&n, &i)| (n, i)).collect();

    pf.lap("spec");
    // ---- active ItemSet's slot -> itemId (+ active flag) map ----
    let mut slots: Vec<(String, i64, bool)> = Vec::new();
    // Every valid slot selection of the active set under its own name (`build.itemsTab.slots`), swap slots included.
    let mut raw_slots: Vec<(String, i64)> = Vec::new();
    // Weapon-set slots of the inactive set (item ids), still `env.explodeSources` (CalcSetup.lua:838 precedes the weaponSet skip).
    let mut inactive_weapon_slots: HashMap<String, i64> = HashMap::default();
    {
        if let Some((use_second, set_slots)) = &items_sec.set {
            let use_second = *use_second;
            let raw_sel: HashMap<String, i64> = set_slots.iter().filter_map(|(n, id, _)| Some((n.clone()?, *id))).collect();
            let w1_valid = |w1_name: &str| -> Option<&pom_item::Item> {
                let it = items.get(raw_sel.get(w1_name)?)?;
                item_valid_for_slot(it, w1_name, None, game).then_some(it)
            };
            for (slot_name, item_id, slot_active) in set_slots {
                let Some(name) = slot_name.as_deref() else { continue };
                let item_id = *item_id;
                if item_id == 0 {
                    continue;
                }
                // `ItemSlotClass:Populate` (ItemSlotControl.lua:105): a selection that is not valid for its
                // slot (`ItemsTab:IsItemValidForSlot`, e.g. a quiver with no bow) is reset to empty.
                if let Some(it) = items.get(&item_id) {
                    let w1 = w1_valid(if name.contains("Swap") { "Weapon 1 Swap" } else { "Weapon 1" });
                    if !item_valid_for_slot(it, name, w1, game) {
                        continue;
                    }
                }
                // ItemsTab.lua:153-196: every "Weapon N" slot, its "Weapon N Abyssal Socket i"
                // slots (weaponSet 1) and their " Swap" twins (weaponSet 2). CalcSetup.lua:840-845
                // skips the inactive set's slots and, for the active second set, strips " Swap".
                raw_slots.push((name.to_string(), item_id));
                let mut name = name.to_string();
                if name.starts_with("Weapon") {
                    let swap = name.contains(" Swap");
                    if swap != use_second {
                        inactive_weapon_slots.insert(name.clone(), item_id);
                        continue;
                    }
                    if swap {
                        // The abyss jewel of a swapped weapon counts: the second pass over `orderedSlots` (CalcSetup.lua:1025)
                        // reads `items[slot.slotName]` by the merged name, so it meets the jewel in the plain
                        // "Weapon N Abyssal Socket i" slot, whose parent slot is the plain "Weapon N" (the swapped weapon).
                        name = name.replace(" Swap", "");
                    }
                }
                // CalcSetup.lua:805-812: no item in "Ring 3" unless The Unseen Hand (`AdditionalRingSlot`)
                // is allocated; grafts only exist on 3_27 trees.
                if name == "Ring 3" && !spec.nodes.values().any(|n| n.alloc && n.mods.iter().any(|m| m.name == "AdditionalRingSlot")) {
                    continue;
                }
                if (name == "Graft 1" || name == "Graft 2") && !tree_version.contains("3_27") {
                    continue;
                }
                slots.push((name, item_id, *slot_active));
            }
        }
    }

    pf.lap("slots");
    // CalcSetup.lua:942-1006: items disabled by `CanNotUseItem`/`DisablesItem` mods (tree nodes, other items).
    {
        let disables = |m: &Mod| -> Option<(String, Option<String>)> {
            if m.name.as_str() != "CanNotUseItem" {
                return None;
            }
            let t = m.tags.iter().find(|t| t.kind.as_str() == "DisablesItem")?;
            let slot = match t.get(pom_engine::sym!("slotName")) {
                pom_engine::value::Value::Str(x) => x.to_string(),
                _ => return None,
            };
            let excl = match t.get(pom_engine::sym!("excludeItemType")) {
                pom_engine::value::Value::Str(x) => Some(x.to_string()),
                _ => None,
            };
            Some((slot, excl))
        };
        let type_of = |slots: &Vec<(String, i64, bool)>, name: &str| -> Option<String> { slots.iter().find(|(n, _, _)| n == name).and_then(|(_, id, _)| items.get(id)).and_then(|it| it.item_type.clone()) };
        let mut disabled: HashMap<String, String> = HashMap::default();
        let mut disablers: Vec<(String, String)> = Vec::new();
        let mut set_disabler = |k: String, v: String, disabled: &mut HashMap<String, String>| {
            disabled.insert(v.clone(), k.clone());
            if let Some(e) = disablers.iter_mut().find(|(a, _)| *a == k) {
                e.1 = v;
            } else {
                disablers.push((k, v));
            }
        };
        let mut node_ids: Vec<i64> = spec.nodes.iter().filter(|(_, n)| n.alloc).map(|(k, _)| *k).collect();
        node_ids.sort_unstable();
        for nid in node_ids {
            for m in node_mods(&spec.nodes[&nid].mods).iter().cloned() {
                if let Some((slot, excl)) = disables(&m) {
                    if excl.is_some() && type_of(&slots, &slot) == excl {
                        continue;
                    }
                    set_disabler(format!("Tree:{nid}"), slot, &mut disabled);
                }
            }
        }
        for (slot_name, item_id, _) in slots.clone().iter() {
            let Some(item) = items.get(item_id) else { continue };
            for m in item_mods_for_slot(item, slot_name) {
                if let Some((slot, excl)) = disables(m) {
                    if excl.is_some() && type_of(&slots, &slot) == excl {
                        continue;
                    }
                    set_disabler(slot_name.clone(), slot, &mut disabled);
                }
            }
        }
        let dis_of = |k: &str| disablers.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        let mut visited: pom_engine::fxhash::HashSet<String> = Default::default();
        let mut true_disabled: pom_engine::fxhash::HashSet<String> = Default::default();
        for (start, _) in &disablers {
            let mut slot = start.clone();
            if visited.contains(&slot) {
                continue;
            }
            let mut chain: pom_engine::fxhash::HashSet<String> = pom_engine::fxhash::HashSet::default();
            chain.insert("slot".to_string());
            while let Some(d) = disabled.get(&slot) {
                slot = d.clone();
                if chain.contains(&slot) {
                    break;
                }
                chain.insert(slot.clone());
            }
            loop {
                visited.insert(slot.clone());
                let Some(n) = dis_of(&slot) else { break };
                slot = n;
                visited.insert(slot.clone());
                true_disabled.insert(slot.clone());
                match dis_of(&slot) {
                    Some(n) => slot = n,
                    None => break,
                }
                if visited.contains(&slot) {
                    break;
                }
            }
        }
        if !true_disabled.is_empty() {
            slots.retain(|(n, _, _)| !true_disabled.contains(n));
        }
    }

    pf.lap("disables");
    // CalcSetup.lua:1916-1925: an enabled Energy Blade gem restarts `initEnv` with `AffectedByEnergyBlade` set.
    let energy_blade = match (pom_skills::xmlskills::socket_groups_shared(xml_text), pom_skills::xmlskills::parse_build_meta(xml_text)) {
        (Ok(sg), Ok(meta)) => sg.iter().any(|g| {
            g.source.is_none()
                && g.enabled
                && pom_skills::xmlskills::slot_enabled(&g.slot, meta.use_second_weapon_set)
                && g.gem_list.iter().any(|gem| gem.enabled && (gem.gem_data.map_or(false, |gd| gd.granted_effect_id.as_deref() == Some("EnergyBlade")) || gem.granted_effect.map_or(false, |ge| ge.id.as_deref() == Some("EnergyBlade"))))
        }),
        _ => false,
    };
    // Energy Blade needs at least one equipped weapon, and every one must be of the gem's own weaponTypes (swords); upstream accepts any non-bow weapon.
    let energy_blade = energy_blade && (!pom_offence::data::pom_fixes_on() || {
        let allowed = pom_skills::data::all_skills().get("EnergyBlade").and_then(pom_skills::data::weapon_types).unwrap_or_default();
        let types: Vec<String> = slots
            .iter()
            .filter(|(n, _, _)| n == "Weapon 1" || n == "Weapon 2")
            .filter_map(|(_, id, _)| items.get(id))
            .filter_map(|it| it.weapon_data.as_ref().and_then(|w| w.first()).and_then(|v| v.get("type")).and_then(|t| t.as_str()).map(|t| t.to_string()))
            .collect();
        !types.is_empty() && types.iter().all(|t| allowed.contains(t))
    });
    // CalcSetup.lua:1118-1152: with the condition set, a non-bow weapon in Weapon 1/2 is swapped for the hidden
    // "Energy Blade One/Two Handed" base (the original item's mods are dropped, sockets are kept).
    // CalcSetup.lua:1070 records the requirements of the item before the swap.
    let mut eb_orig_reqs: HashMap<i64, [f64; 3]> = HashMap::default();
    if energy_blade {
        let mut next_id = -1000i64;
        for (slot_name, item_id, _) in slots.iter_mut() {
            if slot_name != "Weapon 1" && slot_name != "Weapon 2" {
                continue;
            }
            let Some(prev) = items.get(item_id) else { continue };
            let Some(ty) = prev.weapon_data.as_ref().and_then(|w| w.first()).and_then(|v| v.get("type")).and_then(|t| t.as_str()).map(|t| t.to_string()) else { continue };
            let Some(info) = pom_skills::data::weapon_type_info(&ty) else { continue };
            if ty == "Bow" {
                continue;
            }
            let name = if info.one_hand { "Energy Blade One Handed" } else { "Energy Blade Two Handed" };
            let mut it = pom_item::parse::parse_raw_with_id(&format!("Rarity: NORMAL\n{name}\n"), false, Some(next_id), game);
            it.sockets = prev.sockets.clone();
            it.abyssal_socket_count = prev.abyssal_socket_count;
            eb_orig_reqs.insert(next_id, [prev.requirements.str_mod.unwrap_or(0.0), prev.requirements.dex_mod.unwrap_or(0.0), prev.requirements.int_mod.unwrap_or(0.0)]);
            items.insert(next_id, std::rc::Rc::new(it));
            *item_id = next_id;
            next_id -= 1;
        }
    }

    pf.lap("energy_blade");
    let mut player = ModStore::new_list(None, None);
    if energy_blade {
        player.conditions.insert(pom_engine::sym!("AffectedByEnergyBlade"), true);
    }
    let mut enemy = ModStore::new_list(None, None);
    // `early_base`: CalcSetup.lua:590-673 puts initModDB, the player base mods, the bandit and the pantheon mods
    // into modDB before anything from config, items or the tree, and `ModDB:MoreInternal` rounds the product in
    // insertion order (a `Base` "Damage MORE" must precede tree ones). The pass further down still pushes the same
    // mods to `parent_level_mods` and the enemy store in its old order.
    {
        let early_cfg = parse_config_memo(xml_text)?;
        let early_set = early_cfg.config_sets.get(&early_cfg.active_config_set_id).ok_or("active <ConfigSet> missing")?;
        let early_str = |k: &str| match early_set.input.get(k) {
            Some(pom_config::types::OwnedOptionValue::Str(s)) => Some(s.to_string()),
            _ => None,
        };
        let early_res = match early_set.input.get("resistancePenalty") {
            Some(pom_config::types::OwnedOptionValue::Num(n)) => Some(*n),
            _ => None,
        };
        let early_cc = pom_calc::data::CharacterConstants::shared();
        let early_mode = pom_calc::setup::buff_mode();
        let early_init = pom_calc::setup::init_mod_db_shared(early_mode.buffs, early_mode.combat, early_mode.effective);
        for m in &early_init.mods {
            player.add_mod(m.clone());
        }
        let early_subset = pom_calc::setup::ConfigInputSubset { bandit: early_str("bandit"), resistance_penalty: early_res };
        for m in pom_calc::setup::player_base_mods(&early_cc, &tree_version, spec.cur_class_id, character_level, &early_subset) {
            player.add_mod(m);
        }
        for key in ["pantheonMajorGod", "pantheonMinorGod"] {
            let Some(god_name) = early_str(key).filter(|g| g.as_str() != "None") else { continue };
            let Ok(Some(pantheons)) = game.extra.get("pantheons") else { continue };
            let Some(souls) = pantheons.get(god_name.as_str()).and_then(|g| g.get("souls")).and_then(|s| s.as_array()) else { continue };
            let source: std::sync::Arc<str> = format!("Pantheon:{}", souls.first().and_then(|s| s.get("name")).and_then(|n| n.as_str()).unwrap_or("")).into();
            for soul in souls {
                for soul_mod in soul.get("mods").and_then(|m| m.as_array()).into_iter().flatten() {
                    let Some(line) = soul_mod.get("line").and_then(|l| l.as_str()) else { continue };
                    if let (Some(parsed), None) = pom_engine::modparser::parse_mod(line) {
                        for pmod in &parsed {
                            let mut m = pmod_to_mod(pmod);
                            m.source = Some(source.clone());
                            player.add_mod(m);
                        }
                    }
                }
            }
        }
    }
    pf.lap("early_base");
    let mut item_armour = HashMap::default();
    let mut weapon_data: HashMap<String, Vec<serde_json::Value>> = HashMap::default();
    let mut keystone_mods = Vec::new();
    let mut aegis_mod_list: Vec<Mod> = Vec::new();
    let mut weapon_mod_list1: Vec<Mod> = Vec::new();
    let necromantic_aegis = spec.nodes.get(&45175).map_or(false, |n| n.alloc && n.dn == "Necromantic Aegis");
    let mut keystone_map: HashMap<String, Vec<Mod>> = HashMap::default();
    let mut keystones_added = pom_engine::fxhash::HashSet::default();
    let mut attr_reqs: Vec<[f64; 3]> = Vec::new();
    let mut attr_req_srcs: Vec<bd_perform::ReqSrc> = Vec::new();
    let mut active_flask_mods = Vec::new();
    let (mut flask_removes_bleed, mut flask_life_per_s) = (false, 0.0_f64);
    let mut seen_flask_items: pom_engine::fxhash::HashSet<i64> = pom_engine::fxhash::HashSet::default();
    let mut active_tinctures: Vec<TinctureInput> = Vec::new();
    let mut flask_cond_info = Vec::new();
    let mut magic_utility_flasks: Vec<(String, bool, pom_calc::perform::FlaskInput, (String, bool, bool, f64, f64, f64, f64))> = Vec::new();
    // `env.player.itemList`: slot name -> equipped (non-flask, non-skipped) item, for `ItemCondition`.
    let mut item_list: Vec<(String, &pom_item::Item)> = Vec::new();

    let socket_groups = pom_skills::xmlskills::parse_active_socket_groups(xml_text).unwrap_or_default();
    // Stand-in for `env.initialNodeModDB` (CalcSetup.lua:774) in the Quiver/Gloves/Boots "bonuses gained from
    // equipped X" scaling: the allocated nodes' own plain mods for those three stats.
    let mut tree_bonus_store = ModStore::new_list(None, None);
    for n in spec.nodes.values().filter(|n| n.alloc) {
        // (`pmod_to_mod` keeps the name, so only the matching mods are converted)
        for pm in n.mods.iter().filter(|pm| matches!(pm.name.as_str(), "EffectOfBonusesFromQuiver" | "EffectOfBonusesFromGloves" | "EffectOfBonusesFromBoots")) {
            tree_bonus_store.add_mod(pmod_to_mod(pm));
        }
    }
    for (slot_name, item_id, active) in &slots {
        let Some(item) = items.get(item_id) else { continue };
        // CalcSetup.lua:846-849: a tree jewel socket ("Jewel <nodeId>") only counts when its node is
        // allocated; sockets from `<Spec><Sockets>` are merged by the socket loop below instead.
        if let Some(nid) = slot_name.strip_prefix("Jewel ").and_then(|r| r.parse::<i64>().ok()) {
            if !spec.nodes.get(&nid).map_or(false, |n| n.alloc) || jewel_sockets.iter().any(|(n, _)| *n == nid) {
                continue;
            }
        }
        // CalcSetup.lua:1051-1060: an abyss jewel in "<parent slot> Abyssal Socket <n>" only counts if
        // the parent item has at least n abyssal sockets, and its mods are scaled by the parent's
        // `socketedJewelEffectModifier`.
        let mut scale = 1.0;
        if let Some((parent_name, num)) = slot_name.split_once(" Abyssal Socket ") {
            let parent = slots.iter().find(|(n, _, _)| n == parent_name).and_then(|(_, id, _)| items.get(id));
            match (parent, num.parse::<i64>()) {
                (Some(p), Ok(n)) if p.abyssal_socket_count >= n => scale = p.socketed_jewel_effect_modifier,
                _ => continue,
            }
        }
        item_setup_multipliers(&mut player, game, slot_name, item);
        // CalcSetup.lua:1308-1351: socket counts of the item and the gems socketed in its slot.
        if !matches!(item.item_type.as_deref(), Some("Jewel") | Some("Flask") | Some("Tincture") | Some("Graft")) {
            let mut socketed: Vec<&pom_skills::xmlskills::GemInstance> = Vec::new();
            for g in &socket_groups {
                if g.source.is_none() && g.enabled && g.slot.as_deref() == Some(slot_name.as_str()) {
                    for gem in &g.gem_list {
                        if gem.gem_data.is_some() && gem.enabled {
                            socketed.push(gem);
                        }
                    }
                }
            }
            let (mut empty, mut sock_count) = ([0f64; 4], 0usize);
            for (i, sk) in item.sockets.iter().enumerate() {
                if let Some(ci) = ['R', 'G', 'B', 'W'].iter().position(|c| *c == sk.color) {
                    sock_count += 1;
                    if i + 1 > socketed.len() {
                        empty[ci] += 1.0;
                    }
                }
            }
            let mut colours = [0f64; 3];
            for gem in socketed.iter().take(sock_count) {
                let tags = &gem.gem_data.unwrap().tags;
                for (ci, t) in ["strength", "dexterity", "intelligence"].iter().enumerate() {
                    if tags.get(*t).copied().unwrap_or(false) {
                        colours[ci] += 1.0;
                    }
                }
            }
            let mut set = |name: String, v: f64| {
                player.multipliers.insert(Sym::new(&name), v);
            };
            set(format!("SocketedGemsIn{slot_name}"), sock_count.min(socketed.len()) as f64);
            set(format!("SocketedRedGemsIn{slot_name}"), colours[0]);
            set(format!("SocketedGreenGemsIn{slot_name}"), colours[1]);
            set(format!("SocketedBlueGemsIn{slot_name}"), colours[2]);
            set(format!("EmptySocketIn{slot_name}"), (sock_count as f64).min(empty.iter().sum()));
            for (nm, v) in [("EmptyRedSocketsInAnySlot", empty[0]), ("EmptyGreenSocketsInAnySlot", empty[1]), ("EmptyBlueSocketsInAnySlot", empty[2]), ("EmptyWhiteSocketsInAnySlot", empty[3])] {
                *player.multipliers.entry(Sym::new(nm)).or_insert(0.0) += v;
            }
        }
        if is_flask_slot(slot_name) {
            if let Some(bn) = item.base_name.as_deref() {
                if let Some(tincture) = game.item_bases.get(bn).and_then(|b| b.extra.get("tincture")) {
                    if *active {
                        let source = format!("Item:{}:{}", item.id.unwrap_or(-1), item.name);
                        let mut buff_mod_list = Vec::new();
                        for line in tincture.get("buff").and_then(|b| b.as_array()).into_iter().flatten().filter_map(|l| l.as_str()) {
                            if let (Some(mods), _) = pom_engine::modparser::parse_mod(line) {
                                for pm in &mods {
                                    let mut m = pom_engine::modparser::types::pmod_to_mod(pm);
                                    m.source = Some(std::sync::Arc::from(source.as_str()));
                                    buff_mod_list.push(m);
                                }
                            }
                        }
                        active_tinctures.push(TinctureInput {
                            base_name: bn.to_string(),
                            title: item.title.clone(),
                            unique: item.rarity == "UNIQUE" || item.rarity == "RELIC",
                            magic: item.rarity == "MAGIC",
                            quality: item.quality.unwrap_or(0.0),
                            effect_inc: item.tincture_data.as_ref().and_then(|f| f.get("effectInc")).and_then(|x| x.as_f64()).unwrap_or(0.0),
                            buff_mod_list,
                            mod_list: item_mods_for_slot(item, slot_name).to_vec(),
                        });
                    }
                    continue;
                }
            }
            // mergeFlasks input (CalcPerform.lua:1848+): the flask's own mod list plus its base type's
            // fixed buff list; tinctures have no flask base info and are skipped, as in the grader.
            if let Some(bn) = item.base_name.as_deref() {
                if let Some(info) = pom_calc::data::flask_base_info(bn) {
                    let source = format!("Item:{}:{}", item.id.unwrap_or(0), item.name);
                    let fd = |k: &str| item.flask_data.as_ref().and_then(|f| f.get(k)).and_then(|x| x.as_f64()).unwrap_or(0.0);
                    let cond_info = (bn.to_string(), info.is_life, info.is_mana, fd("instantPerc"), fd("instantLowLifePerc"), fd("gainMod"), fd("chargesUsed"));
                    let input = pom_calc::perform::FlaskInput {
                        base_name: bn.to_string(),
                        title: item.title.clone(),
                        is_unique_or_relic: item.rarity == "UNIQUE" || item.rarity == "RELIC",
                        is_magic: item.rarity == "MAGIC",
                        is_life_or_mana: info.is_life_or_mana,
                        is_life: info.is_life,
                        is_mana: info.is_mana,
                        instant_perc: fd("instantPerc"),
                        instant_low_life_perc: fd("instantLowLifePerc"),
                        name: item.name.clone(),
                        life_base: fd("lifeBase"),
                        mana_base: fd("manaBase"),
                        duration: fd("duration"),
                        life_effect_not_removed: item.flask_data.as_ref().and_then(|f| f.get("lifeEffectNotRemoved")).and_then(|x| x.as_bool()).unwrap_or(false),
                        mana_effect_not_removed: item.flask_data.as_ref().and_then(|f| f.get("manaEffectNotRemoved")).and_then(|x| x.as_bool()).unwrap_or(false),
                        effect_inc: item.flask_data.as_ref().and_then(|f| f.get("effectInc")).and_then(|x| x.as_f64()).unwrap_or(0.0),
                        buff_mod_list: pom_calc::perform::flask_buff_mod_list(bn, &source),
                        mod_list: item_mods_for_slot(item, slot_name).to_vec(),
                    };
                    let bleed_immune = Sym::new("BleedImmune");
                    flask_removes_bleed |= input.mod_list.iter().any(|m| m.name == bleed_immune && m.ty == ModType::Flag && m.value.truthy());
                    if input.is_life {
                        flask_life_per_s += input.life_base * (1.0 + input.effect_inc / 100.0) / input.duration.max(1.0);
                    }
                    if item.rarity == "MAGIC" && !(bn.contains("Life Flask") || bn.contains("Mana Flask") || bn.contains("Hybrid Flask")) {
                        magic_utility_flasks.push((slot_name.clone(), *active, input.clone(), cond_info.clone()));
                    }
                    // `env.flasks` is a set keyed by the item object: one item in several flask slots counts (and merges) once.
                    if *active && seen_flask_items.insert(*item_id) {
                        flask_cond_info.push(cond_info);
                        active_flask_mods.push(input);
                    }
                }
            }
            continue;
        }
        attr_reqs.push(eb_orig_reqs.get(item_id).copied().unwrap_or([item.requirements.str_mod.unwrap_or(0.0), item.requirements.dex_mod.unwrap_or(0.0), item.requirements.int_mod.unwrap_or(0.0)]));
        {
            attr_req_srcs.push(bd_perform::ReqSrc::Item { rarity: item.rarity.clone(), name: item.name.clone(), order: bd_perform::slot_order(slot_name) });
        }
        if item.name.contains("Kalandra's Touch") {
            // CalcSetup.lua:1189-1216: copies the other ring's mods (minus SocketedIn ones), sourced
            // to this item; only its own ExtraSkill mods survive.
            let other_slot = match slot_name.as_str() {
                "Ring 1" => Some("Ring 2"),
                "Ring 2" => Some("Ring 1"),
                _ => None,
            };
            let other = other_slot.and_then(|sn| slots.iter().find(|(n, _, _)| n == sn)).and_then(|(sn, id, _)| items.get(id).map(|it| (sn.as_str(), it)));
            if let Some((other_slot_name, other_item)) = other {
                if !other_item.name.contains("Kalandra's Touch") {
                    let source: std::sync::Arc<str> = format!("Item:{}:{}", item.id.unwrap_or(-1), item.name).into();
                    for m in item_mods_for_slot(other_item, other_slot_name) {
                        if m.tags.iter().any(|t| t.kind.as_str() == "SocketedIn") {
                            continue;
                        }
                        let mut mc = m.clone();
                        mc.source = Some(source.clone());
                        player.add_mod(mc);
                    }
                    let key = format!("{}Equipped", other_item.base_name.as_deref().unwrap_or("").replace(' ', ""));
                    *player.multipliers.entry(Sym::new(&key)).or_insert(0.0) += 1.0;
                    // "Adjust multipliers based on other ring" (CalcSetup.lua:1207-1214)
                    for (mult, prop) in [("CorruptedItem", "corrupted"), ("ShaperItem", "shaper"), ("ElderItem", "elder"), ("WarlordItem", "adjudicator"), ("HunterItem", "basilisk"), ("CrusaderItem", "crusader"), ("RedeemerItem", "eyrie")] {
                        let has = if prop == "corrupted" { other_item.corrupted } else { other_item.influence.get(prop).copied().unwrap_or(false) };
                        if has {
                            *player.multipliers.entry(Sym::new(mult)).or_insert(0.0) += 1.0;
                            *player.multipliers.entry(Sym::new(&format!("Non{mult}"))).or_insert(0.0) -= 1.0;
                        }
                    }
                    if other_item.influence.get("elder").copied().unwrap_or(false) || other_item.influence.get("shaper").copied().unwrap_or(false) {
                        *player.multipliers.entry(pom_engine::sym!("ShaperOrElderItem")).or_insert(0.0) += 1.0;
                    }
                }
            }
            for m in item_mods_for_slot(item, slot_name) {
                if m.name.as_str() == "ExtraSkill" {
                    player.add_mod(m.clone());
                }
            }
            item_list.push((slot_name.clone(), item));
            continue;
        }
        item_list.push((slot_name.clone(), item));
        if item.item_type.as_deref() == Some("Shield") && necromantic_aegis {
            // CalcSetup.lua:1100-1116: mods that apply to socketed gems / add supports stay on the
            // player, everything else goes to `env.aegisModList` (scale-added, `scale` is 1 here).
            for m in pom_calc::perform::scale_add_list(item_mods_for_slot(item, slot_name), scale) {
                if m.tags.iter().any(|t| t.kind.as_str() == "SocketedIn") {
                    player.add_mod(m);
                } else {
                    aegis_mod_list.push(m);
                }
            }
        } else if slot_name == "Weapon 1"
            && item_mods_for_slot(item, slot_name).iter().find(|m| m.name.as_str() == "ExtraSkill").is_some_and(|m| match &m.value {
                pom_engine::value::Value::Map(kv) => kv.iter().any(|(k, v)| k.as_str() == "skillId" && matches!(v, pom_engine::value::Value::Str(s) if s.as_ref() == "UniqueAnimateWeapon")),
                _ => false,
            })
        {
            // CalcSetup.lua:1170-1188 (The Dancing Dervish): the weapon's own mods wait in `env.weaponModList1`;
            // mods that apply to socketed gems / add supports stay on the player.
            for m in pom_calc::perform::scale_add_list(item_mods_for_slot(item, slot_name), scale) {
                if m.tags.iter().any(|t| t.kind.as_str() == "SocketedIn") {
                    player.add_mod(m);
                } else {
                    weapon_mod_list1.push(m);
                }
            }
        } else if let Some((list, extra)) = equipped_bonus::equipped_bonus_mods(item, slot_name, scale, item_mods_for_slot(item, slot_name), &slots, &items, &tree_bonus_store) {
            for m in list {
                player.add_mod(m);
            }
            if let Some(m) = extra {
                player.add_mod(m);
            }
        } else if scale == 1.0 {
            for m in item_mods_for_slot(item, slot_name) {
                player.add_mod(m.clone());
            }
        } else {
            for m in pom_calc::perform::scale_add_list(item_mods_for_slot(item, slot_name), scale) {
                player.add_mod(m);
            }
        }
        if let Some(ad) = armour_data_for(item) {
            item_armour.insert(slot_name.clone(), ad);
        }
        if slot_name == "Weapon 1" || slot_name == "Weapon 2" {
            if let Some(wd) = &item.weapon_data {
                weapon_data.insert(slot_name.clone(), wd.clone());
            }
        }
    }

    pf.lap("items_merge");
    // ---- socketed jewels (`<Spec><Sockets><Socket nodeId itemId/>`): CalcSetup.lua:821-822's
    // `item = build.itemsTab.items[env.spec.jewels[slot.nodeId]]` branch, then merged the same as
    // any other equipped item (line 1068's `env.player.itemList[slotName] = item` plus the
    // `srcList` mod merge right after). A jewel's own explicit mod list (e.g. a rare jewel's "+N to
    // Dexterity"/"% increased Evasion", or a unique like "Dissolution of the Flesh"'s "Removes all
    // Energy Shield") is unconditional once its socket is allocated, separate from the cluster/timeless jewels'
    // tree-structural effects that `jewel_inputs`/`spec_from_xml_with_jewels_and_timeless` above handle.
    // Abyssal jewels (socketed inside an item, not a tree node) are not covered by `<Spec><Sockets>` and are not
    // modeled here.
    // `orderedSlots` puts the tree's jewel sockets after the equipment slots, in ascending node id.
    let mut sorted_sockets = jewel_sockets.clone();
    sorted_sockets.sort_by_key(|(node_id, _)| *node_id);
    // `env.modDB.multipliers["Corrupted<Magic|Rare>JewelEffect"]`: CalcSetup.lua's first slot pass
    // (lines 836-860) sets it from The Adorned before the second pass merges any item mods, so it
    // applies to every socketed corrupted jewel regardless of socket order.
    let (mut corrupted_magic_effect, mut corrupted_rare_effect): (Option<f64>, Option<f64>) = (None, None);
    for (node_id, item_id) in &sorted_sockets {
        let Some(node) = spec.nodes.get(node_id) else { continue };
        let Some(item) = items.get(item_id) else { continue };
        if (node.alloc || extra_node(*node_id)) && item.item_type.as_deref() == Some("Jewel") && item.name.contains("The Adorned, Crimson Jewel") {
            if let Some(v) = item.jewel_data.corrupted_magic_jewel_inc_effect {
                corrupted_magic_effect = Some(v / 100.0);
            }
            if let Some(v) = item.jewel_data.corrupted_rare_jewel_inc_effect {
                corrupted_rare_effect = Some(v / 100.0);
            }
        }
    }
    let ignore_jewel_limits = any_input_true(xml_text, "ignoreJewelLimits");
    let mut jewel_limits: HashMap<String, f64> = HashMap::default();
    for (node_id, item_id) in &sorted_sockets {
        let Some(node) = spec.nodes.get(node_id) else { continue };
        if !node.alloc && !extra_node(*node_id) {
            continue;
        }
        let Some(item) = items.get(item_id) else { continue };
        // CalcSetup.lua:861-872: a jewel with "Limited to: N" is skipped once N are already merged.
        if let Some(limit) = item.limit {
            if !ignore_jewel_limits {
                let key = if item.base_name.as_deref() == Some("Timeless Jewel") { "Historic".to_string() } else { item.title.clone().unwrap_or_default() };
                let n = jewel_limits.entry(key).or_insert(0.0);
                if *n >= limit {
                    continue;
                }
                *n += 1.0;
            }
        }
        let slot_name = format!("Jewel {node_id}");
        item_setup_multipliers(&mut player, game, &slot_name, item);
        let is_jewel = item.item_type.as_deref() == Some("Jewel");
        let mut scale = 1.0;
        let mut merged_first = false;
        if is_jewel {
            if let Some(v) = item.jewel_data.jewel_inc_effect_from_class_start {
                scale += spec.class_start_distance(*node_id) as f64 * (v / 100.0);
            }
        }
        if is_jewel && item.corrupted {
            // The corrupted-effect branch (line 1207) is one arm of an if/elseif chain that the
            // class-start scale above doesn't participate in, so it adds to whatever `scale` is.
            let extra = match item.rarity.as_str() {
                "MAGIC" => corrupted_magic_effect,
                "RARE" => corrupted_rare_effect,
                _ => None,
            };
            if let Some(e) = extra {
                scale += e;
                merged_first = true;
            }
        }
        item_list.push((slot_name.clone(), item));
        if scale == 1.0 {
            for m in item_mods_for_slot(item, &slot_name) {
                player.add_mod(m.clone());
            }
        } else {
            // The corrupted-jewel arm merges same-kind mods (`combinedList:MergeMod`) before scaling, so 5+15 scale as 20.
            let scaled = if merged_first { pom_calc::perform::scale_add_list(&merge_mods_additive(item_mods_for_slot(item, &slot_name), None), scale) } else { pom_calc::perform::scale_add_list(item_mods_for_slot(item, &slot_name), scale) };
            for m in scaled {
                player.add_mod(m);
            }
        }
    }

    pf.lap("jewels_merge");
    // ---- active skill list (`pom_skills::assemble::build_all_skills`) ----
    // `item_types`/`item_extra_supports`/`item_granted_skills`/`item_can_explode`: read straight off the parsed
    // `pom_item::Item`s with their resolved mod lists (see `pom_skills::data::ItemExtraSupports::from_live`), not
    // from recorded data.
    let mut item_slots_map: HashMap<String, i64> = HashMap::default();
    let mut item_types_live: HashMap<i64, String> = HashMap::default();
    let mut item_mods_live: HashMap<i64, Vec<Mod>> = HashMap::default();
    for (slot_name, item_id, _active) in &slots {
        item_slots_map.insert(slot_name.clone(), *item_id);
        let Some(item) = items.get(item_id) else { continue };
        if let Some(ty) = &item.item_type {
            item_types_live.insert(*item_id, ty.clone());
        }
        item_mods_live.entry(*item_id).or_insert_with(|| item_mods_for_slot(item, slot_name).to_vec());
    }
    // `build.itemsTab.orderedSlots` order (baseSlots first), the order items enter the modDB; a HashMap walk here made
    // ExtraSupport / CanExplode list order (and float products over it) vary from run to run.
    let item_order: Vec<i64> = {
        const BASE: [&str; 18] = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Graft 1", "Graft 2", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
        let mut v: Vec<(usize, usize, i64)> = slots.iter().enumerate().map(|(i, (name, id, _))| (BASE.iter().position(|b| b == name).unwrap_or(BASE.len()), i, *id)).collect();
        v.sort();
        let mut seen = pom_engine::fxhash::HashSet::default();
        v.into_iter().filter_map(|(_, _, id)| seen.insert(id).then_some(id)).collect()
    };
    let all_1h_flags: HashMap<String, bool> = weapon_data
        .iter()
        .map(|(slot, wd)| (slot.clone(), wd.first().and_then(|v| v.get("countsAsAll1H")).and_then(|v| v.as_bool()).unwrap_or(false)))
        .collect();
    let hollow_palm = spec.nodes.values().any(|n| n.alloc && n.kind == "Keystone" && n.dn == "Hollow Palm Technique")
        || item_mods_live.values().any(|ms| ms.iter().any(|m| m.name.as_str() == "Keystone" && matches!(&m.value, pom_engine::value::Value::Str(s) if &**s == "Hollow Palm Technique")));
    let item_types = pom_skills::data::BuildItemTypes::from_live(&item_types_live).with_hollow_palm(hollow_palm).with_counts_as_all_1h(all_1h_flags).with_dual_wield_offhand({
        let w1 = weapon_data.get("Weapon 1");
        let dual = w1.and_then(|w| w.first()).and_then(|v| v.get("countsAsDualWielding")).and_then(|v| v.as_bool()).unwrap_or(false);
        if dual { w1.and_then(|w| w.get(1)).and_then(|v| v.get("type")).and_then(|t| t.as_str()).map(|t| t.to_string()) } else { None }
    });
    let mut weapon_conditions = attrib_conds::weapon_conditions(&item_types, &item_slots_map, &weapon_data);
    // CalcPerform.lua:189-194: `condList["Using" .. baseName:match("%s(%S+)")]` for the Graft slots ("Erupting Xophgraft" -> UsingXophgraft).
    for slot in ["Graft 1", "Graft 2"] {
        if let Some(bn) = item_slots_map.get(slot).and_then(|id| items.get(id)).and_then(|it| it.base_name.as_deref()) {
            if let Some(i) = bn.find(char::is_whitespace) {
                let rest = bn[i..].trim_start();
                let word: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
                if !word.is_empty() { weapon_conditions.push(format!("Using{word}")); }
            }
        }
    }
    let actor_weapons = attrib_conds::actor_weapon_maps(&item_types, &item_slots_map, &weapon_data);
    let mut item_extra_supports = pom_skills::data::ItemExtraSupports::from_live(&item_mods_live, &item_order);
    {
        let tree_mods: Vec<Mod> = spec
            .env_alloc_order()
            .into_iter()
            .filter_map(|id| spec.nodes.get(&id).filter(|n| n.alloc))
            .flat_map(|n| node_mods(&n.mods).iter().cloned().filter(|m| m.name.as_str() == "ExtraSupport").collect::<Vec<_>>())
            .collect();
        item_extra_supports.add_tree_mods(&tree_mods);
        // One item in two slots (Mjolner in "Weapon 1" and "Weapon 2"): upstream adds `slotModList[i]` per slot, so the
        // second slot's copy carries `SocketedIn slotName="Weapon 2"`. `item_mods_live` is keyed by item id and kept the first only.
        let mut seen_ids: pom_engine::fxhash::HashSet<i64> = pom_engine::fxhash::HashSet::default();
        let mut extra_slot_mods: Vec<Mod> = Vec::new();
        for (slot_name, item_id, _active) in &slots {
            if !seen_ids.insert(*item_id) {
                if let Some(item) = items.get(item_id) {
                    extra_slot_mods.extend(item_mods_for_slot(item, slot_name).iter().filter(|m| m.name.as_str() == "ExtraSupport" && m.tags.iter().any(|t| t.kind.as_str() == "SocketedIn")).cloned());
                }
            }
        }
        item_extra_supports.add_tree_mods(&extra_slot_mods);
    }
    // Items in the inactive weapon set's slots still grant skills (CalcSetup.lua:826-835 runs before the weapon-set skip at 840).
    let mut inactive_granted_slots: HashMap<String, i64> = HashMap::default();
    let mut granted_order = item_order.clone();
    // With set II active the " Swap" slots are the active ones (merged under the plain name in `slots`) and the plain
    // "Weapon N" slots are the inactive set's; each grant is named by its slot's own name, so both are kept by raw name.
    let second_set_active = items_sec.set.as_ref().is_some_and(|s| s.0);
    for (name, id) in &raw_slots {
        if !name.starts_with("Weapon") || (!name.contains(" Swap") && !second_set_active) {
            continue;
        }
        let Some(item) = items.get(id) else { continue };
        item_mods_live.entry(*id).or_insert_with(|| item_mods_for_slot(item, &name.replace(" Swap", "")).to_vec());
        inactive_granted_slots.insert(name.clone(), *id);
        if !granted_order.contains(id) {
            granted_order.push(*id);
        }
    }
    // Socketed tree jewels are slots too: their `ExtraSkill` grants (e.g. a jewel triggering Summon Elemental Relic)
    // are merged in `orderedSlots` order, after the equipment (CalcSetup.lua:826-835).
    let mut granted_mods = item_mods_live.clone();
    for (node_id, item_id) in &sorted_sockets {
        if let Some(item) = items.get(item_id) {
            granted_mods.entry(*item_id).or_insert_with(|| item_mods_for_slot(item, &format!("Jewel {node_id}")).to_vec());
            inactive_granted_slots.insert(format!("Jewel {node_id}"), *item_id);
            if !granted_order.contains(item_id) {
                granted_order.push(*item_id);
            }
        }
    }
    let item_granted_skills = pom_skills::data::ItemGrantedSkills::from_live(&granted_mods, &granted_order).with_inactive_slots(inactive_granted_slots.clone());
    // SkillsTab.lua:1188-1192 empties the shared level `cost` of triggered item skills; carried as marker flags on the player.
    for (id, lvl) in item_granted_skills.triggered_levels() {
        player.add_mod(Mod { name: Sym::new(&format!("TriggeredZeroCost:{id}:{lvl}")), ty: ModType::Flag, value: pom_engine::value::Value::Bool(true), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
    }
    // `calcs.buildModListForNodeList`'s `for _, node in pairs(nodeList)` order (CalcSetup.lua:267-276).
    let mut tree_explode_ids: Vec<i64> = spec
        .env_alloc_order()
        .into_iter()
        .filter(|id| spec.nodes.get(id).is_some_and(|n| n.alloc && node_mods(&n.mods).iter().any(|m| m.name.as_str() == "CanExplode" && matches!(m.value, pom_engine::value::Value::Bool(true)))))
        .collect();
    // `item.sockets` colours per slot, for `SkillsTab:UpdateSocketGroups`' matching-socket quality bonus.
    let mut item_sockets: HashMap<String, Vec<char>> = HashMap::default();
    let mut item_sockets_always_match: pom_engine::fxhash::HashSet<String> = Default::default();
    for (slot_name, item_id, _active) in &slots {
        if let Some(item) = items.get(item_id) {
            item_sockets.insert(slot_name.clone(), item.sockets.iter().map(|s| s.color).collect());
            if item.socket_always_matches {
                item_sockets_always_match.insert(slot_name.clone());
            }
        }
    }
    // `SkillsTab:UpdateSocketGroups` reads `itemsTab.slots[group.slot]` (every slot of the active set, swap included).
    let mut item_sockets_raw: HashMap<String, Vec<char>> = HashMap::default();
    let mut item_sockets_always_match_raw: pom_engine::fxhash::HashSet<String> = Default::default();
    for (slot_name, item_id) in &raw_slots {
        if let Some(item) = items.get(item_id) {
            item_sockets_raw.insert(slot_name.clone(), item.sockets.iter().map(|s| s.color).collect());
            if item.socket_always_matches {
                item_sockets_always_match_raw.insert(slot_name.clone());
            }
        }
    }
    // `GemProperty` LIST mods in scope at skill-construction time (items, socketed jewels, allocated
    // non-keystone tree nodes): `env.modDB:Tabulate("LIST", gemCfg, "GemProperty")` in CalcSetup.lua's
    // `applyGemMods` call sites.
    pf.lap("item_maps");
    // CalcSetup.lua:1387-1398: `GrantedPassive` LIST mods (item "Allocates X", e.g. amulet anoints)
    // add the named notable/ascendancy node to `allocNodes`, whether or not the spec allocated it.
    let mut granted_nodes: pom_engine::fxhash::HashSet<i64> = pom_engine::fxhash::HashSet::default();
    let mut granted_latest: Vec<(i64, Vec<Mod>)> = Vec::new();
    {
        let granted_sym = pom_engine::sym!("GrantedPassive");
        // Config-tab mods (custom modifiers such as "Allocates <notable>") are in env.modDB before this scan
        // (CalcSetup.lua:681), but only join `player` further down here.
        let mut scan_mods: Vec<Mod> = Vec::new();
        if let pom_engine::modstore::store::Backing::List(v) = &player.backing {
            scan_mods.extend(v.iter().filter(|m| m.name == granted_sym && m.ty == ModType::List).cloned());
        }
        if let Some(cfg) = settled_config(xml_text, game, character_level) {
            scan_mods.extend(cfg.0.iter().filter(|m| m.name == granted_sym && m.ty == ModType::List).cloned());
        }
        for m in scan_mods.iter() {
            let pom_engine::value::Value::Str(name) = &m.value else { continue };
            // `notableMap` holds the un-conquered tree nodes (looked up by their tree name); the granted node is then
            // taken from `env.spec.nodes[id]`, i.e. the conquered replacement when a timeless jewel changed it.
            // A node's name is its tree node's `dn` (lowercased), or its own `dn` when the tree has none for it. The
            // tree's names are indexed once; nodes without one are the tree's `dn`-less nodes and the ones this spec
            // added (they are touched, see `NodeMap`).
            let (by_dn, no_dn) = &*tree_dn_index(spec.tree);
            let own_dn = |id: &i64| spec.nodes.get(id).is_some_and(|n| n.dn.to_lowercase() == **name);
            let mut ids: Vec<i64> = by_dn.get(&**name).cloned().unwrap_or_default();
            ids.extend(no_dn.iter().copied().filter(|id| own_dn(id)));
            ids.extend(spec.nodes.touched().iter().copied().filter(|id| spec.tree.node(*id).is_none() && own_dn(id)));
            let mut cands: Vec<&pom_passives::node::Node> = ids.iter().filter_map(|id| spec.nodes.get(id)).filter(|n| n.kind == "Notable" && n.ascendancy_name.is_none()).map(|n| &**n).collect();
            // `notableMap` keeps a later duplicate only when it belongs to a group (is on the tree).
            if cands.iter().any(|n| n.group_id.is_some()) {
                cands.retain(|n| n.group_id.is_some());
            }
            cands.sort_by_key(|n| n.id);
            let node = cands.last().copied().or_else(|| {
                let mut c: Vec<&pom_passives::node::Node> = spec.nodes.values().filter(|n| n.ascendancy_name.is_some() && n.dn.to_lowercase() == **name && (n.kind == "Notable" || n.kind == "Normal")).map(|n| &**n).collect();
                c.sort_by_key(|n| n.id);
                c.last().copied()
            });
            if let Some(n) = node {
                granted_nodes.insert(n.id);
            } else if let Some((id, mods)) = latest_tree_ascendancy_node(name) {
                granted_latest.push((id, mods));
            }
        }
    }
    pf.lap("granted_passive");
    // CalcSetup.lua:1400-1417: a Forbidden Flame + Forbidden Flesh pair naming the same ascendancy
    // node grants it, when both jewels' class restriction is the current class
    // (`env.itemModDB.conditions[item.title:gsub(" ", "")] = item.classRestriction`, line 1273).
    if let pom_engine::modstore::store::Backing::List(v) = &player.backing {
        let cur_class = spec.classes.get(&spec.cur_class_id).map(|c| c.name.clone());
        let class_cond = |key: &str| item_list.iter().any(|(_, it)| it.title.as_deref().map_or(false, |t| t.replace(' ', "") == key) && it.class_restriction.is_some() && it.class_restriction == cur_class);
        let gan = pom_engine::sym!("GrantedAscendancyNode");
        let (side_k, name_k) = (pom_engine::sym!("side"), pom_engine::sym!("name"));
        let mut matched_name: HashMap<String, (String, bool)> = HashMap::default();
        for m in v.iter().filter(|m| m.name == gan && m.ty == ModType::List) {
            let (pom_engine::value::Value::Str(side), pom_engine::value::Value::Str(name)) = (m.value.get(side_k), m.value.get(name_k)) else { continue };
            let (side, name) = (side.to_string(), name.to_string());
            match matched_name.get_mut(&name) {
                Some(e) if e.0 != side && !e.1 => {
                    e.1 = true;
                    let mut c: Vec<&pom_passives::node::Node> = spec.nodes.values().filter(|n| n.ascendancy_name.is_some() && n.dn.to_lowercase() == name && (n.kind == "Notable" || n.kind == "Normal")).map(|n| &**n).collect();
                    c.sort_by_key(|n| n.id);
                    let both = class_cond("ForbiddenFlesh") && class_cond("ForbiddenFlame");
                    if let Some(n) = c.last() {
                        if both {
                            granted_nodes.insert(n.id);
                        }
                    } else if both {
                        if let Some((id, mods)) = latest_tree_ascendancy_node(&name) {
                            granted_latest.push((id, mods));
                        }
                    }
                }
                _ => {
                    matched_name.insert(name, (side, false));
                }
            }
        }
    }
    EXTRA_NODES.with(|e| {
        for id in e.borrow().iter() {
            if spec.nodes.get(id).is_some() {
                granted_nodes.insert(*id);
            }
        }
    });
    // Granted-only nodes (item "Allocates X", Forbidden Flame/Flesh pairs) carry `ExtraSupport` mods too (Tukohama's
    // "Skills from Equipped Body Armour are Supported by ..."); `env.allocNodes` includes them before skills are built.
    {
        let mut ids: Vec<i64> = granted_nodes.iter().copied().filter(|id| spec.nodes.get(id).is_some_and(|n| !n.alloc)).collect();
        ids.sort_unstable();
        let mut extra: Vec<Mod> = ids.iter().filter_map(|id| spec.nodes.get(id)).flat_map(|n| node_mods(&n.mods).iter().cloned().filter(|m| m.name.as_str() == "ExtraSupport").collect::<Vec<_>>()).collect();
        for (id, mods) in &granted_latest {
            if !spec.nodes.get(id).is_some_and(|n| n.alloc) {
                extra.extend(mods.iter().filter(|m| m.name.as_str() == "ExtraSupport").cloned());
            }
        }
        item_extra_supports.add_tree_mods(&extra);
    }
    // Granted ascendancy nodes (Forbidden Flame/Flesh) join `env.allocNodes` before `buildModListForNodeList` collects explode sources.
    for id in {let mut g: Vec<i64> = granted_nodes.iter().copied().collect(); g.sort(); g} {
        if !tree_explode_ids.contains(&id) && spec.nodes.get(&id).is_some_and(|n| node_mods(&n.mods).iter().any(|m| m.name.as_str() == "CanExplode" && matches!(m.value, pom_engine::value::Value::Bool(true)))) {
            tree_explode_ids.push(id);
        }
    }
    for (id, mods) in &granted_latest {
        if !tree_explode_ids.contains(id) && mods.iter().any(|m| m.name.as_str() == "CanExplode" && matches!(m.value, pom_engine::value::Value::Bool(true))) {
            tree_explode_ids.push(*id);
        }
    }
    // Granted passives (anoints, Forbidden Flame/Flesh) are in `env.allocNodes` too, so their `ExtraSupport` mods
    // (Tukohama, War's Herald: "Skills from Equipped Body Armour are Supported by ...") reach the socket groups.
    {
        let mut ids: Vec<i64> = granted_nodes.iter().copied().filter(|id| !spec.nodes.get(id).is_some_and(|n| n.alloc)).collect();
        ids.sort_unstable();
        let mut extra: Vec<Mod> = ids.iter().filter_map(|id| spec.nodes.get(id)).flat_map(|n| node_mods(&n.mods).iter().cloned().filter(|m| m.name.as_str() == "ExtraSupport").collect::<Vec<_>>()).collect();
        for (_, mods) in &granted_latest {
            extra.extend(mods.iter().filter(|m| m.name.as_str() == "ExtraSupport").cloned());
        }
        item_extra_supports.add_tree_mods(&extra);
    }
    pf.lap("granted_more");
    let mut explode_mods = granted_mods.clone();
    let mut explode_order = granted_order.clone();
    for (name, id) in &inactive_weapon_slots {
        let Some(item) = items.get(id) else { continue };
        explode_mods.entry(*id).or_insert_with(|| item_mods_for_slot(item, &name.replace(" Swap", "")).to_vec());
        if !explode_order.contains(id) {
            explode_order.push(*id);
        }
    }
    let item_can_explode = pom_skills::data::ItemCanExplode::from_live(&explode_mods, &explode_order).with_inactive_slots(&{ let mut m = inactive_weapon_slots.clone(); m.extend(inactive_granted_slots.iter().filter(|(k, _)| k.starts_with("Jewel ")).map(|(k, v)| (k.clone(), *v))); m }).with_tree_source_names(tree_explode_ids.iter().map(|id| format!("Tree:{id}")).collect());
    // The enemy's config-derived mods/conditions (`env.enemyDB`), so `ActorCondition actor=enemy` tags on an
    // `ExtraSkillMod` (Blight's "Enemies Hindered by Blight take 25% increased Chaos Damage") resolve when skills are built.
    let gp_enemy: std::sync::Arc<ModStore> = {
        let mut es = ModStore::new_list(None, None);
        es.conditions.insert(pom_engine::sym!("Effective"), pom_calc::setup::buff_mode().effective);
        if let Some(cfg) = settled_config(xml_text, game, character_level) {
            for m in cfg.1.iter() {
                es.add_mod(m.clone());
            }
        }
        std::sync::Arc::new(es)
    };
    let gp_actor = {
        use pom_engine::modstore::types::Actor;
        let a = Actor { output: HashMap::default(), mana_efficiency: None, weapon1: HashMap::default(), weapon2: HashMap::default(), minion_monster_tags: None, reservations: Vec::new(), items: HashMap::default(), item_search: HashMap::default(), related: std::cell::RefCell::new(HashMap::default()) };
        a.related.borrow_mut().insert(std::sync::Arc::from("enemy"), gp_enemy);
        let a = std::sync::Arc::new(a);
        pom_engine::modstore::types::register_links(&a);
        a
    };
    pf.lap("gp_enemy");
    let mut gem_prop_store = ModStore::new_list(None, Some(gp_actor));
    // Item count/influence multipliers (`MultiplierThreshold` on "+1 to Level of all ... Gems if 2 Shaper items are equipped").
    gem_prop_store.multipliers = player.multipliers.clone();
    // modDB.multipliers["Level"] (CalcSetup.lua:595) is already set when skills are built ("+1 to Level of Socketed ... per 25 Player Levels").
    gem_prop_store.multipliers.insert(pom_engine::sym!("Level"), pom_calc::setup::level_multiplier(character_level));
    gem_prop_store.conditions = player.conditions.clone();
    {
        let gp = pom_engine::sym!("GemProperty");
        let extra_names = [pom_engine::sym!("ExtraSkillMod"), pom_engine::sym!("ExtraSkillStat")];
        let mut push = |m: &Mod| {
            // `Condition:<var>` flags too: GemProperty mods can be gated on a condition (Venarius' Astrolabe).
            if m.name == gp || m.name.as_str() == "SocketProperty" || extra_names.contains(&m.name) || m.name.as_str().starts_with("Condition:") || matches!(m.name.as_str(), "DisableSkill" | "EnableSkill") {
                gem_prop_store.add_mod(m.clone());
            }
        };
        if let pom_engine::modstore::store::Backing::List(v) = &player.backing {
            v.iter().for_each(&mut push);
        }
        // A Keystone node contributes only its `keystoneMod` to the modDB at setup (CalcSetup.lua:138-139); its real
        // mods arrive later through `mergeKeystones` (CalcPerform.lua:1292), after every skill's mod list is built,
        // so e.g. Lone Messenger's `DisableSkill` never disables a skill.
        for node in spec.nodes.values().filter(|n| (n.alloc || granted_nodes.contains(&n.id)) && n.kind != "Keystone") {
            node_mods(&node.mods).iter().for_each(|m| push(m));
        }
        for (_, mods) in &granted_latest {
            mods.iter().for_each(&mut push);
        }
        // Config-tab mods (e.g. `aspectOfTheSpiderWebStacks`' `ExtraSkillMod`) are in env.modDB before the skills
        // are built (CalcSetup.lua), so they must be visible to `skillModList:List(skillCfg, "ExtraSkillMod")`.
        if let Some(cfg) = settled_config(xml_text, game, character_level) {
            cfg.0.iter().for_each(&mut push);
        }
    }
    pf.lap("gem_prop_store");
    // ---- tree: allocated nodes' own mods, keystones held aside for Perform ----
    for node in spec.nodes.values().filter(|n| n.kind == "Keystone") {
        let mods: Vec<Mod> = node_mods(&node.mods).to_vec();
        keystone_map.insert(node.dn.to_lowercase(), mods.clone());
        keystone_map.insert(node.dn.to_string(), mods);
    }
    // `tree.keystoneMap` also carries keystones that exist only as legion/legacy nodes (Divine Flesh,
    // Corrupted Soul, Immortal Ambition, ...; PassiveTree.lua:739 "Don't override good tree data with
    // legacy keystones"): built via ProcessStats from the node's own stat lines.
    // Their mods follow from the tree alone, so they are built once per tree (in `keystoneMap` order).
    for (name, mods) in tree_keystone_mods(tree_data).iter() {
        if keystone_map.contains_key(name) {
            continue;
        }
        keystone_map.insert(name.to_lowercase(), mods.clone());
        keystone_map.insert(name.to_string(), mods.clone());
    }
    pf.lap("keystone_map");
    // Radius jewels (CalcSetup.lua:872-932): built from the allocated, socketed jewels in slot order.
    let radius_sockets: Vec<(i64, &pom_item::Item)> = sorted_sockets
        .iter()
        .filter(|(node_id, _)| spec.nodes.get(node_id).map_or(false, |n| n.alloc || extra_node(*node_id)))
        .filter_map(|(node_id, item_id)| items.get(item_id).map(|it| (*node_id, &**it)))
        .filter(|(_, it)| it.item_type.as_deref() == Some("Jewel"))
        .collect();
    let (mut radius_jewels, extra_radius_nodes) = radius::collect(&spec, &radius_sockets, game, &granted_nodes);
    let mut alloc_ids: Vec<i64> = spec.nodes.values().filter(|n| n.alloc || granted_nodes.contains(&n.id)).map(|n| n.id).collect();
    alloc_ids.sort_unstable();
    let mut keystone_mods_names: pom_engine::fxhash::HashSet<String> = pom_engine::fxhash::HashSet::default();
    let mut tree_mods: Vec<Mod> = Vec::new();
    for id in &alloc_ids {
        let node = &spec.nodes[id];
        if node.kind == "Keystone" {
            if node.alloc {
                keystones_added.insert(node.dn.to_string());
            }
            // mergeKeystones (ModTools.lua:248) merges a keystone's `keystoneMap` mods once per name, so two
            // conquered keystones that both become the same keystone (Timeless "_v2" replacements) count once.
            if keystone_mods_names.insert(node.dn.to_string()) {
                keystone_mods.push(node_mods(&node.mods).to_vec());
            }
        } else {
            let nm = radius::node_mod_list(node, true, &mut radius_jewels);
            tree_mods.extend(nm);
        }
    }
    // Granted nodes only the latest tree has (not in the spec's own tree): plain node mods.
    for (id, mods) in std::mem::take(&mut granted_latest) {
        if !alloc_ids.contains(&id) {
            tree_mods.extend(radius::apply_effect_scaling(mods, true));
        }
    }
    // Unallocated nodes near non-Self jewels: run for their data side effects only (granted
    // passives were removed from the extra list, CalcSetup.lua:1396).
    for id in &extra_radius_nodes {
        if granted_nodes.contains(id) {
            continue;
        }
        if let Some(node) = spec.nodes.get(id) {
            if node.kind != "Keystone" {
                let _ = radius::node_mod_list(node, false, &mut radius_jewels);
            }
        }
    }
    if CAPTURE_TREE_FACTS.with(|c| c.get()) {
        let mut facts = tree_facts(&spec, &radius_jewels, &extra_radius_nodes, &granted_nodes);
        // Sockets holding a plain jewel become simple too (unless another rule already excludes the node).
        let adorned = spec.jewels.values().filter_map(|i| items.get(i)).any(|it| it.name.contains("The Adorned"));
        let lone = |item: &pom_item::Item| {
            let titled = spec.jewels.iter().filter(|(n, _)| spec.nodes.get(n).is_some_and(|n| n.alloc)).filter_map(|(_, i)| items.get(i)).filter(|o| o.title == item.title).count();
            (items.values().filter(|o| o.base_name == item.base_name).count() == 1, item.limit.is_some_and(|l| titled as f64 <= l))
        };
        for (&node, &item_id) in spec.jewels.iter() {
            let Some(item) = items.get(&item_id) else { continue };
            if item_id > 0 && plain_jewel(item, game, adorned, lone(item)) && !radius_jewels.iter().any(|rj| rj.nodes.contains(&node)) {
                if let (Some(n), Some(e)) = (spec.nodes.get(&node), facts.simple.get_mut(&node)) {
                    if n.kind == "Socket" && n.is_jewel_socket && n.expansion_jewel.is_none() && !n.is_tattoo && n.conquered_by.is_none() && n.intuitive_leap_likes_affecting.is_empty() && !granted_nodes.contains(&node) && !extra_radius_nodes.contains(&node) && !n.mods.iter().any(|m| special_node_mod(&m.name)) {
                        e.0 = true;
                        facts.jewel.insert(node, item_id);
                    }
                }
            }
        }
        // A top-level large socket holding an otherwise plain cluster jewel: without the socket upstream builds no
        // subgraph, so the socket, its jewel and everything allocated in the subgraph (generated nodes, ids from 65536,
        // and nested sockets whose parent is in it, with their own jewels and subgraphs) go together.
        let socket_ok = |id: i64| -> Option<Option<i64>> {
            let n = spec.nodes.get(&id)?;
            let ok = n.kind == "Socket" && n.is_jewel_socket && !n.is_tattoo && n.conquered_by.is_none() && n.intuitive_leap_likes_affecting.is_empty() && !granted_nodes.contains(&id)
                && !extra_radius_nodes.contains(&id) && !n.mods.iter().any(|m| special_node_mod(&m.name)) && !radius_jewels.iter().any(|rj| rj.nodes.contains(&id));
            match spec.jewels.get(&id).copied().filter(|&i| i > 0) {
                None => (ok && facts.simple.get(&id).is_some_and(|e| e.0)).then_some(None),
                Some(item_id) => (ok && items.get(&item_id).is_some_and(|it| plain_jewel_except_cluster(it, game, adorned, lone(it)))).then_some(Some(item_id)),
            }
        };
        // (the spec's own socket nodes don't keep `expansionJewel.parent`; the tree data has it)
        let parent_of = |id: i64| spec.tree.node(id).and_then(|t| t.get("expansionJewel")).and_then(|e| e.get("parent")).and_then(pom_passives::treedata::as_i64);
        let mut found: Vec<(i64, i64, Vec<(i64, Option<i64>)>)> = Vec::new();
        for (&node, &item_id) in spec.jewels.iter() {
            let Some(n) = spec.nodes.get(&node) else { continue };
            let top = n.expansion_jewel.is_some() && spec.tree.node(node).is_some() && parent_of(node).is_none();
            if item_id <= 0 || !n.alloc || !top || !items.get(&item_id).is_some_and(|it| it.cluster_jewel.is_some()) || socket_ok(node) != Some(Some(item_id)) {
                continue;
            }
            let (mut sub, mut stack, mut ok): (Vec<(i64, Option<i64>)>, Vec<i64>, bool) = (Vec::new(), vec![node], true);
            while let Some(x) = stack.pop() {
                if !ok {
                    break;
                }
                for &l in facts.neighbours.get(&x).map_or(&[][..], |v| v.as_slice()) {
                    if l == node || sub.iter().any(|e| e.0 == l) {
                        continue;
                    }
                    let parent = parent_of(l);
                    if l >= 65536 {
                        ok &= facts.simple.get(&l).is_some_and(|e| e.0);
                        sub.push((l, None));
                    } else if parent.is_some_and(|p| p == node || sub.iter().any(|e| e.0 == p)) {
                        match socket_ok(l) {
                            Some(j) => sub.push((l, j)),
                            None => {
                                ok = false;
                                break;
                            }
                        }
                    } else {
                        continue;
                    }
                    stack.push(l);
                }
            }
            if ok {
                found.push((node, item_id, sub));
            }
        }
        for (node, item_id, sub) in found {
            if let Some(e) = facts.simple.get_mut(&node) {
                e.0 = true;
                facts.jewel.insert(node, item_id);
                for &(id, j) in &sub {
                    if let Some(j) = j {
                        facts.jewel.insert(id, j);
                    }
                }
                facts.cluster.insert(node, sub.into_iter().map(|e| e.0).collect());
            }
        }
        TREE_FACTS.with(|f| *f.borrow_mut() = Some(facts));
    }
    let radius_mods = radius::finish(tree_mods, &mut radius_jewels);
    // Radius-jewel output (e.g. Blight's threshold `ExtraSkillMod`) is in env.modDB before skills are built
    // (CalcSetup.lua:872-932), so it must reach the skill-construction store too; mods already pushed from the
    // plain node list are skipped once each.
    {
        let gp = pom_engine::sym!("GemProperty");
        let extra_names = [pom_engine::sym!("ExtraSkillMod"), pom_engine::sym!("ExtraSkillStat")];
        let interesting = |m: &Mod| m.name == gp || m.name.as_str() == "SocketProperty" || extra_names.contains(&m.name) || m.name.as_str().starts_with("Condition:") || matches!(m.name.as_str(), "DisableSkill" | "EnableSkill");
        let key = |m: &Mod| format!("{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}", m.name, m.ty, m.value, m.flags, m.keyword_flags, m.source, m.tags);
        let mut have: HashMap<String, i64> = HashMap::default();
        if let pom_engine::modstore::store::Backing::List(v) = &gem_prop_store.backing {
            for m in v.iter().filter(|m| interesting(m)) {
                *have.entry(key(m)).or_insert(0) += 1;
            }
        }
        for m in radius_mods.iter().filter(|m| interesting(m)) {
            let k = key(m);
            match have.get_mut(&k) {
                Some(c) if *c > 0 => *c -= 1,
                _ => gem_prop_store.add_mod(m.clone()),
            }
        }
    }
    for m in radius_mods {
        player.add_mod(m);
    }
    pf.lap("tree_mods_radius");
    let gem_props = |slot: Option<&str>, colour: Option<char>, num: Option<usize>| -> Vec<pom_skills::assemble::GemProp> {
        let cfg = pom_engine::modstore::types::Cfg {
            slot_name: slot.map(std::sync::Arc::from),
            socket_color: colour.map(|c| std::sync::Arc::from(c.to_string())),
            socket_num: num.map(|n| n as f64),
            ..Default::default()
        };
        gem_prop_store
            .tabulate(Some(ModType::List), Some(&cfg), &[pom_engine::sym!("GemProperty")])
            .into_iter()
            .filter_map(|(v, mp)| {
                let key = match v.get(pom_engine::sym!("key")) {
                    pom_engine::value::Value::Str(s) => s.to_string(),
                    _ => return None,
                };
                let value = v.get(pom_engine::sym!("value")).num()?;
                let keywords: Vec<String> = match (v.get(pom_engine::sym!("keywordList")), v.get(pom_engine::sym!("keyword"))) {
                    (pom_engine::value::Value::List(l), _) => l.iter().filter_map(|k| if let pom_engine::value::Value::Str(s) = k { Some(s.to_string()) } else { None }).collect(),
                    (_, pom_engine::value::Value::Str(s)) => vec![s.to_string()],
                    _ => return None,
                };
                // SAFETY: `mp` points into `gem_prop_store`, alive for the whole closure.
                let (source, tag0) = unsafe { ((*mp).source.clone(), (*mp).tags.first().cloned()) };
                Some(pom_skills::assemble::GemProp { keywords, key, value, source, tag0 })
            })
            .collect()
    };
    // `env.grantedSkillsNodes` (CalcSetup.lua:1437-1445): `ExtraSkill` mods of every allocated node (spec-allocated plus
    // `GrantedPassive`/Forbidden pairs), in node id order.
    let item_granted_skills = {
        // (the allocated-or-granted ids in id order: `alloc_ids` above, with the same nodes and grants)
        let mut tree_granted: Vec<pom_skills::data::GrantedSkillMod> = Vec::new();
        for &id in &alloc_ids {
            for m in node_mods(&spec.nodes[&id].mods).iter() {
                if m.name.as_str() != "ExtraSkill" { continue; }
                if matches!(m.value.get(pom_engine::sym!("name")), pom_engine::value::Value::Str(s) if &**s == "Unknown") { continue; }
                let pom_engine::value::Value::Str(skill_id) = m.value.get(pom_engine::sym!("skillId")) else { continue };
                let level = if let pom_engine::value::Value::Num(n) = m.value.get(pom_engine::sym!("level")) { *n } else { 1.0 };
                let no_supports = matches!(m.value.get(pom_engine::sym!("noSupports")), pom_engine::value::Value::Bool(true));
                let triggered = matches!(m.value.get(pom_engine::sym!("triggered")), pom_engine::value::Value::Bool(true));
                let trigger_chance = if let pom_engine::value::Value::Num(n) = m.value.get(pom_engine::sym!("triggerChance")) { Some(*n) } else { None };
                tree_granted.push(pom_skills::data::GrantedSkillMod { skill_id: skill_id.to_string(), level, no_supports, triggered, source: format!("Tree:{id}"), trigger_chance });
            }
        }
        item_granted_skills.with_tree(tree_granted)
    };
    let granted_triggered = item_granted_skills.triggered_pairs();
    let granted_trigger_chance = item_granted_skills.trigger_chances();
    let inactive_item_grants: Vec<(String, String, String, f64)> = {
        let mut names: Vec<&String> = item_granted_skills.inactive_slot_names().into_iter().filter(|n| n.starts_with("Weapon") && n.contains(" Swap") != second_set_active).collect();
        names.sort();
        names.into_iter().flat_map(|n| item_granted_skills.for_slot(&item_slots_map, n).iter().map(|g| (n.clone(), g.source.clone(), g.skill_id.clone(), g.level)).collect::<Vec<_>>()).collect()
    };
    let extra_skill_fn = |cfg: &pom_engine::modstore::types::Cfg| {
        let (stats, mut mods) = extra_skill::stats_and_mods(&gem_prop_store, cfg);
        // CalcActiveSkill.lua:503-508: `DisableSkill` and not `EnableSkill` disables the skill.
        if gem_prop_store.flag(Some(cfg), &[pom_engine::sym!("DisableSkill")]) && !gem_prop_store.flag(Some(cfg), &[pom_engine::sym!("EnableSkill")]) {
            mods.push(Mod { name: pom_engine::sym!("__DisableSkill"), ty: ModType::Flag, value: pom_engine::value::Value::Bool(true), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
        }
        (stats, mods)
    };
    pf.lap("granted_skills");
    // `env.requirementsTableItems` is filled in `orderedSlots` order; the item loop above walks the XML's slot order.
    {
        let mut idx: Vec<usize> = (0..attr_req_srcs.len()).collect();
        idx.sort_by_key(|&i| match &attr_req_srcs[i] {
            bd_perform::ReqSrc::Item { order, .. } => *order,
            _ => (usize::MAX, 0, 0),
        });
        let (rows, srcs) = (attr_reqs.clone(), attr_req_srcs.clone());
        attr_reqs = idx.iter().map(|&i| rows[i]).collect();
        attr_req_srcs = idx.iter().map(|&i| srcs[i].clone()).collect();
    }
    for (row, src) in gem_requirements(xml_text, &item_slots_map, &item_granted_skills, &item_can_explode) {
        attr_reqs.push(row);
        if let Some(src) = src {
            attr_req_srcs.push(src);
        }
    }
    // The skills follow from the build text outside `<Tree>` and from the arguments below (the gem-property store is
    // what the two closures read). An edit to the tree usually changes none of them, so the last result is kept
    // against the full text of every input.
    let skill_mode = pom_calc::setup::buff_mode();
    let skills_key = {
        let gp_mods: &[Mod] = match &gem_prop_store.backing {
            pom_engine::modstore::store::Backing::List(v) => v,
            _ => &[],
        };
        let mut conds: Vec<(Sym, bool)> = gem_prop_store.conditions.iter().map(|(k, v)| (*k, *v)).collect();
        conds.sort_unstable();
        let mut mults: Vec<(Sym, u64)> = gem_prop_store.multipliers.iter().map(|(k, v)| (*k, v.to_bits())).collect();
        mults.sort_unstable();
        let mut slots_sorted: Vec<(&String, &i64)> = item_slots_map.iter().collect();
        slots_sorted.sort_unstable();
        let text = format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{}|{:?}",
            pom_skills::xmlskills::xml_key_without_tree(xml_text),
            item_types, item_extra_supports, item_granted_skills, item_can_explode, slots_sorted, item_sockets, item_sockets_always_match, item_sockets_raw, item_sockets_always_match_raw,
            mults, gem_prop_store.parent.is_some() as u8 + 2 * gem_prop_store.actor.is_some() as u8,
            pom_calc::setup::buff_mode()
        );
        (text, gp_mods, conds)
    };
    type SkillsKey = (String, Vec<Mod>, Vec<(Sym, bool)>);
    thread_local! {
        /// (inputs, skills, the raw copies `calcs.copyActiveSkill` builds when a build needs them)
        static SKILLS_MEMO: std::cell::RefCell<Option<(SkillsKey, Vec<pom_skills::assemble::ComputedSkill>, Option<Vec<pom_skills::assemble::ComputedSkill>>)>> = const { std::cell::RefCell::new(None) };
    }
    let hit = SKILLS_MEMO.with(|m| m.borrow().as_ref().filter(|e| e.0 .0 == skills_key.0 && e.0 .1.as_slice() == skills_key.1 && e.0 .2 == skills_key.2).map(|e| e.1.clone()));
    let active_skills = match hit {
        Some(v) => v,
        None => {
            let v = pom_skills::assemble::build_all_skills_with_sockets(xml_text, &item_types, &item_extra_supports, &item_granted_skills, &item_can_explode, &item_slots_map, &item_sockets, &item_sockets_always_match, &item_sockets_raw, &item_sockets_always_match_raw, Some(&gem_props), Some(&extra_skill_fn), skill_mode.buffs, skill_mode.combat, skill_mode.effective).unwrap_or_default();
            let (text, gp, conds) = skills_key;
            SKILLS_MEMO.with(|m| *m.borrow_mut() = Some(((text, gp.to_vec(), conds), v.clone(), None)));
            v
        }
    };

    pf.lap("build_all_skills");
    // `applySocketMods` (CalcSetup.lua:419-425, called at 1708/1779): each processed, enabled gem adds the
    // `SocketProperty` mods whose `SocketedIn` tag matches its slot/socket ("+N% to X resistance when
    // Socketed with a Y Gem", Malachai's Artifice), once per gem, supports before actives, with the
    // group's running per-colour gem counts.
    if let (Ok(sg), Ok(meta)) = (pom_skills::xmlskills::socket_groups_shared(xml_text), pom_skills::xmlskills::parse_build_meta(xml_text)) {
        for (gi, group) in sg.iter().enumerate() {
            let is_main = (gi as i64 + 1) == meta.main_socket_group;
            if !(is_main || (group.enabled && pom_skills::xmlskills::slot_enabled(&group.slot, meta.use_second_weapon_set))) || group.source.as_deref() == Some("Explode") {
                continue;
            }
            if group.source.as_deref().is_some_and(|s| s.starts_with("Item:")) && !is_main {
                continue;
            }
            let is_tree_skill = group.slot.is_none() && group.source.as_deref().is_some_and(|s| s.to_lowercase().contains("tree"));
            let slot_name: Option<String> = match (&group.slot, is_tree_skill) {
                (Some(s), _) => Some(s.replace(" Swap", "")),
                (None, true) => Some("Passive Tree".to_string()),
                _ => None,
            };
            let item_name: String = slot_name.as_ref().and_then(|s| item_slots_map.get(s)).and_then(|id| items.get(id)).map(|it| it.name.clone()).unwrap_or_else(|| slot_name.clone().unwrap_or_default());
            let (mut int_g, mut dex_g, mut str_g) = (0.0f64, 0.0f64, 0.0f64);
            for pass in 0..2 {
                for (i, gem) in group.gem_list.iter().enumerate() {
                    let Some(gd) = gem.gem_data else { continue };
                    if !gem.enabled {
                        continue;
                    }
                    let is_sup = pom_skills::data::gem_primary_effect(gd).is_some_and(|ge| pom_skills::data::is_support(ge));
                    if is_sup != (pass == 0) {
                        continue;
                    }
                    let cfg = pom_engine::modstore::types::Cfg {
                        slot_name: slot_name.as_deref().map(std::sync::Arc::from),
                        skill_gem: Some(pom_engine::modstore::types::GemInfo { name: std::sync::Arc::from(gd.name.clone().unwrap_or_default().to_lowercase().as_str()), tags: gd.tags.iter().map(|(k, v)| (std::sync::Arc::from(k.as_str()), *v)).collect() }),
                        socket_num: Some((i + 1) as f64),
                        intelligence_gems: Some(int_g),
                        dexterity_gems: Some(dex_g),
                        strength_gems: Some(str_g),
                        ..Default::default()
                    };
                    for (v, _) in gem_prop_store.tabulate(Some(ModType::List), Some(&cfg), &[pom_engine::sym!("SocketProperty")]) {
                        if let pom_engine::value::Value::Map(m) = v.get(pom_engine::sym!("value")) {
                            let mut nm = actor_misc::map_to_mod(m);
                            nm.source = Some(std::sync::Arc::from(item_name.as_str()));
                            player.add_mod(nm);
                        }
                    }
                    int_g += if gd.tags.get("intelligence").copied().unwrap_or(false) { 1.0 } else { 0.0 };
                    dex_g += if gd.tags.get("dexterity").copied().unwrap_or(false) { 1.0 } else { 0.0 };
                    str_g += if gd.tags.get("strength").copied().unwrap_or(false) { 1.0 } else { 0.0 };
                }
            }
        }
    }
    pf.lap("socket_mods");
    // `calcs.copyActiveSkill` rebuilds the skill with no gemCfg, so its skillCfg.slotName is nil and slot-bound
    // (`SocketedIn`) ExtraSkillMod/ExtraSkillStat values never reach the copy (CalcActiveSkill.lua:475).
    let raw_extra_skill_fn = |cfg: &pom_engine::modstore::types::Cfg| {
        let mut c = cfg.clone();
        c.slot_name = None;
        extra_skill::stats_and_mods(&gem_prop_store, &c)
    };
    // The memo entry now holds this build's inputs (see above), so its raw copies are this build's too.
    let needs_raw = xml_contains_any(xml_text, &["Mirage Archer", "Sacred Wisps", "Tawhoa", "Reflection", "The Saviour"]);
    let raw_kept = if needs_raw { SKILLS_MEMO.with(|m| m.borrow().as_ref().and_then(|e| e.2.clone())) } else { None };
    let raw_skills = if let Some(raw) = raw_kept {
        raw
    } else if needs_raw {
        pom_skills::assemble::RAW_ACTIVE_GEMS.with(|c| c.set(true));
        // The mirage copy keeps the gem's item/tree level and quality bonus; upstream rebuilds it from the raw gem level.
        pom_skills::assemble::RAW_KEEP_GEM_BONUS.with(|c| c.set(pom_offence::data::pom_fixes_on()));
        let raw = pom_skills::assemble::build_all_skills_with_sockets(xml_text, &item_types, &item_extra_supports, &item_granted_skills, &item_can_explode, &item_slots_map, &item_sockets, &item_sockets_always_match, &item_sockets_raw, &item_sockets_always_match_raw, Some(&gem_props), Some(&raw_extra_skill_fn), skill_mode.buffs, skill_mode.combat, skill_mode.effective).unwrap_or_default();
        pom_skills::assemble::RAW_ACTIVE_GEMS.with(|c| c.set(false));
        pom_skills::assemble::RAW_KEEP_GEM_BONUS.with(|c| c.set(false));
        SKILLS_MEMO.with(|m| {
            if let Some(e) = m.borrow_mut().as_mut() {
                e.2 = Some(raw.clone());
            }
        });
        raw
    } else {
        Vec::new()
    };
    pf.lap("raw_skills");
    // `allocatedMasteryTypes` (PassiveSpec.lua:357-366/1436-1446): allocated masteries with a selected effect, by name.
    // Keyed by the tree's own node name: a Runegraft/tattoo replacement changes `dn` but not the mastery's `name`.
    let mut mastery_types: HashMap<String, usize> = HashMap::default();
    for n in spec.nodes.values().filter(|n| n.alloc && n.kind == "Mastery" && spec.mastery_selections.contains_key(&n.id)) {
        // `ReplaceNode` copies the replacement's `name` ("Runegraft Mastery" for every alternate-mastery tattoo).
        let name = if n.is_tattoo && n.override_type.as_deref() == Some("AlternateMastery") { "Runegraft Mastery".to_string() } else { spec.tree.node(n.id).and_then(|t| t.get("dn")).and_then(|d| d.as_str()).map(|s| s.to_string()).unwrap_or_else(|| n.dn.to_string()) };
        *mastery_types.entry(name).or_insert(0) += 1;
    }
    let life_mastery = mastery_types.get("Life Mastery").copied().unwrap_or(0);
    for m in pom_calc::setup::allocated_count_mods(spec.allocated_notable_count.max(0) as usize, spec.allocated_keystone_count.max(0) as usize, spec.allocated_mastery_count.max(0) as usize, mastery_types.len(), life_mastery) {
        player.add_mod(m);
    }
    // `allocatedTattooTypes` (PassiveSpec.lua:1461, CalcSetup.lua:793-797): `env.modDB.multipliers[overrideType] = count`.
    {
        let mut tattoo_types: HashMap<&str, f64> = HashMap::default();
        for n in spec.nodes.values().filter(|n| n.alloc && n.is_tattoo) {
            if let Some(t) = n.override_type.as_deref() {
                *tattoo_types.entry(t).or_insert(0.0) += 1.0;
            }
        }
        for (t, c) in tattoo_types {
            player.multipliers.insert(Sym::new(t), c);
        }
    }


    pf.lap("mastery_counts");
    // ---- config: settled over two passes (OnFrame x2), like calc's own setup.rs callers ----
    let config_data = parse_config_memo(xml_text)?;
    let set = config_data.config_sets.get(&config_data.active_config_set_id).ok_or("active <ConfigSet> missing")?;
    // `ConfigTab:BuildModList`'s tail (enabled custom-modifier blocks, source "Custom:<title>") is applied inside.
    let settled = settled_config(xml_text, game, character_level).ok_or("active <ConfigSet> missing")?;
    let ph2 = settled.2.clone();
    let mut parent_level_mods: Vec<Mod> = Vec::new();
    for m in settled.0.iter() {
        parent_level_mods.push(m.clone());
        player.add_mod(m.clone());
    }
    for m in settled.1.iter() {
        enemy.add_mod(m.clone());
    }
    pf.lap("config");
    // CalcSetup.lua:685: `env.enemyDB:AddList(build.partyTab.enemyModList)`; the party actor feeds the buff loop and resist-equal-to-yours.
    let party_data = std::sync::Arc::new(party::parse_party(xml_text));
    party::set_current(party_data.clone());
    for m in &party_data.enemy_mods {
        enemy.add_mod(m.clone());
    }
    let mut config_input = HashMap::default();
    let mut config_flags = HashMap::default();
    let mut config_str = HashMap::default();
    for (k, v) in &set.input {
        match v {
            pom_config::types::OwnedOptionValue::Num(n) => {
                config_input.insert(k.clone(), *n);
            }
            pom_config::types::OwnedOptionValue::Bool(b) => {
                config_flags.insert(k.clone(), *b);
            }
            pom_config::types::OwnedOptionValue::Str(s) => {
                config_str.insert(k.clone(), s.to_string());
            }
        }
    }
    // `env.configPlaceholder` (CalcSetup.lua:497, settled the same OnFrame-x2 way as the config
    // mods themselves above) - `pom_defence::estimations::EstimationsEnv`'s own `config_placeholder`/
    // `config_placeholder_str` input, split the same way `config_input`/`config_str` are.
    let mut config_placeholder = HashMap::default();
    let mut config_placeholder_str = HashMap::default();
    for (k, v) in &ph2 {
        match v {
            pom_config::types::OwnedOptionValue::Num(n) => {
                config_placeholder.insert(k.clone(), *n);
            }
            pom_config::types::OwnedOptionValue::Str(s) => {
                config_placeholder_str.insert(k.clone(), s.to_string());
            }
            pom_config::types::OwnedOptionValue::Bool(_) => {}
        }
    }

    pf.lap("party_config");
    // ---- calc base mods (init_mod_db + player/enemy base mods), Modules/CalcSetup.lua initEnv ----
    let cc = pom_calc::data::CharacterConstants::shared();
    let init_mode = pom_calc::setup::buff_mode();
    let init = pom_calc::setup::init_mod_db_shared(init_mode.buffs, init_mode.combat, init_mode.effective);
    for m in &init.mods {
        parent_level_mods.push(m.clone());
        // (player copy was added up front, see `early_base`)
        enemy.add_mod(m.clone());
    }
    for (name, val) in &init.conditions {
        player.conditions.insert(Sym::new(name), *val);
        enemy.conditions.insert(Sym::new(name), *val);
    }
    // `env.configInput.bandit` comes from the Config tab's `bandit` input only; the <Build bandit=>
    // attribute is not read.
    let bandit = config_str.get("bandit").cloned();
    // Pantheon mods (CalcSetup.lua:662-673, PantheonTools.lua `applySoulMod`): every soul mod line of the chosen
    // major/minor god through parseMod, sourced "Pantheon:<first soul name>".
    for key in ["pantheonMajorGod", "pantheonMinorGod"] {
        let Some(god_name) = config_str.get(key).filter(|g| g.as_str() != "None") else { continue };
        let Ok(Some(pantheons)) = game.extra.get("pantheons") else { continue };
        let Some(souls) = pantheons.get(god_name.as_str()).and_then(|g| g.get("souls")).and_then(|s| s.as_array()) else { continue };
        let source: std::sync::Arc<str> = format!("Pantheon:{}", souls.first().and_then(|s| s.get("name")).and_then(|n| n.as_str()).unwrap_or("")).into();
        for soul in souls {
            for soul_mod in soul.get("mods").and_then(|m| m.as_array()).into_iter().flatten() {
                let Some(line) = soul_mod.get("line").and_then(|l| l.as_str()) else { continue };
                if let (Some(parsed), None) = pom_engine::modparser::parse_mod(line) {
                    for pmod in &parsed {
                        let mut m = pmod_to_mod(pmod);
                        m.source = Some(source.clone());
                        parent_level_mods.push(m.clone());
                    }
                }
            }
        }
    }
    // `env.configInput.resistancePenalty or -60` (CalcSetup.lua:605-608).
    let resistance_penalty = config_input.get("resistancePenalty").copied();
    let cfg_subset = pom_calc::setup::ConfigInputSubset { bandit, resistance_penalty };
    for m in pom_calc::setup::player_base_mods(&cc, &tree_version, spec.cur_class_id, character_level, &cfg_subset) {
        parent_level_mods.push(m.clone());
    }
    player.multipliers.insert(pom_engine::sym!("Level"), pom_calc::setup::level_multiplier(character_level));

    // `configTab.enemyLevel` (ConfigTab.lua:1121-1126): explicit input, else the boss-type placeholder (84/85), else the character level.
    let max_enemy_level = game.misc.get("MaxEnemyLevel").unwrap_or(character_level);
    let enemy_level = match (config_input.get("enemyLevel").copied().filter(|v| *v > 0.0), config_placeholder.get("enemyLevel").copied().filter(|v| *v > 0.0)) {
        (Some(v), _) | (None, Some(v)) => v.min(max_enemy_level),
        _ => max_enemy_level.min(character_level),
    };
    for m in pom_calc::setup::enemy_base_mods(enemy_level as i64) {
        enemy.add_mod(m);
    }

    pf.lap("base_mods");
    // `env.player.itemList` + `FindModifierSubstring` results for every `ItemCondition` tag now on the modDB.
    let item_actor = build_item_actor(&item_list, &player, game);
    let item_actor_info: ItemActorInfo = (item_actor.items, item_actor.item_search);

    let mut weapon_range: HashMap<String, f64> = HashMap::default();
    for (slot_name, item_id, _) in &slots {
        let idx = match slot_name.as_str() {
            "Weapon 1" => 0,
            "Weapon 2" => 1,
            _ => continue,
        };
        let Some(wd) = items.get(item_id).and_then(|i| i.weapon_data.as_ref()).and_then(|w| w.get(idx)) else { continue };
        if let Some(r) = wd.get("range").and_then(|r| r.as_f64()) {
            weapon_range.insert(slot_name.clone(), r);
        }
    }
    // CalcSetup.lua:1567-1568: a `countsAsDualWielding` Weapon 1 supplies `weaponData[2]` as the off hand.
    if let Some(wd1) = slots.iter().find(|(n, _, _)| n == "Weapon 1").and_then(|(_, id, _)| items.get(id)).and_then(|i| i.weapon_data.as_ref()) {
        if wd1.first().and_then(|v| v.get("countsAsDualWielding")).and_then(|v| v.as_bool()).unwrap_or(false) {
            weapon_range.remove("Weapon 2");
            if let Some(r) = wd1.get(1).and_then(|v| v.get("range")).and_then(|r| r.as_f64()) {
                weapon_range.insert("Weapon 2".to_string(), r);
            }
        }
    }

    pf.lap("tail");
    let setup_snapshot = if stage_snapshots_on() { vec![("setup", snapshot(&player))] } else { Vec::new() };
    pf.lap("snapshot");
    let mut env = Env {
        run_links: run_links.clone(),
        tertiary_occ: Vec::new(),
        granted_triggered,
        granted_trigger_chance,
        inactive_item_grants,
        parent_level_mods,
        recorded_override: None,
        parent_snapshot: None,
        parent_output: None,
        items,
        slot_items: slots.iter().map(|(n, id, _)| (n.clone(), *id)).collect(),
        minion_limit: None,
        parent_weapon1_crit: None,
        item_actor_info,
        xml_text: xml_text.to_string(),
        character_level,
        tree_version,
        class_id: spec.cur_class_id,
        player,
        enemy,
        item_armour,
        weapon_data,
        actor_weapons,
        aegis_mod_list,
        weapon_mod_list1,
        weapons_disabled: false,
        keystone_mods,
        keystone_map,
        weapon_conditions,
        keystones_added,
        active_flask_mods,
        flask_removes_bleed,
        flask_life_per_s,
        active_tinctures,
        tincture_params: (0.0, 0.0, 0.0),
        points_used,
        flask_cond_info,
        magic_utility_flasks,
        config_input,
        config_flags,
        config_str,
        config_placeholder,
        config_placeholder_str,
        enemy_level,
        active_skills,
        raw_skills,
        output: HashMap::default(),
        output_lists: HashMap::default(),
        skill_dps: Vec::new(),
        trigger_apply: None,
        output_str: HashMap::default(),
        weapon_range,
        attr_reqs,
        attr_req_srcs,
        output_extra: HashMap::default(),
        game,
        minion_info: None,
        minion_mods: None,
        minion_skill_ids: Vec::new(),
        low_pool_threshold: game.misc.get("LowPoolThreshold").unwrap_or(0.5),
        temporal_chains_cap: game.misc.get("TemporalChainsEffectCap").unwrap_or(75.0),
        stages_run: vec!["setup"],
        stage_snapshots: setup_snapshot,
        pristine: None,
        fulldps_rows: false,
        buff_exports: None,
    };
    // calcFullDPS re-runs the whole calc once per FullDPS skill on a fresh env. That env only depends on the XML,
    // so keep a copy from before `run` mutates this one and let each FullDPS row start from it.
    if let Some(w) = timeless_warning {
        env.output_extra.insert("TimelessDataWarning".to_string(), serde_json::json!(w));
    }
    if xml_contains_any(xml_text, &["includeInFullDPS=\"true\""]) {
        env.fulldps_rows = true;
        if !SKIP_PRISTINE.with(|c| c.get()) {
            env.pristine = Some(Box::new(env.clone()));
        }
    }
    Ok(env)
}

/// Runs the calc stages in the order of `calcs.perform` (see `pom_calc::perform`'s module doc): `mergeKeystones`,
/// the attribute-value/attribute-bonus block, `mergeFlasks`'s innate-mod half, buffs, `pom_defence::defence`, then
/// offence.
struct BdRunDepth;
impl BdRunDepth {
    fn enter() -> BdRunDepth {
        pom_offence::bd::enter_run();
        BdRunDepth
    }
}
impl Drop for BdRunDepth {
    fn drop(&mut self) {
        pom_offence::bd::exit_run();
    }
}

pub fn run(env: &mut Env) {
    buff_export::EXPORT_ON.with(|c| c.set(buff_export::enabled(&env.xml_text)));
    let _bd_run_depth = BdRunDepth::enter();
    let _bd_perform = bd_perform::PerformScope::enter();
    mem_probe("run start");
    let links = env.run_links.clone();
    let _links_scope = pom_engine::modstore::types::use_run_links(&links);
    // doActorAttribsConditions' "Set conditions" head (CalcPerform.lua:146-297), before anything reads conditions.
    for c in env.weapon_conditions.clone() {
        env.player.conditions.insert(Sym::new(&c), true);
    }
    let combat = pom_calc::setup::buff_mode().combat;
    if combat {
        crate::actor_misc::shrine_buffs(&mut env.player);
        if let Some(main) = crate::offence::select_main_skill(&env.xml_text, &env.active_skills) {
            let triggered = matches!(crate::offence::skill_data_map(&env.player, main).get("triggered"), Some(v) if !matches!(v, pom_engine::modstore::types::ScalarValue::Bool(false)));
            for c in attrib_conds::combat_conditions(main, triggered) {
                env.player.conditions.insert(Sym::new(&c), true);
            }
        }
    }
    // a. modLib.mergeKeystones(env, env.modDB) - CalcPerform.lua:1292.
    for mods in &env.keystone_mods {
        for m in mods {
            env.player.add_mod(m.clone());
        }
    }
    merge_keystone_markers(env);
    env.stages_run.push("merge_keystones");
    mem_probe("merge_keystones");
    if stage_end(env, 0) {
        return;
    }

    // Per-actually-summoned-minion counting (CalcPerform.lua:1436-1506, `pom_calc::
    // perform_minions::compute_minion_mods`) - one of the "early sections" `pom_calc::perform`'s
    // own module doc places before `mergeFlasks`/attributes, well before the buff loop. Needs only
    // `env.active_skills`' own `skill_types`/`skill_flags`/`skill_mod_list`/gem identity (already
    // real and live, same shape `compute_reservation` below uses) plus
    // `env.configInput.multiplierSummonedMinion` - no minion actor is needed, unlike `init_minion_mod_db`.
    let skill_snapshots_early: Vec<pom_calc::snapshot::SkillSnapshot> = env
        .active_skills
        .iter()
        .map(|c| pom_calc::snapshot::SkillSnapshot {
            name: Some(c.name.clone()),
            skill_flags: c.skill_flags.iter().map(|f| (f.clone(), true)).collect(),
            skill_types: c.skill_types.iter().copied().collect(),
            skill_mod_list: c.skill_mod_list.clone(),
            gem: Some(pom_calc::snapshot::GemRef { granted_effect_id: Some(c.granted_effect_id.clone()), gem_id: None, level: c.level, quality: c.quality }),
            cfg: None,
        })
        .collect();
    let minion_override = env.config_input.get("multiplierSummonedMinion").copied().filter(|v| *v != 0.0);
    let minion_lists_early: Vec<Vec<String>> = env.active_skills.iter().map(|c| minion::full_minion_list(env, c)).collect();
    let minion_mods = pom_calc::perform_minions::compute_minion_mods_with_lists(&env.player, &skill_snapshots_early, minion_override, Some(&minion_lists_early));
    // `modDB:NewMod("Multiplier:SummonedMinion", "BASE", counts.total, "Config", { type = "Condition", var = "Combat" })`
    // (CalcPerform.lua:1498-1506): the minion counts only apply in the combat modes.
    for (name, val) in &minion_mods.multiplier_mods {
        let combat = pom_engine::modifier::Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), pom_engine::value::Value::Str(std::sync::Arc::from("Combat")))] };
        env.player.add_mod(Mod { name: Sym::new(name), ty: ModType::Base, value: pom_engine::value::Value::Num(*val), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Config")), tags: (vec![combat]).into() });
    }
    if minion_mods.have_damageable_minion {
        env.player.add_mod(Mod { name: pom_engine::sym!("Condition:HaveDamageableMinion"), ty: ModType::Flag, value: pom_engine::value::Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() });
    }
    env.player.conditions.insert(pom_engine::sym!("OnlyMinion"), minion_mods.only_minion);
    let minion_limit_outputs = minion_mods.limit_outputs.clone();
    env.stages_run.push("minion_counts");
    mem_probe("minion_counts");
    if stage_end(env, 1) {
        return;
    }
    // `if modDB:Flag(nil, "ConvertArmourESToLife")` (CalcPerform.lua:1524-1537): each armour slot's
    // base ES becomes a Life BASE mod.
    if env.player.flag(None, &[pom_engine::sym!("ConvertArmourESToLife")]) {
        for slot in ["Helmet", "Gloves", "Boots", "Body Armour", "Weapon 2", "Weapon 3"] {
            // CalcPerform.lua:1322 already removed `itemList["Weapon 2"]` when Necromantic Aegis took the shield.
            if slot == "Weapon 2" && !env.aegis_mod_list.is_empty() {
                continue;
            }
            if let Some(ad) = env.item_armour.get(slot) {
                if ad.energy_shield > 0.0 {
                    let v = ad.energy_shield;
                    env.player.add_mod(Mod { name: pom_engine::sym!("Life"), ty: ModType::Base, value: pom_engine::value::Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(format!("{slot} ES to Life Conversion").as_str())), tags: (vec![]).into() });
                }
            }
        }
    }
    // `initMinionModDB` for the main skill's minion (CalcPerform.lua:1316-1321).
    let mut minion_actor: Option<minion::MinionActor> = None;
    let mut minion_main: Option<pom_skills::assemble::ComputedSkill> = None;
    if let Some(main) = crate::offence::select_main_skill(&env.xml_text, &env.active_skills) {
        minion_actor = minion::create(env, main);
        if let Some(m) = &minion_actor {
            // The Calcs view lists the skills of the minion the main skill raised, not of whichever minion a later pass
            // (a Full DPS row, another group's skill) happened to create.
            if offence_dps::MAIN_OVERRIDE.with(|c| c.get()).is_none() {
                calcs_popup::note_minion_skills(minion::skill_names(m));
            }
            minion_main = Some(main.clone());
            env.minion_limit = Some(pom_calc::data::minion_raw(&m.ty).and_then(|r| r.get("limit")).and_then(|l| l.as_str()).unwrap_or("").to_string());
        }
    }

    // `if env.aegisModList then env.player.itemList["Weapon 2"] = nil end` (CalcPerform.lua:1322): with Necromantic
    // Aegis the shield's block/defences belong to the minion only, so the player's own shield is gone from here on.
    if !env.aegis_mod_list.is_empty() {
        env.item_armour.remove("Weapon 2");
        env.item_actor_info.0.retain(|k, _| &**k != "Weapon 2");
    }

    // c. env.player.output = {} - fresh for this pass.
    env.output.clear();
    env.output_lists.clear();
    // `output[minionData.limit]` set during minion counting, which in upstream runs after the wipe.
    for (k, v) in minion_limit_outputs {
        env.output.insert(k, v);
    }

    // Banners / warcry power / brands / totem limits (CalcPerform.lua:1331-1381).
    let chill_skills: Vec<usize>;
    let guaranteed_bonechill: bool;
    {
        let main_idx = crate::offence::select_main_skill(&env.xml_text, &env.active_skills).and_then(|m| env.active_skills.iter().position(|c| std::ptr::eq(c, m)));
        crate::actor_misc::early_perform(&mut env.player, &mut env.enemy, &mut env.output, &mut env.active_skills, main_idx);
        (chill_skills, guaranteed_bonechill) = crate::ailments::early_skill_ailments(&mut env.player, &mut env.enemy, &mut env.output, &env.active_skills);
    }

    // Special rarity/quantity calc for Bisco's (CalcPerform.lua:1509-1512).
    {
        let inc = |n: &str| env.player.sum(ModType::Inc, None, &[Sym::new(n)]);
        let q = inc("LootQuantityNormalEnemies");
        let r = inc("LootRarityMagicEnemies");
        let qv = if q > 0.0 { q + inc("LootQuantity") } else { 0.0 };
        let rv = if r > 0.0 { r + inc("LootRarity") } else { 0.0 };
        env.output.insert("LootQuantityNormalEnemies".to_string(), qv);
        env.output.insert("LootRarityMagicEnemies".to_string(), rv);
    }

    // Totem counts (CalcPerform.lua:1371-1375): for every totem skill, the limit comes from the *main*
    // skill's mod list; `TotemsSummoned` (PerStat "per Summoned Totem") reads the actor output.
    if env.active_skills.iter().any(|c| c.skill_flags.contains("totem")) {
        if let Some(main) = crate::offence::select_main_skill(&env.xml_text, &env.active_skills) {
            let snap = crate::buffs::player_snapshot(&env.player);
            let mut store = ModStore::new_list(Some(snap.clone()), snap.actor.clone());
            for m in &main.skill_mod_list {
                store.add_mod(m.clone());
            }
            let cfg = crate::buffs::skill_cfg(main);
            let limit = store.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ActiveTotemLimit"), pom_engine::sym!("ActiveBallistaLimit")]);
            // `m_max(limit, output.ActiveTotemLimit or 0)`, once per totem skill (idempotent).
            let active_limit = limit.max(0.0);
            let summoned = env.player.override_(None, &[pom_engine::sym!("TotemsSummoned")]).and_then(|v| v.num()).unwrap_or(active_limit);
            env.output.insert("ActiveTotemLimit".to_string(), active_limit);
            env.output.insert("TotemsSummoned".to_string(), summoned);
            let e = env.enemy.multipliers.entry(pom_engine::sym!("TotemsSummoned")).or_insert(0.0);
            if summoned > *e {
                *e = summoned;
            }
        }
    }
    // `env.enemy.modDB.multipliers["ActiveMineCount"] = m_max(activeMineCount, current)` per mine skill
    // (CalcActiveSkill.lua:626), read by the enemy-side "each mine applies N% reduced damage" mods.
    for c in env.active_skills.iter().filter(|_| !offence_dps::FD_ENEMY_MULTS_WIPED.with(|w| w.get())) {
        if let Some(n) = c.active_mine_count.filter(|n| *n > 0.0) {
            let e = env.enemy.multipliers.entry(pom_engine::sym!("ActiveMineCount")).or_insert(0.0);
            if n > *e {
                *e = n;
            }
        }
    }

    // mergeFlasks' innate-mod half (CalcPerform.lua:1937, approximated), BEFORE
    // attributes: the real call order merges flasks first specifically so a flask-granted
    // attribute mod feeds into the attribute-value/bonus block that follows it
    // (CalcPerform.lua:1936 "This needs to be done in 2 steps to account for effects affecting
    // life recovery from flasks" / the attribute comment right above line 1944's
    // `doActorAttribsConditions` call).
    // Damage to Aura Effect conversion from Breach rings (CalcPerform.lua:1539-1564).
    for (element, kw) in [("Lightning", pom_engine::modparser::flags::keyword_flag::Lightning), ("Fire", pom_engine::modparser::flags::keyword_flag::Fire), ("Cold", pom_engine::modparser::flags::keyword_flag::Cold), ("Chaos", pom_engine::modparser::flags::keyword_flag::Chaos), ("Physical", pom_engine::modparser::flags::keyword_flag::Physical)] {
        if !env.player.flag(None, &[Sym::new(&format!("{element}DamageAppliesTo{element}AuraEffect"))]) {
            continue;
        }
        // `Sum(...) or 100`: Sum always returns a number, so the `or 100` never applies.
        let multiplier = env.player.sum(ModType::Base, None, &[Sym::new(&format!("Improved{element}DamageAppliesTo{element}AuraEffect"))]) / 100.0;
        let limit = env.player.max(None, &[Sym::new(&format!("{element}DamageAppliesTo{element}AuraEffectLimit"))]);
        let mut total_converted = 0.0;
        let empty = pom_engine::modstore::types::Cfg::default();
        let found = env.player.tabulate(Some(ModType::Inc), Some(&empty), &[Sym::new(&format!("{element}Damage"))]);
        let mut new_mods: Vec<Mod> = Vec::new();
        for (_, mp) in found {
            let m = unsafe { &*mp };
            let val = m.value.num().unwrap_or(0.0);
            let tags: Vec<pom_engine::modifier::Tag> = m
                .tags
                .iter()
                .map(|t| {
                    let mut t = t.clone();
                    if t.get(pom_engine::sym!("limitTotal")).truthy() {
                        for (k, fv) in t.fields.iter_mut() {
                            if k.as_str() == "limit" {
                                if let pom_engine::value::Value::Num(l) = fv {
                                    *l *= multiplier;
                                }
                            }
                        }
                    }
                    t
                })
                .collect();
            let mut converted = (val * multiplier).floor();
            if let Some(limit) = limit {
                if converted > 0.0 {
                    let remaining = limit - total_converted;
                    if remaining <= 0.0 {
                        converted = 0.0;
                    } else {
                        converted = converted.min(remaining);
                        total_converted += converted;
                    }
                }
            }
            if converted != 0.0 {
                new_mods.push(Mod { name: pom_engine::sym!("AuraEffect"), ty: m.ty, value: pom_engine::value::Value::Num(converted), flags: m.flags, keyword_flags: kw, source: m.source.clone(), tags: (tags).into() });
            }
        }
        for nm in new_mods {
            env.player.add_mod(nm);
        }
    }
    // Minion Life conversion from Rigwald's Hunt (CalcPerform.lua:1566-1575).
    if env.player.flag(None, &[pom_engine::sym!("MinionLifeAppliesToPlayer")]) {
        let multiplier = env.player.max(None, &[pom_engine::sym!("ImprovedMinionLifeAppliesToPlayer")]).unwrap_or(100.0) / 100.0;
        let mut converted = Vec::new();
        for value in env.player.list(None, &[pom_engine::sym!("MinionModifier")]) {
            let pom_engine::value::Value::Map(outer) = &value else { continue };
            let Some(pom_engine::value::Value::Map(inner)) = outer.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v) else { continue };
            let get = |k: &str| inner.iter().find(|(kk, _)| kk.as_str() == k).map(|(_, v)| v);
            let is_str = |k: &str, want: &str| matches!(get(k), Some(pom_engine::value::Value::Str(s)) if &**s == want);
            if !(is_str("name", "Life") && is_str("type", "INC")) {
                continue;
            }
            let val = get("value").and_then(|v| v.num()).unwrap_or(0.0);
            let num = |k: &str| get(k).and_then(|v| v.num()).unwrap_or(0.0) as u64;
            // tags are the numerically-keyed entries "1", "2", ... (getConvertedModTags, minionMods=true)
            let mut tags = Vec::new();
            let mut i = 1;
            while let Some(pom_engine::value::Value::Map(t)) = get(&i.to_string()) {
                let kind = t.iter().find_map(|(k, v)| if k.as_str() == "type" { if let pom_engine::value::Value::Str(s) = v { Some(Sym::new(s)) } else { None } } else { None });
                if let Some(kind) = kind {
                    let mut fields: Vec<(Sym, pom_engine::value::Value)> = t.iter().filter(|(k, _)| k.as_str() != "type").map(|(k, v)| (*k, v.clone())).collect();
                    let actor_parent = fields.iter().any(|(k, v)| k.as_str() == "actor" && matches!(v, pom_engine::value::Value::Str(s) if &**s == "parent"));
                    if kind.as_str() == "ActorCondition" && actor_parent {
                        fields.retain(|(k, _)| k.as_str() == "var");
                        tags.push(pom_engine::modifier::Tag { kind: pom_engine::sym!("Condition"), fields });
                    } else {
                        tags.push(pom_engine::modifier::Tag { kind, fields });
                    }
                }
                i += 1;
            }
            let source = match get("source") {
                Some(pom_engine::value::Value::Str(s)) => Some(s.clone()),
                _ => None,
            };
            converted.push(Mod { name: pom_engine::sym!("Life"), ty: ModType::Inc, value: pom_engine::value::Value::Num((val * multiplier).floor()), flags: num("flags"), keyword_flags: num("keywordFlags"), source, tags: (tags).into() });
        }
        for m in converted {
            env.player.add_mod(m);
        }
    }
    // Special handling of Mageblood (CalcPerform.lua:1577-1600): the first N (left) / last M (right)
    // magic utility flasks count as active.
    {
        let left = env.player.sum(ModType::Base, None, &[pom_engine::sym!("LeftActiveMagicUtilityFlasks")]).max(0.0) as usize;
        let right = env.player.sum(ModType::Base, None, &[pom_engine::sym!("RightActiveMagicUtilityFlasks")]).max(0.0) as usize;
        if left > 0 || right > 0 {
            let mut order: Vec<usize> = (0..env.magic_utility_flasks.len()).collect();
            order.sort_by_key(|&i| {
                let n = env.magic_utility_flasks[i].0.rsplit(' ').next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(99);
                n
            });
            let n = order.len();
            let mut picked: Vec<usize> = order.iter().copied().take(left.min(n)).collect();
            let mut i = n;
            while i > 0 && i > n.saturating_sub(right) {
                picked.push(order[i - 1]);
                i -= 1;
            }
            for idx in picked {
                let (_, active, input, cond) = env.magic_utility_flasks[idx].clone();
                if !active {
                    env.magic_utility_flasks[idx].1 = true;
                    env.flask_cond_info.push(cond);
                    env.active_flask_mods.push(input);
                }
            }
        }
    }
    // Alchemist's Genius (CalcPerform.lua:1325-1329): injects FlaskEffect/FlaskChargesGained before mergeFlasks and the output block.
    pom_calc::perform::apply_alchemists_genius(&mut env.player);
    // Flask / tincture output block (CalcPerform.lua:1602-1634, 1851-1858; only written when `breakdown` is on,
    // which the graded runs always have).
    {
        let player_cfg = pom_engine::modstore::types::Cfg { actor_tag: Some(std::sync::Arc::from("player")), ..Default::default() };
        let sum = |t: ModType, n: &str| env.player.sum(t, if n.ends_with("Effect") { Some(&player_cfg) } else { None }, &[Sym::new(n)]);
        let used_flasks = env.active_flask_mods.len() as f64;
        let charges = sum(ModType::Base, "FlaskChargesGenerated") + sum(ModType::Base, "FlaskChargesGeneratedPerEmptyFlask") * (5.0 - used_flasks);
        let utility = sum(ModType::Base, "UtilityFlaskChargesGenerated");
        let life = sum(ModType::Base, "LifeFlaskChargesGenerated");
        let mana = sum(ModType::Base, "ManaFlaskChargesGenerated");
        let vals = [
            ("FlaskEffect", sum(ModType::Inc, "FlaskEffect")),
            ("FlaskChargeGen", charges),
            ("LifeFlaskChargeGen", charges + life),
            ("ManaFlaskChargeGen", charges + mana),
            ("UtilityFlaskChargeGen", charges + utility),
            ("FlaskChargeOnCritChance", sum(ModType::Base, "FlaskChargeOnCritChance").min(100.0)),
            ("TinctureEffect", sum(ModType::Inc, "TinctureEffect")),
            ("TinctureLimit", sum(ModType::Base, "TinctureLimit")),
        ];
        env.tincture_params = (sum(ModType::Inc, "TinctureEffect"), sum(ModType::Inc, "MagicTinctureEffect"), sum(ModType::Base, "TinctureLimit"));
        for (k, v) in vals {
            env.output.insert(k.to_string(), v);
        }
        // CalcOffence.lua:565-566: `env.itemModDB.multipliers[..]` is nil (key absent) without a life flask.
        for k in ["LifeFlaskRecovery", "LifeFlaskCharges"] {
            if let Some(v) = env.player.multipliers.get(&Sym::new(k)) {
                env.output.insert(k.to_string(), *v);
            }
        }
    }
    // `if env.mode_combat then mergeFlasks(env.flasks, false, true) ...` (CalcPerform.lua:1934): no flask mods, flask
    // conditions or flask minion mods outside the combat modes.
    let flasks_on = pom_calc::setup::buff_mode().combat;
    if flasks_on {
        for m in pom_calc::perform::merge_flask_mods(&env.player, &env.active_flask_mods) {
            env.player.add_mod(m);
        }
    }
    // Flask conditions (CalcPerform.lua:1774-1793, applied at 1832-1834): `UsingFlask`,
    // `Using<BaseName>`, `UsingLifeFlask`, `UsingManaFlask`, unless FlasksDoNotApplyToPlayer;
    // `UtilityFlasksDoNotApplyToPlayer` restricts them to life/mana flasks.
    if flasks_on && !env.player.flag(None, &[pom_engine::sym!("FlasksDoNotApplyToPlayer")]) {
        let utility_off = env.player.flag(None, &[pom_engine::sym!("UtilityFlasksDoNotApplyToPlayer")]);
        let low_life = env.player.flag(None, &[pom_engine::sym!("Condition:LowLife")]);
        let cannot_recover_life = env.player.flag(None, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]);
        let life_inst = env.player.sum(ModType::Base, None, &[pom_engine::sym!("LifeFlaskInstantRecovery")]);
        let mana_inst = env.player.sum(ModType::Base, None, &[pom_engine::sym!("ManaFlaskInstantRecovery")]);
        let mut conds: Vec<String> = Vec::new();
        for (base_name, is_life, is_mana, inst, inst_low, _, _) in &env.flask_cond_info {
            let mut instant = *inst + if low_life { *inst_low } else { 0.0 };
            if *is_life { instant += life_inst; }
            if *is_mana { instant += mana_inst; }
            if instant.min(100.0) < 100.0 {
                let non_utility = *is_life || *is_mana;
                let using = format!("Using{}", base_name.split_whitespace().collect::<String>());
                if !utility_off || non_utility {
                    conds.push("UsingFlask".into());
                    conds.push(using);
                    if *is_life && !cannot_recover_life { conds.push("UsingLifeFlask".into()); }
                    if *is_mana { conds.push("UsingManaFlask".into()); }
                }
            }
        }
        // Iron Flask with enough charges generated on Ward break (CalcPerform.lua:1793-1801); a utility flask, so only
        // in the full (not non-utility) condition set.
        if !utility_off {
            let generated = env.player.sum(ModType::Base, None, &[pom_engine::sym!("IronFlaskChargesGeneratedOnWardBreak")]);
            if generated > 0.0 {
                let gained_inc = env.player.sum(ModType::Inc, None, &[pom_engine::sym!("FlaskChargesGained")]);
                let used_inc = env.player.sum(ModType::Inc, None, &[pom_engine::sym!("FlaskChargesUsed")]);
                for (base_name, _, _, _, _, gain, used) in &env.flask_cond_info {
                    if base_name == "Iron Flask" && generated * (gain * (1.0 + gained_inc / 100.0)) > used * (1.0 + used_inc / 100.0) {
                        conds.push("UnbrokenWard".into());
                    }
                }
            }
        }
        for c in conds {
            env.player.conditions.insert(Sym::new(&c), true);
        }
    }
    // CalcPerform.lua:1607-1609, 1830-1849: flasks applied to the main skill's minion (`FlasksApplyToMinion`, Quicksilver
    // applied to allies). `ParentNonUniqueFlasksAppliedToYou` (link skills) is not ported.
    if flasks_on && minion_actor.is_some() {
        let main_cfg = crate::offence::select_main_skill(&env.xml_text, &env.active_skills).map(crate::buffs::skill_cfg);
        let applies_all =env.player.flag(main_cfg.as_ref(), &[pom_engine::sym!("FlasksApplyToMinion")]);
        let quicksilver = env.player.flag(main_cfg.as_ref(), &[pom_engine::sym!("QuickSilverAppliesToAllies")]);
        if applies_all || quicksilver {
            let mf = pom_calc::perform::merge_flask_mods_non_player(&env.player, &env.active_flask_mods, &|_| true);
            let low_life = env.player.flag(None, &[pom_engine::sym!("Condition:LowLife")]);
            let cannot_recover_life = env.player.flag(None, &[pom_engine::sym!("CannotRecoverLifeOutsideLeech")]);
            let life_inst = env.player.sum(ModType::Base, None, &[pom_engine::sym!("LifeFlaskInstantRecovery")]);
            let mana_inst = env.player.sum(ModType::Base, None, &[pom_engine::sym!("ManaFlaskInstantRecovery")]);
            let mut conds: Vec<String> = Vec::new();
            for (base_name, is_life, is_mana, inst, inst_low, _, _) in &env.flask_cond_info {
                let mut instant = *inst + if low_life { *inst_low } else { 0.0 };
                if *is_life { instant += life_inst; }
                if *is_mana { instant += mana_inst; }
                if instant.min(100.0) < 100.0 {
                    conds.push("UsingFlask".into());
                    conds.push(format!("Using{}", base_name.split_whitespace().collect::<String>()));
                    if *is_life && !cannot_recover_life { conds.push("UsingLifeFlask".into()); }
                    if *is_mana { conds.push("UsingManaFlask".into()); }
                }
            }
            if let Some(m) = minion_actor.as_mut() {
                if applies_all {
                    for c in &conds { m.store.conditions.insert(Sym::new(c), true); }
                    for md in mf.all { m.store.add_mod(md); }
                } else if let Some(list) = mf.per_base.get("Quicksilver Flask") {
                    m.store.conditions.insert(pom_engine::sym!("UsingQuicksilverFlask"), conds.iter().any(|c| c == "UsingQuicksilverFlask"));
                    m.store.conditions.insert(pom_engine::sym!("UsingFlask"), conds.iter().any(|c| c == "UsingFlask"));
                    for md in list.clone() { m.store.add_mod(md); }
                }
            }
        }
    }
    // CalcPerform.lua:1936-1940: merge keystones again to catch any that were added by flasks
    if flasks_on {
        merge_keystone_markers(env);
    }
    env.stages_run.push("flasks");
    mem_probe("flasks");
    if stage_end(env, 2) {
        return;
    }
    if stage_snapshots_on() {
        env.stage_snapshots.push(("flasks", snapshot(&env.player)));
    }

    // attributes + attribute-bonus mods (CalcPerform.lua:411-528, called from line 1944).
    // `if modDB:Flag(nil, "Omniscience") then calculateOmniscience() else calculateAttributes() end`
    // (CalcPerform.lua:504-508) - both paths feed the same downstream attribute-bonus block.
    let omniscience = env.player.flag(None, &[pom_engine::sym!("Omniscience")]);
    // `calculateAttributes` runs its body twice ("Calculate twice because of circular dependency (X attribute
    // higher than Y attribute)", CalcPerform.lua:412): pass 1 sets the attribute-comparison conditions that
    // pass 2's `calcLib.val` (e.g. "15% increased Dexterity if Strength is higher than Intelligence") reads.
    let set_attr_conds = |env: &mut Env, attrs: &pom_calc::perform::Attributes| {
        let (s, d, i) = (attrs.str_, attrs.dex, attrs.int_);
        let mut stats = [s, d, i];
        stats.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for (name, v) in [
            ("TwoHighestAttributesEqual", stats[1] == stats[2]),
            ("DexHigherThanInt", d > i),
            ("StrHigherThanInt", s > i),
            ("IntHigherThanDex", i > d),
            ("StrHigherThanDex", s > d),
            ("IntHigherThanStr", i > s),
            ("DexHigherThanStr", d > s),
            ("StrHighestAttribute", s >= d && s >= i),
            ("IntHighestAttribute", i >= s && i >= d),
            ("DexHighestAttribute", d >= s && d >= i),
            ("IntSingleHighestAttribute", i > s && i > d),
            ("DexSingleHighestAttribute", d > s && d > i),
        ] {
            env.player.conditions.insert(Sym::new(name), v);
        }
    };
    let attrs = if omniscience {
        let class_stats = pom_calc::data::class_base_stats(&env.tree_version, env.class_id);
        let omni = pom_calc::perform_omni::calculate_omniscience_with(&mut env.player, &class_stats, &mut |store, stat, total| bd_perform::attribute_table(store, stat, total));
        env.output.insert("Omni".to_string(), omni.omni);
        pom_calc::perform::Attributes { str_: omni.str_, dex: omni.dex, int_: omni.int_ }
    } else {
        let pass1 = pom_calc::perform::compute_attributes(&env.player);
        set_attr_conds(env, &pass1);
        let pass2 = pom_calc::perform::compute_attributes(&env.player);
        bd_perform::attribute_tables(&env.player, pass2.str_, pass2.dex, pass2.int_);
        set_attr_conds(env, &pass2);
        pass2
    };
    env.output.insert("Str".to_string(), attrs.str_);
    env.output.insert("Dex".to_string(), attrs.dex);
    env.output.insert("Int".to_string(), attrs.int_);
    env.output.insert("LowestAttribute".to_string(), attrs.str_.min(attrs.dex).min(attrs.int_));
    // `output.TotalAttr` / "Special case for Devotion" (CalcPerform.lua:510-514).
    env.output.insert("TotalAttr".to_string(), attrs.str_ + attrs.dex + attrs.int_);
    env.output.insert("Devotion".to_string(), env.player.sum(ModType::Base, None, &[pom_engine::sym!("Devotion")]));
    for m in pom_calc::perform::attribute_bonus_mods(&env.player, &attrs) {
        env.player.add_mod(m);
    }
    env.stages_run.push("attributes");
    mem_probe("attributes");
    if stage_end(env, 3) {
        return;
    }
    if stage_snapshots_on() {
        env.stage_snapshots.push(("attributes", vec![("Str", attrs.str_), ("Dex", attrs.dex), ("Int", attrs.int_)].into_iter().map(|(k, v)| (k.to_string(), v)).collect()));
    }

    // doActorLifeMana(env.player) (CalcPerform.lua:1945, right after doActorAttribsConditions) -
    // Life/Mana pool block only (`pom_calc::perform_reserve::life_mana_pool`'s own doc comment:
    // LowLifePercentage/FullLifePercentage/breakdown text aren't ported). Written into `env.output`
    // before `env.player.actor` is built below so a PerStat mod keyed on Life/Mana (leech,
    // LifeRegen/ManaRegen, ...) sees the real pool totals instead of reading 0.
    // `actor.output` already holds Str/Dex/Int here, which PerStat mods on Life/Mana read.
    env.player.actor = Some(std::sync::Arc::new(pom_engine::modstore::types::Actor {
        output: env.output.iter().map(|(k, v)| (Sym::new(k), *v)).collect(),
        items: env.item_actor_info.0.clone(),
        item_search: env.item_actor_info.1.clone(),
        weapon1: env.actor_weapons.0.clone(),
        weapon2: env.actor_weapons.1.clone(),
        ..Default::default()
    }));
    let (life, mana) = pom_calc::perform_reserve::life_mana_pool(&env.player);
    env.output.insert("Life".to_string(), life);
    env.output.insert("Mana".to_string(), mana);
    bd_perform::life_mana_tables(&env.player, life, mana);
    // `if output.ChaosInoculation then output.Life = 1; condList["FullLife"] = true` (CalcPerform.lua:83-86).
    if env.player.flag(None, &[pom_engine::sym!("ChaosInoculation")]) {
        env.output.insert("ChaosInoculation".to_string(), 1.0);
        env.player.conditions.insert(pom_engine::sym!("FullLife"), true);
    }
    // doActorLifeMana's own tail keys (CalcPerform.lua:77-80, 132).
    let low_life_perc = env.player.sum(ModType::Base, None, &[pom_engine::sym!("LowLifePercentage")]);
    env.output.insert("LowLifePercentage".to_string(), 100.0 * if low_life_perc > 0.0 { low_life_perc } else { env.low_pool_threshold });
    let full_life_perc = env.player.sum(ModType::Base, None, &[pom_engine::sym!("FullLifePercentage")]);
    env.output.insert("FullLifePercentage".to_string(), 100.0 * if full_life_perc > 0.0 { full_life_perc } else { 1.0 });
    env.output.insert("LowestOfMaximumLifeAndMaximumMana".to_string(), life.min(mana));

    if let (Some(m), Some(main)) = (minion_actor.as_mut(), minion_main.as_ref()) {
        minion::attribs_and_pools(env, m, main);
    }

    // doActorLifeManaReservation(env.player, ...) (CalcPerform.lua:2092, right after
    // doActorLifeMana/before doActorCharges): each active skill's own reservation, from its real
    // `skillModList` (`pom_skills::modlist`, built in `build_env`). `skillData`'s reservation
    // overrides (a linked support gem turning a curse into a reserved aura, e.g. Blasphemy) aren't
    // threaded through here - `pom_calc::perform_reserve::SkillReserveOverride`'s own doc comment -
    // so `Default::default()` (no override, falls back to the gem's own level value) for every
    // skill.
    let reserve = reservation(env);
    // CalcPerform.lua:2084-2087: a skill with a forced Mana reservation that reserves none is disabled from here on.
    for &i in &reserve.disabled {
        if let Some(c) = env.active_skills.get_mut(i) {
            c.skill_flags.insert("disable".to_string());
            c.disable_reason = Some("This skill requires reserving Mana".to_string());
        }
    }
    bd_perform::reservation_tables(&reserve.rows, &|i| {
        let c = &env.active_skills[i];
        pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|g| g.name.clone()).unwrap_or_else(|| c.name.clone())
    });
    let reserve_mana_efficiency = reserve.mana_efficiency;
    // `activeSkillList` reservations as `ModStore:GetStat("<Pool>ReservedPercent")` reads them.
    let player_reservations = {
        let mut list: Vec<pom_engine::modstore::types::Reservation> = Vec::new();
        for (i, c) in env.active_skills.iter().enumerate() {
            if !c.skill_types.contains(&12) || c.skill_flags.contains("disable") {
                continue;
            }
            let names = buffs::buff_names(c);
            if names.is_empty() {
                continue;
            }
            let base = |pool: &str| reserve.per_skill_base.iter().find(|(idx, p, _)| *idx == i && *p == pool).map(|(_, _, v)| *v).unwrap_or(0.0);
            list.push(pom_engine::modstore::types::Reservation { buff_names: names.iter().map(|n| std::sync::Arc::from(n.as_str())).collect(), mana_reserved_base: Some(base("Mana")), life_reserved_base: Some(base("Life")) });
        }
        let mut actor = env.player.actor.as_ref().map(|a| (**a).clone()).unwrap_or_default();
        actor.reservations = list.clone();
        if reserve.mana_efficiency.is_some() { actor.mana_efficiency = reserve.mana_efficiency; }
        env.player.actor = Some(std::sync::Arc::new(actor));
        list
    };
    for (k, v) in reserve.fields {
        env.output.insert(k.to_string(), v);
    }
    // `GrantReserved<Pool>AsAura` (CalcPerform.lua:576-581, `addAura`): "Grants Armour equal to 25% of
    // your Reserved Mana" (Radiant Faith) becomes an `ExtraAura` LIST mod whose value is
    // floor(value * min(reserved, max)).
    reservation_tail(env, !env.player.flag(None, &[pom_engine::sym!("ManaIncreasedByOvercappedLightningRes")]));
    // Number of active heralds and auras affecting self (CalcPerform.lua:2160-2178, `env.mode_buffs`).
    if pom_calc::setup::buff_mode().buffs {
        let mut heralds: pom_engine::fxhash::HashSet<&str> = pom_engine::fxhash::HashSet::default();
        let mut auras: pom_engine::fxhash::HashSet<&str> = pom_engine::fxhash::HashSet::default();
        for c in &env.active_skills {
            if c.skill_types.contains(&pom_skills::skill_type::HERALD) && !heralds.contains(c.name.as_str()) {
                heralds.insert(c.name.as_str());
                *env.player.multipliers.entry(pom_engine::sym!("Herald")).or_insert(0.0) += 1.0;
                env.player.conditions.insert(pom_engine::sym!("AffectedByHerald"), true);
            } else if c.skill_types.contains(&pom_skills::skill_type::AURA)
                && !c.skill_types.contains(&pom_skills::skill_type::AURA_AFFECTS_ENEMIES)
                && !matches!(crate::offence::skill_data_map(&env.player, c).get("auraCannotAffectSelf"), Some(v) if !matches!(v, pom_engine::modstore::types::ScalarValue::Bool(false)))
                && !auras.contains(c.name.as_str())
            {
                auras.insert(c.name.as_str());
                *env.player.multipliers.entry(pom_engine::sym!("AuraAffectingSelf")).or_insert(0.0) += 1.0;
            }
        }
    }

    // Maximum Mana conversion from Lightning Mastery (CalcPerform.lua:2180-2188).
    if env.player.flag(None, &[pom_engine::sym!("ManaAppliesToShockEffect")]) {
        let multiplier = env.player.max(None, &[pom_engine::sym!("ImprovedManaAppliesToShockEffect")]).unwrap_or(100.0) / 100.0;
        let mut new_mods = Vec::new();
        for (_, mp) in env.player.tabulate(Some(ModType::Inc), None, &[pom_engine::sym!("Mana")]) {
            // SAFETY: `tabulate` returns pointers into `env.player`, alive and unmodified here.
            let m = unsafe { &*mp };
            let tags = m
                .tags
                .iter()
                .map(|t| {
                    let mut c = t.clone();
                    if t.get(pom_engine::sym!("limitTotal")).truthy() {
                        for (k, v) in c.fields.iter_mut() {
                            if k.as_str() == "limit" {
                                if let Some(l) = v.num() {
                                    *v = pom_engine::value::Value::Num(l * multiplier);
                                }
                            }
                        }
                    }
                    c
                })
                .collect();
            new_mods.push(pom_engine::modifier::Mod {
                name: pom_engine::sym!("EnemyShockEffect"),
                ty: ModType::Inc,
                value: pom_engine::value::Value::Num((m.value.num().unwrap_or(0.0) * multiplier).floor()),
                flags: m.flags,
                keyword_flags: m.keyword_flags,
                source: m.source.clone(),
                tags,
            });
        }
        for m in new_mods {
            env.player.add_mod(m);
        }
    }

    attribute_requirements(env);

    // mergeTinctures (CalcPerform.lua:1862-1930, called right after the reservation at 2095).
    if combat {
        merge_tinctures(env);
    }
    // A PerStat/GetStat-tagged mod (e.g. ManaRegen's {type="PerStat", stat="Mana", div=1},
    // CalcSetup.lua:599) reads `self.actor.output[stat]` during Sum/Tabulate evaluation - without
    // this, `player.actor` is always None (`ModStore::new_list(None, None)` at construction) and
    // every such mod silently evaluates as if the stat were 0. Built *after* reservation so a mod keyed on
    // `ManaUnreserved`/`LifeUnreserved` (regen/leech formulas gated on the unreserved pool, not the
    // full one) sees the real value instead of 0.
    env.player.actor = Some(std::sync::Arc::new(pom_engine::modstore::types::Actor {
        output: env.output.iter().map(|(k, v)| (Sym::new(k), *v)).collect(),
        items: env.item_actor_info.0.clone(),
        item_search: env.item_actor_info.1.clone(),
        weapon1: env.actor_weapons.0.clone(),
        weapon2: env.actor_weapons.1.clone(),
        reservations: player_reservations,
        mana_efficiency: reserve_mana_efficiency,
        ..Default::default()
    }));

    // doActorCharges(env, env.player)/(env, env.enemy) (CalcPerform.lua:2191/3490/3624, before
    // calcs.defence at 3792) - upstream calls this once early (2191) and again after the buff/curse stages
    // (3490); one call per actor here gives the same result. `env.minion` charges (line 3493) are skipped: no
    // minion ModStore exists at this point.
    let player_charges = pom_calc::perform_charges::compute_charges(&env.player, true);
    pom_calc::perform_charges::apply_charge_multipliers(&mut env.player, &player_charges);
    for (k, v) in pom_calc::perform_charges::output_fields(&player_charges) {
        env.output.insert(k.to_string(), v);
    }
    let enemy_charges = pom_calc::perform_charges::compute_charges(&env.enemy, false);
    pom_calc::perform_charges::apply_charge_multipliers(&mut env.enemy, &enemy_charges);
    // Set curse limit (CalcPerform.lua:3216).
    let power_charges_max = env.output.get("PowerChargesMax").copied().unwrap_or(0.0);
    let curse_limit = pom_calc::perform_curses::compute_enemy_curse_limit_raw(
        env.player.flag(None, &[pom_engine::sym!("CurseLimitIsMaximumPowerCharges")]),
        env.player.sum(ModType::Base, None, &[pom_engine::sym!("EnemyCurseLimit")]),
        power_charges_max,
    );
    env.output.insert("EnemyCurseLimit".to_string(), curse_limit);
    env.stages_run.push("life_mana_charges");
    mem_probe("life_mana_charges");
    if stage_end(env, 4) {
        return;
    }
    if stage_snapshots_on() {
        env.stage_snapshots.push(("life_mana_charges", vec![("Life", life), ("Mana", mana)].into_iter().map(|(k, v)| (k.to_string(), v)).collect()));
    }

    // Buffs/auras (CalcPerform.lua:2201-2517's buff loop, extracted from each skill's own `skill_mod_list`, see
    // `crate::buffs`) are merged into `env.player` where upstream does it (CalcPerform.lua:3344-3345's
    // `for _, modList in pairs(buffs) do modDB:AddList(modList) end`). `env.player.actor` was already built above
    // (right after reservation), so a PerStat-tagged buff mod still resolves against the real output.
    // applyEnemyModifiers(env.player, true) (CalcPerform.lua:1350), then again once the buffs' own mods are in.
    let mut enemy_mod_cache = pom_engine::fxhash::HashSet::default();
    enemy_mods::apply_enemy_modifiers(&env.player, &mut env.enemy, &mut enemy_mod_cache);
    // The buff loop's `ActorCondition actor=enemy` tags (e.g. "Determination has +36% effect while a Rare or Unique enemy is nearby")
    // read `actor.enemy.modDB`: link the enemy before the buffs are evaluated, not only after them.
    refresh_actors(env);
    let mut minion_enemy_mod_cache = pom_engine::fxhash::HashSet::default();
    if let Some(m) = minion_actor.as_ref() { enemy_mods::apply_enemy_modifiers(&m.store, &mut env.enemy, &mut minion_enemy_mod_cache); }
    let main_cfg = crate::offence::select_main_skill(&env.xml_text, &env.active_skills).map(crate::buffs::skill_cfg);
    // `env.player.weaponData1` (CalcSetup.lua:1566): the Weapon 1 item's first data table, else the class's unarmed table.
    let weapon1_dmg: HashMap<String, f64> = match env.weapon_data.get("Weapon 1").and_then(|w| w.first()).and_then(|v| v.as_object()) {
        Some(o) => o.iter().filter_map(|(k, v)| v.as_f64().map(|n| (k.clone(), n))).collect(),
        None => [("PhysicalMin".to_string(), 2.0), ("PhysicalMax".to_string(), [6.0, 8.0, 5.0, 5.0, 6.0, 6.0, 5.0][env.class_id.clamp(0, 6) as usize])].into_iter().collect(),
    };
    // CalcPerform.lua:2293-2297: Scorching Ray part 2 always sits at its 7 maximum stages.
    for c in env.active_skills.iter_mut() {
        // `skillPart` is clamped to the number of parts (CalcActiveSkill.lua: `m_min(#parts, gemInstance.skillPart)`).
        let n_parts = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(pom_skills::data::parts).map_or(1, |p| p.len()) as i64;
        let part = c.gem_skill_part.unwrap_or(1).max(1).min(n_parts);
        if (c.name == "Scorching Ray" || c.name == "Scorching Ray of Immolation") && part == 2 && !c.skill_flags.contains("disable") {
            let nm: String = c.name.split_whitespace().collect();
            for (k, v) in [("MaxStages", 7.0), ("StageAfterFirst", 7.0)] {
                c.skill_mod_list.push(Mod { name: Sym::new(&format!("Multiplier:{nm}{k}")), ty: ModType::Base, value: pom_engine::value::Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() });
            }
        }
    }
    // Every player skill's minion and its skills (`activeSkill.minion.activeSkillList`), for the minion-to-player aura pass.
    let mut minion_ctx: Vec<(Vec<pom_skills::assemble::ComputedSkill>, String, bool, bool, usize)> = Vec::new();
    {
        let main_ptr = crate::offence::select_main_skill(&env.xml_text, &env.active_skills).map(|m| m as *const pom_skills::assemble::ComputedSkill);
        let name_of = |ty: &str| pom_calc::data::minion_raw(ty).and_then(|r| r.get("name")).and_then(|n| n.as_str()).unwrap_or("").to_string();
        for (owner_idx, c) in env.active_skills.iter().enumerate() {
            if c.skill_flags.contains("disable") || !(c.is_spectre || !c.minion_list.is_empty()) {
                continue;
            }
            if Some(c as *const _) == main_ptr {
                if let Some(m) = minion_actor.as_ref() {
                    minion_ctx.push((m.skills.clone(), name_of(&m.ty), c.skill_flags.contains("spectre"), true, owner_idx));
                }
            } else if let Some(m) = minion::create(env, c) {
                minion_ctx.push((m.skills.clone(), name_of(&m.ty), c.skill_flags.contains("spectre"), false, owner_idx));
            }
        }
    }
    env.minion_skill_ids = minion_ctx.iter().flat_map(|(sk, ..)| sk.iter().map(|k| k.granted_effect_id.clone())).collect();
    let minion_debuff_ctx: Vec<(Vec<pom_skills::assemble::ComputedSkill>, bool)> = minion_ctx.iter().map(|(sk, _, _, main, _)| (sk.clone(), *main)).collect();
    // `env.configInput[var]` is truthy for a ticked checkbox too (e.g. `balanceOfTerrorSelfCast<Curse>`, CalcPerform.lua:2656).
    let mut buff_config_input = env.config_input.clone();
    for (k, v) in &env.config_flags {
        if *v {
            buff_config_input.entry(k.clone()).or_insert(1.0);
        }
    }
    // The buff/curse loop's `skillModList` mods carry `ActorCondition actor=enemy` tags (Corpse Hand's mark effect
    // against Rare/Unique enemies), which need the player's `enemy` link.
    refresh_actors(env);
    let (buff_mods, mut buff_extras) = crate::buffs::compute_and_flatten(&env.player, &env.enemy, &env.active_skills, main_cfg.as_ref(), &buff_config_input, minion_actor.as_ref().map(|m| &m.store), &weapon1_dmg, minion_main.as_ref().is_some_and(|m| m.skill_types.contains(&pom_skills::skill_type::MINIONS_ARE_UNDAMAGABLE)), crate::offence::select_main_skill(&env.xml_text, &env.active_skills).is_some_and(|m| m.skill_flags.contains("totem")), &crate::minion::spectre_list(&env.xml_text), minion_ctx);
    env.buff_exports = buff_extras.exports.take();
    // `addMinionModifiers(modList, mainSkill.skillCfg, env.minion)` per player buff, then `minionBuffs` (CalcPerform.lua:3344-3355).
    if let (Some(m), Some(main)) = (minion_actor.as_mut(), minion_main.as_ref()) {
        minion::add_buff_mods(m, main, &buff_mods);
        for md in &buff_extras.minion_mods {
            m.store.add_mod(md.clone());
        }
        for c in &buff_extras.minion_conditions {
            m.store.conditions.insert(Sym::new(c), true);
        }
    }
    *env.player.multipliers.entry(pom_engine::sym!("BuffOnSelf")).or_insert(0.0) += buff_extras.buff_on_self;
    for m in buff_mods.into_iter().chain(buff_extras.player_mods) {
        env.player.add_mod(m);
    }
    {
        let (dm, dc, minion_dc, enemy_dc) = crate::buffs::all_debuffs(&env.active_skills, &env.player, &env.enemy, &minion_debuff_ctx);
        for m in dm {
            env.enemy.add_mod(m);
        }
        for c in dc {
            env.enemy.conditions.insert(Sym::new(&c), true);
            env.player.conditions.insert(Sym::new(&c), true);
        }
        for c in enemy_dc {
            env.enemy.conditions.insert(Sym::new(&c), true);
        }
        if let Some(m) = minion_actor.as_mut() {
            for c in minion_dc {
                m.store.conditions.insert(Sym::new(&c), true);
            }
        }
    }
    // `output.GuardSkillActive = modDB.conditions["AffectedByGuardSkill"] or false` (CalcPerform.lua:3341).
    env.output.insert("GuardSkillActive".into(), buff_extras.conditions.iter().any(|c| c == "AffectedByGuardSkill") as u8 as f64);
    for c in buff_extras.conditions {
        env.player.conditions.insert(Sym::new(&c), true);
    }
    // The limit is read at CalcPerform.lua:3216, after the aura loop set `AffectedBy<Aura>` (Sublime Vision: "an additional
    // Curse while affected by Malevolence"), so recompute it now that those conditions exist.
    let curse_limit = pom_calc::perform_curses::compute_enemy_curse_limit_raw(
        env.player.flag(None, &[pom_engine::sym!("CurseLimitIsMaximumPowerCharges")]),
        env.player.sum(ModType::Base, None, &[pom_engine::sym!("EnemyCurseLimit")]),
        power_charges_max,
    );
    env.output.insert("EnemyCurseLimit".to_string(), curse_limit);
    // Curse slots (CalcPerform.lua:3216-3376): the player-cast curses compete for `EnemyCurseLimit` slots and the
    // winners' mods land on the enemy modDB. Minion/ally curses are not modelled.
    for m in buff_extras.enemy_mods {
        env.enemy.add_mod(m);
    }
    for (name, v) in buff_extras.self_cast {
        env.player.conditions.insert(Sym::new(&name), v);
    }
    let mut all_curses = buff_extras.curses.clone();
    let buff_extras_minion_curses = buff_extras.minion_curses.clone();
    let buff_extras_minion_limit = buff_extras.minion_curse_limit;
    // Extra curses (CalcPerform.lua:3149-3190): `ExtraCurse` LIST mods, either applied to the player
    // (`applyToPlayer`: "You are Cursed with X", config "playerCursedWith*") or added as a curse on the enemy.
    {
        // "Check for extra curses" (CalcPerform.lua:3145-3148): Consecrated Ground halves curse effect on self.
        if combat && env.player.flag(None, &[pom_engine::sym!("Condition:OnConsecratedGround")]) {
            let effect = 1.0 + env.player.sum(ModType::Inc, None, &[pom_engine::sym!("ConsecratedGroundEffect")]) / 100.0;
            env.player.add_mod(Mod { name: pom_engine::sym!("CurseEffectOnSelf"), ty: ModType::Inc, value: pom_engine::value::Value::Num(-50.0 * effect), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Consecrated Ground")), tags: (vec![]).into() });
        }
        let extra: Vec<pom_engine::value::Value> = env.player.list(None, &[pom_engine::sym!("ExtraCurse")]);
        for value in extra {
            let pom_engine::value::Value::Map(fields) = &value else { continue };
            let get = |k: &str| fields.iter().find(|(n, _)| n.as_str() == k).map(|(_, v)| v);
            let Some(skill_id) = get("skillId").and_then(|v| if let pom_engine::value::Value::Str(s) = v { Some(s.to_string()) } else { None }) else { continue };
            let level = get("level").and_then(|v| v.num()).unwrap_or(1.0);
            let apply_to_player = get("applyToPlayer").is_some_and(|v| v.truthy());
            let Some(ge) = pom_skills::data::granted_effect_by_skill_id(&skill_id) else { continue };
            let ge_name = ge.name.clone().unwrap_or_default();
            let gem_mods = pom_skills::modlist::merge_skill_instance_mods(ge, level, 0.0, None, &[], false);
            let curse_mods: Vec<Mod> = gem_mods.iter().filter(|m| m.tags.iter().any(|tg| tg.kind.as_str() == "GlobalEffect" && matches!(tg.get(pom_engine::sym!("effectType")), pom_engine::value::Value::Str(s) if &**s == "Curse"))).cloned().collect();
            let mut gem_store = ModStore::new_list(None, None);
            for m in &gem_mods {
                gem_store.add_mod(m.clone());
            }
            if apply_to_player {
                // Sources for curses on the player don't respect any limit (CalcPerform.lua:3164).
                // Upstream merges skill buffs/auras into the modDB only after this point (CalcPerform.lua:3344),
                // so an aura's own `AvoidCurse` (a `GlobalEffect` Aura/Buff/Curse mod) is not yet visible here.
                let avoid_curse: f64 = env.player.tabulate(Some(ModType::Base), None, &[pom_engine::sym!("AvoidCurse")]).into_iter().filter_map(|(_, mp)| {
                    let m = unsafe { &*mp };
                    let buffed = m.tags.iter().any(|tg| tg.kind.as_str() == "GlobalEffect" && matches!(tg.get(pom_engine::sym!("effectType")), pom_engine::value::Value::Str(s) if matches!(&**s, "Aura" | "Buff" | "Curse")));
                    if buffed { None } else { m.value.num() }
                }).sum();
                if avoid_curse < 100.0 {
                    env.player.conditions.insert(pom_engine::sym!("Cursed"), true);
                    *env.player.multipliers.entry(pom_engine::sym!("CurseOnSelf")).or_insert(0.0) += 1.0;
                    env.player.conditions.insert(Sym::new(&format!("AffectedBy{}", ge_name.replace(' ', ""))), true);
                    let cfg = pom_engine::modstore::types::Cfg { skill_name: Some(std::sync::Arc::from(ge_name.as_str())), ..Default::default() };
                    let ceos = [pom_engine::sym!("CurseEffectOnSelf")];
                    let ceap = [pom_engine::sym!("CurseEffectAgainstPlayer")];
                    let inc = env.player.sum(ModType::Inc, Some(&cfg), &ceos) + gem_store.sum(ModType::Inc, None, &ceap);
                    let more = env.player.more(Some(&cfg), &ceos) * gem_store.more(None, &ceap);
                    for m in pom_calc::perform::scale_add_list(&curse_mods, ((1.0 + inc / 100.0) * more).max(0.0)) {
                        env.player.add_mod(m);
                    }
                }
            } else if !env.enemy.flag(None, &[pom_engine::sym!("Hexproof")]) || env.player.flag(None, &[pom_engine::sym!("CursesIgnoreHexproof")]) {
                let ceos = [pom_engine::sym!("CurseEffectOnSelf")];
                let scale = (1.0 + env.enemy.sum(ModType::Inc, None, &ceos) / 100.0) * env.enemy.more(None, &ceos);
                all_curses.push(pom_calc::perform_curses::CurseIn {
                    name: ge_name.clone(),
                    from_player: true,
                    priority: crate::buffs::determine_curse_priority(&ge_name, None),
                    is_mark: false,
                    ignore_hex_limit: false,
                    socketed_hex_limit: false,
                    skip: false,
                    mod_list: pom_calc::perform::scale_add_list(&curse_mods, scale),
                    buff_mod_list: Vec::new(),
                    minion_buff_mod_list: Vec::new(),
                });
            }
        }
    }
    {
        let socketed_limit = env.player.sum(ModType::Base, None, &[pom_engine::sym!("SocketedCursesHexLimitValue")]);
        // allyCurses (CalcPerform.lua:3192-3210): the Party tab's imported curses, scaled by their own effect
        // (marks skip the enemy's CurseEffectOnSelf MORE), priority 0, sharing `allyCurses.limit`.
        let party = crate::party::current();
        let ally_list = party.list("Curse");
        let ally_limit = if ally_list.is_empty() { 0.0 } else { party.curse_limit.unwrap_or(0.0) };
        let ally_curses: Vec<pom_calc::perform_curses::CurseIn> = ally_list
            .iter()
            .map(|(name, curse)| {
                let mut mult = curse.effect_mult / 100.0;
                if !curse.is_mark {
                    mult *= env.enemy.more(None, &[pom_engine::sym!("CurseEffectOnSelf")]);
                }
                pom_calc::perform_curses::CurseIn {
                    name: name.clone(),
                    from_player: false,
                    priority: 0.0,
                    is_mark: curse.is_mark,
                    ignore_hex_limit: false,
                    socketed_hex_limit: false,
                    skip: false,
                    mod_list: pom_calc::perform::scale_add_list(&curse.mods, mult),
                    buff_mod_list: Vec::new(),
                    minion_buff_mod_list: Vec::new(),
                }
            })
            .collect();
        // minionCurses (CalcPerform.lua:2933-2944 via `buff_extras`, plus the minion modDB's own `ExtraCurse` list, 3144-3190).
        let mut minion_curses = buff_extras_minion_curses;
        if let Some(m) = minion_actor.as_ref() {
            for value in m.store.list(None, &[pom_engine::sym!("ExtraCurse")]) {
                let pom_engine::value::Value::Map(fields) = &value else { continue };
                let get = |k: &str| fields.iter().find(|(n, _)| n.as_str() == k).map(|(_, v)| v);
                let Some(skill_id) = get("skillId").and_then(|v| if let pom_engine::value::Value::Str(s) = v { Some(s.to_string()) } else { None }) else { continue };
                if get("applyToPlayer").is_some_and(|v| v.truthy()) {
                    continue;
                }
                let level = get("level").and_then(|v| v.num()).unwrap_or(1.0);
                let Some(ge) = pom_skills::data::granted_effect_by_skill_id(&skill_id) else { continue };
                if env.enemy.flag(None, &[pom_engine::sym!("Hexproof")]) && !m.store.flag(None, &[pom_engine::sym!("CursesIgnoreHexproof")]) {
                    continue;
                }
                let ge_name = ge.name.clone().unwrap_or_default();
                let gem_mods = pom_skills::modlist::merge_skill_instance_mods(ge, level, 0.0, None, &[], false);
                let curse_mods: Vec<Mod> = gem_mods.iter().filter(|m| m.tags.iter().any(|tg| tg.kind.as_str() == "GlobalEffect" && matches!(tg.get(pom_engine::sym!("effectType")), pom_engine::value::Value::Str(s) if &**s == "Curse"))).cloned().collect();
                let ceos = [pom_engine::sym!("CurseEffectOnSelf")];
                let scale = (1.0 + env.enemy.sum(ModType::Inc, None, &ceos) / 100.0) * env.enemy.more(None, &ceos);
                minion_curses.push(pom_calc::perform_curses::CurseIn {
                    name: ge_name.clone(),
                    from_player: false,
                    priority: crate::buffs::determine_curse_priority(&ge_name, None),
                    is_mark: false,
                    ignore_hex_limit: false,
                    socketed_hex_limit: false,
                    skip: false,
                    mod_list: pom_calc::perform::scale_add_list(&curse_mods, scale),
                    buff_mod_list: Vec::new(),
                    minion_buff_mod_list: Vec::new(),
                });
            }
        }
        let slots = pom_calc::perform_curses::assign_curse_slots(&all_curses, curse_limit, &minion_curses, buff_extras_minion_limit, &ally_curses, ally_limit, socketed_limit);
        bd_perform::cap_curse_slots(&slots);
        pom_calc::perform_curses::apply_curse_slots(&mut env.player, &mut env.enemy, None, &slots);
    }
    // mergeFlasks(env.flasks, true, ...) (CalcPerform.lua:3121): flask recovery over duration.
    if combat {
        for m in pom_calc::perform::merge_flask_recovery(&env.player, &env.active_flask_mods) {
            env.player.add_mod(m);
        }
    }
    crate::ailments::fix_impale_stacks(&env.player, &mut env.enemy);
    // "Process stats from alternate charges" (CalcPerform.lua:3125-3141).
    if combat {
        let mult_tag = |var: &str| pom_engine::modifier::Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), pom_engine::value::Value::Str(std::sync::Arc::from(var)))] };
        let mkm = |name: &str, ty: ModType, v: f64, src: &str, kw: u64, var: &str| Mod { name: Sym::new(name), ty, value: pom_engine::value::Value::Num(v), flags: 0, keyword_flags: kw, source: Some(std::sync::Arc::from(src)), tags: (vec![mult_tag(var)]).into() };
        if env.player.flag(None, &[pom_engine::sym!("UseEnduranceCharges")]) && env.player.flag(None, &[pom_engine::sym!("EnduranceChargesConvertToBrutalCharges")]) {
            let v = env.player.sum(ModType::Base, None, &[pom_engine::sym!("PerBrutalTripleDamageChance")]);
            env.player.add_mod(mkm("TripleDamageChance", ModType::Base, v, "", 0, "BrutalCharge"));
        }
        if env.player.flag(None, &[pom_engine::sym!("UseFrenzyCharges")]) && env.player.flag(None, &[pom_engine::sym!("FrenzyChargesConvertToAfflictionCharges")]) {
            let dmg = env.player.sum(ModType::Base, None, &[pom_engine::sym!("PerAfflictionAilmentDamage")]);
            let eff = env.player.sum(ModType::Base, None, &[pom_engine::sym!("PerAfflictionNonDamageEffect")]);
            env.player.add_mod(mkm("Damage", ModType::More, dmg, "Affliction Charges", 0x80000, "AfflictionCharge"));
            for n in ["Chill", "Shock", "Freeze", "Scorch", "Brittle", "Sap"] {
                env.player.add_mod(mkm(&format!("Enemy{n}Effect"), ModType::More, eff, "Affliction Charges", 0, "AfflictionCharge"));
            }
        }
    }
    // CalcPerform.lua:3378: guaranteed chills come after the alternate-charge mods (Affliction: EnemyChillEffect MORE).
    crate::ailments::late_guaranteed_chills(&mut env.player, &env.active_skills, &chill_skills);
    // "Special handling for Dancing Dervish" (CalcPerform.lua:3472-3481).
    if env.player.flag(None, &[pom_engine::sym!("DisableWeapons")]) {
        env.weapons_disabled = true;
        env.player.conditions.insert(pom_engine::sym!("Unarmed"), true);
        env.player.conditions.insert(pom_engine::sym!("Unencumbered"), true); // `env.player.Gloves` is never set, so always nil
    } else {
        for m in env.weapon_mod_list1.clone() {
            env.player.add_mod(m);
        }
    }
    // The player's `enemy` link is a snapshot: refresh it so `ActorCondition actor=enemy` (Marked/Cursed, set by the curse slots) sees the current conditions.
    refresh_actors(env);
    enemy_mods::apply_enemy_modifiers(&env.player, &mut env.enemy, &mut enemy_mod_cache);
    if let Some(m) = minion_actor.as_ref() { enemy_mods::apply_enemy_modifiers(&m.store, &mut env.enemy, &mut minion_enemy_mod_cache); }
    env.stages_run.push("buffs");
    mem_probe("buffs");
    if stage_end(env, 5) {
        return;
    }
    if stage_snapshots_on() {
        env.stage_snapshots.push(("buffs", snapshot(&env.player)));
    }
    // calcs.defenceForConditionals(env, env.player) (CalcPerform.lua:3484): `<Type>On<Slot>` outputs.
    pom_defence::conditionals::defence_for_conditionals(&env.player, &env.item_armour, &mut env.output);

    // Fix the configured impale stacks on the enemy (CalcPerform.lua:3383-3392): a blank config means the maximum,
    // and a config above the maximum is clamped (upstream replaces the Config mod; a negative delta sums the same).
    {
        let max_impale = env.player.sum(ModType::Base, None, &[pom_engine::sym!("ImpaleStacksMax")]) * (1.0 + env.player.sum(ModType::Base, None, &[pom_engine::sym!("ImpaleAdditionalDurationChance")]) / 100.0);
        let names = [pom_engine::sym!("Multiplier:ImpaleStacks")];
        let combat_tag = pom_engine::modifier::Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), pom_engine::value::Value::Str(std::sync::Arc::from("Combat")))] };
        let cur = env.enemy.sum(ModType::Base, None, &names);
        if !env.enemy.has_mod(ModType::Base, None, &names) {
            env.enemy.add_mod(Mod { name: names[0].clone(), ty: ModType::Base, value: pom_engine::value::Value::Num(max_impale), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Config")), tags: (vec![combat_tag]).into() });
            refresh_actors(env);
        } else if cur > max_impale {
            env.enemy.add_mod(Mod { name: names[0].clone(), ty: ModType::Base, value: pom_engine::value::Value::Num(max_impale - cur), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Config")), tags: (vec![combat_tag]).into() });
            refresh_actors(env);
        }
    }
    if env.player.flag(None, &[pom_engine::sym!("ManaIncreasedByOvercappedLightningRes")]) {
        redo_mana_after_overcap(env);
    }
    // "Check for extra auras" (CalcPerform.lua:3418), then doActorMisc.
    let main_is_totem = crate::offence::select_main_skill(&env.xml_text, &env.active_skills).is_some_and(|m| m.skill_flags.contains("totem"));
    crate::actor_misc::extra_auras(&mut env.player, minion_actor.as_mut().map(|m| &mut m.store), main_is_totem);
    // doActorCharges(env, env.player) again (CalcPerform.lua:3490), now that buffs/curses are merged.
    {
        let player_charges = pom_calc::perform_charges::compute_charges(&env.player, true);
        pom_calc::perform_charges::apply_charge_multipliers(&mut env.player, &player_charges);
        for (k, v) in pom_calc::perform_charges::output_fields(&player_charges) {
            env.output.insert(k.to_string(), v);
        }
    }
    // doActorMisc(env, env.player) (CalcPerform.lua:3491, just before calcs.defence).
    // `actor.output` is a live table in upstream: StatThreshold tags read the fresh `EvasionOn<Slot>`/charge outputs.
    refresh_actors(env);
    {
        let main = crate::offence::select_main_skill(&env.xml_text, &env.active_skills);
        crate::actor_misc::do_actor_misc(&mut env.player, &mut env.enemy, &mut env.output, &env.active_flask_mods, &env.config_input, main, 0.0);
    }
    if let Some(m) = minion_actor.as_mut() {
        minion::misc_pass(env, m);
    }

    // Merge keystones again to catch any that were added by buffs (CalcPerform.lua:3470).
    merge_keystone_markers(env);
    // Maximum/Current non-damaging ailments on the enemy (CalcPerform.lua:3467-3624).
    {
        // The player's `enemy` link is a snapshot (ActorCondition actor=enemy, e.g. "enemies chilled by your hits are shocked"'s ShockBase).
        refresh_actors(env);
        let main = crate::offence::select_main_skill(&env.xml_text, &env.active_skills);
        crate::ailments::apply_ailments(&mut env.player, &mut env.enemy, &mut env.output, &env.active_skills, main, guaranteed_bonechill);
        refresh_actors(env);
        crate::ailments::apply_exposures(&mut env.player, &mut env.enemy, &env.tree_version);
    }
    {
        let enemy_charges = pom_calc::perform_charges::compute_charges(&env.enemy, false);
        pom_calc::perform_charges::apply_charge_multipliers(&mut env.enemy, &enemy_charges);
    }
    // doActorMisc(env, env.enemy) (CalcPerform.lua:3625): the same routine with the enemy as the actor
    // (Blind's Accuracy/Evasion MORE, Chill/Freeze ActionSpeed, Shock DamageTaken, ...). The enemy's
    // own `output` table isn't kept, so a scratch map stands in.
    {
        let mut enemy_output = pom_engine::fxhash::HashMap::default();
        crate::actor_misc::do_actor_misc(&mut env.enemy, &mut env.player, &mut enemy_output, &[], &env.config_input, None, 0.0);
    }

    // calcs.defence(env, env.player) (Modules/CalcDefence.lua).
    let denv = pom_defence::defence::DefenceEnv {
        enemy_level: env.enemy_level,
        mode_effective: pom_calc::setup::buff_mode().effective,
        necromantic_aegis: false,
        config_input: env.config_input.clone(),
        config_flags: env.config_flags.clone(),
        is_minion: false,
        party_output: party::current().member_output.clone(),
        resist_done: false,
    };
    // `output.ActionSpeedMod = calcs.actionSpeedMod(actor)` (CalcDefence.lua:663, CalcPerform.lua:1142-1151).
    {
        let inc = |n: &str| env.player.sum(ModType::Inc, None, &[Sym::new(n)]);
        let min_speed = env.player.max(None, &[pom_engine::sym!("MinimumActionSpeed")]).unwrap_or(0.0);
        let max_reduction = env.player.max(None, &[pom_engine::sym!("MaximumActionSpeedReduction")]);
        let speed = pom_offence::tools::action_speed_mod(inc("TemporalChainsActionSpeed"), inc("ActionSpeed"), env.temporal_chains_cap, min_speed, max_reduction);
        env.output.insert("ActionSpeedMod".to_string(), speed);
    }
    refresh_actors(env);
    ally_life_pools(env, minion_actor.as_ref(), minion_main.as_ref());
    let bd_was = pom_offence::bd::set_active(defence_bd_active());
    let out = pom_defence::defence::defence(&mut env.player, &env.enemy, &env.item_armour, &denv, &env.output);
    pom_offence::bd::set_active(bd_was);
    env.output = out;
    if let Some(m) = minion_actor.as_mut() {
        minion::resistance_added(env, m);
    }
    if let (Some(&ms), Some(&asm)) = (env.output.get("MovementSpeedMod"), env.output.get("ActionSpeedMod")) {
        env.output.insert("EffectiveMovementSpeedMod".to_string(), ms * asm);
    }
    // `calcs.defence` and `calcs.buildDefenceEstimations` are two separate statements
    // (`Modules/CalcDefence.lua:651`/`:1674`, `CalcPerform.lua:3792`/`:3794`: `calcs.defence(env, env.player)`, then,
    // gated by `if not skipEHP`, `calcs.buildDefenceEstimations(env, env.player)`). The "defence" snapshot is taken
    // between them (CalcPerform.lua:3793).
    env.stages_run.push("defence");
    mem_probe("defence");
    if stage_end(env, 6) {
        return;
    }
    if stage_snapshots_on() {
        env.stage_snapshots.push(("defence", env.output.clone()));
    }

    // calcs.buildDefenceEstimations(env, env.player) (Modules/CalcDefence.lua:1674-3874), its own
    // separate call right after `calcs.defence`.
    // `pre_output_bool.specificTypeAvoidance` is derived from `defence()`'s `Avoid{Type}DamageChance` output
    // (CalcDefence.lua:1576-1580). Nothing else feeds `pre_output_bool`, so `build_defence_estimations`'s
    // `unwrap_or(false)` fallback applies to every other name.
    let specific_type_avoidance = pom_defence::pools::DMG_TYPES.iter().any(|dt| env.output.get(&format!("Avoid{dt}DamageChance")).copied().unwrap_or(0.0) > 0.0);
    let eenv = pom_defence::estimations::EstimationsEnv {
        enemy_level: env.enemy_level,
        config_input: env.config_input.clone(),
        config_flags: env.config_flags.clone(),
        config_str: env.config_str.clone(),
        config_placeholder: env.config_placeholder.clone(),
        config_placeholder_str: env.config_placeholder_str.clone(),
        pre_output_bool: [("specificTypeAvoidance".to_string(), specific_type_avoidance)].into_iter().collect(),
    };
    let skip_optional = SKIP_OPTIONAL.with(|c| c.get());
    let before = OPTIONAL_KEYS.with(|k| k.borrow().is_some()).then(|| env.output.clone());
    if !skip_optional {
        let bd_was = pom_offence::bd::set_active(defence_bd_active());
        pom_defence::estimations::build_defence_estimations(&mut env.output, &env.player, &env.enemy, &eenv);
        pom_offence::bd::set_active(bd_was);
    }
    if let Some(before) = before {
        record_optional_keys(&before, &env.output, &[]);
    }
    // The "defence_estimations" snapshot (CalcPerform.lua:3795) follows the `if not skipEHP` block that wraps
    // `buildDefenceEstimations`.
    env.stages_run.push("defence_estimations");
    mem_probe("defence_estimations");
    if stage_end(env, 7) {
        return;
    }
    env.stage_snapshots.push(("defence_estimations", env.output.clone()));

    // calcs.triggers(env, env.player) (CalcPerform.lua:3797, between estimations and offence in upstream) is
    // `triggers_wire::run`, called just below; calcs.offence(env, env.player, env.player.mainSkill)
    // (CalcPerform.lua:3799, gated by `if not calcs.mirages(env)`, assumed true here) is `crate::offence::compute_offence`.
    let xml_text = env.xml_text.clone();
    refresh_actors(env);
    env.trigger_apply = crate::triggers_wire::run(env, &xml_text);
    if let Some(t) = &env.trigger_apply {
        bd_perform::trigger_tables(t, false);
    }
    offence_prep::MINION_MODS.with(|v| v.borrow_mut().clear());
    crate::offence::MIRAGE_MAIN.with(|m| *m.borrow_mut() = None);
    if crate::buffs::FULLDPS_PARENT.with(|p| p.borrow().is_none()) {
        crate::offence::MIRAGE_CHOSEN.with(|m| m.borrow_mut().clear());
        crate::offence::MIRAGE_ARCHER_SEEN.with(|m| m.borrow_mut().clear());
    }
    crate::offence::compute_offence(env, &xml_text);
    // the copy a Saviour / Tawhoa mirage made the main skill: read now, a FullDPS row run later overwrites it
    let mirage_main = crate::offence::MIRAGE_MAIN.with(|m| m.borrow().clone());
    let main_summon_speed = crate::offence::SUMMON_SPEED.with(|c| c.get());
    let claw_minion_mods = offence_prep::MINION_MODS.with(|v| std::mem::take(&mut *v.borrow_mut()));
    // Runs after FullDPS: a Saviour / Tawhoa mirage run there overwrites its skill's GlobalCache entry (no cost).
    crate::offence_dps::full_dps(env);
    if !skip_optional {
        let before = OPTIONAL_KEYS.with(|k| k.borrow().is_some()).then(|| (env.output.clone(), env.output_lists.keys().cloned().collect::<Vec<_>>()));
        crate::offence::cost_warnings(env, &xml_text);
        if let Some((before, lists_before)) = before {
            let new_lists: Vec<String> = env.output_lists.keys().filter(|k| !lists_before.contains(k)).cloned().collect();
            record_optional_keys(&before, &env.output, &new_lists);
        }
    }
    // The "offence" snapshot (CalcPerform.lua:3800) follows the `if not calcs.mirages(env)` block, so it is only
    // taken when offence ran for MAIN mode.
    env.stages_run.push("offence");
    mem_probe("offence");
    if stage_snapshots_on() {
        env.stage_snapshots.push(("offence", env.output.clone()));
    }
    let mut buff_tables_done = false;
    // `calcs.defence(env, env.minion)` etc. (CalcPerform.lua:3802-3807).
    if let Some(mut m) = minion_actor.take() {
        for md in claw_minion_mods {
            m.store.add_mod(md);
        }
        minion::defence_pass(env, &mut m);
        if let Some(main) = minion_main.as_ref() {
            crate::offence::SUMMON_SPEED.with(|c| c.set(main_summon_speed));
            minion::offence_pass(env, &mut m, main);
        }
        bd_perform::buff_tables(&env.player, &env.enemy, Some(&m.store));
        buff_tables_done = true;
        minion::export(env, &m);
    }
    if let Some(mut ex) = env.buff_exports.take() {
        let crit = env.weapon_data.get("Weapon 1").and_then(|w| w.first()).and_then(|w| w.get("CritChance")).and_then(|v| v.as_f64());
        buff_export::finish(&mut ex, &env.player, &env.enemy, &env.output, crit, &env.slot_items);
        env.buff_exports = Some(ex);
    }
    solver_drain::outputs(env);
    tail_outputs(env, mirage_main);
    if !buff_tables_done {
        bd_perform::buff_tables(&env.player, &env.enemy, None);
    }
}

/// Prints every mod of `store` as `<tag> {json}`, then its conditions (`<tag>_C`) and multipliers (`<tag>_M`), to stderr.
/// For comparing a build's mod store with another implementation's by hand; the CLI's POM_DUMP_MODS=* mode calls it.
pub fn debug_dump_store(tag: &str, store: &ModStore) {
    use pom_engine::modstore::store::Backing;
    let fmt = |m: &Mod| {
        let v = match &m.value {
            pom_engine::value::Value::Num(x) => serde_json::json!(x),
            other => serde_json::json!(format!("{other:?}")),
        };
        serde_json::json!({"name": m.name.as_str(), "type": format!("{:?}", m.ty), "value": v, "source": m.source.as_deref(), "tags": format!("{:?}", m.tags)})
    };
    match &store.backing {
        Backing::List(v) => v.iter().for_each(|m| eprintln!("{tag} {}", fmt(m))),
        Backing::Db(map) => map.values().flatten().for_each(|m| eprintln!("{tag} {}", fmt(m))),
    }
    for (k, v) in &store.conditions {
        eprintln!("{tag}_C {}", serde_json::json!({"k": k.as_str(), "v": v}));
    }
    for (k, v) in &store.multipliers {
        eprintln!("{tag}_M {}", serde_json::json!({"k": k.as_str(), "v": v}));
    }
}

/// `calcLib.getGemStatRequirement` (CalcTools.lua:179-189).
fn gem_stat_requirement(level: f64, is_support: bool, multi: f64) -> f64 {
    if multi == 0.0 {
        return 0.0;
    }
    let stat_type = if is_support { 0.5 } else { 0.7 };
    let req = ((20.0 + (level - 3.0) * 3.0) * (multi / 100.0).powf(0.9) * stat_type).round_ties_lua();
    if req < 14.0 { 0.0 } else { req }
}

trait RoundLua {
    fn round_ties_lua(self) -> f64;
}
impl RoundLua for f64 {
    /// `round(x)` from Common.lua: `m_floor(x + 0.5)` for positive x.
    fn round_ties_lua(self) -> f64 {
        if self >= 0.0 { (self + 0.5).floor() } else { (self - 0.5).ceil() }
    }
}

/// Requirement rows for every enabled gem of every processed socket group (CalcSetup.lua:1603-1609,
/// 1844-1851, with `gemInstance.reqStr` from SkillsTab.lua:1226-1229). `reqOverride` (a "socketed gems have
/// no attribute requirements" GemProperty) is not applied.
fn gem_requirements(xml_text: &str, item_slots: &pom_engine::fxhash::HashMap<String, i64>, item_granted_skills: &pom_skills::data::ItemGrantedSkills, item_can_explode: &pom_skills::data::ItemCanExplode) -> Vec<([f64; 3], Option<bd_perform::ReqSrc>)> {
    let mut rows = Vec::new();
    let Ok(groups) = pom_skills::xmlskills::parse_active_socket_groups(xml_text) else { return rows };
    let Ok(meta) = pom_skills::xmlskills::parse_build_meta(xml_text) else { return rows };
    // CalcSetup.lua:1552-1562 drops stale item/tree-granted groups before the main group index is used.
    let mut groups = groups;
    pom_skills::assemble::retain_item_groups(&mut groups, item_slots, item_granted_skills);
    // mainSocketGroup is clamped against every group CalcSetup ends up with, the appended item/tree grant groups included: an index past the saved ones names a gem-less group
    let total_groups = pom_skills::assemble::total_socket_groups(xml_text, item_slots, item_granted_skills, item_can_explode).unwrap_or(groups.len());
    let main_idx1 = meta.main_socket_group.max(1).min(total_groups.max(1) as i64);
    for (i, group) in groups.iter().enumerate() {
        if !((i as i64 + 1) == main_idx1 || (group.enabled && pom_skills::xmlskills::slot_enabled(&group.slot, meta.use_second_weapon_set))) {
            continue;
        }
        for gem in &group.gem_list {
            let Some(gd) = gem.gem_data else { continue };
            if !gem.enabled {
                continue;
            }
            // `gd.granted_effect` is a placeholder for some gems (no id, no levels): resolve the real effect by id.
            let Some(ge) = pom_skills::data::gem_primary_effect(gd) else { continue };
            // `gemData.grantedEffect.levels[gemInstance.level].levelRequirement` (SkillsTab.lua:1226); the typed `levels` is empty for some skills, so read the raw table.
            let level = gem.level;
            let raw_req = ge.id.as_deref().and_then(|id| pom_skills::modlist::raw_level_field(id, level, "levelRequirement"));
            let Some(req_level) = raw_req.or_else(|| ge.levels.get((level.max(1.0) as usize).saturating_sub(1)).and_then(|l| l.level_requirement)) else { continue };
            let is_support = pom_skills::data::is_support(ge);
            rows.push((
                [
                    gem_stat_requirement(req_level, is_support, gd.req_str),
                    gem_stat_requirement(req_level, is_support, gd.req_dex),
                    gem_stat_requirement(req_level, is_support, gd.req_int),
                ],
                Some(bd_perform::ReqSrc::Gem { color: bd_perform::gem_color(ge.color), name: gd.name.clone().unwrap_or_default(), level: gem.level, quality: gem.quality }),
            ));
        }
    }
    rows
}

/// "Process attribute requirements" (CalcPerform.lua:2093-2162). `ReqXItem` is a table in upstream
/// (dumped as "?"), `ReqXString` the colour-coded text when the requirement isn't met.
fn attribute_requirements(env: &mut Env) {
    let req_mult = {
        let (inc, more) = (env.player.sum(ModType::Inc, None, &[pom_engine::sym!("GlobalAttributeRequirements")]), env.player.more(None, &[pom_engine::sym!("GlobalAttributeRequirements")]));
        (1.0 + inc / 100.0) * more
    };
    let omni = if env.player.flag(None, &[pom_engine::sym!("OmniscienceRequirements")]) {
        let n = pom_engine::sym!("OmniAttributeRequirements");
        Some((1.0 + env.player.sum(ModType::Inc, None, &[n]) / 100.0) * env.player.more(None, &[n]))
    } else {
        None
    };
    let ignore = env.player.flag(None, &[pom_engine::sym!("IgnoreAttributeRequirements")]);
    let mut attrs: Vec<(&str, Option<usize>)> = Vec::new();
    if omni.is_some() {
        attrs.push(("Omni", None));
    }
    attrs.extend([("Str", Some(0)), ("Dex", Some(1)), ("Int", Some(2))]);
    for (attr, idx) in attrs {
        let breakdown_attr = if omni.is_some() { "Omni" } else { attr };
        bd_perform::req_table_begin(attr);
        let mut best = 0.0f64;
        let mut best_name: Option<String> = None;
        if let Some(idx) = idx {
            for (ri, row) in env.attr_reqs.iter().enumerate() {
                let v = row[idx];
                if v > 0.0 {
                    let mut req = (v * req_mult).floor();
                    if let Some(o) = omni {
                        req = ((v * req_mult).floor() * (1.0 / (o - 1.0))).floor();
                    }
                    if req > best {
                        best = req;
                        best_name = env.attr_req_srcs.get(ri).map(|src| match src {
                            bd_perform::ReqSrc::Item { name, .. } | bd_perform::ReqSrc::Gem { name, .. } => name.clone(),
                        });
                    }
                    if let Some(src) = env.attr_req_srcs.get(ri) {
                        bd_perform::req_row(breakdown_attr, req, env.output.get(breakdown_attr).copied().unwrap_or(0.0), src);
                    }
                }
            }
        }
        if ignore {
            best = 0.0;
        }
        let string_key = format!("Req{attr}String");
        env.output.insert(string_key.clone(), 0.0);
        let req_key = format!("Req{breakdown_attr}");
        if best > env.output.get(&req_key).copied().unwrap_or(0.0) {
            let have = env.output.get(breakdown_attr).copied().unwrap_or(0.0);
            env.output_extra.remove(&string_key);
            if best > have {
                env.output_extra.insert(format!("Req{breakdown_attr}String"), serde_json::json!(format!("^xDD0022{best}")));
            } else {
                env.output.insert(format!("Req{breakdown_attr}String"), best);
            }
            env.output.insert(req_key, best);
            env.output_extra.insert(format!("Req{breakdown_attr}Item"), serde_json::json!("?"));
            // The name upstream's warning prints (`ReqXItem.sourceItem.name` / `sourceGem.nameSpec`).
            match best_name {
                Some(n) => env.output_extra.insert(format!("Req{breakdown_attr}ItemName"), serde_json::json!(n)),
                None => env.output_extra.remove(&format!("Req{breakdown_attr}ItemName")),
            };
        }
    }
}

/// Output keys set by `Calcs.lua`'s `calcs.perform` wrapper (ExtraPoints, `Spec:*Inc`, lines 441-446) and
/// `CalcPerform.lua`'s main-skill gem level/quality block (3935-3985).
fn tail_outputs(env: &mut Env, mirage_main: Option<pom_skills::assemble::ComputedSkill>) {
    let base = |env: &Env, n: &str| env.player.sum(ModType::Base, None, &[Sym::new(n)]);
    let extra_points = base(env, "ExtraPoints");
    env.output.insert("ExtraPoints".to_string(), extra_points);
    let spec_cfg = pom_engine::modstore::types::Cfg { source: Some(std::sync::Arc::from("Tree")), ..Default::default() };
    let spec_inc = |names: &[&str]| env.player.sum(ModType::Inc, Some(&spec_cfg), &names.iter().map(|n| Sym::new(n)).collect::<Vec<_>>());
    let specs = [
        ("Spec:LifeInc", spec_inc(&["Life"])),
        ("Spec:ManaInc", spec_inc(&["Mana"])),
        ("Spec:ArmourInc", spec_inc(&["Armour", "ArmourAndEvasion"])),
        ("Spec:EvasionInc", spec_inc(&["Evasion", "ArmourAndEvasion"])),
        ("Spec:EnergyShieldInc", spec_inc(&["EnergyShield"])),
    ];
    for (k, v) in specs {
        env.output.insert(k.to_string(), v);
    }
    // Main skill's gem level/quality (only for a skill socketed from a real gem instance).
    // Saviour / Tawhoa's Chosen: `calculateMirage`'s postCalcFunc made the copied skill `env.player.mainSkill`.
    if let Some(main) = mirage_main.as_ref().or_else(|| crate::offence::select_main_skill(&env.xml_text, &env.active_skills)).filter(|m| m.has_src_instance) {
        let snap = crate::buffs::player_snapshot(&env.player);
        let mut store = ModStore::new_list(Some(snap.clone()), snap.actor.clone());
        for m in &main.skill_mod_list {
            store.add_mod(m.clone());
        }
        let cfg = crate::buffs::skill_cfg(main);
        let sum = |n: &str| store.sum(ModType::Base, Some(&cfg), &[Sym::new(n)]);
        env.output.insert("GemHasLevel".to_string(), 1.0);
        env.output.insert("GemLevel".to_string(), sum("GemLevel") + sum("GemSupportLevel") + sum("GemItemLevel"));
        env.output.insert("GemHasQuality".to_string(), 1.0);
        env.output.insert("GemQuality".to_string(), sum("GemQuality") + sum("GemSupportQuality") + sum("GemItemQuality") + sum("GemSocketQuality"));
        bd_perform::gem_tables(&store, &cfg, env.output["GemLevel"], env.output["GemQuality"]);
    }
}

/// `player.output` keys the Lua only ever assigns a boolean (`x = true`/`false`/a comparison),
/// taken from the recorded answer keys (no key is ever bool in one build and a number in another).
/// `env.output` is a `HashMap<String, f64>` everywhere, so these are emitted as JSON booleans
/// (non-zero => true) to keep the dump's types faithful to upstream.
pub(crate) const BOOL_OUTPUT_KEYS: &[&str] = &[
    "AncestralCryCalculated", "AnyAegis", "AnyBypass", "AnyGuard", "AnySpecificMindOverMatter",
    "AnyTakenReflect", "BattleMageCryCalculated", "BurningGroundFromIgnite", "CappingES",
    "CappingLife", "CausticGroundFromPoison", "ChaosInoculation", "CorruptedBloodImmunity",
    "CreatePactOffensiveCalcSection", "CreateWarcryOffensiveCalcSection", "ESHasCost",
    "ESPerSecondHasCost", "ESPercentPerSecondHasCost", "EnergyShieldProtectsMana",
    "EnergyShieldRechargeAppliesToEnergyShield", "EnergyShieldRechargeAppliesToLife",
    "ExertedAttackUptimeRatioCalculated", "GemHasLevel", "GemHasQuality", "GuardSkillActive",
    "HasBonechill", "HinderImmunity", "InfernalCryCalculated", "IntimidatingCryCalculated",
    "KnockbackImmunity", "LifeCostWarning", "LifeHasCost", "LifePerSecondHasCost",
    "LifePercentHasCost", "LifePercentPerSecondHasCost", "MaimImmunity", "ManaCostWarning",
    "ManaHasCost", "ManaPerSecondHasCost", "ManaPercentHasCost", "ManaPercentPerSecondHasCost",
    "OnlySharedGuard", "OnlySharedMindOverMatter", "PactOfBeidatCalculated",
    "PactOfGhorrCalculated", "PactOfKtashCalculated", "PactOfLyciaCalculated", "PreciseTechnique", "VixensTooMuchCastSpeedWarn",
    "RageCostWarning", "RageHasCost", "RagePerSecondHasCost", "RallyingCryCalculated",
    "SeismicCryCalculated", "ShowBlockEffect", "ShowBurst", "SoulHasCost", "SoulPerSecondHasCost",
    "VixenModeNoVixenGlovesWarn", "VixensTooMuchCastSpeedWarn", "ehpSectionAnySpecificTypes",
    "noSplitEvade", "showDebuffExpirationModifier", "showNetRecoup", "showTotalDotDPS",
    "specificTypeAvoidance", "splitEvade",
];

/// Output keys that are always an (empty) table in upstream: `SkillDPS` is `fullDPS.skills`.
const EMPTY_TABLE_KEYS: &[&str] = &["SkillDPS"];

/// Whether `key` is in `BOOL_OUTPUT_KEYS`, by a set lookup (`dump` asks for every output).
pub(crate) fn is_bool_output_key(key: &str) -> bool {
    static SET: std::sync::OnceLock<pom_engine::fxhash::HashSet<&'static str>> = std::sync::OnceLock::new();
    SET.get_or_init(|| BOOL_OUTPUT_KEYS.iter().copied().collect()).contains(key)
}

/// `dump(env)["player"][name]` as a number (`true`/`false` as 1/0), read without building the whole map; `None`
/// where that entry is missing or not a finite number.
pub fn stat_value(env: &Env, name: &str) -> Option<f64> {
    // `Solver.<stat>`: what the build solver derives from the calc (flask uptime, self-damage per second).
    if let Some(rest) = name.strip_prefix("Solver.") {
        return solver::solver_stat(env, rest);
    }
    // `Minion.<stat>`: the main skill's minion output (absent when there is no minion).
    if let Some(rest) = name.strip_prefix("Minion.") {
        let v = *env.minion_info.as_ref()?.2.get(rest)?;
        return v.is_finite().then_some(v);
    }
    // `dump` writes these after the output map, so they win.
    if let Some(v) = env.output_extra.get(name) {
        return v.as_f64().or_else(|| v.as_bool().map(|b| if b { 1.0 } else { 0.0 }));
    }
    // A warning list counts its entries (the solver's "no warnings" limit); other lists and strings have no value.
    if let Some(l) = env.output_lists.get(name) {
        return name.ends_with("WarningList").then_some(l.len() as f64);
    }
    if env.output_str.contains_key(name) {
        return None;
    }
    if name.contains('.') || EMPTY_TABLE_KEYS.contains(&name) {
        return None;
    }
    let v = *env.output.get(name)?;
    if crate::is_bool_output_key(name) {
        return Some(if v != 0.0 { 1.0 } else { 0.0 });
    }
    v.is_finite().then_some(v)
}

pub fn dump(env: &Env) -> serde_json::Value {
    let mut player = serde_json::Map::with_capacity(env.output.len() + env.output_lists.len() + env.output_str.len() + env.output_extra.len() + 2);
    let mut keys: Vec<&String> = env.output.keys().collect();
    keys.sort_unstable();
    for k in keys {
        let v = env.output[k];
        let value = if EMPTY_TABLE_KEYS.contains(&k.as_str()) {
            let mut rows = serde_json::Map::new();
            for (i, r) in env.skill_dps.iter().enumerate() {
                let mut o = serde_json::Map::new();
                o.insert("name".into(), serde_json::json!(r.name));
                o.insert("dps".into(), serde_json::json!(r.dps));
                o.insert("count".into(), serde_json::json!(r.count));
                if let Some(sp) = &r.skill_part {
                    o.insert("skillPart".into(), serde_json::json!(sp));
                }
                if let Some(src) = &r.source {
                    o.insert("source".into(), serde_json::json!(src));
                }
                if let Some(t) = &r.trigger {
                    o.insert("trigger".into(), serde_json::json!(t));
                }
                rows.insert((i + 1).to_string(), serde_json::Value::Object(o));
            }
            serde_json::Value::Object(rows)
        } else if crate::is_bool_output_key(k.as_str()) {
            serde_json::json!(v != 0.0)
        } else if v.is_nan() {
            serde_json::json!("NaN")
        } else if v.is_infinite() {
            serde_json::json!(if v > 0.0 { "Inf" } else { "-Inf" })
        } else {
            serde_json::json!(v)
        };
        // `MainHand.<stat>` / `OffHand.<stat>`: an attack's per-hand output tables.
        if let Some((hand, stat)) = k.split_once('.') {
            let entry = player.entry(hand.to_string()).or_insert_with(|| serde_json::json!({}));
            if let Some(o) = entry.as_object_mut() {
                let bool_key = crate::is_bool_output_key(stat);
                o.insert(stat.to_string(), if bool_key { serde_json::json!(v != 0.0) } else { value });
            }
        } else {
            player.insert(k.clone(), value);
        }
    }
    // CalcOffence creates both `output.MainHand` and `output.OffHand` for every attack pass.
    if player.contains_key("MainHand") {
        player.entry("OffHand".to_string()).or_insert_with(|| serde_json::json!({}));
    }
    for (k, v) in &env.output_lists {
        let o: serde_json::Map<String, serde_json::Value> = v.iter().enumerate().map(|(i, n)| ((i + 1).to_string(), serde_json::json!(n))).collect();
        player.insert(k.clone(), serde_json::Value::Object(o));
    }
    for (k, v) in &env.output_str {
        player.insert(k.clone(), serde_json::json!(v));
    }
    for (k, v) in &env.output_extra {
        player.insert(k.clone(), v.clone());
    }
    serde_json::json!({ "player": player })
}

/// Rebuilds both actors from the current `env.output` and wires the cross-actor links
/// (`env.player.enemy = env.enemy`, `env.enemy.enemy = env.player`, `actor.player`; CalcSetup.lua:
/// 524-527) that `ModStore.lua`'s `getActor` resolves for `ActorCondition`/`Multiplier`(actor=...)
/// tags. The links hold snapshots, so this is re-run whenever the stores have changed since
/// (right before Defence and again before Offence).
pub(crate) fn refresh_actors(env: &mut Env) {
    use pom_engine::modstore::types::Actor;
    let output: HashMap<Sym, f64> = env.output.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
    let player_actor = std::sync::Arc::new(actor_with_output(env.player.actor.as_deref(), output));
    env.player.actor = Some(player_actor.clone());
    let enemy_actor = std::sync::Arc::new(env.enemy.actor.clone().map(|a| (*a).clone()).unwrap_or_default());
    env.enemy.actor = Some(enemy_actor.clone());
    let p = crate::buffs::player_snapshot(&env.player);
    let e = crate::buffs::player_snapshot(&env.enemy);
    // While a minion's pass is running, `env.player` is the minion: `getActor("player")` (ModStore.lua:48-54)
    // still yields the real player (`actor.parent.player`), and the enemy's `enemy`/`player` stay the real player.
    let real_player = env.parent_snapshot.clone().unwrap_or_else(|| p.clone());
    {
        let mut m = player_actor.related.borrow_mut();
        m.clear();
        m.insert("enemy".into(), e);
        m.insert("player".into(), real_player.clone());
        if let Some(parent) = &env.parent_snapshot {
            m.insert("parent".into(), parent.clone());
        }
        // `env.player.partyMembers = env.partyMembers` (CalcPerform.lua:1311): the Party tab's actor, whose `output`
        // holds the imported "PartyMemberStats" numbers (a Link buff's `PercentStat actor=partyMembers` reads them).
        let party = crate::party::current();
        {
            let out: HashMap<Sym, f64> = party.member_output.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
            let pa = std::sync::Arc::new(Actor { output: out, ..Default::default() });
            m.insert("partyMembers".into(), std::sync::Arc::new(ModStore::new_db(None, Some(pa))));
        }
    }
    {
        let mut m = enemy_actor.related.borrow_mut();
        m.clear();
        m.insert("enemy".into(), real_player.clone());
        m.insert("player".into(), real_player);
    }
    pom_engine::modstore::types::register_links(&player_actor);
    pom_engine::modstore::types::register_links(&enemy_actor);
}

/// Resolved once per process (it checks the file system).
pub fn engine_data_dir() -> std::path::PathBuf {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(engine_data_dir_live).clone()
}

fn engine_data_dir_live() -> std::path::PathBuf {
    // The data folder the host or tool named. The working-directory copies below are for running from a checkout
    // (cargo tests and the command-line tools); the app always sets the variable, so it never reaches them.
    for var in ["POM_ENGINE_DATA"] {
        if let Some(d) = std::env::var_os(var).filter(|d| !d.is_empty()) {
            return std::path::PathBuf::from(d);
        }
    }
    for dir in ["engine-data", "../../engine-data"] {
        let p = std::path::Path::new(dir);
        if p.exists() {
            return p.to_path_buf();
        }
    }
    std::path::PathBuf::from("engine-data")
}

/// A directory the app set (`set_timeless_data_dir`), ahead of the environment and the development folders. For every
/// thread: the item ranking workers calculate with the same tables as the thread that set it.
static TIMELESS_DIR_OVERRIDE: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);
static DATA_REV: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Points the Legion (timeless jewel) tables at `dir` (the app's user-data copy once they are downloaded). A later
/// call replaces the folder; the tables are read again the next time a search or a calculation needs them.
pub fn set_timeless_data_dir(dir: Option<std::path::PathBuf>) {
    *TIMELESS_DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = dir;
    DATA_REV.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Counts changes to the data a calculation reads besides the build text (the timeless tables' folder): a result kept
/// for a build text is reused only while this is unchanged.
pub fn data_rev() -> u64 {
    DATA_REV.load(std::sync::atomic::Ordering::SeqCst)
}

/// The directory the timeless jewel tables are read from: the one the app set, else `POM_TIMELESS_DATA`. With
/// neither, an empty path: the tables count as "not installed" (they are 406 MB and live outside the data folder).
pub fn timeless_jewel_data_dir() -> std::path::PathBuf {
    if let Some(d) = TIMELESS_DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return d;
    }
    if let Some(d) = pom_engine::env::var_os("POM_TIMELESS_DATA") {
        return std::path::PathBuf::from(d);
    }
    std::path::PathBuf::new()
}

// Per-thread caches so a batch run (`pom-cli <list.txt> <out>`) loads each tree version and the
// jewel tables once, not once per build. thread_local because TimelessJewelData isn't Sync.
// The trees are shared by every thread: each ranking worker loaded and kept its own copy of each tree it used.
static TREE_CACHE: std::sync::Mutex<Option<HashMap<String, &'static pom_passives::treedata::TreeData>>> = std::sync::Mutex::new(None);
static CJ_CACHE: std::sync::OnceLock<pom_passives::clusterjewel::ClusterJewelData> = std::sync::OnceLock::new();
thread_local! {
    static TIMELESS_CACHE: std::cell::RefCell<Option<(std::path::PathBuf, &'static pom_passives::timelessjewel::TimelessJewelData)>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn cached_tree(version: &str) -> Result<&'static pom_passives::treedata::TreeData, String> {
    // Held while loading, so threads asking at once load a version once.
    let mut cache = TREE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = cache.get_or_insert_with(HashMap::default).get(version).copied() {
        return Ok(t);
    }
    mem_probe("before tree");
    // (every thread shares the tree, so it parses the way upstream parses it even on a solver thread with text rules on)
    // shortcut: text rules never read tree lines; a tree cache per rules setting if a patch rewords a notable.
    let rules = pom_engine::modparser::text_rules::set_active(false);
    let t = pom_passives::load_tree(&engine_data_dir(), &format!("tree_{version}.json"));
    pom_engine::modparser::text_rules::set_active(rules);
    let t: &'static pom_passives::treedata::TreeData = Box::leak(Box::new(t.map_err(|e| format!("load_tree: {e}"))?));
    mem_probe(&format!("tree {version}"));
    cache.get_or_insert_with(HashMap::default).insert(version.to_string(), t);
    Ok(t)
}

/// POM_MEM=1: prints this process's private memory (MB) and the change since the last probe.
pub fn mem_probe(label: &str) {
    // POM_RUNPROF=1: time since the previous probe (calc stages).
    if pom_engine::env::var_os("POM_RUNPROF").is_some() {
        thread_local! {
            static AT: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) };
        }
        let now = std::time::Instant::now();
        if let Some(t) = AT.with(|c| c.replace(Some(now))) {
            eprintln!("RUNPROF {label} {:.3}", (now - t).as_secs_f64() * 1000.0);
        }
    }
    if pom_engine::env::var_os("POM_MEM").is_none() {
        return;
    }
    thread_local! {
        static LAST: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    }
    let now = process_private_mb();
    let d = now - LAST.with(|c| c.replace(now));
    eprintln!("MEMP {label}: {now:.0} MB ({d:+.0})");
}

/// Private bytes of this process in MB (0 off Windows).
pub fn process_private_mb() -> f64 {
    #[cfg(windows)]
    {
        #[repr(C)]
        #[derive(Default)]
        struct Counters { cb: u32, faults: u32, peak_ws: usize, ws: usize, qpp: usize, qp: usize, qpnp: usize, qnp: usize, pagefile: usize, peak_pagefile: usize }
        extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
        }
        let mut c = Counters { cb: std::mem::size_of::<Counters>() as u32, ..Default::default() };
        unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
        c.pagefile as f64 / 1048576.0
    }
    #[cfg(not(windows))]
    0.0
}

fn cluster_jewel_data() -> &'static pom_passives::clusterjewel::ClusterJewelData {
    mem_probe("before cj");
    let r = CJ_CACHE.get_or_init(|| pom_passives::clusterjewel::ClusterJewelData::load(&engine_data_dir()).expect("load data_clusterJewels.json"));
    mem_probe("cj");
    r
}

/// The Legion tables, or None when `NodeIndexMapping.lua` is not in the data folder (the app has not installed them).
pub fn timeless_jewel_data() -> Option<&'static pom_passives::timelessjewel::TimelessJewelData> {
    mem_probe("before timeless");
    let dir = timeless_jewel_data_dir();
    let cached = TIMELESS_CACHE.with(|c| c.borrow().as_ref().filter(|(d, _)| *d == dir).map(|(_, t)| *t));
    let r = match cached {
        Some(t) => Some(t),
        None => match pom_passives::timelessjewel::TimelessJewelData::load(&dir) {
            Ok(t) => {
                let t: &'static pom_passives::timelessjewel::TimelessJewelData = Box::leak(Box::new(t));
                TIMELESS_CACHE.with(|c| *c.borrow_mut() = Some((dir, t)));
                Some(t)
            }
            Err(_) => None,
        },
    };
    mem_probe("timeless");
    r
}

/// Builds one socketed jewel's `pom_passives::clusterjewel::ClusterJewelInput` from its REAL
/// parsed `pom_item::Item` (its `cluster_jewel`/`jewel_data`/`jewel_radius_index` fields).
fn cluster_jewel_input_from_item(item: &pom_item::Item) -> pom_passives::clusterjewel::ClusterJewelInput {
    let jd = &item.jewel_data;
    let (size, size_index) = item.cluster_jewel.as_ref().map(|cj| (cj.size.clone(), cj.size_index)).unwrap_or_default();
    pom_passives::clusterjewel::ClusterJewelInput {
        cluster_jewel_valid: jd.cluster_jewel_valid,
        keystone: jd.cluster_jewel_keystone.clone(),
        notables: jd.cluster_jewel_notables.clone(),
        skill_tag: jd.cluster_jewel_skill.clone(),
        socket_count_override: jd.cluster_jewel_socket_count_override,
        socket_count: jd.cluster_jewel_socket_count,
        node_count: jd.cluster_jewel_node_count,
        nothingness_count: jd.cluster_jewel_nothingness_count,
        added_mods: jd.cluster_jewel_added_mods.clone(),
        inc_effect: jd.cluster_jewel_inc_effect,
        size,
        size_index,
        conquered_by: jd.conquered_by.as_ref().map(|cb| pom_passives::clusterjewel::ConqueredBy {
            id: cb.id,
            conqueror_type: cb.conqueror_type.clone(),
            conqueror_id: cb.conqueror_id.clone(),
        }),
        jewel_radius_index: item.jewel_radius_index,
        intuitive_leap_like: jd.intuitive_leap_like,
        intuitive_leap_keystone_only: jd.intuitive_leap_keystone_only,
        impossible_escape_keystones: jd.impossible_escape_keystones.clone(),
        // `limit_disabled`: not computed here - `Item.lua` never sets it either (only
        // `CalcSetup.lua`'s cross-item "which extra copy past `Limited to N` gets disabled" pass
        // does), so this crate would need to port that algorithm itself to make it real. Always
        // `false`, same as this crate's `pom_item::JewelData::limit_disabled` default - see that
        // field's own doc comment.
        limit_disabled: jd.limit_disabled,
    }
}

/// `mergeTinctures(env.tinctures)` (CalcPerform.lua:1862-1930). `pairs(tinctures)` iterates in table-hash
/// order in upstream; only the `TinctureLimit` cut-off can observe that, slot order is used here.
fn merge_tinctures(env: &mut Env) {
    if env.active_tinctures.is_empty() {
        return;
    }
    let p = &env.player;
    let (effect_inc, effect_inc_magic, mut limit) = env.tincture_params;
    let not_burn = p.sum(ModType::Base, None, &[pom_engine::sym!("TincturesNotInflictManaBurn")]).min(100.0);
    let can_gain = p.flag(None, &[pom_engine::sym!("Condition:WeepingWoundsInsteadOfManaBurn")]) || (not_burn < 100.0 && env.output.get("ManaUnreserved").copied().unwrap_or(0.0) > 0.0);
    if !can_gain {
        return;
    }
    let mut buffs: Vec<(String, Vec<Mod>)> = Vec::new();
    let mut conds: Vec<String> = Vec::new();
    let mut merge = |key: String, src: &[Mod]| {
        let idx = buffs.iter().position(|(k, _)| *k == key).unwrap_or_else(|| {
            buffs.push((key, Vec::new()));
            buffs.len() - 1
        });
        pom_calc::perform::merge_buff(&mut buffs[idx].1, src);
    };
    for t in &env.active_tinctures {
        if limit <= 0.0 {
            break;
        }
        limit -= 1.0;
        conds.push("UsingTincture".to_string());
        conds.push(format!("Using{}", t.base_name.split_whitespace().collect::<String>()));
        let mut inc = effect_inc + t.effect_inc;
        if t.magic {
            inc += effect_inc_magic;
        }
        let effect_mod = ((1.0 + inc / 100.0) * (1.0 + t.quality / 100.0) * 100.0).floor() / 100.0;
        if !t.buff_mod_list.is_empty() {
            merge(t.base_name.clone(), &pom_calc::perform::scale_add_list(&t.buff_mod_list, effect_mod));
        }
        if !t.mod_list.is_empty() {
            let key = if t.unique { t.title.clone().unwrap_or_default() } else { t.mod_list.iter().map(|m| format!("{:?}|{:?}|{}|{}|{:?}&", m.name, m.ty, m.flags, m.keyword_flags, m.tags)).collect::<String>() };
            merge(key, &pom_calc::perform::scale_add_list(&t.mod_list, effect_mod));
        }
    }
    for c in conds {
        env.player.conditions.insert(Sym::new(&c), true);
    }
    let ranged = env.player.flag(None, &[pom_engine::sym!("TinctureRangedWeapons")]);
    let mut ranged_copies: Vec<Mod> = Vec::new();
    for (_, mods) in buffs {
        for m in mods {
            // CalcPerform.lua:1921-1930: "TinctureRangedWeapons" duplicates each WeaponMelee tincture mod as WeaponRanged.
            if ranged && m.flags & 0x0400_0000 == 0x0400_0000 {
                let mut c = m.clone();
                c.flags = (c.flags & !0x0400_0000) | 0x0800_0000;
                ranged_copies.push(c);
            }
            env.player.add_mod(m);
        }
    }
    for c in ranged_copies {
        env.player.add_mod(c);
    }
}

fn merge_keystone_markers(env: &mut Env) {
    // The rest of modLib.mergeKeystones: `Keystone` LIST markers granted by items/jewels/config
    // (e.g. a unique's "Blood Magic" line) pull in that keystone's tree mods once.
    let markers: Vec<(String, Option<std::sync::Arc<str>>)> = env
        .player
        .tabulate(Some(ModType::List), None, &[pom_engine::sym!("Keystone")])
        .into_iter()
        .filter_map(|(v, m)| match v {
            pom_engine::value::Value::Str(name) => Some((name.to_string(), unsafe { (*m).source.clone() })),
            _ => None,
        })
        .collect();
    for (name, source) in markers {
        if env.keystones_added.contains(&name) {
            continue;
        }
        let Some(mods) = env.keystone_map.get(&name).cloned() else { continue };
        env.keystones_added.insert(name);
        let from_tree = source.as_ref().map_or(false, |s| !s.to_lowercase().contains("tree"));
        for mut m in mods {
            if from_tree {
                m.source = source.clone();
            }
            env.player.add_mod(m);
        }
    }
}

/// The minion half of the ally-Life block in `calcs.perform` (CalcPerform.lua:3667-3757) followed by the
/// totem half. Pool Life comes from the skill's own minion actor; a minion that is not the main skill's is
/// built here (`initMinionModDB` + `addMinionModifiers` + attributes/pools) without the aura/buff lists.
fn ally_life_pools(env: &mut Env, main_minion: Option<&minion::MinionActor>, main_skill: Option<&pom_skills::assemble::ComputedSkill>) {
    struct Pool { life: &'static str, redirect: &'static str, source: &'static str, limit: Option<&'static str> }
    const SPECTRE: Pool = Pool { life: "TotalSpectreLife", redirect: "takenFromSpectresBeforeYou", source: "Spectres", limit: Some("ActiveSpectreLimit") };
    const COMPANION: Pool = Pool { life: "TotalMinionLife", redirect: "takenFromMinionBeforeYou", source: "Minion", limit: None };
    let by_skill = |name: &str| -> Option<Pool> {
        match name {
            "Summon Sentinel of Radiance" => Some(Pool { life: "TotalRadianceSentinelLife", redirect: "takenFromRadianceSentinelBeforeYou", source: "Sentinel of Radiance", limit: None }),
            "Summon Void Spawn" => Some(Pool { life: "TotalVoidSpawnLife", redirect: "takenFromVoidSpawnBeforeYou", source: "Void Spawns", limit: Some("ActiveVoidSpawnLimit") }),
            "Summon Stone Golem of Safeguarding" => Some(Pool { life: "TotalStoneGolemLife", redirect: "takenFromStoneGolemBeforeYou", source: "Stone Golem", limit: None }),
            _ => None,
        }
    };
    let sum = |env: &Env, n: &str| env.player.sum(ModType::Base, None, &[Sym::new(n)]);
    pom_defence::bd_est2::ally_list_reset();
    let redirects = ["takenFromSpectresBeforeYou", "takenFromMinionBeforeYou", "takenFromTotemsBeforeYou", "takenFromVaalRejuvenationTotemsBeforeYou",
        "takenFromRadianceSentinelBeforeYou", "takenFromVoidSpawnBeforeYou", "takenFromStoneGolemBeforeYou"];
    let needs_ally_life = redirects.iter().map(|r| sum(env, r)).sum::<f64>() != 0.0;
    if needs_ally_life {
        let skills = env.active_skills.clone();
        let mut calculated: pom_engine::fxhash::HashSet<&'static str> = pom_engine::fxhash::HashSet::default();
        let mut spectre_count = 0.0;
        let override_n = env.config_input.get("multiplierSummonedMinion").copied().filter(|v| *v != 0.0);
        let spectre_limit = env.output.get("ActiveSpectreLimit").copied().unwrap_or(0.0).min(override_n.unwrap_or(f64::INFINITY));
        let mut first_spectre: Option<f64> = None;
        let mut first_spectre_entry = 0usize;
        for c in &skills {
            if c.skill_flags.contains("disable") || (c.minion_list.is_empty() && !c.is_spectre) { continue; }
            if c.skill_types.contains(&117) { continue; }
            let skill_pool = if c.skill_flags.contains("spectre") { Some(SPECTRE) } else { by_skill(pom_skills::data::granted_effect_by_skill_id(&c.granted_effect_id).and_then(|ge| ge.name.as_deref()).unwrap_or(&c.name)) };
            let mut pools: Vec<Pool> = skill_pool.into_iter().collect();
            // Companionship (a buff on the supported skill carrying the redirect)
            let has_companionship = c.support_list.iter().any(|(ge, _, _)| ge.id.as_deref() == Some("SupportCompanionship"));
            if has_companionship {
                if let Some(sp) = pools.first() {
                    if sum(env, sp.redirect) != 0.0 && sum(env, COMPANION.redirect) != 0.0 {
                        let sp_life = sp.life;
                        pools = vec![COMPANION];
                        env.player.add_mod(pom_defence::modbuild::mb(&format!("MinionLifeShares{sp_life}"), "Companionship"));
                    } else { pools.push(COMPANION); }
                } else { pools.push(COMPANION); }
            }
            let mut minion_life: Option<f64> = None;
            let mut minion_name = String::new();
            for pool in &pools {
                let is_spectre = pool.life == SPECTRE.life;
                let can_add = ((is_spectre && spectre_count < spectre_limit) || (!is_spectre && !calculated.contains(pool.life)))
                    && sum(env, pool.redirect) != 0.0
                    && env.player.override_(None, &[Sym::new(pool.life)]).is_none();
                if !can_add { continue; }
                let life0 = match minion_life {
                    Some(l) => l,
                    None => {
                        let is_main = main_skill.is_some_and(|m| m.granted_effect_id == c.granted_effect_id && m.slot_name == c.slot_name && m.group_index == c.group_index);
                        let minion_data_name = |ty: &str| pom_calc::data::minion_raw(ty).and_then(|r| r.get("name").and_then(|n| n.as_str().map(str::to_string))).unwrap_or_default();
                        let l = match (is_main, main_minion) {
                            (true, Some(m)) => { minion_name = minion_data_name(&m.ty); m.output.get("Life").copied().unwrap_or(0.0) }
                            _ => match minion::create(env, c) {
                                Some(mut m) => { minion_name = minion_data_name(&m.ty); minion::attribs_and_pools(env, &mut m, c); m.output.get("Life").copied().unwrap_or(0.0) }
                                None => 0.0,
                            },
                        };
                        minion_life = Some(l);
                        l
                    }
                };
                let mut count = match pool.limit {
                    Some(l) => env.output.get(l).copied().unwrap_or_else(|| { let s = minion::skill_store(env, c); crate::calc_val(&s, l) }),
                    None => 1.0,
                };
                if is_spectre { count = 1.0; spectre_count += 1.0; }
                let life = life0 * count;
                env.player.add_mod(pom_defence::modbuild::m(pool.life, ModType::Base, life, pool.source));
                let entry = pom_defence::bd_est2::ally_entry(pool.life, &minion_name, life, Some(count));
                if is_spectre { if first_spectre.is_none() { first_spectre_entry = entry; } first_spectre.get_or_insert(life0); } else { calculated.insert(pool.life); }
            }
        }
        if let Some(l0) = first_spectre {
            if spectre_count < spectre_limit {
                let life = l0 * (spectre_limit - spectre_count);
                pom_defence::bd_est2::ally_entry_add(SPECTRE.life, first_spectre_entry, spectre_limit - spectre_count, life);
                env.player.add_mod(pom_defence::modbuild::m(SPECTRE.life, ModType::Base, life, SPECTRE.source));
            }
        }
    }
    totem_life_pools(env);
}

/// The totem half of the ally-Life block in `calcs.perform` (CalcPerform.lua:3760-3789): the nearest
/// totem's Life becomes `TotalTotemLife` (and `TotalVaalRejuvenationTotemLife`) when a
/// `takenFrom...BeforeYou` redirect is present. Minion/spectre pools (3667-3757) are not ported.
fn totem_life_pools(env: &mut Env) {
    let sum = |env: &Env, n: &str| env.player.sum(ModType::Base, None, &[Sym::new(n)]);
    let mut normal: Option<f64> = None;
    let mut vaal: Option<f64> = None;
    let (mut normal_name, mut vaal_name) = (String::new(), String::new());
    for c in &env.active_skills {
        if !c.skill_flags.contains("totem") || c.skill_flags.contains("disable") { continue; }
        // `skillData.totemLevel`: the level requirement, overridden by SkillData mods (CalcActiveSkill.lua:618, 661-666).
        let sd = crate::offence::skill_data_map(&env.player, c);
        let level = match sd.get("totemLevel") {
            Some(pom_engine::modstore::types::ScalarValue::Num(n)) => *n,
            _ => match c.skill_data.totem_level { Some(l) => l, None => continue },
        };
        let Some(ge) = pom_skills::data::granted_effect_by_skill_id(&c.granted_effect_id) else { continue };
        // CalcActiveSkill.lua:443-451
        let id = match ge.extra.get("skillTotemId").and_then(|v| v.as_i64()) {
            Some(i) => i,
            None => match ge.color { Some(2) => 2, Some(3) => 3, _ => 1 },
        };
        let snap = crate::buffs::player_snapshot(&env.player);
        let mut store = ModStore::new_list(Some(snap), env.player.actor.clone());
        for m in &c.skill_mod_list { store.add_mod(m.clone()); }
        let cfg = crate::buffs::skill_cfg(c);
        let (life, _) = pom_offence::cooldown::calc_totem_life(&store, Some(&cfg), level as i64, id);
        if ge.name.as_deref() == Some("Vaal Rejuvenation Totem") {
            vaal = Some(life);
            vaal_name = ge.name.clone().unwrap_or_default();
        } else if normal.map_or(true, |n| life > n) {
            normal = Some(life);
            normal_name = ge.name.clone().unwrap_or_default();
        }
    }
    let nearest_is_vaal = vaal.is_some_and(|v| normal.map_or(true, |n| v > n));
    let nearest_is_vaal_raw = nearest_is_vaal;
    let nearest = if nearest_is_vaal { vaal } else { normal };
    let total_override = env.player.override_(None, &[pom_engine::sym!("TotalTotemLife")]).is_some();
    let totem_redirect = sum(env, "takenFromTotemsBeforeYou");
    let nearest_is_vaal = nearest_is_vaal && !total_override;
    if let Some(life) = nearest {
        if !nearest_is_vaal && totem_redirect != 0.0 && !total_override {
            env.player.add_mod(pom_defence::modbuild::m("TotalTotemLife", ModType::Base, life, "Totem"));
            pom_defence::bd_est2::ally_entry("TotalTotemLife", if nearest_is_vaal_raw { &vaal_name } else { &normal_name }, life, None);
        }
    }
    if let Some(life) = vaal {
        if (sum(env, "takenFromVaalRejuvenationTotemsBeforeYou") != 0.0 || nearest_is_vaal && totem_redirect != 0.0)
            && env.player.override_(None, &[pom_engine::sym!("TotalVaalRejuvenationTotemLife")]).is_none()
        {
            env.player.add_mod(pom_defence::modbuild::m("TotalVaalRejuvenationTotemLife", ModType::Base, life, "Vaal Rejuvenation Totem"));
            pom_defence::bd_est2::ally_entry("TotalVaalRejuvenationTotemLife", &vaal_name, life, None);
        }
    }
}

/// `doActorLifeManaReservation`'s tail (CalcPerform.lua:558-583): the `GrantReserved<Pool>AsAura`
/// extra auras (only when `add_aura`) and the `Low<Pool>` conditions, from the just-computed pools.
fn reservation_tail(env: &mut Env, add_aura: bool) {
    if add_aura {
        for pool in ["Life", "Mana"] {
            let max = env.output.get(pool).copied().unwrap_or(0.0);
            let reserved = if max > 0.0 { env.output.get(&format!("{pool}Reserved")).copied().unwrap_or(0.0) } else { 0.0 };
            let lists = env.player.list(None, &[Sym::new(&format!("GrantReserved{pool}AsAura"))]);
            for value in lists {
                let pom_engine::value::Value::Map(fields) = &value else { continue };
                let Some(pom_engine::value::Value::Map(inner)) = fields.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v.clone()) else { continue };
                let new_inner: Vec<(Sym, pom_engine::value::Value)> = inner
                    .iter()
                    .map(|(k, v)| {
                        if k.as_str() == "value" {
                            (*k, pom_engine::value::Value::Num((v.num().unwrap_or(0.0) * reserved.min(max)).floor()))
                        } else {
                            (*k, v.clone())
                        }
                    })
                    .collect();
                let wrapped = pom_engine::value::Value::Map(std::sync::Arc::new(vec![(pom_engine::sym!("mod"), pom_engine::value::Value::Map(std::sync::Arc::new(new_inner)))]));
                env.player.add_mod(Mod { name: pom_engine::sym!("ExtraAura"), ty: ModType::List, value: wrapped, flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
            }
        }
    }
    // `Low<Pool>` conditions (CalcPerform.lua:570-571), from the just-computed Unreserved values.
    for pool in ["Life", "Mana"] {
        let max = env.output.get(pool).copied().unwrap_or(0.0);
        if max > 0.0 {
            let low_perc = env.player.sum(ModType::Base, None, &[Sym::new(&format!("Low{pool}Percentage"))]);
            let unreserved = env.output.get(&format!("{pool}Unreserved")).copied().unwrap_or(max);
            if unreserved / max <= if low_perc > 0.0 { low_perc } else { pom_offence::data::misc("LowPoolThreshold") } {
                env.player.conditions.insert(Sym::new(&format!("Low{pool}")), true);
            }
        }
    }
}

/// True when the actor's own `calcs.defence` / `calcs.buildDefenceEstimations` run should write its breakdown tables: the
/// Calcs mode is on and this is the real run, not a FullDPS / mirage copy (which upstream runs in CALCULATOR mode).
pub(crate) fn defence_bd_active() -> bool {
    pom_offence::bd::calcs_mode() && buffs::FULLDPS_PARENT.with(|p| p.borrow().is_none()) && pom_offence::bd::run_depth() <= 1
}

/// Foulborn Choir of the Storm (CalcPerform.lua:3395-3409): resistances are computed on a copy of
/// the player's modDB (`tempResistActor`) so `LightningResistOverCap` is in `output`, then life/mana
/// and their reservations are redone with the overcap-increased Mana, and `GrantReserved<Pool>AsAura`
/// finally applies.
fn redo_mana_after_overcap(env: &mut Env) {
    refresh_actors(env);
    let mut temp = ModStore::new_list(Some(crate::buffs::player_snapshot(&env.player)), env.player.actor.clone());
    let mut out = env.output.clone();
    // `tempResistActor` has no breakdown table (CalcPerform.lua:3405)
    let bd_was = pom_offence::bd::set_active(false);
    pom_defence::resist::resistances(&mut temp, &mut out);
    pom_offence::bd::set_active(bd_was);
    env.output = out;
    refresh_actors(env);
    let (life, mana) = pom_calc::perform_reserve::life_mana_pool(&env.player);
    env.output.insert("Life".to_string(), life);
    env.output.insert("Mana".to_string(), mana);
    bd_perform::life_mana_tables(&env.player, life, mana);
    env.output.insert("LowestOfMaximumLifeAndMaximumMana".to_string(), life.min(mana));
    let reserve = reservation(env);
    for (k, v) in reserve.fields {
        env.output.insert(k.to_string(), v);
    }
    reservation_tail(env, true);
}

/// `activeSkill.activeStageCount + 1` for Blood Sacrament (CalcActiveSkill.lua:646-656 sets `activeStageCount`;
/// CalcPerform.lua:2042-2046 multiplies the reservation by it).
fn blood_sacrament_stage_mult(player: &pom_engine::modstore::ModStore, c: &pom_skills::assemble::ComputedSkill) -> Option<f64> {
    if c.name != "Blood Sacrament" {
        return None;
    }
    let cfg = buffs::skill_cfg(c);
    let sym = pom_engine::sym::Sym::new;
    use crate::offence::TapAdd;
    let store = pom_engine::modstore::ModStore::new_list(Some(buffs::player_snapshot(player)), player.actor.clone()).tap_add(&c.skill_mod_list);
    let limit = store.sum(pom_engine::modifier::ModType::Base, Some(&cfg), &[sym("Multiplier:BloodSacramentMaxStages")]);
    if limit <= 0.0 {
        return None;
    }
    let min_stage = store.sum(pom_engine::modifier::ModType::Base, Some(&cfg), &[sym("Multiplier:BloodSacramentMinimumStage")]);
    let count = c.stage_count.unwrap_or(limit).max(1.0 + min_stage);
    if count > 0.0 { Some(count) } else { None }
}

/// `doActorLifeManaReservation` over the env's active skills (see the call site in `perform`).
pub(crate) fn reservation(env: &Env) -> pom_calc::perform_reserve::ReserveResult {
    reservation_with(env, &env.active_skills)
}
pub(crate) fn reservation_with(env: &Env, active_skills: &[pom_skills::assemble::ComputedSkill]) -> pom_calc::perform_reserve::ReserveResult {
    // `compute_reservation` skips a skill that is disabled, has no reservation or turns it into a cost before
    // reading its mods, gem, cfg or override; those get empty ones instead of copies.
    let reserves = |c: &pom_skills::assemble::ComputedSkill| c.skill_types.contains(&12) && !c.skill_types.contains(&13) && !c.skill_flags.contains("disable");
    let skill_snapshots: Vec<pom_calc::snapshot::SkillSnapshot> = active_skills
        .iter()
        .map(|c| {
            let full = reserves(c);
            pom_calc::snapshot::SkillSnapshot {
                name: Some(c.name.clone()),
                skill_flags: c.skill_flags.iter().map(|f| (f.clone(), true)).collect(),
                skill_types: c.skill_types.iter().copied().collect(),
                skill_mod_list: if full { c.skill_mod_list.clone() } else { Vec::new() },
                gem: Some(pom_calc::snapshot::GemRef { granted_effect_id: Some(c.granted_effect_id.clone()), gem_id: None, level: c.level, quality: c.quality }),
                cfg: if full { Some(crate::buffs::skill_cfg(c)) } else { None },
            }
        })
        .collect();
    // `activeSkill.skillData` reservation keys (CalcPerform.lua:1984-1993, 2013-2027): a support's
    // `skill("manaReservationPercent", 0)` base mod (Eternal Blessing), Blasphemy-style
    // `level.manaReservationPercent`, and the `*ReservationFlat/PercentForced` SkillData mods.
    let overrides: Vec<pom_calc::perform_reserve::SkillReserveOverride> = active_skills
        .iter()
        .map(|c| {
            if !reserves(c) {
                return Default::default();
            }
            let m = crate::offence::skill_data_map(&env.player, c);
            let g = |k: &str| match m.get(k) {
                Some(pom_engine::modstore::types::ScalarValue::Num(v)) => Some(*v),
                _ => None,
            };
            pom_calc::perform_reserve::SkillReserveOverride {
                mana_flat: g("manaReservationFlat"),
                mana_percent: g("manaReservationPercent"),
                life_flat: g("lifeReservationFlat"),
                life_percent: g("lifeReservationPercent"),
                mine_count: c.active_mine_count,
                blood_sacrament_stage_mult: blood_sacrament_stage_mult(&env.player, c),
                forced: [g("ManaReservationFlatForced"), g("ManaReservationPercentForced"), g("LifeReservationFlatForced"), g("LifeReservationPercentForced")],
            }
        })
        .collect();
    let res = pom_calc::perform_reserve::compute_reservation(&env.player, &skill_snapshots, &overrides);
    res
}

