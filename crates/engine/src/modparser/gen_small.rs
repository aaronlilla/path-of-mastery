// Transcribed from ModParser.lua: suffixTypes, penTypes, resourceTypes (+ derived regen/degen/
// cost/baseCost via appendMod), flagTypes, dmgTypes, unsupportedModList.
use crate::value::Value;
use std::sync::Arc;

pub fn build_suffix_types() -> Vec<(&'static str, &'static str)> {
    vec![
        ("as extra lightning damage", "GainAsLightning"),
        ("added as lightning damage", "GainAsLightning"),
        ("gained as extra lightning damage", "GainAsLightning"),
        ("as extra cold damage", "GainAsCold"),
        ("added as cold damage", "GainAsCold"),
        ("gained as extra cold damage", "GainAsCold"),
        ("as extra fire damage", "GainAsFire"),
        ("added as fire damage", "GainAsFire"),
        ("gained as extra fire damage", "GainAsFire"),
        ("as extra chaos damage", "GainAsChaos"),
        ("added as chaos damage", "GainAsChaos"),
        ("gained as extra chaos damage", "GainAsChaos"),
        ("converted to lightning", "ConvertToLightning"),
        ("converted to lightning damage", "ConvertToLightning"),
        ("converted to cold damage", "ConvertToCold"),
        ("converted to fire damage", "ConvertToFire"),
        ("converted to fire", "ConvertToFire"),
        ("converted to chaos damage", "ConvertToChaos"),
        ("added as energy shield", "GainAsEnergyShield"),
        ("as extra maximum energy shield", "GainAsEnergyShield"),
        ("converted to energy shield", "ConvertToEnergyShield"),
        ("as extra armour", "GainAsArmour"),
        ("as physical damage", "AsPhysical"),
        ("as lightning damage", "AsLightning"),
        ("as cold damage", "AsCold"),
        ("as fire damage", "AsFire"),
        ("as fire", "AsFire"),
        ("as chaos damage", "AsChaos"),
        ("leeched as life and mana", "Leech"),
        ("leeched as life", "LifeLeech"),
        ("is leeched as life", "LifeLeech"),
        ("leeched as mana", "ManaLeech"),
        ("is leeched as mana", "ManaLeech"),
        ("leeched as energy shield", "EnergyShieldLeech"),
        ("is leeched as energy shield", "EnergyShieldLeech"),
    ]
}

pub fn build_pen_types() -> Vec<(&'static str, &'static str)> {
    vec![
        ("lightning resistance", "LightningPenetration"),
        ("cold resistance", "ColdPenetration"),
        ("fire resistance", "FirePenetration"),
        ("elemental resistance", "ElementalPenetration"),
        ("elemental resistances", "ElementalPenetration"),
        ("chaos resistance", "ChaosPenetration"),
    ]
}

/// A resourceTypes-family value: either one resource name or several (e.g. "life and mana").
#[derive(Clone, Copy)]
pub enum ResVal {
    One(&'static str),
    Many(&'static [&'static str]),
}
impl ResVal {
    pub fn names(&self) -> Vec<&'static str> {
        match self {
            ResVal::One(s) => vec![*s],
            ResVal::Many(v) => v.to_vec(),
        }
    }
    fn suffixed(&self, suffix: &'static str) -> ResValOwned {
        match self {
            ResVal::One(s) => ResValOwned::One(format!("{}{}", s, suffix)),
            ResVal::Many(v) => ResValOwned::Many(v.iter().map(|s| format!("{}{}", s, suffix)).collect()),
        }
    }
}
#[derive(Clone)]
pub enum ResValOwned {
    One(String),
    Many(Vec<String>),
}
impl ResValOwned {
    pub fn names(&self) -> Vec<String> {
        match self {
            ResValOwned::One(s) => vec![s.clone()],
            ResValOwned::Many(v) => v.clone(),
        }
    }
}

const RESOURCE_BASE: &[(&str, ResVal)] = &[
    ("life", ResVal::One("Life")),
    ("mana", ResVal::One("Mana")),
    ("energy shield", ResVal::One("EnergyShield")),
    ("life and mana", ResVal::Many(&["Life", "Mana"])),
    ("life and energy shield", ResVal::Many(&["Life", "EnergyShield"])),
    ("life, mana and energy shield", ResVal::Many(&["Life", "Mana", "EnergyShield"])),
    ("life, energy shield and mana", ResVal::Many(&["Life", "Mana", "EnergyShield"])),
    ("mana and life", ResVal::Many(&["Life", "Mana"])),
    ("mana and energy shield", ResVal::Many(&["Mana", "EnergyShield"])),
    ("mana, life and energy shield", ResVal::Many(&["Life", "Mana", "EnergyShield"])),
    ("mana, energy shield and life", ResVal::Many(&["Life", "Mana", "EnergyShield"])),
    ("energy shield and life", ResVal::Many(&["Life", "EnergyShield"])),
    ("energy shield and mana", ResVal::Many(&["Mana", "EnergyShield"])),
    ("energy shield, life and mana", ResVal::Many(&["Life", "Mana", "EnergyShield"])),
    ("energy shield, mana and life", ResVal::Many(&["Life", "Mana", "EnergyShield"])),
    ("rage", ResVal::One("Rage")),
];

/// resourceTypes, including the "maximum X" duplicates the Lua `do ... end` block adds.
pub fn build_resource_types() -> Vec<(String, ResVal)> {
    let mut out: Vec<(String, ResVal)> = RESOURCE_BASE.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let extra: Vec<(String, ResVal)> = RESOURCE_BASE.iter().map(|(k, v)| (format!("maximum {}", k), *v)).collect();
    out.extend(extra);
    out
}

fn append_mod(table: &[(String, ResVal)], suffix: &'static str) -> Vec<(String, ResValOwned)> {
    table.iter().map(|(k, v)| (k.clone(), v.suffixed(suffix))).collect()
}
pub fn build_regen_types() -> Vec<(String, ResValOwned)> {
    append_mod(&build_resource_types(), "Regen")
}
pub fn build_degen_types() -> Vec<(String, ResValOwned)> {
    append_mod(&build_resource_types(), "Degen")
}
pub fn build_cost_types() -> Vec<(String, ResValOwned)> {
    append_mod(&build_resource_types(), "Cost")
}
pub fn build_base_cost_types() -> Vec<(String, ResValOwned)> {
    append_mod(&build_resource_types(), "CostNoMult")
}

/// flagTypes value: a plain "Condition:X"-style name, or the {name,value,type} override table
/// (only used for "hexproof").
#[derive(Clone)]
pub enum FlagVal {
    Name(&'static str),
    Obj { name: &'static str, value: f64, ty: &'static str },
}
pub fn build_flag_types() -> Vec<(&'static str, FlagVal)> {
    use FlagVal::*;
    vec![
        ("phasing", Name("Condition:Phasing")),
        ("onslaught", Name("Condition:Onslaught")),
        ("rampage", Name("Condition:Rampage")),
        ("soul eater", Name("Condition:CanHaveSoulEater")),
        ("adrenaline", Name("Condition:Adrenaline")),
        ("elusive", Name("Condition:CanBeElusive")),
        ("arcane surge", Name("Condition:ArcaneSurge")),
        ("fortify", Name("Condition:Fortified")),
        ("fortified", Name("Condition:Fortified")),
        ("unholy might", Name("Condition:UnholyMight")),
        ("chaotic might", Name("Condition:ChaoticMight")),
        ("tailwind", Name("Condition:Tailwind")),
        ("intimidated", Name("Condition:Intimidated")),
        ("crushed", Name("Condition:Crushed")),
        ("chilled", Name("Condition:Chilled")),
        ("blinded", Name("Condition:Blinded")),
        ("no life regeneration", Name("NoLifeRegen")),
        ("hexproof", Obj { name: "CurseEffectOnSelf", value: -100.0, ty: "MORE" }),
        ("hindered,? with (%d+)%% reduced movement speed", Name("Condition:Hindered")),
        ("unnerved", Name("Condition:Unnerved")),
        ("malediction", Name("HasMalediction")),
        ("debilitated", Name("Condition:Debilitated")),
        // duplicate keys in the Lua source (last write wins there too; harmless here)
        ("lesser brutal shrine buff", Name("Condition:LesserBrutalShrine")),
        ("lesser massive shrine buff", Name("Condition:LesserMassiveShrine")),
        ("acceleration shrine buff", Name("Condition:AccelerationShrine")),
        ("brutal shrine buff", Name("Condition:BrutalShrine")),
        ("diamond shrine buff", Name("Condition:DiamondShrine")),
        ("echoing shrine buff", Name("Condition:EchoingShrine")),
        ("gloom shrine buff", Name("Condition:GloomShrine")),
        ("greater freezing shrine buff", Name("Condition:GreaterFreezingShrine")),
        ("greater shocking shrine buff", Name("Condition:GreaterShockingShrine")),
        ("greater skeletal shrine buff", Name("Condition:GreaterSkeletalShrine")),
        ("impenetrable shrine buff", Name("Condition:ImpenetrableShrine")),
        ("massive shrine buff", Name("Condition:MassiveShrine")),
        ("replenishing shrine buff", Name("Condition:ReplenishingShrine")),
        ("resistance shrine buff", Name("Condition:ResistanceShrine")),
        ("resonating shrine buff", Name("Condition:ResonatingShrine")),
    ]
}

pub fn build_dmg_types() -> Vec<(&'static str, &'static str)> {
    vec![
        ("physical", "Physical"),
        ("lightning", "Lightning"),
        ("cold", "Cold"),
        ("fire", "Fire"),
        ("chaos", "Chaos"),
    ]
}

pub fn build_unsupported_mod_list() -> Vec<&'static str> {
    vec!["properties are doubled while in a breach", "mirrored", "split"]
}

#[allow(dead_code)]
fn _unused(_: Value, _: Arc<str>) {}
