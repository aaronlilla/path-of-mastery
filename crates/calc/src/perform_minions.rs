//! Two independent pieces of `calcs.perform`'s minion handling, ported by separate sessions and
//! kept side by side in this one file (both are named "perform_minions" in their own branch):
//!
//! 1. **Minion actor setup**: `initMinionModDB` (Modules/CalcPerform.lua:1154-1244, called once
//!    per Perform pass at line 1320 for `env.player.mainSkill`'s minion, gated by `if env.minion
//!    then`) and `addMinionModifiers` (lines 1247-1253, called from the "Apply buff/debuff
//!    modifiers" loop at line 3350 for every buff the player actor picked up this pass). Together
//!    these are "the parts of Perform that run for the minion actor": building the minion's own
//!    `ModStore` from its static minion-type data plus whatever the player/its items/its granting
//!    skill hands it, then folding in the player's own buffs that carry a `MinionModifier` LIST
//!    mod. Graded in isolation by the answer-key grader's minion section: a probe pair at
//!    `initMinionModDB`'s first and last line records the exact inputs this function reads and the
//!    resulting `minion.modDB` mod list, fed straight into `init_minion_mod_db` and compared as a
//!    multiset (same technique as `perform.rs`'s attribute-bonus/flask grading).
//!
//!    Not re-derived here, taken as recorded probe input instead (each is a self-contained item/
//!    skill-plumbing concern, not "minion setup" logic in its own right - same principle
//!    `perform.rs`'s `merge_flask_mods` uses for flask item mods): `activeSkill.extraSkillModList`,
//!    the Aegis/Iron Mass mod lists, the player's Weapon 1/Weapon 2/Gloves item mod lists, and the
//!    resolved per-slot mod lists a minion with `itemSet`/`uses` (Animate Guardian, some spectres)
//!    borrows from the player's equipped gear (CalcPerform.lua:1222-1240's `env.build.itemsTab.slots`
//!    walk) - this crate's `items` module already exposes per-slot item mods elsewhere; only the
//!    *conditions* deciding whether/how each list gets folded in are ported below, faithfully.
//!
//! 2. **Per-actually-summoned-minion counting**: the counting block of `calcs.perform`'s main skill
//!    loop (CalcPerform.lua:1436-1506), plus the one condition it sets outside that block
//!    (`Condition:HaveDamageableMinion`, lines 1461-1463) - the only pieces of that ~1000-line loop
//!    that are Condition/Multiplier bookkeeping rather than buffs/auras/curses/flasks (a different
//!    scope from part 1 above: this is about *how many* minions exist and what `Multiplier`s that
//!    produces, not about building any one minion's own `ModStore`). Graded in isolation by
//!    the answer-key grader against the recorded post-Perform player mod list
//!    (`Multiplier:SummonedMinion` etc., `Condition:HaveDamageableMinion`) and
//!    `player.conditions["OnlyMinion"]`.
//!
//!    Named gaps: everything else in that loop (banner/warcry/exposure/curse-doom/Skitterbot/
//!    guaranteed-chill bookkeeping, lines 1300-1490 besides the minion-count block) is out of scope
//!    here. `activeSkill.minionList`/`activeEffect.grantedEffect` is resolved the same way
//!    `perform_reserve` resolves a skill's `GrantedEffect` (by `gem.grantedEffectId`); a skill
//!    whose recorded `gem` doesn't resolve is
//!    skipped, same as the reservation port.
use crate::data::{self, CharacterConstants, MinionData};
use crate::snapshot::SkillSnapshot;
use crate::modbuild::{actor_cond, cond, m, mf, mfk, mt};
use crate::perform_reserve::clone_store;
use crate::setup::init_mod_db;
use crate::skills::granted_effect_by_id;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modparser::flags::{keyword_flag as kf, mod_flag as mf_};
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;
use std::sync::{Arc, OnceLock};

/// `round(val)` with no decimal argument (Modules/Common.lua:709): `floor(val + 0.5)`.
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `ModStore:ScaleAddMod(mod, scale)` (Classes/ModStore.lua:56-91), the one call site this crate
/// needs (`initMinionModDB`'s Widowhail quiver-mod scaling, CalcPerform.lua:1213). Only the
/// numeric-value case matters for any mod a quiver can carry, so LIST/table-valued mods are not
/// handled (`AddMod` unscaled, matching upstream's `scaledMod.value.mod`/`keyOfScaledMod`
/// branches only ever firing for effect-list mods, never plain item mods). Replicates a genuine
/// original quirk: when the mod isn't in `data.highPrecisionMods` and its pre-scale value is a
/// whole number, the "precision" branch is skipped and `subMod.value = m_modf(round(value*scale,
/// 2))` keeps only `math.modf`'s *first* return (the truncated integer part), silently discarding
/// the rounded value's fractional part - so e.g. a flat 15 scaled by 1.3 becomes 19, not 19.5.
fn scale_add_mod(store: &mut ModStore, src: &Mod, scale: f64) {
    let unscalable = src.tags.iter().any(|t| t.get(pom_engine::sym!("unscalable")).truthy());
    if scale == 1.0 || unscalable {
        store.add_mod(src.clone());
        return;
    }
    let mut scaled = src.clone();
    if let Value::Num(v) = scaled.value {
        let scaled_v = v * scale;
        scaled.value = Value::Num(match data::mod_precision(src.name.as_str(), src.ty.as_str(), v) {
            Some(p) => {
                let power = 10f64.powi(p);
                (scaled_v * power).floor() / power
            }
            None => {
                let r = (scaled_v * 100.0 + 0.5).floor() / 100.0; // rounds to two decimals
                r.trunc() // math.modf(r)'s first return only - see doc comment above
            }
        });
    }
    store.add_mod(scaled);
}

/// Every input `initMinionModDB` reads beyond the minion's own static `data.minions[type]` entry
/// (already loaded from `minion_type` via `crate::data::minion_data`) and the player's `ModStore`
/// (flags/sums it reads directly). Field-by-field provenance is in each call site's own comment
/// in `init_minion_mod_db` below.
pub struct MinionInput {
    pub minion_type: String,
    pub level: f64,
    pub is_spectre: bool,
    pub enemy_level: f64,
    pub extra_skill_mod_list: Vec<Mod>,
    pub aegis_mod_list: Option<Vec<Mod>>,
    pub iron_mass_mod_list: Option<Vec<Mod>>,
    pub minion_use_bow_and_quiver: bool,
    pub minion_use_main_hand_weapon: bool,
    pub weapon1_is_bow: bool,
    pub weapon1_slot_mod_list: Vec<Mod>,
    pub weapon2_is_quiver: bool,
    pub weapon2_mod_list: Vec<Mod>,
    pub gloves_mod_list: Option<Vec<Mod>>,
    /// The already-resolved per-slot mod lists `minion.itemList[slotName] = item` /
    /// `minion.modDB:AddList(item.modList or item.slotModList[slot.slotNum])` would have picked
    /// up for a minion with `itemSet` or `uses` set (CalcPerform.lua:1222-1240) - one entry per
    /// slot the minion actually uses, already filtered to the relevant `minion.uses`/`itemSet`
    /// selection. Empty when the minion has neither (the common case).
    pub borrowed_slot_mod_lists: Vec<Vec<Mod>>,
}

/// The handful of reads `initMinionModDB` makes against the player's own `ModStore` (`env.modDB`
/// in upstream), taken as already-resolved scalars/booleans rather than a full `ModStore` -
/// this function's actual subject is the minion's own mod-store construction, not re-deriving the
/// player's stats (out of scope, same principle as `MinionInput`'s borrowed item mod lists; see
/// module doc).
pub struct PlayerReads {
    /// `modDB:Flag(nil, "MinionAccuracyEqualsAccuracy")`.
    pub minion_accuracy_equals_accuracy: bool,
    /// `calcLib.val(modDB, "Accuracy")`.
    pub accuracy_val: f64,
    /// `calcLib.val(modDB, "Dex")`.
    pub dex_val: f64,
    /// `modDB:Override(nil, "DexAccBonusOverride")`.
    pub dex_acc_bonus_override: Option<f64>,
    /// `modDB:Sum("BASE", nil, "StrengthAddedToMinions")`.
    pub strength_added_to_minions: f64,
    /// `calcLib.val(modDB, "Str")` (only read when `strength_added_to_minions > 0`).
    pub str_val: f64,
    /// `modDB:Flag(nil, "BlinkAndMirrorUseGloves")`.
    pub blink_and_mirror_use_gloves: bool,
    /// `modDB:Sum("BASE", nil, "WidowHailMultiplier")`.
    pub widow_hail_multiplier: f64,
}

/// `initMinionModDB(env, activeSkill, output)` (CalcPerform.lua:1154-1244), minus the `output`/
/// `minion.itemList["Weapon 3"]` bookkeeping (not mod-store state). Returns the minion's freshly
/// built `ModStore` (`minion.modDB`).
pub fn init_minion_mod_db(player: &PlayerReads, cc: &CharacterConstants, input: &MinionInput) -> ModStore {
    let md: &MinionData = data::minion_data(&input.minion_type);
    let mut store = ModStore::new_list(None, None);
    store.multipliers.insert(pom_engine::sym!("Level"), input.level); // minion.modDB.multipliers["Level"] = minion.level

    // calcs.initModDB(env, minion.modDB): the same base stat-cap/condition mods every actor gets.
    let mode = crate::setup::buff_mode();
    let base = init_mod_db(cc, mode.buffs, mode.combat, mode.effective);
    for mm in base.mods {
        store.add_mod(mm);
    }
    for (name, value) in base.conditions {
        store.conditions.insert(Sym::new(name), value);
    }

    // local baseLife = minion.lifeTable[minion.level] * minion.minionData.life; hostile scales by
    // env.data.mapLevelLifeMult[env.enemyLevel]. lifeTable itself is chosen from purely static
    // data (CalcActiveSkill.lua:724-728): hostile -> monsterLifeTable; else AltLife1/AltLife2 ->
    // monsterLifeTable2/3; else spectre -> monsterLifeTable; else monsterAllyLifeTable.
    let life_table_val = if md.hostile {
        data::monster_life_table(input.level)
    } else {
        match md.life_scaling.as_deref() {
            Some("AltLife1") => data::monster_life_table2(input.level),
            Some("AltLife2") => data::monster_life_table3(input.level),
            _ if input.is_spectre => data::monster_life_table(input.level),
            _ => data::monster_ally_life_table(input.level),
        }
    };
    let mut base_life = life_table_val * md.life;
    if md.hostile {
        base_life *= data::map_level_life_mult(input.enemy_level);
    }
    store.add_mod(m("Life", ModType::Base, base_life.floor(), "Base"));

    // if minion.minionData.energyShield then ... esTable = minion.hostile and minion.lifeTable or
    // env.data.monsterAllyLifeTable (note: NOT the same AltLife/spectre-aware choice as baseLife
    // above for a non-hostile minion - always monsterAllyLifeTable there, a genuine original quirk).
    if let Some(es_mult) = md.energy_shield {
        let es_table_val = if md.hostile { life_table_val } else { data::monster_ally_life_table(input.level) };
        let mut base_es = es_table_val * md.life * es_mult;
        if md.hostile {
            base_es *= data::map_level_life_mult(input.enemy_level);
        }
        store.add_mod(m("EnergyShield", ModType::Base, base_es.floor(), "Base"));
    }

    store.add_mod(m("Armour", ModType::Base, round(data::monster_armour_table(input.level) * md.armour.unwrap_or(1.0)), "Base"));
    store.add_mod(m("Evasion", ModType::Base, round(data::monster_evasion_table(input.level) * md.evasion.unwrap_or(1.0)), "Base"));

    if player.minion_accuracy_equals_accuracy {
        let per_dex = player.dex_acc_bonus_override.unwrap_or_else(data::accuracy_per_dex_base);
        store.add_mod(m("Accuracy", ModType::Base, player.accuracy_val + player.dex_val * per_dex, "Player"));
    } else {
        store.add_mod(Mod { name: pom_engine::sym!("CannotBeEvaded"), ty: ModType::Flag, value: Value::Num(1.0), flags: 0, keyword_flags: 0, source: Some("Minion Attacks always hit".into()), tags: (vec![]).into() });
    }

    store.add_mod(m("CritMultiplier", ModType::Base, data::monster_constant("base_critical_strike_multiplier") - 100.0, "Base"));
    store.add_mod(mt("DotMultiplier", ModType::Base, data::monster_constant("critical_ailment_dot_multiplier_+"), "Base", vec![cond("CriticalStrike")]));
    store.add_mod(m("FireResist", ModType::Base, md.fire_resist, "Base"));
    store.add_mod(m("ColdResist", ModType::Base, md.cold_resist, "Base"));
    store.add_mod(m("LightningResist", ModType::Base, md.lightning_resist, "Base"));
    store.add_mod(m("ChaosResist", ModType::Base, md.chaos_resist, "Base"));
    store.add_mod(mt("CritChance", ModType::Inc, data::monster_constant("critical_strike_chance_+%_per_power_charge"), "Base", vec![crate::modbuild::mult("PowerCharge")]));
    store.add_mod(mf("Speed", ModType::Inc, data::monster_constant("base_attack_speed_+%_per_frenzy_charge"), "Base", mf_::Attack, vec![crate::modbuild::mult("FrenzyCharge")]));
    store.add_mod(mf("Speed", ModType::Inc, data::monster_constant("base_cast_speed_+%_per_frenzy_charge"), "Base", mf_::Cast, vec![crate::modbuild::mult("FrenzyCharge")]));
    store.add_mod(mt("Damage", ModType::More, data::monster_constant("object_inherent_damage_+%_final_per_frenzy_charge"), "Base", vec![crate::modbuild::mult("FrenzyCharge")]));
    store.add_mod(mt("PhysicalDamageReduction", ModType::Base, data::monster_constant("physical_damage_reduction_%_per_endurance_charge"), "Base", vec![crate::modbuild::mult("EnduranceCharge")]));
    store.add_mod(mt("ElementalDamageReduction", ModType::Base, data::monster_constant("elemental_damage_reduction_%_per_endurance_charge_if_player_minion"), "Base", vec![crate::modbuild::mult("EnduranceCharge")]));
    store.add_mod(m("ProjectileCount", ModType::Base, 1.0, "Base"));
    store.add_mod(m("MaximumFortification", ModType::Base, data::monster_constant("base_max_fortification"), "Base"));
    store.add_mod(mfk("Damage", ModType::More, 200.0, "Base", 0, kf::Bleed, vec![actor_cond("enemy", "Moving")]));

    for mm in &md.mod_list {
        store.add_mod(mm.clone());
    }
    for mm in &input.extra_skill_mod_list {
        store.add_mod(mm.clone());
    }
    if let Some(aegis) = &input.aegis_mod_list {
        for mm in aegis {
            store.add_mod(mm.clone());
        }
    }
    if input.minion_type == "RaisedSkeleton" {
        if let Some(iron_mass) = &input.iron_mass_mod_list {
            for mm in iron_mass {
                store.add_mod(mm.clone());
            }
        }
    }
    if input.minion_use_bow_and_quiver {
        if input.weapon1_is_bow {
            for mm in &input.weapon1_slot_mod_list {
                store.add_mod(mm.clone());
            }
        }
        if input.weapon2_is_quiver {
            let scale = player.widow_hail_multiplier.max(1.0);
            for mm in &input.weapon2_mod_list {
                scale_add_mod(&mut store, mm, scale);
            }
        }
        if player.blink_and_mirror_use_gloves {
            if let Some(gloves) = &input.gloves_mod_list {
                for mm in gloves {
                    store.add_mod(mm.clone());
                }
            }
        }
    }
    if input.minion_use_main_hand_weapon {
        for mm in &input.weapon1_slot_mod_list {
            store.add_mod(mm.clone());
        }
    }
    for slot_mods in &input.borrowed_slot_mod_lists {
        for mm in slot_mods {
            store.add_mod(mm.clone());
        }
    }

    if player.strength_added_to_minions > 0.0 {
        store.add_mod(m("Str", ModType::Base, round(player.str_val * player.strength_added_to_minions / 100.0), "Player"));
    }

    store
}

/// `addMinionModifiers(modList, skillCfg, minion)` (CalcPerform.lua:1247-1253): every
/// `MinionModifier` LIST mod in `mod_list` (a buff's mod list, `env.buffs[name]` at the call site)
/// whose own `.type` tag is absent or matches this minion's own type gets its wrapped `.mod`
/// added to the minion's `ModStore` directly.
pub fn add_minion_modifiers(store: &mut ModStore, mod_list: &[Mod], minion_type: &str) {
    for entry in mod_list {
        if entry.name.as_str() != "MinionModifier" || entry.ty != ModType::List {
            continue;
        }
        let Value::Map(map) = &entry.value else { continue };
        let ty_matches = match map.iter().find(|(k, _)| k.as_str() == "type") {
            Some((_, Value::Str(s))) => s.as_ref() == minion_type,
            Some((_, Value::Nil)) | None => true,
            _ => true,
        };
        if !ty_matches {
            continue;
        }
        if let Some((_, Value::Map(inner))) = map.iter().find(|(k, _)| k.as_str() == "mod") {
            store.add_mod(map_to_mod(inner));
        }
    }
}

/// Reconstructs a `Mod` from the `Value::Map` shape a `MinionModifier`/`PlayerModifier` LIST
/// mod's `.mod` field parses into (same field names as `Mod` itself: name/type/value/flags/
/// keywordFlags/source/tags, minus positional-tag reconstruction - a wrapped mod's own tags are
/// not read by any minion-buff call site this crate ports yet).
fn map_to_mod(map: &[(Sym, Value)]) -> Mod {
    let get = |k: &str| map.iter().find(|(mk, _)| mk.as_str() == k).map(|(_, v)| v.clone());
    let name = match get("name") {
        Some(Value::Str(s)) => Sym::new(&s),
        _ => pom_engine::sym!(""),
    };
    let ty = match get("type") {
        Some(Value::Str(s)) => ModType::parse(&s).unwrap_or(ModType::Base),
        _ => ModType::Base,
    };
    let value = get("value").unwrap_or(Value::Nil);
    let flags = match get("flags") {
        Some(Value::Num(n)) => n as u64,
        _ => 0,
    };
    let keyword_flags = match get("keywordFlags") {
        Some(Value::Num(n)) => n as u64,
        _ => 0,
    };
    let source = match get("source") {
        Some(Value::Str(s)) => Some(s),
        _ => None,
    };
    Mod { name, ty, value, flags, keyword_flags, source, tags: (vec![]).into() }
}

// ===== Probe-based grading =====
// The probe pair brackets `initMinionModDB` in full ("minion_in" at line 1155, its first line;
// "minion_out" at line 1244, its closing `end`). See
// this crate's `probe.rs`.

fn jstr(v: &J, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn jf64(v: &J, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn jbool(v: &J, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn jmods(v: &J, k: &str) -> Vec<Mod> {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().map(crate::snapshot::parse_mod).collect()).unwrap_or_default()
}
fn jmod_lists(v: &J, k: &str) -> Vec<Vec<Mod>> {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().map(|l| l.as_array().map(|a2| a2.iter().map(crate::snapshot::parse_mod).collect()).unwrap_or_default()).collect()).unwrap_or_default()
}

fn parse_minion_input(v: &J) -> MinionInput {
    MinionInput {
        minion_type: jstr(v, "minionType"),
        level: jf64(v, "level"),
        is_spectre: jbool(v, "isSpectre"),
        enemy_level: jf64(v, "enemyLevel"),
        extra_skill_mod_list: jmods(v, "extraSkillModList"),
        aegis_mod_list: if v.get("aegisModList").map(|x| x.is_null()).unwrap_or(true) { None } else { Some(jmods(v, "aegisModList")) },
        iron_mass_mod_list: if v.get("ironMassModList").map(|x| x.is_null()).unwrap_or(true) { None } else { Some(jmods(v, "ironMassModList")) },
        minion_use_bow_and_quiver: jbool(v, "minionUseBowAndQuiver"),
        minion_use_main_hand_weapon: jbool(v, "minionUseMainHandWeapon"),
        weapon1_is_bow: jbool(v, "weapon1IsBow"),
        weapon1_slot_mod_list: jmods(v, "weapon1ModList"),
        weapon2_is_quiver: jbool(v, "weapon2IsQuiver"),
        weapon2_mod_list: jmods(v, "weapon2ModList"),
        gloves_mod_list: if v.get("glovesModList").map(|x| x.is_null()).unwrap_or(true) { None } else { Some(jmods(v, "glovesModList")) },
        borrowed_slot_mod_lists: jmod_lists(v, "borrowedSlotModLists"),
    }
}

fn parse_player_reads(v: &J) -> PlayerReads {
    PlayerReads {
        minion_accuracy_equals_accuracy: jbool(v, "minionAccuracyEqualsAccuracy"),
        accuracy_val: jf64(v, "accuracyVal"),
        dex_val: jf64(v, "dexVal"),
        dex_acc_bonus_override: v.get("dexAccBonusOverride").and_then(|x| x.as_f64()),
        strength_added_to_minions: jf64(v, "strengthAddedToMinions"),
        str_val: jf64(v, "strVal"),
        blink_and_mirror_use_gloves: jbool(v, "blinkAndMirrorUseGloves"),
        widow_hail_multiplier: jf64(v, "widowHailMultiplier"),
    }
}

fn mods_equal(a: &Mod, b: &Mod) -> bool {
    fn value_close(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Nil, Value::Nil) => true,
            (Value::Bool(x), Value::Bool(y)) => x == y,
            (Value::Str(x), Value::Str(y)) => x == y,
            (Value::Num(x), Value::Num(y)) => (x.is_nan() && y.is_nan()) || (x - y).abs() <= 1e-6 * x.abs().max(y.abs()).max(1.0),
            (Value::List(x), Value::List(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|(xi, yi)| value_close(xi, yi)),
            (Value::Map(x), Value::Map(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|((kx, vx), (ky, vy))| kx == ky && value_close(vx, vy)),
            _ => false,
        }
    }
    a.name == b.name && a.ty == b.ty && a.flags == b.flags && a.keyword_flags == b.keyword_flags && a.source == b.source && value_close(&a.value, &b.value)
}
fn match_multiset(want: &[Mod], have: &[Mod]) -> (usize, Vec<Mod>, Vec<Mod>) {
    let mut pool: Vec<Mod> = have.to_vec();
    let mut matched = 0;
    let mut missing = Vec::new();
    for w in want {
        if let Some(pos) = pool.iter().position(|h| mods_equal(w, h)) {
            pool.remove(pos);
            matched += 1;
        } else {
            missing.push(w.clone());
        }
    }
    (matched, missing, pool)
}

/// Grades `init_minion_mod_db` against every `minion_in`/`minion_out` probe pair in `path`
/// (one pair per `calcs.perform` call that had `env.minion` set - MAIN-mode passes and every
/// FullDPS/tooltip pass alike). Returns a "matched N/total" report.
pub fn grade_from_probe_file(path: &std::path::Path) -> String {
    use std::fmt::Write as _;
    let mut report = String::new();
    let ins = crate::probe::load_probe(path, "minion_in");
    let outs = crate::probe::load_probe(path, "minion_out");
    let cc = CharacterConstants::load();
    let mut total = 0usize;
    let mut matched = 0usize;
    let mut want_total = 0usize;
    let mut perfect = 0usize;
    let mut first_misses: Vec<String> = Vec::new();
    for (key, vin) in &ins {
        let Some(vout) = outs.get(key) else { continue };
        total += 1;
        let input = parse_minion_input(vin);
        let player = parse_player_reads(vin);
        let have = init_minion_mod_db(&player, &cc, &input);
        let have_mods: Vec<Mod> = match &have.backing {
            pom_engine::modstore::store::Backing::List(v) => v.to_vec(),
            pom_engine::modstore::store::Backing::Db(map) => map.values().flatten().cloned().collect(),
        };
        let want = jmods(vout, "mods");
        let (m, missing, extra) = match_multiset(&want, &have_mods);
        matched += m;
        want_total += want.len();
        if missing.is_empty() && extra.is_empty() {
            perfect += 1;
        } else if first_misses.len() < 40 {
            for w in missing.iter().take(5) {
                first_misses.push(format!("{}#{} ({}): MISSING {} {:?} = {:?} src={:?}", key.0, key.1, input.minion_type, w.name.as_str(), w.ty, w.value, w.source));
            }
            for e in extra.iter().take(5) {
                first_misses.push(format!("{}#{} ({}): EXTRA (golden has, port doesn't) {} {:?} = {:?} src={:?}", key.0, key.1, input.minion_type, e.name.as_str(), e.ty, e.value, e.source));
            }
        }
    }
    let _ = writeln!(report, "minions (probe-graded): {total} calcs.perform passes with a minion_in/minion_out pair");
    let _ = writeln!(report, "minions: mods matched {matched}/{want_total} ({perfect}/{total} passes byte-for-byte perfect)");
    if !first_misses.is_empty() {
        let _ = writeln!(report, "\nfirst mismatches (minions):");
        for l in first_misses.iter().take(40) {
            let _ = writeln!(report, "  {l}");
        }
    }
    report
}

// ===== Per-actually-summoned-minion counting =====

const SKILL_TYPE_VAAL: i64 = 38;
const SKILL_TYPE_CREATES_MINION: i64 = 77;
const SKILL_TYPE_MINIONS_ARE_UNDAMAGABLE: i64 = 117;

struct MinionInfo {
    hostile: bool,
    limit: Option<String>,
}

/// `data.minions` (`data_minions.json`), keyed by minion type name - loaded once from
/// `GameData::extra` (untyped section, see `crate::data`).
fn minions_data() -> &'static HashMap<String, MinionInfo> {
    static M: OnceLock<HashMap<String, MinionInfo>> = OnceLock::new();
    M.get_or_init(|| {
        let mut out = HashMap::default();
        // `data.minions`, then `data.spectres` merged into it (Data.lua:1155-1160, each with `limit = "ActiveSpectreLimit"`)
        for section in ["minions", "spectres"] {
            if let Some(obj) = crate::data::game_data().extra.get(section).ok().flatten().and_then(|j| j.as_object()) {
                for (k, v) in obj {
                    let hostile = v.get("hostile").and_then(|x| x.as_bool()).unwrap_or(false);
                    let limit = v.get("limit").and_then(|x| x.as_str()).map(|s| s.to_string());
                    out.insert(k.to_string(), MinionInfo { hostile, limit });
                }
            }
        }
        out
    })
}

/// `activeEffect.grantedEffect.minionList` - an untyped field on `GrantedEffect` (list of minion
/// type names, e.g. `AnimateGuardian`'s `["AnimatedArmour"]`).
fn minion_list(ge: &pom_engine::data::gems::GrantedEffect) -> Vec<String> {
    ge.extra.get("minionList").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

#[derive(Default)]
struct Counts {
    total: f64,
    non_vaal: Option<f64>,
    permanent: Option<f64>,
}

pub struct MinionModsResult {
    /// `(name, value)` pairs for `Multiplier:SummonedMinion`/`Multiplier:NonVaalSummonedMinion`/
    /// `Multiplier:PermanentMinion`, one per distinct limit/grantedEffect key that produced a
    /// minion count (CalcPerform.lua:1491-1501) - each is its own separate `NewMod` call in the
    /// original, so multiple entries can share a name.
    pub multiplier_mods: Vec<(&'static str, f64)>,
    pub summoned_minions_total: f64,
    /// `modDB.conditions["OnlyMinion"]` (CalcPerform.lua:1506). `env.configInput.multiplierSummonedMinion`
    /// (the Companionship config override) is applied when non-zero, matching upstream.
    pub only_minion: bool,
    /// Every active, non-disabled skill with `SkillType.CreatesMinion` and not
    /// `SkillType.MinionsAreUndamagable` sets this (CalcPerform.lua:1461-1463) - `true` iff at
    /// least one such skill exists, since upstream just adds the same FLAG mod repeatedly.
    pub have_damageable_minion: bool,
    /// `output[minionData.limit] = max(count, output[minionData.limit] or 0)` (CalcPerform.lua:1447),
    /// e.g. `ActiveGolemLimit`: read back by `PerStat` mods ("per Summoned Golem").
    pub limit_outputs: HashMap<String, f64>,
}

/// `config_summoned_minion_override`: `env.configInput.multiplierSummonedMinion` for this build (0
/// or absent means "no override", matching the Lua's `~= 0 and ... or nil`).
pub fn compute_minion_mods(player_store: &ModStore, skills: &[SkillSnapshot], config_summoned_minion_override: Option<f64>) -> MinionModsResult {
    compute_minion_mods_with_lists(player_store, skills, config_summoned_minion_override, None)
}

/// As `compute_minion_mods`, with each skill's `activeSkill.minionList` (parallel to `skills`) when the caller has it:
/// a Raise Spectre's list is the build's spectre list, not the granted effect's empty one.
pub fn compute_minion_mods_with_lists(player_store: &ModStore, skills: &[SkillSnapshot], config_summoned_minion_override: Option<f64>, minion_lists: Option<&[Vec<String>]>) -> MinionModsResult {
    let player_arc = Arc::new(clone_store(player_store));
    let mut counts: HashMap<String, Counts> = HashMap::default();
    let mut have_damageable_minion = false;
    let mut limit_outputs: HashMap<String, f64> = HashMap::default();

    for (skill_idx, skill) in skills.iter().enumerate() {
        let disabled = skill.skill_flags.get("disable").copied().unwrap_or(false);

        if skill.skill_types.contains(&SKILL_TYPE_CREATES_MINION) && !skill.skill_types.contains(&SKILL_TYPE_MINIONS_ARE_UNDAMAGABLE) {
            have_damageable_minion = true;
        }

        if disabled {
            continue;
        }
        let Some(gem) = &skill.gem else { continue };
        let Some(ge_id) = &gem.granted_effect_id else { continue };
        let Some(ge) = granted_effect_by_id(ge_id) else { continue };
        let minion_types = match minion_lists { Some(l) => l[skill_idx].clone(), None => minion_list(ge) };
        if minion_types.is_empty() {
            continue;
        }

        let mut skill_store = ModStore::new_list(Some(Arc::clone(&player_arc)), None);
        for m in &skill.skill_mod_list {
            skill_store.add_mod(m.clone());
        }
        let is_vaal = skill.skill_types.contains(&SKILL_TYPE_VAAL);
        let is_permanent = skill.skill_flags.get("permanentMinion").copied().unwrap_or(false);

        for minion_type in &minion_types {
            let Some(info) = minions_data().get(minion_type) else { continue };
            if info.hostile {
                continue;
            }
            let key = info.limit.clone().unwrap_or_else(|| format!("{}:{}", ge.id.as_deref().unwrap_or(ge_id), minion_type));
            let count = if let Some(limit) = &info.limit {
                let override_val = player_store.override_(None, &[Sym::new(limit)]).and_then(|v| v.num());
                override_val.unwrap_or_else(|| crate::tools::val(&skill_store, Sym::new(limit), None) * skill_store.more(None, &[pom_engine::sym!("ActiveMinionLimit")])).floor()
            } else {
                1.0
            };

            if let Some(limit) = &info.limit {
                let cur = limit_outputs.entry(limit.clone()).or_insert(0.0);
                *cur = cur.max(count);
            }
            let entry = counts.entry(key).or_default();
            entry.total = entry.total.max(count);
            if !is_vaal {
                entry.non_vaal = Some(entry.non_vaal.unwrap_or(0.0).max(count));
            }
            if is_permanent {
                entry.permanent = Some(entry.permanent.unwrap_or(0.0).max(count));
            }
        }
    }

    let mut multiplier_mods = Vec::new();
    let mut summoned_minions_total = 0.0;
    for c in counts.values() {
        summoned_minions_total += c.total;
        multiplier_mods.push(("Multiplier:SummonedMinion", c.total));
        if let Some(v) = c.non_vaal {
            multiplier_mods.push(("Multiplier:NonVaalSummonedMinion", v));
        }
        if let Some(v) = c.permanent {
            multiplier_mods.push(("Multiplier:PermanentMinion", v));
        }
    }

    let effective = match config_summoned_minion_override {
        Some(v) if v != 0.0 => v,
        _ => summoned_minions_total,
    };
    let only_minion = effective == 1.0;

    MinionModsResult { multiplier_mods, summoned_minions_total, only_minion, have_damageable_minion, limit_outputs }
}
