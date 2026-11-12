//! Skill life/mana reservation (Modules/CalcPerform.lua:1967-2092, `doActorLifeManaReservation` at
//! lines 551-584) plus the small `doActorLifeMana` (lines 69-133) prerequisite it needs for
//! `output.Life`/`output.Mana` - that function isn't itself in this file's ported scope (it's
//! CalcPerform's general Life/Mana pool calc, shared with Defence), but reservation can't produce
//! a real `Unreserved`/`Reserved` split without it, so a minimal copy lives here as `life_mana_pool`
//! rather than widening scope into another crate area. Graded in isolation by the answer-key grader
//! against the recorded `output_player` scalar map.
//!
//! Named gaps (documented, not silently dropped):
//! - `env.partyMembers`/multi-instance skill state, `activeSkill.activeMineCount` (mine-count
//!   reservation multiplier) and Blood Sacrament's per-stage multiplier: none of the recorded
//!   `SkillSnapshot` data (name/skillFlags/skillTypes/skillModList/gem) carries mine counts,
//!   channelled stage counts, or `skillData` overrides, so these are not applied.
//! - `activeSkill.skillData.triggeredByAutoexertion` (an alternate gate into this loop besides
//!   `SkillType.HasReservation`): `skillData` isn't recorded either; only the `HasReservation`/
//!   `ReservationBecomesCost` skill-type gate and `skillFlags.disable` are checked.
//! - `GrantReserved{Life,Mana}AsAura` (CalcPerform.lua:576-581): adds an `ExtraAura` LIST mod that
//!   feeds the (separately-owned) aura pipeline - not emitted here to avoid double-producing aura
//!   input mods across the two in-flight ports of this crate.
use crate::skills::granted_effect_by_id;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::Backing;
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;
use std::sync::Arc;

fn sym(s: &str) -> Sym {
    Sym::new(s)
}

/// `floor(val, dec)` (Modules/Common.lua:721-727): floor to `dec` decimal places, with a `0.0001`
/// epsilon nudge before flooring (guards against float representation putting an exact multiple
/// just under the target, e.g. `2.9999999996`).
fn floor_dec(val: f64, dec: i32) -> f64 {
    let mult = 10f64.powi(dec);
    (val * mult + 0.0001).floor() / mult
}

/// `round(val, dec)` (Modules/Common.lua:709-715).
fn round_dec(val: f64, dec: i32) -> f64 {
    let mult = 10f64.powi(dec);
    (val * mult + 0.5).floor() / mult
}

/// `math.modf(x)`'s first return value used standalone (`local baseFlatVal = m_modf(...)`):
/// truncation toward zero, not `floor` (matters for negative reservation-reducing mods).
fn trunc0(x: f64) -> f64 {
    x.trunc()
}

/// Deep-copies a `ModStore`'s mods/conditions/multipliers into a fresh, parentless store - used to
/// give each skill's own mod-list store a real parent link to the player's store (`ModStore::sum`/
/// `more`/`flag` recurse into `parent`, matching `skillModList.parent = actor.modDB` in the
/// original), since `ModStore` itself isn't `Clone` and the player store here is borrowed, not
/// already behind an `Arc`.
pub fn clone_store(s: &ModStore) -> ModStore {
    // A list-backed store shares its copy-on-write list: the same mods in the same order, without copying each one
    // (the reservation pass cloned the player's whole store three times per calc).
    if let Backing::List(mods) = &s.backing {
        let mut out = ModStore::new_list(None, None);
        out.backing = Backing::List(Arc::clone(mods));
        out.conditions = s.conditions.clone();
        out.multipliers = s.multipliers.clone();
        return out;
    }
    let mut out = ModStore::new_list(None, None);
    match &s.backing {
        Backing::List(mods) => {
            for m in mods.iter() {
                out.add_mod(m.clone());
            }
        }
        Backing::Db(map) => {
            for mods in map.values() {
                for m in mods {
                    out.add_mod(m.clone());
                }
            }
        }
    }
    out.conditions = s.conditions.clone();
    out.multipliers = s.multipliers.clone();
    out
}

/// `doActorLifeMana`'s Life/Mana pool block only (CalcPerform.lua:69-132): the part
/// `doActorLifeManaReservation` needs. `output.LowLifePercentage`/`.FullLifePercentage`/
/// `.LowestOfMaximumLifeAndMaximumMana` and the breakdown text are not computed here.
pub fn life_mana_pool(store: &ModStore) -> (f64, f64) {
    let chaos_inoculation = store.flag(None, &[sym("ChaosInoculation")]);
    let life = if chaos_inoculation {
        1.0
    } else {
        let base = store.sum(ModType::Base, None, &[sym("Life")]);
        let inc = store.sum(ModType::Inc, None, &[sym("Life")]);
        let more = store.more(None, &[sym("Life")]);
        let conv = store.sum(ModType::Base, None, &[sym("LifeConvertToEnergyShield")]);
        let computed = (crate::perform::round(base * (1.0 + inc / 100.0) * more * (1.0 - conv / 100.0))).max(1.0);
        store.override_(None, &[sym("Life")]).and_then(|v| v.num()).unwrap_or(computed)
    };
    let mana_conv = store.sum(ModType::Base, None, &[sym("ManaConvertToArmour")]);
    let mana = crate::perform::round(crate::tools::val(store, sym("Mana"), None) * (1.0 - mana_conv / 100.0));
    (life, mana)
}

/// One pool's (`Life` or `Mana`) reservation, before `doActorLifeManaReservation` folds it against
/// the pool's max (CalcPerform.lua:2004-2083, one `for name, values in pairs(pool)` iteration).
struct PoolReservation {
    reserved_flat: f64,
    reserved_percent: f64,
}

/// A single active skill's contribution, from `GrantedEffect.levels[level]`'s untyped
/// `manaReservationFlat`/`manaReservationPercent`/`lifeReservationFlat`/`lifeReservationPercent`
/// (CalcPerform.lua:1984-1993 - the `activeSkill.skillData.*ReservationFlat/Percent or
/// activeEffect.grantedEffectLevel.*ReservationFlat/Percent or 0` chain). The `skillData` half
/// (set by a linked support gem with its own `manaReservationPercent`, e.g. Blasphemy/Awakened
/// Blasphemy/Eldritch Blasphemy turning a curse into a reserved aura - CalcActiveSkill.lua:526-527)
/// isn't in `SkillSnapshot` (the recorder doesn't capture per-skill support gem+level data, only
/// the flat mod list each support contributes), so it's threaded in separately as `SkillReserveOverride`,
/// `None` meaning "no override recorded" (falls back to the gem-level value, same as before this
/// override existed) rather than "override is 0" (Lua's `or` chain treats an explicit 0 as truthy).
fn level_field(ge_id: &str, level: f64, key: &str) -> f64 {
    crate::skills::raw_level(ge_id, level).and_then(|l| l.get(key)).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// One active skill's `activeSkill.skillData.{mana,life}Reservation{Flat,Percent}` values, when
/// known (e.g. from a JS-port probe at CalcPerform.lua:1979, since the recorder doesn't capture
/// this - see `level_field`'s doc comment). `None` in any field means that specific field wasn't
/// overridden (falls through to the gem's own level value), matching Lua's `or` chain exactly.
#[derive(Default, Clone, Copy)]
pub struct SkillReserveOverride {
    pub mana_flat: Option<f64>,
    pub mana_percent: Option<f64>,
    pub life_flat: Option<f64>,
    pub life_percent: Option<f64>,
    /// `skillData.<Pool>Reservation{Flat,Percent}Forced` (order: mana flat, mana percent, life flat, life percent).
    pub forced: [Option<f64>; 4],
    /// `activeSkill.activeMineCount` (CalcActiveSkill.lua:623).
    pub mine_count: Option<f64>,
    /// `activeSkill.activeStageCount + 1` when the skill is "Blood Sacrament" and has stages (CalcPerform.lua:2042-2046).
    pub blood_sacrament_stage_mult: Option<f64>,
}
fn level_cost(ge_id: &str, level: f64, key: &str) -> Option<f64> {
    crate::skills::raw_level(ge_id, level).and_then(|l| l.get("cost")).and_then(|c| c.get(key)).and_then(|v| v.as_f64())
}

const SKILL_TYPE_HAS_RESERVATION: i64 = 12;
const SKILL_TYPE_RESERVATION_BECOMES_COST: i64 = 13;

/// One player's worth of `output.Reserved_*`/`output.Unreserved_*` scalar fields (the "output"
/// keys this port grades), keyed exactly as the recorder's `output_player` flattening
/// records them.
pub struct ReserveResult {
    pub fields: Vec<(&'static str, f64)>,
    /// `(skill index, pool, reservedPercent)` for each non-zero `activeSkill.skillData[name.."ReservedPercent"]`
    /// (CalcPerform.lua:2063-2064).
    pub per_skill: Vec<(usize, &'static str, f64)>,
    /// `(skill index, pool, skillData[pool.."ReservedBase"])` (CalcPerform.lua:2048, 2065): what
    /// `ModStore:GetStat("ManaReservedPercent"/"LifeReservedPercent")` reads.
    pub per_skill_base: Vec<(usize, &'static str, f64)>,
    /// `env.player.ManaEfficiency` (CalcPerform.lua:2012): the last processed skill's `values.efficiency`; read by
    /// `ModStore:GetStat("ManaUnreserved")` (Arcane Cloak).
    pub mana_efficiency: Option<f64>,
    /// The rows upstream writes to `breakdown.<Pool>Reserved.reservations` (CalcPerform.lua:2050-2078), in its order.
    pub rows: Vec<ReservationRow>,
    /// Skills upstream disables here (CalcPerform.lua:2084-2087): a forced Mana percent whose `ManaReservedBase` came out 0.
    pub disabled: Vec<usize>,
}

/// One `breakdown[name.."Reserved"].reservations` row: the factors of one skill's flat or percent reservation of one pool.
#[derive(Clone, Debug)]
pub struct ReservationRow {
    pub skill_idx: usize,
    pub pool: &'static str,
    /// True for the percent row (`base` is `basePercent`, shown with a "%"), false for the flat row.
    pub percent: bool,
    pub base: f64,
    pub mult: f64,
    pub more: f64,
    pub inc: f64,
    pub efficiency: f64,
    pub efficiency_more: f64,
    pub total: f64,
}

/// `env.player.activeSkillList` loop (CalcPerform.lua:1978-2089) plus
/// `doActorLifeManaReservation(env.player, ...)` (line 2092). `player_store` is this build's
/// pre-Perform player mods (already merged: base+bandit+config+tree+item, per this crate's Setup
/// stage); `skills` is the same build's pre-Perform skill list (`skillModList` per skill, already
/// scoped to that skill+supports); `overrides` is a same-length, index-aligned slice of each
/// skill's known `skillData` reservation overrides (see `SkillReserveOverride`'s doc comment) -
/// pass a slice of `Default::default()` (all-`None`) when none are known, which reproduces this
/// function's pre-override behavior exactly.
pub fn compute_reservation(player_store: &ModStore, skills: &[crate::snapshot::SkillSnapshot], overrides: &[SkillReserveOverride]) -> ReserveResult {
    // The player's actor (`output`) must ride along: `PerStat` tags ("per 250 total Attributes") read it.
    let mut player_clone = clone_store(player_store);
    player_clone.actor = player_store.actor.clone();
    let player_arc = Arc::new(player_clone);

    let mut reserved_life_base = 0.0f64;
    let mut reserved_life_percent = player_store.sum(ModType::Base, None, &[sym("ExtraLifeReserved")]);
    let mut reserved_mana_base = 0.0f64;
    let mut reserved_mana_percent = 0.0f64;
    let mut uncancellable_life = player_store.sum(ModType::Base, None, &[sym("ExtraLifeReserved")]);
    let mut uncancellable_mana = player_store.sum(ModType::Base, None, &[sym("ExtraManaReserved")]);
    let mut per_skill: Vec<(usize, &'static str, f64)> = Vec::new();
    let mut per_skill_base: Vec<(usize, &'static str, f64)> = Vec::new();
    let mut last_mana_efficiency: Option<f64> = None;
    let mut rows: Vec<ReservationRow> = Vec::new();
    let mut disabled: Vec<usize> = Vec::new();
    let (pool_life_max, pool_mana_max) = life_mana_pool(player_store);

    for (i, skill) in skills.iter().enumerate() {
        let is_disabled = skill.skill_flags.get("disable").copied().unwrap_or(false);
        let has_reservation = skill.skill_types.contains(&SKILL_TYPE_HAS_RESERVATION);
        let becomes_cost = skill.skill_types.contains(&SKILL_TYPE_RESERVATION_BECOMES_COST);
        if !has_reservation || becomes_cost || is_disabled {
            continue;
        }
        if pom_engine::env::var("POM_DEBUG_RESERVE").is_ok() { eprintln!("RSK {:?} lvl={:?} ge={:?}", skill.name, skill.gem.as_ref().map(|g| g.level), skill.gem.as_ref().and_then(|g| g.granted_effect_id.clone()).map(|i| granted_effect_by_id(&i).is_some())); }
        let Some(gem) = &skill.gem else { continue };
        let Some(ge_id) = &gem.granted_effect_id else { continue };
        if granted_effect_by_id(ge_id).is_none() { continue }
        let cfg = skill.cfg.as_ref();
        let ov = overrides.get(i).copied().unwrap_or_default();

        let mut skill_store = ModStore::new_list(Some(Arc::clone(&player_arc)), player_store.actor.clone());
        for m in &skill.skill_mod_list {
            skill_store.add_mod(m.clone());
        }

        let mult = floor_dec(skill_store.more(cfg, &[sym("SupportManaMultiplier")]), 4);

        let mut mana_flat = ov.mana_flat.unwrap_or_else(|| level_field(ge_id, gem.level, "manaReservationFlat"));
        if skill_store.flag(cfg, &[sym("ManaCostGainAsReservation")]) {
            if let Some(cost_mana) = level_cost(ge_id, gem.level, "Mana") {
                mana_flat = skill_store.sum(ModType::Base, cfg, &[sym("ManaCostBase")]) + cost_mana;
            }
        }
        let mut mana_percent = ov.mana_percent.unwrap_or_else(|| level_field(ge_id, gem.level, "manaReservationPercent"));
        let mut life_flat = ov.life_flat.unwrap_or_else(|| level_field(ge_id, gem.level, "lifeReservationFlat"));
        if skill_store.flag(cfg, &[sym("LifeCostGainAsReservation")]) {
            if let Some(cost_life) = level_cost(ge_id, gem.level, "Life") {
                life_flat = skill_store.sum(ModType::Base, cfg, &[sym("LifeCostBase")]) + cost_life;
            }
        }
        let mut life_percent = ov.life_percent.unwrap_or_else(|| level_field(ge_id, gem.level, "lifeReservationPercent"));

        let mut forced = ov.forced;
        if skill_store.flag(cfg, &[sym("BloodMagicReserved")]) && forced[1].is_none() {
            life_flat += mana_flat;
            mana_flat = 0.0;
            life_percent += mana_percent;
            mana_percent = 0.0;
            forced[2] = forced[0].take();
            forced[3] = forced[1].take();
        }

        let has_uncancellable = skill_store.flag(cfg, &[sym("HasUncancellableReservation")]);

        let mut mana_reserved_base: Option<f64> = None;
        for (name, base_flat, base_percent) in [("Mana", mana_flat, mana_percent), ("Life", life_flat, life_percent)] {
            let resource_more = skill_store.more(cfg, &[sym(&format!("{name}Reserved"))]);
            let generic_more = skill_store.more(cfg, &[sym("Reserved")]);
            let inc = skill_store.sum(ModType::Inc, cfg, &[sym(&format!("{name}Reserved")), sym("Reserved")]);
            let efficiency = skill_store.sum(ModType::Inc, cfg, &[sym(&format!("{name}ReservationEfficiency")), sym("ReservationEfficiency")]).max(-100.0);
            let efficiency_more = skill_store.more(cfg, &[sym(&format!("{name}ReservationEfficiency")), sym("ReservationEfficiency")]);
            if name == "Mana" { last_mana_efficiency = Some(efficiency); if pom_engine::env::var("POM_DEBUG_RESERVE").is_ok() { eprintln!("EFF {:?} {}", skill.name, efficiency); } }

            let (forced_flat, forced_percent) = if name == "Mana" { (forced[0], forced[1]) } else { (forced[2], forced[3]) };
            let mut reserved_flat = 0.0;
            let base_flat_val = trunc0(base_flat * mult);
            if let Some(f) = forced_flat {
                reserved_flat = f;
            } else if base_flat_val != 0.0 {
                let mut modified = base_flat_val + trunc0(base_flat_val * inc / 100.0);
                modified += trunc0(modified * (resource_more - 1.0));
                modified += trunc0(modified * (generic_more - 1.0));
                reserved_flat = round_dec(modified / (1.0 + efficiency / 100.0) / efficiency_more, 0).max(0.0);
            }

            let mut reserved_percent = 0.0;
            let base_percent_val = trunc0(base_percent * 100.0 * mult);
            if let Some(f) = forced_percent {
                reserved_percent = f;
            } else if base_percent_val != 0.0 {
                let mut modified = base_percent_val + trunc0(base_percent_val * inc / 100.0);
                modified += trunc0(modified * (resource_more - 1.0));
                modified += trunc0(modified * (generic_more - 1.0));
                reserved_percent = (round_dec(modified / (1.0 + efficiency / 100.0) / efficiency_more, 0) / 100.0).max(0.0);
            }

            if pom_engine::env::var("POM_DEBUG_RESERVE").is_ok() { eprintln!("RESERVE {} {name} basep={base_percent} basef={base_flat} mult={mult} inc={inc} eff={efficiency} -> flat={reserved_flat} pct={reserved_percent}", skill.name.as_deref().unwrap_or("?")); }
            if let Some(n) = ov.mine_count {
                reserved_flat *= n;
                reserved_percent *= n;
            }
            if let Some(n) = ov.blood_sacrament_stage_mult {
                reserved_flat *= n;
                reserved_percent *= n;
            }
            let pool_name: &'static str = if name == "Mana" { "Mana" } else { "Life" };
            let row = |percent: bool, base: f64, total: f64| ReservationRow { skill_idx: i, pool: pool_name, percent, base, mult, more: resource_more * generic_more, inc, efficiency, efficiency_more, total };
            if reserved_flat != 0.0 {
                rows.push(row(false, base_flat, reserved_flat));
            }
            if reserved_percent != 0.0 {
                rows.push(row(true, base_percent, reserved_percent));
            }
            let pool_max = if name == "Mana" { pool_mana_max } else { pool_life_max };
            let mut base_out: Option<f64> = None;
            if reserved_flat != 0.0 {
                base_out = Some(reserved_flat);
            }
            if reserved_percent != 0.0 {
                per_skill.push((i, pool_name, reserved_percent));
                base_out = Some(reserved_flat + (pool_max * reserved_percent / 100.0).ceil());
            }
            if let Some(b) = base_out {
                per_skill_base.push((i, pool_name, b));
            }
            if name == "Mana" {
                mana_reserved_base = base_out;
            }
            let pool = PoolReservation { reserved_flat, reserved_percent };
            match name {
                "Mana" => {
                    if pool.reserved_flat != 0.0 {
                        reserved_mana_base += pool.reserved_flat;
                    }
                    if pool.reserved_percent != 0.0 {
                        reserved_mana_percent += pool.reserved_percent;
                    }
                    if has_uncancellable {
                        uncancellable_mana += pool.reserved_percent;
                    }
                }
                "Life" => {
                    if pool.reserved_flat != 0.0 {
                        reserved_life_base += pool.reserved_flat;
                    }
                    if pool.reserved_percent != 0.0 {
                        reserved_life_percent += pool.reserved_percent;
                    }
                    if has_uncancellable {
                        uncancellable_life += pool.reserved_percent;
                    }
                }
                _ => unreachable!(),
            }
        }
        if forced[1].is_some() && mana_reserved_base == Some(0.0) {
            disabled.push(i);
        }
    }

    let (life_max, mana_max) = life_mana_pool(player_store);
    // `LowLife`/`LowMana` conditions (CalcPerform.lua:570-571, using `data.misc.LowPoolThreshold`
    // as the `lowPerc <= 0` fallback) aren't set here: this function only produces the `output.*`
    // scalar fields graded by the answer-key tests, not `modDB.conditions` writes.

    let mut fields = Vec::new();
    // The field names, `{pool}Reserved` and so on, written out: they were built and leaked on every calculation.
    const LIFE: [&str; 6] = ["LifeReserved", "LifeReservedPercent", "LifeUnreserved", "LifeUnreservedPercent", "LifeUncancellableReservation", "LifeCancellableReservation"];
    const MANA: [&str; 6] = ["ManaReserved", "ManaReservedPercent", "ManaUnreserved", "ManaUnreservedPercent", "ManaUncancellableReservation", "ManaCancellableReservation"];
    for (names, max, reserved_base, reserved_percent, uncancellable) in
        [(LIFE, life_max, reserved_life_base, reserved_life_percent, uncancellable_life), (MANA, mana_max, reserved_mana_base, reserved_mana_percent, uncancellable_mana)]
    {
        if max > 0.0 {
            let reserved = reserved_base + (max * reserved_percent / 100.0).ceil();
            fields.push((names[0], reserved.min(max)));
            fields.push((names[1], (reserved / max * 100.0).min(100.0)));
            fields.push((names[2], max - reserved));
            fields.push((names[3], (max - reserved) / max * 100.0));
            fields.push((names[4], uncancellable.min(0.0)));
            fields.push((names[5], 100.0 - uncancellable));
        }
    }

    ReserveResult { fields, per_skill, per_skill_base, mana_efficiency: last_mana_efficiency, rows, disabled }
}

