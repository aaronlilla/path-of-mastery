// jewelThresholdFuncs (ModParser.lua:6455-6549, "Threshold" kind: radius jewels with a bonus
// gated on total Str/Dex/Int in radius reaching 40). Split from jewelfunc_other.rs because of the size of these functions.
use super::flags::{keyword_flag as kf, mod_flag as mf};
use super::jewelfunc::{get_threshold, get_threshold_multi, nv, sv, tag, wrap_mod, JewelEntry, JewelKind, JewelTableEntry};
use crate::modifier::ModType;

fn t(pattern: &'static str, f: super::jewelfunc::JewelFn) -> JewelTableEntry {
    JewelTableEntry { pattern, kind: JewelKind::Threshold, entry: JewelEntry::Fixed(f) }
}
fn skill(name: &'static str) -> Vec<(&'static str, super::jewelfunc::Value)> {
    vec![("skillName", sv(name))]
}
fn skill_tf(name: &'static str) -> Vec<(&'static str, super::jewelfunc::Value)> {
    vec![("skillName", sv(name)), ("includeTransfigured", super::jewelfunc::bv(true))]
}

/// jewelThresholdFuncs, first half (ModParser.lua:6481-6516).
pub fn threshold_part1() -> Vec<JewelTableEntry> {
    vec![
        t(
            "with at least 40 dexterity in radius, frost blades melee damage penetrates 15% cold resistance",
            get_threshold(&["Dex"], "ColdPenetration", ModType::Base, nv(15.0), mf::Melee, 0, vec![tag("SkillName", skill_tf("Frost Blades"))]),
        ),
        t(
            "with at least 40 dexterity in radius, melee damage dealt by frost blades penetrates 15% cold resistance",
            get_threshold(&["Dex"], "ColdPenetration", ModType::Base, nv(15.0), mf::Melee, 0, vec![tag("SkillName", skill_tf("Frost Blades"))]),
        ),
        t(
            "with at least 40 dexterity in radius, frost blades has 25% increased projectile speed",
            get_threshold(&["Dex"], "ProjectileSpeed", ModType::Inc, nv(25.0), 0, 0, vec![tag("SkillName", skill_tf("Frost Blades"))]),
        ),
        t(
            "with at least 40 dexterity in radius, ice shot has 25% increased area of effect",
            get_threshold(&["Dex"], "AreaOfEffect", ModType::Inc, nv(25.0), 0, 0, vec![tag("SkillName", skill("Ice Shot"))]),
        ),
        t(
            "ice shot pierces 5 additional targets with 40 dexterity in radius",
            get_threshold(&["Dex"], "PierceCount", ModType::Base, nv(5.0), 0, 0, vec![tag("SkillName", skill("Ice Shot"))]),
        ),
        t(
            "with at least 40 dexterity in radius, ice shot pierces 3 additional targets",
            get_threshold(&["Dex"], "PierceCount", ModType::Base, nv(3.0), 0, 0, vec![tag("SkillName", skill("Ice Shot"))]),
        ),
        t(
            "with at least 40 dexterity in radius, ice shot pierces 5 additional targets",
            get_threshold(&["Dex"], "PierceCount", ModType::Base, nv(5.0), 0, 0, vec![tag("SkillName", skill("Ice Shot"))]),
        ),
        t(
            "with at least 40 intelligence in radius, frostbolt fires 2 additional projectiles",
            get_threshold(&["Int"], "ProjectileCount", ModType::Base, nv(2.0), 0, 0, vec![tag("SkillName", skill("Frostbolt"))]),
        ),
        t(
            "with at least 40 intelligence in radius, rolling magma fires an additional projectile",
            get_threshold(&["Int"], "ProjectileCount", ModType::Base, nv(1.0), 0, 0, vec![tag("SkillName", skill("Rolling Magma"))]),
        ),
        t(
            "with at least 40 intelligence in radius, rolling magma has 10% increased area of effect per chain",
            get_threshold(
                &["Int"],
                "AreaOfEffect",
                ModType::Inc,
                nv(10.0),
                0,
                0,
                vec![tag("SkillName", skill("Rolling Magma")), tag("PerStat", vec![("stat", sv("Chain"))])],
            ),
        ),
        t(
            "with at least 40 intelligence in radius, rolling magma deals 40% more damage per chain",
            get_threshold(
                &["Int"],
                "Damage",
                ModType::More,
                nv(40.0),
                0,
                0,
                vec![tag("SkillName", skill("Rolling Magma")), tag("PerStat", vec![("stat", sv("Chain"))])],
            ),
        ),
        t(
            "with at least 40 intelligence in radius, rolling magma deals 50% less damage",
            get_threshold(&["Int"], "Damage", ModType::More, nv(-50.0), 0, 0, vec![tag("SkillName", skill("Rolling Magma"))]),
        ),
        t(
            "with at least 40 dexterity in radius, shrapnel shot has 25% increased area of effect",
            get_threshold(&["Dex"], "AreaOfEffect", ModType::Inc, nv(25.0), 0, 0, vec![tag("SkillName", skill("Shrapnel Shot"))]),
        ),
        t(
            "with at least 40 dexterity in radius, shrapnel shot's cone has a 50% chance to deal double damage",
            get_threshold(
                &["Dex"],
                "DoubleDamageChance",
                ModType::Base,
                nv(50.0),
                0,
                0,
                vec![tag("SkillName", skill("Shrapnel Shot")), tag("SkillPart", vec![("skillPart", nv(2.0))])],
            ),
        ),
        t(
            "with at least 40 dexterity in radius, galvanic arrow deals 50% increased area damage",
            get_threshold(
                &["Dex"],
                "Damage",
                ModType::Inc,
                nv(50.0),
                0,
                0,
                vec![tag("SkillName", skill_tf("Galvanic Arrow")), tag("SkillPart", vec![("skillPart", nv(2.0))])],
            ),
        ),
        t(
            "with at least 40 dexterity in radius, galvanic arrow has 25% increased area of effect",
            get_threshold(&["Dex"], "AreaOfEffect", ModType::Inc, nv(25.0), 0, 0, vec![tag("SkillName", skill_tf("Galvanic Arrow"))]),
        ),
        t(
            "with at least 40 intelligence in radius, freezing pulse fires 2 additional projectiles",
            get_threshold(&["Int"], "ProjectileCount", ModType::Base, nv(2.0), 0, 0, vec![tag("SkillName", skill("Freezing Pulse"))]),
        ),
        t(
            "with at least 40 intelligence in radius, 25% increased freezing pulse damage if you've shattered an enemy recently",
            get_threshold(
                &["Int"],
                "Damage",
                ModType::Inc,
                nv(25.0),
                0,
                0,
                vec![tag("SkillName", skill("Freezing Pulse")), tag("Condition", vec![("var", sv("ShatteredEnemyRecently"))])],
            ),
        ),
        t(
            "with at least 40 dexterity in radius, ethereal knives fires 10 additional projectiles",
            get_threshold(&["Dex"], "ProjectileCount", ModType::Base, nv(10.0), 0, 0, vec![tag("SkillName", skill_tf("Ethereal Knives"))]),
        ),
        t(
            "with at least 40 dexterity in radius, ethereal knives fires 5 additional projectiles",
            get_threshold(&["Dex"], "ProjectileCount", ModType::Base, nv(5.0), 0, 0, vec![tag("SkillName", skill_tf("Ethereal Knives"))]),
        ),
        t(
            "with at least 40 strength in radius, molten strike fires 2 additional projectiles",
            get_threshold(&["Str"], "ProjectileCount", ModType::Base, nv(2.0), 0, 0, vec![tag("SkillName", skill_tf("Molten Strike"))]),
        ),
        t(
            "with at least 40 strength in radius, molten strike has 25% increased area of effect",
            get_threshold(&["Str"], "AreaOfEffect", ModType::Inc, nv(25.0), 0, 0, vec![tag("SkillName", skill_tf("Molten Strike"))]),
        ),
        t(
            "with at least 40 strength in radius, molten strike projectiles chain +1 time",
            get_threshold(&["Str"], "ChainCountMax", ModType::Base, nv(1.0), 0, 0, vec![tag("SkillName", skill_tf("Molten Strike"))]),
        ),
        t(
            "with at least 40 strength in radius, molten strike fires 50% less projectiles",
            get_threshold(&["Str"], "ProjectileCount", ModType::More, nv(-50.0), 0, 0, vec![tag("SkillName", skill_tf("Molten Strike"))]),
        ),
        t(
            "with at least 40 strength in radius, 25% of glacial hammer physical damage converted to cold damage",
            get_threshold(&["Str"], "SkillPhysicalDamageConvertToCold", ModType::Base, nv(25.0), 0, 0, vec![tag("SkillName", skill_tf("Glacial Hammer"))]),
        ),
        t(
            "with at least 40 strength in radius, heavy strike has a 20% chance to deal double damage",
            get_threshold(&["Str"], "DoubleDamageChance", ModType::Base, nv(20.0), 0, 0, vec![tag("SkillName", skill("Heavy Strike"))]),
        ),
        t(
            "with at least 40 strength in radius, heavy strike has a 20% chance to deal double damage.",
            get_threshold(&["Str"], "DoubleDamageChance", ModType::Base, nv(20.0), 0, 0, vec![tag("SkillName", skill("Heavy Strike"))]),
        ),
        t(
            "with at least 40 strength in radius, cleave has +1 to radius per nearby enemy, up to +10",
            get_threshold(
                &["Str"],
                "AreaOfEffect",
                ModType::Base,
                nv(1.0),
                0,
                0,
                vec![tag("Multiplier", vec![("var", sv("NearbyEnemies")), ("limit", nv(10.0))]), tag("SkillName", skill_tf("Cleave"))],
            ),
        ),
        t(
            "with at least 40 strength in radius, cleave has +0.1 metres to radius per nearby enemy, up to a maximum of +1 metre",
            get_threshold(
                &["Str"],
                "AreaOfEffect",
                ModType::Base,
                nv(1.0),
                0,
                0,
                vec![tag("Multiplier", vec![("var", sv("NearbyEnemies")), ("limit", nv(10.0))]), tag("SkillName", skill_tf("Cleave"))],
            ),
        ),
        t(
            "with at least 40 strength in radius, cleave grants fortify on hit",
            get_threshold(
                &["Str"],
                "ExtraSkillMod",
                ModType::List,
                wrap_mod(super::jewelfunc::flag_true("Condition:Fortified", vec![])),
                0,
                0,
                vec![tag("SkillName", skill_tf("Cleave"))],
            ),
        ),
        t(
            "with at least 40 strength in radius, hits with cleave fortify",
            get_threshold(
                &["Str"],
                "ExtraSkillMod",
                ModType::List,
                wrap_mod(super::jewelfunc::flag_true("Condition:Fortified", vec![])),
                0,
                0,
                vec![tag("SkillName", skill_tf("Cleave"))],
            ),
        ),
        t(
            "with at least 40 dexterity in radius, dual strike has a 20% chance to deal double damage with the main-hand weapon",
            get_threshold(
                &["Dex"],
                "DoubleDamageChance",
                ModType::Base,
                nv(20.0),
                0,
                0,
                vec![tag("SkillName", skill_tf("Dual Strike")), tag("Condition", vec![("var", sv("MainHandAttack"))])],
            ),
        ),
    ]
}

/// jewelThresholdFuncs, second half (ModParser.lua:6513-6547).
pub fn threshold_part2() -> Vec<JewelTableEntry> {
    vec![
        JewelTableEntry {
            pattern: "with at least 40 dexterity in radius, dual strike has (%d+)%% increased attack speed while wielding a claw",
            kind: JewelKind::Threshold,
            // ModParser.lua's Dual-Strike-while-wielding-X threshold entries never wrap `num` in
            // `tonumber(...)`, so `mod(...)`'s value stays the raw capture string (golden:
            // `"value":"15"`, not a number) -- unlike almost every other threshold entry.
            entry: JewelEntry::Ctor(|a| {
                get_threshold(&["Dex"], "Speed", ModType::Inc, sv(a.s(1)), 0, 0, vec![tag("SkillName", skill_tf("Dual Strike")), tag("Condition", vec![("var", sv("UsingClaw"))])])
            }),
        },
        JewelTableEntry {
            pattern: r"with at least 40 dexterity in radius, dual strike has %+(%d+)%% to critical strike multiplier while wielding a dagger",
            kind: JewelKind::Threshold,
            entry: JewelEntry::Ctor(|a| {
                get_threshold(
                    &["Dex"],
                    "CritMultiplier",
                    ModType::Base,
                    sv(a.s(1)),
                    0,
                    0,
                    vec![tag("SkillName", skill_tf("Dual Strike")), tag("Condition", vec![("var", sv("UsingDagger"))])],
                )
            }),
        },
        JewelTableEntry {
            pattern: "with at least 40 dexterity in radius, dual strike has (%d+)%% increased accuracy rating while wielding a sword",
            kind: JewelKind::Threshold,
            entry: JewelEntry::Ctor(|a| {
                get_threshold(
                    &["Dex"],
                    "Accuracy",
                    ModType::Inc,
                    sv(a.s(1)),
                    0,
                    0,
                    vec![tag("SkillName", skill_tf("Dual Strike")), tag("Condition", vec![("var", sv("UsingSword"))])],
                )
            }),
        },
        t(
            "with at least 40 dexterity in radius, dual strike hits intimidate enemies for 4 seconds while wielding an axe",
            get_threshold(
                &["Dex"],
                "EnemyModifier",
                ModType::List,
                wrap_mod(super::jewelfunc::flag_true("Condition:Intimidated", vec![])),
                0,
                0,
                vec![tag("Condition", vec![("var", sv("UsingAxe"))])],
            ),
        ),
        t(
            "with at least 40 intelligence in radius, raised zombies' slam attack has 100% increased cooldown recovery speed",
            get_threshold(
                &["Int"],
                "MinionModifier",
                ModType::List,
                wrap_mod(super::jewelfunc::new_mod("CooldownRecovery", ModType::Inc, nv(100.0), None, 0, 0, vec![tag("SkillId", vec![("skillId", sv("ZombieSlam"))])])),
                0,
                0,
                vec![],
            ),
        ),
        t(
            "with at least 40 intelligence in radius, raised zombies' slam attack deals 30% increased damage",
            get_threshold(
                &["Int"],
                "MinionModifier",
                ModType::List,
                wrap_mod(super::jewelfunc::new_mod("Damage", ModType::Inc, nv(30.0), None, 0, 0, vec![tag("SkillId", vec![("skillId", sv("ZombieSlam"))])])),
                0,
                0,
                vec![],
            ),
        ),
        t(
            "with at least 40 dexterity in radius, viper strike deals 2% increased attack damage for each poison on the enemy",
            get_threshold(
                &["Dex"],
                "Damage",
                ModType::Inc,
                nv(2.0),
                mf::Attack,
                0,
                vec![tag("SkillName", skill_tf("Viper Strike")), tag("Multiplier", vec![("actor", sv("enemy")), ("var", sv("PoisonStack"))])],
            ),
        ),
        t(
            "with at least 40 dexterity in radius, viper strike deals 2% increased damage with hits and poison for each poison on the enemy",
            get_threshold(
                &["Dex"],
                "Damage",
                ModType::Inc,
                nv(2.0),
                0,
                kf::Hit | kf::Poison,
                vec![tag("SkillName", skill_tf("Viper Strike")), tag("Multiplier", vec![("actor", sv("enemy")), ("var", sv("PoisonStack"))])],
            ),
        ),
        t(
            "with at least 40 intelligence in radius, spark fires 2 additional projectiles",
            get_threshold(&["Int"], "ProjectileCount", ModType::Base, nv(2.0), 0, 0, vec![tag("SkillName", skill_tf("Spark"))]),
        ),
        t(
            "with at least 40 intelligence in radius, blight has 50% increased hinder duration",
            get_threshold(&["Int"], "SecondaryDuration", ModType::Inc, nv(50.0), 0, 0, vec![tag("SkillName", skill_tf("Blight"))]),
        ),
        t(
            "with at least 40 intelligence in radius, enemies hindered by blight take 25% increased chaos damage",
            get_threshold(
                &["Int"],
                "ExtraSkillMod",
                ModType::List,
                wrap_mod(super::jewelfunc::new_mod(
                    "ChaosDamageTaken",
                    ModType::Inc,
                    nv(25.0),
                    None,
                    0,
                    0,
                    vec![tag("GlobalEffect", vec![("effectType", sv("Debuff")), ("effectName", sv("Hinder"))])],
                )),
                0,
                0,
                vec![tag("SkillName", skill_tf("Blight")), tag("ActorCondition", vec![("actor", sv("enemy")), ("var", sv("Hindered"))])],
            ),
        ),
        t(
            "with 40 intelligence in radius, 20% of glacial cascade physical damage converted to cold damage",
            get_threshold(&["Int"], "SkillPhysicalDamageConvertToCold", ModType::Base, nv(20.0), 0, 0, vec![tag("SkillName", skill_tf("Glacial Cascade"))]),
        ),
        t(
            "with at least 40 intelligence in radius, 20% of glacial cascade physical damage converted to cold damage",
            get_threshold(&["Int"], "SkillPhysicalDamageConvertToCold", ModType::Base, nv(20.0), 0, 0, vec![tag("SkillName", skill_tf("Glacial Cascade"))]),
        ),
        t(
            "with 40 total intelligence and dexterity in radius, elemental hit and wild strike deal 50% less fire damage",
            get_threshold(
                &["Int", "Dex"],
                "FireDamage",
                ModType::More,
                nv(-50.0),
                0,
                0,
                vec![tag("SkillName", vec![("skillNameList", super::jewelfunc::list_val(&["Elemental Hit", "Wild Strike"])), ("includeTransfigured", super::jewelfunc::bv(true))])],
            ),
        ),
        t(
            "with 40 total strength and intelligence in radius, elemental hit and wild strike deal 50% less cold damage",
            get_threshold(
                &["Str", "Int"],
                "ColdDamage",
                ModType::More,
                nv(-50.0),
                0,
                0,
                vec![tag("SkillName", vec![("skillNameList", super::jewelfunc::list_val(&["Elemental Hit", "Wild Strike"])), ("includeTransfigured", super::jewelfunc::bv(true))])],
            ),
        ),
        t(
            "with 40 total dexterity and strength in radius, elemental hit and wild strike deal 50% less lightning damage",
            get_threshold(
                &["Dex", "Str"],
                "LightningDamage",
                ModType::More,
                nv(-50.0),
                0,
                0,
                vec![tag("SkillName", vec![("skillNameList", super::jewelfunc::list_val(&["Elemental Hit", "Wild Strike"])), ("includeTransfigured", super::jewelfunc::bv(true))])],
            ),
        ),
        t(
            "with 40 total intelligence and dexterity in radius, prismatic skills deal 50% less fire damage",
            get_threshold(&["Int", "Dex"], "FireDamage", ModType::More, nv(-50.0), 0, 0, vec![tag("SkillType", vec![("skillType", nv(102.0))])]),
        ),
        t(
            "with 40 total strength and intelligence in radius, prismatic skills deal 50% less cold damage",
            get_threshold(&["Str", "Int"], "ColdDamage", ModType::More, nv(-50.0), 0, 0, vec![tag("SkillType", vec![("skillType", nv(102.0))])]),
        ),
        t(
            "with 40 total dexterity and strength in radius, prismatic skills deal 50% less lightning damage",
            get_threshold(&["Dex", "Str"], "LightningDamage", ModType::More, nv(-50.0), 0, 0, vec![tag("SkillType", vec![("skillType", nv(102.0))])]),
        ),
        t(
            "with 40 total dexterity and strength in radius, spectral shield throw chains +4 times",
            get_threshold(&["Dex", "Str"], "ChainCountMax", ModType::Base, nv(4.0), 0, 0, vec![tag("SkillName", skill_tf("Spectral Shield Throw"))]),
        ),
        t(
            "with 40 total dexterity and strength in radius, spectral shield throw fires 75% less shard projectiles",
            get_threshold(&["Dex", "Str"], "ProjectileCount", ModType::More, nv(-75.0), 0, 0, vec![tag("SkillName", skill_tf("Spectral Shield Throw"))]),
        ),
        t(
            "with at least 40 intelligence in radius, blight inflicts withered for 2 seconds",
            get_threshold(
                &["Int"],
                "ExtraSkillMod",
                ModType::List,
                wrap_mod(super::jewelfunc::new_mod("Condition:CanWither", ModType::Flag, super::jewelfunc::bv(true), None, 0, 0, vec![])),
                0,
                0,
                vec![tag("SkillName", skill_tf("Blight"))],
            ),
        ),
        t(
            "with at least 40 intelligence in radius, blight has 30% reduced cast speed",
            get_threshold(&["Int"], "Speed", ModType::Inc, nv(-30.0), 0, 0, vec![tag("SkillName", skill_tf("Blight"))]),
        ),
        t(
            "with at least 40 intelligence in radius, fireball cannot ignite",
            get_threshold(
                &["Int"],
                "ExtraSkillMod",
                ModType::List,
                wrap_mod(super::jewelfunc::flag_true("CannotIgnite", vec![])),
                0,
                0,
                vec![tag("SkillName", skill("Fireball"))],
            ),
        ),
        JewelTableEntry {
            pattern: r"with at least 40 intelligence in radius, fireball has %+(%d+)%% chance to inflict scorch",
            kind: JewelKind::Threshold,
            // Not wrapped in tonumber() in ModParser.lua: value stays the raw capture string.
            entry: JewelEntry::Ctor(|a| get_threshold(&["Int"], "EnemyScorchChance", ModType::Base, sv(a.s(1)), 0, 0, vec![tag("SkillName", skill("Fireball"))])),
        },
        t(
            "with at least 40 intelligence in radius, discharge has 60% less area of effect",
            get_threshold(&["Int"], "AreaOfEffect", ModType::More, nv(-60.0), 0, 0, vec![tag("SkillName", skill_tf("Discharge"))]),
        ),
        t(
            "with at least 40 intelligence in radius, discharge cooldown is 250 ms",
            get_threshold(&["Int"], "CooldownRecovery", ModType::Override, nv(0.25), 0, 0, vec![tag("SkillName", skill_tf("Discharge"))]),
        ),
        t(
            "with at least 40 intelligence in radius, discharge deals 60% less damage",
            get_threshold(&["Int"], "Damage", ModType::More, nv(-60.0), 0, 0, vec![tag("SkillName", skill_tf("Discharge"))]),
        ),
        JewelTableEntry {
            pattern: "with at least 40 intelligence in radius, (%d+)%% of damage taken recouped as mana if you've warcried recently",
            kind: JewelKind::Threshold,
            // Not wrapped in tonumber() in ModParser.lua: value stays the raw capture string.
            entry: JewelEntry::Ctor(|a| get_threshold(&["Int"], "ManaRecoup", ModType::Base, sv(a.s(1)), 0, 0, vec![tag("Condition", vec![("var", sv("UsedWarcryRecently"))])])),
        },
        JewelTableEntry {
            pattern: r"with at least 40 intelligence in radius, fireball projectiles gain radius as they travel farther, up to %+(%d+) radius",
            kind: JewelKind::Threshold,
            // Not wrapped in tonumber() in ModParser.lua: value stays the raw capture string
            // (unlike the very similar "metres" entry just below, whose `num * 10` arithmetic
            // coerces the capture to a real number as a side effect).
            entry: JewelEntry::Ctor(|a| {
                get_threshold(&["Int"], "AreaOfEffect", ModType::Base, sv(a.s(1)), 0, 0, vec![tag("DistanceRamp", vec![("ramp", super::jewelfunc::ramp_val(&[(0.0, 0.0), (50.0, 1.0)]))])])
            }),
        },
        JewelTableEntry {
            pattern: r"with at least 40 intelligence in radius, projectiles gain radius as they travel farther, up to a maximum of %+([%d%.]+) metres? to radius",
            kind: JewelKind::Threshold,
            entry: JewelEntry::Ctor(|a| {
                let num = a.n(1);
                get_threshold(&["Int"], "AreaOfEffect", ModType::Base, nv(num * 10.0), 0, 0, vec![tag("DistanceRamp", vec![("ramp", super::jewelfunc::ramp_val(&[(0.0, 0.0), (50.0, 1.0)]))])])
            }),
        },
        t(
            "with at least 40 intelligence in radius, raised spectres have a 50% chance to gain soul eater for 20 seconds on kill",
            get_threshold_multi(vec![
                get_threshold(
                    &["Int"],
                    "MinionModifier",
                    ModType::List,
                    wrap_mod(super::jewelfunc::new_mod("Condition:CanHaveSoulEater", ModType::Flag, super::jewelfunc::bv(true), None, 0, 0, vec![])),
                    0,
                    0,
                    vec![tag("SkillName", skill_tf("Raise Spectre"))],
                ),
                get_threshold(&["Int"], "Condition:MinionCanHaveSoulEater", ModType::Flag, super::jewelfunc::bv(true), 0, 0, vec![]),
            ]),
        ),
    ]
}
