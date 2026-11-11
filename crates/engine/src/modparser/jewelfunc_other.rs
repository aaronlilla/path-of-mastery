// jewelOtherFuncs (ModParser.lua:6151-6366, "Other" kind, radius jewels that rewrite *other*
// nodes' mods) plus jewelSelfFuncs and jewelSelfUnallocFuncs (ModParser.lua:6369-6452, "Self" and
// "SelfUnalloc" kinds, radius jewels that grant something to their own socket based on nearby
// nodes). Split from jewelfunc_threshold.rs because of the size of these functions.
use super::flags::{keyword_flag as kf, mod_flag as mf};
use super::jewelfunc::{bv, get_per_stat, get_simple_conv, grants_all_bonuses, new_mod, other_wrap, sum_mods, sv, wrap_mod, JewelEntry, JewelKind, JewelTableEntry};
use crate::modifier::ModType;
use crate::sym::Sym;
use crate::value::Value;
use std::sync::Arc;

fn e(pattern: &'static str, entry: JewelEntry) -> JewelTableEntry {
    JewelTableEntry { pattern, kind: JewelKind::Other, entry }
}
fn fixed(pattern: &'static str, f: super::jewelfunc::JewelFn) -> JewelTableEntry {
    e(pattern, JewelEntry::Fixed(other_wrap(f)))
}
fn ctor(pattern: &'static str, c: super::jewelfunc::JewelCtor) -> JewelTableEntry {
    e(pattern, JewelEntry::Ctor(c))
}

/// jewelOtherFuncs, first half: the attribute/damage-type/resistance getSimpleConv entries
/// (ModParser.lua:6152-6201).
pub fn other_part1() -> Vec<JewelTableEntry> {
    vec![
        fixed("strength from passives in radius is transformed to dexterity", get_simple_conv(&["Str"], "Dex", ModType::Base, true, None, None)),
        fixed("dexterity from passives in radius is transformed to strength", get_simple_conv(&["Dex"], "Str", ModType::Base, true, None, None)),
        fixed("strength from passives in radius is transformed to intelligence", get_simple_conv(&["Str"], "Int", ModType::Base, true, None, None)),
        fixed("intelligence from passives in radius is transformed to strength", get_simple_conv(&["Int"], "Str", ModType::Base, true, None, None)),
        fixed("dexterity from passives in radius is transformed to intelligence", get_simple_conv(&["Dex"], "Int", ModType::Base, true, None, None)),
        fixed("intelligence from passives in radius is transformed to dexterity", get_simple_conv(&["Int"], "Dex", ModType::Base, true, None, None)),
        fixed(
            "increases and reductions to life in radius are transformed to apply to energy shield",
            get_simple_conv(&["Life"], "EnergyShield", ModType::Inc, true, None, None),
        ),
        fixed(
            "increases and reductions to evasion rating in radius are transformed to apply to armour",
            get_simple_conv(&["Evasion"], "Armour", ModType::Inc, true, None, None),
        ),
        ctor("increases and reductions to energy shield in radius are transformed to apply to armour at (%d+)%% of their value", |a| {
            get_simple_conv(&["EnergyShield"], "Armour", ModType::Inc, true, Some(a.n(1) / 100.0), None)
        }),
        ctor("increases and reductions to life in radius are transformed to apply to mana at (%d+)%% of their value", |a| {
            get_simple_conv(&["Life"], "Mana", ModType::Inc, true, Some(a.n(1) / 100.0), None)
        }),
        fixed(
            "increases and reductions to physical damage in radius are transformed to apply to cold damage",
            get_simple_conv(&["PhysicalDamage"], "ColdDamage", ModType::Inc, true, None, None),
        ),
        fixed(
            "increases and reductions to cold damage in radius are transformed to apply to physical damage",
            get_simple_conv(&["ColdDamage"], "PhysicalDamage", ModType::Inc, true, None, None),
        ),
        fixed(
            "increases and reductions to other damage types in radius are transformed to apply to fire damage",
            get_simple_conv(
                &["PhysicalDamage", "ColdDamage", "LightningDamage", "ChaosDamage", "ElementalDamage"],
                "FireDamage",
                ModType::Inc,
                true,
                None,
                None,
            ),
        ),
        ctor(
            "passives granting lightning resistance or all elemental resistances in radius also grant chance to block spells? ?d?a?m?a?g?e? at (%d+)%% of its value",
            |a| get_simple_conv(&["LightningResist", "ElementalResist"], "SpellBlockChance", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
        ctor(
            "passives granting lightning resistance or all elemental resistances in radius also grant increased maximum energy shield at (%d+)%% of its value",
            |a| get_simple_conv(&["LightningResist", "ElementalResist"], "EnergyShield", ModType::Inc, false, Some(a.n(1) / 100.0), Some(ModType::Base)),
        ),
        ctor(
            "passives granting lightning resistance or all elemental resistances in radius also grant lightning damage converted to chaos damage at (%d+)%% of its value",
            |a| get_simple_conv(&["LightningResist", "ElementalResist"], "LightningDamageConvertToChaos", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
        ctor(
            "passives granting cold resistance or all elemental resistances in radius also grant chance to dodge attacks? ?h?i?t?s? at (%d+)%% of its value",
            |a| get_simple_conv(&["ColdResist", "ElementalResist"], "AttackDodgeChance", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
        ctor(
            "passives granting cold resistance or all elemental resistances in radius also grant chance to suppress spell damage at (%d+)%% of its value",
            |a| get_simple_conv(&["ColdResist", "ElementalResist"], "SpellSuppressionChance", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
        ctor(
            "passives granting cold resistance or all elemental resistances in radius also grant increased maximum mana at (%d+)%% of its value",
            |a| get_simple_conv(&["ColdResist", "ElementalResist"], "Mana", ModType::Inc, false, Some(a.n(1) / 100.0), Some(ModType::Base)),
        ),
        ctor(
            "passives granting cold resistance or all elemental resistances in radius also grant cold damage converted to chaos damage at (%d+)%% of its value",
            |a| get_simple_conv(&["ColdResist", "ElementalResist"], "ColdDamageConvertToChaos", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
        ctor(
            "passives granting fire resistance or all elemental resistances in radius also grant chance to block attack damage at (%d+)%% of its value",
            |a| get_simple_conv(&["FireResist", "ElementalResist"], "BlockChance", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
        ctor("passives granting fire resistance or all elemental resistances in radius also grant chance to block at (%d+)%% of its value", |a| {
            get_simple_conv(&["FireResist", "ElementalResist"], "BlockChance", ModType::Base, false, Some(a.n(1) / 100.0), None)
        }),
        ctor(
            "passives granting fire resistance or all elemental resistances in radius also grant increased maximum life at (%d+)%% of its value",
            |a| get_simple_conv(&["FireResist", "ElementalResist"], "Life", ModType::Inc, false, Some(a.n(1) / 100.0), Some(ModType::Base)),
        ),
        ctor(
            "passives granting fire resistance or all elemental resistances in radius also grant fire damage converted to chaos damage at (%d+)%% of its value",
            |a| get_simple_conv(&["FireResist", "ElementalResist"], "FireDamageConvertToChaos", ModType::Base, false, Some(a.n(1) / 100.0), None),
        ),
    ]
}

/// jewelOtherFuncs, second half: the Melee-to-Bow rewrite and the "Passive Skills in Radius also
/// grant/are Transformed to instead grant" custom entries (ModParser.lua:6202-6365).
pub fn other_part2() -> Vec<JewelTableEntry> {
    vec![
        fixed(
            "melee and melee weapon type modifiers in radius are transformed to bow modifiers",
            melee_to_bow(),
        ),
        ctor("(%d+)%% increased effect of non%-keystone passive skills in radius", |a| {
            let num = a.n(1);
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if n.node_type != "Keystone" && n.node_type != "ClassStart" {
                    out.new_mod("PassiveSkillEffect", ModType::Inc, Value::Num(num), data.mod_source.clone(), 0, 0, vec![]);
                }
            })
        }),
        fixed(
            "notable passive skills in radius grant nothing",
            Arc::new(|node, out, data| {
                let Some(n) = node else { return };
                if n.node_type == "Notable" {
                    out.new_mod("PassiveSkillHasNoEffect", ModType::Flag, bv(true), data.mod_source.clone(), 0, 0, vec![]);
                }
            }),
        ),
        ctor("(%d+)%% increased effect of tattoos in radius", |a| {
            let num = a.n(1);
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if n.is_tattoo {
                    out.new_mod("PassiveSkillEffect", ModType::Inc, Value::Num(num), data.mod_source.clone(), 0, 0, vec![]);
                }
            })
        }),
        fixed(
            "allocated small passive skills in radius grant nothing",
            Arc::new(|node, out, data| {
                let Some(n) = node else { return };
                if n.node_type == "Normal" {
                    out.new_mod("AllocatedPassiveSkillHasNoEffect", ModType::Flag, bv(true), data.mod_source.clone(), 0, 0, vec![]);
                }
            }),
        ),
        fixed(
            "allocated notable passive skills in radius grant nothing",
            Arc::new(|node, out, data| {
                let Some(n) = node else { return };
                if n.node_type == "Notable" {
                    out.new_mod("AllocatedPassiveSkillHasNoEffect", ModType::Flag, bv(true), data.mod_source.clone(), 0, 0, vec![]);
                }
            }),
        ),
        ctor("passive skills in radius also grant: traps and mines deal (%d+) to (%d+) added physical damage", |a| {
            let (min, max) = (a.n(1), a.n(2));
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if n.node_type != "Keystone" && n.node_type != "ClassStart" {
                    let kwf = kf::Trap | kf::Mine;
                    out.new_mod("PhysicalMin", ModType::Base, Value::Num(min), data.mod_source.clone(), 0, kwf, vec![]);
                    out.new_mod("PhysicalMax", ModType::Base, Value::Num(max), data.mod_source.clone(), 0, kwf, vec![]);
                }
            })
        }),
        ctor("passive skills in radius also grant: (%d+)%% increased unarmed attack speed with melee skills", |a| {
            let num = a.n(1);
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if n.node_type != "Keystone" && n.node_type != "ClassStart" {
                    out.new_mod("Speed", ModType::Inc, Value::Num(num), data.mod_source.clone(), mf::Unarmed | mf::Attack | mf::Melee, 0, vec![]);
                }
            })
        }),
        ctor("passive skills in radius also grant (%d+)%% increased global critical strike chance", |a| {
            grant_unless(a.n(1), "CritChance", ModType::Inc, true)
        }),
        ctor(r"passive skills in radius also grant %+(%d+) to maximum life", |a| grant_unless(a.n(1), "Life", ModType::Base, true)),
        ctor(r"passive skills in radius also grant %+(%d+) to maximum mana", |a| grant_unless(a.n(1), "Mana", ModType::Base, true)),
        ctor("passive skills in radius also grant (%d+)%% increased energy shield", |a| grant_unless(a.n(1), "EnergyShield", ModType::Inc, true)),
        ctor("passive skills in radius also grant (%d+)%% increased armour", |a| grant_unless(a.n(1), "Armour", ModType::Inc, true)),
        ctor("passive skills in radius also grant (%d+)%% increased evasion rating", |a| grant_unless(a.n(1), "Evasion", ModType::Inc, true)),
        ctor(r"passive skills in radius also grant %+(%d+) to all attributes", |a| {
            let num = a.n(1);
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if excludes_socket(n.node_type) {
                    for stat in ["Str", "Dex", "Int", "All"] {
                        out.new_mod(stat, ModType::Base, Value::Num(num), data.mod_source.clone(), 0, 0, vec![]);
                    }
                }
            })
        }),
        ctor(r"passive skills in radius also grant %+(%d+)%% to chaos resistance", |a| grant_unless(a.n(1), "ChaosResist", ModType::Base, true)),
        ctor("passive skills in radius also grant (%d+)%% increased (%w+) damage", |a| {
            let num = a.n(1);
            let dmg_type = super::special::support::first_upper(a.s(2));
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if excludes_socket(n.node_type) {
                    out.new_mod(&format!("{dmg_type}Damage"), ModType::Inc, Value::Num(num), data.mod_source.clone(), 0, 0, vec![]);
                }
            })
        }),
        ctor(
            "notable passive skills in radius are transformed to instead grant: (%d+)%% increased mana cost of skills and (%d+)%% increased spell damage",
            |a| {
                let (num1, num2) = (a.n(1), a.n(2));
                Arc::new(move |node, out, data| {
                    let Some(n) = node else { return };
                    if n.node_type == "Notable" {
                        let src = data.mod_source.clone();
                        out.new_mod("PassiveSkillHasOtherEffect", ModType::Flag, bv(true), src.clone(), 0, 0, vec![]);
                        let mana_cost = new_mod("ManaCost", ModType::Inc, Value::Num(num1), src.clone(), 0, 0, vec![]);
                        out.new_mod("NodeModifier", ModType::List, wrap_mod(mana_cost), src.clone(), 0, 0, vec![]);
                        let dmg = new_mod("Damage", ModType::Inc, Value::Num(num2), src.clone(), mf::Spell, 0, vec![]);
                        out.new_mod("NodeModifier", ModType::List, wrap_mod(dmg), src, 0, 0, vec![]);
                    }
                })
            },
        ),
        ctor("notable passive skills in radius are transformed to instead grant: minions take (%d+)%% increased damage", |a| {
            let num = a.n(1);
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if n.node_type == "Notable" {
                    let src = data.mod_source.clone();
                    out.new_mod("PassiveSkillHasOtherEffect", ModType::Flag, bv(true), src.clone(), 0, 0, vec![]);
                    let taken = new_mod("DamageTaken", ModType::Inc, Value::Num(num), src.clone(), 0, 0, vec![]);
                    let minion_mod = new_mod("MinionModifier", ModType::List, wrap_mod(taken), None, 0, 0, vec![]);
                    out.new_mod("NodeModifier", ModType::List, wrap_mod(minion_mod), src, 0, 0, vec![]);
                }
            })
        }),
        ctor("notable passive skills in radius are transformed to instead grant: minions have (%d+)%% reduced movement speed", |a| {
            let num = a.n(1);
            Arc::new(move |node, out, data| {
                let Some(n) = node else { return };
                if n.node_type == "Notable" {
                    let src = data.mod_source.clone();
                    out.new_mod("PassiveSkillHasOtherEffect", ModType::Flag, bv(true), src.clone(), 0, 0, vec![]);
                    let speed = new_mod("MovementSpeed", ModType::Inc, Value::Num(-num), src.clone(), 0, 0, vec![]);
                    let minion_mod = new_mod("MinionModifier", ModType::List, wrap_mod(speed), None, 0, 0, vec![]);
                    out.new_mod("NodeModifier", ModType::List, wrap_mod(minion_mod), src, 0, 0, vec![]);
                }
            })
        }),
    ]
}

/// `node.type ~= "Keystone" and node.type ~= "Socket" and node.type ~= "ClassStart"`: the guard
/// shared by every "Passive Skills in Radius also grant ..." entry that excludes Socket nodes.
fn excludes_socket(t: &str) -> bool {
    t != "Keystone" && t != "Socket" && t != "ClassStart"
}

/// The common shape shared by most "Passive Skills in Radius also grant ..." entries: one flat
/// `NewMod(name, modType, num, data.modSource)` gated on `excludes_socket`.
fn grant_unless(num: f64, name: &'static str, ty: ModType, _socket_excluded: bool) -> super::jewelfunc::JewelFn {
    Arc::new(move |node, out, data| {
        let Some(n) = node else { return };
        if excludes_socket(n.node_type) {
            out.new_mod(name, ty, Value::Num(num), data.mod_source.clone(), 0, 0, vec![]);
        }
    })
}

/// ModParser.lua:6202-6230 "Melee and Melee Weapon Type modifiers in Radius are Transformed to
/// Bow Modifiers".
fn melee_to_bow() -> super::jewelfunc::JewelFn {
    Arc::new(|node, out, _data| {
        let Some(n) = node else { return };
        let mask1 = mf::Axe | mf::Claw | mf::Dagger | mf::Mace | mf::Staff | mf::Sword | mf::Melee;
        let mask2 = mf::Weapon1H | mf::WeaponMelee;
        let mask3 = mf::Weapon2H | mf::WeaponMelee;
        let using_vars = ["UsingAxe", "UsingClaw", "UsingDagger", "UsingMace", "UsingStaff", "UsingSword", "UsingMeleeWeapon"];
        for m in n.mod_list {
            if m.flags & mask1 != 0 || m.flags & mask2 == mask2 || m.flags & mask3 == mask3 {
                let v = m.value.num().unwrap_or(0.0);
                out.merge_new_mod(m.name.as_str(), m.ty, -v, m.source.clone(), m.flags, m.keyword_flags, (m.tags.clone()).into());
                let new_flags = (m.flags & !(mask1 | mask2 | mask3)) | mf::Bow;
                out.merge_new_mod(m.name.as_str(), m.ty, v, m.source.clone(), new_flags, m.keyword_flags, (m.tags.clone()).into());
            } else if !m.tags.is_empty() {
                let condition_sym = crate::sym!("Condition");
                let var_sym = crate::sym!("var");
                let hits = m.tags.iter().any(|t| t.kind == condition_sym && using_vars.contains(&value_str(t.get(var_sym)).as_str()));
                if hits {
                    let v = m.value.num().unwrap_or(0.0);
                    let mut new_tags = m.tags.clone();
                    for t in new_tags.iter_mut() {
                        if t.kind == condition_sym && using_vars.contains(&value_str(t.get(var_sym)).as_str()) {
                            t.fields = t.fields.iter().map(|(k, val)| if *k == var_sym { (*k, sv("UsingBow")) } else { (*k, val.clone()) }).collect();
                            break;
                        }
                    }
                    out.merge_new_mod(m.name.as_str(), m.ty, -v, m.source.clone(), m.flags, m.keyword_flags, (m.tags.clone()).into());
                    out.merge_new_mod(m.name.as_str(), m.ty, v, m.source.clone(), m.flags, m.keyword_flags, (new_tags).into());
                }
            }
        }
    })
}
fn value_str(v: &Value) -> String {
    match v {
        Value::Str(s) => s.to_string(),
        _ => String::new(),
    }
}

/// jewelSelfFuncs (ModParser.lua:6378-6408, "Self" kind: applied only to allocated nodes in
/// radius, gated by the calc engine, not by this closure).
pub fn self_entries() -> Vec<JewelTableEntry> {
    let s = |pattern: &'static str, f: super::jewelfunc::JewelFn| JewelTableEntry { pattern, kind: JewelKind::SelfAlloc, entry: JewelEntry::Fixed(f) };
    vec![
        s("adds 1 to maximum life per 3 intelligence in radius", get_per_stat("Life", ModType::Base, 0, "Int", 1.0 / 3.0)),
        s("adds 1 to maximum life per 3 intelligence allocated in radius", get_per_stat("Life", ModType::Base, 0, "Int", 1.0 / 3.0)),
        s("1% increased evasion rating per 3 dexterity allocated in radius", get_per_stat("Evasion", ModType::Inc, 0, "Dex", 1.0 / 3.0)),
        s("1% increased claw physical damage per 3 dexterity allocated in radius", get_per_stat("PhysicalDamage", ModType::Inc, mf::Claw, "Dex", 1.0 / 3.0)),
        s(
            "1% increased melee physical damage while unarmed per 3 dexterity allocated in radius",
            get_per_stat("PhysicalDamage", ModType::Inc, mf::Unarmed, "Dex", 1.0 / 3.0),
        ),
        s("3% increased totem life per 10 strength in radius", get_per_stat("TotemLife", ModType::Inc, 0, "Str", 3.0 / 10.0)),
        s("3% increased totem life per 10 strength allocated in radius", get_per_stat("TotemLife", ModType::Inc, 0, "Str", 3.0 / 10.0)),
        s(
            "adds 1 maximum lightning damage to attacks per 1 dexterity allocated in radius",
            get_per_stat("LightningMax", ModType::Base, mf::Attack, "Dex", 1.0),
        ),
        s("5% increased chaos damage per 10 intelligence from allocated passives in radius", get_per_stat("ChaosDamage", ModType::Inc, 0, "Int", 5.0 / 10.0)),
        JewelTableEntry {
            pattern: "dexterity and intelligence from passives in radius count towards strength melee damage bonus",
            kind: JewelKind::SelfAlloc,
            entry: JewelEntry::Fixed(Arc::new(|node, out, data| {
                if let Some(n) = node {
                    data.add("Dex", sum_mods(n.mod_list, ModType::Base, "Dex"));
                    data.add("Int", sum_mods(n.mod_list, ModType::Base, "Int"));
                } else if data.touched("Dex") || data.touched("Int") {
                    out.new_mod("DexIntToMeleeBonus", ModType::Base, Value::Num(data.get("Dex") + data.get("Int")), data.mod_source.clone(), 0, 0, vec![]);
                }
            })),
        },
        s("-1 strength per 1 strength on allocated passives in radius", get_per_stat("Str", ModType::Base, 0, "Str", -1.0)),
        s(
            "1% additional physical damage reduction per 10 strength on allocated passives in radius",
            get_per_stat("PhysicalDamageReduction", ModType::Base, 0, "Str", 1.0 / 10.0),
        ),
        s("2% increased life recovery rate per 10 strength on allocated passives in radius", get_per_stat("LifeRecoveryRate", ModType::Inc, 0, "Str", 2.0 / 10.0)),
        s("3% increased life recovery rate per 10 strength on allocated passives in radius", get_per_stat("LifeRecoveryRate", ModType::Inc, 0, "Str", 3.0 / 10.0)),
        s("-1 intelligence per 1 intelligence on allocated passives in radius", get_per_stat("Int", ModType::Base, 0, "Int", -1.0)),
        s(
            "0.4% of energy shield regenerated per second for every 10 intelligence on allocated passives in radius",
            get_per_stat("EnergyShieldRegenPercent", ModType::Base, 0, "Int", 0.4 / 10.0),
        ),
        s(
            "regenerate 0.4% of energy shield per second for every 10 intelligence on allocated passives in radius",
            get_per_stat("EnergyShieldRegenPercent", ModType::Base, 0, "Int", 0.4 / 10.0),
        ),
        s("2% increased mana recovery rate per 10 intelligence on allocated passives in radius", get_per_stat("ManaRecoveryRate", ModType::Inc, 0, "Int", 2.0 / 10.0)),
        s("3% increased mana recovery rate per 10 intelligence on allocated passives in radius", get_per_stat("ManaRecoveryRate", ModType::Inc, 0, "Int", 3.0 / 10.0)),
        s("-1 dexterity per 1 dexterity on allocated passives in radius", get_per_stat("Dex", ModType::Base, 0, "Dex", -1.0)),
        s("2% increased movement speed per 10 dexterity on allocated passives in radius", get_per_stat("MovementSpeed", ModType::Inc, 0, "Dex", 2.0 / 10.0)),
        s("3% increased movement speed per 10 dexterity on allocated passives in radius", get_per_stat("MovementSpeed", ModType::Inc, 0, "Dex", 3.0 / 10.0)),
    ]
}

/// jewelSelfUnallocFuncs (ModParser.lua:6409-6452, "SelfUnalloc" kind: applied only to
/// unallocated nodes in radius, gated by the calc engine).
pub fn self_unalloc_entries() -> Vec<JewelTableEntry> {
    let s = |pattern: &'static str, f: super::jewelfunc::JewelFn| JewelTableEntry { pattern, kind: JewelKind::SelfUnalloc, entry: JewelEntry::Fixed(f) };
    vec![
        s("+5% to critical strike multiplier per 10 strength on unallocated passives in radius", get_per_stat("CritMultiplier", ModType::Base, 0, "Str", 5.0 / 10.0)),
        s("+7% to critical strike multiplier per 10 strength on unallocated passives in radius", get_per_stat("CritMultiplier", ModType::Base, 0, "Str", 7.0 / 10.0)),
        s("2% reduced life recovery rate per 10 strength on unallocated passives in radius", get_per_stat("LifeRecoveryRate", ModType::Inc, 0, "Str", -2.0 / 10.0)),
        s("+15 to maximum mana per 10 dexterity on unallocated passives in radius", get_per_stat("Mana", ModType::Base, 0, "Dex", 15.0 / 10.0)),
        s("+100 to accuracy rating per 10 intelligence on unallocated passives in radius", get_per_stat("Accuracy", ModType::Base, 0, "Int", 100.0 / 10.0)),
        s("+125 to accuracy rating per 10 intelligence on unallocated passives in radius", get_per_stat("Accuracy", ModType::Base, 0, "Int", 125.0 / 10.0)),
        s("2% reduced mana recovery rate per 10 intelligence on unallocated passives in radius", get_per_stat("ManaRecoveryRate", ModType::Inc, 0, "Int", -2.0 / 10.0)),
        s("+3% to damage over time multiplier per 10 intelligence on unallocated passives in radius", get_per_stat("DotMultiplier", ModType::Base, 0, "Int", 3.0 / 10.0)),
        s("2% reduced movement speed per 10 dexterity on unallocated passives in radius", get_per_stat("MovementSpeed", ModType::Inc, 0, "Dex", -2.0 / 10.0)),
        s("+125 to accuracy rating per 10 dexterity on unallocated passives in radius", get_per_stat("Accuracy", ModType::Base, 0, "Dex", 125.0 / 10.0)),
        JewelTableEntry {
            pattern: "grants all bonuses of unallocated small passive skills in radius",
            kind: JewelKind::SelfUnalloc,
            entry: JewelEntry::Fixed(grants_all_bonuses("Normal")),
        },
        JewelTableEntry {
            pattern: "grants all bonuses of unallocated notable passive skills in radius",
            kind: JewelKind::SelfUnalloc,
            entry: JewelEntry::Fixed(grants_all_bonuses("Notable")),
        },
    ]
}

