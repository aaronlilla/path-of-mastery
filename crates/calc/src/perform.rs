//! Orchestration shape of Modules/Calcs.lua + CalcPerform.lua's `calcs.perform`. Ported so far:
//! `compute_attributes`/`attribute_bonus_mods`, the attribute-value and attribute-bonus part of
//! `doActorAttribsConditions` (CalcPerform.lua:411-528); `calculate_omniscience` in
//! `perform_omni.rs` (the Omniscience-keystone alternative to `compute_attributes`, same call
//! site); `doActorCharges` in `perform_charges.rs`; skill life/mana reservation in
//! `perform_reserve.rs`; the per-summoned-minion `Multiplier`/`Condition` mods in
//! `perform_minions.rs`. Graded in isolation against the recorder's `prePerform` snapshot. What is
//! still unported (Offence/Defence, everything else `doActorAttribsConditions` sets, parts of
//! buffs/auras/curses/flasks) is named on the functions below.
//!
//! Call order, traced from Modules/Calcs.lua (`calcs.buildOutput`, mode "MAIN") and
//! Modules/CalcPerform.lua (`calcs.perform`, lines 1286+):
//! 1. `calcs.initEnv(build, mode)` - this crate's `setup` module (partial).
//! 2. `calcs.perform(env)`:
//!    a. `modLib.mergeKeystones(env, env.modDB)` (line 1292) - re-run now that item/tree mods are
//!       merged (Setup already ran it once for `env.initialNodeModDB` alone, CalcSetup.lua:775).
//!    b. Build minion skills for every active skill with a minion (`calcs.createMinionSkills`,
//!       CalcActiveSkill.lua) - depends on the (unported) full CalcActiveSkill pipeline.
//!    c. `env.player.output = {}` / `env.enemy.output = {}` (lines 1305-1306): fresh output
//!       tables for this pass.
//!    d. Early sections with no shared dependency order among themselves but each reads/writes
//!       `modDB`/`enemyDB` directly (lines 1310-1385ish): Alchemist's Genius flask mods, banner
//!       valour, warcry power, brand attach counts, totem limits, `applyEnemyModifiers`.
//!    e. The bulk of the file: buffs, auras, curses, charges, reservations, flasks, attributes,
//!       resistances, then `calcs.offence(env, env.player, env.player.mainSkill)` and
//!       `calcs.defence(env, env.player)` - these two calls are stubbed here; Offence and
//!       Defence live in their own crates.
//! 3. `calcs.buildOutput`'s post-`perform` aggregation (Modules/Calcs.lua:384-459 for mode
//!    "MAIN"): `calcs.calcFullDPS` (loops every `activeSkill.socketGroup.includeInFullDPS` skill
//!    through another `calcs.perform` pass), cost/reservation warnings, `env.skillsUsed`/
//!    `env.conditionsUsed`/etc. bookkeeping for the UI. None of this is reachable without Offence
//!    (`output.TotalDPS` etc.) existing first.
use crate::data::accuracy_per_dex_base;
use crate::modbuild::{m, mf, mt};
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modparser::flags::mod_flag as mf_;
use pom_engine::modstore::{Cfg, ModStore};
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashMap;

/// Placeholder for `calcs.offence(env, actor, activeSkill)` (Modules/CalcOffence.lua). The
/// offence crate owns the real function.
pub fn offence_stub(_player_mod_db: &ModStore) {}

/// Placeholder for `calcs.defence(env, actor)` (Modules/CalcDefence.lua). The defence crate owns
/// the real function.
pub fn defence_stub(_player_mod_db: &ModStore) {}

/// `modLib.compareModParams` (Modules/ModTools.lua:121-134): name, type, flags, keywordFlags and
/// tags all equal - source and value are deliberately not part of the comparison. `Mod` already
/// derives `PartialEq` over every field including `tags`, so this only needs to leave `source`
/// and `value` out.
fn mod_params_match(a: &Mod, b: &Mod) -> bool {
    a.name == b.name && a.ty == b.ty && a.flags == b.flags && a.keyword_flags == b.keyword_flags && a.tags == b.tags
}

/// `mergeBuff(src, destTable, destKey)` (CalcPerform.lua:44-62): merges `src` into one `dest`
/// list, keeping at most one mod per distinct `mod_params_match` group. A `LIST`-type mod is
/// always appended (never deduplicated - `if mod.type ~= "LIST" then ... end` skips the dedup
/// search entirely for those). A non-`LIST` mod either starts a new group, or, when a match is
/// found, replaces the existing one only if its value is a plain number and strictly larger
/// (never on a tie, and never when the existing value isn't numeric, e.g. a `FLAG`'s `true`) -
/// otherwise the earlier mod already in `dest` is left alone.
pub fn merge_buff(dest: &mut Vec<Mod>, src: &[Mod]) {
    for m in src {
        if m.ty != ModType::List {
            if let Some(existing) = dest.iter_mut().find(|d| mod_params_match(m, d)) {
                if let (Value::Num(new_v), Value::Num(old_v)) = (&m.value, &existing.value) {
                    if *new_v > *old_v {
                        *existing = m.clone();
                    }
                }
                continue;
            }
        }
        dest.push(m.clone());
    }
}

/// `modLib.formatModParams`-per-mod fingerprint of a flask's own `modList` (CalcPerform.lua:
/// 1740-1746's `key` construction, used to group two non-unique flasks' `modList` contributions
/// together only when their entire recorded mod lists are byte-identical). `formatModParams`
/// itself is `name|type|flags(formatted)|keywordFlags(formatted)|tags(formatted)`, i.e. exactly
/// the fields `mod_params_match` already compares, just turned into a hashable/sortable key
/// instead of a pairwise predicate. `Tag`/`Value` don't derive `Hash` (a `Value::Num(f64)` can't),
/// so the fingerprint is built as a `Debug`-formatted string (both derive `Debug`) rather than a
/// structured, directly-hashable key; it only needs to distinguish groups correctly, matching the
/// original's own `key = key .. modLib.formatModParams(mod) .. "&"` per-mod concatenation - there
/// is no need for a stable/human-readable format.
fn flask_mod_list_key(mods: &[Mod]) -> String {
    let mut key = String::new();
    for m in mods {
        key.push_str(&format!("{:?}|{:?}|{}|{}|{:?}&", m.name, m.ty, m.flags, m.keyword_flags, m.tags));
    }
    key
}

/// One active flask/tincture item's recorded fields `mergeFlasks`/`calcFlaskMods`
/// (CalcPerform.lua:1679-1763) needs: `buffModList` (the flask base type's own fixed buff lines,
/// `perform::flask_buff_mod_list`) and `modList` (the item's own rolled mods, already what
/// `items::BuildItems::mods_for_slot` returns for a flask item) kept as the two genuinely separate
/// lists upstream treats them as, plus the item metadata `calcFlaskMods`' keying/scaling logic
/// reads off the item itself rather than off either mod list.
#[derive(Clone)]
pub struct FlaskInput {
    pub base_name: String,
    pub title: Option<String>,
    pub is_unique_or_relic: bool,
    pub is_magic: bool,
    pub is_life_or_mana: bool,
    /// `item.base.flask.life` / `.mana` individually (`is_life_or_mana` is their OR).
    pub is_life: bool,
    pub is_mana: bool,
    /// `item.flaskData.instantPerc` / `.instantLowLifePerc` (0 when absent).
    pub instant_perc: f64,
    pub instant_low_life_perc: f64,
    /// `item.name` (the source of the recovery mods `calcFlaskRecovery` creates).
    pub name: String,
    /// `item.flaskData.lifeBase` / `.manaBase` / `.duration` (0 when absent).
    pub life_base: f64,
    pub mana_base: f64,
    pub duration: f64,
    /// `item.flaskData.lifeEffectNotRemoved` / `.manaEffectNotRemoved`.
    pub life_effect_not_removed: bool,
    pub mana_effect_not_removed: bool,
    pub effect_inc: f64,
    pub buff_mod_list: Vec<Mod>,
    pub mod_list: Vec<Mod>,
}

/// `item.buffModList` (`Item.lua:2554-2561`, `BuildModList`): every mod line in this flask's
/// *base type*'s own fixed `flask.buff` array (`data::flask_base_info`) - a property of the base,
/// not this specific item's rolls (every item on the same base grants the identical buff lines) -
/// parsed via the same `modparser::parse_mod` port `ModParser.lua`'s `parseMod` corresponds to,
/// then source-tagged with the item's own `modSource` ("Item:<id>:<name>", matching
/// `mod.source = self.modSource` at Item.lua:2559). A line whose `parse_mod` returns `None`
/// (unrecognized text) contributes nothing, same as upstream silently producing an empty
/// `modList` for that line.
pub fn flask_buff_mod_list(base_name: &str, source: &str) -> Vec<Mod> {
    let Some(info) = crate::data::flask_base_info(base_name) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &info.buff_lines {
        let (mods, _extra) = pom_engine::modparser::parse_mod(line);
        if let Some(mods) = mods {
            for pm in &mods {
                let mut m = pom_engine::modparser::types::pmod_to_mod(pm);
                m.source = Some(std::sync::Arc::from(source));
                out.push(m);
            }
        }
    }
    out
}

/// `modDB:Flag(nil, "AlchemistsGenius")` branch (CalcPerform.lua:1325-1329, one of the
/// no-shared-dependency-order "early sections" this module's own doc comment lists): the
/// "Alchemist's Genius" unique flask's buff (`Condition:AlchemistsGenius`, a config-tab checkbox
/// per `ConfigOptions.lua:1054-1056` - `CalcSetup.lua:112` turns it into a plain `AlchemistsGenius`
/// FLAG mod already present in `store` by the time this runs) grants `10%`/`20%` increased flask
/// effect/charges gained, each itself scaled by `BuffEffectOnSelf` - dynamically computed and
/// injected into `modDB` here rather than living on any item's own mod list, which is why
/// `merge_flask_mods`'s `FlaskEffect` sum can't see it without this call running first (matching
/// upstream's own call order: this, then `mergeFlasks`). `math.floor` (`m_floor`) is exact, no
/// truncation-quirk subtlety here (unlike `ScaleAddMod`'s `scaled_num`).
pub fn apply_alchemists_genius(store: &mut ModStore) {
    if !store.flag(None, &[pom_engine::sym!("AlchemistsGenius")]) {
        return;
    }
    let effect_mod = 1.0 + store.sum(ModType::Inc, None, &[pom_engine::sym!("BuffEffectOnSelf")]) / 100.0;
    store.add_mod(m("FlaskEffect", ModType::Inc, (10.0 * effect_mod).floor(), "Alchemist's Genius"));
    store.add_mod(m("FlaskChargesGained", ModType::Inc, (20.0 * effect_mod).floor(), "Alchemist's Genius"));
}

/// The innate-mod half of `mergeFlasks` (CalcPerform.lua:1679-1763, the "player applies" branch
/// only - `flaskBuffsNonPlayer`/minion application, and `calcFlaskRecovery`'s `FlaskXRecovery`
/// computed mods, are not ported here).
///
/// Real keying, replacing an earlier session's single-shared-accumulator approximation:
/// `buffModList` contributions are grouped by `item.baseName` (CalcPerform.lua:1727's
/// `mergeBuff(srcList, flaskBuffs, baseName)` - every flask of the same base type shares one
/// group, regardless of rarity), `modList` contributions by `item.title` for a UNIQUE/RELIC flask
/// or a `flask_mod_list_key` fingerprint of the *unscaled* `modList` for everything else
/// (CalcPerform.lua:1741-1746). Both groupings share one key space exactly as `flaskBuffs` does in
/// upstream (a single Lua table indexed by either a baseName or a title/fingerprint string) -
/// two flasks only dedupe against each other when they land in the *same* group; different groups
/// never merge against each other, they're all just concatenated into the final result. Each
/// flask's own contribution is scaled first (`ScaleAddList`/`scale_add_list`) by
/// `1 + flaskEffectInc/100`, where `flaskEffectInc = modDB:Sum("INC",{actor="player"},
/// "FlaskEffect") + item.flaskData.effectInc`, plus `modDB:Sum("INC",{actor="player"},
/// "MagicUtilityFlaskEffect")` when the flask is MAGIC rarity and not a life/mana flask
/// (CalcPerform.lua:1701-1710) - the Essence of Desolation "no adjacent flask" magic bonus
/// (1711-1719) is NOT modeled (needs `env.flaskSlotMap`/`flaskSlotOccupied`, not recorded by this
/// crate's harness; unmeasured, not confirmed present in the graded corpus).
///
/// `FlasksDoNotApplyToPlayer` skips everything (CalcPerform.lua:1814); when
/// `UtilityFlasksDoNotApplyToPlayer` is set instead, only life/mana flasks' contributions apply
/// (`appliedFlaskBuffs = flaskBuffsNonUtility`, which only ever received insertions gated by `not
/// isUtilityFlask` in upstream - reproduced here as filtering the *input* flask list down to
/// `is_life_or_mana` ones before grouping, equivalent since a life/mana flask's own group can
/// never also receive a utility flask's contribution: distinct base names, and a modList
/// fingerprint collision across genuinely different flask types is not realistic).
pub fn merge_flask_mods(store: &ModStore, flasks: &[FlaskInput]) -> Vec<Mod> {
    if store.flag(None, &[pom_engine::sym!("FlasksDoNotApplyToPlayer")]) {
        return Vec::new();
    }
    let utility_disabled = store.flag(None, &[pom_engine::sym!("UtilityFlasksDoNotApplyToPlayer")]);
    let player_cfg = Cfg { actor_tag: Some(std::sync::Arc::from("player")), ..Cfg::default() };
    let effect_inc = store.sum(ModType::Inc, Some(&player_cfg), &[pom_engine::sym!("FlaskEffect")]);
    let effect_inc_magic = store.sum(ModType::Inc, Some(&player_cfg), &[pom_engine::sym!("MagicUtilityFlaskEffect")]);

    // Insertion-ordered: upstream's `pairs()` over its string-keyed tables visits in insertion order here.
    let mut groups: indexmap::IndexMap<String, Vec<Mod>> = indexmap::IndexMap::new();
    for flask in flasks {
        if utility_disabled && !flask.is_life_or_mana {
            continue;
        }
        let mut flask_effect_inc = effect_inc + flask.effect_inc;
        if flask.is_magic && !flask.is_life_or_mana {
            flask_effect_inc += effect_inc_magic;
        }
        let effect_mod = 1.0 + flask_effect_inc / 100.0;

        if !flask.buff_mod_list.is_empty() {
            let scaled = scale_add_list(&flask.buff_mod_list, effect_mod);
            merge_buff(groups.entry(flask.base_name.clone()).or_default(), &scaled);
        }
        if !flask.mod_list.is_empty() {
            let key = if flask.is_unique_or_relic { flask.title.clone().unwrap_or_default() } else { flask_mod_list_key(&flask.mod_list) };
            let scaled = scale_add_list(&flask.mod_list, effect_mod);
            merge_buff(groups.entry(key).or_default(), &scaled);
        }
    }
    groups.into_values().flatten().collect()
}

/// `flaskBuffsNonPlayer` and `flaskBuffsPerBaseNonPlayer` (CalcPerform.lua:1727-1763): what the minion's modDB receives
/// from the player's flasks. `applies` is `flasksApplyToMinion or quickSilverAppliesToAllies or (nonUnique...)`.
pub struct MinionFlaskMods {
    pub all: Vec<Mod>,
    pub per_base: indexmap::IndexMap<String, Vec<Mod>>,
}

pub fn merge_flask_mods_non_player(store: &ModStore, flasks: &[FlaskInput], applies: &dyn Fn(&FlaskInput) -> bool) -> MinionFlaskMods {
    let effect_inc = store.sum(ModType::Inc, None, &[pom_engine::sym!("FlaskEffect")]);
    let effect_inc_magic = store.sum(ModType::Inc, None, &[pom_engine::sym!("MagicUtilityFlaskEffect")]);
    let mut groups: indexmap::IndexMap<String, Vec<Mod>> = indexmap::IndexMap::new();
    let mut per_base_groups: indexmap::IndexMap<String, indexmap::IndexMap<String, Vec<Mod>>> = indexmap::IndexMap::new();
    for flask in flasks {
        if !applies(flask) {
            continue;
        }
        let mut inc = effect_inc + flask.effect_inc;
        if flask.is_magic && !flask.is_life_or_mana {
            inc += effect_inc_magic;
        }
        let effect_mod = 1.0 + inc / 100.0;
        if !flask.buff_mod_list.is_empty() {
            let scaled = scale_add_list(&flask.buff_mod_list, effect_mod);
            merge_buff(groups.entry(flask.base_name.clone()).or_default(), &scaled);
            merge_buff(per_base_groups.entry(flask.base_name.clone()).or_default().entry(flask.base_name.clone()).or_default(), &scaled);
        }
        if !flask.mod_list.is_empty() {
            let key = if flask.is_unique_or_relic { flask.title.clone().unwrap_or_default() } else { flask_mod_list_key(&flask.mod_list) };
            let scaled = scale_add_list(&flask.mod_list, effect_mod);
            merge_buff(groups.entry(key.clone()).or_default(), &scaled);
            merge_buff(per_base_groups.entry(flask.base_name.clone()).or_default().entry(key).or_default(), &scaled);
        }
    }
    MinionFlaskMods {
        all: groups.into_values().flatten().collect(),
        per_base: per_base_groups.into_iter().map(|(k, g)| (k, g.into_values().flatten().collect())).collect(),
    }
}

/// `mergeFlasks(env.flasks, true, ...)`'s recovery half (CalcPerform.lua:3121, `calcFlaskRecovery`
/// 1652-1689): a Life/Mana flask whose effect is not removed contributes a `LifeRecovery`/
/// `ManaRecovery` BASE mod of `total / duration`, scaled by that flask's effect and merged like any
/// other flask buff. Returned mods are merged into the player's modDB by the caller.
pub fn merge_flask_recovery(store: &ModStore, flasks: &[FlaskInput]) -> Vec<Mod> {
    if store.flag(None, &[pom_engine::sym!("FlasksDoNotApplyToPlayer")]) {
        return Vec::new();
    }
    let s = |n: &str| Sym::new(n);
    let player_cfg = Cfg { actor_tag: Some(std::sync::Arc::from("player")), ..Cfg::default() };
    let effect_inc = store.sum(ModType::Inc, Some(&player_cfg), &[s("FlaskEffect")]);
    let total_rate_inc = store.sum(ModType::Inc, None, &[s("FlaskRecoveryRate")]);
    let dur_inc = store.sum(ModType::Inc, None, &[s("FlaskDuration")]);
    let low_life = store.flag(None, &[s("Condition:LowLife")]);
    let cannot_recover_life = store.flag(None, &[s("CannotRecoverLifeOutsideLeech")]);
    let life_instant = store.sum(ModType::Base, None, &[s("LifeFlaskInstantRecovery")]);
    let mana_instant = store.sum(ModType::Base, None, &[s("ManaFlaskInstantRecovery")]);

    let mut groups: std::collections::BTreeMap<&str, Vec<Mod>> = std::collections::BTreeMap::new();
    for f in flasks {
        let mut instant = f.instant_perc;
        if low_life {
            instant += f.instant_low_life_perc;
        }
        if f.is_life {
            instant += life_instant;
        }
        if f.is_mana {
            instant += mana_instant;
        }
        let instant = instant.min(100.0);
        let effect_mod = 1.0 + (effect_inc + f.effect_inc) / 100.0;
        for (ty, present, base, not_removed, group) in [("Life", f.is_life && !cannot_recover_life, f.life_base, f.life_effect_not_removed, "LifeFlask"), ("Mana", f.is_mana, f.mana_base, f.mana_effect_not_removed, "ManaFlask")] {
            if !present || !(not_removed || store.flag(None, &[s(&format!("{ty}FlaskEffectNotRemoved"))])) {
                continue;
            }
            let rec_inc = store.sum(ModType::Inc, None, &[s(&format!("Flask{ty}Recovery"))]);
            let rec_more = store.more(None, &[s(&format!("Flask{ty}Recovery"))]);
            let rate_inc = store.sum(ModType::Inc, None, &[s(&format!("Flask{ty}RecoveryRate"))]);
            // "50% less Life Flask Recovery Rate" (Master Surgeon, 3.30) is a MORE on the same rate: the flask lasts longer for the same total
            let rate_more = store.more(None, &[s(&format!("Flask{ty}RecoveryRate"))]);
            let mut total = base * (1.0 - instant / 100.0) * (1.0 + rec_inc / 100.0) * rec_more * (1.0 + dur_inc / 100.0);
            let dur = f.duration * (1.0 + dur_inc / 100.0) / (1.0 + total_rate_inc / 100.0) / (1.0 + rate_inc / 100.0) / rate_more;
            let low_more = store.more(None, &[s("FlaskLifeRecoveryLowLife")]);
            if low_more > 1.0 && ty == "Life" {
                total *= (low_more - 1.0) / (1.0 + effect_inc / 100.0) + 1.0;
            }
            let rate = total / dur;
            let mk = |name: &str| Mod { name: Sym::new(name), ty: ModType::Base, value: Value::Num(rate), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(f.name.as_str())), tags: (vec![]).into() };
            let mut out = vec![mk(&format!("{ty}Recovery"))];
            if store.flag(None, &[s(&format!("{ty}FlaskAppliesToEnergyShield"))]) {
                out.push(mk("EnergyShieldRecovery"));
            }
            if store.flag(None, &[s(&format!("{ty}FlaskAppliesToLife"))]) {
                out.push(mk("LifeRecovery"));
            }
            let scaled = scale_add_list(&out, effect_mod);
            merge_buff(groups.entry(group).or_default(), &scaled);
        }
    }
    groups.into_values().flatten().collect()
}

/// `modLib.mergeKeystones(env, env.modDB)`, re-run as the very first thing `calcs.perform` does
/// (CalcPerform.lua:1292, `Modules/ModTools.lua:248-259`), before any of the rest of this file.
/// Setup already merged each keystone's own placeholder `"Keystone"` LIST marker mod into
/// `env.modDB` (a keystone-type node's `finalModList` is just that marker, `buildModListForNode`
/// at CalcSetup.lua:139-142); this call is what turns each marker into that keystone's real
/// effect mods (`env.spec.tree.keystoneMap[name].modList`, e.g. `NoDexBonusToEvasion` for Iron
/// Reflexes), which is why a build with an allocated keystone still needs this step even though
/// its keystone was allocated back in Setup, not during Perform. This crate's own recorder
/// already captures a Keystone-type node's real mod list directly (the same `node.modList` this
/// port's own `keystoneMap` lookup would need), so this just adds those straight in rather than
/// re-deriving a keystone name -> mod list table from tree data; the per-keystone `keystonesAdded`
/// dedup guard upstream has is not needed here since a build can only allocate a given
/// keystone once.
pub fn merge_keystones(store: &mut ModStore, alloc_nodes: &pom_engine::fxhash::HashMap<i64, crate::snapshot::AllocNode>) {
    for node in alloc_nodes.values() {
        if node.node_type == "Keystone" {
            for m in &node.mods {
                store.add_mod(m.clone());
            }
        }
    }
}

/// `calcLib.val(modStore, name)` (Modules/CalcTools.lua:32-39, `cfg` always nil here): `Sum(BASE)
/// * (1 + Sum(INC)/100) * More(...)`, or 0 outright when the base sum is 0 (an early-out the
/// original takes too, not just an optimization: it skips ever calling `More`, which matters if
/// a `More` mod has side effects through `EvalMod`'s global-limit tracking).
pub fn calc_val_pub(store: &ModStore, name: Sym) -> f64 {
    calc_val(store, name)
}

pub(crate) fn calc_val(store: &ModStore, name: Sym) -> f64 {
    let base = store.sum(ModType::Base, None, &[name]);
    if base != 0.0 {
        let inc = 1.0 + store.sum(ModType::Inc, None, &[name]) / 100.0;
        base * inc * store.more(None, &[name])
    } else {
        0.0
    }
}

/// `round(val)` with no decimal argument (Modules/Common.lua:709): `floor(val + 0.5)`, not
/// language-default round-half-to-even.
pub(crate) fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `output.Str`/`.Dex`/`.Int`, the non-Omniscience path only (`doActorAttribsConditions`'s
/// `calculateAttributes`, CalcPerform.lua:411-437): two passes in upstream because the
/// attribute-comparison conditions it also sets (`StrHigherThanInt` etc.) can read a value the
/// same pass computed for a different stat, but the three output numbers themselves don't change
/// between passes, so one pass is enough for the values this port grades. The comparison
/// conditions themselves are not ported.
pub struct Attributes {
    pub str_: f64,
    pub dex: f64,
    pub int_: f64,
}

pub fn compute_attributes(store: &ModStore) -> Attributes {
    let val = |name: &str| round(calc_val(store, Sym::new(name))).max(0.0);
    Attributes { str_: val("Str"), dex: val("Dex"), int_: val("Int") }
}

/// The "Add attribute bonuses" block right after `calculateAttributes`/`calculateOmniscience`
/// (CalcPerform.lua:504-528): Life from Strength, melee Physical Damage from Strength (plus
/// `DexIntToMeleeBonus`/`StrDmgBonusRatioOverride`), Accuracy and Evasion from Dexterity, Mana
/// and Energy Shield from Intelligence, each individually gated by its own `No*Bonus*` flag mod.
/// Omniscience's own bonus suppression (`modDB:Flag(nil, "NoAttributeBonuses")` still applies,
/// since `calculateOmniscience` isn't ported and Omniscience-respec'd builds aren't graded here
/// yet) and the total-attribute/Devotion output fields above this block are not ported.
pub fn attribute_bonus_mods(store: &ModStore, attrs: &Attributes) -> Vec<Mod> {
    let flag = |name: &str| store.flag(None, &[Sym::new(name)]);
    let mut mods = Vec::new();
    if flag("NoAttributeBonuses") {
        return mods;
    }
    if !flag("NoStrengthAttributeBonuses") {
        if !flag("NoStrBonusToLife") {
            mods.push(m("Life", ModType::Base, (attrs.str_ / 2.0).floor(), "Strength"));
        }
        let dex_int_to_melee = store.sum(ModType::Base, None, &[pom_engine::sym!("DexIntToMeleeBonus")]);
        let ratio_override = store.sum(ModType::Base, None, &[pom_engine::sym!("StrDmgBonusRatioOverride")]);
        let str_dmg_bonus = if ratio_override > 0.0 { ((attrs.str_ + dex_int_to_melee) * ratio_override).floor() } else { ((attrs.str_ + dex_int_to_melee) / 5.0).floor() };
        mods.push(mf("PhysicalDamage", ModType::Inc, str_dmg_bonus, "Strength", mf_::Melee, vec![]));
    }
    if !flag("NoDexterityAttributeBonuses") {
        let per_dex = store.override_(None, &[pom_engine::sym!("DexAccBonusOverride")]).and_then(|v| v.num()).unwrap_or_else(accuracy_per_dex_base);
        mods.push(m("Accuracy", ModType::Base, attrs.dex * per_dex, "Dexterity"));
        if !flag("NoDexBonusToEvasion") {
            mods.push(mt("Evasion", ModType::Inc, (attrs.dex / 5.0).floor(), "Dexterity", vec![]));
        }
    }
    if !flag("NoIntelligenceAttributeBonuses") {
        if !flag("NoIntBonusToMana") {
            mods.push(m("Mana", ModType::Base, (attrs.int_ / 2.0).floor(), "Intelligence"));
        }
        if !flag("NoIntBonusToES") {
            mods.push(mt("EnergyShield", ModType::Inc, (attrs.int_ / 10.0).floor(), "Intelligence", vec![]));
        }
    }
    mods
}

/// `data.highPrecisionMods` (Modules/Data.lua:436-524), name-keyed by (name, type) exactly like
/// upstream (`pom_engine::modstore::store::high_precision_more` ports only this table's
/// single `MORE`-type entry, for `MoreInternal`'s own unrelated use - `ScaleAddMod` needs the
/// whole table, including that entry, which is why it's repeated here rather than shared).
fn high_precision_scale(name: Sym, ty: ModType) -> Option<i32> {
    match (name.as_str(), ty) {
        ("CritChance" | "SelfCritChance" | "LifeRegenPercent" | "ManaRegenPercent" | "EnergyShieldRegenPercent" | "LifeDegenPercent" | "LifeDegenPercentTincture" | "ManaDegenPercent" | "ManaDegenPercentTincture" | "EnergyShieldDegenPercent" | "DamageLifeLeech" | "PhysicalDamageLifeLeech" | "ElementalDamageLifeLeech" | "FireDamageLifeLeech" | "ColdDamageLifeLeech" | "LightningDamageLifeLeech" | "ChaosDamageLifeLeech" | "DamageManaLeech" | "PhysicalDamageManaLeech" | "ElementalDamageManaLeech" | "FireDamageManaLeech" | "ColdDamageManaLeech" | "LightningDamageManaLeech" | "ChaosDamageManaLeech" | "DamageEnergyShieldLeech" | "PhysicalDamageEnergyShieldLeech" | "ElementalDamageEnergyShieldLeech" | "FireDamageEnergyShieldLeech" | "ColdDamageEnergyShieldLeech" | "LightningDamageEnergyShieldLeech" | "ChaosDamageEnergyShieldLeech", ModType::Base) => Some(2),
        ("LifeRegen" | "ManaRegen" | "EnergyShieldRegen" | "RageRegen" | "LifeDegen" | "ManaDegen" | "EnergyShieldDegen", ModType::Base) => Some(1),
        ("SupportManaMultiplier", ModType::More) => Some(4),
        _ => None,
    }
}

/// `round(val, 2)` (Modules/Common.lua:709-715 with a `dec` argument): `floor(val*100+0.5)/100`.
fn round2(v: f64) -> f64 {
    (v * 100.0 + 0.5).floor() / 100.0
}

/// The numeric scaling core shared by a plain mod's own `value` and a nested `value.mod`'s
/// (`name`/`ty` are whichever mod's fields are actually being scaled - the outer mod's for the
/// former, the inner `value.mod`'s own for the latter, since `data.highPrecisionMods` and the
/// truncation quirk both key off the mod that's *actually* getting its value changed).
fn scaled_num(v: f64, scale: f64, name: Sym, ty: ModType) -> f64 {
    match high_precision_scale(name, ty).or(if v.floor() != v { Some(1) } else { None }) {
        Some(p) => {
            let power = 10f64.powi(p);
            (v * scale * power).floor() / power
        }
        // `m_modf(round(v * scale, 2))`: `math.modf` in a single-value assignment context keeps
        // only its first return (the truncated integer part) - a genuine original quirk, ported as-is.
        None => round2(v * scale).trunc(),
    }
}

/// Replaces `map`'s `"value"` entry (an `f64`, looked up via `name`/`"type"` also in `map`, both
/// needed for `scaled_num`'s precision lookup) with its scaled value, leaving every other field
/// untouched. `None` if `map` doesn't have the shape a `Mod`-as-`Value::Map` needs (a name, a
/// type this crate recognizes, and a numeric value) - the caller then leaves the whole mod alone,
/// same as the top-level "not a number" case does.
fn scale_nested_mod_map(map: &[(Sym, Value)], scale: f64) -> Option<Vec<(Sym, Value)>> {
    let name = map.iter().find_map(|(k, v)| if k.as_str() == "name" { if let Value::Str(s) = v { Some(Sym::new(s)) } else { None } } else { None })?;
    let ty = map.iter().find_map(|(k, v)| if k.as_str() == "type" { if let Value::Str(s) = v { ModType::parse(s) } else { None } } else { None })?;
    let value = map.iter().find_map(|(k, v)| if k.as_str() == "value" { v.num() } else { None })?;
    let new_value = scaled_num(value, scale, name, ty);
    Some(map.iter().map(|(k, v)| if k.as_str() == "value" { (*k, Value::Num(new_value)) } else { (*k, v.clone()) }).collect())
}

/// `ModStoreClass:ScaleAddMod` (Classes/ModStore.lua:56-91) for one mod: the plain-number `value`
/// case, and the `value.mod` nested case (`MinionModifier`/`AllyModifier` LIST mods carry a
/// complete inner mod description under `value.mod` - e.g. a golem's `MinionModifier` mod's own
/// `value` is `{mod = {name="PhysicalMin", type="BASE", value=35, ...}}` - and it's the *inner*
/// mod's value that needs scaling, the outer `MinionModifier`/`LIST` mod itself has no numeric
/// value of its own to scale). **Not modeled:** `value.keyOfScaledMod` (a different, rarer nested
/// shape using a plain `round(val, 2)` with no truncation quirk and no precision-table lookup at
/// all - not seen in this port's own graded corpus) passes through unscaled, same as any other
/// mod whose `value` isn't a plain number or a `{mod = ...}` map. `replace` (`ReplaceModInternal`
/// instead of `AddMod`) is never used by the buff/aura call sites this port covers, so it isn't
/// modeled either.
fn scale_mod(src: &Mod, scale: f64) -> Mod {
    let unscalable = src.tags.iter().any(|t| t.get(pom_engine::sym!("unscalable")).truthy());
    if scale == 1.0 || unscalable {
        return src.clone();
    }
    let mut scaled = src.clone();
    match &scaled.value {
        Value::Num(v) => scaled.value = Value::Num(scaled_num(*v, scale, scaled.name, scaled.ty)),
        Value::Map(m) => {
            if let Some(Value::Map(inner)) = m.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v) {
                if let Some(new_inner) = scale_nested_mod_map(inner, scale) {
                    let new_outer: Vec<(Sym, Value)> = m.iter().map(|(k, v)| if k.as_str() == "mod" { (*k, Value::Map(std::sync::Arc::new(new_inner.clone()))) } else { (*k, v.clone()) }).collect();
                    scaled.value = Value::Map(std::sync::Arc::new(new_outer));
                }
            }
        }
        _ => {}
    }
    scaled
}

/// `ModStoreClass:ScaleAddList` (Classes/ModStore.lua:99-107): `scale == 1` is a plain copy (no
/// `ScaleAddMod` call at all, so a nested-table `.value` mod passes through untouched in that
/// case, which is the common one - most buffs have `AuraEffect`/`BuffEffect` mods summing to 0).
/// Not a full `ModStore` method here (nothing in this crate's buff/aura port needs the `replace`
/// variant), just the list transform upstream always applies before merging a buff's mods in.
pub fn scale_add_list(mods: &[Mod], scale: f64) -> Vec<Mod> {
    if scale == 1.0 {
        mods.to_vec()
    } else {
        mods.iter().map(|m| scale_mod(m, scale)).collect()
    }
}

/// One `CalcActiveSkill.lua:826-839`-shaped `buff` table entry from a skill's `buffList`, plus the
/// gate booleans `compute_buffs` needs for subsystems this port doesn't model (general skill
/// condition evaluation, party/ally aura sharing) - see `buffprobe::ProbedBuff`'s doc comment,
/// which is the only current source of these (no live skill-building pipeline exists yet).
pub struct SkillBuff {
    pub ty: String,
    pub name: String,
    pub mod_list: Vec<Mod>,
    pub apply_not_player: bool,
    /// `buff.applyMinions` / `buff.applyAllies` (CalcActiveSkill.lua:826-846).
    pub apply_minions: bool,
    pub apply_allies: bool,
    pub allow_totem_buff: bool,
    pub active_skill_buff: bool,
    pub gate_ok: bool,
    pub aura_cannot_affect_self: bool,
    pub allies_auras_cannot_affect_self_flag: bool,
    pub has_party_aura: bool,
    pub party_aura_effect_mult: f64,
    /// `extraAuraModList` (CalcPerform.lua:2447-2459): `ExtraAuraEffect` LIST mods, summed by params.
    pub extra_aura_mods: Vec<Mod>,
    /// `buff.stackVar` / `stackLimit` / `stackLimitVar` (CalcActiveSkill.lua:833-835), read by the Debuff/AuraDebuff branch.
    pub stack_var: Option<String>,
    pub stack_limit: Option<f64>,
    pub stack_limit_var: Option<String>,
}

pub struct SkillBuffs {
    pub is_totem: bool,
    pub buff_list: Vec<SkillBuff>,
    /// `activeSkill.skillCfg` itself (`snapshot::SkillSnapshot.cfg`) - needed because a
    /// `SkillName`/`SkillType`/... tagged conditional mod (a unique item's "X% increased Effect of
    /// Malevolence while affected by it", a mastery's "increased Effect of Non-Curse Auras from
    /// your Skills") silently evaluates to "doesn't match" with no `Cfg` at all (`eval_mod`'s tag
    /// cases all need specific `Cfg` fields to check against). Falls back to `Cfg::default()` when
    /// unavailable, which behaves identically to passing `None` everywhere below (`cfg_triple`
    /// gives the same `(0, 0, None)` triple, and every tag case's own `Option`/`HashMap` field
    /// reads as empty either way) - so this is never itself a source of mismatched filtering.
    pub cfg: Cfg,
}

const BUFF_EFFECT_NAMES: &[&str] = &["BuffEffect", "BuffEffectOnSelf", "BuffEffectOnPlayer"];
const AURA_EFFECT_NAMES: &[&str] = &["AuraEffect", "BuffEffect", "BuffEffectOnSelf", "AuraEffectOnSelf", "AuraBuffEffect", "SkillAuraEffectOnSelf"];

/// The player-self-effect slice of CalcPerform.lua's buff/aura loop (`buff.type == "Buff"` at
/// lines 2318-2333, `"Aura"` at 2461-2477), across every active, non-disabled skill in
/// `env.player.activeSkillList` order (`buffs` is accumulated left-to-right across skills, same as
/// upstream, since `mergeBuff`'s dedup keeps the larger value on a later match rather than
/// unconditionally overwriting - order matters).
///
/// Reproduces the cond/enemyCond gate (CalcPerform.lua:2312-2315, common to every buff type) via
/// `SkillBuff::gate_ok`, and `env.mode_buffs and (not activeSkill.skillFlags.totem or
/// buff.allowTotemBuff)` (2319/2351, Buff/Guard only - Aura's own gate at 2445 has no totem check)
/// via `SkillBuffs::is_totem`/`allow_totem_buff` (`env.mode_buffs` itself is always true for the
/// "MAIN"-mode env this crate grades, so it's not modeled as a separate input). The Aura branch's
/// line-2465 guard (self-buff suppressed only when
/// an ally grants a stronger copy of the same aura) is reproduced from the recorded party-aura
/// state plus this port's own freshly-computed `mult`, matching upstream's own order of
/// evaluation (the ally's *effect* is party data, i.e. an unported subsystem's output as before -
/// the guard's *comparison* against `mult` is this port's own logic on top of it).
///
/// `Guard`-type buffs (CalcPerform.lua:2350-2362) go through the identical self-effect formula as
/// `Buff` (same `BuffEffect`/`BuffEffectOnSelf`/`BuffEffectOnPlayer` names, no name-specific extra
/// term), but land in their own `guards` accumulator first; `guardSlots`' Vaal-priority selection
/// (3317-3336) - "Vaal Molten Shell" alone always wins outright, any other `"Vaal"`-prefixed guard
/// stacks with every other Vaal guard, and at most one non-Vaal guard survives (the first one
/// `pairs(guards)` visits) - runs once after every skill's buffs are collected, and only the
/// selected slots ever reach `buffs`. **`pairs(guards)`' LuaJIT hash order isn't reproduced here**
/// (this crate doesn't model it for a name-keyed table the way `ljhash.rs` does for passive tree
/// nodes) - `guard_slots` below iterates by sorted name instead, a deterministic stand-in that
/// only actually matters when two or more *non-Vaal* guard buffs are active on the same build
/// simultaneously (rare: most builds run at most one guard skill).
///
/// **Not ported**: `Warcry`/`Curse`/`Link`/`GlobalDB` buff types; the Spectre
/// "AllyModifier"/"PlayerModifier" pre-loop mods (CalcPerform.lua:2241-2270); minion/ally/party
/// application and `buffExports` (party-tab export data); the Aura branch's `ExtraAuraEffect`
/// LIST-mod addition and its totem-buff/`AurasAffectEnemies`-debuff sub-branches (2478-2517); a
/// `Guard` buff's own dynamic, runtime-output-dependent mods (Arcane Cloak's `Multiplier:
/// ArcaneCloakConsumedMana`, needing `PerStat`-tag `eval_mod` context this crate doesn't build).
/// A buff whose type isn't `"Buff"`/`"Aura"`/`"Guard"` is skipped outright (never merged into the
/// returned map), so grading against golden's real `buffs` table correctly counts those as
/// not-yet-covered rather than silently matching.
pub fn compute_buffs(player_mod_db: &ModStore, skills: &[(SkillBuffs, ModStore)]) -> indexmap::IndexMap<String, Vec<Mod>> {
    compute_buffs_and_conditions(player_mod_db, skills).0
}

/// `compute_buffs` plus the `modDB.conditions["AffectedBy<BuffName>"]` (and `AffectedByAura`) flags
/// the same buff loop sets as it merges each Buff/Aura (CalcPerform.lua:2324, 2467-2471).
pub fn compute_buffs_and_conditions(player_mod_db: &ModStore, skills: &[(SkillBuffs, ModStore)]) -> (indexmap::IndexMap<String, Vec<Mod>>, Vec<String>) {
    compute_buffs_and_conditions_totem(player_mod_db, skills, false)
}

/// Lua pattern `Resist?M?a?x?$` on a mod name (CalcPerform.lua:2531): "Resis", optional "t", "M", "a", "x", end.
pub fn totem_resist_name(name: &str) -> bool {
    let b = name.as_bytes();
    for start in 0..b.len() {
        if !name[start..].starts_with("Resis") {
            continue;
        }
        let mut i = start + 5;
        for c in [b't', b'M', b'a', b'x'] {
            if i < b.len() && b[i] == c {
                i += 1;
            }
        }
        if i == b.len() {
            return true;
        }
    }
    false
}

/// Same as `compute_buffs_and_conditions`, with `main_is_totem` = `env.player.mainSkill.skillFlags.totem`
/// (adds the totem copy of each Aura's EnergyShield/Armour/Evasion/Resist mods, CalcPerform.lua:2520-2547).
/// Not ported there: the `AffectedBy<aura>` conditions upstream sets on the main skill's own skillModList.
pub fn compute_buffs_and_conditions_totem(player_mod_db: &ModStore, skills: &[(SkillBuffs, ModStore)], main_is_totem: bool) -> (indexmap::IndexMap<String, Vec<Mod>>, Vec<String>) {
    let mut conditions: Vec<String> = Vec::new();
    let sum_names = |names: &[&str]| -> Vec<Sym> { names.iter().map(|n| Sym::new(n)).collect() };
    let buff_effect_names = sum_names(BUFF_EFFECT_NAMES);
    let aura_effect_names = sum_names(AURA_EFFECT_NAMES);

    // `buffs` is visited with `pairs()` (CalcPerform.lua:3344): insertion order.
    let mut buffs: indexmap::IndexMap<String, Vec<Mod>> = indexmap::IndexMap::new();
    let mut guards: HashMap<String, Vec<Mod>> = HashMap::default();
    for (skill, skill_mod_list) in skills {
        let cfg = &skill.cfg;
        for b in &skill.buff_list {
            if !b.gate_ok {
                continue;
            }
            match b.ty.as_str() {
                "Buff" => {
                    // The totem gate (CalcPerform.lua:2319) is Buff/Guard-specific, not shared by
                    // Aura (2445 has no such check) - so it lives in this arm, not the shared one.
                    if (skill.is_totem && !b.allow_totem_buff) || b.apply_not_player {
                        continue;
                    }
                    conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                    let mod_store = if b.active_skill_buff { skill_mod_list } else { player_mod_db };
                    // `local skillCfg = buff.activeSkillBuff and skillCfg` (CalcPerform.lua:2320):
                    // the real per-skill `Cfg` only when `activeSkillBuff`, else falsy (`None`
                    // here) - not this arm's own choice of `mod_store` (skillModList vs modDB),
                    // though the two happen to coincide for every buff this port has seen so far.
                    let buff_cfg = b.active_skill_buff.then_some(cfg);
                    let effect_name = Sym::new(&format!("{}Effect", b.name.replace(' ', "")));
                    let inc = mod_store.sum(ModType::Inc, buff_cfg, &buff_effect_names) + skill_mod_list.sum(ModType::Inc, buff_cfg, &[effect_name]);
                    let more = mod_store.more(buff_cfg, &buff_effect_names[..2]);
                    let mult = (1.0 + inc / 100.0) * more;
                    let src = scale_add_list(&b.mod_list, mult);
                    merge_buff(buffs.entry(b.name.clone()).or_default(), &src);
                }
                "Aura" => {
                    if b.aura_cannot_affect_self {
                        continue;
                    }
                    // The Aura branch always uses the skill's own (real, un-shadowed) `skillCfg`
                    // (CalcPerform.lua:2462-2463), unlike Buff's conditional one above.
                    let inc = skill_mod_list.sum(ModType::Inc, Some(cfg), &aura_effect_names);
                    let more = skill_mod_list.more(Some(cfg), &aura_effect_names);
                    let mult = (1.0 + inc / 100.0) * more;
                    let self_apply_ok = b.allies_auras_cannot_affect_self_flag || !b.has_party_aura || (b.party_aura_effect_mult / 100.0 <= mult);
                    if self_apply_ok {
                        conditions.push("AffectedByAura".to_string());
                        if b.name.starts_with("Vaal") {
                            conditions.push(format!("AffectedBy{}", b.name.chars().skip(5).collect::<String>().replace(' ', "")));
                        }
                        conditions.push(format!("AffectedBy{}", b.name.replace(' ', "")));
                        let mut src = scale_add_list(&b.mod_list, mult);
                        src.extend(scale_add_list(&b.extra_aura_mods, mult));
                        merge_buff(buffs.entry(b.name.clone()).or_default(), &src);
                    }
                    if main_is_totem && !(player_mod_db.flag(None, &[pom_engine::sym!("SelfAurasCannotAffectAllies")]) || player_mod_db.flag(None, &[pom_engine::sym!("SelfAuraSkillsCannotAffectAllies")])) {
                        let inc = skill_mod_list.sum(ModType::Inc, Some(cfg), &sum_names(&["AuraEffect", "BuffEffect", "AuraBuffEffect"]));
                        let more = skill_mod_list.more(Some(cfg), &sum_names(&["AuraEffect", "BuffEffect", "AuraBuffEffect"]));
                        let scale = ((1.0 + inc / 100.0) * more).max(0.0);
                        let mut src: Vec<Mod> = Vec::new();
                        for md in b.extra_aura_mods.iter().chain(b.mod_list.iter()) {
                            let n = md.name.as_str();
                            if n == "EnergyShield" || n == "Armour" || n == "Evasion" || totem_resist_name(n) {
                                let mut tm = md.clone();
                                tm.name = Sym::new(&format!("Totem{n}"));
                                if scale != 1.0 {
                                    if let Value::Num(v) = tm.value {
                                        tm.value = Value::Num(if v.floor() == v { (((v * scale) * 100.0 + 0.5).floor() / 100.0).trunc() } else { v * scale });
                                    }
                                }
                                src.push(tm);
                            }
                        }
                        merge_buff(buffs.entry(format!("Totem {}", b.name)).or_default(), &src);
                    }
                }
                "Guard" => {
                    // Same totem/applyNotPlayer gate as Buff (CalcPerform.lua:2351), same
                    // effect-multiplier formula, just a `guards` accumulator instead of `buffs`
                    // directly - `guardSlots` below decides which of `guards`' entries actually
                    // reach `buffs`.
                    if (skill.is_totem && !b.allow_totem_buff) || b.apply_not_player {
                        continue;
                    }
                    let mod_store = if b.active_skill_buff { skill_mod_list } else { player_mod_db };
                    let buff_cfg = b.active_skill_buff.then_some(cfg);
                    let inc = mod_store.sum(ModType::Inc, buff_cfg, &buff_effect_names);
                    let more = mod_store.more(buff_cfg, &buff_effect_names[..2]);
                    let mult = (1.0 + inc / 100.0) * more;
                    let src = scale_add_list(&b.mod_list, mult);
                    merge_buff(guards.entry(b.name.clone()).or_default(), &src);
                }
                // Curses are handled in `perform_curses.rs`, not this
                // branch's - CalcPerform.lua's own curse handling (roughly 2660-2750, a
                // `curseSlots`/priority selection distinct from `buffs`) is deliberately not
                // ported here. `perform_curses.rs` isn't on master yet (checked this session), so
                // there's nothing to call into; once it lands, this arm is where a real call
                // belongs (curses never merge into this function's own `buffs` map the way
                // Buff/Aura do, so it likely needs its own return path, not a `buffs` entry).
                "Curse" => {}
                _ => {}
            }
        }
    }

    // `guardSlots` (CalcPerform.lua:3317-3340): see this function's own doc comment for the
    // sorted-name substitute for LuaJIT's `pairs(guards)` order.
    let mut guard_names: Vec<&String> = guards.keys().collect();
    guard_names.sort();
    let mut guard_slots: Vec<&String> = Vec::new();
    for name in guard_names {
        if name == "Vaal Molten Shell" {
            guard_slots.clear();
            guard_slots.push(name);
            break;
        } else if name.starts_with("Vaal") {
            guard_slots.push(name);
        } else if guard_slots.iter().all(|s| s.starts_with("Vaal")) {
            guard_slots.push(name);
        }
    }
    for name in guard_slots {
        let mod_list = guards.get(name).cloned().unwrap_or_default();
        merge_buff(buffs.entry(name.clone()).or_default(), &mod_list);
    }
    (buffs, conditions)
}

/// `calcs.perform`'s shape. Returns `Err` unconditionally: a real implementation needs the
/// pieces named in the module doc above (minion skills, buffs/auras/curses/charges/reservations,
/// attributes) before it can produce a real `Output`, none of which exist yet.
pub fn perform_stub() -> Result<(), &'static str> {
    Err("CalcPerform not ported; see crates/calc/src/perform.rs module doc for the traced call order")
}
