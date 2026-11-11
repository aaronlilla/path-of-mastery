// Port of ModParser.lua specialModList, lines 4041-5955.
use super::helpers;
use super::support::{b, first_upper, flag_mod, flags, hole, kw, list, mk_mod, num, s, src, stag, tg, wrap, Arg, SpecialVal};
use crate::modparser::flags::{keyword_flag as kf, mod_flag as mf};
use crate::modparser::types::{mod_to_pval, PMod, PVal};

/// `{ key = val, ... }` as a `PVal::Map`, for the many literal-table mod values/tags this range
/// builds that aren't a plain `{ type = ..., ... }` tag (use `stag` for those).
fn mapv(fields: Vec<(&str, PVal)>) -> PVal {
    PVal::Map(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// `{ type = "SkillId", skillId = gemIdLookup[name] }`: `skillId` is only present when the name
/// resolves (Lua: assigning a nil table field never creates the key).
fn skill_id_tag(name: &str) -> PVal {
    let mut fields = Vec::new();
    if let Some(id) = helpers::gem_id_lookup().get(name) {
        fields.push(("skillId", s(id.clone())));
    }
    stag("SkillId", fields)
}

/// `{ skillId = gemIdLookup[name], level = level, applyToPlayer = true }`: the common shape
/// behind "you are cursed with ..." entries. `skillId` is only present when the name resolves
/// (Lua: assigning a nil table field omits the key).
fn extra_curse_fields(name: &str, level: f64) -> Vec<(&'static str, PVal)> {
    let mut fields = Vec::new();
    if let Some(id) = helpers::gem_id_lookup().get(name) {
        fields.push(("skillId", s(id.clone())));
    }
    fields.push(("level", num(level)));
    fields.push(("applyToPlayer", b(true)));
    fields
}

/// `mod("ExtraAura", "LIST", { onlyAllies = <only_allies>, mod = <inner> }, ...)`. `onlyAllies` is
/// only present in the map when true, matching Lua (assigning a table field `= false` never
/// appears in the entries this range ports; they either write `onlyAllies = true` or omit it).
fn extra_aura(inner: PMod, only_allies: bool, args: Vec<Arg>) -> PMod {
    let mut fields: Vec<(&str, PVal)> = Vec::new();
    if only_allies {
        fields.push(("onlyAllies", b(true)));
    }
    fields.push(("mod", mod_to_pval(&inner)));
    mk_mod("ExtraAura", "LIST", mapv(fields), args)
}

const DAMAGE_TYPE_LIST: [&str; 5] = ["Physical", "Lightning", "Cold", "Fire", "Chaos"];

/// Lua `dealNoNonDamageType(dmgType, forMinion)` (line 2018-2029): "DealNo<X>" flags for every
/// damage type except `dmgType`. Returns `None` when `dmgType` isn't a known damage type (Lua's
/// implicit `return` with no value).
fn deal_no_non_damage_type(dmg_type: &str, for_minion: bool) -> Option<Vec<PMod>> {
    let dmg_type = first_upper(dmg_type);
    if !DAMAGE_TYPE_LIST.contains(&dmg_type.as_str()) {
        return None;
    }
    Some(
        DAMAGE_TYPE_LIST
            .iter()
            .filter(|&&d| d != dmg_type)
            .map(|d| {
                let deal_no = flag_mod(format!("DealNo{}", d), vec![]);
                if for_minion { wrap("MinionModifier", deal_no, vec![]) } else { deal_no }
            })
            .collect(),
    )
}

/// Lua's `firstToUpper(x):gsub(" %l", string.upper):gsub(" ", "")` (and the equivalent
/// `x:gsub("^%l", string.upper):gsub(" %l", string.upper):gsub(" ", "")`): capitalizes the first
/// letter and the letter following every space, then removes the spaces, e.g. "flame surge" ->
/// "FlameSurge". Used to build a `SelfCast<SkillName>` condition variable from a captured skill
/// name.
fn pascal_no_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut cap_next = true;
    for c in s.chars() {
        if c == ' ' {
            cap_next = true;
            continue;
        }
        if cap_next {
            out.extend(c.to_uppercase());
            cap_next = false;
        } else {
            out.push(c);
        }
    }
    out
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
    v
}

fn part1() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        // 4041-4131
        ("auras from your skills can only affect you", Mods(vec![flag_mod("SelfAurasOnlyAffectYou", vec![])])),
        ("auras from your skills which affect allies also affect enemies", Mods(vec![flag_mod("AurasAffectEnemies", vec![])])),
        ("aura buffs from skills have (%d+)%% increased effect on you for each herald affecting you", Func(|a| Some(vec![
            mk_mod("SkillAuraEffectOnSelf", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("Herald"))]))]),
        ]))),
        ("aura buffs from skills have (%d+)%% increased effect on you for each herald affecting you, up to (%d+)%%", Func(|a| Some(vec![
            mk_mod("SkillAuraEffectOnSelf", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![
                ("var", s("Herald")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("PurposefulHarbinger")),
            ]))]),
        ]))),
        ("auras from your skills have (%d+)%% increased effect on you for each herald affecting you, up to (%d+)%%", Func(|a| Some(vec![
            mk_mod("SkillAuraEffectOnSelf", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![
                ("var", s("Herald")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("PurposefulHarbinger")),
            ]))]),
        ]))),
        ("(%d+)%% increased area of effect per power charge, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![
                ("var", s("PowerCharge")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("VastPower")),
            ]))]),
        ]))),
        ("(%d+)%% increased area of effect per second you've been stationary, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![
                ("var", s("StationarySeconds")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("ExpansiveMight")), ("limitTotal", b(true)),
            ]))]),
        ]))),
        ("(%d+)%% increased chaos damage per (%d+) maximum mana, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("ChaosDamage", "INC", num(a.n(1)), vec![tg(stag("PerStat", vec![
                ("stat", s("Mana")), ("div", num(a.n(2))), ("globalLimit", num(a.n(3))), ("globalLimitKey", s("DarkIdeation")),
            ]))]),
        ]))),
        ("minions have %+(%d+)%% to damage over time multiplier per ghastly eye jewel affecting you, up to a maximum of %+(%d+)%%", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("DotMultiplier", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![
                ("var", s("GhastlyEyeJewel")), ("actor", s("parent")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("AmanamuGaze")),
            ]))]), vec![]),
        ]))),
        ("(%d+)%% increased effect of arcane surge on you per hypnotic eye jewel affecting you, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("ArcaneSurgeEffect", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![
                ("var", s("HypnoticEyeJewel")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("KurgalGaze")),
            ]))]),
        ]))),
        ("(%d+)%% increased main hand critical strike chance per murderous eye jewel affecting you, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![
                tg(stag("Multiplier", vec![("var", s("MurderousEyeJewel")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("TecrodGazeMainHand"))])),
                tg(stag("Condition", vec![("var", s("MainHandAttack"))])),
            ]),
        ]))),
        ("%+(%d+)%% to off hand critical strike multiplier per murderous eye jewel affecting you, up to a maximum of %+(%d+)%%", Func(|a| Some(vec![
            mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![
                tg(stag("Multiplier", vec![("var", s("MurderousEyeJewel")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("TecrodGazeOffHand"))])),
                tg(stag("Condition", vec![("var", s("OffHandAttack"))])),
            ]),
        ]))),
        ("nearby allies' damage with hits is lucky", Mods(vec![
            mk_mod("ExtraAura", "LIST", mapv(vec![("onlyAllies", b(true)), ("mod", crate::modparser::types::mod_to_pval(&flag_mod("LuckyHits", vec![])))]), vec![]),
        ])),
        ("your damage with hits is lucky", Mods(vec![flag_mod("LuckyHits", vec![])])),
        ("your damage with hits is lucky while on low life", Mods(vec![flag_mod("LuckyHits", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("damage with hits is unlucky", Mods(vec![flag_mod("UnluckyHits", vec![])])),
        ("chaos damage with hits is lucky", Mods(vec![flag_mod("ChaosLuckyHits", vec![])])),
        ("lightning damage with hits is lucky if you[' ]h?a?ve blocked spell damage recently", Mods(vec![flag_mod("LightningLuckHits", vec![tg(stag("Condition", vec![("var", s("BlockedSpellRecently"))]))])])),
        ("cold damage with hits is lucky if you[' ]h?a?ve suppressed spell damage recently", Mods(vec![flag_mod("ColdLuckyHits", vec![tg(stag("Condition", vec![("var", s("SuppressedRecently"))]))])])),
        ("fire damage with hits is lucky if you[' ]h?a?ve blocked an attack recently", Mods(vec![flag_mod("FireLuckyHits", vec![tg(stag("Condition", vec![("var", s("BlockedAttackRecently"))]))])])),
        ("elemental damage with hits is lucky while you are shocked", Mods(vec![flag_mod("ElementalLuckHits", vec![tg(stag("Condition", vec![("var", s("Shocked"))]))])])),
        ("your lucky or unlucky effects are instead unexciting", Mods(vec![flag_mod("Unexciting", vec![])])),
        ("allies' aura buffs do not affect you", Mods(vec![flag_mod("AlliesAurasCannotAffectSelf", vec![])])),
        ("(%d+)%% increased effect of non%-curse auras from your skills on enemies", Func(|a| Some(vec![
            mk_mod("DebuffEffect", "INC", num(a.n(1)), vec![
                tg(stag("SkillType", vec![("skillType", num(39.0))])), // SkillType.Aura
                tg(stag("SkillType", vec![("skillType", num(69.0)), ("neg", b(true))])), // SkillType.AppliesCurse
            ]),
            mk_mod("AuraEffect", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Death Aura"))]))]),
        ]))),
        ("enemies can have 1 additional curse", Mods(vec![mk_mod("EnemyCurseLimit", "BASE", num(1.0), vec![])])),
        ("you can apply an additional curse", Mods(vec![mk_mod("EnemyCurseLimit", "BASE", num(1.0), vec![])])),
        ("you can apply an additional curse during effect", Mods(vec![mk_mod("EnemyCurseLimit", "BASE", num(1.0), vec![])])),
        ("you can apply an additional curse while affected by malevolence", Mods(vec![
            mk_mod("EnemyCurseLimit", "BASE", num(1.0), vec![tg(stag("Condition", vec![("var", s("AffectedByMalevolence"))]))]),
        ])),
        ("you can apply an additional curse while at maximum power charges", Mods(vec![
            mk_mod("EnemyCurseLimit", "BASE", num(1.0), vec![tg(stag("StatThreshold", vec![("stat", s("PowerCharges")), ("thresholdStat", s("PowerChargesMax"))]))]),
        ])),
        ("you can apply an additional curse if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("EnemyCurseLimit", "BASE", num(1.0), vec![tg(stag("MultiplierThreshold", vec![
                ("var", s(format!("{}Item", first_upper(a.s(2))))), ("threshold", num(a.n(1))),
            ]))]),
        ]))),
        ("you can apply one fewer curse", Mods(vec![mk_mod("EnemyCurseLimit", "BASE", num(-1.0), vec![])])),
        ("curses on enemies in your chilling areas have (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("CurseEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("InChillingArea"))]))]),
        ]))),
        ("hexes you inflict have their effect increased by twice their doom instead", Mods(vec![mk_mod("DoomEffect", "MORE", num(100.0), vec![])])),
        ("nearby enemies have an additional (%d+)%% chance to receive a critical strike", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("SelfExtraCritChance", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("nearby enemies have (%-%d+)%% to all resistances", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("ElementalResist", "BASE", num(a.n(1)), vec![]), vec![]),
            wrap("EnemyModifier", mk_mod("ChaosResist", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("enemies ignited or chilled by you have (%-%d+)%% to elemental resistances", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("ElementalResist", "BASE", num(a.n(1)), vec![]),
                vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("varList", list(vec![s("Ignited"), s("Chilled")]))]))]),
        ]))),
        ("reserves (%d+)%% of nearby enemy monsters' life", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("LifeReservationPercent", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("nearby enemy monsters have at least (%d+)%% of life reserved", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("LifeReservationPercent", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("your hits inflict decay, dealing (%d+) chaos damage per second for %d+ seconds", Func(|a| Some(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("decay")), ("value", num(a.n(1))), ("merge", s("MAX"))]), vec![]),
        ]))),
        // typo never existed except in some items generated by upstream
        ("inflict decay on enemies you curse with hex or mark skills, dealing (%d+) chaos damage per second for %d+ seconds", Func(|a| Some(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("decay")), ("value", num(a.n(1))), ("merge", s("MAX"))]),
                vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("inflict decay on enemies you curse with hex skills, dealing (%d+) chaos damage per second for %d+ seconds", Func(|a| Some(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("decay")), ("value", num(a.n(1))), ("merge", s("MAX"))]),
                vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("temporal chains has (%d+)%% reduced effect on you", Func(|a| Some(vec![
            mk_mod("CurseEffectOnSelf", "INC", num(-a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Temporal Chains"))]))]),
        ]))),
        ("unaffected by temporal chains", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Temporal Chains"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("targets are unaffected by your hexes", Mods(vec![
            mk_mod("CurseEffect", "MORE", num(-100.0), vec![tg(stag("SkillType", vec![("skillType", num(97.0))]))]), // SkillType.Hex
        ])),
        ("([%+%-][%d%.]+) seconds to cat's stealth duration", Func(|a| Some(vec![
            mk_mod("PrimaryDuration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Aspect of the Cat"))]))]),
        ]))),
        ("([%+%-][%d%.]+) seconds to cat's agility duration", Func(|a| Some(vec![
            mk_mod("SecondaryDuration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Aspect of the Cat"))]))]),
        ]))),
        ("([%+%-][%d%.]+) seconds to avian's might duration", Func(|a| Some(vec![
            mk_mod("PrimaryDuration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Aspect of the Avian"))]))]),
        ]))),
        ("([%+%-][%d%.]+) seconds to avian's flight duration", Func(|a| Some(vec![
            mk_mod("SecondaryDuration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Aspect of the Avian"))]))]),
        ]))),
        ("aspect of the spider can inflict spider's web on enemies an additional time", Mods(vec![
            wrap("ExtraSkillMod", mk_mod("Multiplier:SpiderWebApplyStackMax", "BASE", num(1.0), vec![]),
                vec![tg(stag("SkillName", vec![("skillName", s("Aspect of the Spider"))]))]),
        ])),
        ("aspect of the avian also grants avian's might and avian's flight to nearby allies", Mods(vec![
            wrap("ExtraSkillMod", flag_mod("BuffAppliesToAllies", vec![]),
                vec![tg(stag("SkillName", vec![("skillName", s("Aspect of the Avian"))]))]),
        ])),
        ("marked enemy takes (%d+)%% increased damage", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![]),
                vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Marked"))]))]),
        ]))),
        ("marked enemy has (%d+)%% reduced accuracy rating", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("Accuracy", "INC", num(-a.n(1)), vec![]),
                vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Marked"))]))]),
        ]))),
        ("you are cursed with level (%d+) (%D+)", Func(|a| Some(vec![
            mk_mod("ExtraCurse", "LIST", mapv(extra_curse_fields(a.s(2), a.n(1))), vec![]),
        ]))),
        ("you are cursed with (%D+)", Func(|a| Some(vec![
            mk_mod("ExtraCurse", "LIST", mapv(extra_curse_fields(a.s(1), 1.0)), vec![]),
        ]))),
        ("you are cursed with (%D+), with (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("ExtraCurse", "LIST", mapv(extra_curse_fields(a.s(1), 1.0)), vec![]),
            mk_mod("CurseEffectOnSelf", "INC", num(a.n(2)), vec![tg(stag("SkillName", vec![("skillName", s(helpers::title_case_words(a.s(1))))]))]),
        ]))),

        // 4133-4340
        ("you count as on low life while you are cursed with vulnerability", Mods(vec![flag_mod("Condition:LowLife", vec![tg(stag("Condition", vec![("var", s("AffectedByVulnerability"))]))])])),
        ("you count as on full life while you are cursed with vulnerability", Mods(vec![flag_mod("Condition:FullLife", vec![tg(stag("Condition", vec![("var", s("AffectedByVulnerability"))]))])])),
        ("if you consumed a corpse recently, you and nearby allies regenerate (%d+)%% of life per second", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("ConsumedCorpseRecently"))]))]),
        ]))),
        ("if you have blocked recently, you and nearby allies regenerate (%d+)%% of life per second", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
        ]))),
        ("you are at maximum chance to block attack damage if you have not blocked recently", Mods(vec![
            flag_mod("MaxBlockIfNotBlockedRecently", vec![tg(stag("Condition", vec![("var", s("BlockedRecently")), ("neg", b(true))]))]),
        ])),
        ("you are at maximum chance to block spell damage if you have not blocked recently", Mods(vec![
            flag_mod("MaxSpellBlockIfNotBlockedRecently", vec![tg(stag("Condition", vec![("var", s("BlockedRecently")), ("neg", b(true))]))]),
        ])),
        ("%+(%d+)%% chance to block attack damage if you have not blocked recently", Func(|a| Some(vec![
            mk_mod("BlockChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("BlockedRecently")), ("neg", b(true))]))]),
        ]))),
        ("%+(%d+)%% chance to block spell damage if you have not blocked recently", Func(|a| Some(vec![
            mk_mod("SpellBlockChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("BlockedRecently")), ("neg", b(true))]))]),
        ]))),
        ("y?o?u?r? ?chance to block is lucky", Mods(vec![
            flag_mod("BlockChanceIsLucky", vec![]), flag_mod("ProjectileBlockChanceIsLucky", vec![]),
            flag_mod("SpellBlockChanceIsLucky", vec![]), flag_mod("SpellProjectileBlockChanceIsLucky", vec![]),
        ])),
        ("y?o?u?r? ?chance to block attack damage is lucky", Mods(vec![flag_mod("BlockChanceIsLucky", vec![]), flag_mod("ProjectileBlockChanceIsLucky", vec![])])),
        ("y?o?u?r? ?chance to block attack damage is unlucky", Mods(vec![flag_mod("BlockChanceIsUnlucky", vec![]), flag_mod("ProjectileBlockChanceIsUnlucky", vec![])])),
        ("y?o?u?r? ?chance to block is unlucky", Mods(vec![
            flag_mod("BlockChanceIsUnlucky", vec![]), flag_mod("ProjectileBlockChanceIsUnlucky", vec![]),
            flag_mod("SpellBlockChanceIsUnlucky", vec![]), flag_mod("SpellProjectileBlockChanceIsUnlucky", vec![]),
        ])),
        ("y?o?u?r? ?chance to block spell damage is lucky", Mods(vec![flag_mod("SpellBlockChanceIsLucky", vec![]), flag_mod("SpellProjectileBlockChanceIsLucky", vec![])])),
        ("y?o?u?r? ?chance to block spell damage is unlucky", Mods(vec![flag_mod("SpellBlockChanceIsUnlucky", vec![]), flag_mod("SpellProjectileBlockChanceIsUnlucky", vec![])])),
        ("your lucky or unlucky effects use the best or worst from three rolls instead of two", Mods(vec![flag_mod("ExtremeLuck", vec![])])),
        ("chance to block attack or spell damage is lucky if you've blocked recently", Mods(vec![
            flag_mod("BlockChanceIsLucky", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
            flag_mod("ProjectileBlockChanceIsLucky", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
            flag_mod("SpellBlockChanceIsLucky", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
            flag_mod("SpellProjectileBlockChanceIsLucky", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
        ])),
        ("([%d%.]+)%% of evasion rating is regenerated as life per second while focus?sed", Func(|a| Some(vec![
            mk_mod("LifeRegen", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("Evasion")), ("percent", num(a.n(1)))])),
                tg(stag("Condition", vec![("var", s("Focused"))])),
            ]),
        ]))),
        ("nearby allies have (%d+)%% increased defences per (%d+) strength you have", Func(|a| Some(vec![
            extra_aura(mk_mod("Defences", "INC", num(a.n(1)), vec![]), true, vec![tg(stag("PerStat", vec![("stat", s("Str")), ("div", num(a.n(2)))]))]),
        ]))),
        ("nearby allies have %+(%d+)%% to critical strike multiplier per (%d+) dexterity you have", Func(|a| Some(vec![
            extra_aura(mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![]), true, vec![tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(2)))]))]),
        ]))),
        ("nearby allies have (%d+)%% increased cast speed per (%d+) intelligence you have", Func(|a| Some(vec![
            extra_aura(mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Cast)]), true, vec![tg(stag("PerStat", vec![("stat", s("Int")), ("div", num(a.n(2)))]))]),
        ]))),
        ("quicksilver flasks you use also apply to nearby allies", Mods(vec![flag_mod("QuickSilverAppliesToAllies", vec![])])),
        ("you gain divinity for %d+ seconds on reaching maximum divine charges", Mods(vec![
            mk_mod("ElementalDamage", "MORE", num(75.0), vec![tg(stag("Condition", vec![("var", s("Divinity"))]))]),
            mk_mod("ElementalDamageTaken", "MORE", num(-25.0), vec![tg(stag("Condition", vec![("var", s("Divinity"))]))]),
        ])),
        ("your nearby party members maximum endurance charges is equal to yours", Mods(vec![flag_mod("PartyMemberMaximumEnduranceChargesEqualToYours", vec![])])),
        ("your maximum endurance charges is equal to your maximum frenzy charges", Mods(vec![flag_mod("MaximumEnduranceChargesIsMaximumFrenzyCharges", vec![])])),
        ("your maximum frenzy charges is equal to your maximum power charges", Mods(vec![flag_mod("MaximumFrenzyChargesIsMaximumPowerCharges", vec![])])),
        ("your curse limit is equal to your maximum power charges", Mods(vec![flag_mod("CurseLimitIsMaximumPowerCharges", vec![])])),
        ("consecrated ground you create grants (%d+)%% increased accuracy rating to you and allies", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("ConsecratedGroundAlsoAccuracy", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))]), vec![]),
        ]))),
        ("consecrated ground created during effect applies (%d+)%% increased damage taken to enemies", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTakenConsecratedGround", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))]),
                vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("consecrated ground you create while affected by zealotry causes enemies to take (%d+)%% increased damage", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTakenConsecratedGround", "INC", num(a.n(1)), vec![]), vec![
                tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("OnConsecratedGround"))])),
                tg(stag("Condition", vec![("var", s("AffectedByZealotry"))])),
            ]),
        ]))),
        ("if you've warcried recently, you and nearby allies have (%d+)%% increased attack, cast and movement speed", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("Speed", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
            wrap("ExtraAura", mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
        ]))),
        ("(%d+)%% increased movement speed while on full life", Func(|a| Some(vec![
            mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FullLife"))]))]),
        ]))),
        ("when you warcry, you and nearby allies gain onslaught for 4 seconds", Mods(vec![
            wrap("ExtraAura", flag_mod("Onslaught", vec![]), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
        ])),
        ("warcries grant arcane surge to you and allies, with (%d+)%% increased effect per (%d+) power, up to (%d+)%%", Func(|a| Some(vec![
            wrap("ExtraAura", flag_mod("Condition:ArcaneSurge", vec![]), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
            mk_mod("ArcaneSurgeEffect", "INC", num(a.n(1)), vec![
                tg(stag("PerStat", vec![("stat", s("WarcryPower")), ("div", num(a.n(2))), ("globalLimit", num(a.n(3))), ("globalLimitKey", s("Brinerot Flag"))])),
                tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))])),
            ]),
        ]))),
        ("gain arcane surge after spending a total of (%d+) mana", Func(|a| Some(vec![
            wrap("ExtraAura", flag_mod("Condition:ArcaneSurge", vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("ManaSpentRecently")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("gain arcane surge after spending a total of (%d+) life", Func(|a| Some(vec![
            wrap("ExtraAura", flag_mod("Condition:ArcaneSurge", vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("LifeSpentRecently")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("gain onslaught for (%d+) seconds on hit while at maximum frenzy charges", Mods(vec![
            flag_mod("Onslaught", vec![
                tg(stag("StatThreshold", vec![("stat", s("FrenzyCharges")), ("thresholdStat", s("FrenzyChargesMax"))])),
                tg(stag("Condition", vec![("var", s("HitRecently"))])),
            ]),
        ])),
        ("enemies in your chilling areas take (%d+)%% increased lightning damage", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("LightningDamageTaken", "INC", num(a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("InChillingArea"))]))]),
        ]))),
        ("warcries count as having (%d+) additional nearby enemies", Func(|a| Some(vec![
            mk_mod("Multiplier:WarcryNearbyEnemies", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("enemies taunted by your warcries take (%d+)%% increased damage", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Taunted"))]))]),
                vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
        ]))),
        ("warcries have minimum of (%d+) power", Mods(vec![flag_mod("CryWolfMinimumPower", vec![])])),
        ("warcries have infinite power", Mods(vec![flag_mod("WarcryInfinitePower", vec![])])),
        ("your warcries do not grant buffs or charges to you", Mods(vec![flag_mod("CannotGainWarcryBuffs", vec![])])),
        ("(%d+)%% chance to inflict corrosion on hit with attacks", Mods(vec![flag_mod("Condition:CanCorrode", vec![])])),
        ("(%d+)%% chance to inflict withered for (%d+) seconds on hit", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("melee weapon hits inflict (%d+) withered debuffs for (%d+) seconds", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("inflict withered for (%d+) seconds on hit if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            flag_mod("Condition:CanWither", vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(2)))))]))]),
        ]))),
        ("(%d+)%% chance to inflict withered for (%d+) seconds on hit with this weapon", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("(%d+)%% chance to inflict withered for (%d+) seconds on hit against cursed enemies", Mods(vec![
            flag_mod("Condition:CanWither", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ])),
        ("(%d+)%% chance to inflict withered for two seconds on hit if there are (%d+) or fewer withered debuffs on enemy", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("inflict withered for (%d+) seconds on hit with this weapon", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("chaos skills inflict up to (%d+) withered debuffs on hit for (%d+) seconds", Mods(vec![flag_mod("Condition:CanWither", vec![])])),
        ("minions have (%d+)%% chance to inflict withered on hit", Mods(vec![wrap("MinionModifier", flag_mod("Condition:CanWither", vec![]), vec![])])),
        ("enemies take (%d+)%% increased elemental damage from your hits for each withered you have inflicted on them", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("ElementalDamageTaken", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("WitheredStack")), ("limit", num(15.0))]))]), vec![]),
        ]))),
        ("your hits cannot penetrate or ignore elemental resistances", Mods(vec![flag_mod("CannotElePenIgnore", vec![])])),
        ("nearby enemies have malediction", Mods(vec![wrap("EnemyModifier", flag_mod("HasMalediction", vec![]), vec![])])),
        ("gain shaper's presence for 10 seconds when you kill a rare or unique enemy", Mods(vec![
            wrap("ExtraAura", flag_mod("HasShapersPresence", vec![]), vec![tg(stag("Condition", vec![("var", s("KilledUniqueEnemy"))]))]),
        ])),
        ("gain maddening presence for 10 seconds when you kill a rare or unique enemy", Mods(vec![
            wrap("EnemyModifier", flag_mod("HasMaddeningPresence", vec![]), vec![tg(stag("Condition", vec![("var", s("KilledUniqueEnemy"))]))]),
        ])),
        ("elemental damage you deal with hits is resisted by lowest elemental resistance instead", Mods(vec![flag_mod("ElementalDamageUsesLowestResistance", vec![])])),
        ("you take (%d+) chaos damage per second for 3 seconds on kill", Func(|a| Some(vec![
            mk_mod("ChaosDegen", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("KilledLast3Seconds"))]))]),
        ]))),
        ("regenerate (%d+) life per second for each (%d+)%% uncapped fire resistance", Func(|a| Some(vec![
            mk_mod("LifeRegen", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("FireResistTotal")), ("div", num(1.0 / a.n(2)))]))]),
        ]))),
        ("regenerate (%d+) life over 1 second for each spell you cast", Func(|a| Some(vec![
            mk_mod("LifeRegen", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("CastLast1Seconds"))]))]),
        ]))),
        ("and nearby allies regenerate (%d+) life per second", Func(|a| Some(vec![
            wrap("ExtraAura", mk_mod("LifeRegen", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("KilledPoisonedLast2Seconds"))]))]),
        ]))),
        ("(%d+)%% increased life regeneration rate", Func(|a| Some(vec![mk_mod("LifeRegen", "INC", num(a.n(1)), vec![])]))),
        ("every (%d+) seconds, regenerate life equal to (%d+)%% of armour and evasion rating over (%d+) second", Func(|a| {
            let avg = num(1.0 / a.n(1) * a.n(3));
            let percent_raw = s(a.s(2).to_string());
            Some(vec![
                mk_mod("LifeRegen", "BASE", num(1.0), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstFull"))])), tg(stag("PercentStat", vec![("stat", s("Armour")), ("percent", percent_raw.clone())]))]),
                mk_mod("LifeRegen", "BASE", avg.clone(), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstAvg"))])), tg(stag("PercentStat", vec![("stat", s("Armour")), ("percent", percent_raw.clone())]))]),
                mk_mod("LifeRegen", "BASE", num(1.0), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstFull"))])), tg(stag("PercentStat", vec![("stat", s("Evasion")), ("percent", percent_raw.clone())]))]),
                mk_mod("LifeRegen", "BASE", avg, vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstAvg"))])), tg(stag("PercentStat", vec![("stat", s("Evasion")), ("percent", percent_raw)]))]),
            ])
        })),
        ("every (%d+) seconds, regenerate energy shield equal to (%d+)%% of evasion rating over (%d+) second", Func(|a| {
            let avg = num(1.0 / a.n(1) * a.n(3));
            let percent_raw = s(a.s(2).to_string());
            Some(vec![
                mk_mod("EnergyShieldRegen", "BASE", num(1.0), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstFull"))])), tg(stag("PercentStat", vec![("stat", s("Evasion")), ("percent", percent_raw.clone())]))]),
                mk_mod("EnergyShieldRegen", "BASE", avg, vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstAvg"))])), tg(stag("PercentStat", vec![("stat", s("Evasion")), ("percent", percent_raw)]))]),
            ])
        })),
    ]
}

fn part2() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("regenerate (%d+)%% of life per second for each different ailment affecting you", Func(|a| Some(
            ["Bleeding", "Ignited", "Scorched", "Chilled", "Frozen", "Brittle", "Shocked", "Sapped", "Poisoned"]
                .iter().map(|v| mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s(*v))]))])).collect()
        ))),
        ("fire skills have a (%d+)%% chance to apply fire exposure on hit", Func(|a| Some(vec![mk_mod("FireExposureChance", "BASE", num(a.n(1)), vec![])]))),
        ("cold skills have a (%d+)%% chance to apply cold exposure on hit", Func(|a| Some(vec![mk_mod("ColdExposureChance", "BASE", num(a.n(1)), vec![])]))),
        ("lightning skills have a (%d+)%% chance to apply lightning exposure on hit", Func(|a| Some(vec![mk_mod("LightningExposureChance", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% chance to inflict cold exposure on hit with cold damage", Func(|a| Some(vec![mk_mod("ColdExposureChance", "BASE", num(a.n(1)), vec![])]))),
        ("socketed skills apply fire, cold and lightning exposure on hit", Mods(vec![
            mk_mod("FireExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            mk_mod("ColdExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            mk_mod("LightningExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ])),
        ("inflict fire, cold, and lightning exposure on hit", Mods(vec![
            mk_mod("FireExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            mk_mod("ColdExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            mk_mod("LightningExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ])),
        ("inflict fire exposure on hit", Mods(vec![mk_mod("FireExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))])])),
        ("inflict cold exposure on hit", Mods(vec![mk_mod("ColdExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))])])),
        ("inflict lightning exposure on hit", Mods(vec![mk_mod("LightningExposureChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))])])),
        ("nearby enemies have fire exposure", Mods(vec![wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))])])),
        ("nearby enemies have cold exposure", Mods(vec![wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))])])),
        ("nearby enemies have lightning exposure", Mods(vec![wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))])])),
        ("nearby enemies have fire exposure while at maximum rage", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("HaveMaximumRage"))]))]),
        ])),
        ("nearby enemies have fire exposure while you are affected by herald of ash", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("AffectedByHeraldofAsh"))]))]),
        ])),
        ("nearby enemies have cold exposure while you are affected by herald of ice", Mods(vec![
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("AffectedByHeraldofIce"))]))]),
        ])),
        ("nearby enemies have lightning exposure while you are affected by herald of thunder", Mods(vec![
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("AffectedByHeraldofThunder"))]))]),
        ])),
        ("(%a+) exposure on hit if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod(format!("{}Exposure", first_upper(a.s(1))), "BASE", num(-10.0), vec![]),
                vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(2)))))])), tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ]))),
        ("inflict (%a+) exposure on hit if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod(format!("{}Exposure", first_upper(a.s(1))), "BASE", num(-10.0), vec![]),
                vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(2)))))])), tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ]))),
        ("inflict fire, cold and lightning exposure on nearby enemies when used", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-10.0), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))])), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("enemies near your linked targets have fire, cold and lightning exposure", Mods(vec![
            wrap("EnemyModifier", mk_mod("FireExposure", "BASE", num(-10.0), vec![tg(stag("Condition", vec![("var", s("NearLinkedTarget"))]))]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            wrap("EnemyModifier", mk_mod("ColdExposure", "BASE", num(-10.0), vec![tg(stag("Condition", vec![("var", s("NearLinkedTarget"))]))]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            wrap("EnemyModifier", mk_mod("LightningExposure", "BASE", num(-10.0), vec![tg(stag("Condition", vec![("var", s("NearLinkedTarget"))]))]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ])),
        ("inflict (%w+) exposure on hit, applying %-(%d+)%% to (%w+) resistance", Func(|a| Some(vec![
            mk_mod(format!("{}ExposureChance", first_upper(a.s(1))), "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
            wrap("EnemyModifier", mk_mod(format!("{}Exposure", first_upper(a.s(3))), "BASE", num(-a.n(2)), vec![]), vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ]))),
        ("while a unique enemy is in your presence, inflict (%w+) exposure on hit, applying %-(%d+)%% to (%w+) resistance", Func(|a| Some(vec![
            mk_mod(format!("{}ExposureChance", first_upper(a.s(1))), "BASE", num(100.0), vec![
                tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))])),
                tg(stag("Condition", vec![("var", s("Effective"))])),
            ]),
            wrap("EnemyModifier", mk_mod(format!("{}Exposure", first_upper(a.s(3))), "BASE", num(-a.n(2)), vec![tg(stag("Condition", vec![("var", s("RareOrUnique"))]))]),
                vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ]))),
        ("while a pinnacle atlas boss is in your presence, inflict (%w+) exposure on hit, applying %-(%d+)%% to (%w+) resistance", Func(|a| Some(vec![
            mk_mod(format!("{}ExposureChance", first_upper(a.s(1))), "BASE", num(100.0), vec![
                tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))])),
                tg(stag("Condition", vec![("var", s("Effective"))])),
            ]),
            wrap("EnemyModifier", mk_mod(format!("{}Exposure", first_upper(a.s(3))), "BASE", num(-a.n(2)), vec![tg(stag("Condition", vec![("var", s("PinnacleBoss"))]))]),
                vec![tg(stag("Condition", vec![("var", s("Effective"))]))]),
        ]))),
        ("inflict fire exposure on hit against enemies with (%d+) cinderflame, applying %-(%d+)%% to (%w+) resistance", Func(|a| Some(vec![
            mk_mod("FireExposureChance", "BASE", num(100.0), vec![
                tg(stag("Condition", vec![("var", s("Effective"))])),
                tg(stag("MultiplierThreshold", vec![("var", s("CinderflameStacks")), ("threshold", num(a.n(1)))])),
            ]),
            wrap("EnemyModifier", mk_mod(format!("{}Exposure", first_upper(a.s(3))), "BASE", num(-a.n(2)), vec![]), vec![
                tg(stag("Condition", vec![("var", s("Effective"))])),
                tg(stag("MultiplierThreshold", vec![("var", s("CinderflameStacks")), ("threshold", num(a.n(1)))])),
            ]),
        ]))),
        ("fire exposure you inflict applies an extra (%-?%d+)%% to fire resistance", Func(|a| Some(vec![mk_mod("ExtraFireExposure", "BASE", num(a.n(1)), vec![])]))),
        ("cold exposure you inflict applies an extra (%-?%d+)%% to cold resistance", Func(|a| Some(vec![mk_mod("ExtraColdExposure", "BASE", num(a.n(1)), vec![])]))),
        ("lightning exposure you inflict applies an extra (%-?%d+)%% to lightning resistance", Func(|a| Some(vec![mk_mod("ExtraLightningExposure", "BASE", num(a.n(1)), vec![])]))),
        ("exposure you inflict applies at least (%-%d+)%% to the affected resistance", Func(|a| Some(vec![mk_mod("ExposureMin", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("modifiers to minimum endurance charges instead apply to minimum brutal charges", Mods(vec![flag_mod("MinimumEnduranceChargesEqualsMinimumBrutalCharges", vec![])])),
        ("modifiers to minimum frenzy charges instead apply to minimum affliction charges", Mods(vec![flag_mod("MinimumFrenzyChargesEqualsMinimumAfflictionCharges", vec![])])),
        ("modifiers to minimum power charges instead apply to minimum absorption charges", Mods(vec![flag_mod("MinimumPowerChargesEqualsMinimumAbsorptionCharges", vec![])])),
        ("maximum brutal charges is equal to maximum endurance charges", Mods(vec![flag_mod("MaximumEnduranceChargesEqualsMaximumBrutalCharges", vec![])])),
        ("maximum affliction charges is equal to maximum frenzy charges", Mods(vec![flag_mod("MaximumFrenzyChargesEqualsMaximumAfflictionCharges", vec![])])),
        ("maximum absorption charges is equal to maximum power charges", Mods(vec![flag_mod("MaximumPowerChargesEqualsMaximumAbsorptionCharges", vec![])])),
        ("(%d+)%% chance to gain a brine charge instead of an endurance charge", Func(|a| Some(vec![
            flag_mod("CanGainBrineCharges", vec![]),
            mk_mod("BrineChargeGainChance", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("gain brutal charges instead of endurance charges", Mods(vec![flag_mod("EnduranceChargesConvertToBrutalCharges", vec![])])),
        ("gain affliction charges instead of frenzy charges", Mods(vec![flag_mod("FrenzyChargesConvertToAfflictionCharges", vec![])])),
        ("gain absorption charges instead of power charges", Mods(vec![flag_mod("PowerChargesConvertToAbsorptionCharges", vec![])])),
        ("regenerate (%d+)%% life over one second when hit while sane", Func(|a| Some(vec![
            mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Insane")), ("neg", b(true))])), tg(stag("Condition", vec![("var", s("BeenHitRecently"))]))]),
        ]))),
        ("you count as on low (%a+) while at (%d+)%% of maximum (%a+) or below", Func(|a| Some(vec![
            mk_mod(format!("Low{}Percentage", first_upper(a.s(1))), "BASE", num(a.n(2) / 100.0), vec![]),
        ]))),
        ("you count as on full (%a+) while at (%d+)%% of maximum (%a+) or above", Func(|a| Some(vec![
            mk_mod(format!("Full{}Percentage", first_upper(a.s(1))), "BASE", num(a.n(2) / 100.0), vec![]),
        ]))),
        ("(%d+)%% more maximum life if you have at least (%d+) life masteries allocated", Func(|a| Some(vec![
            mk_mod("Life", "MORE", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("AllocatedLifeMastery")), ("threshold", num(a.n(2)))]))]),
        ]))),
        ("left ring slot: cover enemies in ash for (%d+) seconds when you ignite them", Mods(vec![
            mk_mod("CoveredInAshEffect", "BASE", num(20.0), vec![tg(stag("SlotNumber", vec![("num", num(1.0))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))]))]),
        ])),
        ("right ring slot: cover enemies in frost for (%d+) seconds when you freeze them", Mods(vec![
            mk_mod("CoveredInFrostEffect", "BASE", num(20.0), vec![tg(stag("SlotNumber", vec![("num", num(2.0))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Frozen"))]))]),
        ])),
        ("nearby enemies are covered in ash", Mods(vec![mk_mod("CoveredInAshEffect", "BASE", num(20.0), vec![])])),
        ("nearby enemies are covered in ash if you haven't moved in the past (%d+) seconds", Func(|a| Some(vec![
            mk_mod("CoveredInAshEffect", "BASE", num(20.0), vec![tg(stag("MultiplierThreshold", vec![("var", s("StationarySeconds")), ("threshold", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("Stationary"))]))]),
        ]))),
        ("your warcries cover enemies in ash for (%d+) seconds", Mods(vec![mk_mod("CoveredInAshEffect", "BASE", num(20.0), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))])])),
        ("enemies near targets you shatter have (%d+)%% chance to be covered in frost for (%d+) seconds", Mods(vec![mk_mod("CoveredInFrostEffect", "BASE", num(20.0), vec![tg(stag("Condition", vec![("var", s("ShatteredEnemyRecently"))]))])])),

        // 4341-4530
        // Lua: function(_, skill, num) return { mod("BuffEffect", "INC", num, ...) } end
        // `num` is param position 2 (not 0 or 1), so it is never tonumber()'d and stays a string.
        ("([%a%s]+) has (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("BuffEffect", "INC", s(a.s(2)), vec![tg(skill_id_tag(a.s(1)))]),
        ]))),
        ("debuffs on you expire (%d+)%% faster", Func(|a| Some(vec![mk_mod("SelfDebuffExpirationRate", "BASE", num(a.n(1)), vec![])]))),
        ("debuffs on you expire (%d+)%% slower", Func(|a| Some(vec![mk_mod("SelfDebuffExpirationRate", "BASE", num(-a.n(1)), vec![])]))),
        ("debuffs on you expire (%d+)%% faster while affected by haste", Func(|a| Some(vec![
            mk_mod("SelfDebuffExpirationRate", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByHaste"))]))]),
        ]))),
        ("warcries debilitate enemies for (%d+) seconds?", Mods(vec![mk_mod("DebilitateChance", "BASE", num(100.0), vec![])])),
        ("debilitate enemies for (%d+) seconds? when you suppress their spell damage", Mods(vec![mk_mod("DebilitateChance", "BASE", num(100.0), vec![])])),
        ("debilitate nearby enemies for (%d+) seconds? when f?l?a?s?k? ?effect ends", Mods(vec![mk_mod("DebilitateChance", "BASE", num(100.0), vec![])])),
        ("counterattacks have a (%d+)%% chance to debilitate on hit for (%d+) seconds?", Func(|a| Some(vec![mk_mod("DebilitateChance", "BASE", num(a.n(1)), vec![])]))),
        ("retaliation skills debilitate enemies for (%d+) seconds on hit", Mods(vec![mk_mod("DebilitateChance", "BASE", num(100.0), vec![])])),
        ("eat a soul when you hit a unique enemy, no more than once every second", Mods(vec![flag_mod("Condition:CanHaveSoulEater", vec![])])),
        ("eat a soul when you hit a rare or unique enemy, no more than once every [%d%.]+ seconds", Mods(vec![flag_mod("Condition:CanHaveSoulEater", vec![])])),
        ("(%d+)%% chance to gain soul eater for (%d+) seconds on killing blow against rare and unique enemies with double strike or dual strike", Mods(vec![flag_mod("Condition:CanHaveSoulEater", vec![])])),
        ("when (%d+)%% of your hex's duration expires on an enemy, eat (%d+) soul per enemy power", Mods(vec![flag_mod("Condition:CanHaveSoulEater", vec![])])),
        ("eat (%d+) souls when you kill a rare or unique enemy with this weapon", Mods(vec![flag_mod("Condition:CanHaveSoulEater", vec![])])),
        ("maximum (%d+) eaten souls", Func(|a| Some(vec![mk_mod("SoulEaterMax", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("([%+%-]%d+) to maximum number of eaten souls", Func(|a| Some(vec![mk_mod("SoulEaterMax", "BASE", num(a.n(1)), vec![])]))),
        // This boot enchant gives a buff that applies both stats individually.
        ("(%d+)%% increased attack and cast speed if you've killed recently", Func(|a| Some(vec![
            mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Cast), tg(stag("Condition", vec![("var", s("KilledRecently"))]))]),
            mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Attack), tg(stag("Condition", vec![("var", s("KilledRecently"))]))]),
        ]))),
        ("gain adrenaline for 1 second when you change stance", Mods(vec![flag_mod("Condition:Adrenaline", vec![tg(stag("Condition", vec![("var", s("StanceChangeLastSecond"))]))])])),
        ("with a searching eye jewel socketed, maim enemies for (%d) seconds on hit with attacks", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Maimed", vec![flags(mf::Attack)]), vec![tg(stag("Condition", vec![("var", s("HaveSearchingEyeJewelIn{SlotName}"))]))]),
        ])),
        ("with a searching eye jewel socketed, blind enemies for (%d) seconds on hit with attacks", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Blinded", vec![flags(mf::Attack)]), vec![tg(stag("Condition", vec![("var", s("HaveSearchingEyeJewelIn{SlotName}"))]))]),
        ])),
        ("enemies maimed by you take (%d+)%% increased damage over time", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTakenOverTime", "INC", num(a.n(1)), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Maimed"))]))]),
        ]))),
        ("(%d+)%% increased defences while you have at least four linked targets", Func(|a| Some(vec![
            mk_mod("Defences", "INC", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("LinkedTargets")), ("threshold", num(4.0))]))]),
        ]))),
        ("your movement speed is equal to the highest movement speed among linked players", Mods(vec![
            flag_mod("MovementSpeedEqualHighestLinkedPlayers", vec![tg(stag("MultiplierThreshold", vec![("var", s("LinkedTargets")), ("threshold", num(1.0))]))]),
        ])),
        ("(%d+)%% increased movement speed while you have at least two linked targets", Func(|a| Some(vec![
            mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("LinkedTargets")), ("threshold", num(2.0))]))]),
        ]))),
        ("link skills have (%d+)%% increased buff effect if you have linked to a target recently", Func(|a| Some(vec![
            mk_mod("BuffEffect", "INC", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(107.0))])), tg(stag("Condition", vec![("var", s("LinkedRecently"))]))]), // SkillType.Link
        ]))),
        ("link skills can target damageable minions", Mods(vec![flag_mod("Condition:CanLinkToMinions", vec![tg(stag("Condition", vec![("var", s("HaveDamageableMinion"))]))])])),
        ("your linked minions take (%d+)%% less damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("DamageTaken", "MORE", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByLink"))]))]), vec![]),
        ]))),
        ("curses are inflicted on you instead of linked targets", Mods(vec![wrap("ExtraLinkEffect", flag_mod("CurseImmune", vec![]), vec![])])),
        ("elemental ailments are inflicted on you instead of linked targets", Mods(vec![wrap("ExtraLinkEffect", flag_mod("ElementalAilmentImmune", vec![]), vec![])])),
        ("non%-unique utility flasks you use apply to linked targets", Mods(vec![
            wrap("ExtraLinkEffect", mk_mod("ParentNonUniqueFlasksAppliedToYou", "FLAG", b(true), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]), vec![]),
        ])),
        ("non%-curse auras from your skills only apply to you and linked targets", Mods(vec![
            flag_mod("SelfAurasAffectYouAndLinkedTarget", vec![
                tg(stag("SkillType", vec![("skillType", num(39.0))])), // SkillType.Aura
                tg(stag("SkillType", vec![("skillType", num(69.0)), ("neg", b(true))])), // SkillType.AppliesCurse
            ]),
        ])),
        ("linked targets always count as in range of non%-curse auras from your skills", Mods(vec![])),
        ("gain unholy might on block for (%d) seconds", Mods(vec![
            flag_mod("Condition:UnholyMight", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
            flag_mod("Condition:CanWither", vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))]),
        ])),
        ("your warcries inflict hallowing flame", Mods(vec![flag_mod("Condition:CanInflictHallowingFlame", vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))])])),
        ("attacks with this weapon inflict hallowing flame on hit", Mods(vec![flag_mod("Condition:CanInflictHallowingFlame", vec![])])),
        ("inflict hallowing flame on hit while on consecrated ground", Mods(vec![flag_mod("Condition:CanInflictHallowingFlame", vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))])])),
        ("inflict hallowing flame on melee hit", Mods(vec![flag_mod("Condition:CanInflictHallowingFlame", vec![])])),
        // Traps, Mines
        ("traps and mines deal (%d+)%-(%d+) additional physical damage", Func(|a| Some(vec![
            mk_mod("PhysicalMin", "BASE", num(a.n(1)), vec![kw(kf::Trap | kf::Mine)]),
            mk_mod("PhysicalMax", "BASE", num(a.n(2)), vec![kw(kf::Trap | kf::Mine)]),
        ]))),
        ("traps and mines deal (%d+) to (%d+) additional physical damage", Func(|a| Some(vec![
            mk_mod("PhysicalMin", "BASE", num(a.n(1)), vec![kw(kf::Trap | kf::Mine)]),
            mk_mod("PhysicalMax", "BASE", num(a.n(2)), vec![kw(kf::Trap | kf::Mine)]),
        ]))),
        ("each mine applies (%d+)%% increased damage taken to enemies near it, up to (%d+)%%", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("ActiveMineCount")), ("limit", num(a.n(2) / a.n(1)))]))]), vec![]),
        ]))),
        ("each mine applies (%d+)%% reduced damage dealt to enemies near it, up to (%d+)%%", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("Damage", "INC", num(-a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("ActiveMineCount")), ("limit", num(a.n(2) / a.n(1)))]))]), vec![]),
        ]))),
        ("stormblast, icicle and pyroclast mine have (%d+)%% increased aura effect", Func(|a| Some(vec![
            mk_mod("AuraEffect", "INC", num(a.n(1)), vec![kw(kf::Mine), tg(stag("SkillName", vec![
                ("skillNameList", list(vec![s("Stormblast Mine"), s("Icicle Mine"), s("Pyroclast Mine")])),
                ("includeTransfigured", b(true)),
            ]))]),
        ]))),
        ("stormblast, icicle and pyroclast mine deal no damage", Mods(vec![
            flag_mod("DealNoDamage", vec![tg(stag("SkillName", vec![
                ("skillNameList", list(vec![s("Stormblast Mine"), s("Icicle Mine"), s("Pyroclast Mine")])),
                ("includeTransfigured", b(true)),
            ]))]),
        ])),
        ("can have up to (%d+) additional traps? placed at a time", Func(|a| Some(vec![mk_mod("ActiveTrapLimit", "BASE", num(a.n(1)), vec![])]))),
        ("can have (%d+) fewer traps placed at a time", Func(|a| Some(vec![mk_mod("ActiveTrapLimit", "BASE", num(-a.n(1)), vec![])]))),
        ("can have up to (%d+) additional remote mines? placed at a time", Func(|a| Some(vec![mk_mod("ActiveMineLimit", "BASE", num(a.n(1)), vec![])]))),
        // Additional trap & mine throw
        ("throw an additional trap", Mods(vec![mk_mod("TrapThrowCount", "BASE", num(1.0), vec![])])),
        ("(%d+)%% chance to throw up to (%d+) additional traps?", Func(|a| Some(vec![mk_mod("TrapThrowCount", "BASE", num(a.n(2) * a.n(1) / 100.0), vec![])]))),
        ("throw an additional mine", Mods(vec![mk_mod("MineThrowCount", "BASE", num(1.0), vec![])])),
        ("(%d+)%% chance to throw up to (%d+) additional mines?", Func(|a| Some(vec![mk_mod("MineThrowCount", "BASE", num(a.n(2) * a.n(1) / 100.0), vec![])]))),
        ("(%d+)%% chance to throw up to (%d+) additional traps? or mines?", Func(|a| Some(vec![
            mk_mod("TrapThrowCount", "BASE", num(a.n(2) * a.n(1) / 100.0), vec![]),
            mk_mod("MineThrowCount", "BASE", num(a.n(2) * a.n(1) / 100.0), vec![]),
        ]))),
        ("skills which throw traps throw up to (%d+) additional traps?", Func(|a| Some(vec![mk_mod("TrapThrowCount", "BASE", num(a.n(1)), vec![])]))),
        // Totems
        ("can have up to (%d+) additional totems? summoned at a time", Func(|a| Some(vec![mk_mod("ActiveTotemLimit", "BASE", num(a.n(1)), vec![])]))),
        ("attack skills can have (%d+) additional totems? summoned at a time", Func(|a| Some(vec![mk_mod("ActiveTotemLimit", "BASE", num(a.n(1)), vec![kw(kf::Attack)])]))),
        ("can [hs][au][vm][em]o?n? 1 additional siege ballista totem per (%d+) dexterity", Func(|a| Some(vec![
            mk_mod("ActiveBallistaLimit", "BASE", num(1.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Siege Ballista")), ("includeTransfigured", b(true))])),
                tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(1)))])),
            ]),
        ]))),
        ("totems fire (%d+) additional projectiles", Func(|a| Some(vec![mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![kw(kf::Totem)])]))),
        ("([%d%.]+)%% of damage dealt by y?o?u?r? ?totems is leeched to you as life", Func(|a| Some(vec![mk_mod("DamageLifeLeechToPlayer", "BASE", num(a.n(1)), vec![kw(kf::Totem)])]))),
        ("([%d%.]+)%% of damage dealt by y?o?u?r? ?mines is leeched to you as life", Func(|a| Some(vec![mk_mod("DamageLifeLeechToPlayer", "BASE", num(a.n(1)), vec![kw(kf::Mine)])]))),
        ("you can cast an additional brand", Mods(vec![mk_mod("ActiveBrandLimit", "BASE", num(1.0), vec![])])),
        ("you can cast (%d+) additional brands", Func(|a| Some(vec![mk_mod("ActiveBrandLimit", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% increased damage while you are wielding a bow and have a totem", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HaveTotem"))])), tg(stag("Condition", vec![("var", s("UsingBow"))]))]),
        ]))),
        ("each totem applies (%d+)%% increased damage taken to enemies near it", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("TotemsSummoned"))]))]), vec![]),
        ]))),
        ("totems gain %+(%d+)%% to (%w+) resistance", Func(|a| Some(vec![mk_mod(format!("Totem{}Resist", first_upper(a.s(2))), "BASE", num(a.n(1)), vec![])]))),
        ("totems gain %+(%d+)%% to all elemental resistances", Func(|a| Some(vec![mk_mod("TotemElementalResist", "BASE", num(a.n(1)), vec![])]))),
        ("rejuvenation totem also grants mana regeneration equal to 15%% of its life regeneration", Mods(vec![flag_mod("Condition:RejuvenationTotemManaRegen", vec![])])),
        // Minions
        ("your strength is added to your minions", Mods(vec![mk_mod("StrengthAddedToMinions", "BASE", num(100.0), vec![])])),
        ("half of your strength is added to your minions", Mods(vec![mk_mod("StrengthAddedToMinions", "BASE", num(50.0), vec![])])),
        ("minions gain added resistances equal to (%d+)%% of your resistances", Func(|a| Some(vec![mk_mod("ResistanceAddedToMinions", "BASE", num(a.n(1)), vec![])]))),
        ("minions' accuracy rating is equal to yours", Mods(vec![flag_mod("MinionAccuracyEqualsAccuracy", vec![])])),
        ("minions poison enemies on hit", Mods(vec![wrap("MinionModifier", mk_mod("PoisonChance", "BASE", num(100.0), vec![]), vec![])])),
        ("minions have (%d+)%% chance to poison enemies on hit", Func(|a| Some(vec![wrap("MinionModifier", mk_mod("PoisonChance", "BASE", num(a.n(1)), vec![]), vec![])]))),
        ("(%d+)%% increased minion damage if you have hit recently", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("HitRecently"))]))]),
        ]))),
        ("(%d+)%% increased minion damage if you've used a minion skill recently", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("UsedMinionSkillRecently"))]))]),
        ]))),
        ("minions deal (%d+)%% increased damage if you have warcried recently", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("UsedWarcryRecently"))]))]), vec![]),
        ]))),
        ("minions deal (%d+)%% increased damage if you've used a minion skill recently", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("UsedMinionSkillRecently"))]))]),
        ]))),
        ("minions deal (%d+)%% more damage while they are on low life", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "MORE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("LowLife"))]))]), vec![]),
        ]))),
        ("minions have (%d+)%% increased attack and cast speed if you or your minions have killed recently", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Speed", "INC", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("varList", list(vec![s("KilledRecently"), s("MinionsKilledRecently")]))]))]),
        ]))),
        ("(%d+)%% increased minion attack speed per (%d+) dexterity", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Attack)]), vec![tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(2)))]))]),
        ]))),
        ("(%d+)%% increased minion movement speed per (%d+) dexterity", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![]), vec![tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(2)))]))]),
        ]))),
        ("minions deal (%d+)%% increased damage per (%d+) dexterity", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![]), vec![tg(stag("PerStat", vec![("stat", s("Dex")), ("div", num(a.n(2)))]))]),
        ]))),
        ("minions have (%d+)%% chance to deal double damage while they are on full life", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("DoubleDamageChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("FullLife"))]))]), vec![]),
        ]))),
        ("minions have (%d+)%% chance to deal double damage per fortification on you", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("DoubleDamageChance", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("FortificationStacks")), ("actor", s("parent"))]))]), vec![]),
        ]))),
        ("(%d+)%% increased golem damage for each type of golem you have summoned", Func(|a| Some(
            ["HavePhysicalGolem", "HaveLightningGolem", "HaveColdGolem", "HaveFireGolem", "HaveChaosGolem", "HaveCarrionGolem"].iter().map(|v| {
                wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s(*v))]))]),
                    vec![tg(stag("SkillType", vec![("skillType", num(51.0))]))]) // SkillType.Golem
            }).collect()
        ))),
        ("can summon up to (%d) additional golems? at a time", Func(|a| Some(vec![mk_mod("ActiveGolemLimit", "BASE", num(a.n(1)), vec![])]))),
        ("%+(%d) to maximum number of sentinels of purity", Func(|a| Some(vec![mk_mod("ActiveSentinelOfPurityLimit", "BASE", num(a.n(1)), vec![])]))),
        ("if you have 3 primordial jewels, can summon up to (%d) additional golems? at a time", Func(|a| Some(vec![
            mk_mod("ActiveGolemLimit", "BASE", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s("PrimordialItem")), ("threshold", num(3.0))]))]),
        ]))),
        ("golems regenerate (%d)%% of their maximum life per second", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillType", vec![("skillType", num(51.0))]))]), // SkillType.Golem
        ]))),
        ("summoned golems regenerate (%d)%% of their life per second", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillType", vec![("skillType", num(51.0))]))]), // SkillType.Golem
        ]))),
        ("summoned carrion golems impale on hit if you have the same number of them as summoned chaos golems", Mods(vec![
            wrap("MinionModifier", mk_mod("ImpaleChance", "BASE", num(100.0), vec![
                tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("CarrionEqualChaosGolem"))])),
                tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("HaveChaosGolem"))])),
            ]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Carrion Golem")), ("includeTransfigured", b(true))]))]),
        ])),
        ("summoned chaos golems impale on hit if you have the same number of them as summoned stone golems", Mods(vec![
            wrap("MinionModifier", mk_mod("ImpaleChance", "BASE", num(100.0), vec![
                tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("ChaosEqualStoneGolem"))])),
                tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("HavePhysicalGolem"))])),
            ]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Chaos Golem")), ("includeTransfigured", b(true))]))]),
        ])),
        ("summoned stone golems impale on hit if you have the same number of them as summoned carrion golems", Mods(vec![
            wrap("MinionModifier", mk_mod("ImpaleChance", "BASE", num(100.0), vec![
                tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("StoneEqualCarrionGolem"))])),
                tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("HaveCarrionGolem"))])),
            ]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Stone Golem")), ("includeTransfigured", b(true))]))]),
        ])),
        ("maximum life of summoned elemental golems is doubled", Mods(vec![
            wrap("MinionModifier", mk_mod("Life", "MORE", num(100.0), vec![]), vec![
                tg(stag("SkillType", vec![("skillType", num(51.0))])), // SkillType.Golem
                tg(stag("SkillType", vec![("skillTypeList", list(vec![num(31.0), num(30.0), num(29.0)]))])), // Lightning, Cold, Fire
            ]),
        ])),
        ("golems summoned in the past 8 seconds deal (%d+)%% increased damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("SummonedGolemInPast8Sec"))]))]),
                vec![tg(stag("SkillType", vec![("skillType", num(51.0))]))]), // SkillType.Golem
        ]))),
        ("raised zombies and spectres gain adrenaline for 8 seconds when raised", Mods(vec![
            wrap("MinionModifier", flag_mod("Condition:Adrenaline", vec![]), vec![
                tg(stag("Condition", vec![("var", s("SummonedSpectreInPast8Sec"))])),
                tg(stag("SkillName", vec![("skillName", s("Raise Spectre")), ("includeTransfigured", b(true))])),
            ]),
            wrap("MinionModifier", flag_mod("Condition:Adrenaline", vec![]), vec![
                tg(stag("Condition", vec![("var", s("SummonedZombieInPast8Sec"))])),
                tg(stag("SkillName", vec![("skillName", s("Raise Zombie")), ("includeTransfigured", b(true))])),
            ]),
        ])),
        ("raised spectres fire (%d+) additional projectiles", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Raise Spectre")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("gain onslaught for 10 seconds when you cast socketed golem skill", Func(|_a| Some(vec![
            flag_mod("Condition:Onslaught", vec![tg(stag("Condition", vec![("var", s("SummonedGolemInPast10Sec"))]))]),
        ]))),
        ("s?u?m?m?o?n?e?d? ?raging spirits' hits always ignite", Mods(vec![
            wrap("MinionModifier", mk_mod("EnemyIgniteChance", "BASE", num(100.0), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Raging Spirit")), ("includeTransfigured", b(true))]))]),
        ])),
        ("raised zombies have avatar of fire", Mods(vec![
            wrap("MinionModifier", mk_mod("Keystone", "LIST", s("Avatar of Fire"), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Raise Zombie")), ("includeTransfigured", b(true))]))]),
        ])),
        ("raised zombies take ([%d%.]+)%% of their maximum life per second as fire damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("FireDegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))]),
                vec![tg(stag("SkillName", vec![("skillName", s("Raise Zombie")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("maximum number of summoned raging spirits is (%d+)", Func(|a| Some(vec![mk_mod("ActiveRagingSpiritLimit", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("maximum number of summoned phantasms is (%d+)", Func(|a| Some(vec![mk_mod("ActivePhantasmLimit", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("summoned raging spirits have diamond shrine and massive shrine buffs", Mods(vec![
            wrap("MinionModifier", flag_mod("Condition:DiamondShrine", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Raging Spirit")), ("includeTransfigured", b(true))]))]),
            wrap("MinionModifier", flag_mod("Condition:MassiveShrine", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Raging Spirit")), ("includeTransfigured", b(true))]))]),
        ])),
        ("summoned phantasms have diamond shrine and massive shrine buffs", Mods(vec![
            wrap("MinionModifier", flag_mod("Condition:DiamondShrine", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Phantasm"))]))]),
            wrap("MinionModifier", flag_mod("Condition:MassiveShrine", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Phantasm"))]))]),
        ])),
        ("minions deal no non%-(%a+) damage", Func(|a| deal_no_non_damage_type(a.s(1), true))),
        ("minions convert (%d+)%% of (.+) damage to (.+) damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("summoned skeletons have avatar of fire", Mods(vec![
            wrap("MinionModifier", mk_mod("Keystone", "LIST", s("Avatar of Fire"), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Skeletons")), ("includeTransfigured", b(true))]))]),
        ])),
        ("summoned skeletons take ([%d%.]+)%% of their maximum life per second as fire damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("FireDegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))]),
                vec![tg(stag("SkillName", vec![("skillName", s("Summon Skeletons")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("summoned skeletons have (%d+)%% chance to wither enemies for (%d+) seconds on hit", Mods(vec![
            wrap("ExtraSkillMod", flag_mod("Condition:CanWither", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Skeletons")), ("includeTransfigured", b(true))]))]),
        ])),
        ("summoned skeletons have (%d+)%% of physical damage converted to chaos damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("PhysicalDamageConvertToChaos", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Skeletons")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("summoned skeletons gain added chaos damage equal to (%d+)%% of maximum energy shield on your equipped shield", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("ChaosMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShieldOnWeapon 2")), ("actor", s("parent")), ("percent", num(a.n(1)))]))]), vec![]),
            wrap("MinionModifier", mk_mod("ChaosMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShieldOnWeapon 2")), ("actor", s("parent")), ("percent", num(a.n(1)))]))]), vec![]),
        ]))),
        ("skeletons gain added chaos damage equal to (%d+)%% of maximum energy shield on your equipped shield", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("ChaosMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShieldOnWeapon 2")), ("actor", s("parent")), ("percent", num(a.n(1)))]))]), vec![]),
            wrap("MinionModifier", mk_mod("ChaosMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShieldOnWeapon 2")), ("actor", s("parent")), ("percent", num(a.n(1)))]))]), vec![]),
        ]))),
    ]
}

fn part3() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("minions convert (%d+)%% of (.+) damage to (.+) damage per (.+) socket", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![]),
                vec![tg(stag("Multiplier", vec![("var", s(format!("{}SocketIn{{SlotName}}", first_upper(a.s(4)))))]))]),
        ]))),
        ("minions convert (%d+)%% of (.+) damage to (.+) damage per socketed (%a+) gem", Func(|a| {
            let colour = a.s(4);
            if colour != "red" && colour != "green" && colour != "blue" {
                return None;
            }
            let var = format!("Socketed{}GemsIn{{SlotName}}", first_upper(colour));
            Some(vec![
                wrap("MinionModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![]),
                    vec![tg(stag("Multiplier", vec![("var", s(var))]))]),
            ])
        })),
        ("minions have a (%d+)%% chance to impale on hit with attacks", Func(|a| Some(vec![wrap("MinionModifier", mk_mod("ImpaleChance", "BASE", num(a.n(1)), vec![]), vec![])]))),
        ("minions have (%d+)%% chance to impale on attack hit per socketed ghastly eye jewel", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("ImpaleChance", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Multiplier", vec![("var", s("GhastlyEyeJewelIn{SlotName}"))]))]),
        ]))),
        ("minions from herald skills deal (%d+)%% more damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "MORE", num(a.n(1)), vec![]), vec![tg(stag("SkillType", vec![("skillType", num(52.0))]))]), // SkillType.Herald
        ]))),
        ("minions have (%d+)%% increased movement speed for each herald affecting you", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("MovementSpeed", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("Herald")), ("actor", s("parent"))]))]), vec![]),
        ]))),
        ("minions deal (%d+)%% increased damage while you are affected by a herald", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("AffectedByHerald"))]))]), vec![]),
        ]))),
        ("minions have (%d+)%% increased attack and cast speed while you are affected by a herald", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Speed", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("AffectedByHerald"))]))]), vec![]),
        ]))),
        ("minions have unholy might", Mods(vec![
            wrap("MinionModifier", flag_mod("Condition:UnholyMight", vec![]), vec![]),
            wrap("MinionModifier", flag_mod("Condition:CanWither", vec![]), vec![]),
        ])),
        ("summoned skeleton warriors a?n?d? ?s?o?l?d?i?e?r?s? ?deal triple damage with this weapon if you've hit with this weapon recently", Mods(vec![
            wrap("MinionModifier", mk_mod("TripleDamageChance", "BASE", num(100.0), vec![tg(stag("ActorCondition", vec![("actor", s("parent")), ("var", s("HitRecentlyWithWeapon"))]))]), vec![
                tg(stag("SkillName", vec![("skillName", s("Summon Skeletons"))])),
                tg(stag("ItemCondition", vec![("itemSlot", s("Weapon 1")), ("nameCond", s("The Iron Mass, Gladius"))])),
            ]),
        ])),
        // just make the mod blue, handled in CalcSetup
        ("summoned skeleton warriors a?n?d? ?s?o?l?d?i?e?r?s? ?wield a? ?c?o?p?y? ?o?f? ?this weapon while in your main hand", Mods(vec![])),
        ("each summoned phantasm grants you phantasmal might", Mods(vec![flag_mod("Condition:PhantasmalMight", vec![])])),
        ("minions have (%d+)%% increased critical strike chance per maximum power charge you have", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("CritChance", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("actor", s("parent")), ("var", s("PowerChargeMax"))]))]), vec![]),
        ]))),
        ("minions' base attack critical strike chance is equal to the critical strike chance of your main hand weapon", Mods(vec![
            wrap("MinionModifier", flag_mod("AttackCritIsEqualToParentMainHand", vec![flags(mf::Attack)]), vec![]),
        ])),
        ("non%-spectre minions' base attack time is equal to the attack time of your main hand weapon", Mods(vec![flag_mod("NonSpectreMinionsUseParentMainHandAttackTime", vec![])])),
        ("minions can hear the whispers for 5 seconds after they deal a critical strike", Mods(vec![
            wrap("ExtraSkillMod", mk_mod("Speed", "INC", num(50.0), vec![
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
                tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))])),
            ]), vec![]),
            wrap("ExtraSkillMod", mk_mod("Damage", "INC", num(50.0), vec![
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
                tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))])),
            ]), vec![]),
            wrap("ExtraSkillMod", mk_mod("ChaosDegen", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(20.0))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
                tg(stag("Condition", vec![("neg", b(true)), ("var", s("NeverCrit"))])),
            ]), vec![]),
        ])),
        ("chaos damage t?a?k?e?n? ?does not bypass minions' energy shield", Mods(vec![wrap("MinionModifier", flag_mod("ChaosNotBypassEnergyShield", vec![]), vec![])])),
        ("while minions have energy shield, their hits ignore monster elemental resistances", Mods(vec![
            wrap("MinionModifier", flag_mod("IgnoreElementalResistances", vec![tg(stag("StatThreshold", vec![("stat", s("EnergyShield")), ("threshold", num(1.0))]))]), vec![]),
        ])),
        ("summoned arbalists' projectiles pierce (%d+) additional targets", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("PierceCount", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
        ]))),
        ("summoned arbalists' projectiles fork", Mods(vec![
            wrap("MinionModifier", flag_mod("ForkOnce", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
            wrap("MinionModifier", mk_mod("ForkCountMax", "BASE", num(1.0), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
        ])),
        ("summoned arbalists' projectiles chain %+(%d+) times", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
        ]))),
        ("summoned arbalists have (%d+)%% chance to inflict (.+) exposure on hit", Func(|a| Some(vec![
            mk_mod(format!("{}ExposureChance", first_upper(a.s(2))), "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
        ]))),
        ("summoned arbalists convert (%d+)%% of (.+) damage to (.+) damage", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod(format!("{}DamageConvertTo{}", first_upper(a.s(2)), first_upper(a.s(3))), "BASE", num(a.n(1)), vec![]),
                vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
        ]))),
        ("summoned arbalists have (%d+)%% chance to freeze, shock, and ignite", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("EnemyFreezeChance", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
            wrap("MinionModifier", mk_mod("EnemyShockChance", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
            wrap("MinionModifier", mk_mod("EnemyIgniteChance", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Summon Arbalists"))]))]),
        ]))),
        // typo never existed except in some items generated by upstream
        ("skeleton warriors are permanent minions and follow you", Mods(vec![flag_mod("RaisedSkeletonPermanentDuration", vec![tg(stag("SkillName", vec![("skillName", s("Summon Skeletons"))]))])])),
        ("summoned skeleton warriors are permanent and follow you", Mods(vec![flag_mod("RaisedSkeletonPermanentDuration", vec![tg(stag("SkillName", vec![("skillName", s("Summon Skeletons"))]))])])),
        ("your blink and mirror arrow clones use your gloves", Mods(vec![flag_mod("BlinkAndMirrorUseGloves", vec![])])),
        // Projectiles
        ("skills chain %+(%d) times", Func(|a| Some(vec![mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![])]))),
        ("projectiles chain an additional time", Mods(vec![mk_mod("ChainCountMax", "BASE", num(1.0), vec![flags(mf::Projectile)])])),
        ("projectiles chain %+(%d) times", Func(|a| Some(vec![mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![flags(mf::Projectile)])]))),
        ("arrows chain %+(%d) times", Func(|a| Some(vec![mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![kw(kf::Arrow)])]))),
        ("skills chain an additional time while at maximum frenzy charges", Mods(vec![
            mk_mod("ChainCountMax", "BASE", num(1.0), vec![tg(stag("StatThreshold", vec![("stat", s("FrenzyCharges")), ("thresholdStat", s("FrenzyChargesMax"))]))]),
        ])),
        ("attacks chain an additional time when in main hand", Mods(vec![mk_mod("ChainCountMax", "BASE", num(1.0), vec![flags(mf::Attack), tg(stag("SlotNumber", vec![("num", num(1.0))]))])])),
        ("attacks fire an additional projectile when in off hand", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Attack), tg(stag("SlotNumber", vec![("num", num(2.0))]))])])),
        ("projectiles chain %+(%d) times while you have phasing", Func(|a| Some(vec![
            mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("Condition", vec![("var", s("Phasing"))]))]),
        ]))),
        ("projectiles can chain from any number of additional targets in close range", Mods(vec![
            mk_mod("ChainCountMax", "BASE", num(f64::INFINITY), vec![flags(mf::Projectile), tg(stag("Condition", vec![("var", s("AtCloseRange"))]))]),
        ])),
        ("projectiles split towards %+(%d) targets", Func(|a| Some(vec![mk_mod("SplitCount", "BASE", num(a.n(1)), vec![])]))),
        ("adds an additional arrow", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![kw(kf::Arrow)])])),
        ("(%d+) additional arrows", Func(|a| Some(vec![mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow)])]))),
        ("bow attacks fire an additional arrow", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Bow)])])),
        ("bow attacks fire (%d+) additional arrows", Func(|a| Some(vec![mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow)])]))),
        ("bow attacks fire (%d+) additional arrows if you haven't cast dash recently", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow), tg(stag("Condition", vec![("var", s("CastDashRecently")), ("neg", b(true))]))]),
        ]))),
        ("wand attacks fire an additional projectile", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Wand)])])),
        ("skills fire an additional projectile", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![])])),
        ("skills fire an additional projectile if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "BASE", num(1.0), vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(2))))), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("spells [hf][ai][vr]e an additional projectile", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Spell)])])),
        ("spells [hf][ai][vr]e (%d+) additional projectiles", Func(|a| Some(vec![mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![flags(mf::Spell)])]))),
        ("attacks fire an additional projectile", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Attack)])])),
        ("attacks [hf][ai][vr]e (%d+) additional projectiles", Func(|a| Some(vec![mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("attacks [hf][ai][vr]e (%d+) additional projectiles? when in off hand", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![flags(mf::Attack), tg(stag("SlotNumber", vec![("num", num(2.0))]))]),
        ]))),
        ("fire at most 1 projectile", Mods(vec![flag_mod("SingleProjectile", vec![])])),
        ("attacks have an additional projectile when in off hand", Mods(vec![mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Attack), tg(stag("SlotNumber", vec![("num", num(2.0))]))])])),
        ("caustic arrow and scourge arrow fire (%d+)%% more projectiles", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "MORE", num(a.n(1)), vec![tg(stag("SkillName", vec![
                ("skillNameList", list(vec![s("Caustic Arrow"), s("Scourge Arrow")])), ("includeTransfigured", b(true)),
            ]))]),
        ]))),
        ("essence drain and soulrend fire (%d+) additional projectiles", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![
                ("skillNameList", list(vec![s("Essence Drain"), s("Soulrend")])), ("includeTransfigured", b(true)),
            ]))]),
        ]))),
        ("(%d+)%% reduced essence drain and soulrend projectile speed", Func(|a| Some(vec![
            mk_mod("ProjectileSpeed", "INC", num(-a.n(1)), vec![tg(stag("SkillName", vec![
                ("skillNameList", list(vec![s("Essence Drain"), s("Soulrend")])), ("includeTransfigured", b(true)),
            ]))]),
        ]))),
        ("tornado shot fires an additional secondary projectile", Mods(vec![
            mk_mod("tornadoShotSecondaryProjectiles", "BASE", num(1.0), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Tornado Shot")]))]))]),
        ])),
        ("tornado shot fires 2 additional secondary projectiles", Mods(vec![
            mk_mod("tornadoShotSecondaryProjectiles", "BASE", num(2.0), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Tornado Shot")]))]))]),
        ])),
        ("projectiles pierce an additional target", Mods(vec![mk_mod("PierceCount", "BASE", num(1.0), vec![])])),
        ("projectiles pierce (%d+) targets?", Func(|a| Some(vec![mk_mod("PierceCount", "BASE", num(a.n(1)), vec![])]))),
        ("projectiles pierce (%d+) additional targets?", Func(|a| Some(vec![mk_mod("PierceCount", "BASE", num(a.n(1)), vec![])]))),
        ("projectiles pierce (%d+) additional targets while you have phasing", Func(|a| Some(vec![
            mk_mod("PierceCount", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Phasing"))]))]),
        ]))),
        // Lua: mod("PierceCount", "BASE", num, { ..., threshold = tonumber(thresh) }) (line 4585) --
        // `num` used raw (stays a string); `thresh` is tonumber()'d (stays numeric).
        ("projectiles pierce (%d+) additional targets if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("PierceCount", "BASE", s(a.s(1)), vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(3))))), ("threshold", num(a.n(2)))]))]),
        ]))),
        ("projectiles pierce all targets while you have phasing", Mods(vec![flag_mod("PierceAllTargets", vec![tg(stag("Condition", vec![("var", s("Phasing"))]))])])),
        ("projectiles pierce all burning enemies", Mods(vec![flag_mod("PierceAllTargets", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Burning"))]))])])),
        ("arrows pierce an additional target", Mods(vec![mk_mod("PierceCount", "BASE", num(1.0), vec![kw(kf::Arrow)])])),
        ("arrows pierce (%d+) additional targets", Func(|a| Some(vec![mk_mod("PierceCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow)])]))),
        ("arrows pierce one target", Mods(vec![mk_mod("PierceCount", "BASE", num(1.0), vec![kw(kf::Arrow)])])),
        ("arrows pierce (%d+) targets?", Func(|a| Some(vec![mk_mod("PierceCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow)])]))),
        ("always pierce with arrows", Mods(vec![flag_mod("PierceAllTargets", vec![kw(kf::Arrow)])])),
        ("arrows always pierce", Mods(vec![flag_mod("PierceAllTargets", vec![kw(kf::Arrow)])])),
        ("arrows pierce all targets", Mods(vec![flag_mod("PierceAllTargets", vec![kw(kf::Arrow)])])),
        ("arrows that pierce cause bleeding", Mods(vec![
            mk_mod("BleedChance", "BASE", num(100.0), vec![flags(mf::Projectile), kw(kf::Arrow), tg(stag("StatThreshold", vec![("stat", s("PierceCount")), ("threshold", num(1.0))]))]),
        ])),
        ("arrows that pierce have (%d+)%% chance to [ic][na][fu][ls][ie]c?t? bleeding", Func(|a| Some(vec![
            mk_mod("BleedChance", "BASE", num(a.n(1)), vec![flags(mf::Projectile), kw(kf::Arrow), tg(stag("StatThreshold", vec![("stat", s("PierceCount")), ("threshold", num(1.0))]))]),
        ]))),
        ("arrows that pierce deal (%d+)%% increased damage", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Projectile), kw(kf::Arrow), tg(stag("StatThreshold", vec![("stat", s("PierceCount")), ("threshold", num(1.0))]))]),
        ]))),
        ("projectiles gain (%d+)%% of non%-chaos damage as extra chaos damage per chain", Func(|a| Some(vec![
            mk_mod("NonChaosDamageGainAsChaos", "BASE", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("PerStat", vec![("stat", s("Chain"))]))]),
        ]))),
        ("projectiles that have chained gain (%d+)%% of non%-chaos damage as extra chaos damage", Func(|a| Some(vec![
            mk_mod("NonChaosDamageGainAsChaos", "BASE", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("StatThreshold", vec![("stat", s("Chain")), ("threshold", num(1.0))]))]),
        ]))),
        ("left ring slot: projectiles from spells cannot chain", Mods(vec![flag_mod("CannotChain", vec![flags(mf::Spell | mf::Projectile), tg(stag("SlotNumber", vec![("num", num(1.0))]))])])),
        ("left ring slot: projectiles from spells fork", Mods(vec![
            flag_mod("ForkOnce", vec![flags(mf::Spell | mf::Projectile), tg(stag("SlotNumber", vec![("num", num(1.0))]))]),
            mk_mod("ForkCountMax", "BASE", num(1.0), vec![flags(mf::Spell | mf::Projectile), tg(stag("SlotNumber", vec![("num", num(1.0))]))]),
        ])),
        ("right ring slot: projectiles from spells chain %+1 times", Mods(vec![
            mk_mod("ChainCountMax", "BASE", num(1.0), vec![flags(mf::Spell | mf::Projectile), tg(stag("SlotNumber", vec![("num", num(2.0))]))]),
        ])),
        ("right ring slot: projectiles from spells cannot fork", Mods(vec![flag_mod("CannotFork", vec![flags(mf::Spell | mf::Projectile), tg(stag("SlotNumber", vec![("num", num(2.0))]))])])),
        ("projectiles from spells cannot pierce", Mods(vec![flag_mod("CannotPierce", vec![flags(mf::Spell)])])),
        ("projectiles fork", Mods(vec![
            flag_mod("ForkOnce", vec![flags(mf::Projectile)]),
            mk_mod("ForkCountMax", "BASE", num(1.0), vec![flags(mf::Projectile)]),
        ])),
        ("projectiles from attacks fork", Mods(vec![
            flag_mod("ForkOnce", vec![flags(mf::Projectile), tg(stag("SkillType", vec![("skillType", num(41.0))]))]), // SkillType.RangedAttack
            mk_mod("ForkCountMax", "BASE", num(1.0), vec![flags(mf::Projectile), tg(stag("SkillType", vec![("skillType", num(41.0))]))]),
        ])),
        ("projectiles from attacks fork an additional time", Mods(vec![
            flag_mod("ForkTwice", vec![flags(mf::Projectile), tg(stag("SkillType", vec![("skillType", num(41.0))]))]),
            mk_mod("ForkCountMax", "BASE", num(1.0), vec![flags(mf::Projectile), tg(stag("SkillType", vec![("skillType", num(41.0))]))]),
        ])),
        ("projectiles from attacks can fork (%d+) additional times?", Func(|a| Some(vec![
            flag_mod("ForkTwice", vec![flags(mf::Projectile), tg(stag("SkillType", vec![("skillType", num(41.0))]))]),
            mk_mod("ForkCountMax", "BASE", num(a.n(1)), vec![flags(mf::Projectile), tg(stag("SkillType", vec![("skillType", num(41.0))]))]),
        ]))),
        ("(%d+)%% increased critical strike chance with arrows that fork", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![kw(kf::Arrow),
                tg(stag("StatThreshold", vec![("stat", s("ForkRemaining")), ("threshold", num(1.0))])),
                tg(stag("StatThreshold", vec![("stat", s("PierceCount")), ("threshold", num(0.0)), ("upper", b(true))])),
            ]),
        ]))),
        ("arrows that pierce have %+(%d+)%% to critical strike multiplier", Func(|a| Some(vec![
            mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![kw(kf::Arrow), tg(stag("StatThreshold", vec![("stat", s("PierceCount")), ("threshold", num(1.0))]))]),
        ]))),
        ("arrows pierce all targets after forking", Mods(vec![flag_mod("PierceAllTargets", vec![kw(kf::Arrow), tg(stag("StatThreshold", vec![("stat", s("ForkedCount")), ("threshold", num(1.0))]))])])),
        ("modifiers to number of projectiles instead apply to the number of targets projectiles split towards", Mods(vec![
            flag_mod("NoAdditionalProjectiles", vec![]),
            flag_mod("AdditionalProjectilesAddSplitsInstead", vec![]),
        ])),
        ("modifiers to number of projectiles do not apply to fireball and rolling magma", Mods(vec![
            flag_mod("NoAdditionalProjectiles", vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Fireball"), s("Rolling Magma")]))]))]),
        ])),
        ("attack skills fire an additional projectile while wielding a claw or dagger", Mods(vec![
            mk_mod("ProjectileCount", "BASE", num(1.0), vec![flags(mf::Attack), tg(stag("ModFlagOr", vec![("modFlags", num((mf::Claw | mf::Dagger) as f64))]))]),
        ])),
        ("skills fire (%d+) additional projectiles for 4 seconds after you consume a total of 12 steel shards", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Consumed12SteelShardsRecently"))]))]),
        ]))),
        ("bow attacks sacrifice a random damageable minion to fire (%d+) additional arrows?", Func(|a| Some(vec![
            mk_mod("ProjectileCount", "BASE", num(a.n(1)), vec![kw(kf::Arrow),
                tg(stag("Condition", vec![("var", s("SacrificeMinionOnAttack"))])),
                tg(stag("Condition", vec![("var", s("HaveDamageableMinion"))])),
                tg(stag("SkillType", vec![("skillType", num(37.0)), ("neg", b(true))])), // SkillType.Triggered
                tg(stag("SkillType", vec![("skillType", num(26.0)), ("neg", b(true))])), // SkillType.SummonsTotem
            ]),
        ]))),
        ("non%-projectile chaining lightning skills chain %+(%d+) times", Func(|a| Some(vec![
            mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![
                tg(stag("SkillType", vec![("skillType", num(3.0)), ("neg", b(true))])), // SkillType.Projectile
                tg(stag("SkillType", vec![("skillType", num(19.0))])), // SkillType.Chains
                tg(stag("SkillType", vec![("skillType", num(31.0))])), // SkillType.Lightning
            ]),
        ]))),
        ("arrows gain damage as they travel farther, dealing up to (%d+)%% increased damage with hits to targets", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Hit), kw(kf::Arrow), tg(stag("DistanceRamp", vec![("ramp", list(vec![list(vec![num(35.0), num(0.0)]), list(vec![num(70.0), num(1.0)])]))]))]),
        ]))),
        ("arrows gain critical strike chance as they travel farther, up to (%d+)%% increased critical strike chance", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![kw(kf::Arrow), tg(stag("DistanceRamp", vec![("ramp", list(vec![list(vec![num(35.0), num(0.0)]), list(vec![num(70.0), num(1.0)])]))]))]),
        ]))),
        ("projectiles deal (%d+)%% increased damage with hits to targets at the start of their movement, reducing to (%d+)%% as they travel farther", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Hit | mf::Projectile), tg(stag("DistanceRamp", vec![("ramp", list(vec![list(vec![num(35.0), num(1.0)]), list(vec![num(70.0), num(0.0)])]))]))]),
        ]))),
        ("projectiles deal (%d+)%% increased damage with hits and ailments for each time they have chained", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("PerStat", vec![("stat", s("Chain"))])), tg(stag("SkillType", vec![("skillType", num(3.0))]))]), // SkillType.Projectile
        ]))),
        ("projectiles deal (%d+)%% increased damage with hits and ailments for each enemy pierced", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![kw(kf::Hit | kf::Ailment), tg(stag("PerStat", vec![("stat", s("PiercedCount"))])), tg(stag("SkillType", vec![("skillType", num(3.0))]))]),
        ]))),
        ("(%d+)%% increased bonuses gained from equipped (.+)", Func(|a| Some(vec![mk_mod(format!("EffectOfBonusesFrom{}", first_upper(a.s(2))), "INC", num(a.n(1)), vec![])]))),
        ("(%d+)%% reduced bonuses gained from equipped (.+)", Func(|a| Some(vec![mk_mod(format!("EffectOfBonusesFrom{}", first_upper(a.s(2))), "INC", num(-a.n(1)), vec![])]))),
        // Strike Skills
        ("non%-vaal strike skills target (%d+) additional nearby enem[yi]e?s?", Func(|a| Some(vec![
            mk_mod("AdditionalStrikeTarget", "BASE", num(a.n(1)), vec![
                tg(stag("SkillType", vec![("skillType", num(21.0))])), // SkillType.MeleeSingleTarget
                tg(stag("SkillType", vec![("skillType", num(38.0)), ("neg", b(true))])), // SkillType.Vaal
            ]),
        ]))),
        // Leech/Gain on Hit/Kill
        ("cannot leech life", Mods(vec![flag_mod("CannotLeechLife", vec![])])),
        ("cannot leech mana", Mods(vec![flag_mod("CannotLeechMana", vec![])])),
        ("cannot leech when on low life", Mods(vec![
            flag_mod("CannotLeechLife", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))]),
            flag_mod("CannotLeechMana", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))]),
        ])),
        ("cannot leech life from critical strikes", Mods(vec![flag_mod("CannotLeechLife", vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("leech applies instantly on critical strike", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
            mk_mod("InstantEnergyShieldLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
        ])),
        ("gain life and mana from leech instantly on critical strike", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
            mk_mod("InstantEnergyShieldLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
        ])),
        ("leech applies instantly during f?l?a?s?k? ?effect", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            mk_mod("InstantEnergyShieldLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("gain life and mana from leech instantly during f?l?a?s?k? ?effect", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("life and mana leech are instant during f?l?a?s?k? ?effect", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("life leech from critical strikes is instant", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
        ])),
        ("life and mana leech from critical strikes are instant", Mods(vec![
            mk_mod("InstantLifeLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
            mk_mod("InstantManaLeech", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("CriticalStrike"))]))]),
        ])),
        ("with 5 corrupted items equipped: life leech recovers based on your chaos damage instead", Mods(vec![
            flag_mod("LifeLeechBasedOnChaosDamage", vec![tg(stag("MultiplierThreshold", vec![("var", s("CorruptedItem")), ("threshold", num(5.0))]))]),
        ])),
        ("you have vaal pact if you've dealt a critical strike recently", Mods(vec![mk_mod("Keystone", "LIST", s("Vaal Pact"), vec![tg(stag("Condition", vec![("var", s("CritRecently"))]))])])),
        ("you have vaal pact while at maximum endurance charges", Mods(vec![mk_mod("Keystone", "LIST", s("Vaal Pact"), vec![tg(stag("StatThreshold", vec![("stat", s("EnduranceCharges")), ("thresholdStat", s("EnduranceChargesMax"))]))])])),
        ("you have vaal pact while focus?sed", Mods(vec![mk_mod("Keystone", "LIST", s("Vaal Pact"), vec![tg(stag("Condition", vec![("var", s("Focused"))]))])])),
        ("gain (%d+) energy shield for each enemy you hit which is affected by a spider's web", Func(|a| Some(vec![
            mk_mod("EnergyShieldOnHit", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("MultiplierThreshold", vec![("actor", s("enemy")), ("var", s("Spider's WebStack")), ("threshold", num(1.0))]))]),
        ]))),
        ("(%d+)%% chance to gain (%d+) life on hit with attacks", Func(|a| Some(vec![
            mk_mod("LifeOnHit", "BASE", num(a.n(2) * a.n(1) / 100.0), vec![flags(mf::Attack | mf::Hit), tg(stag("Condition", vec![("var", s("AverageResourceGain"))]))]),
            mk_mod("LifeOnHit", "BASE", num(a.n(2)), vec![flags(mf::Attack | mf::Hit), tg(stag("Condition", vec![("var", s("MaxResourceGain"))]))]),
        ]))),
        ("(%d+) life gained for each cursed enemy hit by your attacks", Func(|a| Some(vec![
            mk_mod("LifeOnHit", "BASE", num(a.n(1)), vec![flags(mf::Attack | mf::Hit), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("gain (%d+) life per cursed enemy hit with attacks", Func(|a| Some(vec![
            mk_mod("LifeOnHit", "BASE", num(a.n(1)), vec![flags(mf::Attack | mf::Hit), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
    ]
}

fn part4() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("gain (%d+) life for each ignited enemy hit with attacks", Func(|a| Some(vec![
            mk_mod("LifeOnHit", "BASE", num(a.n(1)), vec![flags(mf::Attack | mf::Hit), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))]))]),
        ]))),
        ("(%d+) mana gained for each cursed enemy hit by your attacks", Func(|a| Some(vec![
            mk_mod("ManaOnHit", "BASE", num(a.n(1)), vec![flags(mf::Attack | mf::Hit), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("gain (%d+) mana per cursed enemy hit with attacks", Func(|a| Some(vec![
            mk_mod("ManaOnHit", "BASE", num(a.n(1)), vec![flags(mf::Attack | mf::Hit), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("gain (%d+) life per blinded enemy hit with this weapon", Func(|a| Some(vec![
            mk_mod("LifeOnHit", "BASE", num(a.n(1)), vec![flags(mf::Hit),
                tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Blinded"))])),
                tg(stag("Condition", vec![("var", s("{Hand}Attack"))])),
            ]),
        ]))),
        ("recover (%d+)%% of life on kill", Func(|a| Some(vec![mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))])]))),
        ("recover (%d+)%% of life on kill for each different type of mastery you have allocated", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("AllocatedMasteryType"))]))]),
        ]))),
        ("recover (%d+)%% of life on killing a poisoned enemy", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("MultiplierThreshold", vec![("actor", s("enemy")), ("var", s("PoisonStack")), ("threshold", num(1.0))]))]),
        ]))),
        ("recover (%d+)%% of life on killing a chilled enemy", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Chilled"))]))]),
        ]))),
        ("recover (%d+)%% of life when you kill a cursed enemy", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("recover (%d+)%% of life per withered debuff on each enemy you kill", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("WitheredStack")), ("actor", s("enemy")), ("limit", num(15.0))]))]),
        ]))),
        ("minions recover (%d+)%% of life on killing a poisoned enemy", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("MultiplierThreshold", vec![("actor", s("enemy")), ("var", s("PoisonStack")), ("threshold", num(1.0))]))]), vec![]),
        ]))),
        ("minions recover (%d+)%% of their life when they block", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("LifeOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))]), vec![]),
        ]))),
        ("recover (%d+)%% of mana when you kill a cursed enemy", Func(|a| Some(vec![
            mk_mod("ManaOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("recover (%d+)%% of energy shield when you kill a cursed enemy", Func(|a| Some(vec![
            mk_mod("EnergyShieldOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("recover (%d+)%% of life on kill if you've spent life recently", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("MultiplierThreshold", vec![("var", s("LifeSpentRecently")), ("threshold", num(1.0))]))]),
        ]))),
        ("(%d+)%% chance to recover all life when you kill an enemy", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("AverageResourceGain"))]))]),
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(100.0))])), tg(stag("Condition", vec![("var", s("MaxResourceGain"))]))]),
        ]))),
        ("lose (%d+)%% of life on kill", Func(|a| Some(vec![mk_mod("LifeOnKill", "BASE", num(-1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))])]))),
        ("%+(%d+) life gained on killing ignited enemies", Func(|a| Some(vec![mk_mod("LifeOnKill", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))]))])]))),
        ("gain (%d+) life per ignited enemy killed", Func(|a| Some(vec![mk_mod("LifeOnKill", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Ignited"))]))])]))),
        ("recover (%d+)%% of mana on kill", Func(|a| Some(vec![mk_mod("ManaOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))]))])]))),
        ("recover (%d+)%% of mana on kill while you have a tincture active", Func(|a| Some(vec![
            mk_mod("ManaOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("UsingTincture"))]))]),
        ]))),
        ("recover (%d+)%% of mana on kill for each different type of mastery you have allocated", Func(|a| Some(vec![
            mk_mod("ManaOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("AllocatedMasteryType"))]))]),
        ]))),
        ("lose (%d+)%% of mana on kill", Func(|a| Some(vec![mk_mod("ManaOnKill", "BASE", num(-1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))]))])]))),
        ("%+(%d+) mana gained on killing a frozen enemy", Func(|a| Some(vec![mk_mod("ManaOnKill", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Frozen"))]))])]))),
        ("recover (%d+)%% of energy shield on kill", Func(|a| Some(vec![mk_mod("EnergyShieldOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))]))])]))),
        ("recover (%d+)%% of energy shield on kill for each different type of mastery you have allocated", Func(|a| Some(vec![
            mk_mod("EnergyShieldOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("AllocatedMasteryType"))]))]),
        ]))),
        ("lose (%d+)%% of energy shield on kill", Func(|a| Some(vec![mk_mod("EnergyShieldOnKill", "BASE", num(-1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))]))])]))),
        ("%+(%d+) energy shield gained on killing a shocked enemy", Func(|a| Some(vec![mk_mod("EnergyShieldOnKill", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Shocked"))]))])]))),
        ("%+(%d+) energy shield gained on kill per level", Func(|a| Some(vec![mk_mod("EnergyShieldOnKill", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("Level"))]))])]))),
        // Defences
        ("chaos damage t?a?k?e?n? ?does not bypass energy shield", Mods(vec![flag_mod("ChaosNotBypassEnergyShield", vec![])])),
        ("(%d+)%% of chaos damage t?a?k?e?n? ?does not bypass energy shield", Func(|a| Some(vec![mk_mod("ChaosEnergyShieldBypass", "BASE", num(-a.n(1)), vec![])]))),
        ("chaos damage t?a?k?e?n? ?does not bypass energy shield while not on low life", Mods(vec![
            flag_mod("ChaosNotBypassEnergyShield", vec![tg(stag("Condition", vec![("varList", list(vec![s("LowLife")])), ("neg", b(true))]))]),
        ])),
        ("chaos damage t?a?k?e?n? ?does not bypass energy shield while not on low life or low mana", Mods(vec![
            flag_mod("ChaosNotBypassEnergyShield", vec![tg(stag("Condition", vec![("varList", list(vec![s("LowLife"), s("LowMana")])), ("neg", b(true))]))]),
        ])),
        ("chaos damage t?a?k?e?n? ?does not bypass energy shield while not on low mana", Mods(vec![
            flag_mod("ChaosNotBypassEnergyShield", vec![tg(stag("Condition", vec![("varList", list(vec![s("LowMana")])), ("neg", b(true))]))]),
        ])),
        ("chaos damage is taken from mana before life", Mods(vec![mk_mod("ChaosDamageTakenFromManaBeforeLife", "BASE", num(100.0), vec![])])),
        ("(%d+)%% of physical damage is taken from mana before life", Func(|a| Some(vec![mk_mod("PhysicalDamageTakenFromManaBeforeLife", "BASE", num(a.n(1)), vec![])]))),
        ("minions take (%d+)%% increased damage", Func(|a| Some(vec![wrap("MinionModifier", mk_mod("DamageTaken", "INC", num(a.n(1)), vec![]), vec![])]))),
        ("minions take (%d+)%% reduced damage", Func(|a| Some(vec![wrap("MinionModifier", mk_mod("DamageTaken", "INC", num(-a.n(1)), vec![]), vec![])]))),
        ("you and your minions take (%d+)%% reduced reflected (%w+) damage", Func(|a| Some(vec![
            mk_mod(format!("{}ReflectedDamageTaken", first_upper(a.s(2))), "INC", num(-a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]),
            wrap("MinionModifier", mk_mod(format!("{}ReflectedDamageTaken", first_upper(a.s(2))), "INC", num(-a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]), vec![]),
        ]))),
        ("(%d+)%% reduced reflected damage taken during effect", Func(|a| Some(vec![
            mk_mod("ReflectedDamageTaken", "INC", num(-a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]),
        ]))),
        ("you and your minions take (%d+)%% reduced reflected damage", Func(|a| Some(vec![
            mk_mod("ReflectedDamageTaken", "INC", num(-a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]),
            wrap("MinionModifier", mk_mod("ReflectedDamageTaken", "INC", num(-a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]), vec![]),
        ]))),
        ("damage cannot be reflected", Mods(vec![mk_mod("ReflectedDamageTaken", "MORE", num(-100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("immune to reflected damage", Mods(vec![mk_mod("ReflectedDamageTaken", "MORE", num(-100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("cannot take reflected (%a+) damage if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod(format!("{}ReflectedDamageTaken", first_upper(a.s(1))), "MORE", num(-100.0), vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(3))))), ("threshold", num(a.n(2)))]))]),
        ]))),
        ("you have mind over matter while at maximum power charges", Mods(vec![mk_mod("Keystone", "LIST", s("Mind Over Matter"), vec![tg(stag("StatThreshold", vec![("stat", s("PowerCharges")), ("thresholdStat", s("PowerChargesMax"))]))])])),
        ("cannot evade enemy attacks", Mods(vec![flag_mod("CannotEvade", vec![])])),
        ("attacks cannot hit you", Mods(vec![flag_mod("AlwaysEvade", vec![])])),
        ("attacks against you always hit", Mods(vec![flag_mod("CannotEvade", vec![])])),
        ("cannot block", Mods(vec![flag_mod("CannotBlockAttacks", vec![]), flag_mod("CannotBlockSpells", vec![])])),
        ("cannot block while you have no energy shield", Mods(vec![
            flag_mod("CannotBlockAttacks", vec![tg(stag("Condition", vec![("var", s("HaveEnergyShield")), ("neg", b(true))]))]),
            flag_mod("CannotBlockSpells", vec![tg(stag("Condition", vec![("var", s("HaveEnergyShield")), ("neg", b(true))]))]),
        ])),
        ("cannot block attacks", Mods(vec![flag_mod("CannotBlockAttacks", vec![])])),
        ("cannot block attack damage", Mods(vec![flag_mod("CannotBlockAttacks", vec![])])),
        ("cannot block spells", Mods(vec![flag_mod("CannotBlockSpells", vec![])])),
        ("cannot block spell damage", Mods(vec![flag_mod("CannotBlockSpells", vec![])])),
        ("monsters cannot block your attacks", Mods(vec![wrap("EnemyModifier", flag_mod("CannotBlockAttacks", vec![]), vec![])])),
        ("damage t?a?k?e?n? from blocked hits cannot bypass energy shield", Mods(vec![flag_mod("BlockedDamageDoesntBypassES", vec![tg(stag("Condition", vec![("var", s("EVBypass")), ("neg", b(true))]))])])),
        ("damage t?a?k?e?n? from unblocked hits always bypasses energy shield", Mods(vec![flag_mod("UnblockedDamageDoesBypassES", vec![tg(stag("Condition", vec![("var", s("EVBypass")), ("neg", b(true))]))])])),
        ("recover (%d+) life when you block", Func(|a| Some(vec![mk_mod("LifeOnBlock", "BASE", num(a.n(1)), vec![])]))),
        ("recover (%d+) energy shield when you block spell damage", Func(|a| Some(vec![mk_mod("EnergyShieldOnSpellBlock", "BASE", num(a.n(1)), vec![])]))),
        ("recover (%d+) energy shield when you suppress spell damage", Func(|a| Some(vec![mk_mod("EnergyShieldOnSuppress", "BASE", num(a.n(1)), vec![])]))),
        ("recover (%d+) life when you suppress spell damage", Func(|a| Some(vec![mk_mod("LifeOnSuppress", "BASE", num(a.n(1)), vec![])]))),
        ("recover (%d+)%% of life when you block", Func(|a| Some(vec![mk_mod("LifeOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))])]))),
        ("recover (%d+)%% of life when you block attack damage while wielding a staff", Func(|a| Some(vec![
            mk_mod("LifeOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("UsingStaff"))]))]),
        ]))),
        ("recover (%d+)%% of your maximum mana when you block", Func(|a| Some(vec![mk_mod("ManaOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))]))])]))),
        ("recover (%d+)%% of energy shield when you block", Func(|a| Some(vec![mk_mod("EnergyShieldOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))]))])]))),
        ("recover (%d+)%% of energy shield when you block spell damage while wielding a staff", Func(|a| Some(vec![
            mk_mod("EnergyShieldOnSpellBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("UsingStaff"))]))]),
        ]))),
        ("replenishes energy shield by (%d+)%% of armour when you block", Func(|a| Some(vec![mk_mod("EnergyShieldOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Armour")), ("percent", num(a.n(1)))]))])]))),
        ("recover energy shield equal to (%d+)%% of armour when you block", Func(|a| Some(vec![mk_mod("EnergyShieldOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Armour")), ("percent", num(a.n(1)))]))])]))),
        ("recover energy shield equal to (%d+)%% of evasion rating when you block", Func(|a| Some(vec![mk_mod("EnergyShieldOnBlock", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Evasion")), ("percent", num(a.n(1)))]))])]))),
        ("(%d+)%% of damage taken while affected by clarity recouped as mana", Func(|a| Some(vec![mk_mod("ManaRecoup", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByClarity"))]))])]))),
        ("(%d+)%% of damage taken while frozen recouped as life", Func(|a| Some(vec![mk_mod("LifeRecoup", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Frozen"))]))])]))),
        ("recoup effects instead occur over 3 seconds", Mods(vec![flag_mod("3SecondRecoup", vec![])])),
        ("life recoup effects instead occur over 3 seconds", Mods(vec![flag_mod("3SecondLifeRecoup", vec![])])),
        ("recoup energy shield instead of life", Mods(vec![flag_mod("EnergyShieldRecoupInsteadOfLife", vec![])])),
        ("life recoup also recovers mana", Mods(vec![flag_mod("AddLifeRecoupToManaRecoup", vec![])])),
        ("damage taken recouped as (%a+) is also recouped as energy shield", Func(|a| Some(vec![flag_mod(format!("Add{}RecoupToEnergyShieldRecoup", first_upper(a.s(1))), vec![])]))),
        ("([%d%.]+)%% of physical damage prevented from hits in the past (%d+) seconds is regenerated as life per second", Func(|a| Some(vec![
            mk_mod("PhysicalDamageMitigatedLifePseudoRecoup", "BASE", num(a.n(1) * a.n(2)), vec![]),
            mk_mod("PhysicalDamageMitigatedLifePseudoRecoupDuration", "BASE", s(a.s(2).to_string()), vec![]),
        ]))),
        ("([%d%.]+)%% of physical damage prevented from hits recently is regenerated as energy shield per second", Func(|a| Some(vec![
            mk_mod("PhysicalDamageMitigatedEnergyShieldPseudoRecoup", "BASE", num(a.n(1) * 4.0), vec![]),
        ]))),
        ("([%d%.]+)%% of physical damage prevented recently is regenerated as energy shield per second if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("PhysicalDamageMitigatedEnergyShieldPseudoRecoup", "BASE", num(a.n(1) * 4.0), vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(3))))), ("threshold", num(a.n(2)))]))]),
        ]))),
        ("cannot leech or regenerate mana", Mods(vec![flag_mod("NoManaRegen", vec![]), flag_mod("CannotLeechMana", vec![])])),
        ("right ring slot: you cannot regenerate mana", Mods(vec![flag_mod("NoManaRegen", vec![tg(stag("SlotNumber", vec![("num", num(2.0))]))])])),
        ("y?o?u? ?cannot recharge energy shield", Mods(vec![flag_mod("NoEnergyShieldRecharge", vec![])])),
        ("you cannot regenerate energy shield", Mods(vec![flag_mod("NoEnergyShieldRegen", vec![])])),
        ("cannot recharge or regenerate energy shield", Mods(vec![flag_mod("NoEnergyShieldRecharge", vec![]), flag_mod("NoEnergyShieldRegen", vec![])])),
        ("left ring slot: you cannot recharge or regenerate energy shield", Mods(vec![
            flag_mod("NoEnergyShieldRecharge", vec![tg(stag("SlotNumber", vec![("num", num(1.0))]))]),
            flag_mod("NoEnergyShieldRegen", vec![tg(stag("SlotNumber", vec![("num", num(1.0))]))]),
        ])),
        ("cannot gain energy shield", Mods(vec![flag_mod("CannotGainEnergyShield", vec![])])),
        ("cannot gain life", Mods(vec![flag_mod("CannotGainLife", vec![])])),
        ("cannot gain mana", Mods(vec![flag_mod("CannotGainMana", vec![])])),
        ("cannot recover life other than from leech", Mods(vec![flag_mod("CannotRecoverLifeOutsideLeech", vec![]), flag_mod("NoLifeRegen", vec![])])),
        ("cannot gain energy shield during f?l?a?s?k? ?effect", Mods(vec![flag_mod("CannotGainEnergyShield", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("cannot gain life during f?l?a?s?k? ?effect", Mods(vec![flag_mod("CannotGainLife", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("cannot gain mana during f?l?a?s?k? ?effect", Mods(vec![flag_mod("CannotGainMana", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("life that would be lost by taking damage is instead reserved", Mods(vec![flag_mod("DamageInsteadReservesLife", vec![])])),
        ("you have no armour or energy shield", Mods(vec![mk_mod("Armour", "MORE", num(-100.0), vec![]), mk_mod("EnergyShield", "MORE", num(-100.0), vec![])])),
        ("you have no armour or maximum energy shield", Mods(vec![mk_mod("Armour", "MORE", num(-100.0), vec![]), mk_mod("EnergyShield", "MORE", num(-100.0), vec![])])),
        ("defences are zero", Mods(vec![
            mk_mod("Armour", "MORE", num(-100.0), vec![]),
            mk_mod("EnergyShield", "MORE", num(-100.0), vec![]),
            mk_mod("Evasion", "MORE", num(-100.0), vec![]),
            mk_mod("Ward", "MORE", num(-100.0), vec![]),
        ])),
        ("you have no intelligence", Mods(vec![mk_mod("Int", "MORE", num(-100.0), vec![])])),
        ("you have no dexterity", Mods(vec![mk_mod("Dex", "MORE", num(-100.0), vec![])])),
        ("you have no strength", Mods(vec![mk_mod("Str", "MORE", num(-100.0), vec![])])),
        ("physical damage reduction is zero", Mods(vec![mk_mod("PhysicalDamageReduction", "OVERRIDE", num(0.0), vec![]), flag_mod("ArmourDoesNotApplyToPhysicalDamageTaken", vec![])])),
        ("elemental resistances are zero", Mods(vec![
            mk_mod("FireResist", "OVERRIDE", num(0.0), vec![]),
            mk_mod("ColdResist", "OVERRIDE", num(0.0), vec![]),
            mk_mod("LightningResist", "OVERRIDE", num(0.0), vec![]),
        ])),
        ("chaos resistance is zero", Mods(vec![mk_mod("ChaosResist", "OVERRIDE", num(0.0), vec![])])),
        ("nearby enemies' chaos resistance is (%d+)", Func(|a| Some(vec![wrap("EnemyModifier", mk_mod("ChaosResist", "OVERRIDE", num(a.n(1)), vec![]), vec![])]))),
        ("your maximum resistances are (%d+)%%", Func(|a| Some(vec![
            mk_mod("FireResistMax", "OVERRIDE", num(a.n(1)), vec![]),
            mk_mod("ColdResistMax", "OVERRIDE", num(a.n(1)), vec![]),
            mk_mod("LightningResistMax", "OVERRIDE", num(a.n(1)), vec![]),
            mk_mod("ChaosResistMax", "OVERRIDE", num(a.n(1)), vec![]),
        ]))),
        ("fire resistance is (%d+)%%", Func(|a| Some(vec![mk_mod("FireResist", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("cold resistance is (%d+)%%", Func(|a| Some(vec![mk_mod("ColdResist", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("lightning resistance is (%d+)%%", Func(|a| Some(vec![mk_mod("LightningResist", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("elemental resistances are capped by your highest maximum elemental resistance instead", Mods(vec![flag_mod("ElementalResistMaxIsHighestResistMax", vec![])])),
        ("nearby enemies have (%d+)%% increased fire and cold resistances", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("FireResist", "INC", num(a.n(1)), vec![]), vec![]),
            wrap("EnemyModifier", mk_mod("ColdResist", "INC", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("nearby enemies are blinded while physical aegis is not depleted", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Blinded", vec![]), vec![tg(stag("Condition", vec![("var", s("PhysicalAegisDepleted")), ("neg", b(true))]))]),
        ])),
        ("maximum energy shield is increased by chance to block spell damage", Mods(vec![flag_mod("EnergyShieldIncreasedByChanceToBlockSpellDamage", vec![])])),
        ("maximum energy shield is increased by chaos resistance", Mods(vec![flag_mod("EnergyShieldIncreasedByChaosResistance", vec![])])),
        ("armour is increased by uncapped fire resistance", Mods(vec![flag_mod("ArmourIncreasedByUncappedFireRes", vec![])])),
        ("armour is increased by overcapped fire resistance", Mods(vec![flag_mod("ArmourIncreasedByOvercappedFireRes", vec![])])),
        ("minion life is increased by t?h?e?i?r? ?overcapped fire resistance", Mods(vec![
            wrap("MinionModifier", mk_mod("Life", "INC", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("FireResistOverCap")), ("div", num(1.0))]))]), vec![]),
        ])),
        ("totem life is increased by t?h?e?i?r? ?overcapped fire resistance", Mods(vec![
            mk_mod("TotemLife", "INC", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("TotemFireResistOverCap")), ("div", num(1.0))]))]),
        ])),
        ("evasion rating is increased by uncapped cold resistance", Mods(vec![flag_mod("EvasionRatingIncreasedByUncappedColdRes", vec![])])),
        ("evasion rating is increased by overcapped cold resistance", Mods(vec![flag_mod("EvasionRatingIncreasedByOvercappedColdRes", vec![])])),
        ("reflects (%d+) physical damage to melee attackers", Mods(vec![])),
        ("ignore all movement penalties from armour", Mods(vec![flag_mod("Condition:IgnoreMovementPenalties", vec![])])),
        ("gain armour equal to your reserved mana", Mods(vec![mk_mod("Armour", "BASE", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("ManaReserved")), ("div", num(1.0))]))])])),
        ("gain ward instead of (%d+)%% of armour and evasion rating from equipped body armour", Func(|a| Some(vec![
            flag_mod("ConvertBodyArmourArmourEvasionToWard", vec![]),
            mk_mod("BodyArmourArmourEvasionToWardPercent", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("(%d+)%% increased armour per (%d+) reserved mana", Func(|a| Some(vec![
            mk_mod("Armour", "INC", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ManaReserved")), ("div", num(a.n(2)))]))]),
        ]))),
        ("cannot be stunned", Mods(vec![flag_mod("StunImmune", vec![])])),
        ("cannot be stunned while bleeding", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("Bleeding"))]))])])),
        ("cannot be stunned when on low life", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("cannot be stunned if you haven't been hit recently", Mods(vec![flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("BeenHitRecently")), ("neg", b(true))]))])])),
        ("cannot be stunned if you have at least (%d+) crab barriers", Func(|a| Some(vec![
            flag_mod("StunImmune", vec![tg(stag("StatThreshold", vec![("stat", s("CrabBarriers")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("cannot be stunned if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            flag_mod("StunImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(2))))), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("cannot be blinded", Mods(vec![flag_mod("Condition:CannotBeBlinded", vec![]), flag_mod("BlindImmune", vec![])])),
        ("cannot be blinded while affected by precision", Mods(vec![
            flag_mod("Condition:CannotBeBlinded", vec![tg(stag("Condition", vec![("var", s("AffectedByPrecision"))]))]),
            flag_mod("BlindImmune", vec![tg(stag("Condition", vec![("var", s("AffectedByPrecision"))]))]),
        ])),
        ("cannot be knocked back", Mods(vec![flag_mod("KnockbackImmune", vec![])])),
        ("cannot be shocked", Mods(vec![flag_mod("ShockImmune", vec![])])),
        ("immun[ei]t?y? to shock", Mods(vec![flag_mod("ShockImmune", vec![])])),
        ("cannot be frozen", Mods(vec![flag_mod("FreezeImmune", vec![])])),
        ("cannot be frozen if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            flag_mod("FreezeImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(2))))), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("immun[ei]t?y? to freeze", Mods(vec![flag_mod("FreezeImmune", vec![])])),
        ("cannot be chilled", Mods(vec![flag_mod("ChillImmune", vec![])])),
        ("immun[ei]t?y? to chill", Mods(vec![flag_mod("ChillImmune", vec![])])),
        ("cannot be ignited", Mods(vec![flag_mod("IgniteImmune", vec![])])),
        ("immun[ei]t?y? to ignite", Mods(vec![flag_mod("IgniteImmune", vec![])])),
        ("immune to ignite while affected by purity of fire", Mods(vec![flag_mod("IgniteImmune", vec![tg(stag("Condition", vec![("var", s("AffectedByPurityofFire"))]))])])),
        ("immune to freeze while affected by purity of ice", Mods(vec![flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("AffectedByPurityofIce"))]))])])),
        ("immune to shock while affected by purity of lightning", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("AffectedByPurityofLightning"))]))])])),
        ("critical strikes against you do not inherently inflict elemental ailments", Mods(vec![flag_mod("CritsOnYouDontAlwaysApplyElementalAilments", vec![])])),
        ("cannot be ignited while at maximum endurance charges", Mods(vec![
            flag_mod("IgniteImmune", vec![
                tg(stag("StatThreshold", vec![("stat", s("EnduranceCharges")), ("thresholdStat", s("EnduranceChargesMax"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("grants immunity to ignite for (%d+) seconds if used while ignited", Mods(vec![flag_mod("IgniteImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants immunity to bleeding for (%d+) seconds if used while bleeding", Mods(vec![flag_mod("BleedImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants immunity to corrupted blood for (%d+) seconds if used while affected by corrupted blood", Mods(vec![flag_mod("CorruptedBloodImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants immunity to poison for (%d+) seconds if used while poisoned", Mods(vec![flag_mod("PoisonImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants immunity to freeze for (%d+) seconds if used while frozen", Mods(vec![flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants immunity to chill for (%d+) seconds if used while chilled", Mods(vec![flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants immunity to shock for (%d+) seconds if used while shocked", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("cannot be chilled while at maximum frenzy charges", Mods(vec![flag_mod("ChillImmune", vec![tg(stag("StatThreshold", vec![("stat", s("FrenzyCharges")), ("thresholdStat", s("FrenzyChargesMax"))]))])])),
        ("cannot be shocked while at maximum power charges", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("StatThreshold", vec![("stat", s("PowerCharges")), ("thresholdStat", s("PowerChargesMax"))]))])])),
        ("you cannot be shocked while at maximum endurance charges", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("StatThreshold", vec![("stat", s("EnduranceCharges")), ("thresholdStat", s("EnduranceChargesMax"))]))])])),
        ("you cannot be shocked while chilled", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("Chilled"))]))])])),
        ("you cannot be shocked while frozen", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("Frozen"))]))])])),
        ("cannot be shocked while chilled", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("Chilled"))]))])])),
        ("cannot be shocked if intelligence is higher than strength", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("IntHigherThanStr"))]))])])),
        ("cannot be frozen if dexterity is higher than intelligence", Mods(vec![flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("DexHigherThanInt"))]))])])),
        ("cannot be frozen if energy shield recharge has started recently", Mods(vec![flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("EnergyShieldRechargeRecently"))]))])])),
        ("cannot be ignited if strength is higher than dexterity", Mods(vec![flag_mod("IgniteImmune", vec![tg(stag("Condition", vec![("var", s("StrHigherThanDex"))]))])])),
        ("cannot be chilled while burning", Mods(vec![flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("Burning"))]))])])),
        ("cannot be chilled while you have onslaught", Mods(vec![flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("Onslaught"))]))])])),
        ("cannot be chilled during onslaught", Mods(vec![flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("Onslaught"))]))])])),
        ("cannot be frozen or chilled if you've used a fire skill recently", Mods(vec![
            flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("UsedFireSkillRecently"))]))]),
            flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("UsedFireSkillRecently"))]))]),
        ])),
        ("cannot be inflicted with bleeding", Mods(vec![flag_mod("BleedImmune", vec![])])),
        ("bleeding cannot be inflicted on you", Mods(vec![flag_mod("BleedImmune", vec![])])),
        ("you are immune to bleeding", Mods(vec![flag_mod("BleedImmune", vec![])])),
        ("immune to bleeding if equipped helmet has higher armour than evasion rating", Mods(vec![flag_mod("BleedImmune", vec![tg(stag("Condition", vec![("var", s("HelmetArmourHigherThanEvasion"))]))])])),
        ("immune to poison if equipped helmet has higher evasion rating than armour", Mods(vec![flag_mod("PoisonImmune", vec![tg(stag("Condition", vec![("var", s("HelmetEvasionHigherThanArmour"))]))])])),
        ("immun[ei]t?y? to bleeding and corrupted blood during f?l?a?s?k? ?effect", Mods(vec![
            flag_mod("BleedImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("CorruptedBloodImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("immun[ei]t?y? to poison", Mods(vec![flag_mod("PoisonImmune", vec![])])),
        ("cannot be poisoned", Mods(vec![flag_mod("PoisonImmune", vec![])])),
        ("cannot be poisoned while bleeding", Mods(vec![flag_mod("PoisonImmune", vec![tg(stag("Condition", vec![("var", s("Bleeding"))]))])])),
        ("immun[ei]t?y? to poison during f?l?a?s?k? ?effect", Mods(vec![flag_mod("PoisonImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("immun[ei]t?y? to shock during f?l?a?s?k? ?effect", Mods(vec![flag_mod("ShockImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("immun[ei]t?y? to freeze and chill during f?l?a?s?k? ?effect", Mods(vec![
            flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("immun[ei]t?y? to freeze and chill while ignited", Mods(vec![
            flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("Ignited"))]))]),
            flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("Ignited"))]))]),
        ])),
        ("immun[ei]t?y? to ignite during f?l?a?s?k? ?effect", Mods(vec![flag_mod("IgniteImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("immun[ei]t?y? to bleeding during f?l?a?s?k? ?effect", Mods(vec![flag_mod("BleedImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("immun[ei]t?y? to curses during f?l?a?s?k? ?effect", Mods(vec![flag_mod("CurseImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("immun[ei]t?y? to curses while channelling", Mods(vec![flag_mod("CurseImmune", vec![tg(stag("Condition", vec![("var", s("Channelling"))]))])])),
        ("you are unaffected by (.+) if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            mk_mod(format!("Self{}Effect", first_upper(a.s(1))), "MORE", num(-100.0), vec![
                tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(2)))))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ]))),
        ("immun[ei]t?y? to (%a-)s? if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            flag_mod(format!("{}Immune", first_upper(a.s(1))), vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(2)))))]))]),
        ]))),
        // typo / old wording change
        ("when you kill an enemy affected by a non%-aura hex, become immune to curses for remaining hex duration", Mods(vec![flag_mod("Condition:CanBeCurseImmune", vec![])])),
        ("when you kill an enemy cursed with a non%-aura hex, become immune to curses for remaining hex duration", Mods(vec![flag_mod("Condition:CanBeCurseImmune", vec![])])),
        ("immun[ei]t?y? to freeze, chill, curses and stuns during f?l?a?s?k? ?effect", Mods(vec![
            flag_mod("FreezeImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("ChillImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("CurseImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("StunImmune", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        // This mod doesn't work as intended: it prevents self-chill, among other issues.
        // We don't currently model enemy ailment infliction, so this should probably be removed:
        // ["cursed enemies cannot inflict elemental ailments on you"] = mod("AvoidElementalAilments", "BASE", 100, ActorCondition{enemy,Cursed}, GlobalEffect{Global,unscalable}) -- commented out in the Lua source
        ("enemies inflict elemental ailments on you instead of nearby allies", Mods(vec![
            extra_aura(flag_mod("ElementalAilmentImmune", vec![]), true, vec![]),
        ])),
        ("unaffected by curses", Mods(vec![mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("you are immune to curses", Mods(vec![flag_mod("CurseImmune", vec![])])),
        ("unaffected by curses while affected by zealotry", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByZealotry"))])), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]),
        ])),
        ("unaffected by vulnerability while affected by determination", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Vulnerability"))])),
                tg(stag("Condition", vec![("var", s("AffectedByDetermination"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("unaffected by enfeeble while affected by grace", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Enfeeble"))])),
                tg(stag("Condition", vec![("var", s("AffectedByGrace"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("unaffected by temporal chains while affected by haste", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Temporal Chains"))])),
                tg(stag("Condition", vec![("var", s("AffectedByHaste"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("unaffected by elemental weakness while affected by purity of elements", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Elemental Weakness"))])),
                tg(stag("Condition", vec![("var", s("AffectedByPurityofElements"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("unaffected by flammability while affected by purity of fire", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Flammability"))])),
                tg(stag("Condition", vec![("var", s("AffectedByPurityofFire"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("unaffected by frostbite while affected by purity of ice", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Frostbite"))])),
                tg(stag("Condition", vec![("var", s("AffectedByPurityofIce"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
        ("unaffected by conductivity while affected by purity of lightning", Mods(vec![
            mk_mod("CurseEffectOnSelf", "MORE", num(-100.0), vec![
                tg(stag("SkillName", vec![("skillName", s("Conductivity"))])),
                tg(stag("Condition", vec![("var", s("AffectedByPurityofLightning"))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
            ]),
        ])),
    ]
}

fn part5() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("immun[ei]t?y? to curses while you have at least (%d+) rage", Func(|a| Some(vec![
            flag_mod("CurseImmune", vec![tg(stag("MultiplierThreshold", vec![("var", s("Rage")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("you cannot be cursed with silence", Mods(vec![flag_mod("SilenceImmune", vec![])])),
        ("unaffected by ignite", Mods(vec![mk_mod("SelfIgniteEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by chill", Mods(vec![mk_mod("SelfChillEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by chill while leeching mana", Mods(vec![mk_mod("SelfChillEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("LeechingMana"))]))])])),
        ("unaffected by chill while channelling", Mods(vec![mk_mod("SelfChillEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Channelling"))]))])])),
        ("unaffected by freeze", Mods(vec![mk_mod("SelfFreezeEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by shock", Mods(vec![mk_mod("SelfShockEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by shock while leeching energy shield", Mods(vec![mk_mod("SelfShockEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("LeechingEnergyShield"))]))])])),
        ("unaffected by shock while channelling", Mods(vec![mk_mod("SelfShockEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("Channelling"))]))])])),
        ("unaffected by scorch", Mods(vec![mk_mod("SelfScorchEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by brittle", Mods(vec![mk_mod("SelfBrittleEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by sap", Mods(vec![mk_mod("SelfSapEffect", "MORE", num(-100.0), vec![])])),
        ("unaffected by damaging ailments", Mods(vec![
            mk_mod("SelfBleedEffect", "MORE", num(-100.0), vec![]),
            mk_mod("SelfIgniteEffect", "MORE", num(-100.0), vec![]),
            mk_mod("SelfPoisonEffect", "MORE", num(-100.0), vec![]),
        ])),
        ("unaffected by bleeding while affected by malevolence", Mods(vec![
            mk_mod("SelfBleedEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByMalevolence"))])), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]),
        ])),
        ("unaffected by poison while affected by malevolence", Mods(vec![
            mk_mod("SelfPoisonEffect", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("AffectedByMalevolence"))])), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]),
        ])),
        ("unaffected by (.+) if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod(format!("Self{}Effect", first_upper(a.s(1))), "MORE", num(-100.0), vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(3))))), ("threshold", num(a.n(2)))]))]),
        ]))),
        ("the effect of chill on you is reversed", Mods(vec![
            flag_mod("SelfChillEffectIsReversed", vec![]),
            mk_mod("Dummy", "DUMMY", num(1.0), vec![src(""), tg(stag("Condition", vec![("var", s("Chilled"))]))]),
        ])),
        ("your movement speed is (%d+)%% of its base value", Func(|a| Some(vec![mk_mod("MovementSpeed", "OVERRIDE", num(a.n(1) / 100.0), vec![])]))),
        ("action speed cannot be modified to below (%d+)%% base value", Func(|a| Some(vec![mk_mod("MinimumActionSpeed", "MAX", num(a.n(1)), vec![])]))),
        ("action speed cannot be slowed below base value if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(1)))))]))]),
        ]))),
        ("action speed cannot be modified to below base value if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(1)))))]))]),
        ]))),
        ("action speed cannot be modified to below base value while ignited", Mods(vec![mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("Condition", vec![("var", s("Ignited"))]))])])),
        ("nearby allies' action speed cannot be modified to below base value", Mods(vec![
            extra_aura(mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))]), true, vec![]),
        ])),
        ("armour also applies to lightning damage taken from hits", Mods(vec![mk_mod("ArmourAppliesToLightningDamageTaken", "BASE", num(100.0), vec![])])),
        ("lightning resistance does not affect lightning damage taken", Mods(vec![flag_mod("SelfIgnoreLightningResistance", vec![])])),
        ("(%d+)%% increased maximum life and reduced fire resistance", Func(|a| Some(vec![
            mk_mod("Life", "INC", num(a.n(1)), vec![]),
            mk_mod("FireResist", "INC", num(-a.n(1)), vec![]),
        ]))),
        ("(%d+)%% increased maximum mana and reduced cold resistance", Func(|a| Some(vec![
            mk_mod("Mana", "INC", num(a.n(1)), vec![]),
            mk_mod("ColdResist", "INC", num(-a.n(1)), vec![]),
        ]))),
        ("(%d+)%% increased global maximum energy shield and reduced lightning resistance", Func(|a| Some(vec![
            mk_mod("EnergyShield", "INC", num(a.n(1)), vec![tg(stag("Global", vec![]))]),
            mk_mod("LightningResist", "INC", num(-a.n(1)), vec![]),
        ]))),
        ("phasing while on low life", Mods(vec![flag_mod("Condition:Phasing", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("cannot be ignited while on low life", Mods(vec![flag_mod("IgniteImmune", vec![tg(stag("Condition", vec![("var", s("LowLife"))]))])])),
        ("ward does not break during f?l?a?s?k? ?effect", Mods(vec![
            flag_mod("Condition:WardNotBreak", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("Condition:UnbrokenWard", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("stun threshold is based on energy shield instead of life", Mods(vec![
            flag_mod("StunThresholdBasedOnEnergyShieldInsteadOfLife", vec![]),
            mk_mod("StunThresholdEnergyShieldPercent", "BASE", num(100.0), vec![]),
        ])),
        ("stun threshold is based on (%d+)%% of your energy shield instead of life", Func(|a| Some(vec![
            flag_mod("StunThresholdBasedOnEnergyShieldInsteadOfLife", vec![]),
            mk_mod("StunThresholdEnergyShieldPercent", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("stun threshold is based on (%d+)%% of your mana instead of life", Func(|a| Some(vec![
            flag_mod("StunThresholdBasedOnManaInsteadOfLife", vec![]),
            mk_mod("StunThresholdManaPercent", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("(%d+)%% of your energy shield is added to your stun threshold", Func(|a| Some(vec![
            flag_mod("AddESToStunThreshold", vec![]),
            mk_mod("ESToStunThresholdPercent", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("(%d+)%% increased armour per second you've been stationary, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("Armour", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("StationarySeconds")), ("limit", num(a.n(2) / a.n(1)))])), tg(stag("Condition", vec![("var", s("Stationary"))]))]),
        ]))),
        ("(%d+)%% of damage from hits is taken from your r?a?i?s?e?d? ?spectres' life before you", Func(|a| Some(vec![mk_mod("takenFromSpectresBeforeYou", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% of damage from hits is taken from your nearest totem's life before you", Func(|a| Some(vec![
            mk_mod("takenFromTotemsBeforeYou", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HaveTotem"))]))]),
        ]))),
        ("(%d+)%% of damage from hits is taken from void spawns' life before you per void spawn", Func(|a| Some(vec![
            mk_mod("takenFromVoidSpawnBeforeYou", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("ActiveVoidSpawnLimit"))]))]),
        ]))),
        ("(%a+) resistance cannot be penetrated", Func(|a| Some(vec![flag_mod(format!("EnemyCannotPen{}Resistance", first_upper(a.s(1))), vec![])]))),
        // Knockback
        ("cannot knock enemies back", Mods(vec![flag_mod("CannotKnockback", vec![])])),
        ("knocks back enemies if you get a critical strike with a staff", Mods(vec![mk_mod("EnemyKnockbackChance", "BASE", num(100.0), vec![flags(mf::Staff), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("knocks back enemies if you get a critical strike with a bow", Mods(vec![mk_mod("EnemyKnockbackChance", "BASE", num(100.0), vec![flags(mf::Bow), tg(stag("Condition", vec![("var", s("CriticalStrike"))]))])])),
        ("bow knockback at close range", Mods(vec![mk_mod("EnemyKnockbackChance", "BASE", num(100.0), vec![flags(mf::Bow), tg(stag("Condition", vec![("var", s("AtCloseRange"))]))])])),
        ("adds knockback during f?l?a?s?k? ?effect", Mods(vec![mk_mod("EnemyKnockbackChance", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("adds knockback to melee attacks during f?l?a?s?k? ?effect", Mods(vec![mk_mod("EnemyKnockbackChance", "BASE", num(100.0), vec![flags(mf::Melee), tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("knockback direction is reversed", Mods(vec![mk_mod("EnemyKnockbackDistance", "MORE", num(-200.0), vec![])])),
        // Culling
        ("culling strike", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("culling strike with melee weapons", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![flags(mf::WeaponMelee), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("melee weapon attacks have culling strike", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![flags(mf::Attack | mf::WeaponMelee), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("culling strike during f?l?a?s?k? ?effect", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))])), tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("hits with this weapon have culling strike against bleeding enemies", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Bleeding"))]))])])),
        ("you have culling strike against cursed enemies", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))])])),
        ("critical strikes have culling strike", Mods(vec![mk_mod("CriticalCullPercent", "MAX", num(10.0), vec![])])),
        ("your critical strikes have culling strike", Mods(vec![mk_mod("CriticalCullPercent", "MAX", num(10.0), vec![])])),
        ("your spells have culling strike", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![flags(mf::Spell)])])),
        ("bow attacks have culling strike", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![flags(mf::Attack | mf::Bow)])])),
        ("culling strike against burning enemies", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Burning"))]))])])),
        ("culling strike against frozen enemies", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Frozen"))]))])])),
        ("culling strike against marked enemy", Mods(vec![mk_mod("CullPercent", "MAX", num(10.0), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Marked"))]))])])),
        ("nearby allies have culling strike", Mods(vec![extra_aura(mk_mod("CullPercent", "MAX", num(10.0), vec![]), true, vec![])])),
        ("hits that stun enemies have culling strike", Mods(vec![flag_mod("Condition:maceMasteryStunCullSpecced", vec![])])),
        // Intimidate
        ("permanently intimidate enemies on block", Mods(vec![wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))]))])])),
        ("with a murderous eye jewel socketed, intimidate enemies for (%d) seconds on hit with attacks", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![tg(stag("Condition", vec![("var", s("HaveMurderousEyeJewelIn{SlotName}"))]))]),
        ])),
        ("enemies taunted by your warcries are intimidated", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![tg(stag("Condition", vec![("var", s("Taunted"))]))]), vec![tg(stag("Condition", vec![("var", s("UsedWarcryRecently"))]))]),
        ])),
        ("intimidate enemies for (%d+) seconds on block while holding a shield", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![tg(stag("Condition", vec![("var", s("BlockedRecently"))])), tg(stag("Condition", vec![("var", s("UsingShield"))]))]),
        ])),
        ("intimidate enemies on hit if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(1)))))]))]),
        ]))),
        ("intimidate enemies for (%d+) seconds on hit with attacks while at maximum endurance charges", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![tg(stag("StatThreshold", vec![("stat", s("EnduranceCharges")), ("thresholdStat", s("EnduranceChargesMax"))])), tg(stag("Condition", vec![("var", s("HitRecently"))]))]),
        ])),
        // MultiplierThreshold is on RageStacks because Rage is only set in CalcPerform when
        // Condition:CanGainRage is true; Bear's Girdle doesn't flag CanGainRage.
        ("nearby enemies are intimidated while you have rage", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("RageStack")), ("threshold", num(1.0))]))]),
        ])),
        ("your hits intimidate enemies for (%d+) seconds while you are using pride", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Intimidated", vec![]), vec![tg(stag("Condition", vec![("var", s("AffectedByPride"))]))]),
        ])),
        // Flasks
        ("flasks do not apply to you", Mods(vec![flag_mod("FlasksDoNotApplyToPlayer", vec![])])),
        ("flasks apply to your zombies and spectres", Mods(vec![
            flag_mod("FlasksApplyToMinion", vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Raise Zombie"), s("Raise Spectre")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("flasks apply to your raised zombies and spectres", Mods(vec![
            flag_mod("FlasksApplyToMinion", vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Raise Zombie"), s("Raise Spectre")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("flasks you use apply to your raised zombies and spectres", Mods(vec![
            flag_mod("FlasksApplyToMinion", vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Raise Zombie"), s("Raise Spectre")])), ("includeTransfigured", b(true))]))]),
        ])),
        ("your minions use your flasks when summoned", Mods(vec![flag_mod("FlasksApplyToMinion", vec![])])),
        ("recover an additional (%d+)%% of flask's life recovery amount over 10 seconds if used while not on full life", Func(|a| Some(vec![
            mk_mod("FlaskAdditionalLifeRecovery", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("creates a smoke cloud on use", Mods(vec![])),
        ("creates chilled ground on use", Mods(vec![])),
        ("creates consecrated ground on use", Mods(vec![])),
        ("removes bleeding on use", Mods(vec![])),
        ("removes burning on use", Mods(vec![])),
        ("removes all burning when used", Mods(vec![])),
        ("removes curses on use", Mods(vec![])),
        ("removes freeze and chill on use", Mods(vec![])),
        ("removes poison on use", Mods(vec![])),
        ("removes shock on use", Mods(vec![])),
        ("g?a?i?n? ?unholy might during f?l?a?s?k? ?effect", Mods(vec![
            flag_mod("Condition:UnholyMight", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            flag_mod("Condition:CanWither", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ])),
        ("zealot's oath during f?l?a?s?k? ?effect", Mods(vec![flag_mod("ZealotsOath", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants level (%d+) (.+) curse aura during f?l?a?s?k? ?effect", Func(|a| Some(vec![
            mk_mod("ExtraCurse", "LIST", mapv(vec![
                ("skillId", s(helpers::gem_id_lookup().get(&a.s(2).replace(" skill", "")).cloned().unwrap_or_else(|| "Unknown".to_string()))),
                ("level", num(a.n(1))),
            ]), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("shocks nearby enemies during f?l?a?s?k? ?effect, causing (%d+)%% increased damage taken", Func(|a| Some(vec![
            mk_mod("ShockOverride", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("during f?l?a?s?k? ?effect, (%d+)%% reduced damage taken of each element for which your uncapped elemental resistance is lowest", Func(|a| Some(vec![
            mk_mod("LightningDamageTaken", "INC", num(-a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("LightningResistTotal")), ("thresholdStat", s("ColdResistTotal")), ("upper", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("LightningResistTotal")), ("thresholdStat", s("FireResistTotal")), ("upper", b(true))])),
            ]),
            mk_mod("ColdDamageTaken", "INC", num(-a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("ColdResistTotal")), ("thresholdStat", s("LightningResistTotal")), ("upper", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ColdResistTotal")), ("thresholdStat", s("FireResistTotal")), ("upper", b(true))])),
            ]),
            mk_mod("FireDamageTaken", "INC", num(-a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("FireResistTotal")), ("thresholdStat", s("LightningResistTotal")), ("upper", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("FireResistTotal")), ("thresholdStat", s("ColdResistTotal")), ("upper", b(true))])),
            ]),
        ]))),
        ("during f?l?a?s?k? ?effect, damage penetrates (%d+)%% o?f? ?resistance of each element for which your uncapped elemental resistance is highest", Func(|a| Some(vec![
            mk_mod("LightningPenetration", "BASE", num(a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("LightningResistTotal")), ("thresholdStat", s("ColdResistTotal"))])),
                tg(stag("StatThreshold", vec![("stat", s("LightningResistTotal")), ("thresholdStat", s("FireResistTotal"))])),
            ]),
            mk_mod("ColdPenetration", "BASE", num(a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("ColdResistTotal")), ("thresholdStat", s("LightningResistTotal"))])),
                tg(stag("StatThreshold", vec![("stat", s("ColdResistTotal")), ("thresholdStat", s("FireResistTotal"))])),
            ]),
            mk_mod("FirePenetration", "BASE", num(a.n(1)), vec![
                tg(stag("StatThreshold", vec![("stat", s("FireResistTotal")), ("thresholdStat", s("LightningResistTotal"))])),
                tg(stag("StatThreshold", vec![("stat", s("FireResistTotal")), ("thresholdStat", s("ColdResistTotal"))])),
            ]),
        ]))),
        ("damage penetrates fire resistance equal to your overcapped fire resistance", Mods(vec![flag_mod("FirePenIncreasedByUncappedFireRes", vec![])])),
        ("damage penetrates fire resistance equal to your overcapped fire resistance, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("FirePenetration", "BASE", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("FireResistOverCap")), ("limit", num(a.n(1))), ("limitTotal", b(true))]))]),
        ]))),
        ("recover (%d+)%% of life when you kill an enemy during f?l?a?s?k? ?effect", Func(|a| Some(vec![
            mk_mod("LifeOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("recover (%d+)%% of mana when you kill an enemy during f?l?a?s?k? ?effect", Func(|a| Some(vec![
            mk_mod("ManaOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("recover (%d+)%% of energy shield when you kill an enemy during f?l?a?s?k? ?effect", Func(|a| Some(vec![
            mk_mod("EnergyShieldOnKill", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("(%d+)%% of maximum life taken as chaos damage per second", Func(|a| Some(vec![mk_mod("ChaosDegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))])]))),
        ("your critical strikes do not deal extra damage during f?l?a?s?k? ?effect", Mods(vec![flag_mod("NoCritMultiplier", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants perfect agony during f?l?a?s?k? ?effect", Mods(vec![mk_mod("Keystone", "LIST", s("Perfect Agony"), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("grants eldritch battery during f?l?a?s?k? ?effect", Mods(vec![mk_mod("Keystone", "LIST", s("Eldritch Battery"), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("eldritch battery during f?l?a?s?k? ?effect", Mods(vec![mk_mod("Keystone", "LIST", s("Eldritch Battery"), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("chaos damage t?a?k?e?n? ?does not bypass energy shield during effect", Mods(vec![flag_mod("ChaosNotBypassEnergyShield", vec![])])),
        ("when hit during effect, (%d+)%% of life loss from damage taken occurs over 4 seconds instead", Func(|a| Some(vec![
            mk_mod("LifeLossPrevented", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("y?o?u?r? ?skills [ch][oa][sv][te] no mana c?o?s?t? ?during f?l?a?s?k? ?effect", Mods(vec![mk_mod("ManaCost", "MORE", num(-100.0), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("life recovery from flasks also applies to energy shield during f?l?a?s?k? ?effect", Mods(vec![flag_mod("LifeFlaskAppliesToEnergyShield", vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))])])),
        ("profane ground you create inflicts malediction on enemies", Mods(vec![
            wrap("EnemyModifier", flag_mod("HasMalediction", vec![tg(stag("Condition", vec![("var", s("OnProfaneGround"))]))]), vec![]),
        ])),
        ("profane ground you create also affects you and your allies, granting chaotic might", Mods(vec![
            wrap("ExtraAura", flag_mod("Condition:ChaoticMight", vec![tg(stag("Condition", vec![("var", s("OnProfaneGround"))]))]), vec![]),
        ])),
        ("raised beast spectres have farrul's farric presence", Mods(vec![
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("Accuracy", "INC", num(80.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("CritChance", "INC", num(120.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
        ])),
        ("raised beast spectres have farrul's fertile presence", Mods(vec![
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("Damage", "INC", num(100.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("LifeRegenPercent", "BASE", num(3.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&flag_mod("StunImmune", vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
        ])),
        ("raised beast spectres have farrul's wild presence", Mods(vec![
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("Speed", "INC", num(20.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("MovementSpeed", "INC", num(20.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
            mk_mod("ExtraAura", "LIST", mapv(vec![("fromAllies", b(true)), ("mod", mod_to_pval(&mk_mod("MinimumActionSpeed", "MAX", num(100.0), vec![])))]), vec![tg(stag("Condition", vec![("var", s("HaveBeastSpectre"))]))]),
        ])),
        ("gain alchemist's genius when you use a flask", Mods(vec![flag_mod("Condition:CanHaveAlchemistGenius", vec![])])),
        ("(%d+)%% chance to gain alchemist's genius when you use a flask", Mods(vec![flag_mod("Condition:CanHaveAlchemistGenius", vec![])])),
        ("(%d+)%% less flask charges gained from kills", Func(|a| Some(vec![mk_mod("FlaskChargesGained", "MORE", num(-a.n(1)), vec![src("from Kills")])]))),
        ("flasks gain (%d+) charges? every (%d+) seconds", Func(|a| Some(vec![mk_mod("FlaskChargesGenerated", "BASE", num(a.n(1) / a.n(2)), vec![])]))),
        ("flasks gain a charge every (%d+) seconds", Func(|a| Some(vec![mk_mod("FlaskChargesGenerated", "BASE", num(1.0 / a.n(1)), vec![])]))),
        ("while a unique enemy is in your presence, flasks gain a charge every (%d+) seconds", Func(|a| Some(vec![
            mk_mod("FlaskChargesGenerated", "BASE", num(1.0 / a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))]),
        ]))),
        ("while a pinnacle atlas boss is in your presence, flasks gain a charge every (%d+) seconds", Func(|a| Some(vec![
            mk_mod("FlaskChargesGenerated", "BASE", num(1.0 / a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))]))]),
        ]))),
        ("utility flasks gain (%d+) charges? every (%d+) seconds", Func(|a| Some(vec![mk_mod("UtilityFlaskChargesGenerated", "BASE", num(a.n(1) / a.n(2)), vec![])]))),
        ("iron flasks gain (%d+) charges? when your ward breaks", Func(|a| Some(vec![mk_mod("IronFlaskChargesGeneratedOnWardBreak", "BASE", num(a.n(1)), vec![])]))),
        ("life flasks gain (%d+) charges? every (%d+) seconds", Func(|a| Some(vec![mk_mod("LifeFlaskChargesGenerated", "BASE", num(a.n(1) / a.n(2)), vec![])]))),
        ("while on low life, life flasks gain (%d+) charges? every (%d+) seconds", Func(|a| Some(vec![
            mk_mod("LifeFlaskChargesGenerated", "BASE", num(a.n(1) / a.n(2)), vec![tg(stag("Condition", vec![("var", s("LowLife"))]))]),
        ]))),
        ("mana flasks gain (%d+) charges? every (%d+) seconds", Func(|a| Some(vec![mk_mod("ManaFlaskChargesGenerated", "BASE", num(a.n(1) / a.n(2)), vec![])]))),
        ("flasks gain (%d+) charges? per empty flask slot every (%d+) seconds", Func(|a| Some(vec![mk_mod("FlaskChargesGeneratedPerEmptyFlask", "BASE", num(a.n(1) / a.n(2)), vec![])]))),
        ("flasks gain (%d+) charges? per second if you've hit a unique enemy recently", Func(|a| Some(vec![
            mk_mod("FlaskChargesGenerated", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("HitRecently"))])), tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))]))]),
        ]))),
        ("effect is not removed when unreserved mana is filled", Mods(vec![flag_mod("ManaFlaskEffectNotRemoved", vec![])])),
        ("life flask effects are not removed when unreserved life is filled", Mods(vec![flag_mod("LifeFlaskEffectNotRemoved", vec![])])),
        ("mana flask effects are not removed when unreserved mana is filled", Mods(vec![flag_mod("ManaFlaskEffectNotRemoved", vec![])])),
        // Jewels
        ("passives? ?s?k?i?l?l?s? in radius of ([%a%s']+) can be allocated without being connected to your tree", Func(|a| Some(vec![
            mk_mod("JewelData", "LIST", mapv(vec![("key", s("impossibleEscapeKeystone")), ("value", s(a.s(1)))]), vec![]),
            mk_mod("ImpossibleEscapeKeystones", "LIST", mapv(vec![("key", s(a.s(1))), ("value", b(true))]), vec![]),
        ]))),
        ("passives? ?s?k?i?l?l?s? in radius can be allocated without being connected to your tree", Mods(vec![
            mk_mod("JewelData", "LIST", mapv(vec![("key", s("intuitiveLeapLike")), ("value", b(true))]), vec![]),
        ])),
        ("keystone passive skills in radius can be allocated without being connected to your tree", Mods(vec![
            mk_mod("JewelData", "LIST", mapv(vec![("key", s("intuitiveLeapLike")), ("value", b(true))]), vec![]),
            mk_mod("JewelData", "LIST", mapv(vec![("key", s("intuitiveLeapKeystoneOnly")), ("value", b(true))]), vec![]),
        ])),
        ("affects passives in small ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(6.0))]), vec![])])),
        ("affects passives in medium ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(7.0))]), vec![])])),
        ("affects passives in large ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(8.0))]), vec![])])),
        ("affects passives in very large ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(9.0))]), vec![])])),
        ("affects passives in massive ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(10.0))]), vec![])])),
        ("only affects passives in small ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(6.0))]), vec![])])),
        ("only affects passives in medium ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(7.0))]), vec![])])),
        ("only affects passives in large ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(8.0))]), vec![])])),
        ("only affects passives in very large ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(9.0))]), vec![])])),
        ("only affects passives in massive ring", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("radiusIndex")), ("value", num(10.0))]), vec![])])),
        ("primordial", Mods(vec![mk_mod("Multiplier:PrimordialItem", "BASE", num(1.0), vec![])])),
        ("spectres have a base duration of (%d+) seconds", Mods(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("duration")), ("value", num(6.0))]), vec![tg(stag("SkillName", vec![("skillName", s("Raise Spectre")), ("includeTransfigured", b(true))]))]),
        ])),
        ("flasks applied to you have (%d+)%% increased effect", Func(|a| Some(vec![mk_mod("FlaskEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("flasks applied to you have (%d+)%% increased effect per level", Func(|a| Some(vec![
            mk_mod("FlaskEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))])), tg(stag("Multiplier", vec![("var", s("Level"))]))]),
        ]))),
        ("equipped magic flasks have (%d+)%% increased effect on you if no flasks are adjacent to them", Func(|a| Some(vec![mk_mod("MagicFlaskNoAdjacentEffect", "INC", num(a.n(1)), vec![])]))),
        ("while a unique enemy is in your presence, flasks applied to you have (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("FlaskEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("RareOrUnique"))])), tg(stag("ActorCondition", vec![("actor", s("player"))]))]),
        ]))),
        ("while a pinnacle atlas boss is in your presence, flasks applied to you have (%d+)%% increased effect", Func(|a| Some(vec![
            mk_mod("FlaskEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("PinnacleBoss"))])), tg(stag("ActorCondition", vec![("actor", s("player"))]))]),
        ]))),
        ("magic utility flasks applied to you have (%d+)%% increased effect", Func(|a| Some(vec![mk_mod("MagicUtilityFlaskEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("flasks applied to you have (%d+)%% reduced effect", Func(|a| Some(vec![mk_mod("FlaskEffect", "INC", num(-a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("tinctures applied to you have (%d+)%% increased effect", Func(|a| Some(vec![mk_mod("TinctureEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("tinctures applied to you have (%d+)%% increased effect if you've used a life flask recently", Func(|a| Some(vec![
            mk_mod("TinctureEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))])), tg(stag("Condition", vec![("var", s("UsingLifeFlask"))]))]),
        ]))),
        ("tinctures applied to you have (%d+)%% increased effect while affected by no flasks", Func(|a| Some(vec![
            mk_mod("TinctureEffect", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))])), tg(stag("Condition", vec![("var", s("UsingFlask")), ("neg", b(true))]))]),
        ]))),
        ("tinctures have (%d+)%% increased effect while at or above (%d+) stacks of mana burn", Func(|a| Some(vec![
            mk_mod("TinctureEffect", "INC", num(a.n(1)), vec![tg(stag("MultiplierThreshold", vec![("varList", list(vec![s("ManaBurnStacks"), s("WeepingWoundsStacks")])), ("threshold", num(a.n(2)))]))]),
        ]))),
        ("tinctures applied to you have (%d+)%% reduced mana burn rate", Func(|a| Some(vec![mk_mod("TinctureManaBurnRate", "INC", num(-a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("tinctures applied to you have (%d+)%% less mana burn rate", Func(|a| Some(vec![mk_mod("TinctureManaBurnRate", "MORE", num(-a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("the first (%d+) mana burn applied to you have no effect", Func(|a| Some(vec![mk_mod("EffectiveManaBurnStacks", "BASE", num(-a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("player"))]))])]))),
        ("tinctures deactivate when you have (%d+) or more mana burn", Func(|a| Some(vec![mk_mod("MaxManaBurnStacks", "BASE", num(a.n(1)), vec![])]))),
        ("tinctures inflict weeping wounds instead of mana burn", Mods(vec![flag_mod("Condition:WeepingWoundsInsteadOfManaBurn", vec![])])),
        ("tincture effects also apply to ranged weapons", Mods(vec![flag_mod("TinctureRangedWeapons", vec![])])),
        ("you can have an additional tincture active", Mods(vec![mk_mod("TinctureLimit", "BASE", num(1.0), vec![])])),
        ("(%d+)%% increased tincture cooldown recovery rate", Func(|a| Some(vec![mk_mod("TinctureCooldownRecovery", "INC", num(a.n(1)), vec![])]))),
        ("adds (%d+) passive skills", Func(|a| Some(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelNodeCount")), ("value", num(a.n(1)))]), vec![])]))),
        ("1 added passive skill is a jewel socket", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelSocketCount")), ("value", num(1.0))]), vec![])])),
        ("(%d+) added passive skills are jewel sockets", Func(|a| Some(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelSocketCount")), ("value", num(a.n(1)))]), vec![])]))),
        ("adds (%d+) jewel socket passive skills", Func(|a| Some(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelSocketCountOverride")), ("value", num(a.n(1)))]), vec![])]))),
        ("adds (%d+) small passive skills? which grants? nothing", Func(|a| Some(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelNothingnessCount")), ("value", num(a.n(1)))]), vec![])]))),
        ("added small passive skills grant nothing", Mods(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelSmallsAreNothingness")), ("value", b(true))]), vec![])])),
        ("added small passive skills have (%d+)%% increased effect", Func(|a| Some(vec![mk_mod("JewelData", "LIST", mapv(vec![("key", s("clusterJewelIncEffect")), ("value", num(a.n(1)))]), vec![])]))),
        ("this jewel's socket has (%d+)%% increased effect per allocated passive skill between it and your class' starting location", Func(|a| Some(vec![
            mk_mod("JewelData", "LIST", mapv(vec![("key", s("jewelIncEffectFromClassStart")), ("value", num(a.n(1)))]), vec![]),
        ]))),
        ("(%d+)%% increased effect of jewel socket passive skills containing corrupted (m?r?ag?r?i?e?c?) jewels, if not from cluster jewels", Func(|a| Some(vec![
            mk_mod("JewelData", "LIST", mapv(vec![("key", s(format!("corrupted{}JewelIncEffect", first_upper(a.s(2))))), ("value", num(a.n(1)))]), vec![]),
        ]))),
        ("(%d+)%% increased effect of jewel socket passive skills containing corrupted (m?r?ag?r?i?e?c?) jewels", Func(|a| Some(vec![
            mk_mod("JewelData", "LIST", mapv(vec![("key", s(format!("corrupted{}JewelIncEffect", first_upper(a.s(2))))), ("value", num(a.n(1)))]), vec![]),
        ]))),
        // Misc
        ("can't use chest armour", Mods(vec![mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Body Armour"))]))])])),
        ("can't use helmets?", Mods(vec![mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Helmet"))]))])])),
        ("can't use other rings", Mods(vec![
            mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Ring 2"))])), tg(stag("SlotNumber", vec![("num", num(1.0))]))]),
            mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Ring 1"))])), tg(stag("SlotNumber", vec![("num", num(2.0))]))]),
        ])),
        ("uses both hand slots", Mods(vec![
            mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Weapon 2"))])), tg(stag("SlotNumber", vec![("num", num(1.0))]))]),
            mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Weapon 1"))])), tg(stag("SlotNumber", vec![("num", num(2.0))]))]),
        ])),
        ("can't use flask in fifth slot", Mods(vec![
            mk_mod("CanNotUseItem", "Flag", num(1.0), vec![tg(stag("DisablesItem", vec![("slotName", s("Flask 5")), ("excludeItemType", s("Tincture"))]))]),
        ])),
        ("boneshatter has (%d+)%% chance to grant %+1 trauma", Func(|a| Some(vec![
            mk_mod("ExtraTrauma", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Boneshatter")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("your minimum frenzy, endurance and power charges are equal to your maximum while you are stationary", Mods(vec![
            flag_mod("MinimumFrenzyChargesIsMaximumFrenzyCharges", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))]),
            flag_mod("MinimumEnduranceChargesIsMaximumEnduranceCharges", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))]),
            flag_mod("MinimumPowerChargesIsMaximumPowerCharges", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))]),
        ])),
        ("minimum power charges equal to maximum while stationary", Mods(vec![flag_mod("MinimumPowerChargesIsMaximumPowerCharges", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))])])),
        ("minimum frenzy charges equal to maximum while stationary", Mods(vec![flag_mod("MinimumFrenzyChargesIsMaximumFrenzyCharges", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))])])),
        ("minimum endurance charges equal to maximum while stationary", Mods(vec![flag_mod("MinimumEnduranceChargesIsMaximumEnduranceCharges", vec![tg(stag("Condition", vec![("var", s("Stationary"))]))])])),
        ("count as having maximum number of power charges", Mods(vec![flag_mod("HaveMaximumPowerCharges", vec![])])),
        ("count as having maximum number of frenzy charges", Mods(vec![flag_mod("HaveMaximumFrenzyCharges", vec![])])),
        ("count as having maximum number of endurance charges", Mods(vec![flag_mod("HaveMaximumEnduranceCharges", vec![])])),
        ("leftmost (%d+) magic utility flasks constantly apply their flask effects to you", Func(|a| Some(vec![mk_mod("LeftActiveMagicUtilityFlasks", "BASE", num(a.n(1)), vec![])]))),
        ("rightmost (%d+) magic utility flasks constantly apply their flask effects to you", Func(|a| Some(vec![mk_mod("RightActiveMagicUtilityFlasks", "BASE", num(a.n(1)), vec![])]))),
        ("marauder: melee skills have (%d+)%% increased area of effect", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("ConnectedToMarauderStart"))])), tg(stag("SkillType", vec![("skillType", num(20.0))]))]), // SkillType.Melee
        ]))),
        ("intelligence provides no bonus to energy shield", Mods(vec![flag_mod("NoIntBonusToES", vec![])])),
        ("intelligence provides no inherent bonus to energy shield", Mods(vec![flag_mod("NoIntBonusToES", vec![])])),
        ("gain accuracy rating equal to your intelligence", Mods(vec![mk_mod("Accuracy", "BASE", num(1.0), vec![tg(stag("PerStat", vec![("stat", s("Int"))]))])])),
        ("intelligence is added to accuracy rating with wands", Mods(vec![mk_mod("Accuracy", "BASE", num(1.0), vec![flags(mf::Wand), tg(stag("PerStat", vec![("stat", s("Int"))]))])])),
        ("dexterity's accuracy bonus instead grants %+(%d+) to accuracy rating per dexterity", Func(|a| Some(vec![mk_mod("DexAccBonusOverride", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("(%d+)%% increased accuracy rating against marked enemy", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "INC", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Marked"))]))])]))),
        ("(%d+)%% more accuracy rating against marked enemy", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "MORE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Marked"))]))])]))),
        ("%+(%d+) to accuracy against bleeding enemies", Func(|a| Some(vec![mk_mod("AccuracyVsEnemy", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Bleeding"))]))])]))),
        ("cannot recover energy shield to above armour", Mods(vec![flag_mod("ArmourESRecoveryCap", vec![])])),
        ("cannot recover energy shield to above evasion rating", Mods(vec![flag_mod("EvasionESRecoveryCap", vec![])])),
        ("warcries exert (%d+) additional attacks?", Func(|a| Some(vec![mk_mod("ExtraExertedAttacks", "BASE", num(a.n(1)), vec![])]))),
        ("battlemage's cry exerts (%d+) additional attack", Func(|a| Some(vec![mk_mod("BattlemageExertedAttacks", "BASE", num(a.n(1)), vec![])]))),
        ("rallying cry exerts (%d+) additional attack", Func(|a| Some(vec![mk_mod("RallyingExertedAttacks", "BASE", num(a.n(1)), vec![])]))),
        ("warcries have (%d+)%% chance to exert (%d+) additional attacks?", Func(|a| Some(vec![mk_mod("ExtraExertedAttacks", "BASE", num(a.n(1) * a.n(2) / 100.0), vec![])]))),
        ("skills deal (%d+)%% more damage for each warcry exerting them", Func(|a| Some(vec![mk_mod("EchoesExertAverageIncrease", "MORE", num(a.n(1)), vec![])]))),
        ("iron will", Mods(vec![flag_mod("IronWill", vec![])])),
        ("iron reflexes while stationary", Mods(vec![mk_mod("Keystone", "LIST", s("Iron Reflexes"), vec![tg(stag("Condition", vec![("var", s("Stationary"))]))])])),
        ("you have iron reflexes while at maximum frenzy charges", Mods(vec![mk_mod("Keystone", "LIST", s("Iron Reflexes"), vec![tg(stag("StatThreshold", vec![("stat", s("FrenzyCharges")), ("thresholdStat", s("FrenzyChargesMax"))]))])])),
        ("you have zealot's oath if you haven't been hit recently", Mods(vec![mk_mod("Keystone", "LIST", s("Zealot's Oath"), vec![tg(stag("Condition", vec![("var", s("BeenHitRecently")), ("neg", b(true))]))])])),
        ("deal no physical damage", Mods(vec![flag_mod("DealNoPhysical", vec![])])),
        ("deal no cold damage", Mods(vec![flag_mod("DealNoCold", vec![])])),
        ("deal no fire damage", Mods(vec![flag_mod("DealNoFire", vec![])])),
        ("deal no lightning damage", Mods(vec![flag_mod("DealNoLightning", vec![])])),
        ("deal no elemental damage", Mods(vec![flag_mod("DealNoLightning", vec![]), flag_mod("DealNoCold", vec![]), flag_mod("DealNoFire", vec![])])),
        ("deal no chaos damage", Mods(vec![flag_mod("DealNoChaos", vec![])])),
        ("deal no damage", Mods(vec![flag_mod("DealNoDamage", vec![])])),
        ("you can't deal damage with skills yourself", Mods(vec![
            flag_mod("DealNoDamage", vec![
                tg(stag("SkillType", vec![("skillTypeList", list(vec![num(26.0), num(36.0), num(33.0)])), ("neg", b(true))])), // SummonsTotem, RemoteMined, Trapped
                tg(stag("Condition", vec![("var", s("usedByMirage")), ("neg", b(true))])),
            ]),
        ])),
        ("deal no non%-elemental damage", Mods(vec![flag_mod("DealNoPhysical", vec![]), flag_mod("DealNoChaos", vec![])])),
        ("deal no non%-(%a+) damage", Func(|a| deal_no_non_damage_type(a.s(1), false))),
        ("cannot deal non%-(%a+) damage", Func(|a| deal_no_non_damage_type(a.s(1), false))),
        ("deal no physical or elemental damage", Mods(vec![flag_mod("DealNoPhysical", vec![]), flag_mod("DealNoCold", vec![]), flag_mod("DealNoFire", vec![]), flag_mod("DealNoLightning", vec![])])),
        ("deal no damage when not on low life", Mods(vec![flag_mod("DealNoDamage", vec![tg(stag("Condition", vec![("var", s("LowLife")), ("neg", b(true))]))])])),
        ("spell skills deal no damage", Mods(vec![flag_mod("DealNoDamage", vec![tg(stag("SkillType", vec![("skillType", num(2.0))]))])])), // SkillType.Spell
        ("attacks have blood magic", Mods(vec![flag_mod("CostLifeInsteadOfMana", vec![flags(mf::Attack)])])),
        ("attacks cost life instead of mana", Mods(vec![flag_mod("CostLifeInsteadOfMana", vec![flags(mf::Attack)])])),
        ("attack skills cost life instead of (%d+)%% of mana cost", Func(|a| Some(vec![mk_mod("HybridManaAndLifeCost_Life", "BASE", num(a.n(1)), vec![flags(mf::Attack)])]))),
        ("skills cost energy shield instead of mana or life", Mods(vec![flag_mod("CostESInsteadOfManaOrLife", vec![])])),
        ("spells have an additional life cost equal to (%d+)%% of your maximum life", Func(|a| Some(vec![
            mk_mod("LifeCostBase", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1))), ("floor", b(true))])), tg(stag("SkillType", vec![("skillType", num(2.0))]))]),
        ]))),
        ("spells have added spell damage equal to (%d+)%% of physical damage of your equipped two handed weapon", Func(|a| Some(vec![
            flag_mod("WeaponPhysAppliesToSpells", vec![]),
            mk_mod("WeaponPhysAppliesToSpellsPercent", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingTwoHandedWeapon"))]))]),
        ]))),
        ("spells cost %+(%d+)%% of life", Func(|a| Some(vec![
            mk_mod("LifeCostBase", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1))), ("floor", b(true))])), tg(stag("SkillType", vec![("skillType", num(2.0))]))]),
        ]))),
        ("trigger a socketed elemental spell on block, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportTriggerElementalSpellOnBlock")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("trigger a socketed spell when you block, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueVirulenceSpellsCastOnBlock")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("(%d+)%% chance to cast a? ?socketed lightning spells? on hit", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueMjolnerLightningSpellsCastOnHit")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("cast a socketed lightning spell on hit", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueMjolnerLightningSpellsCastOnHit")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("trigger a socketed lightning spell on hit", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueMjolnerLightningSpellsCastOnHit")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("trigger a socketed lightning spell on hit, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueMjolnerLightningSpellsCastOnHit")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("trigger a socketed spell when a hit from this weapon freezes a target, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportTriggerSpellOnBowAttackFreezeHit")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("trigger a socketed spell on unarmed melee critical strike, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportTriggerSpellOnUnarmedMeleeCriticalHit")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("[ct][ar][si][tg]g?e?r? a socketed cold s[pk][ei]ll on melee critical strike", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueCosprisMaliceColdSpellsCastOnMeleeCriticalStrike")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("[ct][ar][si][tg]g?e?r? a socketed cold s[pk][ei]ll on melee critical strike, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueCosprisMaliceColdSpellsCastOnMeleeCriticalStrike")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("you cannot cast socketed hex curse skills inflict socketed hexes on enemies that trigger your traps", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportCurseOnTrapTriggered")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
    ]
}

fn part6() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("your curses can apply to hexproof enemies", Mods(vec![flag_mod("CursesIgnoreHexproof", vec![])])),
        ("your hexes can affect hexproof enemies", Mods(vec![flag_mod("CursesIgnoreHexproof", vec![])])),
        ("([%a%s]+) can affect hexproof enemies", Func(|a| Some(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("ignoreHexproof")), ("value", b(true))]),
                vec![tg(skill_id_tag(a.s(1)))]),
        ]))),
        ("hexes from socketed skills can apply (%d) additional curses", Func(|a| Some(vec![
            mk_mod("SocketedCursesHexLimitValue", "BASE", num(a.n(1)), vec![]),
            flag_mod("SocketedCursesAdditionalLimit", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ]))),
        // This changed from ignoreHexLimit to SocketedCursesAdditionalLimit for patch 3.16.0: legacy
        // versions are affected by the new curse-limit change, but only get 20% less curse effect on
        // curses triggered by Summon Doedre's Effigy. Legacy versions still show "Hexes from Socketed
        // Skills ignore Curse limit", but internally get a limit of 5 to match current behavior.
        ("hexes from socketed skills ignore curse limit", Func(|_a| Some(vec![
            mk_mod("SocketedCursesHexLimitValue", "BASE", num(5.0), vec![]),
            flag_mod("SocketedCursesAdditionalLimit", vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ]))),
        ("reserves (%d+)%% of life", Func(|a| Some(vec![mk_mod("ExtraLifeReserved", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% of cold damage taken as lightning", Func(|a| Some(vec![mk_mod("ColdDamageTakenAsLightning", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% of fire damage taken as lightning", Func(|a| Some(vec![mk_mod("FireDamageTakenAsLightning", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% of fire and lightning damage from hits taken as cold damage during effect", Func(|a| Some(vec![
            mk_mod("FireDamageFromHitsTakenAsCold", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
            mk_mod("LightningDamageFromHitsTakenAsCold", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("UsingFlask"))]))]),
        ]))),
        ("(%d+)%% of (%a+) and (%a+) damage from hits taken as (%a+) damage", Func(|a| {
            let dmg_type = |t: &str| DAMAGE_TYPE_LIST.iter().find(|d| d.to_lowercase() == t).copied();
            let (t1, t2, t3) = (dmg_type(a.s(2)), dmg_type(a.s(3)), dmg_type(a.s(4)));
            match (t1, t2, t3) {
                (Some(t1), Some(t2), Some(t3)) => Some(vec![
                    mk_mod(format!("{}DamageFromHitsTakenAs{}", t1, t3), "BASE", num(a.n(1)), vec![]),
                    mk_mod(format!("{}DamageFromHitsTakenAs{}", t2, t3), "BASE", num(a.n(1)), vec![]),
                ]),
                _ => None,
            }
        })),
        ("items and gems have (%d+)%% reduced attribute requirements", Func(|a| Some(vec![mk_mod("GlobalAttributeRequirements", "INC", num(-a.n(1)), vec![])]))),
        ("items and gems have (%d+)%% increased attribute requirements", Func(|a| Some(vec![mk_mod("GlobalAttributeRequirements", "INC", num(a.n(1)), vec![])]))),
        ("mana reservation of herald skills is always (%d+)%%", Func(|a| Some(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("ManaReservationPercentForced")), ("value", num(a.n(1)))]), vec![tg(stag("SkillType", vec![("skillType", num(52.0))]))]), // SkillType.Herald
        ]))),
        ("([%a%s]+) reserves no mana", Func(|a| {
            let sid = skill_id_tag(a.s(1));
            Some(["manaReservationFlat", "lifeReservationFlat", "manaReservationPercent", "lifeReservationPercent"].iter().map(|k| {
                mk_mod("SkillData", "LIST", mapv(vec![("key", s(*k)), ("value", num(0.0))]), vec![
                    tg(sid.clone()),
                    tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))])), // SkillType.Blessing
                ])
            }).collect())
        })),
        ("([%a%s]+) has no reservation", Func(|a| {
            let sid = skill_id_tag(a.s(1));
            Some(["manaReservationFlat", "lifeReservationFlat", "manaReservationPercent", "lifeReservationPercent"].iter().map(|k| {
                mk_mod("SkillData", "LIST", mapv(vec![("key", s(*k)), ("value", num(0.0))]), vec![
                    tg(sid.clone()),
                    tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))])),
                ])
            }).collect())
        })),
        ("([%a%s]+) has no reservation if cast as an aura", Func(|a| {
            let sid = skill_id_tag(a.s(1));
            Some(["manaReservationFlat", "lifeReservationFlat", "manaReservationPercent", "lifeReservationPercent"].iter().map(|k| {
                mk_mod("SkillData", "LIST", mapv(vec![("key", s(*k)), ("value", num(0.0))]), vec![
                    tg(sid.clone()),
                    tg(stag("SkillType", vec![("skillType", num(39.0))])), // SkillType.Aura
                    tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))])),
                ])
            }).collect())
        })),
        ("banner skills reserve no mana", Mods(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("manaReservationPercent")), ("value", num(0.0))]), vec![tg(stag("SkillType", vec![("skillType", num(88.0))])), tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))]))]),
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("lifeReservationPercent")), ("value", num(0.0))]), vec![tg(stag("SkillType", vec![("skillType", num(88.0))])), tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))]))]),
        ])),
        ("banner skills have no reservation", Mods(vec![
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("manaReservationPercent")), ("value", num(0.0))]), vec![tg(stag("SkillType", vec![("skillType", num(88.0))])), tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))]))]),
            mk_mod("SkillData", "LIST", mapv(vec![("key", s("lifeReservationPercent")), ("value", num(0.0))]), vec![tg(stag("SkillType", vec![("skillType", num(88.0))])), tg(stag("SkillType", vec![("skillType", num(108.0)), ("neg", b(true))]))]),
        ])),
        ("placed banners also grant (%d+)%% increased attack damage to you and allies", Func(|a| Some(vec![
            mk_mod("ExtraAuraEffect", "LIST", mapv(vec![("mod", mod_to_pval(&mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Attack)])))]),
                vec![tg(stag("Condition", vec![("var", s("BannerPlanted"))])), tg(stag("SkillType", vec![("skillType", num(88.0))]))]),
        ]))),
        ("banners also cause enemies to take (%d+)%% increased damage", Func(|a| Some(vec![
            mk_mod("ExtraAuraDebuffEffect", "LIST", mapv(vec![("mod", mod_to_pval(&mk_mod("DamageTaken", "INC", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("AuraDebuff")), ("unscalable", b(true))]))])))]),
                vec![tg(stag("Condition", vec![("var", s("BannerPlanted"))])), tg(stag("SkillType", vec![("skillType", num(88.0))]))]),
        ]))),
        ("dread banner grants an additional %+(%d+) to maximum fortification when placing the banner", Func(|a| Some(vec![
            mk_mod("ExtraSkillMod", "LIST", mapv(vec![("mod", mod_to_pval(&mk_mod("MaximumFortification", "BASE", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Buff"))]))])))]),
                vec![tg(stag("Condition", vec![("var", s("BannerPlanted"))])), tg(stag("SkillName", vec![("skillName", s("Dread Banner"))]))]),
        ]))),
        ("your aura skills are disabled", Mods(vec![flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(39.0))]))])])),
        ("your blessing skills are disabled", Mods(vec![flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(108.0))]))])])),
        ("your spells are disabled", Mods(vec![
            flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(2.0))]))]),
            flag_mod("ForceEnableCurseApplication", vec![]),
        ])),
        ("your warcries are disabled", Mods(vec![flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(63.0))]))])])),
        ("your travel skills are disabled", Mods(vec![flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(79.0))]))])])),
        ("aura skills other than ([%a%s]+) are disabled", Func(|a| Some(vec![
            flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(39.0))])), tg(stag("SkillType", vec![("skillType", num(36.0)), ("neg", b(true))]))]),
            flag_mod("EnableSkill", vec![tg(stag("SkillName", vec![("skillName", s(a.s(1)))]))]),
        ]))),
        ("travel skills other than ([%a%s]+) are disabled", Func(|a| Some(vec![
            flag_mod("DisableSkill", vec![tg(stag("SkillType", vec![("skillType", num(79.0))]))]),
            flag_mod("EnableSkill", vec![tg(skill_id_tag(a.s(1)))]),
        ]))),
        ("strength's damage bonus instead grants (%d+)%% increased melee physical damage per (%d+) strength", Func(|a| Some(vec![
            mk_mod("StrDmgBonusRatioOverride", "BASE", num(a.n(1) / a.n(2)), vec![]),
        ]))),
        ("while in her embrace, take ([%d%.]+)%% of your total maximum life and energy shield as fire damage per second per level", Func(|a| Some(vec![
            mk_mod("FireDegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("Level"))])), tg(stag("Condition", vec![("var", s("HerEmbrace"))]))]),
            mk_mod("FireDegen", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Multiplier", vec![("var", s("Level"))])), tg(stag("Condition", vec![("var", s("HerEmbrace"))]))]),
        ]))),
        ("gain her embrace for %d+ seconds when you ignite an enemy", Mods(vec![flag_mod("Condition:CanGainHerEmbrace", vec![])])),
        ("when you cast a spell, sacrifice all mana to gain added maximum lightning damage equal to (%d+)%% of sacrificed mana for 4 seconds", Func(|a| Some(vec![
            flag_mod("Condition:HaveManaStorm", vec![]),
            mk_mod("LightningMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("ManaUnreserved")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("SacrificeManaForLightning"))]))]),
        ]))),
        // typo never existed except in some items generated by upstream
        ("attacks with this weapon have added maximum lightning damage equal to (%d+)%% of your energy shield", Func(|a| Some(vec![
            mk_mod("LightningMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("attacks with this weapon have added maximum lightning damage equal to (%d+)%% of your maximum energy shield", Func(|a| Some(vec![
            mk_mod("LightningMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("attacks with this weapon have added fire damage equal to (%d+)%% of player's maximum life", Func(|a| Some(vec![
            mk_mod("FireMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1))), ("actor", s("parent"))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            mk_mod("FireMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1))), ("actor", s("parent"))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("adds (%d+)%% of your maximum energy shield as cold damage to attacks with this weapon", Func(|a| Some(vec![
            mk_mod("ColdMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            mk_mod("ColdMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("attacks with this weapon have added maximum lightning damage equal to (%d+)%% of player'?s? maximum energy shield", Func(|a| Some(vec![
            mk_mod("LightningMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("EnergyShield")), ("percent", num(a.n(1))), ("actor", s("parent"))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("adds (%d+)%% of your maximum mana as fire damage to attacks with this weapon", Func(|a| Some(vec![
            mk_mod("FireMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
            mk_mod("FireMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))])), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("gain added chaos damage equal to (%d+)%% of ward", Func(|a| Some(vec![
            mk_mod("ChaosMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Ward")), ("percent", num(a.n(1)))]))]),
            mk_mod("ChaosMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Ward")), ("percent", num(a.n(1)))]))]),
        ]))),
        ("while you have unbroken ward, your next non%-channelling attack you use yourself breaks your ward to gain added cold damage equal to (%d+)%% of ward", Func(|a| Some(vec![
            mk_mod("ColdMin", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("Ward")), ("percent", num(a.n(1)))])),
                tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])), // SkillType.Channel
                tg(stag("SkillType", vec![("skillType", num(1.0))])),
                tg(stag("Condition", vec![("var", s("WardNotBreak")), ("neg", b(true))])),
                tg(stag("Condition", vec![("var", s("UnbrokenWard"))])),
            ]),
            mk_mod("ColdMax", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("Ward")), ("percent", num(a.n(1)))])),
                tg(stag("SkillType", vec![("skillType", num(48.0)), ("neg", b(true))])),
                tg(stag("SkillType", vec![("skillType", num(1.0))])),
                tg(stag("Condition", vec![("var", s("WardNotBreak")), ("neg", b(true))])),
                tg(stag("Condition", vec![("var", s("UnbrokenWard"))])),
            ]),
        ]))),
        ("spells deal added chaos damage equal to (%d+)%% of your maximum life", Func(|a| Some(vec![
            mk_mod("ChaosMin", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("SkillType", vec![("skillType", num(2.0))]))]),
            mk_mod("ChaosMax", "BASE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))])), tg(stag("SkillType", vec![("skillType", num(2.0))]))]),
        ]))),
        ("every 16 seconds you gain iron reflexes for 8 seconds", Mods(vec![flag_mod("Condition:HaveArborix", vec![])])),
        ("every 16 seconds you gain elemental overload for 8 seconds", Mods(vec![flag_mod("Condition:HaveAugyre", vec![])])),
        ("every 8 seconds, gain avatar of fire for 4 seconds", Mods(vec![flag_mod("Condition:HaveVulconus", vec![])])),
        ("when hit, gain a random movement speed modifier from 40%% reduced to 100%% increased until hit again", Mods(vec![flag_mod("Condition:HaveGamblesprint", vec![])])),
        ("trigger socketed curse spell when you cast a curse spell, with a ([%d%.]+) second cooldown", Mods(vec![
            mk_mod("ExtraSupport", "LIST", mapv(vec![("skillId", s("SupportUniqueCastCurseOnCurse")), ("level", num(1.0))]), vec![tg(stag("SocketedIn", vec![("slotName", s("{SlotName}"))]))]),
        ])),
        ("modifiers to attributes instead apply to omniscience", Mods(vec![flag_mod("Omniscience", vec![])])),
        ("attribute requirements can be satisfied by (%d+)%% of omniscience", Func(|a| Some(vec![
            mk_mod("OmniAttributeRequirements", "INC", num(a.n(1)), vec![]),
            flag_mod("OmniscienceRequirements", vec![]),
        ]))),
        ("you have far shot while you do not have iron reflexes", Mods(vec![flag_mod("FarShot", vec![tg(stag("Condition", vec![("neg", b(true)), ("var", s("HaveIronReflexes"))]))])])),
        ("you have resolute technique while you do not have elemental overload", Mods(vec![mk_mod("Keystone", "LIST", s("Resolute Technique"), vec![tg(stag("Condition", vec![("neg", b(true)), ("var", s("HaveElementalOverload"))]))])])),
        ("hits ignore enemy monster fire resistance while you are ignited", Mods(vec![flag_mod("IgnoreFireResistance", vec![tg(stag("Condition", vec![("var", s("Ignited"))]))])])),
        ("your hits can't be evaded by blinded enemies", Mods(vec![flag_mod("CannotBeEvaded", vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Blinded"))]))])])),
        ("blind does not affect your chance to hit", Mods(vec![flag_mod("UnaffectedByBlind", vec![])])),
        ("unaffected by blind", Mods(vec![flag_mod("UnaffectedByBlind", vec![])])),
        ("enemies blinded by you while you are blinded have malediction", Mods(vec![
            wrap("EnemyModifier", flag_mod("HasMalediction", vec![tg(stag("Condition", vec![("var", s("Blinded"))]))]),
                vec![tg(stag("Condition", vec![("var", s("Blinded"))])), tg(stag("Condition", vec![("var", s("CannotBeBlinded")), ("neg", b(true))]))]),
        ])),
        ("enemies blinded by you have malediction", Mods(vec![wrap("EnemyModifier", flag_mod("HasMalediction", vec![tg(stag("Condition", vec![("var", s("Blinded"))]))]), vec![])])),
        ("enemies ignited by you during effect have malediction", Mods(vec![wrap("EnemyModifier", flag_mod("HasMalediction", vec![tg(stag("Condition", vec![("var", s("Ignited"))]))]), vec![])])),
        ("skills which throw traps have blood magic", Mods(vec![flag_mod("CostLifeInsteadOfMana", vec![tg(stag("SkillType", vec![("skillType", num(33.0))]))])])), // SkillType.Trapped
        ("skills which throw traps cost life instead of mana", Mods(vec![flag_mod("CostLifeInsteadOfMana", vec![tg(stag("SkillType", vec![("skillType", num(33.0))]))])])),
        ("strength provides no bonus to maximum life", Mods(vec![flag_mod("NoStrBonusToLife", vec![])])),
        ("strength provides no inherent bonus to maximum life", Mods(vec![flag_mod("NoStrBonusToLife", vec![])])),
        ("intelligence provides no bonus to maximum mana", Mods(vec![flag_mod("NoIntBonusToMana", vec![])])),
        ("intelligence provides no inherent bonus to maximum mana", Mods(vec![flag_mod("NoIntBonusToMana", vec![])])),
        ("with a ghastly eye jewel socketed, minions have %+(%d+) to accuracy rating", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("Accuracy", "BASE", num(a.n(1)), vec![]), vec![tg(stag("Condition", vec![("var", s("HaveGhastlyEyeJewelIn{SlotName}"))]))]),
        ]))),
        ("with a ghastly eye jewel socketed, minions have (%d+)%% chance to gain unholy might on hit with spells", Func(|_a| Some(vec![
            wrap("MinionModifier", flag_mod("Condition:UnholyMight", vec![tg(stag("Condition", vec![("var", s("HitSpellRecently"))]))]), vec![tg(stag("Condition", vec![("var", s("HaveGhastlyEyeJewelIn{SlotName}"))]))]),
        ]))),
        ("with a hypnotic eye jewel socketed, gain arcane surge on hit with spells", Func(|_a| Some(vec![
            flag_mod("Condition:ArcaneSurge", vec![tg(stag("Condition", vec![("var", s("HitSpellRecently"))])), tg(stag("Condition", vec![("var", s("HaveHypnoticEyeJewelIn{SlotName}"))]))]),
        ]))),
        ("hits ignore enemy monster chaos resistance if all equipped items are shaper items", Mods(vec![
            flag_mod("IgnoreChaosResistance", vec![tg(stag("MultiplierThreshold", vec![("var", s("NonShaperItem")), ("upper", b(true)), ("threshold", num(0.0))]))]),
        ])),
        ("hits ignore enemy monster chaos resistance if all equipped items are elder items", Mods(vec![
            flag_mod("IgnoreChaosResistance", vec![tg(stag("MultiplierThreshold", vec![("var", s("NonElderItem")), ("upper", b(true)), ("threshold", num(0.0))]))]),
        ])),
        ("your hits ignore enemy monster (%a+) resistances? if all equipped rings are (%a+) rings", Func(|a| Some(vec![
            flag_mod(format!("Ignore{}Resistance", first_upper(a.s(1))), vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}RingEquipped", first_upper(a.s(2))))), ("threshold", num(2.0))]))]),
        ]))),
        ("the stars are aligned if you have 6 influence types among other equipped items", Mods(vec![
            flag_mod("Condition:StarsAreAligned", vec![
                tg(stag("MultiplierThreshold", vec![("var", s("ShaperItem")), ("threshold", num(2.0))])),
                tg(stag("MultiplierThreshold", vec![("var", s("ElderItem")), ("threshold", num(2.0))])),
                tg(stag("MultiplierThreshold", vec![("var", s("WarlordItem")), ("threshold", num(2.0))])),
                tg(stag("MultiplierThreshold", vec![("var", s("HunterItem")), ("threshold", num(2.0))])),
                tg(stag("MultiplierThreshold", vec![("var", s("CrusaderItem")), ("threshold", num(2.0))])),
                tg(stag("MultiplierThreshold", vec![("var", s("RedeemerItem")), ("threshold", num(2.0))])),
            ]),
        ])),
        ("gain %d+ rage on critical hit with attacks, no more than once every [%d%.]+ seconds", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("gain %d+ rage on critical hit with attacks", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("warcry skills' cooldown time is (%d+) seconds", Func(|a| Some(vec![mk_mod("CooldownRecovery", "OVERRIDE", num(a.n(1)), vec![kw(kf::Warcry)])]))),
        // SkillType.Totem doesn't exist in Data/Global.lua's SkillType table (a latent bug in the
        // original: the literal `{SkillType.Instant, SkillType.Totem, SkillType.Triggered}` has a
        // nil hole at index 2); not covered by the golden corpus, so this keeps only the entries
        // before the hole.
        ("non%-instant warcries you use yourself have no cooldown", Func(|_a| Some(vec![
            mk_mod("CooldownRecovery", "OVERRIDE", num(0.0), vec![kw(kf::Warcry), tg(stag("SkillType", vec![("skillTypeList", list(vec![num(64.0)])), ("neg", b(true))]))]),
        ]))),
        ("non%-instant warcries ignore their cooldown when used", Func(|_a| Some(vec![
            mk_mod("CooldownRecovery", "OVERRIDE", num(0.0), vec![kw(kf::Warcry), tg(stag("SkillType", vec![("skillType", num(64.0)), ("neg", b(true))]))]),
        ]))),
        ("warcry skills have (%+%d+) seconds to cooldown", Func(|a| Some(vec![mk_mod("CooldownRecovery", "BASE", num(a.n(1)), vec![kw(kf::Warcry)])]))),
        ("(%d+)%% increased total power counted by warcries", Func(|a| Some(vec![mk_mod("WarcryPower", "INC", num(a.n(1)), vec![])]))),
        ("warcries have a minimum of (%d+) power", Func(|a| Some(vec![mk_mod("MinimumWarcryPower", "BASE", num(a.n(1)), vec![])]))),
        ("stance skills have (%+%d+) seconds to cooldown", Func(|a| Some(vec![mk_mod("CooldownRecovery", "BASE", num(a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(93.0))]))])]))), // SkillType.Stance
        ("using warcries is instant", Mods(vec![flag_mod("InstantWarcry", vec![])])),
        ("attacks with axes or swords grant (%d+) rage on hit, no more than once every second", Mods(vec![
            flag_mod("Condition:CanGainRage", vec![tg(stag("Condition", vec![("varList", list(vec![s("UsingAxe"), s("UsingSword")]))]))]),
        ])),
        ("regenerate (%d+) rage per second for every (%d+) life recovery per second from regeneration", Func(|a| Some(vec![
            mk_mod("RageRegen", "BASE", num(a.n(1)), vec![tg(stag("PercentStat", vec![("stat", s("LifeRegen")), ("percent", num(a.n(1) / a.n(2) * 100.0))]))]),
            flag_mod("Condition:CanGainRage", vec![]),
        ]))),
        ("when you lose temporal chains you gain maximum rage", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
    ]
}

fn part7() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("with a murderous eye jewel socketed, melee attacks grant (%d+) rage on hit, no more than once every second", Mods(vec![
            flag_mod("Condition:CanGainRage", vec![tg(stag("Condition", vec![("var", s("HaveMurderousEyeJewelIn{SlotName}"))]))]),
        ])),
        ("gain %d+ rage after spending a total of %d+ mana", Mods(vec![flag_mod("Condition:CanGainRage", vec![])])),
        ("rage grants cast speed instead of attack speed", Mods(vec![flag_mod("Condition:RageCastSpeed", vec![])])),
        ("rage grants spell damage instead of attack damage", Mods(vec![flag_mod("Condition:RageSpellDamage", vec![])])),
        ("inherent loss of rage is (%d+)%% slower", Func(|a| Some(vec![mk_mod("InherentRageLoss", "INC", num(-a.n(1)), vec![])]))),
        ("inherent loss of rage is (%d+)%% faster", Func(|a| Some(vec![mk_mod("InherentRageLoss", "INC", num(a.n(1)), vec![])]))),
        ("inherent rage loss starts (%d+) seconds? later", Func(|a| Some(vec![mk_mod("InherentRageLossDelay", "BASE", num(a.n(1)), vec![])]))),
        ("your critical strike multiplier is (%d+)%%", Func(|a| Some(vec![mk_mod("CritMultiplier", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("base critical strike chance for attacks with weapons is ([%d%.]+)%%", Func(|a| Some(vec![mk_mod("WeaponBaseCritChance", "OVERRIDE", num(a.n(1)), vec![])]))),
        // old wordings
        ("base critical strike chance of spells is the critical strike chance of y?o?u?r? ?main hand weapon", Mods(vec![flag_mod("BaseCritFromMainHand", vec![flags(mf::Spell)])])),
        ("base spell critical strike chance of spells is equal to that of main hand weapon", Mods(vec![flag_mod("BaseCritFromMainHand", vec![flags(mf::Spell)])])),
        ("critical strike chance is (%d+)%% for hits with this weapon", Func(|a| Some(vec![
            mk_mod("CritChance", "OVERRIDE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("hits with this weapon have %+(%d+)%% to critical strike multiplier per enemy power", Func(|a| Some(vec![
            mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))])), tg(stag("Multiplier", vec![("var", s("EnemyPower"))]))]),
        ]))),
        ("maximum critical strike chance is (%d+)%%", Func(|a| Some(vec![mk_mod("CritChanceCap", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("allocates (.+) if you have the matching modifiers? on forbidden (.+)", Func(|a| Some(vec![
            mk_mod("GrantedAscendancyNode", "LIST", mapv(vec![("side", s(a.s(2))), ("name", s(a.s(1)))]), vec![]),
        ]))),
        ("allocates (.+)", Func(|a| Some(vec![mk_mod("GrantedPassive", "LIST", s(a.s(1)), vec![])]))),
        ("battlemage", Mods(vec![flag_mod("Battlemage", vec![]), mk_mod("MainHandWeaponDamageAppliesToSpells", "MAX", num(100.0), vec![])])),
        ("transfiguration of body", Mods(vec![flag_mod("TransfigurationOfBody", vec![])])),
        ("transfiguration of mind", Mods(vec![flag_mod("TransfigurationOfMind", vec![])])),
        ("transfiguration of soul", Mods(vec![flag_mod("TransfigurationOfSoul", vec![])])),
        ("offering skills have (%d+)%% increased duration", Func(|a| Some(vec![
            mk_mod("Duration", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Bone Offering"), s("Flesh Offering"), s("Spirit Offering"), s("Blood Offering")]))]))]),
        ]))),
        ("offering skills have (%d+)%% reduced duration", Func(|a| Some(vec![
            mk_mod("Duration", "INC", num(-a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Bone Offering"), s("Flesh Offering"), s("Spirit Offering"), s("Blood Offering")]))]))]),
        ]))),
        ("enemies have %-(%d+)%% to total physical damage reduction against your hits", Func(|a| Some(vec![mk_mod("EnemyPhysicalDamageReduction", "BASE", num(-a.n(1)), vec![])]))),
        ("enemies you impale have %-(%d+)%% to total physical damage reduction against impale hits", Func(|a| Some(vec![mk_mod("EnemyImpalePhysicalDamageReduction", "BASE", num(-a.n(1)), vec![])]))),
        ("hits with this weapon overwhelm (%d+)%% physical damage reduction", Func(|a| Some(vec![
            mk_mod("EnemyPhysicalDamageReduction", "BASE", num(-a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("overwhelm (%d+)%% physical damage reduction", Func(|a| Some(vec![mk_mod("EnemyPhysicalDamageReduction", "BASE", num(-a.n(1)), vec![])]))),
        ("hits have (%d+)%% chance to ignore enemy physical damage reduction", Func(|a| Some(vec![mk_mod("ChanceToIgnoreEnemyPhysicalDamageReduction", "BASE", num(a.n(1)), vec![])]))),
        ("hits with this weapon have (%d+)%% chance to ignore enemy physical damage reduction", Func(|a| Some(vec![
            mk_mod("ChanceToIgnoreEnemyPhysicalDamageReduction", "BASE", num(a.n(1)), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("hits with this weapon ignore enemy physical damage reduction", Func(|_a| Some(vec![
            mk_mod("ChanceToIgnoreEnemyPhysicalDamageReduction", "BASE", num(100.0), vec![flags(mf::Hit), tg(stag("Condition", vec![("var", s("{Hand}Attack"))])), tg(stag("SkillType", vec![("skillType", num(1.0))]))]),
        ]))),
        ("hits against you overwhelm (%d+)%% of physical damage reduction", Func(|a| Some(vec![mk_mod("EnemyPhysicalOverwhelm", "BASE", num(a.n(1)), vec![])]))),
        ("impale damage dealt to enemies impaled by you overwhelms (%d+)%% physical damage reduction", Func(|a| Some(vec![mk_mod("EnemyImpalePhysicalDamageReduction", "BASE", num(-a.n(1)), vec![])]))),
        ("impale damage dealt to enemies impaled by you ignores enemy physical damage reduction", Mods(vec![flag_mod("IgnoreEnemyImpalePhysicalDamageReduction", vec![])])),
        // MultiplierThreshold is on RageStacks because Rage is only set in CalcPerform when
        // Condition:CanGainRage is true; Bear's Girdle doesn't flag CanGainRage.
        ("nearby enemies are crushed while you have ?a?t? least (%d+) rage", Func(|a| Some(vec![
            wrap("EnemyModifier", flag_mod("Condition:Crushed", vec![]), vec![tg(stag("MultiplierThreshold", vec![("var", s("RageStack")), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("you are crushed", Mods(vec![flag_mod("Condition:Crushed", vec![])])),
        ("nearby enemies are crushed", Mods(vec![wrap("EnemyModifier", flag_mod("Condition:Crushed", vec![]), vec![])])),
        ("crush enemies on hit with maces and sceptres", Mods(vec![wrap("EnemyModifier", flag_mod("Condition:Crushed", vec![]), vec![tg(stag("Condition", vec![("var", s("UsingMace"))]))])])),
        ("you have fungal ground around you while stationary", Mods(vec![
            wrap("ExtraAura", mk_mod("ChaosResist", "BASE", num(25.0), vec![]), vec![tg(stag("Condition", vec![("varList", list(vec![s("OnFungalGround"), s("Stationary")]))]))]),
            wrap("EnemyModifier", mk_mod("ChaosResist", "BASE", num(-10.0), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("varList", list(vec![s("OnFungalGround"), s("Stationary")]))]))]),
            wrap("EnemyModifier", mk_mod("ElementalResist", "BASE", num(-10.0), vec![]), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("varList", list(vec![s("OnFungalGround"), s("Stationary")]))]))]),
        ])),
        ("create fungal ground instead of consecrated ground", Mods(vec![flag_mod("Condition:CreateFungalGround", vec![])])),
        ("create profane ground instead of consecrated ground", Mods(vec![flag_mod("Condition:CreateProfaneGround", vec![])])),
        ("(%d+)%% chance to create profane ground on critical strike if intelligence is your highest attribute", Mods(vec![
            flag_mod("Condition:CreateProfaneGround", vec![tg(stag("Condition", vec![("var", s("IntHighestAttribute"))]))]),
        ])),
        ("consecrated path and purifying flame create profane ground instead of consecrated ground", Mods(vec![flag_mod("Condition:CreateProfaneGround", vec![])])),
        ("you gain added cold damage instead of added damage of other types if dexterity exceeds both other attributes", Mods(vec![
            flag_mod("AllAddedDamageAsCold", vec![tg(stag("Condition", vec![("var", s("DexSingleHighestAttribute"))]))]),
        ])),
        ("you gain added lightn?ing damage instead of added damage of other types if intelligence exceeds both other attributes", Mods(vec![
            flag_mod("AllAddedDamageAsLightning", vec![tg(stag("Condition", vec![("var", s("IntSingleHighestAttribute"))]))]),
        ])),
        ("elemental hit's added damage cannot be replaced this way", Mods(vec![])),
        ("you have consecrated ground around you while stationary if strength is your highest attribute", Mods(vec![
            flag_mod("Condition:OnConsecratedGround", vec![tg(stag("Condition", vec![("var", s("StrHighestAttribute"))])), tg(stag("Condition", vec![("var", s("Stationary"))]))]),
        ])),
        ("consecrated ground around you while stationary if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            flag_mod("Condition:OnConsecratedGround", vec![tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(2))))), ("threshold", num(a.n(1)))]))]),
        ]))),
        ("you count as dual wielding while you are unencumbered", Mods(vec![flag_mod("Condition:DualWielding", vec![tg(stag("Condition", vec![("var", s("Unencumbered"))]))])])),
        ("dual wielding does not inherently grant chance to block attack damage", Mods(vec![flag_mod("Condition:NoInherentBlock", vec![])])),
        ("inherent attack speed bonus from dual wielding is doubled while wielding two claws", Mods(vec![
            flag_mod("Condition:DoubledInherentDualWieldingSpeed", vec![tg(stag("Condition", vec![("var", s("DualWieldingClaws"))]))]),
        ])),
        ("inherent bonuses from dual wielding are doubled", Mods(vec![
            flag_mod("Condition:DoubledInherentDualWieldingSpeed", vec![]),
            flag_mod("Condition:DoubledInherentDualWieldingBlock", vec![]),
        ])),
        ("(%d+)%% reduced enemy chance to block sword attacks", Func(|a| Some(vec![mk_mod("reduceEnemyBlock", "BASE", num(a.n(1)), vec![flags(mf::Sword)])]))),
        ("you do not inherently take less damage for having fortification", Mods(vec![flag_mod("Condition:NoFortificationMitigation", vec![])])),
        ("skills supported by intensify have %+(%d) to maximum intensity", Func(|a| Some(vec![mk_mod("Multiplier:IntensityLimit", "BASE", num(a.n(1)), vec![])]))),
        ("spells which can gain intensity have %+(%d) to maximum intensity", Func(|a| Some(vec![mk_mod("Multiplier:IntensityLimit", "BASE", num(a.n(1)), vec![])]))),
        ("final repeat of spells has (%d+)%% increased area of effect", Func(|a| Some(vec![
            mk_mod("RepeatFinalAreaOfEffect", "INC", num(a.n(1)), vec![flags(mf::Spell),
                tg(stag("Condition", vec![("var", s("CastOnFrostbolt")), ("neg", b(true))])),
                tg(stag("Condition", vec![("varList", list(vec![s("averageRepeat"), s("alwaysFinalRepeat")]))])),
            ]),
        ]))),
        ("hexes you inflict have ([%+%-]%d+) to maximum doom", Func(|a| Some(vec![mk_mod("MaxDoom", "BASE", num(a.n(1)), vec![])]))),
        ("while stationary, gain (%d+)%% increased area of effect every second, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![
                tg(stag("Multiplier", vec![("var", s("StationarySeconds")), ("globalLimit", num(a.n(2))), ("globalLimitKey", s("ExpansiveMight"))])),
                tg(stag("Condition", vec![("var", s("Stationary"))])),
            ]),
        ]))),
        ("fireball and rolling magma have (%d+)%% more area of effect", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "MORE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Fireball"), s("Rolling Magma")]))]))]),
        ]))),
        ("attack skills have added lightning damage equal to (%d+)%% of maximum mana", Func(|a| Some(vec![
            mk_mod("LightningMin", "BASE", num(1.0), vec![flags(mf::Attack), tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))]))]),
            mk_mod("LightningMax", "BASE", num(1.0), vec![flags(mf::Attack), tg(stag("PercentStat", vec![("stat", s("Mana")), ("percent", num(a.n(1)))]))]),
        ]))),
        ("arc and crackling lance gains added cold damage equal to (%d+)%% of mana cost, if mana cost is not higher than the maximum you could spend", Func(|a| Some(vec![
            mk_mod("ColdMin", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("ManaCost")), ("percent", num(a.n(1))), ("floor", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ManaCostPayablePool")), ("thresholdStat", s("ManaCost"))])),
                tg(stag("SkillName", vec![("skillNameList", list(vec![s("Arc"), s("Crackling Lance")])), ("includeTransfigured", b(true))])),
            ]),
            mk_mod("ColdMax", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("ManaCost")), ("percent", num(a.n(1))), ("floor", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ManaCostPayablePool")), ("thresholdStat", s("ManaCost"))])),
                tg(stag("SkillName", vec![("skillNameList", list(vec![s("Arc"), s("Crackling Lance")])), ("includeTransfigured", b(true))])),
            ]),
        ]))),
        ("forbidden rite and dark pact gains added chaos damage equal to (%d+)%% of mana cost, if mana cost is not higher than the maximum you could spend", Func(|a| Some(vec![
            mk_mod("ChaosMin", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("ManaCost")), ("percent", num(a.n(1))), ("floor", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ManaCostPayablePool")), ("thresholdStat", s("ManaCost"))])),
                tg(stag("SkillName", vec![("skillNameList", list(vec![s("Forbidden Rite"), s("Dark Bargain")])), ("includeTransfigured", b(true))])),
            ]),
            mk_mod("ChaosMax", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("ManaCost")), ("percent", num(a.n(1))), ("floor", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ManaCostPayablePool")), ("thresholdStat", s("ManaCost"))])),
                tg(stag("SkillName", vec![("skillNameList", list(vec![s("Forbidden Rite"), s("Dark Bargain")])), ("includeTransfigured", b(true))])),
            ]),
        ]))),
        ("skills gain added chaos damage equal to (%d+)%% of mana cost, if mana cost is not higher than the maximum you could spend", Func(|a| Some(vec![
            mk_mod("ChaosMin", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("ManaCost")), ("percent", num(a.n(1))), ("floor", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ManaCostPayablePool")), ("thresholdStat", s("ManaCost"))])),
            ]),
            mk_mod("ChaosMax", "BASE", num(1.0), vec![
                tg(stag("PercentStat", vec![("stat", s("ManaCost")), ("percent", num(a.n(1))), ("floor", b(true))])),
                tg(stag("StatThreshold", vec![("stat", s("ManaCostPayablePool")), ("thresholdStat", s("ManaCost"))])),
            ]),
        ]))),
        ("herald of thunder's storms hit enemies with (%d+)%% increased frequency", Func(|a| Some(vec![mk_mod("HeraldStormFrequency", "INC", num(a.n(1)), vec![])]))),
        ("storms hit enemies with (%d+)%% increased frequency", Func(|a| Some(vec![mk_mod("HeraldStormFrequency", "INC", num(a.n(1)), vec![])]))),
        ("your critical strikes have a (%d+)%% chance to deal double damage", Func(|a| Some(vec![mk_mod("DoubleDamageChanceOnCrit", "BASE", num(a.n(1)), vec![])]))),
        ("elemental skills deal triple damage", Mods(vec![mk_mod("TripleDamageChance", "BASE", num(100.0), vec![tg(stag("SkillType", vec![("skillTypeList", list(vec![num(30.0), num(29.0), num(31.0)]))]))])])), // Cold, Fire, Lightning
        ("deal triple damage with elemental skills", Mods(vec![mk_mod("TripleDamageChance", "BASE", num(100.0), vec![tg(stag("SkillType", vec![("skillTypeList", list(vec![num(30.0), num(29.0), num(31.0)]))]))])])),
        ("skills supported by unleash have %+(%d) to maximum number of seals", Func(|a| Some(vec![mk_mod("SealCount", "BASE", num(a.n(1)), vec![])]))),
        ("left ring slot: skills supported by unleash have %+(%d) to maximum number of seals", Func(|a| Some(vec![mk_mod("SealCount", "BASE", num(a.n(1)), vec![tg(stag("SlotNumber", vec![("num", num(1.0))]))])]))),
        ("skills supported by unleash have (%d+)%% increased seal gain frequency", Func(|a| Some(vec![mk_mod("SealGainFrequency", "INC", num(a.n(1)), vec![])]))),
        ("(%d+)%% increased critical strike chance with spells which remove the maximum number of seals", Func(|a| Some(vec![mk_mod("MaxSealCrit", "INC", num(a.n(1)), vec![])]))),
        ("gain elusive on critical strike", Mods(vec![flag_mod("Condition:CanBeElusive", vec![])])),
        ("gain a random shrine buff every (%d+) seconds", Mods(vec![flag_mod("Condition:CanHaveRegularShrines", vec![])])),
        ("gain a random shrine buff for (%d+) seconds when you kill a rare or unique enemy", Mods(vec![flag_mod("Condition:CanHaveRegularShrines", vec![])])),
        ("gain a random blood shrine buff every (%d+) seconds", Mods(vec![flag_mod("Condition:CanHaveBloodShrines", vec![])])),
        ("(%d+)%% chance to gain elusive when you block while dual wielding", Mods(vec![flag_mod("Condition:CanBeElusive", vec![tg(stag("Condition", vec![("var", s("DualWielding"))]))])])),
        ("elusive on you reduces in effect (%d+)%% slower", Func(|a| Some(vec![mk_mod("ElusiveEffectLossSlower", "INC", num(a.n(1)), vec![])]))),
        ("elusive's effect on you is increased instead for the first (%d+) seconds", Func(|a| Some(vec![mk_mod("ElusiveEffectIncreaseDuration", "BASE", num(a.n(1)), vec![])]))),
        ("elusive is removed from you at (%d+)%% effect", Func(|a| Some(vec![mk_mod("ElusiveEffectMinThreshold", "OVERRIDE", num(a.n(1)), vec![])]))),
        ("nearby enemies have (%a+) resistance equal to yours", Func(|a| Some(vec![flag_mod(format!("Enemy{}ResistEqualToYours", first_upper(a.s(1))), vec![])]))),
        ("for each nearby corpse, regenerate ([%d%.]+)%% life per second, up to ([%d%.]+)%%", Func(|a| Some(vec![
            mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("NearbyCorpse")), ("limit", num(a.n(2))), ("limitTotal", b(true))]))]),
        ]))),
        ("gain sacrificial zeal when you use a skill, dealing you %d+%% of the skill's mana cost as physical damage per second", Mods(vec![flag_mod("SacrificialZeal", vec![])])),
        ("skills gain a base life cost equal to (%d+)%% of base mana cost", Func(|a| Some(vec![mk_mod("ManaCostAsLifeCost", "BASE", num(a.n(1)), vec![])]))),
        ("skills gain a base energy shield cost equal to (%d+)%% of base mana cost", Func(|a| Some(vec![mk_mod("ManaCostAsEnergyShieldCost", "BASE", num(a.n(1)), vec![])]))),
    ]
}

fn part8() -> Vec<(&'static str, SpecialVal)> {
    use SpecialVal::{Func, Mods};
    vec![
        ("skills cost life instead of (%d+)%% of mana cost", Func(|a| Some(vec![mk_mod("HybridManaAndLifeCost_Life", "BASE", num(a.n(1)), vec![])]))),
        ("(%d+)%% increased cost of arc and crackling lance", Func(|a| Some(vec![
            mk_mod("Cost", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Arc"), s("Crackling Lance")])), ("includeTransfigured", b(true))]))]),
        ]))),
        // Lua (ModParser.lua:5686-5694): all three of these call `mod(name, "BASE", num, nil,
        // {type="Condition",...})` -- the literal `nil` (not an omitted argument) lands in the
        // table constructor's array slot 1, so the Condition tag ends up at slot 2 instead of 1.
        // `ipairs(mod)` stops at the first missing key, so real EvalMod/ModStore never reaches
        // slot 2: these mods apply UNCONDITIONALLY despite naming a condition. `hole(2, ...)`
        // keeps the tag in the golden JSON export at its real index while excluding it from the
        // reachable `tags` list `pmod_to_mod` hands to the real Mod type (see PMod::unreachable_tags).
        ("hits overwhelm (%d+)%% of physical damage reduction while you have sacrificial zeal", Func(|a| Some(vec![
            mk_mod("EnemyPhysicalDamageReduction", "BASE", num(-a.n(1)), vec![hole(2, stag("Condition", vec![("var", s("SacrificialZeal"))]))]),
        ]))),
        ("(%d+)%% chance for hits to ignore enemy physical damage reduction while you have sacrificial zeal", Func(|a| Some(vec![
            mk_mod("ChanceToIgnoreEnemyPhysicalDamageReduction", "BASE", num(a.n(1)), vec![hole(2, stag("Condition", vec![("var", s("SacrificialZeal"))]))]),
        ]))),
        ("hits have (%d+)%% chance to ignore enemy physical damage reduction while you have sacrificial zeal", Func(|a| Some(vec![
            mk_mod("ChanceToIgnoreEnemyPhysicalDamageReduction", "BASE", num(a.n(1)), vec![hole(2, stag("Condition", vec![("var", s("SacrificialZeal"))]))]),
        ]))),
        ("minions attacks overwhelm (%d+)%% physical damage reduction", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("EnemyPhysicalDamageReduction", "BASE", num(-a.n(1)), vec![tg(stag("SkillType", vec![("skillType", num(1.0))]))]), vec![]),
        ]))),
        ("minions hits have (%d+)%% chance to ignore enemy physical damage reduction", Func(|a| Some(vec![
            wrap("MinionModifier", mk_mod("ChanceToIgnoreEnemyPhysicalDamageReduction", "BASE", num(a.n(1)), vec![]), vec![]),
        ]))),
        ("focus has (%d+)%% increased cooldown recovery rate", Func(|a| Some(vec![mk_mod("FocusCooldownRecovery", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("Focused"))]))])]))),
        ("focus has (%d+)%% reduced cooldown recovery rate", Func(|a| Some(vec![mk_mod("FocusCooldownRecovery", "INC", num(-a.n(1)), vec![tg(stag("Condition", vec![("var", s("Focused"))]))])]))),
        ("(%d+)%% more frozen legion and general's cry cooldown recovery rate", Func(|a| Some(vec![
            mk_mod("CooldownRecovery", "MORE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Frozen Legion"), s("General's Cry")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("flamethrower, seismic and lightning spire trap have (%d+)%% increased cooldown recovery rate", Func(|a| Some(vec![
            mk_mod("CooldownRecovery", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Flamethrower Trap"), s("Seismic Trap"), s("Lightning Spire Trap")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("flamethrower, seismic and lightning spire trap have %-(%d+) cooldown uses?", Func(|a| Some(vec![
            mk_mod("AdditionalCooldownUses", "BASE", num(-a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Flamethrower Trap"), s("Seismic Trap"), s("Lightning Spire Trap")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("right ring slot: shockwave has %+(%d+) to cooldown uses?", Func(|a| Some(vec![
            mk_mod("AdditionalCooldownUses", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Shockwave"))])), tg(stag("SlotNumber", vec![("num", num(2.0))]))]),
        ]))),
        ("flameblast starts with (%d+) additional stages", Func(|a| Some(vec![
            mk_mod("Multiplier:FlameblastMinimumStage", "BASE", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Buff")), ("unscalable", b(true))]))]),
        ]))),
        ("incinerate starts with (%d+) additional stages", Func(|a| Some(vec![
            mk_mod("Multiplier:IncinerateMinimumStage", "BASE", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Buff")), ("unscalable", b(true))]))]),
        ]))),
        ("%+([%d%.]+) seconds to flameblast and incinerate cooldown", Func(|a| Some(vec![
            wrap("ExtraSkillMod", mk_mod("SkillData", "LIST", mapv(vec![("key", s("cooldown")), ("value", num(0.0))]), vec![]),
                vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Incinerate"), s("Flameblast")])), ("includeTransfigured", b(true))]))]),
            mk_mod("CooldownRecovery", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Incinerate"), s("Flameblast")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("(%d+)%% chance to deal double damage with attacks if attack time is longer than 1 second", Func(|a| Some(vec![
            mk_mod("DoubleDamageChance", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("OneSecondAttackTime"))]))]),
        ]))),
        ("elusive also grants %+(%d+)%% to critical strike multiplier for skills supported by nightblade", Func(|a| Some(vec![mk_mod("NightbladeElusiveCritMultiplier", "BASE", num(a.n(1)), vec![])]))),
        ("skills supported by nightblade have (%d+)%% increased effect of elusive", Func(|a| Some(vec![mk_mod("NightbladeSupportedElusiveEffect", "INC", num(a.n(1)), vec![])]))),
        ("nearby enemies are scorched", Mods(vec![
            wrap("EnemyModifier", flag_mod("Condition:Scorched", vec![]), vec![]),
            mk_mod("ScorchBase", "BASE", num(10.0), vec![]),
        ])),
        ("hits have (%d+)%% chance to ignore enemy monster physical damage reduction", Func(|a| Some(vec![mk_mod("PartialIgnoreEnemyPhysicalDamageReduction", "BASE", num(a.n(1)), vec![])]))),
        ("attacks you use yourself have (%d+)%% more attack speed", Func(|a| Some(vec![
            mk_mod("Speed", "MORE", num(a.n(1)), vec![flags(mf::Attack),
                tg(stag("SkillType", vec![("neg", b(true)), ("skillTypeList", list(vec![num(26.0), num(36.0), num(33.0), num(37.0)]))])), // SummonsTotem, RemoteMined, Trapped, Triggered
                tg(stag("Condition", vec![("neg", b(true)), ("var", s("usedByMirage"))])),
            ]),
        ]))),
        ("attacks you use yourself repeat an additional time", Mods(vec![
            mk_mod("RepeatCount", "BASE", num(1.0), vec![flags(mf::Attack),
                tg(stag("SkillType", vec![("neg", b(true)), ("skillTypeList", list(vec![num(26.0), num(36.0), num(33.0), num(37.0)]))])),
                tg(stag("Condition", vec![("neg", b(true)), ("var", s("usedByMirage"))])),
                tg(stag("Condition", vec![("varList", list(vec![s("averageRepeat"), s("alwaysFinalRepeat")]))])),
            ]),
        ])),
        ("final repeat of attack skills deals (%d+)%% more damage", Func(|a| Some(vec![mk_mod("RepeatFinalDamage", "MORE", num(a.n(1)), vec![kw(kf::Attack)])]))),
        ("non%-travel attack skills repeat an additional time", Mods(vec![
            mk_mod("RepeatCount", "BASE", num(1.0), vec![kw(kf::Attack),
                tg(stag("SkillType", vec![("skillType", num(79.0)), ("neg", b(true))])), // SkillType.Travel
                tg(stag("Condition", vec![("varList", list(vec![s("averageRepeat"), s("alwaysFinalRepeat")]))])),
            ]),
        ])),
        ("viper strike and pestilent strike deal (%d+)%% increased attack damage per frenzy charge", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Attack), tg(stag("Multiplier", vec![("var", s("FrenzyCharge"))])), tg(stag("SkillName", vec![("skillNameList", list(vec![s("Viper Strike"), s("Pestilent Strike")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("shield charge and chain hook have (%d+)%% increased attack speed per (%d+) rampage kills", Func(|a| Some(vec![
            mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Attack), tg(stag("Multiplier", vec![("var", s("Rampage")), ("div", s(a.s(2).to_string())), ("limit", num(1000.0 / a.n(2))), ("limitTotal", b(true))])), tg(stag("SkillName", vec![("skillNameList", list(vec![s("Shield Charge"), s("Chain Hook")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("tectonic slam and infernal blow deal (%d+)%% increased attack damage per (%d+) armour", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![flags(mf::Attack), tg(stag("PerStat", vec![("stat", s("Armour")), ("div", s(a.s(2).to_string()))])), tg(stag("SkillName", vec![("skillNameList", list(vec![s("Tectonic Slam"), s("Infernal Blow")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("frozen sweep deals (%d+)%% less damage", Func(|a| Some(vec![mk_mod("Damage", "MORE", num(-a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Frozen Sweep")), ("includeTransfigured", b(true))]))])]))),
        ("ice trap and lightning trap damage penetrates (%d+)%% of enemy elemental resistances", Func(|a| Some(vec![
            mk_mod("LightningPenetration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Ice Trap"), s("Lightning Trap")])), ("includeTransfigured", b(true))]))]),
            mk_mod("ColdPenetration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Ice Trap"), s("Lightning Trap")])), ("includeTransfigured", b(true))]))]),
            mk_mod("FirePenetration", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Ice Trap"), s("Lightning Trap")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("volatile dead and cremation penetrate (%d+)%% fire resistance per (%d+) dexterity", Func(|a| Some(vec![
            mk_mod("FirePenetration", "BASE", num(a.n(1)), vec![tg(stag("PerStat", vec![("stat", s("Dex")), ("div", s(a.s(2).to_string()))])), tg(stag("SkillName", vec![("skillNameList", list(vec![s("Volatile Dead"), s("Cremation")])), ("includeTransfigured", b(true))]))]),
        ]))),
        ("regenerate (%d+) mana per second while any enemy is in your righteous fire or scorching ray", Func(|a| Some(vec![
            mk_mod("ManaRegen", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("InRFOrScorchingRay"))]))]),
        ]))),
        ("%+(%d+)%% to wave of conviction damage over time multiplier per ([%d%.]+) seconds of duration expired", Func(|a| Some(vec![mk_mod("WaveOfConvictionDurationDotMulti", "INC", num(a.n(1)), vec![])]))),
        ("when an enemy hit deals elemental damage to you, their resistance to those elements becomes zero for (%d+) seconds", Mods(vec![flag_mod("Condition:HaveTrickstersSmile", vec![])])),
        // Conditional Player Quantity / Rarity
        ("(%d+)%% increased quantity of items dropped by slain normal enemies", Func(|a| Some(vec![mk_mod("LootQuantityNormalEnemies", "INC", num(a.n(1)), vec![])]))),
        ("(%d+)%% increased rarity of items dropped by slain magic enemies", Func(|a| Some(vec![mk_mod("LootRarityMagicEnemies", "INC", num(a.n(1)), vec![])]))),
        // Pantheon: Soul of Tukohama support
        ("while stationary, gain ([%d%.]+)%% of life regenerated per second every second, up to a maximum of (%d+)%%", Func(|a| Some(vec![
            mk_mod("LifeRegenPercent", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("StationarySeconds")), ("limit", num(a.n(2))), ("limitTotal", b(true))])), tg(stag("Condition", vec![("var", s("Stationary"))]))]),
        ]))),
        // Pantheon: Soul of Ryslatha support
        ("life flasks gain (%d+) charges? every (%d+) seconds if you haven't used a life flask recently", Func(|a| Some(vec![
            mk_mod("LifeFlaskChargesGenerated", "BASE", num(a.n(1) / a.n(2)), vec![tg(stag("Condition", vec![("var", s("UsingLifeFlask")), ("neg", b(true))]))]),
        ]))),
        // Skill-specific enchantment modifiers
        ("(%d+)%% increased decoy totem life", Func(|a| Some(vec![mk_mod("TotemLife", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Decoy Totem"))]))])]))),
        ("(%d+)%% increased ice spear critical strike chance in second form", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Ice Spear")), ("includeTransfigured", b(true))])), tg(stag("SkillPart", vec![("skillPartList", list(vec![num(2.0), num(4.0)]))]))]),
        ]))),
        ("shock nova ring deals (%d+)%% increased damage", Func(|a| Some(vec![
            mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Shock Nova")), ("includeTransfigured", b(true))])), tg(stag("SkillPart", vec![("skillPart", num(1.0))]))]),
        ]))),
        ("enemies affected by bear trap take (%d+)%% increased damage from trap or mine hits", Func(|a| Some(vec![
            wrap("ExtraSkillMod", wrap("EnemyModifier", mk_mod("TrapMineDamageTaken", "INC", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Debuff"))]))]), vec![]),
                vec![tg(stag("SkillName", vec![("skillName", s("Bear Trap")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("blade vortex has %+(%d+)%% to critical strike multiplier for each blade", Func(|a| Some(vec![
            mk_mod("CritMultiplier", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("BladeVortexBlade"))])), tg(stag("SkillName", vec![("skillName", s("Blade Vortex")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("burning arrow has (%d+)%% increased debuff effect", Func(|a| Some(vec![mk_mod("DebuffEffect", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Burning Arrow"))]))])]))),
        ("double strike has a (%d+)%% chance to deal double damage to bleeding enemies", Func(|a| Some(vec![
            mk_mod("DoubleDamageChance", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Bleeding"))])), tg(stag("SkillName", vec![("skillName", s("Double Strike")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("frost bomb has (%d+)%% increased debuff duration", Func(|a| Some(vec![mk_mod("SecondaryDuration", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Frost Bomb"))]))])]))),
        ("incinerate has %+(%d+) to maximum stages", Func(|a| Some(vec![mk_mod("Multiplier:IncinerateMaxStages", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Incinerate"))]))])]))),
        ("perforate creates %+(%d+) spikes?", Func(|a| Some(vec![mk_mod("Multiplier:PerforateMaxSpikes", "BASE", num(a.n(1)), vec![])]))),
        ("scourge arrow has (%d+)%% chance to poison per stage", Func(|a| Some(vec![
            mk_mod("PoisonChance", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Scourge Arrow")), ("includeTransfigured", b(true))])), tg(stag("Multiplier", vec![("var", s("ScourgeArrowStage"))]))]),
        ]))),
        ("winter orb has %+(%d+) maximum stages", Func(|a| Some(vec![mk_mod("Multiplier:WinterOrbMaxStages", "BASE", num(a.n(1)), vec![])]))),
        ("summoned holy relics have (%d+)%% increased buff effect", Func(|a| Some(vec![mk_mod("BuffEffect", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Summon Holy Relic")), ("includeTransfigured", b(true))]))])]))),
        ("%+(%d+) to maximum virulence", Func(|a| Some(vec![mk_mod("Multiplier:VirulenceStacksMax", "BASE", num(a.n(1)), vec![])]))),
        ("winter orb has (%d+)%% increased area of effect per stage", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Winter Orb"))])), tg(stag("Multiplier", vec![("var", s("WinterOrbStage"))]))]),
        ]))),
        ("wintertide brand has %+(%d+) to maximum stages", Func(|a| Some(vec![mk_mod("Multiplier:WintertideBrandMaxStages", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Wintertide Brand"))]))])]))),
        ("wave of conviction's exposure applies (%-%d+)%% elemental resistance", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("purge_expose_resist_%_matching_highest_element_damage")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Wave of Conviction"))]))]),
        ]))),
        ("wave of conviction's exposure applies an extra (%-%d+)%% to elemental resistance", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("purge_expose_resist_%_matching_highest_element_damage")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Wave of Conviction"))]))]),
        ]))),
        ("arcane cloak spends an additional (%d+)%% of current mana", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("arcane_cloak_consume_%_of_mana")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Arcane Cloak"))]))]),
        ]))),
        ("arcane cloak grants life regeneration equal to (%d+)%% of mana spent per second", Func(|a| Some(vec![
            wrap("ExtraSkillMod", mk_mod("LifeRegen", "BASE", num(a.n(1) / 100.0), vec![tg(stag("Multiplier", vec![("var", s("ArcaneCloakConsumedMana"))])), tg(stag("GlobalEffect", vec![("effectType", s("Buff"))]))]),
                vec![tg(stag("SkillName", vec![("skillName", s("Arcane Cloak"))]))]),
        ]))),
        ("caustic arrow has (%d+)%% chance to inflict withered on hit for (%d+) seconds base duration", Mods(vec![
            wrap("ExtraSkillMod", flag_mod("Condition:CanWither", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Caustic Arrow")), ("includeTransfigured", b(true))]))]),
        ])),
        ("venom gyre has a (%d+)%% chance to inflict withered for (%d+) seconds on hit", Mods(vec![
            wrap("ExtraSkillMod", flag_mod("Condition:CanWither", vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Venom Gyre"))]))]),
        ])),
        ("sigil of power's buff also grants (%d+)%% increased critical strike chance per stage", Func(|a| Some(vec![
            mk_mod("CritChance", "INC", num(a.n(1)), vec![
                tg(stag("Multiplier", vec![("var", s("SigilOfPowerStage")), ("limit", num(4.0))])),
                tg(stag("GlobalEffect", vec![("effectType", s("Buff")), ("effectName", s("Sigil of Power"))])),
            ]),
        ]))),
        ("cobra lash chains (%d+) additional times", Func(|a| Some(vec![
            wrap("ExtraSkillMod", mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![]), vec![tg(stag("SkillName", vec![("skillName", s("Cobra Lash"))]))]),
        ]))),
        ("general's cry has ([%+%-]%d) to maximum number of mirage warriors", Func(|a| Some(vec![mk_mod("GeneralsCryDoubleMaxCount", "BASE", num(a.n(1)), vec![])]))),
        ("([%+%-]%d) to maximum blade flurry stages", Func(|a| Some(vec![
            mk_mod("Multiplier:BladeFlurryMaxStages", "BASE", num(a.n(1)), vec![]),
            mk_mod("Multiplier:BladeFlurryofIncisionMaxStages", "BASE", num(a.n(1)), vec![]),
        ]))),
        ("steelskin buff can take (%d+)%% increased amount of damage", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("steelskin_damage_limit_+%")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Steelskin"))]))]),
        ]))),
        ("hydrosphere has (%d+)%% increased pulse frequency", Func(|a| Some(vec![mk_mod("HydroSphereFrequency", "INC", num(a.n(1)), vec![])]))),
        ("void sphere has (%d+)%% increased pulse frequency", Func(|a| Some(vec![mk_mod("VoidSphereFrequency", "INC", num(a.n(1)), vec![])]))),
        ("shield crush central wave has (%d+)%% more area of effect", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "MORE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Shield Crush")), ("includeTransfigured", b(true))])), tg(stag("SkillPart", vec![("skillPart", num(2.0))]))]),
        ]))),
        ("storm rain has (%d+)%% increased beam frequency", Func(|a| Some(vec![mk_mod("StormRainBeamFrequency", "INC", num(a.n(1)), vec![])]))),
        ("voltaxic burst deals (%d+)%% increased damage per ([%d%.]+) seconds of duration", Func(|a| Some(vec![mk_mod("VoltaxicDurationIncDamage", "INC", num(a.n(1)), vec![])]))),
        ("earthquake deals (%d+)%% increased damage per ([%d%.]+) seconds duration", Func(|a| Some(vec![mk_mod("EarthquakeDurationIncDamage", "INC", num(a.n(1)), vec![])]))),
        ("consecrated ground from holy flame totem applies (%d+)%% increased damage taken to enemies", Func(|a| Some(vec![
            wrap("EnemyModifier", mk_mod("DamageTakenConsecratedGround", "INC", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("OnConsecratedGround"))]))]), vec![]),
        ]))),
        ("consecrated ground from purifying flame applies (%d+)%% increased damage taken to enemies", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("consecrated_ground_enemy_damage_taken_+%")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Purifying Flame")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("enemies drenched by hydrosphere have cold and lightning exposure, applying (%-%d+)%% to resistances", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("water_sphere_cold_lightning_exposure_%")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Hydrosphere"))]))]),
        ]))),
        ("frost shield has %+(%d+) to maximum life per stage", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("frost_globe_health_per_stage")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Frost Shield"))]))]),
        ]))),
        ("flame wall grants (%d+) to (%d+) added fire damage to projectiles", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("flame_wall_minimum_added_fire_damage")), ("value", s(a.s(1).to_string()))]), vec![tg(stag("SkillName", vec![("skillName", s("Flame Wall"))]))]),
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("flame_wall_maximum_added_fire_damage")), ("value", s(a.s(2).to_string()))]), vec![tg(stag("SkillName", vec![("skillName", s("Flame Wall"))]))]),
        ]))),
        ("plague bearer buff grants %+(%d+)%% to poison damage over time multiplier while infecting", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("corrosive_shroud_poison_dot_multiplier_+_while_aura_active")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Plague Bearer"))]))]),
        ]))),
        ("(%d+)%% increased lightning trap lightning ailment effect", Func(|a| Some(vec![
            mk_mod("ExtraSkillStat", "LIST", mapv(vec![("key", s("shock_effect_+%")), ("value", num(a.n(1)))]), vec![tg(stag("SkillName", vec![("skillName", s("Lightning Trap")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("wild strike's beam chains an additional (%d+) times", Func(|a| Some(vec![
            wrap("ExtraSkillMod", mk_mod("ChainCountMax", "BASE", num(a.n(1)), vec![]),
                vec![tg(stag("SkillName", vec![("skillName", s("Wild Strike")), ("includeTransfigured", b(true))])), tg(stag("SkillPart", vec![("skillPart", num(4.0))]))]),
        ]))),
        ("energy blades have (%d+)%% increased attack speed", Func(|a| Some(vec![mk_mod("EnergyBladeAttackSpeed", "INC", num(a.n(1)), vec![])]))),
        ("ensnaring arrow has (%d+)%% increased debuff effect", Func(|a| Some(vec![mk_mod("DebuffEffect", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Ensnaring Arrow"))]))])]))),
        ("unearth spawns corpses with ([%+%-]%d) level", Func(|a| Some(vec![mk_mod("CorpseLevel", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Unearth"))]))])]))),
        ("seismic trap releases an additional wave", Mods(vec![mk_mod("MaximumWaves", "BASE", num(1.0), vec![tg(stag("SkillName", vec![("skillName", s("Seismic Trap")), ("includeTransfigured", b(true))]))])])),
        ("lightning spire trap strikes an additional area", Mods(vec![mk_mod("MaximumWaves", "BASE", num(1.0), vec![tg(stag("SkillName", vec![("skillName", s("Lightning Spire Trap")), ("includeTransfigured", b(true))]))])])),
        ("explosive trap causes (%d+) additional smaller explosions", Func(|a| Some(vec![
            mk_mod("SmallExplosions", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillNameList", list(vec![s("Explosive Trap"), s("Explosive Trap of Swells")]))]))]),
        ]))),
        ("frozen sweep deals (%d+)%% increased damage", Func(|a| Some(vec![mk_mod("Damage", "INC", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Frozen Sweep")), ("includeTransfigured", b(true))]))])]))),
        ("(%d+)%% increased attack speed with snipe", Func(|a| Some(vec![mk_mod("Speed", "INC", num(a.n(1)), vec![flags(mf::Attack), tg(stag("SkillName", vec![("skillName", s("Snipe"))]))])]))),
        ("%+(%d+) to maximum snipe stages", Func(|a| Some(vec![
            mk_mod("Multiplier:SnipeStagesMax", "BASE", num(a.n(1)), vec![tg(stag("GlobalEffect", vec![("effectType", s("Buff")), ("unscalable", b(true))]))]),
        ]))),
        ("chain hook has %+([%d%.]+) metres? to radius per (%d+) rage", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "BASE", num(a.n(1) * 10.0), vec![tg(stag("PerStat", vec![("stat", s("Rage")), ("div", num(a.n(2)))])), tg(stag("SkillName", vec![("skillName", s("Chain Hook")), ("includeTransfigured", b(true))]))]),
        ]))),
        ("%+([%d%.]+) metres? to discharge radius", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "BASE", num(a.n(1) * 10.0), vec![tg(stag("SkillName", vec![("skillName", s("Discharge")), ("includeTransfigured", b(true))]))]),
        ]))),
        // Alternate Quality
        ("quality does not increase physical damage", Mods(vec![mk_mod("AlternateQualityWeapon", "BASE", num(1.0), vec![])])),
        ("(%d+)%% increased critical strike chance per 4%% quality", Func(|a| Some(vec![mk_mod("AlternateQualityLocalCritChancePer4Quality", "INC", num(a.n(1)), vec![])]))),
        ("grants (%d+)%% increased accuracy per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("Accuracy", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("(%d+)%% increased attack speed per 8%% quality", Func(|a| Some(vec![mk_mod("AlternateQualityLocalAttackSpeedPer8Quality", "INC", num(a.n(1)), vec![])]))),
        ("%+(%d+) weapon range per 10%% quality", Func(|a| Some(vec![mk_mod("AlternateQualityLocalWeaponRangePer10Quality", "BASE", num(a.n(1)), vec![])]))),
        ("%+([%d%.]+) metres? to weapon range per 10%% quality", Func(|a| Some(vec![mk_mod("AlternateQualityLocalWeaponRangePer10Quality", "BASE", num(a.n(1) * 10.0), vec![])]))),
        ("grants (%d+)%% increased elemental damage per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("ElementalDamage", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants (%d+)%% increased area of effect per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("AreaOfEffect", "INC", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("quality does not increase defences", Mods(vec![mk_mod("AlternateQualityArmour", "BASE", num(1.0), vec![])])),
        ("grants %+(%d+) to maximum life per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("Life", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+) to maximum mana per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("Mana", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+) to strength per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("Str", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+) to dexterity per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("Dex", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+) to intelligence per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("Int", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+)%% to fire resistance per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("FireResist", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+)%% to cold resistance per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("ColdResist", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("grants %+(%d+)%% to lightning resistance per (%d+)%% quality", Func(|a| Some(vec![
            mk_mod("LightningResist", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("QualityOn{SlotName}")), ("div", num(a.n(2)))]))]),
        ]))),
        ("%+(%d+)%% to quality", Func(|a| Some(vec![mk_mod("Quality", "BASE", num(a.n(1)), vec![])]))),
        ("infernal blow debuff deals an additional (%d+)%% of damage per charge", Func(|a| Some(vec![
            mk_mod("DebuffEffect", "BASE", num(a.n(1)), vec![tg(stag("SkillName", vec![("skillName", s("Infernal Blow")), ("includeTransfigured", b(true))]))]),
        ]))),
        // Legion modifiers
        ("bathed in the blood of (%d+) sacrificed in the name of (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("carved to glorify (%d+) new faithful converted by high templar (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("commanded leadership over (%d+) warriors under (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("commissioned (%d+) coins to commemorate (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("denoted service of (%d+) dekhara in the akhara of (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("remembrancing (%d+) songworthy deeds by the line of (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("subjugating (%d+) souls in the thrall of (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("binding (%d+) souls to phylacteries to sustain (.+)", Func(|a| Some(vec![jewel_data_conquered_by(a.n(1), a.s(2))]))),
        ("passives in radius are conquered by the (%D+)", Mods(vec![])),
        ("passives affected are conquered by the abyssal", Mods(vec![])),
        ("historic", Mods(vec![])),
        // Tattoos
        ("+(%d+) to maximum life per allocated journey tattoo of the body", Func(|a| Some(vec![
            mk_mod("Life", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("JourneyTattooBody"))]))]),
            mk_mod("Multiplier:JourneyTattooBody", "BASE", num(1.0), vec![]),
        ]))),
        ("+(%d+) to maximum energy shield per allocated journey tattoo of the soul", Func(|a| Some(vec![
            mk_mod("EnergyShield", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("JourneyTattooSoul"))]))]),
            mk_mod("Multiplier:JourneyTattooSoul", "BASE", num(1.0), vec![]),
        ]))),
        ("+(%d+) to maximum mana per allocated journey tattoo of the mind", Func(|a| Some(vec![
            mk_mod("Mana", "BASE", num(a.n(1)), vec![tg(stag("Multiplier", vec![("var", s("JourneyTattooMind"))]))]),
            mk_mod("Multiplier:JourneyTattooMind", "BASE", num(1.0), vec![]),
        ]))),
        // Display-only modifiers
        ("extra gore", Mods(vec![])),
        ("prefixes:", Mods(vec![])),
        ("suffixes:", Mods(vec![])),
        ("while your passive skill tree connects to a class' starting location, you gain:", Mods(vec![])),
        ("socketed lightning spells [hd][ae][va][el] (%d+)%% increased spell damage if triggered", Mods(vec![])),
        ("manifeste?d? dancing dervishe?s? disables both weapon slots", Mods(vec![])),
        ("manifeste?d? dancing dervishe?s? dies? when rampage ends", Mods(vec![])),
        ("survival", Mods(vec![])),
        ("you can have two different banners at the same time", Mods(vec![])),
        ("[%+%-](%d+) prefix modifiers? allowed", Mods(vec![])),
        ("[%+%-](%d+) suffix modifiers? allowed", Mods(vec![])),
        ("can have a second enchantment modifier", Mods(vec![])),
        ("can have (%d+) additional enchantment modifiers", Mods(vec![])),
        ("this item can be anointed by cassia", Mods(vec![])),
        ("can be anointed", Mods(vec![])),
        ("implicit modifiers cannot be changed", Mods(vec![])),
        ("has a crucible passive skill tree", Mods(vec![])),
        ("has elder, shaper and all conqueror influences", Mods(vec![])),
        ("has a two handed sword crucible passive skill tree", Mods(vec![])),
        ("has a crucible passive skill tree with only support passive skills", Mods(vec![])),
        ("crucible passive skill tree is removed if this modifier is removed", Mods(vec![])),
        ("all sockets are white", Mods(vec![])),
        ("cannot roll (%a+) modifiers", Mods(vec![])),
        ("cannot roll modifiers of non%-(%a+) damage types", Mods(vec![])),
        ("every (%d+) seconds, regenerate (%d+)%% of life over one second", Func(|a| Some(vec![
            mk_mod("LifeRegenPercent", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstFull"))]))]),
            mk_mod("LifeRegenPercent", "BASE", num(a.n(2) / a.n(1)), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstAvg"))]))]),
        ]))),
        ("every (%d+) seconds, regenerate (%d+)%% of life over one second if (%d+) (%a+) items are equipped", Func(|a| Some(vec![
            mk_mod("LifeRegenPercent", "BASE", num(a.n(2)), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstFull"))])), tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(4))))), ("threshold", num(a.n(3)))]))]),
            mk_mod("LifeRegenPercent", "BASE", num(a.n(2) / a.n(1)), vec![tg(stag("Condition", vec![("var", s("LifeRegenBurstAvg"))])), tg(stag("MultiplierThreshold", vec![("var", s(format!("{}Item", first_upper(a.s(4))))), ("threshold", num(a.n(3)))]))]),
        ]))),
        ("take no extra damage from critical strikes", Mods(vec![mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))]))])])),
        ("take no extra damage from critical strikes if you've cast (.-) in the past (%d+) seconds", Func(|a| Some(vec![
            mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![
                tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])),
                tg(stag("Condition", vec![("var", s(format!("SelfCast{}", pascal_no_spaces(a.s(1)))))])),
            ]),
        ]))),
        ("take no extra damage from critical strikes if you have a magic ring in left slot", Mods(vec![
            mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![tg(stag("GlobalEffect", vec![("effectType", s("Global")), ("unscalable", b(true))])), tg(stag("Condition", vec![("var", s("MagicItemInRing 1"))]))]),
        ])),
        ("take no extra damage from critical strikes if energy shield recharge started recently", Mods(vec![mk_mod("ReduceCritExtraDamage", "BASE", num(100.0), vec![tg(stag("Condition", vec![("var", s("EnergyShieldRechargeRecently"))]))])])),
        ("you take (%d+)%% reduced extra damage from critical strikes while affected by determination", Func(|a| Some(vec![
            mk_mod("ReduceCritExtraDamage", "BASE", num(a.n(1)), vec![tg(stag("Condition", vec![("var", s("AffectedByDetermination"))]))]),
        ]))),
        ("you take (%d+)%% reduced extra damage from critical strikes", Func(|a| Some(vec![mk_mod("ReduceCritExtraDamage", "BASE", num(a.n(1)), vec![])]))),
        ("you take (%d+)%% increased extra damage from critical strikes", Func(|a| Some(vec![mk_mod("ReduceCritExtraDamage", "BASE", num(-a.n(1)), vec![])]))),
        ("you take (%d+)%% reduced extra damage from critical strikes while you have no power charges", Func(|a| Some(vec![
            mk_mod("ReduceCritExtraDamage", "BASE", num(a.n(1)), vec![tg(stag("StatThreshold", vec![("stat", s("PowerCharges")), ("threshold", num(0.0)), ("upper", b(true))]))]),
        ]))),
        ("you take (%d+)%% reduced extra damage from critical strikes by poisoned enemies", Func(|a| Some(vec![
            mk_mod("ReduceCritExtraDamage", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Poisoned"))]))]),
        ]))),
        ("you take (%d+)%% reduced extra damage from critical strikes by cursed enemies", Func(|a| Some(vec![
            mk_mod("ReduceCritExtraDamage", "BASE", num(a.n(1)), vec![tg(stag("ActorCondition", vec![("actor", s("enemy")), ("var", s("Cursed"))]))]),
        ]))),
        ("nearby allies have (%d+)%% chance to block attack damage per (%d+) strength you have", Func(|a| Some(vec![
            extra_aura(mk_mod("BlockChance", "BASE", num(a.n(1)), vec![]), true, vec![tg(stag("PerStat", vec![("stat", s("Str")), ("div", num(a.n(2)))]))]),
        ]))),
        ("physical skills have (%d+)%% increased duration per (%d+) intelligence", Func(|a| Some(vec![
            mk_mod("Duration", "INC", num(a.n(1)), vec![kw(kf::Physical), tg(stag("PerStat", vec![("stat", s("Int")), ("div", num(a.n(2)))]))]),
        ]))),
        ("y?o?u?r? ?maximum energy shield is equal to (%d+)%% of y?o?u?r? ?maximum life", Func(|a| Some(vec![
            mk_mod("EnergyShield", "OVERRIDE", num(1.0), vec![tg(stag("PercentStat", vec![("stat", s("Life")), ("percent", num(a.n(1)))]))]),
        ]))),
        ("immun[ei]t?y? to elemental ailments while bleeding", Mods(vec![flag_mod("ElementalAilmentImmune", vec![tg(stag("Condition", vec![("var", s("Bleeding"))]))])])),
        ("mana is increased by (%d+)%% of overcapped lightning resistance", Func(|a| Some(vec![
            flag_mod("ManaIncreasedByOvercappedLightningRes", vec![]),
            mk_mod("Mana", "INC", num(a.n(1) / 100.0), vec![tg(stag("PerStat", vec![("stat", s("LightningResistOverCap"))]))]),
        ]))),
        // handled in item parsing
        ("%d+%% [ir][ne][cd][ru][ec][ae][sd]e?d? ?[%a%s]* modifier magnitudes", Mods(vec![])),
        ("%d+%% [ir][ne][cd][ru][ec][ae][sd]e?d? effect of [sp][ur][fe]fixes", Mods(vec![])),
        ("[%a%s]* modifier magnitudes are doubled", Mods(vec![])),
        // handled in the item tab's corrupt menu: this may not be correct, but the vestigial
        // implicit in-game only ever contains this line. If GGG later adds a line stating how
        // many implicits the item can have, these two modifiers should be swapped.
        ("can be modified while corrupted", Mods(vec![mk_mod("CorruptImplicitCount", "BASE", num(5.0), vec![])])),
        ("can have up to 5 implicit modifiers while item has this modifier", Mods(vec![])),
    ]
}


/// `conquerorList` (line 41-69 in the original): conqueror name -> `{ id, type }`, where `id` is
/// usually a number but is a string like "2_v2" for a few reworked conquerors.
fn conqueror_lookup(name: &str) -> Option<PVal> {
    let (id, ty): (PVal, &str) = match name {
        "xibaqua" => (num(1.0), "vaal"),
        "zerphi" => (num(2.0), "vaal"),
        "doryani" => (num(3.0), "vaal"),
        "ahuana" => (s("2_v2"), "vaal"),
        "deshret" => (num(1.0), "maraketh"),
        "asenath" => (num(2.0), "maraketh"),
        "nasima" => (num(3.0), "maraketh"),
        "balbala" => (s("1_v2"), "maraketh"),
        "cadiro" => (num(1.0), "eternal"),
        "victario" => (num(2.0), "eternal"),
        "chitus" => (num(3.0), "eternal"),
        "caspiro" => (s("3_v2"), "eternal"),
        "kaom" => (num(1.0), "karui"),
        "rakiata" => (num(2.0), "karui"),
        "kiloava" => (num(3.0), "karui"),
        "akoya" => (s("3_v2"), "karui"),
        "venarius" => (num(1.0), "templar"),
        "dominus" => (num(2.0), "templar"),
        "avarius" => (num(3.0), "templar"),
        "maxarius" => (s("1_v2"), "templar"),
        "vorana" => (num(1.0), "kalguur"),
        "uhtred" => (num(2.0), "kalguur"),
        "medved" => (num(3.0), "kalguur"),
        "tecrod" => (num(1.0), "abyss_murderous"),
        "ulaman" => (num(1.0), "abyss_searching"),
        "kurgal" => (num(1.0), "abyss_hypnotic"),
        "amanamu" => (num(1.0), "abyss_ghastly"),
        "zorath" => (num(1.0), "abyss_special"),
        _ => return None,
    };
    Some(mapv(vec![("id", id), ("type", s(ty))]))
}

/// `mod("JewelData", "LIST", { key = "conqueredBy", value = { id = num, conqueror = conquerorList[name:lower()] } })`.
/// `conqueror` is only present when the name resolves (Lua: a nil table field is never stored).
fn jewel_data_conquered_by(id: f64, name: &str) -> PMod {
    let mut value_fields = vec![("id", num(id))];
    if let Some(c) = conqueror_lookup(&name.to_lowercase()) {
        value_fields.push(("conqueror", c));
    }
    mk_mod("JewelData", "LIST", mapv(vec![("key", s("conqueredBy")), ("value", mapv(value_fields))]), vec![])
}

/// The two `for _, name in ipairs(...)` loops at the end of the Lua table (lines 5943-5949) that
/// add one entry per keystone name, built from game data rather than written as literal patterns.
pub fn dynamic_entries() -> Vec<(String, SpecialVal)> {
    use SpecialVal::Mods;
    let mut v: Vec<(String, SpecialVal)> = Vec::new();
    for name in helpers::keystone_names() {
        v.push((
            name.to_lowercase(),
            Mods(vec![
                mk_mod("Keystone", "LIST", s(name.clone()), vec![]),
                flag_mod(format!("Condition:Have{}", pascal_no_spaces(name)), vec![]),
            ]),
        ));
    }
    for name in helpers::cluster_jewel_keystone_names() {
        v.push((name.to_lowercase(), Mods(vec![mk_mod("Keystone", "LIST", s(name.clone()), vec![])])));
    }
    v
}

