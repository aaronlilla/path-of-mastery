//! `doActorCharges` (Modules/CalcPerform.lua:980-1139): per-actor charge-type max/min/current
//! values and `modDB.multipliers` population, called once per actor (player, enemy, minion - same
//! `actor.modDB`/`actor.output`-only signature in upstream, no cross-actor state besides the
//! `env.partyMembers` cases named below). Graded in isolation by the answer-key grader
//! against the recorded post-Perform `output_player`/`output_minion` scalar maps and each store
//! snapshot's own `multipliers` map.
//!
//! Not ported (named gaps, not silently dropped):
//! - `env.partyMembers.modDB:Flag(nil, "PartyMemberMaximumEnduranceChargesEqualToYours")`
//!   (CalcPerform.lua:1001): cross-actor party override for `EnduranceChargesMax`. Treated as
//!   false (no party-member state is recorded by this crate's harness to check it against).
//! - `modDB:ReplaceMod(...)` for `MaximumFrenzyChargesIsMaximumPowerCharges`/
//!   `MaximumEnduranceChargesIsMaximumFrenzyCharges` (lines 989-992, 996-998) isn't literally
//!   replicated as a modDB mutation (this crate doesn't need the replaced mod to persist for
//!   anything downstream in this file); the *value* it produces is applied directly, which is
//!   observationally identical for computing this function's own outputs.
use pom_engine::modifier::ModType;
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;

fn sym(s: &str) -> Sym {
    Sym::new(s)
}
fn base_max0(store: &ModStore, name: &str) -> f64 {
    store.sum(ModType::Base, None, &[sym(name)]).max(0.0)
}
fn flag(store: &ModStore, name: &str) -> bool {
    store.flag(None, &[sym(name)])
}
fn override_num(store: &ModStore, name: &str) -> Option<f64> {
    store.override_(None, &[sym(name)]).and_then(|v| v.num())
}
fn duration(store: &ModStore, name: &str) -> f64 {
    (store.sum(ModType::Base, None, &[sym("ChargeDuration")]) * crate::tools::mod_(store, None, &[sym(name), sym("ChargeDuration")])).floor()
}

#[derive(Default, Clone, Copy)]
pub struct Charges {
    pub power_charges_min: f64,
    pub power_charges_max: f64,
    pub power_charges_duration: f64,
    pub frenzy_charges_min: f64,
    pub frenzy_charges_max: f64,
    pub frenzy_charges_duration: f64,
    pub endurance_charges_min: f64,
    pub endurance_charges_max: f64,
    pub endurance_charges_duration: f64,
    pub siphoning_charges_max: f64,
    pub challenger_charges_max: f64,
    pub blitz_charges_max: f64,
    pub inspiration_charges_max: f64,
    pub crab_barriers_max: f64,
    pub brutal_charges_min: f64,
    pub brutal_charges_max: f64,
    pub brine_charges_max: f64,
    pub absorption_charges_min: f64,
    pub absorption_charges_max: f64,
    pub affliction_charges_min: f64,
    pub affliction_charges_max: f64,
    pub blood_charges_max: f64,
    pub spirit_charges_max: f64,
    pub spirit_infusions_max: f64,

    pub power_charges: f64,
    pub frenzy_charges: f64,
    pub endurance_charges: f64,
    pub siphoning_charges: f64,
    pub challenger_charges: f64,
    pub blitz_charges: f64,
    pub inspiration_charges: f64,
    pub ghost_shrouds: f64,
    pub brutal_charges: f64,
    pub brine_charges: f64,
    pub absorption_charges: f64,
    pub affliction_charges: f64,
    pub blood_charges: f64,
    pub spirit_charges: f64,
    pub spirit_infusions: f64,
    pub crab_barriers: f64,

    pub removable_power_charges: f64,
    pub removable_frenzy_charges: f64,
    pub removable_endurance_charges: f64,
    pub total_charges: f64,
    pub removable_total_charges: f64,
}

/// `is_player`: `actor == env.player` gate on `InspirationCharges` (CalcPerform.lua:1094).
pub fn compute_charges(store: &ModStore, is_player: bool) -> Charges {
    let mut c = Charges::default();

    c.power_charges_min = base_max0(store, "PowerChargesMin");
    c.power_charges_max = override_num(store, "PowerChargesMax").unwrap_or_else(|| base_max0(store, "PowerChargesMax"));
    c.power_charges_duration = duration(store, "PowerChargesDuration");

    c.frenzy_charges_min = base_max0(store, "FrenzyChargesMin");
    c.frenzy_charges_max = if flag(store, "MaximumFrenzyChargesIsMaximumPowerCharges") {
        c.power_charges_max
    } else {
        override_num(store, "FrenzyChargesMax").unwrap_or_else(|| base_max0(store, "FrenzyChargesMax"))
    };
    c.frenzy_charges_duration = duration(store, "FrenzyChargesDuration");

    c.endurance_charges_min = base_max0(store, "EnduranceChargesMin");
    c.endurance_charges_max = if flag(store, "MaximumEnduranceChargesIsMaximumFrenzyCharges") {
        c.frenzy_charges_max
    } else {
        override_num(store, "EnduranceChargesMax").unwrap_or_else(|| base_max0(store, "EnduranceChargesMax"))
    };
    c.endurance_charges_duration = duration(store, "EnduranceChargesDuration");

    c.siphoning_charges_max = base_max0(store, "SiphoningChargesMax");
    c.challenger_charges_max = base_max0(store, "ChallengerChargesMax");
    c.blitz_charges_max = base_max0(store, "BlitzChargesMax");
    c.inspiration_charges_max = base_max0(store, "InspirationChargesMax");
    c.crab_barriers_max = base_max0(store, "CrabBarriersMax");

    c.brutal_charges_min = if flag(store, "MinimumEnduranceChargesEqualsMinimumBrutalCharges") {
        if flag(store, "MinimumEnduranceChargesIsMaximumEnduranceCharges") { c.endurance_charges_max } else { c.endurance_charges_min }
    } else {
        0.0
    }
    .max(0.0);
    c.brutal_charges_max = (if flag(store, "MaximumEnduranceChargesEqualsMaximumBrutalCharges") { c.endurance_charges_max } else { 0.0 }).max(0.0);
    c.brine_charges_max = c.endurance_charges_max.max(0.0);
    c.absorption_charges_min = if flag(store, "MinimumPowerChargesEqualsMinimumAbsorptionCharges") {
        if flag(store, "MinimumPowerChargesIsMaximumPowerCharges") { c.power_charges_max } else { c.power_charges_min }
    } else {
        0.0
    }
    .max(0.0);
    c.absorption_charges_max = (if flag(store, "MaximumPowerChargesEqualsMaximumAbsorptionCharges") { c.power_charges_max } else { 0.0 }).max(0.0);
    c.affliction_charges_min = if flag(store, "MinimumFrenzyChargesEqualsMinimumAfflictionCharges") {
        if flag(store, "MinimumFrenzyChargesIsMaximumFrenzyCharges") { c.frenzy_charges_max } else { c.frenzy_charges_min }
    } else {
        0.0
    }
    .max(0.0);
    c.affliction_charges_max = (if flag(store, "MaximumFrenzyChargesEqualsMaximumAfflictionCharges") { c.frenzy_charges_max } else { 0.0 }).max(0.0);
    c.blood_charges_max = base_max0(store, "BloodChargesMax");
    c.spirit_charges_max = base_max0(store, "SpiritChargesMax");
    c.spirit_infusions_max = store.sum(ModType::Base, None, &[sym("SpiritInfusionsMax")]) + if flag(store, "Condition:CanGainSpiritInfusion") { 10.0 } else { 0.0 };

    // Current values start at 0 (CalcPerform.lua:1019-1034); already the struct default.

    if flag(store, "MinimumFrenzyChargesIsMaximumFrenzyCharges") {
        c.frenzy_charges_min = c.frenzy_charges_max;
    }
    if flag(store, "MinimumEnduranceChargesIsMaximumEnduranceCharges") {
        c.endurance_charges_min = c.endurance_charges_max;
    }
    if flag(store, "MinimumPowerChargesIsMaximumPowerCharges") {
        c.power_charges_min = c.power_charges_max;
    }
    if flag(store, "UsePowerCharges") {
        c.power_charges = override_num(store, "PowerCharges").unwrap_or(c.power_charges_max);
    }
    if flag(store, "PowerChargesConvertToAbsorptionCharges") {
        c.absorption_charges = c.power_charges.max(c.absorption_charges_max.min(c.absorption_charges_min));
        c.power_charges = 0.0;
    } else {
        c.power_charges = c.power_charges.max(c.power_charges_max.min(c.power_charges_min));
    }
    c.removable_power_charges = (c.power_charges - c.power_charges_min).max(0.0);

    if flag(store, "UseFrenzyCharges") {
        c.frenzy_charges = override_num(store, "FrenzyCharges").unwrap_or(c.frenzy_charges_max);
    }
    if flag(store, "FrenzyChargesConvertToAfflictionCharges") {
        c.affliction_charges = c.frenzy_charges.max(c.affliction_charges_max.min(c.affliction_charges_min));
        c.frenzy_charges = 0.0;
    } else {
        c.frenzy_charges = c.frenzy_charges.max(c.frenzy_charges_max.min(c.frenzy_charges_min));
    }
    c.removable_frenzy_charges = (c.frenzy_charges - c.frenzy_charges_min).max(0.0);

    if flag(store, "UseEnduranceCharges") {
        c.endurance_charges = override_num(store, "EnduranceCharges").unwrap_or(c.endurance_charges_max);
        if flag(store, "CanGainBrineCharges") {
            c.brine_charges = c.brine_charges_max;
        }
    }
    if flag(store, "EnduranceChargesConvertToBrutalCharges") {
        c.brutal_charges = c.endurance_charges.max(c.brutal_charges_max.min(c.brutal_charges_min));
        c.endurance_charges = 0.0;
    } else {
        c.endurance_charges = c.endurance_charges.max(c.endurance_charges_max.min(c.endurance_charges_min));
    }
    c.removable_endurance_charges = (c.endurance_charges - c.endurance_charges_min).max(0.0);

    if flag(store, "UseSiphoningCharges") {
        c.siphoning_charges = override_num(store, "SiphoningCharges").unwrap_or(c.siphoning_charges_max);
    }
    if flag(store, "UseChallengerCharges") {
        c.challenger_charges = override_num(store, "ChallengerCharges").unwrap_or(c.challenger_charges_max);
    }
    if flag(store, "UseBlitzCharges") {
        c.blitz_charges = override_num(store, "BlitzCharges").unwrap_or(c.blitz_charges_max);
    }
    if is_player {
        c.inspiration_charges = override_num(store, "InspirationCharges").unwrap_or(c.inspiration_charges_max);
    }
    if flag(store, "UseGhostShrouds") {
        c.ghost_shrouds = override_num(store, "GhostShrouds").unwrap_or(3.0);
    }
    c.blood_charges = override_num(store, "BloodCharges").unwrap_or(c.blood_charges_max).min(c.blood_charges_max);
    c.spirit_charges = override_num(store, "SpiritCharges").unwrap_or(0.0).min(c.spirit_charges_max);
    c.spirit_infusions = override_num(store, "SpiritInfusion").unwrap_or(0.0).min(c.spirit_infusions_max);

    c.crab_barriers = override_num(store, "CrabBarriers").unwrap_or(c.crab_barriers_max).min(c.crab_barriers_max);

    if flag(store, "HaveMaximumPowerCharges") {
        c.power_charges = c.power_charges_max;
    }
    if flag(store, "HaveMaximumFrenzyCharges") {
        c.frenzy_charges = c.frenzy_charges_max;
    }
    if flag(store, "HaveMaximumEnduranceCharges") {
        c.endurance_charges = c.endurance_charges_max;
    }
    c.total_charges = c.power_charges + c.frenzy_charges + c.endurance_charges;
    c.removable_total_charges = c.removable_endurance_charges + c.removable_frenzy_charges + c.removable_power_charges;

    c
}

/// `modDB.multipliers[...]` assignments at the end of `doActorCharges` (CalcPerform.lua:1117-1138).
pub fn apply_charge_multipliers(store: &mut ModStore, c: &Charges) {
    let set = |store: &mut ModStore, name: &str, v: f64| {
        store.multipliers.insert(sym(name), v);
    };
    set(store, "PowerCharge", c.power_charges);
    set(store, "PowerChargeMax", c.power_charges_max);
    set(store, "RemovablePowerCharge", c.removable_power_charges);
    set(store, "FrenzyCharge", c.frenzy_charges);
    set(store, "RemovableFrenzyCharge", c.removable_frenzy_charges);
    set(store, "EnduranceCharge", c.endurance_charges);
    set(store, "RemovableEnduranceCharge", c.removable_endurance_charges);
    set(store, "TotalCharges", c.total_charges);
    set(store, "RemovableTotalCharges", c.removable_total_charges);
    set(store, "SiphoningCharge", c.siphoning_charges);
    set(store, "ChallengerCharge", c.challenger_charges);
    set(store, "BlitzCharge", c.blitz_charges);
    set(store, "InspirationCharge", c.inspiration_charges);
    set(store, "GhostShroud", c.ghost_shrouds);
    set(store, "CrabBarrier", c.crab_barriers);
    set(store, "BrutalCharge", c.brutal_charges);
    set(store, "BrineCharge", c.brine_charges);
    set(store, "AbsorptionCharge", c.absorption_charges);
    set(store, "AfflictionCharge", c.affliction_charges);
    set(store, "BloodCharge", c.blood_charges);
    set(store, "SpiritCharge", c.spirit_charges);
    set(store, "SpiritInfusion", c.spirit_infusions);
}

/// `output.*` scalar fields this function sets, by their exact Lua key name - for grading against
/// the recorder's flattened `output_player`/`output_minion` maps.
pub fn output_fields(c: &Charges) -> Vec<(&'static str, f64)> {
    vec![
        ("PowerChargesMin", c.power_charges_min),
        ("PowerChargesMax", c.power_charges_max),
        ("PowerChargesDuration", c.power_charges_duration),
        ("FrenzyChargesMin", c.frenzy_charges_min),
        ("FrenzyChargesMax", c.frenzy_charges_max),
        ("FrenzyChargesDuration", c.frenzy_charges_duration),
        ("EnduranceChargesMin", c.endurance_charges_min),
        ("EnduranceChargesMax", c.endurance_charges_max),
        ("EnduranceChargesDuration", c.endurance_charges_duration),
        ("SiphoningChargesMax", c.siphoning_charges_max),
        ("ChallengerChargesMax", c.challenger_charges_max),
        ("BlitzChargesMax", c.blitz_charges_max),
        ("InspirationChargesMax", c.inspiration_charges_max),
        ("CrabBarriersMax", c.crab_barriers_max),
        ("BrutalChargesMin", c.brutal_charges_min),
        ("BrutalChargesMax", c.brutal_charges_max),
        ("BrineChargesMax", c.brine_charges_max),
        ("AbsorptionChargesMin", c.absorption_charges_min),
        ("AbsorptionChargesMax", c.absorption_charges_max),
        ("AfflictionChargesMin", c.affliction_charges_min),
        ("AfflictionChargesMax", c.affliction_charges_max),
        ("BloodChargesMax", c.blood_charges_max),
        ("SpiritChargesMax", c.spirit_charges_max),
        ("SpiritInfusionsMax", c.spirit_infusions_max),
        ("PowerCharges", c.power_charges),
        ("FrenzyCharges", c.frenzy_charges),
        ("EnduranceCharges", c.endurance_charges),
        ("SiphoningCharges", c.siphoning_charges),
        ("ChallengerCharges", c.challenger_charges),
        ("BlitzCharges", c.blitz_charges),
        ("InspirationCharges", c.inspiration_charges),
        ("GhostShrouds", c.ghost_shrouds),
        ("BrutalCharges", c.brutal_charges),
        ("BrineCharges", c.brine_charges),
        ("AbsorptionCharges", c.absorption_charges),
        ("AfflictionCharges", c.affliction_charges),
        ("BloodCharges", c.blood_charges),
        ("SpiritCharges", c.spirit_charges),
        ("SpiritInfusions", c.spirit_infusions),
        ("RemovablePowerCharges", c.removable_power_charges),
        ("RemovableFrenzyCharges", c.removable_frenzy_charges),
        ("RemovableEnduranceCharges", c.removable_endurance_charges),
        ("TotalCharges", c.total_charges),
        ("RemovableTotalCharges", c.removable_total_charges),
        ("CrabBarriers", c.crab_barriers),
    ]
}
