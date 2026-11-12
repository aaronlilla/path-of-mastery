// Port of ModParser.lua specialModList, lines 2130-4040. Work in progress: entries that call
// gemIdLookup/grantedExtraSkill/triggerExtraSkill/extraSupport are deferred until
// special/helpers.rs (owned by the special_b.rs porter) lands.
use super::helpers::{extra_support, gem_id_lookup, granted_extra_skill, trigger_extra_skill, TriggerOptions};
use super::support::{b, ext_skill_map, explode_func, first_upper, flag_mod, flags, kw, mk_mod, num, s, src, stag, title_case, tg, wrap, SpecialVal};
use crate::modparser::flags::{keyword_flag as kf, mod_flag as mf};
use crate::modparser::types::PVal;


fn part1() -> Vec<(&'static str, SpecialVal)> {
    vec![
    ]
}

fn part2() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // Explode mods (2132-2196)
        ("enemies you kill have a (%d+)%% chance to explode, dealing a (.+) of their maximum life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![]))),
        ("enemies you kill have ?a? ?(%d+)%% chance to explode, dealing (%d+)%% of their maximum life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![]))),
        ("enemies you or your totems kill have (%d+)%% chance to explode, dealing (%d+)%% of their maximum life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![]))),
        ("enemies you kill while using pride have (%d+)%% chance to explode, dealing a (.+) of their maximum life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![stag("Condition", vec![("var", s("AffectedByPride"))])]))),
        ("enemies you kill during effect have a (%d+)%% chance to explode, dealing a (.+) of their maximum life as damage of a random element",
            Func(|a| explode_func(a.n(1), a.s(2), "randomElement", vec![stag("Condition", vec![("var", s("UsingFlask"))])]))),
        ("enemies you kill while affected by glorious madness have a (%d+)%% chance to explode, dealing a (.+) of their life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![stag("Condition", vec![("var", s("AffectedByGloriousMadness"))])]))),
        ("enemies killed with attack hits have a (%d+)%% chance to explode, dealing a (.+) of their life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![]))),
        ("enemies killed with wand hits have a (%d+)%% chance to explode, dealing a (.+) of their life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![stag("Condition", vec![("var", s("UsingWand"))])]))),
        ("cursed enemies you or your minions kill have a (%d+)%% chance to explode, dealing a (.+) of their maximum life as (.+) damage",
            Func(|a| explode_func(a.n(1), a.s(2), a.s(3), vec![stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))])]))),
        ("enemies you kill explode, dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![]))),
        ("enemies killed explode dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![]))),
        ("enemies on fungal ground you kill explode, dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnFungalGround"))])]))),
        ("enemies killed with attack or spell hits explode, dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![]))),
        ("shocked enemies you kill explode, dealing (%d+)%% of their life as (.+) damage which cannot shock",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Shocked"))])]))),
        ("ignited enemies you kill explode, dealing (%d+)%% of their life as (.+) damage which cannot ignite",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))])]))),
        ("bleeding enemies you kill explode, dealing (%d+)%% of their maximum life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Bleeding"))])]))),
        ("burning enemies you kill have a (%d+)%% chance to explode, dealing a (.+) of their maximum life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Burning"))])]))),
        // Lua source key is genuinely "non-aura..." with an UNESCAPED hyphen (ModParser.lua:2183):
        // since Lua's `-` is a lazy quantifier, not a literal hyphen, this pattern never actually
        // matches the line it names, and real parseMod falls through to leave it unparsed. This
        // looks identical to the real hyphen-escaping bug class fixed elsewhere in this file, but
        // here the "bug" is in the original source and must be reproduced exactly, not corrected.
        ("non-aura curses you inflict are not removed from dying enemies", Mods(vec![])),
        ("enemies near corpses affected by your curses are blinded",
            Mods(vec![wrap("EnemyModifier", flag_mod("Condition:Blinded", vec![]),
                vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyCorpse")), ("threshold", num(1.0))])),
                     tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))])])),
        ("enemies killed near corpses affected by your curses explode, dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![
                stag("MultiplierThreshold", vec![("var", s("NearbyCorpse")), ("threshold", num(1.0))]),
                stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]),
            ]))),
        ("enemies taunted by your warcries explode on death, dealing (%d+)%% of their maximum life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![
                stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Taunted"))]),
                stag("Condition", vec![("var", s("UsedWarcryRecently"))]),
            ]))),
        ("totems explode on death, dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![]))),
        ("nearby corpses explode when you warcry, dealing (%d+)%% of their life as (.+) damage",
            Func(|a| explode_func(100.0, a.s(1), a.s(2), vec![]))),

    ]
}

fn part3() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // Keystones (2198-2279)
        ("(%d+) rage regenerated for every (%d+) mana regeneration per second", Func(|a| Some(vec![
            mk_mod("RageRegen", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ManaRegen")), ("div", num(a.n(2)))]))]),
            flag_mod("Condition:CanGainRage", vec![]),
        ]))),
        ("(%w+) recovery from regeneration is not applied", Func(|a| Some(vec![flag_mod(format!("UnaffectedBy{}Regen", first_upper(a.s(1))), vec![])]))),
        ("(%d+)%% less damage taken for every (%d+)%% life recovery per second from leech", Func(|a| Some(vec![
            mk_mod("DamageTaken", "MORE", num(-a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("MaxLifeLeechRatePercent")), ("div", num(a.n(2)))]))]),
        ]))),
        ("(%w+) recovery from non%-instant leech is not applied", Func(|a| Some(vec![flag_mod(format!("UnaffectedByNonInstant{}Leech", first_upper(a.s(1))), vec![])]))),
        ("(%d+)%% additional physical damage reduction for every (%d+)%% life recovery per second from leech", Func(|a| Some(vec![
            mk_mod("PhysicalDamageReduction", "BASE", num(a.n(1)), vec![
                tg(stag("PerStat", vec![("stat", s("MaxLifeLeechRatePercent")), ("div", num(a.n(2)))])),
                tg(stag("Condition", vec![("var", s("Leeching"))])),
            ]),
        ]))),
        ("modifiers to chance to suppress spell damage instead apply to chance to dodge spell hits at 50%% of their value", Mods(vec![
            flag_mod("ConvertSpellSuppressionToSpellDodge", vec![]),
            mk_mod("SpellSuppressionChance", "OVERRIDE", num(0.0), vec![src("Acrobatics")]),
        ])),
        ("chance to evade hits is based off of (%d+)%% of your ward instead of your evasion rating", Func(|a| Some(vec![
            flag_mod("EvadeChanceBasedOnWard", vec![]),
            mk_mod("EvadeChanceBasedOnWardPercent", "OVERRIDE", num(a.n(1)), vec![src("Black Scythe Training")]),
        ]))),
        ("physical damage reduction from hits is based off of (%d+)%% of your ward instead of your armour", Func(|a| Some(vec![
            flag_mod("PhysicalReductionBasedOnWard", vec![]),
            mk_mod("PhysicalReductionBasedOnWardPercent", "OVERRIDE", num(a.n(1)), vec![src("Black Scythe Training")]),
        ]))),
        ("maximum chance to dodge spell hits is (%d+)%%", Func(|a| Some(vec![mk_mod("SpellDodgeChanceMax", "OVERRIDE", num(a.n(1)), vec![src("Acrobatics")])]))),
        ("dexterity provides no bonus to evasion rating", Mods(vec![flag_mod("NoDexBonusToEvasion", vec![])])),
        ("dexterity provides no inherent bonus to evasion rating", Mods(vec![flag_mod("NoDexBonusToEvasion", vec![])])),
        ("strength's damage bonus applies to all spell damage as well", Mods(vec![flag_mod("IronWill", vec![])])),
        ("your hits can't be evaded", Mods(vec![flag_mod("CannotBeEvaded", vec![])])),
        ("your melee hits can't be evaded while wielding a sword", Mods(vec![
            flag_mod("CannotBeEvaded", vec![flags(mf::Melee | mf::Hit), tg(stag("Condition", vec![("var", s("UsingSword"))]))]),
        ])),
        ("minion hits can't be evaded", Mods(vec![wrap("MinionModifier", flag_mod("CannotBeEvaded", vec![]), vec![])])),
        ("never deal critical strikes", Mods(vec![flag_mod("NeverCrit", vec![]), flag_mod("Condition:NeverCrit", vec![])])),
        ("minions never deal critical strikes", Mods(vec![
            wrap("MinionModifier", flag_mod("NeverCrit", vec![]), vec![]),
            wrap("MinionModifier", flag_mod("Condition:NeverCrit", vec![]), vec![]),
        ])),
        ("never deal critical strikes with spells", Mods(vec![flag_mod("NeverCrit", vec![flags(mf::Spell)]), flag_mod("Condition:NeverCrit", vec![flags(mf::Spell)])])),
        ("never deal critical strikes with attacks", Mods(vec![flag_mod("NeverCrit", vec![flags(mf::Attack)]), flag_mod("Condition:NeverCrit", vec![flags(mf::Attack)])])),
        ("cannot deal critical strikes", Mods(vec![flag_mod("NeverCrit", vec![]), flag_mod("Condition:NeverCrit", vec![])])),
        ("cannot deal critical strikes with spells", Mods(vec![flag_mod("NeverCrit", vec![flags(mf::Spell)]), flag_mod("Condition:NeverCrit", vec![flags(mf::Spell)])])),
        ("cannot deal critical strikes with attacks", Mods(vec![flag_mod("NeverCrit", vec![flags(mf::Attack)]), flag_mod("Condition:NeverCrit", vec![flags(mf::Attack)])])),
        ("no critical strike multiplier", Mods(vec![flag_mod("NoCritMultiplier", vec![])])),
        ("ailments never count as being from critical strikes", Mods(vec![flag_mod("AilmentsAreNeverFromCrit", vec![])])),
        ("the increase to physical damage from strength applies to projectile attacks as well as melee attacks", Mods(vec![flag_mod("IronGrip", vec![])])),
        ("strength's damage bonus applies to projectile attack damage as well as melee damage", Mods(vec![flag_mod("IronGrip", vec![])])),
        ("converts all evasion rating to armour. dexterity provides no bonus to evasion rating", Mods(vec![flag_mod("NoDexBonusToEvasion", vec![]), flag_mod("IronReflexes", vec![])])),
        ("30%% chance to dodge attack hits. 50%% less armour, 30%% less energy shield, 30%% less chance to block spell and attack damage", Mods(vec![
            mk_mod("AttackDodgeChance", "BASE", num(30.0), vec![]),
            mk_mod("Armour", "MORE", num(-50.0), vec![]),
            mk_mod("EnergyShield", "MORE", num(-30.0), vec![]),
            mk_mod("BlockChance", "MORE", num(-30.0), vec![]),
            mk_mod("SpellBlockChance", "MORE", num(-30.0), vec![]),
        ])),
        ("(%d+)%% increased blind effect", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("BlindEffect", "INC", num(a.n(1)), vec![]), vec![])]))),
        ("(%d+)%% increased effect of blind from melee weapons", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("BlindEffect", "INC", num(a.n(1)), vec![]), vec![])]))),
        ("%+(%d+)%% chance to block spell damage for each (%d+)%% overcapped chance to block attack damage", Func(|a| Some(vec![
            mk_mod("SpellBlockChance", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("BlockChanceOverCap")), ("div", num(a.n(2)))]))]),
        ]))),
        ("maximum life becomes 1, immune to chaos damage", Mods(vec![flag_mod("ChaosInoculation", vec![]), mk_mod("ChaosDamageTaken", "MORE", num(-100.0), vec![])])),
        ("life regeneration is applied to energy shield instead", Mods(vec![flag_mod("ZealotsOath", vec![])])),
        ("life leeched per second is doubled", Mods(vec![mk_mod("LifeLeechRate", "MORE", num(100.0), vec![])])),
        ("life regeneration has no effect", Mods(vec![flag_mod("NoLifeRegen", vec![])])),
        ("cannot regenerate or recoup life", Mods(vec![flag_mod("NoLifeRegen", vec![])])),
        ("energy shield recharge instead applies to life", Mods(vec![flag_mod("EnergyShieldRechargeAppliesToLife", vec![])])),
        ("blade vortex and blade blast deal no non%-physical damage", Mods(vec![
            flag_mod("DealNoLightning", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blade Vortex"), s("Blade Blast")])), ("includeTransfigured", b(true))]))]),
            flag_mod("DealNoCold", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blade Vortex"), s("Blade Blast")])), ("includeTransfigured", b(true))]))]),
            flag_mod("DealNoFire", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blade Vortex"), s("Blade Blast")])), ("includeTransfigured", b(true))]))]),
            flag_mod("DealNoChaos", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blade Vortex"), s("Blade Blast")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("(%d+)%% of physical, cold and lightning damage converted to fire damage", Func(|a| Some(vec![
            mk_mod("PhysicalDamageConvertToFire", "BASE", num(a.n(1)), vec![]),
            mk_mod("LightningDamageConvertToFire", "BASE", num(a.n(1)), vec![]),
            mk_mod("ColdDamageConvertToFire", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("all elemental damage converted to chaos damage", Mods(vec![
            mk_mod("ColdDamageConvertToChaos", "BASE", num(100.0), vec![]),
            mk_mod("FireDamageConvertToChaos", "BASE", num(100.0), vec![]),
            mk_mod("LightningDamageConvertToChaos", "BASE", num(100.0), vec![]),
        ])),
        ("removes all mana. spend life instead of mana for skills", Mods(vec![mk_mod("Mana", "MORE", num(-100.0), vec![]), flag_mod("CostLifeInsteadOfMana", vec![])])),
        ("removes all mana", Mods(vec![mk_mod("Mana", "MORE", num(-100.0), vec![])])),
        ("removes all energy shield", Mods(vec![mk_mod("EnergyShield", "MORE", num(-100.0), vec![])])),
        ("skills cost life instead of mana", Mods(vec![flag_mod("CostLifeInsteadOfMana", vec![])])),
        ("skills reserve life instead of mana", Mods(vec![flag_mod("BloodMagicReserved", vec![])])),
        ("your skills that throw mines reserve life instead of mana", Mods(vec![flag_mod("BloodMagicReserved", vec![kw(kf::Mine)])])),
        ("curse skills cost life instead of mana", Mods(vec![flag_mod("CostLifeInsteadOfMana", vec![kw(kf::Curse)])])),
        ("curse aura skills reserve life instead of mana", Mods(vec![flag_mod("BloodMagicReserved", vec![kw(kf::Curse), tg(stag("SkillType", vec![("skillType", num(39.0))]))])])),
        ("your travel skills critically strike once every 3 uses", Mods(vec![flag_mod("Every3UseCrit", vec![tg(stag("SkillType", vec![("skillType", num(79.0))]))])])),
        ("non%-aura skills cost no mana or life while focused", Mods(vec![
            mk_mod("ManaCost", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Focused"))])), tg(stag("SkillType", vec![("skillType", num(39.0)), ("neg", b(true))]))]),
            mk_mod("LifeCost", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Focused"))])), tg(stag("SkillType", vec![("skillType", num(39.0)), ("neg", b(true))]))]),
        ])),
        ("non%-aura skills cost no mana or life while focussed", Mods(vec![
            mk_mod("ManaCost", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Focused"))])), tg(stag("SkillType", vec![("skillType", num(39.0)), ("neg", b(true))]))]),
            mk_mod("LifeCost", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Focused"))])), tg(stag("SkillType", vec![("skillType", num(39.0)), ("neg", b(true))]))]),
        ])),
        ("spend life instead of mana for effects of skills", Mods(vec![])),
        ("skills cost %+(%d+) rage", Func(|a| Some(vec![mk_mod("RageCostBase", "BASE", num(a.n(1)), vec![])]))),
        ("warcries cost %+(%d+)%% of life", Func(|a| Some(vec![
            mk_mod("LifeCostBase", "BASE", num(1.0), vec![kw(kf::Warcry), tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1))), ("floor", b(true))]))]),
        ]))),
        ("vaal skills used during effect have (%d+)%% reduced soul gain prevention duration", Func(|a| Some(vec![
            mk_mod("SoulGainPreventionDuration", "INC", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("SkillType", vec![("skillType", num(38.0))]))]),
        ]))),
        ("vaal volcanic fissure and vaal molten strike have (%d+)%% reduced soul gain prevention duration", Func(|a| Some(vec![
            mk_mod("SoulGainPreventionDuration", "INC", num(-a.n(1)), vec![
                tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Volcanic Fissure"), s("Molten Strike")])), ("includeTransfigured", b(true))])),
                tg(stag("SkillType", vec![("skillType", num(38.0))])),
            ]),
        ]))),
        ("vaal skills can store %+(%d+) uses?", Func(|a| Some(vec![mk_mod("AdditionalUses", "BASE", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(38.0))]))])]))),
        ("vaal attack skills cost rage instead of requiring souls to use", Mods(vec![flag_mod("CostRageInsteadOfSouls", vec![flags(mf::Attack), tg(stag("SkillType", vec![("skillType", num(38.0))]))])])),
        ("vaal attack skills you use yourself cost rage instead of requiring souls", Mods(vec![flag_mod("CostRageInsteadOfSouls", vec![flags(mf::Attack), tg(stag("SkillType", vec![("skillType", num(38.0))]))])])),
        ("you cannot gain rage during soul gain prevention", Mods(vec![mk_mod("RageRegen", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("SoulGainPrevention"))]))])])),

    ]
}

fn part4() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 2450-2599
        ("(%d+)%% more attack damage if accuracy rating is higher than maximum life", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![src("Damage"), flags(mf::Attack), tg(stag("Condition", vec![("var", s("MainHandAccRatingHigherThanMaxLife"))])), tg(stag("Condition", vec![("var", s("MainHandAttack"))]))]),
            mk_mod("Damage", "MORE", num(a.n(1)), vec![src("Damage"), flags(mf::Attack), tg(stag("Condition", vec![("var", s("OffHandAccRatingHigherThanMaxLife"))])), tg(stag("Condition", vec![("var", s("OffHandAttack"))]))]),
        ]))),
        ("your hexes have infinite duration", Mods(vec![mk_mod("Duration", "BASE", num(f64::INFINITY), vec![tg(stag("SkillType", vec![("skillType", num(69.0))]))])])),
        ("(%d+)%% chance to defend with double your armour for each time you've been hit by an enemy recently, up to (%d+)%%", Func(|a| Some(vec![
            mk_mod("ArmourDefense", "MAX", num(100.0), vec![src("Armour Mastery: Max Calc"), tg(stag("Condition", vec![("var", s("ArmourMax"))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).min(1.0) * 100.0), vec![src("Armour Mastery: Average Calc"), tg(stag("Condition", vec![("var", s("ArmourAvg"))])), tg(stag("Multiplier", vec![("var", s("BeenHitRecently")), ("limit", num(a.n(2) / a.n(1)))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).floor().min(1.0) * 100.0), vec![src("Armour Mastery: Min Calc"), tg(stag("Condition", vec![("var", s("ArmourMax")), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("ArmourAvg")), ("neg", b(true))])), tg(stag("Multiplier", vec![("var", s("BeenHitRecently")), ("limit", num(a.n(2) / a.n(1)))]))]),
        ]))),
        ("(%d+)%% chance to defend with (%d+)%% of armour for each time you've been hit by an enemy recently, up to (%d+)%%", Func(|a| Some(vec![
            mk_mod("ArmourDefense", "MAX", num(a.n(2) - 100.0), vec![src("Armour Mastery: Max Calc"), tg(stag("Condition", vec![("var", s("ArmourMax"))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).min(1.0) * (a.n(2) - 100.0)), vec![src("Armour Mastery: Average Calc"), tg(stag("Condition", vec![("var", s("ArmourAvg"))])), tg(stag("Multiplier", vec![("var", s("BeenHitRecently")), ("limit", num(a.n(3) / a.n(1)))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).floor().min(1.0) * (a.n(2) - 100.0)), vec![src("Armour Mastery: Min Calc"), tg(stag("Condition", vec![("var", s("ArmourMax")), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("ArmourAvg")), ("neg", b(true))])), tg(stag("Multiplier", vec![("var", s("BeenHitRecently")), ("limit", num(a.n(3) / a.n(1)))]))]),
        ]))),
        ("(%d+)%% chance to defend with double armour", Func(|a| Some(vec![
            mk_mod("ArmourDefense", "MAX", num(100.0), vec![src("Armour Mastery: Max Calc"), tg(stag("Condition", vec![("var", s("ArmourMax"))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).min(1.0) * 100.0), vec![src("Armour Mastery: Average Calc"), tg(stag("Condition", vec![("var", s("ArmourAvg"))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).floor().min(1.0) * 100.0), vec![src("Armour Mastery: Min Calc"), tg(stag("Condition", vec![("var", s("ArmourMax")), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("ArmourAvg")), ("neg", b(true))]))]),
        ]))),
        ("hits have (%d+)%% chance to treat enemy monster elemental resistance values as inverted", Func(|a| Some(vec![mk_mod("HitsInvertEleResChance", "CHANCE", num(a.n(1) / 100.0), vec![])]))),
        ("off hand accuracy is equal to main hand accuracy while wielding a sword", Mods(vec![flag_mod("Condition:OffHandAccuracyIsMainHandAccuracy", vec![tg(stag("Condition", vec![("var", s("UsingSword"))]))])])),
        ("(%d+)%% increased accuracy rating at close range", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AtCloseRange"))]))])]))),
        ("(%d+)%% more accuracy rating at close range", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AtCloseRange"))]))])]))),
        ("(%d+)%% increased accuracy rating against unique enemies", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])]))),
        ("(%d+)%% more accuracy rating against unique enemies", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "MORE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])]))),
        ("(%d+)%% chance to defend with (%d+)%% of armour", Func(|a| Some(vec![
            mk_mod("ArmourDefense", "MAX", num(a.n(2) - 100.0), vec![src("Armour Mastery: Max Calc"), tg(stag("Condition", vec![("var", s("ArmourMax"))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).min(1.0) * (a.n(2) - 100.0)), vec![src("Armour Mastery: Average Calc"), tg(stag("Condition", vec![("var", s("ArmourAvg"))]))]),
            mk_mod("ArmourDefense", "MAX", num((a.n(1) / 100.0).floor().min(1.0) * (a.n(2) - 100.0)), vec![src("Armour Mastery: Min Calc"), tg(stag("Condition", vec![("var", s("ArmourMax")), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("ArmourAvg")), ("neg", b(true))]))]),
        ]))),
        ("defend with (%d+)%% of armour while not on low energy shield", Func(|a| Some(vec![
            mk_mod("ArmourDefense", "MAX", num(a.n(1) - 100.0), vec![src("Armour and Energy Shield Mastery"), tg(stag("Condition", vec![("var", s("LowEnergyShield")), ("neg", b(true))]))]),
        ]))),
        ("(%d+)%% increased armour and energy shield from equipped body armour if equipped helmet, gloves and boots all have armour and energy shield", Func(|a| Some(vec![
            mk_mod("Body ArmourESAndArmour", "INC", num(a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("ArmourOnGloves")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("EnergyShieldOnGloves")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("ArmourOnHelmet")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("EnergyShieldOnHelmet")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("ArmourOnBoots")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("EnergyShieldOnBoots")), ("threshold", num(1.0))])),
            ]),
        ]))),
        ("brands have (%d+)%% increased area of effect if (%d+)%% of attached duration expired", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("BrandLastHalf"))])), tg(stag("SkillType", vec![("skillType", num(65.0))]))]),
        ]))),
        ("corrupted blood cannot be inflicted on you", Mods(vec![flag_mod("CorruptedBloodImmune", vec![])])),
        ("you cannot be hindered", Mods(vec![flag_mod("HinderImmune", vec![])])),
        ("you cannot be maimed", Mods(vec![flag_mod("MaimImmune", vec![])])),
        ("you cannot be impaled", Mods(vec![flag_mod("ImpaleImmune", vec![])])),
        ("exerted attacks deal (%d+)%% increased damage", Func(|a| Some(vec![mk_mod("ExertIncrease", "INC", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("exerted attacks have (%d+)%% chance to deal double damage", Func(|a| Some(vec![mk_mod("ExertDoubleDamageChance", "BASE", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("grants (%d+) passive skill points?", Func(|a| Some(vec![mk_mod("ExtraPoints", "BASE", num(a.n(1)), vec![])]))),
        ("can allocate passives from the %a+'s starting point", Mods(vec![])),
        ("projectiles gain damage as they travel farther, dealing up to (%d+)%% increased damage with hits to targets", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Hit | mf::Projectile), tg(stag("DistanceRamp", vec![("ramp", PVal::List(vec![PVal::List(vec![num(35.0), num(0.0)]), PVal::List(vec![num(70.0), num(1.0)])]))]))]),
        ]))),
        ("(%d+)%% chance to gain elusive on kill", Mods(vec![flag_mod("Condition:CanBeElusive", vec![])])),
        ("immun[ei]t?y? to elemental ailments while on consecrated ground", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))])])),
        ("poison you inflict with critical strikes deals (%d+)%% more damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Poison), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])]))),
        ("(%d+)%% chance to gain elusive on critical strike", Mods(vec![flag_mod("Condition:CanBeElusive", vec![])])),
        ("(%d+)%% more damage while there is at most one rare or unique enemy nearby", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AtMostOneNearbyRareOrUniqueEnemy"))]))])]))),
        ("(%d+)%% reduced damage taken while there are at least two rare or unique enemies nearby", Func(|a| Some(vec![mk_mod("DamageTaken", "INC", num(-a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyRareOrUniqueEnemies")), ("threshold", num(2.0))]))])]))),
        ("(%d+)%% less damage taken while there are at least two rare or unique enemies nearby", Func(|a| Some(vec![mk_mod("DamageTaken", "MORE", num(-a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyRareOrUniqueEnemies")), ("threshold", num(2.0))]))])]))),
        ("you take no extra damage from critical strikes while elusive", Mods(vec![mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Elusive"))]))])])),
        ("mark skills cost no mana", Mods(vec![mk_mod("ManaCost", "MORE", num(-100.0), vec![tg(stag("SkillType", vec![("skillType", num(98.0))]))])])),
        ("gain %d+ rage when you kill an enemy", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage when you use a warcry", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("you and nearby party members gain %d+ rage when you warcry", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on hit with attacks, no more than once every [%d%.]+ seconds", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on attack hit", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on hit with axes or swords", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on melee hit", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on melee weapon hit", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on hit with axes", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage when hit by an enemy", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on hit with retaliation skills", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage when you use a life flask", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("while a unique enemy is in your presence, gain %d+ rage on hit with attacks, no more than once every [%d%.]+ seconds", Mods(vec![flag_mod("Condition:CanGainRage", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])])),
        ("while a pinnacle atlas boss is in your presence, gain %d+ rage on hit with attacks, no more than once every [%d%.]+ seconds", Mods(vec![flag_mod("Condition:CanGainRage", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))]))])])),
        ("maximum rage is halved", Mods(vec![mk_mod("MaximumRage", "MORE", num(-50.0), vec![])])),
        ("inherent effects from having rage are tripled", Mods(vec![mk_mod("RageEffect", "MORE", num(200.0), vec![])])),
        ("inherent effects from having rage are doubled", Mods(vec![mk_mod("RageEffect", "MORE", num(100.0), vec![])])),
        ("cannot be stunned while you have at least (%d+) rage", Func(|a| Some(vec![flag_mod("StunImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s("Rage")), ("threshold", num(a.n(1)))]))])]))),
        ("(%d+)%% less damage taken per (%d+) rage, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("DamageTaken", "MORE", num(-a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("Rage")), ("div", s(a.s(2))), ("limit", num(-a.n(3))), ("limitNegTotal", b(true))]))]),
        ]))),
        ("lose ([%d%.]+)%% of life per second per rage while you are not losing rage", Func(|a| Some(vec![
            mk_mod("LifeDegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("RageEffect"))]))]),
        ]))),
        ("if you've warcried recently, you and nearby allies have (%d+)%% increased attack speed", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Attack)]), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
        ]))),
        ("gain (%d+)%% increased armour per (%d+) power for 8 seconds when you warcry, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("Armour", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("WarcryPower")), ("div", num(a.n(2))), ("globalLimit", num(a.n(3))), ("globalLimitKey", s("WarningCall"))])), tg(stag("Condition", vec![("var", s("UsedWarcryInPast8Seconds"))]))]),
        ]))),
        ("warcries grant (%d+) rage per (%d+) power if you have less than (%d+) rage", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("warcries grant (%d+) rage per (%d+) enemy power, up to (%d+)", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("exerted attacks deal (%d+)%% more attack damage if a warcry sacrificed rage recently", Func(|a| Some(vec![mk_mod("ExertAttackIncrease", "MORE", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("deal (%d+)%% less damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(-a.n(1)), vec![])]))),
        ("warcries exert twice as many attacks", Mods(vec![mk_mod("ExtraExertedAttacks", "MORE", num(100.0), vec![])])),
        ("cannot be stunned while you have fortify", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("Fortified"))]))])])),
        ("cannot be stunned while fortified", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("Fortified"))]))])])),
        ("you cannot be stunned while at maximum endurance charges", Mods(vec![flag_mod("StunImmune", vec![tg(stag("StatThreshold", vec![("stat", s("EnduranceCharges")), ("thresholdStat", s("EnduranceChargesMax"))]))])])),
        ("fortify", Mods(vec![flag_mod("Condition:Fortified", vec![])])),
        ("you have your maximum fortification", Mods(vec![flag_mod("Condition:Fortified", vec![]), flag_mod("Condition:HaveMaxFortification", vec![])])),
        ("you have (%d+) fortification", Func(|a| Some(vec![mk_mod("MinimumFortification", "BASE", num(a.n(1)), vec![])]))),
        ("nearby allies count as having fortification equal to yours", Mods(vec![
            mk_mod("ExtraAura", "LIST", PVal::Map(vec![("onlyAllies".to_string(), b(true)), ("mod".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("YourFortifyEqualToParent", "FLAG", b(true), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])))]), vec![]),
        ])),
        ("enemies taunted by you cannot evade attacks", Mods(vec![wrap("EnemyModifier", flag_mod("CannotEvade", vec![tg(stag("Condition", vec![("var", s("Taunted"))]))]), vec![])])),
        ("if you've impaled an enemy recently, you and nearby allies have %+(%d+) to armour", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("Armour", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("ImpaledRecently"))]))]),
        ]))),
        ("your hits permanently intimidate enemies that are on full life", Mods(vec![wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![tg(stag("Condition", vec![("var", s("ChampionIntimidate"))]))]), vec![])])),

    ]
}

fn part5() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 2599-2900ish (Chieftain/Deadeye/Elementalist)
        ("you and allies affected by your placed banners regenerate ([%d%.]+)%% of life per second for each stage", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByPlacedBanner"))])), tg(stag("Multiplier", vec![("var", s("BannerValour"))]))]), vec![]),
        ]))),
        ("you and allies near your banner regenerate ([%d%.]+)%% of life per second for each valour consumed for that banner", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByPlacedBanner"))])), tg(stag("Multiplier", vec![("var", s("BannerValour"))]))]), vec![]),
        ]))),
        ("enemies near your totems take (%d+)%% increased physical and fire damage", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("PhysicalDamageTaken", "INC", num(a.n(1)), vec![]), vec![]),
            wrap("EnemyModifier", mk_mod("FireDamageTaken", "INC", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("every (%d+) seconds, gain (%d+)%% of physical damage as extra fire damage for (%d+) seconds", Func(|a| Some(vec![
            mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("NgamahuFlamesAdvance"))]))]),
        ]))),
        ("(%d+)%% more damage for each endurance charge lost recently, up to (%d+)%%", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("EnduranceChargesLostRecently")), ("limit", num(a.n(2))), ("limitTotal", b(true))]))]),
        ]))),
        ("nearby enemy monsters have no fire resistance against damage over time while you are stationary", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireResist", "OVERRIDE", num(0.0), vec![flags(mf::Dot), tg(stag("ActorCondition", vec![("actor", s("player")), ("var", s("Stationary"))]))]), vec![]),
        ])),
        ("(%d+)%% more damage if you've lost an endurance charge in the past 8 seconds", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("LostEnduranceChargeInPast8Sec"))]))])]))),
        ("projectiles pierce all nearby targets", Mods(vec![flag_mod("PierceAllTargets", vec![])])),
        ("gain %+(%d+) life when you hit a bleeding enemy", Func(|a| Some(vec![mk_mod("LifeOnHit", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Bleeding"))]))])]))),
        ("(%d+)%% increased blink arrow and mirror arrow cooldown recovery speed", Func(|a| Some(vec![
            mk_mod("CooldownRecovery", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blink Arrow"), s("Mirror Arrow")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("critical strikes which inflict bleeding also inflict rupture", Mods(vec![flag_mod("Condition:CanInflictRupture", vec![tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))])])),
        ("gain %d+ gale force when you use a skill", Mods(vec![flag_mod("Condition:CanGainGaleForce", vec![])])),
        ("if you've used a skill recently, you and nearby allies have tailwind", Mods(vec![wrap("ExtraAura", flag_mod("Condition:Tailwind", vec![]), vec![tg(stag("Condition", vec![("var", s("UsedSkillRecently"))]))])])),
        ("you and nearby allies have tailwind", Mods(vec![wrap("ExtraAura", flag_mod("Condition:Tailwind", vec![]), vec![])])),
        ("projectiles deal (%d+)%% more damage for each remaining chain", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("PerStat", vec![("stat", s("ChainRemaining"))]))])]))),
        ("projectiles deal (%d+)%% increased damage with hits and ailments for each remaining chain", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("PerStat", vec![("stat", s("ChainRemaining"))])), tg(stag("SkillType", vec![("skillType", num(3.0))]))]),
        ]))),
        ("projectiles deal (%d+)%% increased damage for each remaining chain", Func(|a| Some(vec![mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("PerStat", vec![("stat", s("ChainRemaining"))]))])]))),
        ("far shot", Mods(vec![flag_mod("FarShot", vec![])])),
        ("projectiles gain damage as they travel farther, dealing up to (%d+)%% more damage with hits and ailments", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("DistanceRamp", vec![("ramp", PVal::List(vec![PVal::List(vec![num(35.0), num(0.0)]), PVal::List(vec![num(70.0), num(1.0)])]))]))]),
        ]))),
        ("(%d+)%% increased mirage archer duration", Func(|a| Some(vec![mk_mod("MirageArcherDuration", "INC", num(a.n(1)), vec![])]))),
        ("([%-%+]%d+) to maximum number of summoned mirage archers", Func(|a| Some(vec![mk_mod("MirageArcherMaxCount", "BASE", num(a.n(1)), vec![])]))),
        ("([%-%+]%d+) to maximum number of sacred wisps", Func(|a| Some(vec![mk_mod("SacredWispsMaxCount", "BASE", num(a.n(1)), vec![])]))),
        ("gain (%d+)%% increased area of effect for %d+ seconds", Func(|a| Some(vec![mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("PendulumOfDestructionAreaOfEffect"))]))])]))),
        ("gain (%d+)%% increased elemental damage for %d+ seconds", Func(|a| Some(vec![mk_mod("ElementalDamage", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("PendulumOfDestructionElementalDamage"))]))])]))),
        ("for each element you've been hit by damage of recently, (%d+)%% increased damage of that element", Func(|a| Some(vec![
            mk_mod("FireDamage", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByFireDamageRecently"))]))]),
            mk_mod("ColdDamage", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByColdDamageRecently"))]))]),
            mk_mod("LightningDamage", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByLightningDamageRecently"))]))]),
        ]))),
        ("for each element you've been hit by damage of recently, (%d+)%% reduced damage taken of that element", Func(|a| Some(vec![
            mk_mod("FireDamageTaken", "INC", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByFireDamageRecently"))]))]),
            mk_mod("ColdDamageTaken", "INC", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByColdDamageRecently"))]))]),
            mk_mod("LightningDamageTaken", "INC", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByLightningDamageRecently"))]))]),
        ]))),
        ("gain convergence when you hit a unique enemy, no more than once every %d+ seconds", Mods(vec![flag_mod("Condition:CanGainConvergence", vec![])])),
        ("(%d+)%% increased area of effect while you don't have convergence", Func(|a| Some(vec![mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("neg", b(true)), ("var", s("Convergence"))]))])]))),
        ("exposure you inflict applies an extra (%-?%d+)%% to the affected resistance", Func(|a| Some(vec![mk_mod("ExtraExposure", "BASE", num(a.n(1)), vec![])]))),
        ("cannot take reflected elemental damage", Mods(vec![mk_mod("ElementalReflectedDamageTaken", "MORE", num(-100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("every %d+ seconds:", Mods(vec![])),
        ("gain chilling conflux for %d seconds", Mods(vec![
            flag_mod("PhysicalCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            flag_mod("LightningCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            flag_mod("FireCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            flag_mod("ChaosCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
        ])),
        ("gain shocking conflux for %d seconds", Mods(vec![
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("PhysicalCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("ColdCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("FireCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("ChaosCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
        ])),
        ("gain igniting conflux for %d seconds", Mods(vec![
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("PhysicalCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
        ])),
        ("(%d+)%% chance to gain elemental conflux for %d seconds when you kill an enemy", Mods(vec![
            flag_mod("PhysicalCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            flag_mod("LightningCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            flag_mod("FireCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            flag_mod("ChaosCanChill", vec![tg(stag("Condition", vec![("var", s("ChillingConflux"))]))]),
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("PhysicalCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("ColdCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("FireCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            flag_mod("ChaosCanShock", vec![tg(stag("Condition", vec![("var", s("ShockingConflux"))]))]),
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("PhysicalCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("Condition", vec![("var", s("IgnitingConflux"))]))]),
        ])),
        ("you have elemental conflux if the stars are aligned", Mods(vec![
            flag_mod("PhysicalCanChill", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("LightningCanChill", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("FireCanChill", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("ChaosCanChill", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("PhysicalCanShock", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("ColdCanShock", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("FireCanShock", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("ChaosCanShock", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("PhysicalCanIgnite", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))]),
        ])),
        ("gain chilling, shocking and igniting conflux for %d seconds", Mods(vec![])),
        ("you have igniting, chilling and shocking conflux while affected by glorious madness", Mods(vec![
            flag_mod("PhysicalCanChill", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("LightningCanChill", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("FireCanChill", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("ChaosCanChill", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("PhysicalCanIgnite", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("PhysicalCanShock", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("ColdCanShock", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("FireCanShock", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("ChaosCanShock", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
        ])),
        ("all damage from critical strikes can apply lightning ailments during effect", Mods(vec![
            flag_mod("PhysicalCanShock", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ColdCanShock", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("FireCanShock", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ChaosCanShock", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("PhysicalCanSap", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ColdCanSap", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("FireCanSap", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ChaosCanSap", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
        ])),
        ("all damage from critical strikes can apply cold ailments during effect", Mods(vec![
            flag_mod("PhysicalCanChill", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("LightningCanChill", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("FireCanChill", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ChaosCanChill", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("PhysicalCanFreeze", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("LightningCanFreeze", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("FireCanFreeze", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ChaosCanFreeze", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("PhysicalCanBrittle", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("LightningCanBrittle", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("FireCanBrittle", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
            flag_mod("ChaosCanBrittle", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))]))]),
        ])),
        ("immun[ei]t?y? to elemental ailments while affected by glorious madness", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))])])),
        ("immun[ei]t?y? to elemental ailments while focus?sed", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("Focused"))]))])])),
        ("summoned golems are immune to elemental damage", Mods(vec![
            wrap("MinionModifier", flag_mod("Elemancer", vec![]), vec![tg(stag("SkillType", vec![("skillType", num(51.0))]))]),
            wrap("MinionModifier", mk_mod("ElementalDamageTaken", "MORE", num(-100.0), vec![]), vec![tg(stag("SkillType", vec![("skillType", num(51.0))]))]),
        ])),
        ("(%d+)%% increased golem damage per summoned golem", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![]), vec![tg(stag("SkillType", vec![("skillType", num(51.0))])), tg(stag("PerStat", vec![("stat", s("ActiveGolemLimit"))]))]),
        ]))),
        ("shocks from your hits always increase damage taken by at least (%d+)%%", Func(|a| Some(vec![mk_mod("ShockMinimum", "BASE", num(a.n(1)), vec![])]))),
        ("chills from your hits always reduce action speed by at least (%d+)%%", Func(|a| Some(vec![mk_mod("ChillBase", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% more damage with ignites you inflict with hits for which the highest damage type is fire", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Ignite), tg(stag("Condition", vec![("var", s("FireIsHighestDamageType"))]))]),
            flag_mod("ChecksHighestDamage", vec![]),
        ]))),
        ("(%d+)%% more effect of cold ailments you inflict with hits for which the highest damage type is cold", Func(|a| Some(vec![
            mk_mod("EnemyChillEffect", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ColdIsHighestDamageType"))]))]),
            mk_mod("EnemyBrittleEffect", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ColdIsHighestDamageType"))]))]),
            flag_mod("ChecksHighestDamage", vec![]),
        ]))),
        ("(%d+)%% more effect of lightning ailments you inflict with hits if the highest damage type is lightning", Func(|a| Some(vec![
            mk_mod("EnemyShockEffect", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("LightningIsHighestDamageType"))]))]),
            mk_mod("EnemySapEffect", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("LightningIsHighestDamageType"))]))]),
            flag_mod("ChecksHighestDamage", vec![]),
        ]))),
        ("your chills can reduce action speed by up to a maximum of (%d+)%%", Func(|a| Some(vec![mk_mod("ChillMax", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("your hits always ignite", Mods(vec![mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![])])),
        ("hits always ignite", Mods(vec![mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![])])),
        ("your hits always shock", Mods(vec![mk_mod("EnemyShockChance", "BASE", num(100.0), vec![])])),
        ("hits always shock", Mods(vec![mk_mod("EnemyShockChance", "BASE", num(100.0), vec![])])),
        ("always freeze, shock and ignite", Mods(vec![
            mk_mod("EnemyFreezeChance", "BASE", num(100.0), vec![]),
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![]),
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![]),
        ])),
        ("all damage with hits can ignite", Mods(vec![flag_mod("PhysicalCanIgnite", vec![]), flag_mod("ColdCanIgnite", vec![]), flag_mod("LightningCanIgnite", vec![]), flag_mod("ChaosCanIgnite", vec![])])),
        ("all damage can ignite", Mods(vec![flag_mod("PhysicalCanIgnite", vec![]), flag_mod("ColdCanIgnite", vec![]), flag_mod("LightningCanIgnite", vec![]), flag_mod("ChaosCanIgnite", vec![])])),
        ("all damage with hits can chill", Mods(vec![flag_mod("PhysicalCanChill", vec![]), flag_mod("FireCanChill", vec![]), flag_mod("LightningCanChill", vec![]), flag_mod("ChaosCanChill", vec![])])),
        ("all damage with hits can shock", Mods(vec![flag_mod("PhysicalCanShock", vec![]), flag_mod("FireCanShock", vec![]), flag_mod("ColdCanShock", vec![]), flag_mod("ChaosCanShock", vec![])])),
        ("all damage can shock", Mods(vec![flag_mod("PhysicalCanShock", vec![]), flag_mod("FireCanShock", vec![]), flag_mod("ColdCanShock", vec![]), flag_mod("ChaosCanShock", vec![])])),
        ("other aegis skills are disabled", Mods(vec![
            flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(99.0))]))]),
            flag_mod("EnableSkill", vec![tg(stag("SkillName", vec![("skillId", s("Primal Aegis"))]))]),
        ])),
        ("primal aegis can take (%d+) elemental damage per allocated notable passive skill", Func(|a| Some(vec![
            mk_mod("ElementalAegisValue", "MAX", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("AllocatedNotable"))])), tg(stag("GlobalEffect", vec![("effectType", s("Buff")), ("unscalable", b(true))]))]),
        ]))),
        ("enemies chilled by your hits lessen their damage dealt by half of chill effect", Mods(vec![flag_mod("ChillEffectLessDamageDealt", vec![])])),
        ("chance to block spell damage is equal to chance to block attack damage", Mods(vec![flag_mod("SpellBlockChanceIsBlockChance", vec![])])),
        ("maximum chance to block spell damage is equal to maximum chance to block attack damage", Mods(vec![flag_mod("SpellBlockChanceMaxIsBlockChanceMax", vec![])])),
        ("attack damage is lucky if you[' ]h?a?ve blocked in the past (%d+) seconds", Mods(vec![flag_mod("LuckyHits", vec![flags(mf::Attack), tg(stag("Condition", vec![("var", s("BlockedRecently"))]))])])),
        ("attack damage while dual wielding is lucky if you[' ]h?a?ve blocked in the past (%d+) seconds", Mods(vec![flag_mod("LuckyHits", vec![flags(mf::Attack), tg(stag("Condition", vec![("var", s("BlockedRecently"))])), tg(stag("Condition", vec![("var", s("DualWielding"))]))])])),
        ("hits ignore enemy monster physical damage reduction if you[' ]h?a?ve blocked in the past (%d+) seconds", Mods(vec![flag_mod("IgnoreEnemyPhysicalDamageReduction", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))])])),
        ("(%d+)%% more attack and movement speed per challenger charge", Func(|a| Some(vec![
            mk_mod("Speed", "MORE", num(a.n(1)), vec![flags(mf::Attack), tg(stag("Multiplier", vec![("var", s("ChallengerCharge"))]))]),
            mk_mod("MovementSpeed", "MORE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("ChallengerCharge"))]))]),
        ]))),
        ("gain (%d+)%% chance to block from equipped shield instead of the shield's value", Func(|a| Some(vec![mk_mod("ReplaceShieldBlock", "OVERRIDE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingShield"))]))])]))),
        ("deal (%d+)%% more damage with hits and ailments to rare and unique enemies for each second they've ever been in your presence, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("Multiplier", vec![("var", s("EnemyPresenceSeconds")), ("actor", s("enemy")), ("limit", num(a.n(2)))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))]),
        ]))),
        ("deal (%d+)%% more damage with hits and ailments to rare and unique enemies for every (%d+) seconds they've ever been in your presence, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            // Lua: div = div (line 2863, no tonumber) -- stays a raw string; limit = tonumber(limit) stays numeric.
            mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("Multiplier", vec![("var", s("EnemyPresenceSeconds")), ("actor", s("enemy")), ("limit", num(a.n(3))), ("div", s(a.s(2)))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))]),
        ]))),
        ("(%d+)%% more damage with hits and ailments against enemies that are on low life while you are wielding an axe", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("LowLife"))])), tg(stag("Condition", vec![("var", s("UsingAxe"))]))]),
        ]))),
        ("retaliation skills have (%d+)%% increased speed", Func(|a| Some(vec![
            mk_mod("Speed", "INC", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(121.0))]))]),
            mk_mod("WarcrySpeed", "INC", num(a.n(1)), vec![kw(kf::Warcry), tg(stag("SkillType", vec![("skillType", num(121.0))]))]),
        ]))),
        ("grants armour equal to (%d+)%% of your reserved life to you and nearby allies", Func(|a| Some(vec![wrap("GrantReservedLifeAsAura", mk_mod("Armour", "BASE", num(a.n(1) / 100.0), vec![]), vec![])]))),
        ("grants armour equal to (%d+)%% of your reserved mana to you and nearby allies", Func(|a| Some(vec![wrap("GrantReservedManaAsAura", mk_mod("Armour", "BASE", num(a.n(1) / 100.0), vec![]), vec![])]))),
        ("grants maximum energy shield equal to (%d+)%% of your reserved mana to you and nearby allies", Func(|a| Some(vec![wrap("GrantReservedManaAsAura", mk_mod("EnergyShield", "BASE", num(a.n(1) / 100.0), vec![]), vec![])]))),
        ("warcries cost no mana", Mods(vec![mk_mod("ManaCost", "MORE", num(-100.0), vec![kw(kf::Warcry)])])),
        ("%+(%d+)%% chance to block attack damage for %d seconds? every %d seconds", Func(|a| Some(vec![mk_mod("BlockChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("BastionOfHopeActive"))]))])]))),
        ("if you've blocked in the past %d+ seconds, you and nearby allies cannot be stunned", Mods(vec![wrap("ExtraAura", flag_mod("StunImmune", vec![]), vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))])), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("if you've attacked recently, you and nearby allies have %+(%d+)%% chance to block attack damage", Func(|a| Some(vec![wrap("ExtraAura", mk_mod("BlockChance", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("AttackedRecently"))]))])]))),
        ("if you've cast a spell recently, you and nearby allies have %+(%d+)%% chance to block spell damage", Func(|a| Some(vec![wrap("ExtraAura", mk_mod("SpellBlockChance", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("CastSpellRecently"))]))])]))),
        ("while there is at least one nearby ally, you and nearby allies deal (%d+)%% more damage", Func(|a| Some(vec![wrap("ExtraAura", mk_mod("Damage", "MORE", num(a.n(1)), vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyAlly")), ("threshold", num(1.0))]))])]))),
        ("while there are at least five nearby allies, you and nearby allies have onslaught", Mods(vec![wrap("ExtraAura", flag_mod("Onslaught", vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyAlly")), ("threshold", num(5.0))]))])])),
        ("linked targets and allies in your link beams have %+(%d+)%% to all maximum elemental resistances", Func(|a| Some(vec![
            mk_mod("ExtraAura", "LIST", PVal::Map(vec![("onlyAllies".to_string(), b(true)), ("mod".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("ElementalResistMax", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByLink")), ("neg", b(true))]))])))]), vec![tg(stag("MultiplierThreshold", vec![("var", s("LinkedTargets")), ("threshold", num(1.0))]))]),
            wrap("ExtraLinkEffect", mk_mod("ElementalResistMax", "BASE", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]), vec![]),
        ]))),
        ("enemies in your link beams cannot apply elemental ailments", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("BetweenYouAndLinkedTarget"))]))])])),
        ("(%d+)%% of damage from hits is taken from your sentinel of radiance's life before you", Func(|a| Some(vec![mk_mod("takenFromRadianceSentinelBeforeYou", "BASE", num(a.n(1)), vec![])]))),
        ("you can inflict %+(%d+) hallowing flame on enemies", Func(|a| Some(vec![mk_mod("Multiplier:HallowingFlameMax", "BASE", num(a.n(1)), vec![])]))),
        ("gain (%d+)%% of (%a+) damage as extra (%a+) damage for each of your hallowing flames that have been removed by an allied hit recently, up to (%d+)%%", Func(|a| Some(vec![
            mk_mod(format!("{}DamageGainAs{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("HallowingFlame"))])), tg(stag("Multiplier", vec![("var", s("HallowingFlameStacksRemovedByAlly")), ("limit", num(a.n(4) / a.n(1)))]))]),
        ]))),
        ("(%d+)%% increased magnitude of hallowing flame you inflict", Func(|a| Some(vec![mk_mod("HallowingFlameMagnitude", "INC", num(a.n(1)), vec![])]))),
        // Lua's second mod() call here (ModParser.lua:2895) is `mod(name, type, num, tag, 0,
        // KeywordFlag.Totem)` -- createMod's vararg scan checks fixed positions 1/2/3 for
        // source/flags/keywordFlags regardless of what's actually there, so passing the tag
        // table first (instead of after flags/keywordFlags) means it's never recognized as a tag
        // and is silently dropped; only keywordFlags=Totem survives. A real upstream bug, but one
        // the golden data reflects, so it's kept exactly rather than "corrected" to add the tag.
        ("you and your totems regenerate ([%d%.]+)%% of life per second for each summoned totem", Func(|a| Some(vec![
            mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("TotemsSummoned"))]))]),
            mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![kw(kf::Totem)]),
        ]))),
        ("enemies take (%d+)%% increased damage for each of your brands attached to them", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("BrandsAttached"))]))]), vec![]),
        ]))),
        ("non%-damaging ailments have (%d+)%% reduced effect on you while you have arcane surge", Func(|a| Some(
            ["Chill", "Freeze", "Shock", "Scorch", "Brittle", "Sap"].iter().map(|ailment| {
                mk_mod(format!("Self{}Effect", ailment), "INC", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByArcaneSurge"))]))])
            }).collect()
        ))),
        ("immun[ei]t?y? to elemental ailments while you have arcane surge", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("AffectedByArcaneSurge"))]))])])),
        ("brands have (%d+)%% more activation frequency if (%d+)%% of attached duration expired", Func(|a| Some(vec![mk_mod("BrandActivationFrequency", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("BrandLastQuarter"))]))])]))),
        ("arcane surge a?l?s?o? ?grants (%d+)%% more spell damage to you", Func(|a| Some(vec![mk_mod("ArcaneSurgeDamage", "MAX", num(a.n(1)), vec![])]))),
    ]
}

fn part6() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 2908-3067 (Inquisitor..Ritualist Bloodline)
        ("critical strikes ignore enemy monster elemental resistances", Mods(vec![flag_mod("IgnoreElementalResistances", vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("non%-critical strikes penetrate (%d+)%% of enemy elemental resistances", Func(|a| Some(vec![mk_mod("ElementalPenetration", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("CriticalStrike")), ("neg", b(true))]))])]))),
        ("consecrated ground you create applies (%d+)%% increased damage taken to enemies", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTakenConsecratedGround", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))]), vec![]),
        ]))),
        ("you have consecrated ground around you while stationary", Mods(vec![flag_mod("Condition:OnConsecratedGround", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))])])),
        ("consecrated ground you create grants immun[ei]t?y? to elemental ailments to you and allies", Mods(vec![wrap("ExtraAura", flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))]), vec![])])),
        ("gain fanaticism for (%d+) seconds on reaching maximum fanatic charges", Mods(vec![flag_mod("Condition:CanGainFanaticism", vec![])])),
        ("(%d+)%% increased critical strike chance per point of strength or intelligence, whichever is lower", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("Str"))])), tg(stag("Condition", vec![("var", s("IntHigherThanStr"))]))]),
            mk_mod("CritChance", "INC", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("Int"))])), tg(stag("Condition", vec![("neg", b(true)), ("var", s("IntHigherThanStr"))]))]),
        ]))),
        ("consecrated ground you create causes life regeneration to also recover energy shield for you and allies", Mods(vec![wrap("ExtraAura", flag_mod("LifeRegenerationRecoversEnergyShield", vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))]), vec![])])),
        ("(%d+)%% more attack damage for each non%-instant spell you've cast in the past 8 seconds, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            // Lua: limit = max (line 2923, no tonumber) -- stays a raw string.
            mk_mod("Damage", "MORE", num(a.n(1)), vec![flags(mf::Attack), tg(stag("Multiplier", vec![("var", s("CastLast8Seconds")), ("limit", s(a.s(2))), ("limitTotal", b(true))]))]),
        ]))),
        ("action speed cannot be modified to below base value", Mods(vec![mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("movement speed cannot be modified to below base value", Mods(vec![flag_mod("MovementSpeedCannotBeBelowBase", vec![])])),
        ("you cannot be slowed to below base speed", Mods(vec![mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("cannot be slowed to below base speed", Mods(vec![mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("gain accuracy rating equal to your strength", Mods(vec![mk_mod("Accuracy", "BASE", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("Str"))]))])])),
        ("gain accuracy rating equal to twice your strength", Mods(vec![mk_mod("Accuracy", "BASE", num(2.0), vec![tg(stag("PerStat", vec![("stat", s("Str"))]))])])),
        ("your offering skills also affect you", Mods(vec![
            wrap("ExtraSkillMod", mk_mod("SkillData", "LIST", PVal::Map(vec![("key".to_string(), s("buffNotPlayer")), ("value".to_string(), b(false))]), vec![]),
                vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Bone Offering"), s("Flesh Offering"), s("Spirit Offering"), s("Blood Offering")]))]))]),
        ])),
        ("your offerings have (%d+)%% reduced effect on you", Func(|a| Some(vec![
            wrap("ExtraSkillMod", mk_mod("BuffEffectOnPlayer", "INC", num(-a.n(1)), vec![]),
                vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Bone Offering"), s("Flesh Offering"), s("Spirit Offering"), s("Blood Offering")]))]))]),
        ]))),
        ("your offerings have (%d+)%% increased effect on you", Func(|a| Some(vec![
            wrap("ExtraSkillMod", mk_mod("BuffEffectOnPlayer", "INC", num(a.n(1)), vec![]),
                vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Bone Offering"), s("Flesh Offering"), s("Spirit Offering"), s("Blood Offering")]))]))]),
        ]))),
        ("if you've consumed a corpse recently, you and your minions have (%d+)%% increased area of effect", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ConsumedCorpseRecently"))]))]),
            wrap("MinionModifier", mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("ConsumedCorpseRecently"))]))]),
        ]))),
        ("with at least one nearby corpse, you and nearby allies deal (%d+)%% more damage", Func(|a| Some(vec![wrap("ExtraAura", mk_mod("Damage", "MORE", num(a.n(1)), vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyCorpse")), ("threshold", num(1.0))]))])]))),
        ("with at least one nearby corpse, nearby enemies deal (%d+)%% reduced damage", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("Damage", "INC", num(-a.n(1)), vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("NearbyCorpse")), ("threshold", num(1.0))]))])]))),
        ("for each nearby corpse, you and nearby allies regenerate ([%d%.]+)%% of energy shield per second, up to ([%d%.]+)%% per second", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("EnergyShieldRegenPercent", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Multiplier", vec![("var", s("NearbyCorpse")), ("limit", num(a.n(2))), ("limitTotal", b(true))]))]),
        ]))),
        ("for each nearby corpse, you and nearby allies regenerate (%d+) mana per second, up to (%d+) per second", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("ManaRegen", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Multiplier", vec![("var", s("NearbyCorpse")), ("limit", num(a.n(2))), ("limitTotal", b(true))]))]),
        ]))),
        ("(%d+)%% increased attack and cast speed for each corpse consumed recently, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("Speed", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("CorpseConsumedRecently")), ("limit", num(a.n(2) / a.n(1)))]))]),
        ]))),
        ("enemies near corpses you spawned recently are chilled and shocked", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Chilled", vec![]), vec![tg(stag("Condition", vec![("var", s("SpawnedCorpseRecently"))]))]),
            wrap("EnemyModifier", flag_mod("Condition:Shocked", vec![]), vec![tg(stag("Condition", vec![("var", s("SpawnedCorpseRecently"))]))]),
            mk_mod("ChillBase", "BASE", num(10.0), vec![tg(stag("Condition", vec![("var", s("SpawnedCorpseRecently"))]))]),
            mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("Condition", vec![("var", s("SpawnedCorpseRecently"))]))]),
        ])),
        ("regenerate (%d+)%% of energy shield over 2 seconds when you consume a corpse", Func(|a| Some(vec![mk_mod("EnergyShieldRegenPercent", "BASE", num(a.n(1) / 2.0), vec![tg(stag("Condition", vec![("var", s("ConsumedCorpseInPast2Sec"))]))])]))),
        ("regenerate (%d+)%% of mana over 2 seconds when you consume a corpse", Func(|a| Some(vec![mk_mod("ManaRegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1) / 2.0))])), tg(stag("Condition", vec![("var", s("ConsumedCorpseInPast2Sec"))]))])]))),
        ("corpses you spawn have (%d+)%% increased maximum life", Func(|a| Some(vec![mk_mod("CorpseLife", "INC", num(a.n(1)), vec![])]))),
        ("corpses you spawn have (%d+)%% reduced maximum life", Func(|a| Some(vec![mk_mod("CorpseLife", "INC", num(-a.n(1)), vec![])]))),
        ("minions gain added physical damage equal to (%d+)%% of maximum energy shield on your equipped helmet", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("PhysicalMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShieldOnHelmet")), ("actor", s("parent")), ("percent", num(a.n(1)))]))]), vec![]),
            wrap("MinionModifier", mk_mod("PhysicalMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShieldOnHelmet")), ("actor", s("parent")), ("percent", num(a.n(1)))]))]), vec![]),
        ]))),
        ("when you kill an enemy, for each curse on that enemy, gain (%d+)%% of non%-chaos damage as extra chaos damage for 4 seconds", Func(|a| Some(vec![
            mk_mod("NonChaosDamageGainAsChaos", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("KilledRecently"))])), tg(stag("Multiplier", vec![("var", s("CurseOnEnemy"))]))]),
        ]))),
        ("cannot be stunned while you have energy shield", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("HaveEnergyShield"))]))])])),
        ("every second, inflict withered on nearby enemies for (%d+) seconds", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("nearby hindered enemies deal (%d+)%% reduced damage over time", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("DamageOverTime", "INC", num(-a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Hindered"))]))])]))),
        ("nearby chilled enemies deal (%d+)%% reduced damage with hits", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("Damage", "INC", num(-a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Chilled"))]))])]))),
        ("gain spirit infusion every ?(%d?)%.?(%d?) seconds? while channelling a spell", Func(|_a| Some(vec![flag_mod("Condition:CanGainSpiritInfusion", vec![])]))),
        ("always poison on hit while using a flask", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("poisons you inflict during any flask effect have (%d+)%% chance to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Poison), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("immun[ei]t?y? to elemental ailments during any flask effect", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grant bonuses to non%-channelling skills you use by consuming (%d+) charges from a flask of each of the following types, if possible:", Mods(vec![])),
        ("if diamond flask charges are consumed, (%d+)%% increased critical strike chance", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(37.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("HaveDiamondFlask"))]))]),
        ]))),
        ("if diamond flask charges are consumed, ([%+%-]%d+)%% to critical strike multiplier", Func(|a| Some(vec![
            mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(37.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("HaveDiamondFlask"))]))]),
        ]))),
        ("if bismuth flask charges are consumed, penetrate (%d+)%% elemental resistances", Func(|a| Some(vec![
            mk_mod("ElementalPenetration", "BASE", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(37.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("HaveBismuthFlask"))]))]),
        ]))),
        ("if amethyst flask charges are consumed, (%d+)%% of physical damage as extra chaos damage", Func(|a| Some(vec![
            mk_mod("PhysicalDamageGainAsChaos", "BASE", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(37.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("HaveAmethystFlask"))]))]),
        ]))),
        ("nearby enemies have (%d+)%% less accuracy rating while you have phasing", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("Accuracy", "MORE", num(-a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))])]))),
        ("immun[ei]t?y? to elemental ailments while phasing", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("Phasing"))]))])])),
        ("nearby enemies have fire, cold and lightning exposure while you have phasing, applying %-(%d+)%% to those resistances", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
        ]))),
        ("nearby enemies have fire, cold and lightning exposure while you have phasing", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
        ])),
        ("hits have (%d+)%% chance to deal (%d+)%% more area damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1) * a.n(2) / 100.0), vec![flags(mf::Area | mf::Hit)])]))),
        ("immun[ei]t?y? to ignite and shock", Mods(vec![flag_mod("IgniteImmune", vec![]), flag_mod("ShockImmune", vec![])])),
        ("you gain (%d+)%% increased damage for each trap", Func(|a| Some(vec![mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ActiveTrapLimit"))]))])]))),
        ("you gain (%d+)%% increased area of effect for each mine", Func(|a| Some(vec![mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ActiveMineLimit"))]))])]))),
        ("triggers level (%d+) summon triggerbots when allocated", Mods(vec![flag_mod("HaveTriggerBots", vec![])])),
        ("deal up to (%d+)%% more melee damage to enemies, based on proximity", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![flags(mf::Attack | mf::Melee), tg(stag("MeleeProximity", vec![("ramp", PVal::List(vec![num(1.0), num(0.0)]))]))])]))),
        ("cannot be stunned while leeching", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("Leeching"))]))])])),
        ("you are immune to bleeding while leeching", Mods(vec![flag_mod("BleedImmune", vec![tg(stag("Condition", vec![("var", s("Leeching"))]))])])),
        ("life leech effects are not removed at full life", Mods(vec![flag_mod("CanLeechLifeOnFullLife", vec![])])),
        ("life leech effects are not removed when unreserved life is filled", Mods(vec![flag_mod("CanLeechLifeOnFullLife", vec![])])),
        ("energy shield leech effects from attacks are not removed at full energy shield", Mods(vec![flag_mod("CanLeechEnergyShieldOnFullEnergyShield", vec![])])),
        ("cannot take reflected physical damage", Mods(vec![mk_mod("PhysicalReflectedDamageTaken", "MORE", num(-100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("gain (%d+)%% increased movement speed for 20 seconds when you kill an enemy", Func(|a| Some(vec![mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("KilledRecently"))]))])]))),
        ("gain (%d+)%% increased attack speed for 20 seconds when you kill a rare or unique enemy", Func(|a| Some(vec![mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Attack), tg(stag("Condition", vec![("var", s("KilledUniqueEnemy"))]))])]))),
        ("kill enemies that have (%d+)%% or lower life when hit by your skills", Func(|a| Some(vec![mk_mod("CullPercent", "MAX", num(a.n(1)), vec![])]))),
        ("you are unaffected by bleeding while leeching", Mods(vec![mk_mod("SelfBleedEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Leeching"))]))])])),
        ("(%d+)%% chance to gain (%d+)%% of non%-chaos damage with hits as extra chaos damage", Func(|a| Some(vec![mk_mod("NonChaosDamageGainAsChaos", "BASE", num(a.n(1) / 100.0 * a.n(2)), vec![])]))),
        ("movement skills cost no mana", Mods(vec![mk_mod("ManaCost", "MORE", num(-100.0), vec![kw(kf::Movement)])])),
        ("cannot be stunned while you have ghost shrouds", Func(|_a| Some(vec![flag_mod("StunImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s("GhostShroud")), ("threshold", num(1.0))]))])]))),
        ("your action speed is at least (%d+)%% of base value", Func(|a| Some(vec![mk_mod("MinimumActionSpeed", "MAX", num(a.n(1)), vec![])]))),
        ("nearby enemy monsters' action speed is at most (%d+)%% of base value", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("MaximumActionSpeedReduction", "MAX", num(100.0 - a.n(1)), vec![]), vec![])]))),
        ("prevent %+(%d+)%% of suppressed spell damage while on full energy shield", Func(|a| Some(vec![mk_mod("SpellSuppressionEffect", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FullEnergyShield"))]))])]))),
        ("energy shield leech effects are not removed when energy shield is filled", Mods(vec![flag_mod("CanLeechEnergyShieldOnFullEnergyShield", vec![])])),
        ("take (%d+)%% less damage from hits for (%d+) seconds", Func(|a| Some(vec![
            mk_mod("DamageTakenWhenHit", "MORE", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("HeartstopperHIT"))]))]),
            mk_mod("DamageTakenWhenHit", "MORE", num(-a.n(1) * a.n(2) / 10.0), vec![tg(stag("Condition", vec![("var", s("HeartstopperAVERAGE"))]))]),
        ]))),
        ("take (%d+)%% less damage over time for (%d+) seconds", Func(|a| Some(vec![
            mk_mod("DamageTakenOverTime", "MORE", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("HeartstopperDOT"))]))]),
            mk_mod("DamageTakenOverTime", "MORE", num(-a.n(1) * a.n(2) / 10.0), vec![tg(stag("Condition", vec![("var", s("HeartstopperAVERAGE"))]))]),
        ]))),
        ("prevent %+(%d+)%% of suppressed spell damage per bark below maximum", Func(|a| Some(vec![mk_mod("SpellSuppressionEffect", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("MissingBarkskinStacks"))]))])]))),
        ("hits that would ignite instead scorch", Mods(vec![flag_mod("IgniteCanScorch", vec![]), flag_mod("CannotIgnite", vec![])])),
        ("you can inflict an additional scorch on each enemy", Mods(vec![flag_mod("ScorchCanStack", vec![]), mk_mod("ScorchStacksMax", "BASE", num(1.0), vec![])])),
        ("maximum effect of shock is (%d+)%% increased damage taken", Func(|a| Some(vec![mk_mod("ShockMax", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("you can apply up to (%d+) shocks to each enemy", Func(|a| Some(vec![flag_mod("ShockCanStack", vec![]), mk_mod("ShockStacksMax", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("hits that fail to freeze due to insufficient freeze duration inflict hoarfrost", Mods(vec![flag_mod("HitsCanInflictHoarfrost", vec![])])),
        ("your hits always inflict freeze, shock and ignite while unbound", Mods(vec![
            mk_mod("EnemyFreezeChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Unbound"))]))]),
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Unbound"))]))]),
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Unbound"))]))]),
        ])),
        ("(%d+)%% more elemental damage while unbound", Func(|a| Some(vec![mk_mod("ElementalDamage", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Unbound"))]))])]))),
        ("defences from equipped body armour are doubled if it has no socketed gems", Mods(vec![
            mk_mod("Defences", "MORE", num(100.0), vec![
                tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInBody Armour")), ("threshold", num(0.0)), ("upper", b(true))])),
                tg(stag("Condition", vec![("var", s("UsingBody Armour"))])),
                tg(stag("SlotName", vec![("slotName", s("Body Armour"))])),
                tg(stag("Multiplier", vec![("var", s("OathOfTheMajiDoubled")), ("globalLimit", num(100.0)), ("globalLimitKey", s("OathOfTheMajiLimit"))])),
            ]),
            mk_mod("Multiplier:OathOfTheMajiDoubled", "OVERRIDE", num(1.0), vec![tg(stag("SlotName", vec![("slotName", s("Body Armour"))]))]),
        ])),
        ("([%+%-]%d+)%% to all elemental resistances if you have an equipped helmet with no socketed gems", Func(|a| Some(vec![mk_mod("ElementalResist", "BASE", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInHelmet")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingHelmet"))]))])]))),
        ("(%d+)%% increased maximum life if you have equipped gloves with no socketed gems", Func(|a| Some(vec![mk_mod("Life", "INC", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInGloves")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingGloves"))]))])]))),
        ("(%d+)%% increased movement speed if you have equipped boots with no socketed gems", Func(|a| Some(vec![mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInBoots")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingBoots"))]))])]))),
        ("spells you cast yourself gain added physical damage equal to (%d+)%% of life cost, if life cost is not higher than the maximum you could spend", Func(|a| Some(vec![
            mk_mod("PhysicalMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("LifeCost")), ("percent", num(a.n(1))), ("floor", b(true))])), tg(stag("StatThreshold", vec![("stat", s("LifeUnreserved")), ("thresholdStat", s("LifeCost"))]))]),
            mk_mod("PhysicalMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("LifeCost")), ("percent", num(a.n(1))), ("floor", b(true))])), tg(stag("StatThreshold", vec![("stat", s("LifeUnreserved")), ("thresholdStat", s("LifeCost"))]))]),
        ]))),
        ("gain maximum life instead of maximum energy shield from equipped armour items", Mods(vec![flag_mod("ConvertArmourESToLife", vec![])])),
        ("unaffected by bleeding", Mods(vec![mk_mod("SelfBleedEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by poison", Mods(vec![mk_mod("SelfPoisonEffect", "MORE", num(-100.0), vec![])])),
        ("can't use amulets", Mods(vec![mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Amulet"))]))])])),
        ("can't use belts", Mods(vec![mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Belt"))]))])])),
        ("%+1 ring slot", Mods(vec![flag_mod("AdditionalRingSlot", vec![])])),
        ("utility flasks are disabled", Mods(vec![flag_mod("UtilityFlasksDoNotApplyToPlayer", vec![])])),
    ]
}

fn part7() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 3068-3227 (Abyssal/Aul/Delirious/Lycia/Oshabi/Velka Bloodlines, item locals, socketed gems)
        ("totems have (%d+)%% more life per maximum number of summoned totems", Func(|a| Some(vec![mk_mod("TotemLife", "MORE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ActiveTotemLimit"))]))])]))),
        ("while you have at least (%d+) hypnotic eye jewels socketed: arcane surge also grants (%d+)%% of damage taken recouped as mana to you arcane surge also grants (%d+)%% increased mana cost efficiency to you", Func(|a| Some(vec![
            mk_mod("ArcaneSurgeAlsoManaRecoup", "BASE", num(a.n(2)), vec![tg(stag("MultiplierThreshold", vec![("var", s("HypnoticEyeJewel")), ("threshold", num(a.n(1)))]))]),
            mk_mod("ArcaneSurgeAlsoManaCostEfficiency", "INC", num(a.n(3)), vec![tg(stag("MultiplierThreshold", vec![("var", s("HypnoticEyeJewel")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("while you have at least (%d+) ghastly eye jewels socketed: unholy might you grant also causes target's damage to penetrate (%d+)%% chaos resistance unholy might you grant also applies (%d+)%% increased effect of withered", Func(|a| Some(vec![
            mk_mod("UnholyMightAlsoChaosPenetration", "BASE", num(a.n(2)), vec![tg(stag("MultiplierThreshold", vec![("var", s("GhastlyEyeJewel")), ("threshold", num(a.n(1)))]))]),
            mk_mod("UnholyMightAlsoWitherEffect", "INC", num(a.n(3)), vec![tg(stag("MultiplierThreshold", vec![("var", s("GhastlyEyeJewel")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("while you have at least (%d+) searching eye jewels socketed: targets affected by maim you inflict cannot deal critical strikes maim you inflict causes hits against the target to have (%d+)%% more critical strike chance", Func(|a| Some(vec![
            wrap("EnemyModifier", flag_mod("NeverCrit", vec![tg(stag("Condition", vec![("var", s("Maimed"))]))]), vec![tg(stag("MultiplierThreshold", vec![("var", s("SearchingEyeJewel")), ("threshold", num(a.n(1)))]))]),
            wrap("EnemyModifier", mk_mod("SelfCritChance", "MORE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("Maimed"))]))]), vec![tg(stag("MultiplierThreshold", vec![("var", s("SearchingEyeJewel")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("while you have at least (%d+) murderous eye jewels socketed: intimidate you inflict applies an extra %+(%d+)%% increased attack damage taken intimidate you inflict causes targets to deal (%d+)%% less damage", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(2)), vec![flags(mf::Attack), tg(stag("Condition", vec![("var", s("Intimidated"))]))]), vec![tg(stag("MultiplierThreshold", vec![("var", s("MurderousEyeJewel")), ("threshold", num(a.n(1)))]))]),
            wrap("EnemyModifier", mk_mod("Damage", "MORE", num(-a.n(3)), vec![tg(stag("Condition", vec![("var", s("Intimidated"))]))]), vec![tg(stag("MultiplierThreshold", vec![("var", s("MurderousEyeJewel")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("action speed cannot be modified to below base value if you have equipped boots with no socketed gems", Mods(vec![mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])), tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInBoots")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingBoots"))]))])])),
        ("cannot be stunned if you have an equipped helmet with no socketed gems", Mods(vec![flag_mod("StunImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInHelmet")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingHelmet"))]))])])),
        ("elemental ailments cannot be inflicted on you if you have an equipped body armour with no socketed gems", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInBody Armour")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingBody Armour"))]))])])),
        ("take no extra damage from critical strikes if you have equipped gloves with no socketed gems", Mods(vec![mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])), tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsInGloves")), ("threshold", num(0.0)), ("upper", b(true))])), tg(stag("Condition", vec![("var", s("UsingGloves"))]))])])),
        ("while affected by glorious madness, inflict mania on nearby enemies every second", Mods(vec![
            flag_mod("Condition:CanInflictMania", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            wrap("EnemyModifier", flag_mod("Condition:AfflictedByMania", vec![]), vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
        ])),
        // Lua: function(_, num1, num2) -- num1 is capture 1, num2 is capture 2 (both were shifted
        // by one below).
        ("herald skills have (%d+)%% more buff effect for every (%d+)%% of maximum mana they reserve", Func(|a| Some(vec![mk_mod("BuffEffect", "MORE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ManaReservedPercent")), ("div", num(a.n(2)))])), tg(stag("SkillType", vec![("skillType", num(52.0))]))])]))),
        ("herald skills and minions from herald skills deal (%d+)%% more damage for every (%d+)%% of maximum life those skills reserve", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "MORE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("LifeReservedPercent")), ("div", num(a.n(2))), ("actor", s("parent"))]))]), vec![tg(stag("SkillType", vec![("skillType", num(52.0))]))]),
            mk_mod("Damage", "MORE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("LifeReservedPercent")), ("div", num(a.n(2)))])), tg(stag("SkillType", vec![("skillType", num(52.0))]))]),
        ]))),
        ("unsealed spells gain (%d+)%% more damage each time their effects reoccur", Func(|a| Some(vec![mk_mod("MaxSealDamage", "MORE", num(a.n(1)), vec![])]))),
        ("skills gain added chaos damage equal to (%d+)%% of life cost, if life cost is not higher than the maximum you could spend", Func(|a| Some(vec![
            mk_mod("ChaosMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("LifeCost")), ("percent", num(a.n(1))), ("floor", b(true))])), tg(stag("StatThreshold", vec![("stat", s("LifeUnreserved")), ("thresholdStat", s("LifeCost"))]))]),
            mk_mod("ChaosMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("LifeCost")), ("percent", num(a.n(1))), ("floor", b(true))])), tg(stag("StatThreshold", vec![("stat", s("LifeUnreserved")), ("thresholdStat", s("LifeCost"))]))]),
        ]))),
        ("lose all rage on reaching maximum rage and gain wild savagery for 1 second per 10 rage lost this way", Mods(vec![flag_mod("WildSavagery", vec![])])),
        ("inflict barnacles on nearby enemies every second", Mods(vec![flag_mod("CanInflictBarnacles", vec![])])),
        ("drop brine ground while moving, lasting 4 seconds", Mods(vec![flag_mod("CanCreateBrineGround", vec![])])),
        ("has no sockets", Mods(vec![flag_mod("NoSockets", vec![])])),
        ("gems socketed always have the quality bonus from socket colour", Mods(vec![flag_mod("SocketAlwaysMatches", vec![])])),
        ("cannot have non%-abyssal sockets", Mods(vec![flag_mod("NoSockets", vec![])])),
        ("socketed %a+ abyssal jewels will be consumed", Mods(vec![])),
        ("one modifier from consumed jewels will be retained", Mods(vec![])),
        ("reflects your o[tp][hp][eo][rs]i?t?e? ring", Mods(vec![])),
        ("can be allflame crafted as if rare", Mods(vec![])),
        ("cannot gain intangibility", Mods(vec![])),
        ("has (%d+) sockets?", Func(|a| Some(vec![mk_mod("SocketCount", "BASE", num(a.n(1)), vec![])]))),
        ("has (%d+) abyssal sockets?", Func(|a| Some(vec![mk_mod("AbyssalSocketCount", "BASE", num(a.n(1)), vec![])]))),
        ("no physical damage", Mods(vec![
            mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("PhysicalMin"))]), vec![]),
            mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("PhysicalMax"))]), vec![]),
            mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("PhysicalDPS"))]), vec![]),
        ])),
        ("has (%d+)%% increased elemental damage", Func(|a| Some(vec![mk_mod("LocalElementalDamage", "INC", num(a.n(1)), vec![])]))),
        ("all attacks with this weapon are critical strikes", Mods(vec![mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("CritChance")), ("value".to_string(), num(100.0))]), vec![])])),
        ("this weapon's critical strike chance is (%d+)%%", Func(|a| Some(vec![mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("CritChance")), ("value".to_string(), num(a.n(1)))]), vec![])]))),
        ("counts as dual wielding", Mods(vec![mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("countsAsDualWielding")), ("value".to_string(), b(true))]), vec![])])),
        ("counts as all one handed melee weapon types", Mods(vec![mk_mod("WeaponData", "LIST", PVal::Map(vec![("key".to_string(), s("countsAsAll1H")), ("value".to_string(), b(true))]), vec![])])),
        ("no block chance", Mods(vec![mk_mod("ArmourData", "LIST", PVal::Map(vec![("key".to_string(), s("BlockChance")), ("value".to_string(), num(0.0))]), vec![])])),
        ("no chance to block", Mods(vec![mk_mod("ArmourData", "LIST", PVal::Map(vec![("key".to_string(), s("BlockChance")), ("value".to_string(), num(0.0))]), vec![])])),
        ("has no energy shield", Mods(vec![mk_mod("ArmourData", "LIST", PVal::Map(vec![("key".to_string(), s("EnergyShield")), ("value".to_string(), num(0.0))]), vec![])])),
        ("hits can't be evaded", Mods(vec![flag_mod("CannotBeEvaded", vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("causes bleeding on hit", Mods(vec![mk_mod("BleedChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("poisonous hit", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("attacks with this weapon deal double damage", Mods(vec![mk_mod("DoubleDamageChance", "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])])),
        ("hits with this weapon gain (%d+)%% of physical damage as extra cold or lightning damage", Func(|a| Some(vec![mk_mod("PhysicalDamageGainAsColdOrLightning", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])]))),
        ("hits with this weapon shock enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("ShockAsThoughDealing", "MORE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])]))),
        ("hits with this weapon freeze enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("FreezeAsThoughDealing", "MORE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])]))),
        ("ignites inflicted with this weapon deal (%d+)%% more damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Ignite), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])]))),
        ("hits with this weapon always ignite, freeze, and shock", Mods(vec![
            mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            mk_mod("EnemyFreezeChance", "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            mk_mod("EnemyShockChance", "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ])),
        ("attacks with this weapon deal double damage to chilled enemies", Mods(vec![mk_mod("DoubleDamageChance", "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Chilled"))]))])])),
        ("life leech from hits with this weapon applies instantly", Mods(vec![mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("life leech from hits with this weapon is instant", Mods(vec![mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("mana leech from hits with this weapon is instant", Mods(vec![mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("life leech from melee damage is instant", Mods(vec![mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![flags(mf::Melee)])])),
        ("gain life from leech instantly from hits with this weapon", Mods(vec![mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])])),
        ("(%d+)%% of leech from hits with this weapon is instant per enemy power", Func(|a| Some(vec![
            mk_mod("InstantLifeLeech", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))])), tg(stag("Multiplier", vec![("var", s("EnemyPower"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))])), tg(stag("Multiplier", vec![("var", s("EnemyPower"))]))]),
            mk_mod("InstantEnergyShieldLeech", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))])), tg(stag("Multiplier", vec![("var", s("EnemyPower"))]))]),
        ]))),
        ("instant recovery", Mods(vec![mk_mod("FlaskInstantRecovery", "BASE", num(100.0), vec![])])),
        ("(%d+)%% of recovery applied instantly", Func(|a| Some(vec![mk_mod("FlaskInstantRecovery", "BASE", num(a.n(1)), vec![])]))),
        ("instant recovery when on low life", Mods(vec![mk_mod("FlaskLowLifeInstantRecovery", "BASE", num(100.0), vec![]), mk_mod("Dummy", "DUMMY", num(1.0), vec![src(""), tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("life flasks used while on low life apply recovery instantly", Mods(vec![mk_mod("LifeFlaskInstantRecovery", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("mana flasks used while on low mana apply recovery instantly", Mods(vec![mk_mod("ManaFlaskInstantRecovery", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("LowMana"))]))])])),
        ("has no attribute requirements", Mods(vec![flag_mod("NoAttributeRequirements", vec![])])),
        ("trigger a socketed spell when you attack with this weapon", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed spell when you attack with this weapon, with a ([%d%.]+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed spell when you use a skill", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnSkillUse")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed spell when you use a skill, with a (%d+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnSkillUse")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        // Current bench-craft wording: level 2 for a cooldown of 4s or less (the older "when you use a skill" line above is level 1).
        ("trigger a socketed spell on using a skill, with a (%d+) second cooldown", Func(|a| Some(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnSkillUse")), ("level".to_string(), num(if a.n(1) <= 4.0 { 2.0 } else { 1.0 }))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])]))),
        ("trigger a socketed spell when you use a skill, with a (%d+) second cooldown and (%d+)%% more cost", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnSkillUse")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger socketed spells when you focus", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellFromHelmet")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger socketed spells when you focus, with a ([%d%.]+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellFromHelmet")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed spell when you attack with a bow", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnBowAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed spell when you attack with a bow, with a ([%d%.]+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnBowAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed bow skill when you attack with a bow", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerBowSkillOnBowAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed bow skill when you attack with a bow, with a ([%d%.]+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerBowSkillOnBowAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("trigger a socketed bow skill when you cast a spell while wielding a bow", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerBowSkillOnBowAttack")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("(%d+)%% chance to trigger socketed spell on kill, with a ([%d%.]+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerSpellOnKill")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("(%d+)%% chance to [c?t?][a?r?][s?i?][t?g?]g?e?r? socketed spells when you spend at least (%d+) mana to use a skill", Func(|a| Some(vec![
            mk_mod("KitavaTriggerChance", "BASE", num(a.n(1)), vec![src("Kitava's Thirst")]),
            mk_mod("KitavaRequiredManaCost", "BASE", num(a.n(2)), vec![src("Kitava's Thirst")]),
            mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportCastOnManaSpent")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ]))),
        ("(%d+)%% chance to [c?t?][a?r?][s?i?][t?g?]g?e?r? socketed spells when you spend at least (%d+) mana on an upfront cost to use or trigger a skill, with a ([%d%.]+) second cooldown", Func(|a| Some(vec![
            mk_mod("KitavaTriggerChance", "BASE", num(a.n(1)), vec![src("Kitava's Thirst")]),
            mk_mod("KitavaRequiredManaCost", "BASE", num(a.n(2)), vec![src("Kitava's Thirst")]),
            mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportCastOnManaSpent")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ]))),
        ("(%d+)%% chance to [c?t?][a?r?][s?i?][t?g?]g?e?r? socketed spells when you spend at least (%d+) life on an upfront cost to use or trigger a skill, with a ([%d%.]+) second cooldown", Func(|a| Some(vec![
            mk_mod("FoulbornKitavaTriggerChance", "BASE", num(a.n(1)), vec![src("Kitava's Thirst")]),
            mk_mod("FoulbornKitavaRequiredLifeCost", "BASE", num(a.n(2)), vec![src("Kitava's Thirst")]),
            mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportCastOnLifeSpent")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ]))),
        ("trigger a socketed fire spell on hit, with a ([%d%.]+) second cooldown", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportTriggerFireSpellOnHit")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("([%+%-]%d+) to level of socketed gems", Func(|a| Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("all")), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1)))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])]))),
        ("([%+%-]%d+)%%? to (%a+) of socketed ?([%a%- ]*) gems", Func(|a| {
            let ty = if a.s(3).is_empty() { "all" } else { a.s(3) };
            Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s(ty)), ("key".to_string(), s(a.s(2))), ("value".to_string(), num(a.n(1)))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])
        })),
        ("([%+%-]%d+) to level of socketed skill gems per socketed gem", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("grants_active_skill")), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("Multiplier", vec![("var", s("SocketedGemsIn{SlotName}"))]))]),
        ]))),
    ]
}

pub fn entries() -> Vec<(&'static str, SpecialVal)> {
    let mut v = Vec::new();
    v.extend(part1());
    v.extend(part2());
    v.extend(part3());
    v.extend(part4());
    v.extend(part5());
    v.extend(part6());
    v.extend(part7());
    v.extend(part8());
    v.extend(part9());
    v.extend(part10());
    v.extend(part11());
    v.extend(militant_faith_entries());
    v
}

/// ModParser.lua:2621-2635, the two "Non-Unique Jewels cause ..." Militant Faith wrapping
/// entries. Unlike every other specialModList entry, these build a mod whose value embeds a real
/// callable (`ExtraJewelFunc`'s `func` field, ModParser.lua:2622,2630) -- the same shape
/// jewelFuncList itself produces for a plain `JewelFunc` mod. See
/// `crate::modparser::jewelfunc::get_simple_conv_dyn`/`other_wrap` for why reusing those pieces is
/// enough to reproduce both closures exactly, and `jewelfunc.rs`'s module doc for the call shapes
/// the resulting callable is driven with.
fn militant_faith_entries() -> Vec<(&'static str, SpecialVal)> {
    use crate::modifier::ModType;
    use crate::modparser::jewelfunc::{self, JewelFuncHandle};
    use SpecialVal::Func;

    fn item_condition_tags() -> Vec<super::support::Arg> {
        vec![
            tg(stag("ItemCondition", vec![("itemSlot", s("{SlotName}")), ("rarityCond", s("UNIQUE")), ("neg", b(true))])),
            tg(stag("ItemCondition", vec![("itemSlot", s("{SlotName}")), ("rarityCond", s("RELIC")), ("neg", b(true))])),
        ]
    }
    /// `firstToUpper(attr):match("^%a%l%l")`: the first 3 characters of the title-cased attribute
    /// name (Str/Dex/Int).
    fn stat_code3(attr: &str) -> String {
        first_upper(attr).chars().take(3).collect()
    }

    vec![
        (
            "non%-unique jewels cause increases and reductions to other damage types in a (%a+) radius to be transformed to apply to (%a+) damage",
            Func(|a| {
                let radius = first_upper(a.s(1));
                let dmg_type = first_upper(a.s(2));
                let dst: std::sync::Arc<str> = std::sync::Arc::from(format!("{dmg_type}Damage"));
                let func = jewelfunc::other_wrap(jewelfunc::get_simple_conv_dyn(
                    &["PhysicalDamage", "FireDamage", "ColdDamage", "LightningDamage", "ChaosDamage", "ElementalDamage"],
                    dst,
                    ModType::Inc,
                    true,
                    None,
                    None,
                ));
                Some(vec![mk_mod(
                    "ExtraJewelFunc",
                    "LIST",
                    PVal::Map(vec![
                        ("radius".to_string(), s(radius)),
                        ("type".to_string(), s("Other")),
                        ("func".to_string(), PVal::JewelFunc(JewelFuncHandle(func))),
                    ]),
                    item_condition_tags(),
                )])
            }),
        ),
        (
            "non%-unique jewels cause small and notable passive skills in a (%a+) radius to also grant %+(%d+) to (%a+)",
            Func(|a| {
                let radius = first_upper(a.s(1));
                let val = a.n(2);
                let attr_code = stat_code3(a.s(3));
                let func = jewelfunc::other_wrap(std::sync::Arc::new(move |node: Option<&jewelfunc::JewelNode>, out: &mut jewelfunc::JewelOut, data: &mut jewelfunc::JewelData| {
                    let Some(n) = node else { return };
                    if n.node_type == "Notable" || n.node_type == "Normal" {
                        out.new_mod(&attr_code, ModType::Base, jewelfunc::Value::Num(val), data.mod_source.clone(), 0, 0, vec![]);
                    }
                }));
                Some(vec![mk_mod(
                    "ExtraJewelFunc",
                    "LIST",
                    PVal::Map(vec![
                        ("radius".to_string(), s(radius)),
                        ("type".to_string(), s("Other")),
                        ("func".to_string(), PVal::JewelFunc(JewelFuncHandle(func))),
                    ]),
                    item_condition_tags(),
                )])
            }),
        ),
    ]
}

fn part11() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 2296-2449: gap found by cross-checking golden mismatches against the original --
        // batches for parts 3/4 skipped this range entirely on the first pass.
        ("hits that deal elemental damage remove exposure to those elements and inflict exposure to other elements exposure inflicted this way applies (%-%d+)%% to resistances", Func(|a| Some(vec![
            flag_mod("ElementalEquilibrium", vec![]),
            // Lua: mod("EnemyModifier", "LIST", { mod = mod("FireExposure", "BASE", num, {tag}) })
            // -- the Condition tag is the INNER FireExposure mod's own 4th arg, not the outer
            // EnemyModifier's (unlike the other exposure entries nearby, which do tag the outer
            // mod -- this one's Lua source genuinely puts it on the inner mod instead).
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("varList", PVal::List(vec![s("HitByColdDamage"), s("HitByLightningDamage")]))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("varList", PVal::List(vec![s("HitByFireDamage"), s("HitByLightningDamage")]))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("varList", PVal::List(vec![s("HitByFireDamage"), s("HitByColdDamage")]))]))]), vec![]),
        ]))),
        ("enemies you hit with elemental damage temporarily get (%+%d+)%% resistance to those elements and (%-%d+)%% resistance to other elements", Func(|a| Some(vec![
            flag_mod("ElementalEquilibrium", vec![]),
            flag_mod("ElementalEquilibriumLegacy", vec![]),
            // Lua: mod("EnemyModifier", "LIST", { mod = mod("FireResist", "BASE", plus, {tag}) })
            // -- like the FireExposure entry above, every tag here is a literal argument of the
            // INNER FireResist/ColdResist/LightningResist mod() call, not the outer EnemyModifier
            // LIST wrapper (no answer-key line exercises this text directly; the Elemental
            // Equilibrium keystone, node 39085, does).
            wrap("EnemyModifier", mk_mod("FireResist", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByFireDamage"))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("FireResist", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("HitByFireDamage")), ("neg", b(true))])), tg(stag("Condition", vec![("varList", PVal::List(vec![s("HitByColdDamage"), s("HitByLightningDamage")]))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("ColdResist", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByColdDamage"))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("ColdResist", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("HitByColdDamage")), ("neg", b(true))])), tg(stag("Condition", vec![("varList", PVal::List(vec![s("HitByFireDamage"), s("HitByLightningDamage")]))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("LightningResist", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitByLightningDamage"))]))]), vec![]),
            wrap("EnemyModifier", mk_mod("LightningResist", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("HitByLightningDamage")), ("neg", b(true))])), tg(stag("Condition", vec![("varList", PVal::List(vec![s("HitByFireDamage"), s("HitByColdDamage")]))]))]), vec![]),
        ]))),
        ("projectile attack hits deal up to 30%% more damage to targets at the start of their movement, dealing less damage to targets as the projectile travels farther", Mods(vec![flag_mod("PointBlank", vec![])])),
        ("leech energy shield instead of life", Mods(vec![flag_mod("GhostReaver", vec![])])),
        ("minions explode when reduced to low life, dealing 33%% of their maximum life as fire damage to surrounding enemies", Mods(vec![mk_mod("ExtraMinionSkill", "LIST", PVal::Map(vec![("skillId".to_string(), s("MinionInstability"))]), vec![])])),
        ("minions explode when reduced to low life, dealing 33%% of their life as fire damage to surrounding enemies", Mods(vec![mk_mod("ExtraMinionSkill", "LIST", PVal::Map(vec![("skillId".to_string(), s("MinionInstability"))]), vec![])])),
        ("all bonuses from an equipped shield apply to your minions instead of you", Mods(vec![])),
        ("spend energy shield before mana for skill m?a?n?a? ?costs", Mods(vec![])),
        ("you have perfect agony if you've dealt a critical strike recently", Mods(vec![mk_mod("Keystone", "LIST", s("Perfect Agony"), vec![tg(stag("Condition", vec![("var", s("CritRecently"))]))])])),
        ("energy shield protects mana instead of life", Mods(vec![flag_mod("EnergyShieldProtectsMana", vec![])])),
        ("modifiers to critical strike multiplier also apply to damage over time multiplier for ailments from critical strikes at (%d+)%% of their value", Func(|a| Some(vec![mk_mod("CritMultiplierAppliesToDegen", "BASE", num(a.n(1)), vec![])]))),
        ("damage over time multiplier for ailments is equal to critical strike multiplier", Mods(vec![flag_mod("DotMultiplierIsCritMultiplier", vec![])])),
        ("%+(%d+)%% to cold damage over time multiplier for each (%d+)%% overcapped cold resistance", Func(|a| Some(vec![mk_mod("ColdDotMultiplier", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ColdResistOverCap")), ("div", s(a.s(2)))]))])]))),
        ("your bleeding does not deal extra damage while the enemy is moving", Mods(vec![flag_mod("Condition:NoExtraBleedDamageToMovingEnemy", vec![])])),
        ("your bleeding does not deal extra damage while the enemy is moving and cannot be aggravated", Mods(vec![flag_mod("Condition:NoExtraBleedDamageToMovingEnemy", vec![]), flag_mod("Condition:CannotAggravate", vec![])])),
        ("you and enemies in your presence count as moving while affected by elemental ailments", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Moving", vec![tg(stag("Condition", vec![("varList", PVal::List(vec![s("Frozen"), s("Chilled"), s("Shocked"), s("Ignited"), s("Scorched"), s("Brittle"), s("Sapped")]))]))]), vec![]),
            flag_mod("Condition:Moving", vec![tg(stag("Condition", vec![("varList", PVal::List(vec![s("Frozen"), s("Chilled"), s("Shocked"), s("Ignited"), s("Scorched"), s("Brittle"), s("Sapped")]))]))]),
        ])),
        ("you can inflict bleeding on an enemy up to (%d+) times?", Func(|a| Some(vec![mk_mod("BleedStacksMax", "OVERRIDE", num(a.n(1)), vec![]), flag_mod("Condition:HaveCrimsonDance", vec![])]))),
        ("your minions spread caustic ground on death, dealing (%d+)%% of their maximum life as chaos damage per second", Func(|a| Some(vec![
            mk_mod("ExtraMinionSkill", "LIST", PVal::Map(vec![("skillId".to_string(), s("SiegebreakerCausticGround"))]), vec![]),
            wrap("MinionModifier", mk_mod("Multiplier:SiegebreakerCausticGroundPercent", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("your minions spread burning ground on death, dealing (%d+)%% of their maximum life as fire damage per second", Func(|a| Some(vec![
            mk_mod("ExtraMinionSkill", "LIST", PVal::Map(vec![("skillId".to_string(), s("ReplicaSiegebreakerBurningGround"))]), vec![]),
            wrap("MinionModifier", mk_mod("Multiplier:SiegebreakerBurningGroundPercent", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("you can have an additional brand attached to an enemy", Mods(vec![mk_mod("BrandsAttachedLimit", "BASE", num(1.0), vec![])])),
        ("gain (%d+) grasping vines each second while stationary", Func(|a| Some(vec![
            mk_mod("Multiplier:GraspingVinesCount", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("StationarySeconds")), ("limit", num(10.0)), ("limitTotal", b(true))])), tg(stag("Condition", vec![("var", s("Stationary"))]))]),
        ]))),
        ("all damage inflicts poison against enemies affected by at least (%d+) grasping vines", Func(|a| Some(vec![
            mk_mod("PoisonChance", "BASE", num(100.0), vec![tg(stag("MultiplierThreshold", vec![("var", s("GraspingVinesAffectingEnemy")), ("threshold", num(a.n(1)))]))]),
            flag_mod("FireCanPoison", vec![tg(stag("MultiplierThreshold", vec![("var", s("GraspingVinesAffectingEnemy")), ("threshold", num(a.n(1)))]))]),
            flag_mod("ColdCanPoison", vec![tg(stag("MultiplierThreshold", vec![("var", s("GraspingVinesAffectingEnemy")), ("threshold", num(a.n(1)))]))]),
            flag_mod("LightningCanPoison", vec![tg(stag("MultiplierThreshold", vec![("var", s("GraspingVinesAffectingEnemy")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("attack projectiles always inflict bleeding and maim, and knock back enemies", Mods(vec![
            mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Attack | mf::Projectile)]),
            mk_mod("EnemyKnockbackChance", "BASE", num(100.0), vec![flags(mf::Attack | mf::Projectile)]),
        ])),
        ("projectiles cannot pierce, fork or chain", Mods(vec![
            flag_mod("CannotPierce", vec![flags(mf::Projectile)]),
            flag_mod("CannotChain", vec![flags(mf::Projectile)]),
            flag_mod("CannotFork", vec![flags(mf::Projectile)]),
        ])),
        ("projectiles cannot continue after colliding with targets", Mods(vec![
            flag_mod("CannotPierce", vec![flags(mf::Projectile)]),
            flag_mod("CannotChain", vec![flags(mf::Projectile)]),
            flag_mod("CannotFork", vec![flags(mf::Projectile)]),
            flag_mod("CannotSplit", vec![flags(mf::Projectile)]),
        ])),
        ("critical strikes inflict scorch, brittle and sapped", Mods(vec![flag_mod("CritAlwaysAltAilments", vec![])])),
        ("chance to block attack damage is doubled", Mods(vec![mk_mod("BlockChance", "MORE", num(100.0), vec![])])),
        ("chance to block spell damage is doubled", Mods(vec![mk_mod("SpellBlockChance", "MORE", num(100.0), vec![])])),
        ("you take (%d+)%% of damage from blocked hits", Func(|a| Some(vec![mk_mod("BlockEffect", "BASE", num(a.n(1)), vec![])]))),
        ("ignore attribute requirements", Mods(vec![flag_mod("IgnoreAttributeRequirements", vec![])])),
        ("ignore attribute requirements of gems socketed in blue sockets", Mods(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("all")), ("key".to_string(), s("req")), ("value".to_string(), num(0.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("socketColor", s("B"))]))])])),
        ("ignore attribute requirements of socketed gems", Mods(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("all")), ("key".to_string(), s("req")), ("value".to_string(), num(0.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("gain no inherent bonuses from attributes", Mods(vec![flag_mod("NoAttributeBonuses", vec![])])),
        ("gain no inherent bonuses from strength", Mods(vec![flag_mod("NoStrengthAttributeBonuses", vec![])])),
        ("gain no inherent bonuses from dexterity", Mods(vec![flag_mod("NoDexterityAttributeBonuses", vec![])])),
        ("gain no inherent bonuses from intelligence", Mods(vec![flag_mod("NoIntelligenceAttributeBonuses", vec![])])),
        ("gain no (.+) from equipped (.+)", Func(|a| {
            let stat = title_case(a.s(1)).replace(' ', "");
            let slot_raw = a.s(2);
            let slot = if slot_raw == "shield" { "Weapon 2".to_string() } else { title_case(slot_raw) };
            Some(vec![flag_mod(format!("GainNo{}From{}", stat, slot), vec![])])
        })),
        ("all damage taken bypasses energy shield", Mods(vec![
            mk_mod("PhysicalEnergyShieldBypass", "OVERRIDE", num(100.0), vec![]),
            mk_mod("LightningEnergyShieldBypass", "OVERRIDE", num(100.0), vec![]),
            mk_mod("ColdEnergyShieldBypass", "OVERRIDE", num(100.0), vec![]),
            mk_mod("FireEnergyShieldBypass", "OVERRIDE", num(100.0), vec![]),
            mk_mod("ChaosEnergyShieldBypass", "OVERRIDE", num(100.0), vec![]),
        ])),
        ("physical damage taken bypasses energy shield", Mods(vec![mk_mod("PhysicalEnergyShieldBypass", "BASE", num(100.0), vec![])])),
        ("auras from your skills do not affect allies", Mods(vec![flag_mod("SelfAuraSkillsCannotAffectAllies", vec![])])),
        ("auras from your skills have (%d+)%% more effect on you", Func(|a| Some(vec![mk_mod("SkillAuraEffectOnSelf", "MORE", num(a.n(1)), vec![])]))),
        ("auras from your skills have (%d+)%% increased effect on you", Func(|a| Some(vec![mk_mod("SkillAuraEffectOnSelf", "INC", num(a.n(1)), vec![])]))),
        ("increases and reductions to mana regeneration rate instead apply to rage regeneration rate", Mods(vec![flag_mod("ManaRegenToRageRegen", vec![])])),
        ("increases and reductions to maximum energy shield instead apply to ward", Mods(vec![flag_mod("EnergyShieldToWard", vec![])])),
        ("(%d+)%% of damage taken bypasses ward", Func(|a| Some(vec![mk_mod("WardBypass", "BASE", num(a.n(1)), vec![])]))),
        ("ward has a (%d+)%% chance to not break", Func(|a| Some(vec![mk_mod("WardAvoidBreakChance", "BASE", num(a.n(1)), vec![])]))),
        ("damage taken bypasses unbroken ward if the hit deals less damage than (%d+)%% of ward", Func(|a| Some(vec![mk_mod("WardBypassBelowPercent", "BASE", num(a.n(1)), vec![])]))),
        ("maximum energy shield is (%d+)", Func(|a| Some(vec![mk_mod("EnergyShield", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("while not on full life, sacrifice ([%d%.]+)%% of mana per second to recover that much life", Func(|a| Some(vec![
            mk_mod("ManaDegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FullLife")), ("neg", b(true))]))]),
            mk_mod("LifeRecovery", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("FullLife")), ("neg", b(true))]))]),
        ]))),
        ("(%d+)%% increased maximum energy shield", Func(|a| Some(vec![mk_mod("EnergyShield", "INC", num(a.n(1)), vec![tg(stag("Global", vec![]))])]))),
        ("you are blind", Mods(vec![flag_mod("Condition:Blinded", vec![tg(stag("Condition", vec![("var", s("CannotBeBlinded")), ("neg", b(true))]))])])),
        ("armour applies to fire, cold and lightning damage taken from hits instead of physical damage", Mods(vec![
            mk_mod("ArmourAppliesToFireDamageTaken", "BASE", num(100.0), vec![]),
            mk_mod("ArmourAppliesToColdDamageTaken", "BASE", num(100.0), vec![]),
            mk_mod("ArmourAppliesToLightningDamageTaken", "BASE", num(100.0), vec![]),
            flag_mod("ArmourDoesNotApplyToPhysicalDamageTaken", vec![]),
        ])),
        ("(%d+)%% of armour also applies to chaos damage taken from hits", Func(|a| Some(vec![mk_mod("ArmourAppliesToChaosDamageTaken", "BASE", num(a.n(1)), vec![])]))),
        ("armour also applies to chaos damage taken from hits", Mods(vec![mk_mod("ArmourAppliesToChaosDamageTaken", "BASE", num(100.0), vec![])])),
        ("maximum damage reduction for any damage type is (%d+)%%", Func(|a| Some(vec![mk_mod("DamageReductionMax", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("gain additional elemental damage reduction equal to half your chaos resistance", Mods(vec![mk_mod("ElementalDamageReduction", "BASE", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("ChaosResist")), ("div", num(2.0))]))])])),
        ("(%d+)%% of maximum mana is converted to twice that much armour", Func(|a| Some(vec![mk_mod("ManaConvertToArmour", "BASE", num(a.n(1)), vec![])]))),
        ("life recovery from flasks also applies to energy shield", Mods(vec![flag_mod("LifeFlaskAppliesToEnergyShield", vec![])])),
        ("increase to cast speed from arcane surge also applies to movement speed", Mods(vec![flag_mod("ArcaneSurgeCastSpeedToMovementSpeed", vec![])])),
        ("arcane surge also grants (%d+)%% increased life regeneration rate to you", Func(|a| Some(vec![mk_mod("ArcaneSurgeAlsoLifeRegen", "INC", num(a.n(1)), vec![])]))),
        ("increases and reductions to effect of flasks applied to you also applies to effect of arcane surge on you at (%d+)%% of their value", Func(|a| Some(vec![mk_mod("FlaskEffectToArcaneSurgeEffect", "BASE", num(a.n(1)), vec![])]))),
        ("non%-instant mana recovery from flasks is also recovered as life", Mods(vec![flag_mod("ManaFlaskAppliesToLife", vec![])])),
        ("life leech effects recover energy shield instead while on full life", Mods(vec![flag_mod("ImmortalAmbition", vec![tg(stag("Condition", vec![("var", s("FullLife"))])), tg(stag("Condition", vec![("var", s("LeechingLife"))]))])])),
        ("shepherd of souls", Mods(vec![flag_mod("ShepherdOfSouls", vec![])])),
        ("you have shepherd of souls if at least (%d+) corrupted items are equipped", Func(|a| Some(vec![flag_mod("ShepherdOfSouls", vec![tg(stag("MultiplierThreshold", vec![("var", s("CorruptedItem")), ("threshold", num(a.n(1)))]))])]))),
        ("you have everlasting sacrifice if at least (%d+) corrupted items are equipped", Func(|a| Some(vec![flag_mod("Condition:EverlastingSacrifice", vec![tg(stag("MultiplierThreshold", vec![("var", s("CorruptedItem")), ("threshold", num(a.n(1)))]))])]))),
        ("adds (%d+) to (%d+) attack physical damage to melee skills per (%d+) dexterity while you are unencumbered", Func(|a| Some(vec![
            mk_mod("PhysicalMin", "BASE", num(a.n(1)), vec![flags(mf::Melee), kw(kf::Attack), tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(3)))])), tg(stag("Condition", vec![("var", s("Unencumbered"))]))]),
            mk_mod("PhysicalMax", "BASE", num(a.n(2)), vec![flags(mf::Melee), kw(kf::Attack), tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(3)))])), tg(stag("Condition", vec![("var", s("Unencumbered"))]))]),
        ]))),
        ("adds (%d+) to (%d+) fire damage to attacks for every (%d+)%% your light radius is above base value", Func(|a| Some(vec![
            mk_mod("FireMin", "BASE", num(a.n(1)), vec![flags(mf::Attack), tg(stag("PerStat", vec![("stat", s("LightRadiusInc")), ("div", num(a.n(3)))]))]),
            mk_mod("FireMax", "BASE", num(a.n(2)), vec![flags(mf::Attack), tg(stag("PerStat", vec![("stat", s("LightRadiusInc")), ("div", num(a.n(3)))]))]),
        ]))),
    ]
}

fn part10() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 3908-4040 (end of special_a's range)
        ("projectiles gain impale effect as they travel farther, causing impales they inflict to have up to (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("ImpaleEffect", "INC", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("DistanceRamp", vec![("ramp", PVal::List(vec![PVal::List(vec![num(35.0), num(0.0)]), PVal::List(vec![num(70.0), num(1.0)])]))]))]),
        ]))),
        ("(%d+)%% increased damage with bleeding inflicted on poisoned enemies", Func(|a| Some(vec![mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Bleed), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Poisoned"))]))])]))),
        ("y?o?u?r? ?fire damage can poison", Mods(vec![flag_mod("FireCanPoison", vec![])])),
        ("y?o?u?r? ?cold damage can poison", Mods(vec![flag_mod("ColdCanPoison", vec![])])),
        ("y?o?u?r? ?lightning damage can poison", Mods(vec![flag_mod("LightningCanPoison", vec![])])),
        ("all damage from hits can poison", Mods(vec![flag_mod("FireCanPoison", vec![]), flag_mod("ColdCanPoison", vec![]), flag_mod("LightningCanPoison", vec![])])),
        ("all damage can poison", Mods(vec![flag_mod("FireCanPoison", vec![]), flag_mod("ColdCanPoison", vec![]), flag_mod("LightningCanPoison", vec![])])),
        ("all damage with triggered spells can poison", Mods(vec![
            flag_mod("FireCanPoison", vec![kw(kf::Spell), tg(stag("SkillType", vec![("skillType", num(37.0))]))]),
            flag_mod("ColdCanPoison", vec![kw(kf::Spell), tg(stag("SkillType", vec![("skillType", num(37.0))]))]),
            flag_mod("LightningCanPoison", vec![kw(kf::Spell), tg(stag("SkillType", vec![("skillType", num(37.0))]))]),
        ])),
        ("all damage from hits with this weapon can poison", Mods(vec![
            flag_mod("FireCanPoison", vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            flag_mod("ColdCanPoison", vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            flag_mod("LightningCanPoison", vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ])),
        ("all damage inflicts poison while affected by glorious madness", Mods(vec![
            mk_mod("PoisonChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("FireCanPoison", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("ColdCanPoison", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
            flag_mod("LightningCanPoison", vec![tg(stag("Condition", vec![("var", s("AffectedByGloriousMadness"))]))]),
        ])),
        ("all damage from blast rain and artillery ballista hits can poison", Mods(vec![
            flag_mod("FireCanPoison", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blast Rain"), s("Artillery Ballista")]))]))]),
            flag_mod("ColdCanPoison", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blast Rain"), s("Artillery Ballista")]))]))]),
            flag_mod("LightningCanPoison", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blast Rain"), s("Artillery Ballista")]))]))]),
        ])),
        ("all damage from hits with freezing pulse and eye of winter can poison", Mods(vec![
            flag_mod("FireCanPoison", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Freezing Pulse"), s("Eye of Winter")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ColdCanPoison", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Freezing Pulse"), s("Eye of Winter")])), ("includeTransfigured", b(true))]))]),
            flag_mod("LightningCanPoison", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Freezing Pulse"), s("Eye of Winter")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("your chaos damage poisons enemies", Mods(vec![mk_mod("ChaosPoisonChance", "BASE", num(100.0), vec![])])),
        ("your chaos damage has (%d+)%% chance to poison enemies", Func(|a| Some(vec![mk_mod("ChaosPoisonChance", "BASE", num(a.n(1)), vec![])]))),
        ("melee attacks poison on hit", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![flags(mf::Melee)])])),
        ("triggered spells poison on hit", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![kw(kf::Spell), tg(stag("SkillType", vec![("skillType", num(37.0))]))])])),
        ("melee critical strikes have (%d+)%% chance to poison the enemy", Func(|a| Some(vec![mk_mod("PoisonChance", "BASE", num(a.n(1)), vec![flags(mf::Melee), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])]))),
        ("critical strikes with daggers have a (%d+)%% chance to poison the enemy", Func(|a| Some(vec![mk_mod("PoisonChance", "BASE", num(a.n(1)), vec![flags(mf::Dagger), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])]))),
        ("critical strikes with daggers poison the enemy", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![flags(mf::Dagger), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("poison cursed enemies on hit", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))])])),
        ("always poison on hit against cursed enemies", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))])])),
        ("wh[ie][ln]e? at maximum frenzy charges, attacks poison enemies", Mods(vec![mk_mod("PoisonChance", "BASE", num(100.0), vec![flags(mf::Attack), tg(stag("StatThreshold", vec![("stat", s("FrenzyCharges")), ("thresholdStat", s("FrenzyChargesMax"))]))])])),
        ("traps and mines have a (%d+)%% chance to poison on hit", Func(|a| Some(vec![mk_mod("PoisonChance", "BASE", num(a.n(1)), vec![kw(kf::Trap | kf::Mine)])]))),
        ("poisons you inflict deal damage (%d+)%% faster", Func(|a| Some(vec![mk_mod("PoisonFaster", "INC", num(a.n(1)), vec![])]))),
        ("(%d+)%% chance for poisons inflicted with this weapon to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Poison), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("(%d+)%% chance for poisons inflicted with blast rain or artillery balls?i?s?ta to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Poison), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blast Rain"), s("Artillery Ballista")]))]))]),
        ]))),
        ("(%d+)%% chance for poisons inflicted with freezing pulse and eye of winter to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Poison), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Freezing Pulse"), s("Eye of Winter")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("poisons you inflict on non%-poisoned enemies deal (%d+)%% increased damage", Func(|a| Some(vec![mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Poison), tg(stag("Condition", vec![("var", s("NonPoisonedOnly"))]))])]))),
        ("poisons inflicted by sunder or ground slam on non%-poisoned enemies deal (%d+)%% increased damage", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Poison), tg(stag("Condition", vec![("var", s("NonPoisonedOnly"))])), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Sunder"), s("Ground Slam")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("poisons on you expire (%d+)%% slower", Func(|a| Some(vec![mk_mod("SelfPoisonDebuffExpirationRate", "BASE", num(-a.n(1)), vec![])]))),
        ("(%d+)%% chance to inflict an additional poison on the same target when you inflict poison", Func(|a| Some(vec![mk_mod("AdditionalPoisonChance", "BASE", num(a.n(1)), vec![])]))),
        ("inflict (%d+) additional poisons? on the same target when you inflict poisons? with this weapon", Func(|a| Some(vec![mk_mod("AdditionalPoisonStacks", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])]))),
        ("cannot poison enemies with at least (%d+) poisons? on them", Func(|a| Some(vec![mk_mod("PoisonStackLimit", "MIN", num(a.n(1)), vec![])]))),
        ("cannot inflict multiple poisons in the same hit", Mods(vec![flag_mod("CannotMultiplePoison", vec![])])),
        ("wither on hit with this weapon against enemies with at least (%d+) poisons on them", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("y?o?u?r? ?chance to suppress spell damage is lucky", Mods(vec![flag_mod("SpellSuppressionChanceIsLucky", vec![])])),
        ("y?o?u?r? ?chance to suppress spell damage is unlucky", Mods(vec![flag_mod("SpellSuppressionChanceIsUnlucky", vec![])])),
        ("prevent %+(%d+)%% of suppressed spell damage", Func(|a| Some(vec![mk_mod("SpellSuppressionEffect", "BASE", num(a.n(1)), vec![])]))),
        ("prevent %+(%d+)%% of suppressed spell damage per hit suppressed recently", Func(|a| Some(vec![mk_mod("SpellSuppressionEffect", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("HitsSuppressedRecently"))]))])]))),
        ("prevent %+(%d+)%% of suppressed spell damage if you have not suppressed spell damage recently", Func(|a| Some(vec![mk_mod("SpellSuppressionEffect", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("SuppressedRecently")), ("neg", b(true))]))])]))),
        ("inflict fire, cold and lightning exposure on enemies when you suppress their spell damage", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("SuppressedRecently"))]))]),
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("SuppressedRecently"))]))]),
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("SuppressedRecently"))]))]),
        ])),
        ("critical strike chance is increased by chance to suppress spell damage", Mods(vec![flag_mod("CritChanceIncreasedBySpellSuppressChance", vec![])])),
        ("you take (%d+)%% reduced extra damage from suppressed critical strikes", Func(|a| Some(vec![mk_mod("ReduceSuppressedCritExtraDamage", "BASE", num(a.n(1)), vec![])]))),
        ("+(%d+)%% chance to suppress spell damage if your e?q?u?i?p?p?e?d? ?boots, helmet and gloves have evasion", Func(|a| Some(vec![
            mk_mod("SpellSuppressionChance", "BASE", num(a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("EvasionOnBoots")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("EvasionOnHelmet")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("EvasionOnGloves")), ("threshold", num(1.0))])),
            ]),
        ]))),
        ("evasion rating is doubled against projectile attacks", Mods(vec![mk_mod("ProjectileEvasion", "MORE", num(100.0), vec![])])),
        ("evasion rating is doubled against melee attacks", Mods(vec![mk_mod("MeleeEvasion", "MORE", num(100.0), vec![])])),
        ("+(%d+)%% chance to suppress spell damage for each dagger you're wielding", Func(|a| Some(vec![
            mk_mod("SpellSuppressionChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingDagger"))]))]),
            mk_mod("SpellSuppressionChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("DualWieldingDaggers"))]))]),
        ]))),
        ("phasing", Mods(vec![flag_mod("Condition:Phasing", vec![])])),
        ("onslaught", Mods(vec![flag_mod("Condition:Onslaught", vec![])])),
        ("rampage", Mods(vec![flag_mod("Condition:Rampage", vec![])])),
        ("soul eater", Mods(vec![flag_mod("Condition:CanHaveSoulEater", vec![])])),
        ("unholy might", Mods(vec![flag_mod("Condition:UnholyMight", vec![]), flag_mod("Condition:CanWither", vec![])])),
        ("chaotic might", Mods(vec![flag_mod("Condition:ChaoticMight", vec![])])),
        ("elusive", Mods(vec![flag_mod("Condition:CanBeElusive", vec![])])),
        ("adrenaline", Mods(vec![flag_mod("Condition:Adrenaline", vec![])])),
        ("arcane surge", Mods(vec![flag_mod("Condition:ArcaneSurge", vec![])])),
        ("your aura buffs do not affect allies", Mods(vec![flag_mod("SelfAurasCannotAffectAllies", vec![])])),
        ("your curses have (%d+)%% increased effect if (%d+)%% of curse duration expired", Func(|a| Some(vec![
            mk_mod("CurseEffect", "INC", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("actor", s("enemy")), ("var", s("CurseExpired")), ("threshold", num(a.n(2)))])), tg(stag("SkillType", vec![("skillType", num(97.0))]))]),
        ]))),
        ("non%-aura hexes expire upon reaching (%d+)%% of base effect non%-aura hexes gain (%d+)%% increased effect per second", Func(|a| Some(vec![
            mk_mod("CurseEffect", "INC", num(a.n(2)), vec![tg(stag("Multiplier", vec![("actor", s("enemy")), ("var", s("CurseDurationExpired")), ("limit", num(a.n(1))), ("limitTotal", b(true))])), tg(stag("SkillType", vec![("skillType", num(39.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(97.0))]))]),
        ]))),
        ("enemies cursed by you have malediction if (%d+)%% of curse duration expired", Func(|a| Some(vec![
            wrap("EnemyModifier", flag_mod("HasMalediction", vec![tg(stag("MultiplierThreshold", vec![("var", s("CurseExpired")), ("threshold", num(a.n(1)))])), tg(stag("ActorCondition", vec![("var", s("Cursed"))]))]), vec![]),
        ]))),
        ("enemies cursed by you are hindered if (%d+)%% of curse duration expired", Func(|a| Some(vec![
            wrap("EnemyModifier", flag_mod("Condition:Hindered", vec![tg(stag("MultiplierThreshold", vec![("var", s("CurseExpired")), ("threshold", num(a.n(1)))])), tg(stag("ActorCondition", vec![("var", s("Cursed"))]))]), vec![]),
        ]))),
        ("excommunicate enemies on melee hit for (%d+) seconds", Mods(vec![flag_mod("Condition:CanExcommunicate", vec![])])),
    ]
}

fn part8() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 3228-3271: global/socketed gem properties
        ("([%+%-]%d+)%% to quality of all skill gems", Func(|a| Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("grants_active_skill")), ("key".to_string(), s("quality")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]), vec![])]))),
        ("([%+%-]%d+) to level of all elemental skill gems if the stars are aligned", Func(|a| Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keywordList".to_string(), PVal::List(vec![s("elemental"), s("grants_active_skill")])), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]), vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))])]))),
        ("([%+%-]%d+) to level of all elemental support gems if the stars are aligned", Func(|a| Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keywordList".to_string(), PVal::List(vec![s("elemental"), s("support")])), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]), vec![tg(stag("Condition", vec![("var", s("StarsAreAligned"))]))])]))),
        ("([%+%-]%d+) to level of socketed active skill gems per (%d+) player levels", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("grants_active_skill")), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1)))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("Multiplier", vec![("var", s("Level")), ("div", num(a.n(2)))]))]),
        ]))),
        ("([%+%-]%d+) to level of all (%a+) skill gems if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s(a.s(2))), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]),
                vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(4)))) ), ("threshold", num(a.n(3)))]))]),
        ]))),
        ("([%+%-]%d+) to level of all (%a+) skill gems if a?t? ?l?e?a?s?t? ?(%d+) (%a+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s(a.s(2))), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]),
                vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}{}Item", first_upper(a.s(4)), first_upper(a.s(5))))), ("threshold", num(a.n(3)))]))]),
        ]))),
        ("([%+%-]%d+) to level of all ?([%a%- ]*) support gems if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s(a.s(2))), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]),
                vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(4))))), ("threshold", num(a.n(3)))]))]),
        ]))),
        ("([%+%-]%d+) to level of socketed skill gems per (%d+) player levels", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("grants_active_skill")), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1)))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("Multiplier", vec![("var", s("Level")), ("div", num(a.n(2)))]))]),
        ]))),
        ("([%+%-]%d+) to level of socketed gems while there is a single gem socketed in this item", Func(|a| Some(vec![
            mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("all")), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1)))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("MultiplierThreshold", vec![("var", s("SocketedGemsIn{SlotName}")), ("threshold", num(1.0)), ("equals", b(true))]))]),
        ]))),
        ("socketed gems fire an additional projectile", Mods(vec![wrap("ExtraSkillMod", mk_mod("ProjectileCount", "BASE", num(1.0), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed gems fire (%d+) additional projectiles", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])]))),
        ("socketed gems reserve no mana", Mods(vec![mk_mod("ManaReserved", "MORE", num(-100.0), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed gems have no reservation", Mods(vec![mk_mod("Reserved", "MORE", num(-100.0), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed skill gems get a (%d+)%% mana multiplier", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("SupportManaMultiplier", "MORE", num(a.n(1) - 100.0), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])]))),
        ("socketed skill gems get a (%d+)%% cost & reservation multiplier", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("SupportManaMultiplier", "MORE", num(a.n(1) - 100.0), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])]))),
        ("socketed gems have blood magic", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportBloodMagicUniquePrismGuardian")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed gems cost and reserve life instead of mana", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportBloodMagicUniquePrismGuardian")), ("level".to_string(), num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed gems have elemental equilibrium", Mods(vec![mk_mod("Keystone", "LIST", s("Elemental Equilibrium"), vec![])])),
        ("socketed gems have secrets of suffering", Mods(vec![
            flag_mod("CannotIgnite", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
            flag_mod("CannotChill", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
            flag_mod("CannotFreeze", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
            flag_mod("CannotShock", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
            flag_mod("CritAlwaysAltAilments", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("socketed skills deal double damage", Mods(vec![wrap("ExtraSkillMod", mk_mod("DoubleDamageChance", "BASE", num(100.0), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed gems gain (%d+)%% of physical damage as extra lightning damage", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("PhysicalDamageGainAsLightning", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])]))),
        ("socketed red gems get (%d+)%% physical damage as extra fire damage", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("strength"))]))])]))),
        ("socketed non%-channelling bow skills are triggered by snipe", Mods(vec![])),
        ("grants level (%d+) snipe skill", Func(|a| Some(vec![
            mk_mod("ExtraSkill", "LIST", PVal::Map(vec![("skillId".to_string(), s("Snipe")), ("level".to_string(), num(a.n(1)))]), vec![]),
            mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("ChannelledSnipeSupport")), ("level".to_string(), num(a.n(1)))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ]))),
        ("socketed triggered bow skills deal (%d+)%% less damage", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("Damage", "MORE", num(-a.n(1)), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("bow"))])), tg(stag("SkillType", vec![("skillType", num(32.0))]))])]))),
        ("socketed vaal skills require (%d+)%% less souls per use", Func(|a| Some(vec![wrap("ExtraSkillMod", mk_mod("SoulCost", "MORE", num(-a.n(1)), vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("SkillType", vec![("skillType", num(38.0))]))])]))),
        ("hits from socketed vaal skills ignore enemy monster resistances", Mods(vec![
            wrap("ExtraSkillMod", flag_mod("IgnoreElementalResistances", vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("SkillType", vec![("skillType", num(38.0))]))]),
            wrap("ExtraSkillMod", flag_mod("IgnoreChaosResistance", vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("SkillType", vec![("skillType", num(38.0))]))]),
        ])),
        ("hits from socketed vaal skills ignore enemy monster physical damage reduction", Mods(vec![wrap("ExtraSkillMod", flag_mod("IgnoreEnemyPhysicalDamageReduction", vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("SkillType", vec![("skillType", num(38.0))]))])])),
        ("socketed vaal skills grant elusive when used", Mods(vec![flag_mod("Condition:CanBeElusive", vec![])])),
        ("damage with hits from socketed vaal skills is lucky", Mods(vec![wrap("ExtraSkillMod", flag_mod("LuckyHits", vec![]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("SkillType", vec![("skillType", num(38.0))]))])])),
        ("([%+%-]%d+)%%? to (%a+) of all (.+) gems", Func(|a| {
            let skill = a.s(3);
            if gem_id_lookup().contains_key(skill) {
                Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s(skill)), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]), vec![])])
            } else {
                let word_list: Vec<PVal> = skill.split_whitespace().map(s).collect();
                Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keywordList".to_string(), PVal::List(word_list)), ("key".to_string(), s(a.s(2))), ("value".to_string(), num(a.n(1))), ("keyOfScaledMod".to_string(), s("value"))]), vec![])])
            }
        })),
        ("gems socketed in red sockets have [%+%-](%d+) to level", Func(|a| Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("all")), ("key".to_string(), s("level")), ("value".to_string(), num(a.n(1)))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("socketColor", s("R"))]))])]))),
        ("gems socketed in green sockets have [%+%-](%d+)%% to quality", Func(|a| Some(vec![mk_mod("GemProperty", "LIST", PVal::Map(vec![("keyword".to_string(), s("all")), ("key".to_string(), s("quality")), ("value".to_string(), num(a.n(1)))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("socketColor", s("G"))]))])]))),
        ("%+(%d+)%% to fire resistance when socketed with a red gem", Func(|a| Some(vec![
            mk_mod("SocketProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("FireResist", "BASE", num(a.n(1)), vec![])))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("strength")), ("sockets", PVal::List(vec![num(1.0)]))]))]),
        ]))),
        ("%+(%d+)%% to cold resistance when socketed with a green gem", Func(|a| Some(vec![
            mk_mod("SocketProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("ColdResist", "BASE", num(a.n(1)), vec![])))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("dexterity")), ("sockets", PVal::List(vec![num(1.0)]))]))]),
        ]))),
        ("%+(%d+)%% to lightning resistance when socketed with a blue gem", Func(|a| Some(vec![
            mk_mod("SocketProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("LightningResist", "BASE", num(a.n(1)), vec![])))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("intelligence")), ("sockets", PVal::List(vec![num(1.0)]))]))]),
        ]))),
        ("attack skills gain (%d+)%% of physical damage as extra fire damage per socketed red gem", Func(|a| Some(vec![
            mk_mod("SocketProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(1)), vec![flags(mf::Attack)])))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("strength")), ("sockets", PVal::List((1..=6).map(|i| num(i as f64)).collect()))]))]),
        ]))),
        ("(%d+)%% of damage taken recouped as life per socketed red gem", Func(|a| Some(vec![
            mk_mod("SocketProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("LifeRecoup", "BASE", num(a.n(1)), vec![])))]),
                vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("keyword", s("strength")), ("sockets", PVal::List((1..=6).map(|i| num(i as f64)).collect()))]))]),
        ]))),
        ("you have vaal pact while all socketed gems are red", Mods(vec![mk_mod("GroupProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("Keystone", "LIST", s("Vaal Pact"), vec![])))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("socketColor", s("R")), ("sockets", s("all"))]))])])),
        ("you have immortal ambition while all socketed gems are red", Mods(vec![mk_mod("GroupProperty", "LIST", PVal::Map(vec![("value".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("Keystone", "LIST", s("Immortal Ambition"), vec![])))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}")), ("socketColor", s("R")), ("sockets", s("all"))]))])])),
        ("everlasting sacrifice", Mods(vec![flag_mod("Condition:EverlastingSacrifice", vec![])])),
        // 3297-3317: self-hit damage
        ("take (%d+) (.+) damage when you ignite an enemy", Func(|a| Some(vec![mk_mod("EyeOfInnocenceSelfDamage", "LIST", PVal::Map(vec![("baseDamage".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        ("(%d+) (.+) damage taken on minion death", Func(|a| Some(vec![mk_mod("HeartboundLoopSelfDamage", "LIST", PVal::Map(vec![("baseDamage".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        ("take (%d+) (.+) damage when herald of thunder hits an enemy", Func(|a| Some(vec![mk_mod("StormSecretSelfDamage", "LIST", PVal::Map(vec![("baseDamage".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        ("take (%d+) (.+) damage when you use a skill", Func(|a| Some(vec![mk_mod("EnmitysEmbraceSelfDamage", "LIST", PVal::Map(vec![("baseDamage".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        ("your skills deal you (%d+)%% of mana cost as (.+) damage", Func(|a| Some(vec![mk_mod("ScoldsBridleSelfDamage", "LIST", PVal::Map(vec![("dmgMult".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        ("your skills deal you (%d+)%% of mana spent on upfront skill mana costs as (.+) damage", Func(|a| Some(vec![mk_mod("ScoldsBridleSelfDamage", "LIST", PVal::Map(vec![("dmgMult".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        ("when you attack, take (%d+)%% of life as (.+) damage for each warcry exerting the attack", Func(|a| Some(vec![mk_mod("EchoesOfCreationSelfDamage", "LIST", PVal::Map(vec![("dmgMult".to_string(), num(a.n(1))), ("damageType".to_string(), s(a.s(2)))]), vec![])]))),
        // 3319-3423: extra skill/support (helpers.rs)
        // Lua: function(_, skill) -- single capture, so skill is cap1 (was reading the
        // nonexistent cap2, same off-by-one class as the "curse enemies with" fix above).
        ("grants (%D+)", Func(|a| granted_extra_skill(a.s(1), 1.0, false))),
        ("grants level (%d+) (.+)", Func(|a| granted_extra_skill(a.s(2), a.n(1), false))),
        ("grants level (%d+) (.+), which will be used by shaper memory", Func(|a| granted_extra_skill(a.s(2), a.n(1), false))),
        ("(.+) can trigger level (%d+) (.+)", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { source_skill: Some(a.s(1)), ..Default::default() })))),
        ("trigger level (%d+) (.+) when you consume a corpse", Func(|a| {
            let skill = a.s(2);
            let name = if skill == "summon phantasm skill" { "triggered summon phantasm skill" } else { skill };
            Some(trigger_extra_skill(name, a.n(1), TriggerOptions::default()))
        })),
        ("trigger level (%d+) (.+) on critical strike with cleave or reave", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { on_crit: true, ..Default::default() })))),
        ("trigger level (%d+) (.+) on melee critical strike", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { on_crit: true, ..Default::default() })))),
        ("trigger level (%d+) (.+) on critical strike against marked unique enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { on_crit: true, ..Default::default() })))),
        ("trigger level (%d+) (.+) on critical strike", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { on_crit: true, ..Default::default() })))),
        ("trigger level (%d+) (.+) on attack critical strike against a rare or unique enemy and y?o?u? ?have no mark", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { on_crit: true, ..Default::default() })))),
        // ModParser.lua:2620 -- was entirely missing from this port.
        ("trigger level (%d+) (.+) when you attack with a non%-vaal slam or strike skill near an enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("(%d+)%% chance to attack with level (%d+) (.+) on melee hit", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) when animated weapon kills an enemy", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) on melee hit", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) [ow][nh]e?n? ?y?o?u? kill ?a?n? ?e?n?e?m?y?", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) when you use a socketed skill", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) when you gain avian's might or avian's flight", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) on critical strike with this weapon", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), on_crit: true, ..Default::default() })))),
        ("(%d+)%% chance to trigger level (%d+) (.+) when you or a nearby ally kill an enemy, or hit a rare or unique enemy", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to trigger (.+) when you kill an enemy", Func(|a| Some(trigger_extra_skill(a.s(2), 1.0, TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("(%d+)%% chance to [ct][ar][si][tg]g?e?r? level (%d+) (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(3), a.n(2), TriggerOptions { trigger_chance: Some(a.n(1)), ..Default::default() })))),
        ("attack with level (%d+) (.+) when you kill a bleeding enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("triggers? level (%d+) (.+) when you kill a bleeding enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        // Lua: function(_, skill) -- single capture, so skill is cap1 (was reading cap2, which
        // doesn't exist for this pattern and fell back to an empty string).
        ("curse enemies with (%D+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("curse enemies with level (%d+) (%D+) on %a+, which can apply to hexproof enemies", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { no_supports: true, ignore_hexproof: true, ..Default::default() })))),
        ("curse enemies with level (%d+) (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions { no_supports: true, ..Default::default() })))),
        ("curse enemies with (%D+) on %a+, with (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(1)).map(|x| x.as_str()), vec![("level", num(1.0)), ("noSupports", b(true)), ("triggered", b(true))]), vec![]),
            mk_mod("CurseEffect", "INC", num(a.n(2)), vec![tg(stag("SkillName", vec![("skillName", s(title_case(a.s(1))))]))]),
        ]))),
        ("curse enemies with (%D+) on %a+, with (%d+)%% reduced effect", Func(|a| Some(vec![
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(1)).map(|x| x.as_str()), vec![("level", num(1.0)), ("noSupports", b(true)), ("triggered", b(true))]), vec![]),
            mk_mod("CurseEffect", "INC", num(-a.n(2)), vec![tg(stag("SkillName", vec![("skillName", s(title_case(a.s(1))))]))]),
        ]))),
        ("%d+%% chance to curse n?o?n?%-?c?u?r?s?e?d? ?enemies with (%D+) on %a+, with (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(1)).map(|x| x.as_str()), vec![("level", num(1.0)), ("noSupports", b(true)), ("triggered", b(true))]), vec![]),
            mk_mod("CurseEffect", "INC", num(a.n(2)), vec![tg(stag("SkillName", vec![("skillName", s(title_case(a.s(1))))]))]),
        ]))),
        ("%d+%% chance to curse n?o?n?%-?c?u?r?s?e?d? ?enemies with (%D+) on %a+", Func(|a| Some(vec![
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(1)).map(|x| x.as_str()), vec![("level", num(1.0)), ("noSupports", b(true)), ("triggered", b(true))]), vec![]),
        ]))),
        ("[ct][ar][si][tg]g?e?r?s? (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[at][tr][ti][ag][cg][ke]r? (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[at][tr][ti][ag][cg][ke]r? with (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[ct][ar][si][tg]g?e?r?s? (.+) when hit", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[at][tr][ti][ag][cg][ke]r? (.+) when hit", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[at][tr][ti][ag][cg][ke]r? with (.+) when hit", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[ct][ar][si][tg]g?e?r?s? (.+) when your skills or minions kill", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[at][tr][ti][ag][cg][ke]r? (.+) when you take a critical strike", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("[at][tr][ti][ag][cg][ke]r? with (.+) when you take a critical strike", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("trigger commandment of inferno on critical strike", Mods(vec![
            mk_mod("ExtraSkill", "LIST", PVal::Map(vec![("skillId".to_string(), s("UniqueEnchantmentOfInfernoOnCrit")), ("level".to_string(), num(1.0)), ("noSupports".to_string(), b(true)), ("triggered".to_string(), b(true))]), vec![]),
            mk_mod("ExtraSkillMod", "LIST", PVal::Map(vec![("mod".to_string(), crate::modparser::types::mod_to_pval(&mk_mod("SkillData", "LIST", PVal::Map(vec![("key".to_string(), s("triggerOnCrit")), ("value".to_string(), b(true))]), vec![])))]),
                vec![tg(stag("SkillId", vec![("skillId", s("UniqueEnchantmentOfInfernoOnCrit"))]))]),
        ])),
        ("trigger (.+) on critical strike", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, on_crit: true, ..Default::default() })))),
        ("triggers? (.+) when you take a critical strike", Func(|a| Some(trigger_extra_skill(a.s(1), 1.0, TriggerOptions { no_supports: true, ..Default::default() })))),
        ("socketed [%a+]* ?gems a?r?e? ?supported by level (%d+) (.+)", Func(|a| extra_support(a.s(2), a.n(1), None, false))),
        ("socketed [%a+]* ?spells a?r?e? ?supported by level (%d+) (.+)", Func(|a| extra_support(a.s(2), a.n(1), None, false))),
        ("skills from equipped (.+) are supported by level (%d+) (.+)", Func(|a| extra_support(a.s(3), a.n(2), Some(a.s(1)), false))),
        ("skills socketed in your (.+) are supported by level (%d+) (.+)", Func(|a| extra_support(a.s(3), a.n(2), Some(a.s(1)), true))),
        ("skills granted by your passive tree are supported by level (%d+) (.+)", Func(|a| extra_support(a.s(2), a.n(1), Some("passive tree"), true))),
        ("socketed support gems can also support skills from y?o?u?r? ?e?q?u?i?p?p?e?d? ?([%a%s]+)", Func(|a| {
            let target = if a.s(1) == "main hand" { "Weapon 1" } else { "Body Armour" };
            Some(vec![mk_mod("LinkedSupport", "LIST", PVal::Map(vec![("targetSlotName".to_string(), s(target))]), vec![])])
        })),
        ("socketed hex curse skills are triggered by doedre's effigy when summoned", Mods(vec![mk_mod("ExtraSupport", "LIST", PVal::Map(vec![("skillId".to_string(), s("SupportCursePillarTriggerCurses")), ("level".to_string(), num(20.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))])])),
        ("socketed projectile spells have %+([%d%.]+) seconds to cooldown", Func(|a| Some(vec![
            mk_mod("CooldownRecovery", "BASE", num(a.n(1)), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))])), tg(stag("SkillType", vec![("skillType", num(3.0))])), tg(stag("SkillType", vec![("skillType", num(2.0))]))]),
        ]))),
        ("trigger level (%d+) (.+) every (%d+) seconds", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+), (.+) or (.+) every (%d+) seconds", Func(|a| Some(vec![
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(2)).map(|x| x.as_str()), vec![("level", num(a.n(1))), ("triggered", b(true))]), vec![]),
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(3)).map(|x| x.as_str()), vec![("level", num(a.n(1))), ("triggered", b(true))]), vec![]),
            mk_mod("ExtraSkill", "LIST", ext_skill_map(gem_id_lookup().get(a.s(4)).map(|x| x.as_str()), vec![("level", num(a.n(1))), ("triggered", b(true))]), vec![]),
        ]))),
        ("offering skills triggered this way also affect you", Mods(vec![wrap("ExtraSkillMod", mk_mod("SkillData", "LIST", PVal::Map(vec![("key".to_string(), s("buffNotPlayer")), ("value".to_string(), b(false))]), vec![]),
            vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Bone Offering"), s("Flesh Offering"), s("Spirit Offering")]))]))])])),
        ("trigger level (%d+) (.+) after spending a total of (%d+) mana", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("consumes a void charge to trigger level (%d+) (.+) when you fire arrows", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("consumes a void charge to trigger level (%d+) (.+) when you fire arrows with a non%-triggered skill", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) when equipped", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("use level (%d+) (.+) on %a+", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) when you attack", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) when you deal a critical strike", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) when hit", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) when you kill an enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("[ct][ar][si][tg]g?e?r?s? level (%d+) (.+) when you use a skill", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you use a skill while you have a spirit charge", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you hit an enemy while cursed", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you hit a bleeding enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you attack with this weapon", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you hit a rare or unique enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you hit a rare or unique enemy and have no mark", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you hit a frozen enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you kill a frozen enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you attack with a bow", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you block", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when animated guardian kills an enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you lose cat's stealth", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when your trap is triggered", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) on hit with this weapon", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) on melee hit", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) on melee hit while cursed", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) on melee hit with this weapon", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) every [%d%.]+ seconds while phasing", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you gain avian's might or avian's flight", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) on melee hit if you have at least (%d+) strength", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you take a critical strike from a unique enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you suppress spell damage from a unique enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you block damage from a unique enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) on taking a savage hit from a unique enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when a totem dies while a unique enemy is in your presence", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you use a travel skill while a unique enemy is in your presence", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you reach maximum rage while a unique enemy is in your presence", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when you reach low life while a unique enemy is in your presence", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when energy shield recharge starts while a unique enemy is in your presence", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) when your ward breaks", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("trigger level (%d+) (.+) once every second", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("triggers level (%d+) (.+)", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("triggers level (%d+) (.+) when equipped", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("triggers level (%d+) (.+) when allocated", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("attack with level (%d+) (.+) when you kill a bleeding enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
        ("triggers? level (%d+) (.+) when you kill a bleeding enemy", Func(|a| Some(trigger_extra_skill(a.s(2), a.n(1), TriggerOptions::default())))),
    ]
}

fn part9() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 3442-3907
        ("your hits treat cold resistance as (%d+)%% higher than actual value", Func(|a| Some(vec![mk_mod("ColdPenetration", "BASE", num(-a.n(1)), vec![kw(kf::Hit)])]))),
        ("increases and reductions to minion damage also affects? you", Mods(vec![flag_mod("MinionDamageAppliesToPlayer", vec![])])),
        ("increases and reductions to minion damage also affects? you at (%d+)%% of their value", Func(|a| Some(vec![flag_mod("MinionDamageAppliesToPlayer", vec![]), mk_mod("ImprovedMinionDamageAppliesToPlayer", "MAX", num(a.n(1)), vec![])]))),
        ("increases and reductions to minion damage also affect dominating blow and absolution at (%d+)%% of their value", Func(|a| Some(vec![
            flag_mod("MinionDamageAppliesToPlayer", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Dominating Blow"), s("Absolution")])), ("includeTransfigured", b(true))]))]),
            mk_mod("ImprovedMinionDamageAppliesToPlayer", "MAX", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Dominating Blow"), s("Absolution")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("increases and reductions to minion attack speed also affects? you", Mods(vec![flag_mod("MinionAttackSpeedAppliesToPlayer", vec![])])),
        ("increases and reductions to minion cast speed also affects? you", Mods(vec![flag_mod("MinionCastSpeedAppliesToPlayer", vec![])])),
        ("increases and reductions to minion maximum life also apply to you at (%d+)%% of their value", Func(|a| Some(vec![flag_mod("MinionLifeAppliesToPlayer", vec![]), mk_mod("ImprovedMinionLifeAppliesToPlayer", "MAX", num(a.n(1)), vec![])]))),
        ("increases and reductions to cast speed apply to attack speed at (%d+)%% of their value", Func(|a| Some(vec![flag_mod("CastSpeedAppliesToAttacks", vec![]), mk_mod("ImprovedCastSpeedAppliesToAttacks", "MAX", num(a.n(1)), vec![])]))),
        ("increases and reductions to cast speed apply to attack speed", Func(|_a| Some(vec![flag_mod("CastSpeedAppliesToAttacks", vec![])]))),
        ("increases and reductions to spell damage also apply to attacks", Mods(vec![flag_mod("SpellDamageAppliesToAttacks", vec![])])),
        ("increases and reductions to your evasion rating also apply to your spell damage", Mods(vec![flag_mod("EvasionAppliesToSpellDamage", vec![])])),
        ("arcane might", Mods(vec![flag_mod("SpellDamageAppliesToAttacks", vec![])])),
        ("(%d+)%% arcane might", Func(|a| Some(vec![flag_mod("SpellDamageAppliesToAttacks", vec![]), mk_mod("ImprovedSpellDamageAppliesToAttacks", "MAX", num(a.n(1)), vec![])]))),
        ("attacks have (%d+)%% arcane might", Func(|a| Some(vec![flag_mod("SpellDamageAppliesToAttacks", vec![]), mk_mod("ImprovedSpellDamageAppliesToAttacks", "MAX", num(a.n(1)), vec![])]))),
        ("attacks have (%d+)%% arcane might while wielding a wand", Func(|a| Some(vec![
            flag_mod("SpellDamageAppliesToAttacks", vec![tg(stag("Condition", vec![("var", s("UsingWand"))]))]),
            mk_mod("ImprovedSpellDamageAppliesToAttacks", "MAX", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingWand"))]))]),
        ]))),
        ("retaliation skills have (%d+)%% arcane might", Func(|a| Some(vec![
            flag_mod("SpellDamageAppliesToAttacks", vec![tg(stag("SkillType", vec![("skillType", num(121.0))]))]),
            mk_mod("ImprovedSpellDamageAppliesToAttacks", "MAX", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(121.0))]))]),
        ]))),
        ("attacks have arcane might while wielding a wand", Mods(vec![flag_mod("SpellDamageAppliesToAttacks", vec![tg(stag("Condition", vec![("var", s("UsingWand"))]))])])),
        ("increases and reductions to spell damage also apply to attacks at (%d+)%% of their value", Func(|a| Some(vec![flag_mod("SpellDamageAppliesToAttacks", vec![]), mk_mod("ImprovedSpellDamageAppliesToAttacks", "MAX", num(a.n(1)), vec![])]))),
        ("increases and reductions to spell damage also apply to attack damage with retaliation skills at (%d+)%% of their value", Func(|a| Some(vec![
            flag_mod("SpellDamageAppliesToAttacks", vec![tg(stag("SkillType", vec![("skillType", num(121.0))]))]),
            mk_mod("ImprovedSpellDamageAppliesToAttacks", "MAX", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(121.0))]))]),
        ]))),
        ("increases and reductions to spell damage also apply to attacks while wielding a wand", Mods(vec![flag_mod("SpellDamageAppliesToAttacks", vec![tg(stag("Condition", vec![("var", s("UsingWand"))]))])])),
        ("increases and reductions to maximum mana also apply to shock effect at (%d+)%% of their value", Func(|a| Some(vec![flag_mod("ManaAppliesToShockEffect", vec![]), mk_mod("ImprovedManaAppliesToShockEffect", "MAX", num(a.n(1)), vec![])]))),
        // Lua: function(_, element, skillElement, effect, limit) -- 4 captures, 1-based; the
        // indices below were shifted by one (using 2/3/4/5 instead of 1/2/3/4).
        ("increases and reductions to (%a+) damage also apply to effect of auras from (%a+) skills at (%d+)%% of their value, up to a maximum of (%d+)%%", Func(|a| {
            let element = first_upper(a.s(1));
            let skill_element = first_upper(a.s(2));
            Some(vec![
                flag_mod(format!("{}DamageAppliesTo{}AuraEffect", element, skill_element), vec![]),
                mk_mod(format!("Improved{}DamageAppliesTo{}AuraEffect", element, skill_element), "BASE", num(a.n(3)), vec![]),
                mk_mod(format!("{}DamageAppliesTo{}AuraEffectLimit", element, skill_element), "MAX", num(a.n(4)), vec![]),
            ])
        })),
        ("modifiers to claw damage also apply to unarmed", Mods(vec![flag_mod("ClawDamageAppliesToUnarmed", vec![])])),
        ("modifiers to claw damage also apply to unarmed attack damage", Mods(vec![flag_mod("ClawDamageAppliesToUnarmed", vec![])])),
        ("modifiers to claw damage also apply to unarmed attack damage with melee skills", Mods(vec![flag_mod("ClawDamageAppliesToUnarmed", vec![])])),
        ("modifiers to claw attack speed also apply to unarmed", Mods(vec![flag_mod("ClawAttackSpeedAppliesToUnarmed", vec![])])),
        ("modifiers to claw attack speed also apply to unarmed attack speed", Mods(vec![flag_mod("ClawAttackSpeedAppliesToUnarmed", vec![])])),
        ("modifiers to claw attack speed also apply to unarmed attack speed with melee skills", Mods(vec![flag_mod("ClawAttackSpeedAppliesToUnarmed", vec![])])),
        ("modifiers to claw critical strike chance also apply to unarmed", Mods(vec![flag_mod("ClawCritChanceAppliesToUnarmed", vec![])])),
        ("modifiers to claw critical strike chance also apply to unarmed attack critical strike chance", Mods(vec![flag_mod("ClawCritChanceAppliesToUnarmed", vec![])])),
        ("modifiers to claw critical strike chance also apply to unarmed critical strike chance with melee skills", Mods(vec![flag_mod("ClawCritChanceAppliesToUnarmed", vec![])])),
        ("increases and reductions to light radius also apply to accuracy", Mods(vec![flag_mod("LightRadiusAppliesToAccuracy", vec![])])),
        ("increases and reductions to light radius also apply to area of effect at 50%% of their value", Mods(vec![flag_mod("LightRadiusAppliesToAreaOfEffect", vec![])])),
        ("increases and reductions to light radius also apply to damage", Mods(vec![flag_mod("LightRadiusAppliesToDamage", vec![])])),
        ("increases and reductions to cast speed also apply to trap throwing speed", Mods(vec![flag_mod("CastSpeedAppliesToTrapThrowingSpeed", vec![])])),
        ("increases and reductions to armour also apply to energy shield recharge rate at (%d+)%% of their value", Func(|a| Some(vec![flag_mod("ArmourAppliesToEnergyShieldRecharge", vec![]), mk_mod("ImprovedArmourAppliesToEnergyShieldRecharge", "MAX", num(a.n(1)), vec![])]))),
        ("increases and reductions to projectile speed also apply to damage with bows", Mods(vec![flag_mod("ProjectileSpeedAppliesToBowDamage", vec![])])),
        // Lua: function(_, resFrom, resTo1, resTo2[, rate]) -- resFrom is capture 1, resTo1 is
        // capture 2, resTo2 is capture 3, rate is capture 4 (all were shifted by one below).
        ("modifiers to maximum (%a+) resistance also apply to maximum (%a+) and (%a+) resistances", Func(|a| {
            let from = first_upper(a.s(1));
            Some(vec![
                mk_mod(format!("{}MaxResConvertTo{}", from, first_upper(a.s(2))), "BASE", num(100.0), vec![]),
                mk_mod(format!("{}MaxResConvertTo{}", from, first_upper(a.s(3))), "BASE", num(100.0), vec![]),
            ])
        })),
        ("modifiers to (%a+) resistance also apply to (%a+) and (%a+) resistances at (%d+)%% of their value", Func(|a| {
            let from = first_upper(a.s(1));
            Some(vec![
                mk_mod(format!("{}ResConvertTo{}", from, first_upper(a.s(2))), "BASE", num(a.n(4)), vec![]),
                mk_mod(format!("{}ResConvertTo{}", from, first_upper(a.s(3))), "BASE", num(a.n(4)), vec![]),
            ])
        })),
        ("gain (%d+)%% of bow physical damage as extra damage of each element", Func(|a| Some(vec![
            mk_mod("PhysicalDamageGainAsLightning", "BASE", num(a.n(1)), vec![flags(mf::Bow)]),
            mk_mod("PhysicalDamageGainAsCold", "BASE", num(a.n(1)), vec![flags(mf::Bow)]),
            mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(1)), vec![flags(mf::Bow)]),
        ]))),
        ("gain (%d+)%% of weapon physical damage as extra damage of each element", Func(|a| Some(vec![
            mk_mod("PhysicalDamageGainAsLightning", "BASE", num(a.n(1)), vec![flags(mf::Weapon)]),
            mk_mod("PhysicalDamageGainAsCold", "BASE", num(a.n(1)), vec![flags(mf::Weapon)]),
            mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(1)), vec![flags(mf::Weapon)]),
        ]))),
        ("gain (%d+)%% of physical damage as extra damage of each element per spirit charge", Func(|a| Some(vec![
            mk_mod("PhysicalDamageGainAsLightning", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("SpiritCharge"))]))]),
            mk_mod("PhysicalDamageGainAsCold", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("SpiritCharge"))]))]),
            mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("SpiritCharge"))]))]),
        ]))),
        ("gain (%d+)%% of physical damage as extra damage of each element if (%d+) (%a+) items are equipped", Func(|a| {
            let var = format!("{}Item", first_upper(a.s(3)));
            Some(vec![
                mk_mod("PhysicalDamageGainAsLightning", "BASE", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s(var.clone())), ("threshold", num(a.n(2)))]))]),
                mk_mod("PhysicalDamageGainAsCold", "BASE", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s(var.clone())), ("threshold", num(a.n(2)))]))]),
                mk_mod("PhysicalDamageGainAsFire", "BASE", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s(var)), ("threshold", num(a.n(2)))]))]),
            ])
        })),
        ("gain (%d+)%% of weapon physical damage as extra damage of an? r?a?n?d?o?m? ?element", Func(|a| Some(vec![mk_mod("PhysicalDamageGainAsRandom", "BASE", num(a.n(1)), vec![flags(mf::Weapon)])]))),
        ("gain (%d+)%% of physical damage as extra damage of a random element", Func(|a| Some(vec![mk_mod("PhysicalDamageGainAsRandom", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% chance for hits to deal (%d+)%% of physical damage as extra damage of a random element", Func(|a| Some(vec![mk_mod("PhysicalDamageGainAsRandom", "BASE", num(a.n(1) * a.n(2) / 100.0), vec![])]))),
        ("gain (%d+)%% of physical damage as a random element if you've cast (.-) in the past (%d+) seconds", Func(|a| {
            let curse = title_case(a.s(2)).replace(' ', "");
            Some(vec![mk_mod("PhysicalDamageGainAsRandom", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", curse)))]))])])
        })),
        ("gain (%d+)%% of physical damage as extra damage of a random element while you are ignited", Func(|a| Some(vec![mk_mod("PhysicalDamageGainAsRandom", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Ignited"))]))])]))),
        ("(%d+)%% of physical damage from hits with this weapon is converted to a random element", Func(|a| Some(vec![mk_mod("PhysicalDamageConvertToRandom", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])]))),
        ("(%d+)%% of physical damage converted to a random element", Func(|a| Some(vec![mk_mod("PhysicalDamageConvertToRandom", "BASE", num(a.n(1)), vec![])]))),
        ("nearby enemies convert (%d+)%% of their (%a+) damage to (%a+)", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("enemies ignited by you have (%d+)%% of (%a+) damage they deal converted to (%a+)", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Ignited"))]))]), vec![]),
        ]))),
        ("enemies shocked by you have (%d+)%% of (%a+) damage they deal converted to (%a+)", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Shocked"))]))]), vec![]),
        ]))),
        ("enemies poisoned by you have (%d+)%% of (%a+) damage they deal converted to (%a+)", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Poisoned"))]))]), vec![]),
        ]))),
        ("shield crush and spectral shield throw do not gain added physical damage based on armour or evasion on shield", Mods(vec![flag_mod("Condition:ShieldThrowCrushNoArmourEvasion", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Spectral Shield Throw"), s("Shield Crush")])), ("includeTransfigured", b(true))]))])])),
        ("shield crush and spectral shield throw gains (%d+) to (%d+) added lightning damage per (%d+) energy shield on shield", Func(|a| Some(vec![
            mk_mod("LightningMin", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("OffHandAttack"))])), tg(stag("PerStat", vec![("stat", s("EnergyShieldOnWeapon 2")), ("div", num(a.n(3)))])), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Spectral Shield Throw"), s("Shield Crush")])), ("includeTransfigured", b(true))]))]),
            mk_mod("LightningMax", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("OffHandAttack"))])), tg(stag("PerStat", vec![("stat", s("EnergyShieldOnWeapon 2")), ("div", num(a.n(3)))])), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Spectral Shield Throw"), s("Shield Crush")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% of shield crush and spectral shield throw physical damage converted to lightning damage", Func(|a| Some(vec![
            mk_mod("SkillPhysicalDamageConvertToLightning", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Spectral Shield Throw"), s("Shield Crush")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% of exsanguinate and reap physical damage converted to fire damage", Func(|a| Some(vec![
            mk_mod("SkillPhysicalDamageConvertToFire", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Exsanguinate"), s("Reap")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("%-(%d+)%% of toxic rain physical damage converted to chaos damage", Func(|a| Some(vec![
            mk_mod("SkillPhysicalDamageConvertToChaos", "BASE", num(-a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Toxic Rain")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("cobra lash and venom gyre have %-(%d+)%% of physical damage converted to chaos damage", Func(|a| Some(vec![
            mk_mod("SkillPhysicalDamageConvertToChaos", "BASE", num(-a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cobra Lash"), s("Venom Gyre")]))]))]),
        ]))),
        ("(%d+)%% of consecrated path and purifying flame fire damage converted to chaos damage", Func(|a| Some(vec![
            mk_mod("SkillFireDamageConvertToChaos", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Consecrated Path"), s("Purifying Flame")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% of manabond and stormbind lightning damage converted to cold damage", Func(|a| Some(vec![
            mk_mod("SkillLightningDamageConvertToCold", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Manabond"), s("Stormbind")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("exsanguinate debuffs deal fire damage per second instead of physical damage per second", Mods(vec![flag_mod("Condition:ExsanguinateDebuffIsFireDamage", vec![tg(stag("SkillName", vec![("skillName", s("Exsanguinate")), ("includeTransfigured", b(true))]))])])),
        ("reap debuffs deal fire damage per second instead of physical damage per second", Mods(vec![flag_mod("Condition:ReapDebuffIsFireDamage", vec![tg(stag("SkillName", vec![("skillName", s("Reap"))]))])])),
        ("your critical strike chance is lucky", Mods(vec![flag_mod("CritChanceLucky", vec![])])),
        ("your critical strike chance is lucky while on low life", Mods(vec![flag_mod("CritChanceLucky", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("your critical strike chance is lucky while focus?sed", Mods(vec![flag_mod("CritChanceLucky", vec![tg(stag("Condition", vec![("var", s("Focused"))]))])])),
        ("your critical strikes do not deal extra damage", Mods(vec![flag_mod("NoCritMultiplier", vec![])])),
        ("critical strikes do not deal extra damage", Mods(vec![flag_mod("NoCritMultiplier", vec![])])),
        ("critical strikes with this weapon do not deal extra damage", Mods(vec![flag_mod("NoCritMultiplier", vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("minion critical strikes do not deal extra damage", Mods(vec![wrap("MinionModifier", flag_mod("NoCritMultiplier", vec![]), vec![])])),
        ("lightning damage with non%-critical strikes is lucky", Mods(vec![flag_mod("LightningNoCritLucky", vec![])])),
        ("your damage with critical strikes is lucky", Mods(vec![flag_mod("CritLucky", vec![])])),
        ("spell critical strike chance bifurcates", Mods(vec![flag_mod("BifurcateCrit", vec![flags(mf::Spell)])])),
        ("critical strikes deal no damage", Mods(vec![mk_mod("Damage", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("critical strike chance is increased by uncapped lightning resistance", Mods(vec![flag_mod("CritChanceIncreasedByUncappedLightningRes", vec![])])),
        ("critical strike chance is increased by lightning resistance", Mods(vec![flag_mod("CritChanceIncreasedByLightningRes", vec![])])),
        ("critical strike chance is increased by overcapped lightning resistance", Mods(vec![flag_mod("CritChanceIncreasedByOvercappedLightningRes", vec![])])),
        ("barrage and frenzy have (%d+)%% increased critical strike chance per endurance charge", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("EnduranceCharge"))])), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Barrage"), s("Frenzy")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("non%-critical strikes deal (%d+)%% damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(-100.0 + a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("CriticalStrike")), ("neg", b(true))]))])]))),
        ("non%-critical strikes deal no damage", Mods(vec![mk_mod("Damage", "MORE", num(-100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("CriticalStrike")), ("neg", b(true))]))])])),
        ("non%-critical strikes deal (%d+)%% less damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(-a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("CriticalStrike")), ("neg", b(true))]))])]))),
        ("spell skills always deal critical strikes on final repeat", Mods(vec![flag_mod("SpellSkillsAlwaysDealCriticalStrikesOnFinalRepeat", vec![flags(mf::Spell)])])),
        ("spell skills cannot deal critical strikes except on final repeat", Mods(vec![flag_mod("SpellSkillsCannotDealCriticalStrikesExceptOnFinalRepeat", vec![flags(mf::Spell)]), flag_mod("", vec![tg(stag("Condition", vec![("var", s("alwaysFinalRepeat"))]))])])),
        ("critical strikes penetrate (%d+)%% of enemy elemental resistances while affected by zealotry", Func(|a| Some(vec![mk_mod("ElementalPenetration", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))])), tg(stag("Condition", vec![("var", s("AffectedByZealotry"))]))])]))),
        ("attack critical strikes ignore enemy monster elemental resistances", Mods(vec![flag_mod("IgnoreElementalResistances", vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))])])),
        ("treats enemy monster elemental resistance values as inverted", Mods(vec![mk_mod("HitsInvertEleResChance", "CHANCE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("treats enemy monster chaos resistance values as inverted", Mods(vec![mk_mod("HitsInvertChaosResChance", "CHANCE", num(100.0), vec![tg(stag("Condition", vec![("var", s("{Hand}Attack"))]))])])),
        ("([%+%-]%d+)%% to critical strike multiplier if you've shattered an enemy recently", Func(|a| Some(vec![mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ShatteredEnemyRecently"))]))])]))),
        ("(%d+)%% chance to gain a flask charge when you deal a critical strike", Func(|a| Some(vec![mk_mod("FlaskChargeOnCritChance", "BASE", num(a.n(1)), vec![])]))),
        ("gain a flask charge when you deal a critical strike", Mods(vec![mk_mod("FlaskChargeOnCritChance", "BASE", num(100.0), vec![])])),
        ("gain a flask charge when you deal a critical strike while affected by precision", Mods(vec![mk_mod("FlaskChargeOnCritChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByPrecision"))]))])])),
        ("gain a flask charge when you deal a critical strike while at maximum frenzy charges", Mods(vec![mk_mod("FlaskChargeOnCritChance", "BASE", num(100.0), vec![tg(stag("StatThreshold", vec![("stat", s("FrenzyCharges")), ("thresholdStat", s("FrenzyChargesMax"))]))])])),
        ("on non%-channelling attack, set a life flask with greater than %d+%% of maximum charges remaining to (%d+)%% for each charge removed this way, that attack gains %+(%d+)%% to damage over time multiplier", Func(|a| Some(vec![
            mk_mod("DotMultiplier", "BASE", num(a.n(2)), vec![tg(stag("PercentStat", vec![("stat", s("LifeFlaskCharges")), ("percent", num(100.0 - a.n(1))), ("floor", b(true))])), tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("enemies poisoned by you cannot deal critical strikes", Mods(vec![
            wrap("EnemyModifier", flag_mod("NeverCrit", vec![tg(stag("Condition", vec![("var", s("Poisoned"))]))]), vec![]),
            wrap("EnemyModifier", flag_mod("Condition:NeverCrit", vec![tg(stag("Condition", vec![("var", s("Poisoned"))]))]), vec![]),
        ])),
        ("marked enemy cannot deal critical strikes", Mods(vec![
            wrap("EnemyModifier", flag_mod("NeverCrit", vec![tg(stag("Condition", vec![("var", s("Marked"))]))]), vec![]),
            wrap("EnemyModifier", flag_mod("Condition:NeverCrit", vec![tg(stag("Condition", vec![("var", s("Marked"))]))]), vec![]),
        ])),
        ("marked enemy cannot evade attacks", Mods(vec![wrap("EnemyModifier", flag_mod("CannotEvade", vec![tg(stag("Condition", vec![("var", s("Marked"))]))]), vec![])])),
        ("hits against you cannot be critical strikes if you've been stunned recently", Mods(vec![
            wrap("EnemyModifier", flag_mod("NeverCrit", vec![]), vec![tg(stag("Condition", vec![("var", s("StunnedRecently"))]))]),
            wrap("EnemyModifier", flag_mod("Condition:NeverCrit", vec![]), vec![tg(stag("Condition", vec![("var", s("StunnedRecently"))]))]),
        ])),
        ("nearby enemies cannot deal critical strikes", Mods(vec![wrap("EnemyModifier", flag_mod("NeverCrit", vec![]), vec![]), wrap("EnemyModifier", flag_mod("Condition:NeverCrit", vec![]), vec![])])),
        ("hits against you are always critical strikes", Mods(vec![wrap("EnemyModifier", flag_mod("AlwaysCrit", vec![]), vec![]), wrap("EnemyModifier", flag_mod("Condition:AlwaysCrit", vec![]), vec![])])),
        ("your hits are always critical strikes", Mods(vec![mk_mod("CritChance", "OVERRIDE", num(100.0), vec![])])),
        ("all hits are critical strikes while holding a fishing rod", Mods(vec![mk_mod("CritChance", "OVERRIDE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFishing"))]))])])),
        ("all hits with your next non%-channelling attack within (%d+) seconds of taking a critical strike will be critical strikes", Func(|_a| Some(vec![
            mk_mod("CritChance", "OVERRIDE", num(100.0), vec![tg(stag("Condition", vec![("var", s("BeenCritRecently"))])), tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("hits have (%d+)%% increased critical strike chance against you", Func(|a| Some(vec![mk_mod("EnemyCritChance", "INC", num(a.n(1)), vec![])]))),
        ("stuns from critical strikes have (%d+)%% increased duration", Func(|a| Some(vec![mk_mod("EnemyStunDurationOnCrit", "INC", num(a.n(1)), vec![])]))),
        ("enemies take (%d+)%% increased damage for each type of ailment you have inflicted on them", Func(|a| Some(
            ["Frozen","Chilled","Ignited","Shocked","Scorched","Brittle","Sapped","Bleeding","Poisoned"].iter().map(|c|
                wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s(*c))]))])
            ).collect()
        ))),
        ("(%d+)%% chance to deal double damage against enemies for each type of ailment you have inflicted on them", Func(|a| Some(
            ["Frozen","Chilled","Ignited","Shocked","Scorched","Brittle","Sapped","Bleeding","Poisoned"].iter().map(|c|
                mk_mod("DoubleDamageChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s(*c))]))])
            ).collect()
        ))),
        ("(%d+)%% increased elemental damage with hits and ailments for each type of elemental ailment on enemy", Func(|a| Some(
            ["Frozen","Chilled","Ignited","Shocked","Scorched","Brittle","Sapped"].iter().map(|c|
                mk_mod("ElementalDamage", "INC", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s(*c))]))])
            ).collect()
        ))),
        ("your shocks can increase damage taken by up to a maximum of (%d+)%%", Func(|a| Some(vec![mk_mod("ShockMax", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("%+(%d+)%% to maximum effect of shock", Func(|a| Some(vec![mk_mod("ShockMax", "BASE", num(a.n(1)), vec![])]))),
        // Lua: function(_, element, ailment) -- element is capture 1, ailment is capture 2
        // (the off-by-one below was using capture 2/3, silently dropping the element prefix).
        ("your (%w+) damage can (%w+)", Func(|a| Some(vec![flag_mod(format!("{}Can{}", first_upper(a.s(1)), first_upper(a.s(2))), vec![])]))),
        ("your (%w+) damage cannot (%w+)", Func(|a| Some(vec![flag_mod(format!("{}Cannot{}", first_upper(a.s(1)), first_upper(a.s(2))), vec![])]))),
        ("your elemental damage can shock", Mods(vec![flag_mod("ColdCanShock", vec![]), flag_mod("FireCanShock", vec![])])),
        ("all y?o?u?r? ?damage can freeze", Mods(vec![flag_mod("PhysicalCanFreeze", vec![]), flag_mod("LightningCanFreeze", vec![]), flag_mod("FireCanFreeze", vec![]), flag_mod("ChaosCanFreeze", vec![])])),
        ("all damage with maces and sceptres inflicts chill", Mods(vec![
            flag_mod("PhysicalCanChill", vec![tg(stag("Condition", vec![("var", s("UsingMace"))]))]),
            flag_mod("LightningCanChill", vec![tg(stag("Condition", vec![("var", s("UsingMace"))]))]),
            flag_mod("FireCanChill", vec![tg(stag("Condition", vec![("var", s("UsingMace"))]))]),
            flag_mod("ChaosCanChill", vec![tg(stag("Condition", vec![("var", s("UsingMace"))]))]),
        ])),
        ("all damage from lightning strike and frost blades hits can ignite", Mods(vec![
            flag_mod("PhysicalCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Strike"), s("Frost Blades")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Strike"), s("Frost Blades")])), ("includeTransfigured", b(true))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Strike"), s("Frost Blades")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Strike"), s("Frost Blades")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("all damage from lightning arrow and ice shot hits can ignite", Mods(vec![
            flag_mod("PhysicalCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Arrow"), s("Ice Shot")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Arrow"), s("Ice Shot")])), ("includeTransfigured", b(true))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Arrow"), s("Ice Shot")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Arrow"), s("Ice Shot")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("all damage from shock nova and storm call hits can ignite", Mods(vec![
            flag_mod("PhysicalCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Shock Nova"), s("Storm Call")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ColdCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Shock Nova"), s("Storm Call")])), ("includeTransfigured", b(true))]))]),
            flag_mod("LightningCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Shock Nova"), s("Storm Call")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ChaosCanIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Shock Nova"), s("Storm Call")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("your fire damage can shock but not ignite", Mods(vec![flag_mod("FireCanShock", vec![]), flag_mod("FireCannotIgnite", vec![])])),
        ("your cold damage can ignite but not freeze or chill", Mods(vec![flag_mod("ColdCanIgnite", vec![]), flag_mod("ColdCannotFreeze", vec![]), flag_mod("ColdCannotChill", vec![])])),
        ("your lightning damage can freeze but not shock", Mods(vec![flag_mod("LightningCanFreeze", vec![]), flag_mod("LightningCannotShock", vec![])])),
        ("your physical damage can ignite during effect", Mods(vec![flag_mod("PhysicalCanIgnite", vec![])])),
        ("chaos damage can ignite, chill and shock", Mods(vec![flag_mod("ChaosCanIgnite", vec![]), flag_mod("ChaosCanChill", vec![]), flag_mod("ChaosCanShock", vec![])])),
        ("you always ignite while burning", Mods(vec![mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Burning"))]))])])),
        ("critical strikes do not a?l?w?a?y?s?i?n?h?e?r?e?n?t?l?y? freeze", Mods(vec![flag_mod("CritsDontAlwaysFreeze", vec![])])),
        ("cannot inflict elemental ailments", Mods(vec![flag_mod("CannotIgnite", vec![]), flag_mod("CannotChill", vec![]), flag_mod("CannotFreeze", vec![]), flag_mod("CannotShock", vec![]), flag_mod("CannotScorch", vec![]), flag_mod("CannotBrittle", vec![]), flag_mod("CannotSap", vec![])])),
        ("non%-critical strikes cannot inflict ailments", Mods(vec![flag_mod("AilmentsOnlyFromCrit", vec![])])),
        ("flameblast and incinerate cannot inflict elemental ailments", Mods(vec![
            flag_mod("CannotIgnite", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
            flag_mod("CannotChill", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
            flag_mod("CannotFreeze", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
            flag_mod("CannotShock", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
            flag_mod("CannotScorch", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
            flag_mod("CannotBrittle", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
            flag_mod("CannotSap", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Flameblast"), s("Incinerate")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("you can inflict up to (%d+) ignites on an enemy", Func(|a| Some(vec![flag_mod("IgniteCanStack", vec![]), mk_mod("IgniteStacks", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("you can inflict an additional ignite on [ea][an]c?h? enemy", Mods(vec![flag_mod("IgniteCanStack", vec![]), mk_mod("IgniteStacks", "BASE", num(1.0), vec![])])),
        ("enemies chilled by you take (%d+)%% increased burning damage", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("FireDamageTakenOverTime", "INC", num(a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Chilled"))]))])]))),
        ("damaging ailments deal damage (%d+)%% faster", Func(|a| Some(vec![mk_mod("IgniteBurnFaster", "INC", num(a.n(1)), vec![]), mk_mod("BleedFaster", "INC", num(a.n(1)), vec![]), mk_mod("PoisonFaster", "INC", num(a.n(1)), vec![])]))),
        ("damaging ailments you inflict deal damage (%d+)%% faster while affected by malevolence", Func(|a| Some(vec![
            mk_mod("IgniteBurnFaster", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByMalevolence"))]))]),
            mk_mod("BleedFaster", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByMalevolence"))]))]),
            mk_mod("PoisonFaster", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByMalevolence"))]))]),
        ]))),
        ("(%d+)%% increased damage with damaging ailments you inflict while you are affected by the same ailment", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Bleed), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Bleeding"))])), tg(stag("Condition", vec![("var", s("Bleeding"))]))]),
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Ignite), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))])), tg(stag("Condition", vec![("var", s("Ignited"))]))]),
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Poison), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Poisoned"))])), tg(stag("Condition", vec![("var", s("Poisoned"))]))]),
        ]))),
        ("ignited enemies burn (%d+)%% faster", Func(|a| Some(vec![mk_mod("IgniteBurnFaster", "INC", num(a.n(1)), vec![])]))),
        // Lua: function(_, ailment, num) -- ailment is capture 1, num is capture 2.
        ("base (%a+) duration is ([%d%.]+) seconds?", Func(|a| {
            let ailment = a.s(1);
            let name = if ailment == "bleeding" || ailment == "bleed" { Some("Bleed".to_string()) }
                else if ailment == "ignite" || ailment == "poison" { Some(first_upper(ailment)) }
                else { None };
            name.map(|n| vec![mk_mod(format!("{}DurationBase", n), "OVERRIDE", num(a.n(2)), vec![])])
        })),
        ("ignited enemies burn (%d+)%% slower", Func(|a| Some(vec![mk_mod("IgniteBurnSlower", "INC", num(a.n(1)), vec![])]))),
        ("enemies ignited by an attack burn (%d+)%% faster", Func(|a| Some(vec![mk_mod("IgniteBurnFaster", "INC", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("ignites you inflict with attacks deal damage (%d+)%% faster", Func(|a| Some(vec![mk_mod("IgniteBurnFaster", "INC", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("ignites you inflict deal damage (%d+)%% faster", Func(|a| Some(vec![mk_mod("IgniteBurnFaster", "INC", num(a.n(1)), vec![])]))),
        ("(%d+)%% chance for ignites inflicted with lightning strike or frost blades to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Ignite), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Strike"), s("Frost Blades")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% chance for ignites inflicted with lightning arrow or ice shot to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Ignite), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Lightning Arrow"), s("Ice Shot")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% chance for ignites inflicted with shock nova or storm call to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Ignite), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Shock Nova"), s("Storm Call")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("enemies ignited by you during f?l?a?s?k? ?effect take (%d+)%% increased damage", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))]))])]))),
        ("enemies ignited by you take chaos damage instead of fire damage from ignite", Mods(vec![flag_mod("IgniteToChaos", vec![])])),
        ("enemies chilled by your hits are shocked", Mods(vec![
            mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("ChilledByYourHits"))]))]),
            wrap("EnemyModifier", flag_mod("Condition:Shocked", vec![tg(stag("Condition", vec![("var", s("ChilledByYourHits"))]))]), vec![]),
        ])),
        ("cannot inflict ignite", Mods(vec![flag_mod("CannotIgnite", vec![])])),
        ("cannot inflict freeze or chill", Mods(vec![flag_mod("CannotFreeze", vec![]), flag_mod("CannotChill", vec![])])),
        ("cannot inflict shock", Mods(vec![flag_mod("CannotShock", vec![])])),
        ("cannot ignite, chill, freeze or shock", Mods(vec![flag_mod("CannotIgnite", vec![]), flag_mod("CannotChill", vec![]), flag_mod("CannotFreeze", vec![]), flag_mod("CannotShock", vec![])])),
        ("shock enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("ShockAsThoughDealing", "MORE", num(a.n(1)), vec![])]))),
        ("chill enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("ChillAsThoughDealing", "MORE", num(a.n(1)), vec![])]))),
        ("inflict non%-damaging ailments as though dealing (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("ShockAsThoughDealing", "MORE", num(a.n(1)), vec![]),
            mk_mod("ChillAsThoughDealing", "MORE", num(a.n(1)), vec![]),
            mk_mod("FreezeAsThoughDealing", "MORE", num(a.n(1)), vec![]),
            mk_mod("ScorchAsThoughDealing", "MORE", num(a.n(1)), vec![]),
            mk_mod("BrittleAsThoughDealing", "MORE", num(a.n(1)), vec![]),
            mk_mod("SapAsThoughDealing", "MORE", num(a.n(1)), vec![]),
        ]))),
        ("non%-damaging elemental ailments you inflict have (%d+)%% more effect", Func(|a| Some(vec![
            mk_mod("EnemyShockEffect", "MORE", num(a.n(1)), vec![]),
            mk_mod("EnemyChillEffect", "MORE", num(a.n(1)), vec![]),
            mk_mod("EnemyFreezeEffect", "MORE", num(a.n(1)), vec![]),
            mk_mod("EnemyScorchEffect", "MORE", num(a.n(1)), vec![]),
            mk_mod("EnemyBrittleEffect", "MORE", num(a.n(1)), vec![]),
            mk_mod("EnemySapEffect", "MORE", num(a.n(1)), vec![]),
        ]))),
        ("immun[ei]t?y? to elemental ailments while on consecrated ground if you have at least (%d+) devotion", Func(|a| Some(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))])), tg(stag("StatThreshold", vec![("stat", s("Devotion")), ("threshold", num(a.n(1)))]))])]))),
        ("freeze enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("FreezeAsThoughDealing", "MORE", num(a.n(1)), vec![])]))),
        ("freeze chilled enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("FreezeAsThoughDealing", "MORE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Chilled"))]))])]))),
        ("manabond and stormbind freeze enemies as though dealing (%d+)%% more damage", Func(|a| Some(vec![mk_mod("FreezeAsThoughDealing", "MORE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Manabond"), s("Stormbind")])), ("includeTransfigured", b(true))]))])]))),
        ("(%d+)%% chance to inflict brittle on enemies when you block their damage", Func(|a| Some(vec![mk_mod("EnemyBrittleChance", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% chance to inflict sap on enemies when you block their damage", Func(|a| Some(vec![mk_mod("EnemySapChance", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% chance to inflict scorch on enemies when you block their damage", Func(|a| Some(vec![mk_mod("EnemyScorchChance", "BASE", num(a.n(1)), vec![])]))),
        ("scorch enemies in close range when you block", Mods(vec![mk_mod("EnemyScorchChance", "BASE", num(100.0), vec![])])),
        ("(%d+)%% chance to shock attackers for (%d+) seconds on block", Mods(vec![mk_mod("ShockBase", "BASE", num(15.0), vec![])])),
        ("shock attackers for (%d+) seconds on block", Mods(vec![
            mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
            wrap("EnemyModifier", flag_mod("Condition:Shocked", vec![]), vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
        ])),
        ("shock nearby enemies for (%d+) seconds when you focus", Mods(vec![
            mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("Condition", vec![("var", s("Focused"))]))]),
            wrap("EnemyModifier", flag_mod("Condition:Shocked", vec![]), vec![tg(stag("Condition", vec![("var", s("Focused"))]))]),
        ])),
        ("shock yourself for (%d+) seconds when you focus", Mods(vec![
            mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("Condition", vec![("var", s("Focused"))]))]),
            flag_mod("Condition:Shocked", vec![tg(stag("Condition", vec![("var", s("Focused"))]))]),
        ])),
        ("drops shocked ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnShockedGround"))]))])])),
        ("drops scorched ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("ScorchBase", "BASE", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnScorchedGround"))]))])])),
        ("drops brittle ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("BrittleBase", "BASE", num(2.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnBrittleGround"))]))])])),
        ("drops sapped ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("SapBase", "BASE", num(6.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnSappedGround"))]))])])),
        ("while a unique enemy is in your presence, drops shocked ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnShockedGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])])),
        ("while a unique enemy is in your presence, drops scorched ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("ScorchBase", "BASE", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnScorchedGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])])),
        ("while a unique enemy is in your presence, drops brittle ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("BrittleBase", "BASE", num(2.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnBrittleGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])])),
        ("while a unique enemy is in your presence, drops sapped ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("SapBase", "BASE", num(6.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnSappedGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))])])),
        ("while a pinnacle atlas boss is in your presence, drops shocked ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("ShockBase", "BASE", num(15.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnShockedGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))]))])])),
        ("while a pinnacle atlas boss is in your presence, drops scorched ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("ScorchBase", "BASE", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnScorchedGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))]))])])),
        ("while a pinnacle atlas boss is in your presence, drops brittle ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("BrittleBase", "BASE", num(2.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnBrittleGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))]))])])),
        ("while a pinnacle atlas boss is in your presence, drops sapped ground while moving, lasting (%d+) seconds", Mods(vec![mk_mod("SapBase", "BASE", num(6.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnSappedGround"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))]))])])),
        ("%+(%d+)%% chance to ignite, freeze, shock, and poison cursed enemies", Func(|a| Some(vec![
            mk_mod("EnemyIgniteChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
            mk_mod("EnemyFreezeChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
            mk_mod("EnemyShockChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
            mk_mod("PoisonChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("you have scorching conflux, brittle conflux and sapping conflux while your two highest attributes are equal", Mods(vec![
            mk_mod("EnemyScorchChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            mk_mod("EnemyBrittleChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            mk_mod("EnemySapChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("PhysicalCanScorch", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("LightningCanScorch", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("ColdCanScorch", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("ChaosCanScorch", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("PhysicalCanBrittle", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("LightningCanBrittle", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("FireCanBrittle", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("ChaosCanBrittle", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("PhysicalCanSap", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("ColdCanSap", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("FireCanSap", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
            flag_mod("ChaosCanSap", vec![tg(stag("Condition", vec![("var", s("TwoHighestAttributesEqual"))]))]),
        ])),
        ("all damage from cold snap and creeping frost can sap", Mods(vec![
            flag_mod("PhysicalCanSap", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cold Snap"), s("Creeping Frost")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ColdCanSap", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cold Snap"), s("Creeping Frost")])), ("includeTransfigured", b(true))]))]),
            flag_mod("FireCanSap", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cold Snap"), s("Creeping Frost")])), ("includeTransfigured", b(true))]))]),
            flag_mod("ChaosCanSap", vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cold Snap"), s("Creeping Frost")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("always inflict scorch, brittle and sapped with elemental hit and wild strike hits", Mods(vec![
            mk_mod("EnemyScorchChance", "BASE", num(100.0), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Elemental Hit"), s("Wild Strike")])), ("includeTransfigured", b(true))]))]),
            mk_mod("EnemyBrittleChance", "BASE", num(100.0), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Elemental Hit"), s("Wild Strike")])), ("includeTransfigured", b(true))]))]),
            mk_mod("EnemySapChance", "BASE", num(100.0), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Elemental Hit"), s("Wild Strike")])), ("includeTransfigured", b(true))]))]),
        ])),
        // Lua: function(_, type) -- type is capture 1 (was reading capture 2, an off-by-one).
        ("hits with prismatic skills always ?i?n?f?l?i?c?t? (%w+)", Func(|a| Some(vec![mk_mod(format!("Enemy{}Chance", first_upper(a.s(1))), "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("SkillType", vec![("skillType", num(102.0))]))])]))),
        ("critical strikes do not [ia][np][fp]l[iy]c?t? non%-damaging ailments", Mods(vec![flag_mod("CritsDontAlwaysChill", vec![]), flag_mod("CritsDontAlwaysFreeze", vec![]), flag_mod("CritsDontAlwaysShock", vec![])])),
        ("critical strikes do not inherently ignite", Mods(vec![flag_mod("CritsDontAlwaysIgnite", vec![])])),
        ("always scorch while affected by anger", Mods(vec![mk_mod("EnemyScorchChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByAnger"))]))])])),
        ("always inflict brittle while affected by hatred", Mods(vec![mk_mod("EnemyBrittleChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByHatred"))]))])])),
        ("always sap while affected by wrath", Mods(vec![mk_mod("EnemySapChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByWrath"))]))])])),
        ("(%d+)%% chance to sap enemies in chilling areas", Func(|a| Some(vec![mk_mod("EnemySapChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("InChillingArea"))]))])]))),
        ("(%d+)%% chance for cold snap and creeping frost to sap enemies in chilling areas", Func(|a| Some(vec![mk_mod("EnemySapChance", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cold Snap"), s("Creeping Frost")])), ("includeTransfigured", b(true))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("InChillingArea"))]))])]))),
        ("drops burning ground while moving, dealing (%d+) fire damage per second for %d+ seconds", Func(|a| Some(vec![mk_mod("DropsBurningGround", "BASE", num(a.n(1)), vec![])]))),
        ("take (%d+) fire damage per second while flame%-touched", Func(|a| Some(vec![mk_mod("FireDegen", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByApproachingFlames"))]))])]))),
        ("gain adrenaline when you become flame%-touched", Mods(vec![flag_mod("Condition:Adrenaline", vec![tg(stag("Condition", vec![("var", s("AffectedByApproachingFlames"))]))])])),
        ("lose adrenaline when you cease to be flame%-touched", Mods(vec![])),
        ("modifiers to ignite duration on you apply to all elemental ailments", Mods(vec![flag_mod("IgniteDurationAppliesToElementalAilments", vec![])])),
        ("(%d+)%% increased duration of ailments of types you haven't inflicted recently", Func(|a| Some(vec![
            mk_mod("EnemyFreezeDuration", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FrozenEnemyRecently")), ("neg", b(true))]))]),
            mk_mod("EnemyChillDuration", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FrozenEnemyRecently")), ("neg", b(true))]))]),
            mk_mod("EnemyIgniteDuration", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("IgnitedEnemyRecently")), ("neg", b(true))]))]),
            mk_mod("EnemyShockDuration", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ShockedEnemyRecently")), ("neg", b(true))]))]),
            mk_mod("EnemyBleedDuration", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("CausedBleedingRecently")), ("neg", b(true))]))]),
            mk_mod("EnemyPoisonDuration", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("PoisonedEnemyRecently")), ("neg", b(true))]))]),
        ]))),
        ("chance to avoid being shocked applies to all elemental ailments", Mods(vec![flag_mod("ShockAvoidAppliesToElementalAilments", vec![])])),
        ("modifiers to chance to avoid being shocked apply to all elemental ailments", Mods(vec![flag_mod("ShockAvoidAppliesToElementalAilments", vec![])])),
        ("enemies permanently take (%d+)%% increased damage for each second they've ever been frozen by you, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FrozenByYou"))])), tg(stag("Multiplier", vec![("var", s("FrozenByYouSeconds")), ("limit", num(a.n(2) / a.n(1)))]))]), vec![]),
        ]))),
        ("enemies permanently take (%d+)%% increased damage for each second they've ever been chilled by you, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ChilledByYou"))])), tg(stag("Multiplier", vec![("var", s("ChilledByYouSeconds")), ("limit", num(a.n(2) / a.n(1)))]))]), vec![]),
        ]))),
        ("modifiers to chance to suppress spell damage also apply to chance to avoid elemental ailments at (%d+)%% of their value", Func(|a| Some(vec![
            mk_mod("SpellSuppressionAppliesToAilmentAvoidancePercent", "BASE", num(a.n(1)), vec![]),
            flag_mod("SpellSuppressionAppliesToAilmentAvoidance", vec![]),
        ]))),
        ("modifiers to chance to suppress spell damage also apply to chance to defend with (%d+)%% of armour at (%d+)%% of their value", Func(|a| Some(vec![
            mk_mod("SpellSuppressionAppliesToChanceToDefendWithArmourPercentArmour", "MAX", num(a.n(1)), vec![]),
            mk_mod("SpellSuppressionAppliesToChanceToDefendWithArmourPercent", "MAX", num(a.n(2)), vec![]),
            flag_mod("SpellSuppressionAppliesToChanceToDefendWithArmour", vec![]),
        ]))),
        ("enemies chilled by your hits have damage taken increased by chill effect", Mods(vec![flag_mod("ChillEffectIncDamageTaken", vec![])])),
        ("enemies chilled by your hits have cold damage taken increased by chill effect", Mods(vec![flag_mod("ChillEffectIncColdDamageTaken", vec![])])),
        ("enemies in your chilling areas have cold damage taken increased by chill effect", Mods(vec![flag_mod("ChillingAreaIncColdDamageTaken", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("InChillingArea"))]))])])),
        ("left ring slot: your chilling skitterbot's aura applies socketed h?e?x? ?curse instead", Mods(vec![flag_mod("SkitterbotsCannotChill", vec![tg(stag("SlotNumber", vec![("num", num(1.0))]))])])),
        ("right ring slot: your shocking skitterbot's aura applies socketed h?e?x? ?curse instead", Mods(vec![flag_mod("SkitterbotsCannotShock", vec![tg(stag("SlotNumber", vec![("num", num(2.0))]))])])),
        ("summon skitterbots also summons a scorching skitterbot", Mods(vec![flag_mod("ScorchingSkitterbot", vec![])])),
        ("summoned skitterbots' auras affect you as well as enemies", Mods(vec![flag_mod("SkitterbotAffectPlayer", vec![])])),
        ("(%d+)%% increased effect of non%-damaging ailments inflicted by summoned skitterbots", Func(|a| Some(vec![mk_mod("SkitterbotAilmentEffect", "INC", num(a.n(1)), vec![])]))),
        ("melee attacks cause bleeding", Mods(vec![mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Melee)])])),
        ("attacks cause bleeding when hitting cursed enemies", Mods(vec![mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Attack), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))])])),
        ("melee critical strikes cause bleeding", Mods(vec![mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Melee), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("causes bleeding on melee critical strike", Mods(vec![mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Melee), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("melee critical strikes have (%d+)%% chance to cause bleeding", Func(|a| Some(vec![mk_mod("BleedChance", "BASE", num(a.n(1)), vec![flags(mf::Melee), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])]))),
        ("attacks always inflict bleeding while you have cat's stealth", Mods(vec![mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Attack), tg(stag("Condition", vec![("var", s("AffectedByCat'sStealth"))]))])])),
        ("you have crimson dance while you have cat's stealth", Mods(vec![mk_mod("Keystone", "LIST", s("Crimson Dance"), vec![tg(stag("Condition", vec![("var", s("AffectedByCat'sStealth"))]))])])),
        ("you have crimson dance if you have dealt a critical strike recently", Mods(vec![mk_mod("Keystone", "LIST", s("Crimson Dance"), vec![tg(stag("Condition", vec![("var", s("CritRecently"))]))])])),
        ("bleeding you inflict deals damage (%d+)%% faster", Func(|a| Some(vec![mk_mod("BleedFaster", "INC", num(a.n(1)), vec![])]))),
        ("bleeding you inflict on non%-bleeding enemies deals (%d+)%% more damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Bleed), tg(stag("Condition", vec![("var", s("SingleBleed"))]))])]))),
        ("(%d+)%% chance for bleeding inflicted with this weapon to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Bleed), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("(%d+)%% chance for bleeding inflicted with cobra lash or venom gyre to deal (%d+)%% more damage", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(2) * a.n(1) / 100.0), vec![kw(kf::Bleed), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Cobra Lash"), s("Venom Gyre")]))]))]),
        ]))),
        ("bleeding you inflict deals damage (%d+)%% faster per frenzy charge", Func(|a| Some(vec![mk_mod("BleedFaster", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("FrenzyCharge"))]))])]))),
        ("rain of arrows and toxic rain deal (%d+)%% more damage with bleeding", Func(|a| Some(vec![
            mk_mod("Damage", "MORE", num(a.n(1)), vec![kw(kf::Bleed), tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Rain of Arrows"), s("Toxic Rain")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% increased effect of impales inflicted by hits that also inflict bleeding", Func(|a| Some(vec![mk_mod("ImpaleEffectOnBleed", "INC", num(a.n(1)), vec![kw(kf::Hit)])]))),
        ("(%d+)%% chance for blade vortex and blade blast to impale enemies on hit", Func(|a| Some(vec![mk_mod("ImpaleChance", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", PVal::List(vec![s("Blade Vortex"), s("Blade Blast")])), ("includeTransfigured", b(true))]))])]))),
        ("critical strikes with spells inflict impale", Mods(vec![mk_mod("ImpaleChance", "BASE", num(100.0), vec![flags(mf::Spell), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("(%d+)%% chance on hitting an enemy for all impales on that enemy to last for an additional hit", Func(|a| Some(vec![mk_mod("ImpaleAdditionalDurationChance", "BASE", num(a.n(1)), vec![])]))),
    ]
}
