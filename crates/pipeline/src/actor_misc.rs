//! `doActorMisc` (Modules/CalcPerform.lua:636-978), player half, `env.mode_combat` branch only.
//! Adds the misc self-buff/debuff mods (Consecrated
//! Ground regen, Onslaught, Arcane Surge, Tailwind, Adrenaline, Elusive, ailments on self, Rage, ...)
//! that upstream merges just before `calcs.defence`. Called once, after the buff merge
//! (CalcPerform.lua:3491).
//!
//! Named gaps (need main-skill state this crate's `Env` does not carry yet):
//! - Elusive's `SupportedByNightblade`: treated as false.
//! - Fortify's `skillModList`/`skillCfg` and Rage's `skillCfg`: read from the player store with no cfg.
//! - Spirit Infusion / Shepherd of Souls (SkillType-tagged mods): not emitted.
//! - `env.partyMembers` (alliedFortify): treated as 0.
use pom_calc::perform::FlaskInput;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modstore::types::Cfg;
use pom_engine::modstore::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use std::sync::Arc;

const ATTACK: u64 = 0x1;
const SPELL: u64 = 0x2;
const CAST: u64 = 0x10;

fn s(n: &str) -> Sym {
    Sym::new(n)
}
fn mk(name: &str, ty: ModType, value: f64, source: &str, flags: u64) -> Mod {
    Mod { name: s(name), ty, value: Value::Num(value), flags, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}
fn flagm(name: &str, source: &str) -> Mod {
    Mod { name: s(name), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}
fn sum(st: &ModStore, ty: ModType, names: &[&str]) -> f64 {
    let n: Vec<Sym> = names.iter().map(|x| s(x)).collect();
    st.sum(ty, None, &n)
}
fn flag(st: &ModStore, names: &[&str]) -> bool {
    let n: Vec<Sym> = names.iter().map(|x| s(x)).collect();
    st.flag(None, &n)
}
fn more(st: &ModStore, names: &[&str]) -> f64 {
    let n: Vec<Sym> = names.iter().map(|x| s(x)).collect();
    st.more(None, &n)
}
fn over(st: &ModStore, name: &str) -> Option<f64> {
    st.override_(None, &[s(name)]).and_then(|v| v.num())
}
fn max_(st: &ModStore, name: &str) -> Option<f64> {
    st.max(None, &[s(name)])
}
fn calc_mod(st: &ModStore, name: &str) -> f64 {
    pom_calc::tools::mod_(st, None, &[s(name)])
}

fn clone_store(st: &ModStore) -> ModStore {
    use pom_engine::modstore::store::Backing;
    ModStore {
        parent: st.parent.clone(),
        actor: st.actor.clone(),
        conditions: st.conditions.clone(),
        multipliers: st.multipliers.clone(),
        backing: match &st.backing {
            Backing::List(v) => Backing::List(v.clone()),
            Backing::Db(h) => Backing::Db(h.clone()),
        },
    }
}

pub fn do_actor_misc(
    player: &mut ModStore,
    enemy: &mut ModStore,
    output: &mut pom_engine::fxhash::HashMap<String, f64>,
    flasks: &[FlaskInput],
    config_input: &pom_engine::fxhash::HashMap<String, f64>,
    main: Option<&pom_skills::assemble::ComputedSkill>,
    allied_fortify: f64,
) {
    // doActorMisc: "Add misc buffs/debuffs" is all `if env.mode_combat then` (CalcPerform.lua:645).
    if !pom_calc::setup::buff_mode().combat {
        return;
    }
    let mut add: Vec<Mod> = Vec::new();
    let mut enemy_add: Vec<Mod> = Vec::new();
    // Each block reads the store as it stands, exactly as upstream does; mods added by an
    // earlier block are visible to later ones, so flush `add` after every block.
    macro_rules! flush {
        () => {
            for m in add.drain(..) {
                player.add_mod(m);
            }
        };
    }

    // Cruelty: `mainSkill.baseSkillModList:Flag(nil, "Cruelty")`; the flag is a baseMod of the support,
    // which sits in the skill's own mod list (its parent, the player's modDB, holds no such flag).
    if main.is_some_and(|m| m.skill_mod_list.iter().any(|x| x.ty == ModType::Flag && x.name == pom_engine::sym!("Cruelty") && matches!(x.value, Value::Bool(true)))) {
        let v = over(player, "Cruelty").unwrap_or(40.0);
        player.multipliers.insert(pom_engine::sym!("Cruelty"), v);
    }
    // Minimum Rage
    let min_rage = sum(player, ModType::Base, &["MinimumRage"]);
    if min_rage > player.multipliers.get(&pom_engine::sym!("Rage")).copied().unwrap_or(0.0) {
        player.multipliers.insert(pom_engine::sym!("Rage"), min_rage);
    }
    // Minimum Fortification from King Maker or Perfect Naval Officer spectres or Ally override
    if sum(player, ModType::Base, &["MinimumFortification"]) > 0.0 || allied_fortify > 0.0 {
        player.conditions.insert(pom_engine::sym!("Fortified"), true);
    }
    // Fortify
    if flag(player, &["Fortified"]) || sum(player, ModType::Base, &["Multiplier:Fortification"]) > 0.0 {
        let max_stacks = over(player, "MaximumFortification").unwrap_or_else(|| sum(player, ModType::Base, &["MaximumFortification"])).max(allied_fortify);
        let min_stacks = (if flag(player, &["Condition:HaveMaxFortification"]) { max_stacks } else { sum(player, ModType::Base, &["MinimumFortification"]) }).min(max_stacks);
        let fort_over = over(player, "FortificationStacks");
        let stacks = fort_over.or(if min_stacks > 0.0 { Some(min_stacks) } else { None }).unwrap_or(max_stacks).min(max_stacks);
        // `skillModList` = mainSkill.skillModList (own mods, parent = modDB) or modDB when no main skill.
        let skill_store = main.map(|m| {
            let mut st = ModStore::new_list(Some(Arc::new(clone_store(player))), None);
            for x in &m.skill_mod_list {
                st.add_mod(x.clone());
            }
            st
        });
        let sml: &ModStore = skill_store.as_ref().unwrap_or(&*player);
        let inc_dur = sum(sml, ModType::Inc, &["FortifyDuration"]);
        let dur_over = over(sml, "FortifyDuration");
        output.insert("MaximumFortification".into(), max_stacks);
        output.insert("MinimumFortification".into(), min_stacks);
        output.insert("RemovableFortification".into(), (max_stacks - min_stacks).min(fort_over.unwrap_or(max_stacks) - min_stacks));
        output.insert("FortificationStacks".into(), stacks);
        output.insert("FortificationStacksOver20".into(), (stacks - 20.0).max(0.0).min(max_stacks - 20.0));
        output.insert("FortifyDuration".into(), dur_over.unwrap_or(6.0) * (1.0 + inc_dur / 100.0));
        if !flag(player, &["Condition:NoFortificationMitigation"]) {
            output.insert("FortificationEffect".into(), stacks);
            add.push(mk("DamageTakenWhenHit", ModType::More, -stacks, "Fortification", 0));
        }
        if stacks >= max_stacks {
            add.push(flagm("Condition:HaveMaximumFortification", ""));
        }
        *player.multipliers.entry(pom_engine::sym!("BuffOnSelf")).or_insert(0.0) += 1.0;
    }
    flush!();
    if flag(player, &["Onslaught"]) {
        let mut from_flask = false;
        let mut flask_inc = -100.0;
        // `{ actor = "player" }` cfg: `Actor`-tagged FlaskEffect mods only count with it.
        let actor_cfg = pom_engine::modstore::types::Cfg { actor_tag: Some(std::sync::Arc::from("player")), ..Default::default() };
        let sum_actor = |name: &str| player.sum(ModType::Inc, Some(&actor_cfg), &[Sym::new(name)]);
        let flask_effect_player = sum_actor("FlaskEffect");
        for f in flasks {
            if f.base_name.contains("Silver Flask") {
                from_flask = true;
                let mut cur = f.effect_inc + flask_effect_player;
                if f.is_magic {
                    cur += sum_actor("MagicUtilityFlaskEffect");
                }
                if flask_inc < cur / 100.0 {
                    flask_inc = cur / 100.0;
                }
            }
        }
        let ons_inc = sum(player, ModType::Inc, &["OnslaughtEffect", "BuffEffectOnSelf"]) / 100.0;
        let effect = if from_flask { (20.0 * (1.0 + flask_inc + ons_inc)).floor() } else { (20.0 * (1.0 + ons_inc)).floor() };
        add.push(mk("Speed", ModType::Inc, effect, "Onslaught", ATTACK));
        add.push(mk("Speed", ModType::Inc, effect, "Onslaught", CAST));
        add.push(mk("MovementSpeed", ModType::Inc, effect, "Onslaught", 0));
    }
    flush!();
    if player.conditions.get(&pom_engine::sym!("AffectedByArcaneSurge")).copied().unwrap_or(false) || flag(player, &["Condition:ArcaneSurge"]) {
        player.conditions.insert(pom_engine::sym!("AffectedByArcaneSurge"), true);
        let mut effect = 1.0 + sum(player, ModType::Inc, &["ArcaneSurgeEffect", "BuffEffectOnSelf"]) / 100.0;
        effect += sum(player, ModType::Inc, &["FlaskEffect"]) / 100.0 * sum(player, ModType::Base, &["FlaskEffectToArcaneSurgeEffect"]) / 100.0;
        add.push(mk("ManaRegen", ModType::Inc, max_(player, "ArcaneSurgeManaRegen").unwrap_or(30.0) * effect, "Arcane Surge", 0));
        let cs = max_(player, "ArcaneSurgeCastSpeed").unwrap_or(20.0) * effect;
        add.push(mk("Speed", ModType::Inc, cs, "Arcane Surge", CAST));
        if flag(player, &["ArcaneSurgeCastSpeedToMovementSpeed"]) {
            add.push(mk("MovementSpeed", ModType::Inc, cs, "Arcane Surge", 0));
        }
        let dmg = max_(player, "ArcaneSurgeDamage").unwrap_or(0.0);
        if dmg != 0.0 {
            add.push(mk("Damage", ModType::More, dmg * effect, "Arcane Surge", SPELL));
        }
        for (m, ty) in [("LifeRegen", ModType::Inc), ("ManaRecoup", ModType::Base), ("ManaCostEfficiency", ModType::Inc)] {
            let v = sum(player, ty, &[&format!("ArcaneSurgeAlso{m}")]);
            if v != 0.0 {
                add.push(mk(m, ty, v * effect, "Arcane Surge", 0));
            }
        }
    }
    flush!();
    if flag(player, &["Fanaticism"]) && main.is_some_and(|m| m.skill_flags.contains("selfCast")) {
        let effect = (75.0 * (1.0 + sum(player, ModType::Inc, &["BuffEffectOnSelf"]) / 100.0)).floor();
        add.push(mk("Speed", ModType::More, effect, "Fanaticism", CAST));
        add.push(mk("Cost", ModType::More, -effect, "Fanaticism", CAST));
        add.push(mk("AreaOfEffect", ModType::Inc, effect, "Fanaticism", CAST));
    }
    flush!();
    if flag(player, &["Condition:CanGainSpiritInfusion"]) {
        // CalcPerform.lua:741-749.
        let tag = |kind: &str, fields: Vec<(&str, Value)>| pom_engine::modifier::Tag { kind: s(kind), fields: fields.into_iter().map(|(k, v)| (s(k), v)).collect() };
        let global_effect = || tag("GlobalEffect", vec![("effectType", Value::Str(Arc::from("Buff"))), ("effectName", Value::Str(Arc::from("Spirit Infusion"))), ("unscalable", Value::Bool(true))]);
        let multiplier = || tag("Multiplier", vec![("var", Value::Str(Arc::from("SpiritInfusion")))]);
        let channel = || tag("SkillType", vec![("skillType", Value::Num(48.0))]);
        let mut m1 = mk("EnergyShieldRechargeFaster", ModType::Inc, 15.0, "Spirit Infusion", 0);
        m1.tags = (vec![multiplier(), global_effect()]).into();
        let mut m2 = mk("Damage", ModType::More, 5.0, "Spirit Infusion", 0);
        m2.keyword_flags = 0x20000;
        m2.tags = (vec![channel(), multiplier(), global_effect()]).into();
        let mut m3 = mk("Cost", ModType::More, 10.0, "Spirit Infusion", 0);
        m3.keyword_flags = 0x20000;
        m3.tags = (vec![channel(), multiplier(), global_effect()]).into();
        add.extend([m1, m2, m3]);
    }
    flush!();
    if flag(player, &["UnholyMight"]) {
        let effect = 1.0 + sum(player, ModType::Inc, &["BuffEffectOnSelf"]) / 100.0;
        add.push(mk("PhysicalDamageConvertToChaos", ModType::Base, (100.0 * effect).floor(), "Unholy Might", 0));
        add.push(flagm("Condition:CanWither", "Unholy Might"));
        let v = sum(player, ModType::Base, &["UnholyMightAlsoChaosPenetration"]);
        if v != 0.0 {
            add.push(mk("ChaosPenetration", ModType::Base, v * effect, "Unholy Might", 0));
        }
    }
    flush!();
    if flag(player, &["ShepherdOfSouls"]) {
        // CalcPerform.lua:759-762.
        let tag = |kind: &str, fields: Vec<(&str, Value)>| pom_engine::modifier::Tag { kind: s(kind), fields: fields.into_iter().map(|(k, v)| (s(k), v)).collect() };
        let vaal = || tag("SkillType", vec![("skillType", Value::Num(38.0))]);
        let not_aura = || tag("SkillType", vec![("skillType", Value::Num(39.0)), ("neg", Value::Bool(true))]);
        let mut m1 = mk("SoulCost", ModType::More, -80.0, "Shepherd of Souls", 0);
        m1.tags = (vec![vaal(), not_aura()]).into();
        let mut m2 = mk("SoulCost", ModType::Inc, 100.0, "Shepherd of Souls", 0);
        m2.tags = (vec![vaal(), not_aura(), tag("Multiplier", vec![("var", Value::Str(Arc::from("VaalSkillsUsedInPast8Seconds")))])]).into();
        add.extend([m1, m2]);
    }
    flush!();
    if flag(player, &["ChaoticMight"]) {
        add.push(mk("PhysicalDamageGainAsChaos", ModType::Base, (30.0 * (1.0 + sum(player, ModType::Inc, &["BuffEffectOnSelf"]) / 100.0)).floor(), "Chaotic Might", 0));
    }
    if flag(player, &["Tailwind"]) {
        add.push(mk("ActionSpeed", ModType::Inc, (8.0 * (1.0 + sum(player, ModType::Inc, &["TailwindEffectOnSelf", "BuffEffectOnSelf"]) / 100.0)).floor(), "Tailwind", 0));
    }
    if flag(player, &["Condition:TotemTailwind"]) {
        add.push(mk("TotemActionSpeed", ModType::Inc, 8.0, "Tailwind", 0));
    }
    if flag(player, &["Adrenaline"]) {
        let e = 1.0 + sum(player, ModType::Inc, &["BuffEffectOnSelf"]) / 100.0;
        add.push(mk("Damage", ModType::Inc, (100.0 * e).floor(), "Adrenaline", 0));
        add.push(mk("Speed", ModType::Inc, (25.0 * e).floor(), "Adrenaline", ATTACK));
        add.push(mk("Speed", ModType::Inc, (25.0 * e).floor(), "Adrenaline", CAST));
        add.push(mk("MovementSpeed", ModType::Inc, (25.0 * e).floor(), "Adrenaline", 0));
        add.push(mk("PhysicalDamageReduction", ModType::Base, (10.0 * e).floor(), "Adrenaline", 0));
    }
    if flag(player, &["Condition:WildSavagery"]) && flag(player, &["WildSavagery"]) {
        add.push(mk("PhysicalDamage", ModType::Inc, 100.0, "Wild Savagery", 0));
        add.push(mk("ActionSpeed", ModType::Inc, 10.0, "Wild Savagery", 0));
        add.push(flagm("IgnoreEnemyPhysicalDamageReduction", "Wild Savagery"));
        add.push(flagm("StunImmune", "Wild Savagery"));
    }
    if flag(player, &["Convergence"]) {
        let effect = (30.0 * (1.0 + sum(player, ModType::Inc, &["BuffEffectOnSelf"]) / 100.0)).floor();
        add.push(mk("ElementalDamage", ModType::More, effect, "Convergence", 0));
    }
    if flag(player, &["HerEmbrace"]) {
        player.conditions.insert(pom_engine::sym!("HerEmbrace"), true);
        add.push(mk("AvoidStun", ModType::Base, 100.0, "Her Embrace", 0));
        add.push(mk("PhysicalDamageGainAsFire", ModType::Base, 123.0, "Her Embrace", 0x00400000));
        add.push(mk("AvoidFreeze", ModType::Base, 100.0, "Her Embrace", 0));
        add.push(mk("AvoidChill", ModType::Base, 100.0, "Her Embrace", 0));
        add.push(mk("AvoidIgnite", ModType::Base, 100.0, "Her Embrace", 0));
        add.push(mk("Speed", ModType::Inc, 20.0, "Her Embrace", ATTACK));
        add.push(mk("Speed", ModType::Inc, 20.0, "Her Embrace", CAST));
        add.push(mk("MovementSpeed", ModType::Inc, 20.0, "Her Embrace", 0));
    }
    flush!();
    if flag(player, &["Condition:OnConsecratedGround"]) {
        let effect = 1.0 + sum(player, ModType::Inc, &["ConsecratedGroundEffect"]) / 100.0;
        add.push(mk("LifeRegenPercent", ModType::Base, 5.0 * effect, "Consecrated Ground", 0));
        add.push(mk("Accuracy", ModType::Inc, (sum(player, ModType::Inc, &["ConsecratedGroundAlsoAccuracy"]) * effect).floor(), "Consecrated Ground", 0));
    }
    flush!();
    if flag(player, &["Condition:PhantasmalMight"]) {
        let lim = output.get("ActivePhantasmLimit").copied().unwrap_or(1.0);
        *player.multipliers.entry(pom_engine::sym!("BuffOnSelf")).or_insert(0.0) += lim - 1.0;
    }
    if flag(player, &["Elusive"]) {
        let mut cfg = Cfg::default();
        cfg.source = Some(Arc::from("Skill"));
        let max_skill_inc = player.max(Some(&cfg), &[pom_engine::sym!("ElusiveEffect")]).unwrap_or(0.0);
        let mut inc = sum(player, ModType::Inc, &["ElusiveEffect", "BuffEffectOnSelf"]);
        // `actor.mainSkill.skillModList:Flag(nil, "SupportedByNightblade")`
        if let Some(ms) = main {
            let mut sml = ModStore::new_list(None, None);
            for m in ms.skill_mod_list.iter() {
                if m.name.as_str() == "SupportedByNightblade" {
                    sml.add_mod(m.clone());
                }
            }
            if sml.flag(None, &[pom_engine::sym!("SupportedByNightblade")]) {
                inc += sum(player, ModType::Inc, &["NightbladeSupportedElusiveEffect"]);
            }
        }
        let inc = inc + max_skill_inc;
        let eff_mod = (1.0 + inc / 100.0) * more(player, &["ElusiveEffect", "BuffEffectOnSelf"]) * 100.0;
        let min_thr = over(player, "ElusiveEffectMinThreshold").unwrap_or(0.0);
        let inc_dur = sum(player, ModType::Base, &["ElusiveEffectIncreaseDuration"]);
        let mut peak = eff_mod;
        let mut e_mod;
        if inc_dur > 0.0 {
            let rate = 20.0 / (1.0 + sum(player, ModType::Inc, &["ElusiveEffectLossSlower"]) / 100.0);
            peak = eff_mod + rate * inc_dur;
            let dec_dur = (peak - min_thr) / rate;
            let total = inc_dur + dec_dur;
            e_mod = ((eff_mod + peak) / 2.0 * inc_dur + (peak + min_thr) / 2.0 * dec_dur) / total;
        } else {
            e_mod = (eff_mod + min_thr) / 2.0;
        }
        add.push(mk("ElusiveEffect", ModType::Inc, max_skill_inc, "Max Skill Effect", 0));
        if let Some(o) = over(player, "ElusiveEffect") {
            e_mod = o.min(peak);
        }
        output.insert("ElusiveEffectMod".into(), e_mod);
        let effect = e_mod / 100.0;
        player.conditions.insert(pom_engine::sym!("Elusive"), true);
        add.push(mk("AvoidAllDamageFromHitsChance", ModType::Base, (15.0 * effect).floor(), "Elusive", 0));
        add.push(mk("MovementSpeed", ModType::Inc, (30.0 * effect).floor(), "Elusive", 0));
    }
    flush!();
    let wither_tag = |lim: f64| {
        pom_engine::modifier::Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("WitheredStack"))), (pom_engine::sym!("limit"), Value::Num(lim))] }
    };
    if let Some(effect) = max_(player, "WitherEffectStack") {
        add.push(flagm("Condition:CanWither", "Config"));
        let mut m = mk("ChaosDamageTaken", ModType::Inc, effect, "Withered", 0);
        m.tags.push(wither_tag(15.0));
        enemy_add.push(m);
    }
    if flag(player, &["Condition:CanBeWithered"]) {
        let effect = 6.0 * (100.0 + sum(player, ModType::Inc, &["WitherEffectOnSelf"])) / 100.0 * more(player, &["WitherEffectOnSelf"]);
        let mut m = mk("ChaosDamageTaken", ModType::Inc, effect, "Withered", 0);
        m.tags.push(wither_tag(15.0));
        add.push(m);
    }
    if flag(player, &["Excommunicated"]) {
        add.push(mk("ChaosDamage", ModType::More, -100.0, "Excommunicated", 0));
    }
    flush!();
    if flag(player, &["Blind"]) && !flag(player, &["CannotBeBlinded"]) && !flag(player, &["UnaffectedByBlind"]) {
        let mut effect = 1.0 + sum(player, ModType::Inc, &["BlindEffect", "BuffEffectOnSelf"]) / 100.0;
        if let Some(o) = over(player, "BlindEffect") {
            effect = (o / 100.0).min(effect);
        }
        add.push(mk("Accuracy", ModType::More, (-20.0 * effect).floor(), "Blind", 0));
        add.push(mk("Evasion", ModType::More, (-20.0 * effect).floor(), "Blind", 0));
    }
    flush!();
    // Self ailments (data.nonDamagingAilment: default/max).
    let spell_supp = |p: &ModStore| if flag(p, &["SpellSuppressionAppliesToAilmentAvoidance"]) { sum(p, ModType::Base, &["SpellSuppressionChance"]) / 2.0 } else { 0.0 };
    if flag(player, &["Chill"]) {
        let self_override = sum(player, ModType::Base, &["SelfChillOverride"]);
        let chill_value = over(player, "ChillVal").map_or(self_override, |o| self_override.max(o));
        let total_eff = calc_mod(player, "SelfChillEffect");
        let avoid = if flag(player, &["ChillImmune", "ElementalAilmentImmune"]) {
            100.0
        } else {
            (sum(player, ModType::Base, &["AvoidChill", "AvoidAilments", "AvoidElementalAilments"])
                + if flag(player, &["ShockAvoidAppliesToElementalAilments"]) { sum(player, ModType::Base, &["AvoidShock"]) } else { 0.0 }
                + spell_supp(player))
            .min(100.0)
            .floor()
        };
        let effect = if avoid == 100.0 { 0.0 } else { (chill_value * total_eff).floor().max(0.0).min(over(player, "ChillMax").unwrap_or(30.0)) };
        let rev = flag(player, &["SelfChillEffectIsReversed"]);
        if flag(player, &["SkitterbotBonechill"]) {
            add.push(mk("ColdDamageTaken", ModType::Inc, effect * if rev { -1.0 } else { 1.0 }, "Bonechill", 0));
        }
        add.push(mk("ActionSpeed", ModType::Inc, effect * if rev { 1.0 } else { -1.0 }, "Chill", 0));
    }
    flush!();
    if flag(player, &["Shock"]) {
        let self_override = sum(player, ModType::Base, &["SelfShockOverride"]);
        let shock_value = over(player, "ShockVal").map_or(self_override, |o| self_override.max(o));
        let total_eff = calc_mod(player, "SelfShockEffect");
        let avoid = if flag(player, &["ShockImmune", "ElementalAilmentImmune"]) {
            100.0
        } else {
            (sum(player, ModType::Base, &["AvoidShock", "AvoidAilments", "AvoidElementalAilments"]) + spell_supp(player)).min(100.0).floor()
        };
        let effect = if avoid == 100.0 { 0.0 } else { (shock_value * total_eff).floor().max(0.0).min(over(player, "ShockMax").unwrap_or(50.0)) };
        add.push(mk("DamageTaken", ModType::Inc, effect, "Shock", 0));
    }
    flush!();
    if flag(player, &["Scorch"]) {
        let self_override = sum(player, ModType::Base, &["SelfScorchOverride"]);
        let scorch_value = over(player, "ScorchVal").map_or(self_override, |o| self_override.max(o));
        let total_eff = calc_mod(player, "SelfScorchEffect");
        let avoid = if flag(player, &["ScorchImmune", "ElementalAilmentImmune"]) {
            100.0
        } else {
            (sum(player, ModType::Base, &["AvoidScorch", "AvoidAilments", "AvoidElementalAilments"])
                + if flag(player, &["ShockAvoidAppliesToElementalAilments"]) { sum(player, ModType::Base, &["AvoidShock"]) } else { 0.0 }
                + spell_supp(player))
            .min(100.0)
            .floor()
        };
        let effect = if avoid == 100.0 { 0.0 } else { (scorch_value * total_eff).floor().max(0.0).min(over(player, "ScorchMax").unwrap_or(30.0)) };
        add.push(mk("ElementalResist", ModType::Base, -effect, "Scorch", 0));
    }
    if flag(player, &["Freeze"]) {
        let effect = (70.0 * calc_mod(player, "SelfChillEffect")).floor().max(0.0);
        add.push(mk("ActionSpeed", ModType::Inc, -effect, "Freeze", 0));
    }
    flush!();
    if flag(player, &["CanLeechLifeOnFullLife"]) && !flag(player, &["GhostReaver"]) {
        player.conditions.insert(pom_engine::sym!("Leeching"), true);
        player.conditions.insert(pom_engine::sym!("LeechingLife"), true);
    }
    if flag(player, &["CanLeechEnergyShieldOnFullEnergyShield"]) {
        player.conditions.insert(pom_engine::sym!("Leeching"), true);
        player.conditions.insert(pom_engine::sym!("LeechingEnergyShield"), true);
    }
    if flag(player, &["Condition:CanGainRage"]) || sum(player, ModType::Base, &["RageRegen"]) > 0.0 {
        let max_stacks = (sum(player, ModType::Base, &["MaximumRage"]) * more(player, &["MaximumRage"])).floor();
        let min_stacks = sum(player, ModType::Base, &["MinimumRage"]).min(max_stacks);
        let rage_config = sum(player, ModType::Base, &["Multiplier:RageStack"]);
        let stacks = rage_config.min(max_stacks).max(if min_stacks > 0.0 { min_stacks } else { 0.0 });
        let rage_effect = (stacks * calc_mod(player, "RageEffect")).floor();
        output.insert("RageEffect".into(), rage_effect);
        add.push(mk("Multiplier:RageEffect", ModType::Base, rage_effect, "Base", 0));
        output.insert("Rage".into(), stacks);
        output.insert("MaximumRage".into(), max_stacks);
        add.push(mk("Multiplier:Rage", ModType::Base, stacks, "Base", 0));
        add.push(mk("Damage", ModType::More, rage_effect, "Rage", if flag(player, &["Condition:RageSpellDamage"]) { SPELL } else { ATTACK }));
        if stacks == max_stacks {
            add.push(flagm("Condition:HaveMaximumRage", ""));
        }
        output.insert("InherentRageLossDelay".into(), 2.0 + sum(player, ModType::Base, &["InherentRageLossDelay"]));
        output.insert(
            "InherentRageLoss".into(),
            if !flag(player, &["InherentRageLossIsPrevented"]) { 10.0 * (1.0 + sum(player, ModType::Inc, &["InherentRageLoss"]) / 100.0) } else { 0.0 },
        );
    }
    flush!();
    let mb_stacks = config_input.get("multiplierManaBurnStacks").copied().unwrap_or(0.0);
    if mb_stacks > 0.0 {
        let mut max_mb = sum(player, ModType::Base, &["MaxManaBurnStacks"]);
        if max_mb == 0.0 {
            max_mb = 9999.0;
        }
        let mut stacks = mb_stacks.min(max_mb);
        add.push(mk("Multiplier:ManaBurnStacks", ModType::Base, stacks, "Config", 0));
        stacks += sum(player, ModType::Base, &["EffectiveManaBurnStacks"]);
        if flag(player, &["Condition:WeepingWoundsInsteadOfManaBurn"]) {
            add.push(mk("Multiplier:WeepingWoundsStacks", ModType::Base, stacks, "Config", 0));
        } else {
            add.push(mk("Multiplier:EffectiveManaBurnStacks", ModType::Base, stacks, "Config", 0));
        }
    }
    let ash = sum(player, ModType::Base, &["CoveredInAshEffect"]);
    if ash > 0.0 {
        enemy_add.push(mk("FireDamageTaken", ModType::Inc, ash.min(20.0), "Covered in Ash", 0));
    }
    let frost = sum(player, ModType::Base, &["CoveredInFrostEffect"]);
    if frost > 0.0 {
        enemy_add.push(mk("ColdDamageTaken", ModType::Inc, frost.min(20.0), "Covered in Frost", 0));
    }
    if flag(player, &["HasMalediction"]) {
        add.push(mk("DamageTaken", ModType::Inc, 10.0, "Malediction", 0));
        add.push(mk("Damage", ModType::Inc, -10.0, "Malediction", 0));
    }
    if flag(player, &["HasMaddeningPresence"]) {
        add.push(mk("ActionSpeed", ModType::Inc, -10.0, "Maddening Presence", 0));
        add.push(mk("Damage", ModType::Inc, -10.0, "Maddening Presence", 0));
    }
    if flag(player, &["HasShapersPresence"]) {
        add.push(mk("BuffExpireFaster", ModType::More, -20.0, "Shapers Presence", 0));
    }
    if flag(player, &["Condition:CanHaveSoulEater"]) {
        let max = over(player, "SoulEaterMax").unwrap_or_else(|| sum(player, ModType::Base, &["SoulEaterMax"]));
        for fl in [ATTACK, CAST] {
            let mut m = mk("Speed", ModType::Inc, 5.0, "Base", fl);
            m.tags.push(pom_engine::modifier::Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from("SoulEaterStack"))), (pom_engine::sym!("limit"), Value::Num(max))] });
            add.push(m);
        }
    }
    flush!();
    for m in enemy_add {
        enemy.add_mod(m);
    }
}

/// Rebuilds a `Mod` from the `Value::Map` a LIST mod's `mod` field holds (name/type/value/flags/
/// keywordFlags/source, then positional tags under "1", "2", ... exactly as `mod_to_pval` writes
/// them).
pub(crate) fn map_to_mod(map: &[(Sym, Value)]) -> Mod {
    let get = |k: &str| map.iter().find(|(mk, _)| mk.as_str() == k).map(|(_, v)| v.clone());
    let name = match get("name") {
        Some(Value::Str(x)) => Sym::new(&x),
        _ => pom_engine::sym!(""),
    };
    let ty = match get("type") {
        Some(Value::Str(x)) => ModType::parse(&x).unwrap_or(ModType::Base),
        _ => ModType::Base,
    };
    let num = |k: &str| match get(k) {
        Some(Value::Num(n)) => n as u64,
        _ => 0,
    };
    let source = match get("source") {
        Some(Value::Str(x)) => Some(x),
        _ => None,
    };
    let mut tags = Vec::new();
    for i in 1.. {
        match get(&i.to_string()) {
            Some(Value::Map(fields)) => {
                let mut kind = pom_engine::sym!("");
                let mut rest = Vec::new();
                for (k, v) in fields.iter() {
                    if k.as_str() == "type" {
                        if let Value::Str(x) = v {
                            kind = Sym::new(x);
                        }
                    } else {
                        rest.push((*k, v.clone()));
                    }
                }
                tags.push(pom_engine::modifier::Tag { kind, fields: rest });
            }
            _ => break,
        }
    }
    Mod { name, ty, value: get("value").unwrap_or(Value::Nil), flags: num("flags"), keyword_flags: num("keywordFlags"), source, tags: (tags).into() }
}

/// "Check for extra auras" (CalcPerform.lua:3418-3446), player half: each `ExtraAura` LIST mod's
/// wrapped mod is added to the player scaled by `BuffEffectOnSelf`/`AuraEffectOnSelf`.
/// `main_is_totem` is `env.player.mainSkill.skillFlags.totem`: the wrapped mod is also added under a `Totem<name>` copy
/// (`Condition:X` -> `Condition:TotemX`), except Speed/CritMultiplier/CritChance.
/// Not ported: `allyBuffs` and the Hallowing Flame `ExtraAura` source.
pub fn extra_auras(player: &mut ModStore, mut minion: Option<&mut ModStore>, main_is_totem: bool) {
    for value in player.list(None, &[pom_engine::sym!("ExtraAura")]) {
        let Value::Map(fields) = &value else { continue };
        let Some(Value::Map(inner)) = fields.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v.clone()) else { continue };
        let only_allies = value.get(pom_engine::sym!("onlyAllies")).truthy();
        let from_allies = value.get(pom_engine::sym!("fromAllies")).truthy();
        let m = map_to_mod(&inner);
        if !only_allies && !(from_allies && flag(player, &["AlliesAurasCannotAffectSelf"])) {
            let inc = sum(player, ModType::Inc, &["BuffEffectOnSelf", "AuraEffectOnSelf"]);
            let mo = more(player, &["BuffEffectOnSelf", "AuraEffectOnSelf"]);
            for sm in pom_calc::perform::scale_add_list(&[m], (1.0 + inc / 100.0) * mo) {
                player.add_mod(sm);
            }
            if !value.get(pom_engine::sym!("notBuff")).truthy() {
                *player.multipliers.entry(pom_engine::sym!("BuffOnSelf")).or_insert(0.0) += 1.0;
            }
        }
        if from_allies || !flag(player, &["SelfAurasCannotAffectAllies"]) {
            // `buffExports` is not needed here; the totem copy (CalcPerform.lua:3436-3445) lands in the player modDB.
            let totem_mod_blacklist = matches!(inner_name(&inner).as_deref(), Some("Speed" | "CritMultiplier" | "CritChance"));
            if main_is_totem && !totem_mod_blacklist {
                let mut totem_mod = map_to_mod(&inner);
                let name = totem_mod.name.as_str().to_string();
                let new_name = if name.contains("Condition:") { name.replacen("Condition:", "Condition:Totem", 1) } else { format!("Totem{name}") };
                totem_mod.name = s(&new_name);
                player.add_mod(totem_mod);
            }
            if let Some(mn) = minion.as_deref_mut() {
                let inc = sum(mn, ModType::Inc, &["BuffEffectOnSelf", "AuraEffectOnSelf"]);
                let mo = more(mn, &["BuffEffectOnSelf", "AuraEffectOnSelf"]);
                for sm in pom_calc::perform::scale_add_list(&[map_to_mod(&inner)], (1.0 + inc / 100.0) * mo) {
                    mn.add_mod(sm);
                }
            }
        }
    }
}

fn inner_name(inner: &[(Sym, Value)]) -> Option<String> {
    inner.iter().find(|(k, _)| k.as_str() == "name").and_then(|(_, v)| if let Value::Str(n) = v { Some(n.to_string()) } else { None })
}

/// Source prefix of the temporary mods `totem_cache_mods` builds; removed again once the cached run is over.
pub const TOTEM_CACHE_SOURCE: &str = "__totem_cache__";

/// A cached trigger-source run is its own `calcs.perform` with the source as the main skill, so a totem
/// source sees the "Check for extra auras" totem copies (CalcPerform.lua:3436-3445) and the `TotemTailwind`
/// action speed (CalcPerform.lua:771) even when the real main skill is not a totem.
pub fn totem_cache_mods(player: &ModStore) -> Vec<Mod> {
    let mut out: Vec<Mod> = Vec::new();
    for value in player.list(None, &[pom_engine::sym!("ExtraAura")]) {
        let Value::Map(fields) = &value else { continue };
        let Some(Value::Map(inner)) = fields.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v.clone()) else { continue };
        let from_allies = value.get(pom_engine::sym!("fromAllies")).truthy();
        if !(from_allies || !flag(player, &["SelfAurasCannotAffectAllies"])) { continue; }
        if matches!(inner_name(&inner).as_deref(), Some("Speed" | "CritMultiplier" | "CritChance")) { continue; }
        let mut totem_mod = map_to_mod(&inner);
        let name = totem_mod.name.as_str().to_string();
        totem_mod.name = s(&if name.contains("Condition:") { name.replacen("Condition:", "Condition:Totem", 1) } else { format!("Totem{name}") });
        out.push(totem_mod);
    }
    let tailwind = out.iter().any(|m| m.name.as_str() == "Condition:TotemTailwind" && matches!(m.value, Value::Bool(true)));
    if tailwind && !flag(player, &["Condition:TotemTailwind"]) {
        out.push(mk("TotemActionSpeed", ModType::Inc, 8.0, "Tailwind", 0));
    }
    out
}

/// The early part of `calcs.perform` (CalcPerform.lua:1331-1381): banner valour, minimum/infinite
/// warcry power, then the per-skill brand attach counts and totem limits. `main` is the main skill
/// (`env.player.mainSkill`) whose `skillModList` the totem limit is read from.
///
/// Not ported from that loop: Hex Doom, Shocked Ground, Skitterbots, guaranteed-chill/Bonechill,
/// `skillData.attachedBrandCount`, and minion counting (done separately by `perform_minions`).
pub fn early_perform(
    player: &mut ModStore,
    enemy: &mut ModStore,
    output: &mut pom_engine::fxhash::HashMap<String, f64>,
    active_skills: &mut [pom_skills::assemble::ComputedSkill],
    main_idx: Option<usize>,
) {
    // Banners
    if flag(player, &["Condition:BannerPlanted"]) {
        let max = sum(player, ModType::Base, &["MaximumValour"]);
        let stacks = sum(player, ModType::Base, &["Multiplier:ValourStacks"]);
        player.add_mod(mk("Multiplier:BannerValour", ModType::Base, stacks.min(max), "Base", 0));
    }
    if flag(player, &["CryWolfMinimumPower"]) && sum(player, ModType::Base, &["WarcryPower"]) < 10.0 {
        player.add_mod(mk("WarcryPower", ModType::Override, 10.0, "Minimum Warcry Power from CryWolf", 0));
    }
    if flag(player, &["WarcryInfinitePower"]) {
        player.add_mod(mk("WarcryPower", ModType::Override, 999999.0, "Warcries have infinite power", 0));
    }
    let warcry_power = over(player, "WarcryPower").unwrap_or_else(|| sum(player, ModType::Base, &["WarcryPower"]));
    output.insert("WarcryPower".into(), warcry_power);
    player.multipliers.insert(pom_engine::sym!("WarcryPower"), warcry_power);

    let snap = crate::buffs::player_snapshot(player);
    let skill_store = |c: &pom_skills::assemble::ComputedSkill| {
        let mut st = ModStore::new_list(Some(snap.clone()), snap.actor.clone());
        for m in &c.skill_mod_list {
            st.add_mod(m.clone());
        }
        st
    };
    let main_store = main_idx.map(|i| (skill_store(&active_skills[i]), crate::buffs::skill_cfg(&active_skills[i])));
    for c in active_skills.iter_mut() {
        if c.skill_types.contains(&pom_skills::skill_type::BRAND) {
            let st = skill_store(c);
            let cfg = crate::buffs::skill_cfg(c);
            let attach_limit = st.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("BrandsAttachedLimit")]).min(st.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ActiveBrandLimit")]));
            let configured = sum(player, ModType::Base, &["Multiplier:ConfigBrandsAttachedToEnemy"]);
            let attached = if configured > 0.0 { configured.min(attach_limit) } else { attach_limit };
            c.skill_data.attached_brand_count = Some(attached);
            let active_brands = sum(player, ModType::Base, &["Multiplier:ConfigActiveBrands"]);
            let cur = player.multipliers.get(&pom_engine::sym!("ActiveBrand")).copied().unwrap_or(0.0);
            player.multipliers.insert(pom_engine::sym!("ActiveBrand"), active_brands.min(st.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ActiveBrandLimit")])).max(cur));
            let cur = player.multipliers.get(&pom_engine::sym!("BrandsAttachedToEnemy")).copied().unwrap_or(0.0);
            player.multipliers.insert(pom_engine::sym!("BrandsAttachedToEnemy"), attached.max(cur));
            let cur = enemy.multipliers.get(&pom_engine::sym!("BrandsAttached")).copied().unwrap_or(0.0);
            enemy.multipliers.insert(pom_engine::sym!("BrandsAttached"), attached.max(cur));
        }
        // Hex Doom (CalcPerform.lua:1378-1387): `Sum` is always a number, so every real hex qualifies.
        // Adds the `Doom` CurseEffect INC mod to the hex's skillModList.
        if c.skill_flags.contains("hex") && c.skill_flags.contains("curse") && !c.skill_types.contains(&pom_skills::skill_type::TOTEM_CASTS_WHEN_NOT_DETACHED) {
            let st_doom = skill_store(c);
            let max_doom = st_doom.sum(ModType::Base, None, &[pom_engine::sym!("MaxDoom")]);
            let hex_doom = sum(player, ModType::Base, &["Multiplier:HexDoomStack"]);
            let limit = max_doom.max(output.get("HexDoomLimit").copied().unwrap_or(0.0));
            output.insert("HexDoomLimit".into(), limit);
            let cur = player.multipliers.get(&pom_engine::sym!("HexDoom")).copied().unwrap_or(0.0);
            player.multipliers.insert(pom_engine::sym!("HexDoom"), hex_doom.max(cur).min(limit));
            let doom_effect = st_doom.more(None, &[pom_engine::sym!("DoomEffect")]);
            c.skill_mod_list.push(mk("CurseEffect", ModType::Inc, hex_doom.min(max_doom) * doom_effect, "Doom", 0));
        }
        // Rallying / Seismic Cry share their damage bonus with the offence exert block (CalcPerform.lua:1464-1471).
        if pom_calc::setup::buff_mode().buffs && c.skill_flags.contains("warcry") {
            let main_cfg = main_store.as_ref().map(|(_, cfg)| cfg);
            let st = skill_store(c);
            if c.name == "Rallying Cry" && !st.flag(None, &[pom_engine::sym!("CannotShareWarcryBuffs")]) && !flag(player, &["RallyingActive"]) {
                let v = st.sum(ModType::Base, main_cfg, &[pom_engine::sym!("RallyingCryExertDamageBonus")]);
                player.add_mod(mk("RallyingExertMoreDamagePerAlly", ModType::Base, v, "", 0));
                player.add_mod(flagm("RallyingActive", ""));
            } else if c.name == "Seismic Cry" && !flag(player, &["SeismicActive"]) {
                let v = st.sum(ModType::Base, main_cfg, &[pom_engine::sym!("SeismicAoEMoreMultiplier")]);
                player.add_mod(mk("SeismicMoreAoE", ModType::Base, v, "", 0));
                player.add_mod(flagm("SeismicActive", ""));
            }
        }
        if c.skill_flags.contains("totem") {
            let limit = match &main_store {
                Some((st, cfg)) => st.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ActiveTotemLimit"), pom_engine::sym!("ActiveBallistaLimit")]),
                None => sum(player, ModType::Base, &["ActiveTotemLimit", "ActiveBallistaLimit"]),
            };
            let cur = output.get("ActiveTotemLimit").copied().unwrap_or(0.0);
            let lim = limit.max(cur);
            output.insert("ActiveTotemLimit".into(), lim);
            let summoned = over(player, "TotemsSummoned").unwrap_or(lim);
            output.insert("TotemsSummoned".into(), summoned);
            let cur = enemy.multipliers.get(&pom_engine::sym!("TotemsSummoned")).copied().unwrap_or(0.0);
            enemy.multipliers.insert(pom_engine::sym!("TotemsSummoned"), summoned.max(cur));
        }
    }
    // Exposure application conditions (CalcPerform.lua:397-407, `env.mode_effective`).
    for el in ["Fire", "Cold", "Lightning"].into_iter().filter(|_| pom_calc::setup::buff_mode().effective) {
        let n = format!("{el}ExposureChance");
        let from_skill = main_store.as_ref().map_or(0.0, |(st, cfg)| st.sum(ModType::Base, Some(cfg), &[s(&n)]));
        if from_skill > 0.0 || sum(player, ModType::Base, &[&n]) > 0.0 {
            player.conditions.insert(s(&format!("CanApply{el}Exposure")), true);
        }
    }
}

/// "Shrine Buffs" (CalcPerform.lua:302-372, `env.mode_combat`): each shrine flag adds its mods,
/// scaled by `BuffEffectOnSelf`/`ShrineBuffEffect`. Must run before the life pool is computed
/// (Massive Shrine). `ExtraCurse` (Blood Shrine of Bats) is emitted as a LIST mod.
pub fn shrine_buffs(player: &mut ModStore) {
    let eff = 1.0 + sum(player, ModType::Inc, &["BuffEffectOnSelf", "ShrineBuffEffect"]) / 100.0;
    let f = |v: f64| (v * eff).floor();
    let mut add: Vec<Mod> = Vec::new();
    let has = |p: &ModStore, n: &str| flag(p, &[n]);
    if has(player, "AccelerationShrine") {
        add.push(mk("ActionSpeed", ModType::Inc, f(50.0), "Acceleration Shrine", 0));
        add.push(mk("ProjectileSpeed", ModType::Inc, f(80.0), "Acceleration Shrine", 0));
    }
    if has(player, "BrutalShrine") {
        add.push(mk("Damage", ModType::Inc, f(50.0), "Brutal Shrine", 0));
        add.push(mk("EnemyStunDuration", ModType::Inc, f(30.0), "Brutal Shrine", 0));
        add.push(mk("EnemyKnockbackChance", ModType::Inc, 100.0, "Brutal Shrine", 0));
    }
    if has(player, "DiamondShrine") {
        add.push(mk("CritChance", ModType::Override, 100.0, "Diamond Shrine", 0));
    }
    if has(player, "DivineShrine") {
        add.push(mk("DamageTaken", ModType::More, -100.0, "Divine Shrine", 0));
    }
    if has(player, "EchoingShrine") {
        add.push(mk("Speed", ModType::More, f(100.0), "Echoing Shrine", ATTACK));
        add.push(mk("Speed", ModType::More, f(100.0), "Echoing Shrine", CAST));
        add.push(mk("RepeatCount", ModType::Base, f(1.0), "Echoing Shrine", 0));
    }
    if has(player, "GloomShrine") {
        add.push(mk("NonChaosDamageGainAsChaos", ModType::Base, f(10.0), "Gloom Shrine", 0));
    }
    if has(player, "GreaterFreezingShrine") {
        add.push(mk("PhysicalDamageGainAsCold", ModType::Base, f(30.0), "Greater Freezing Shrine", 0));
    }
    if has(player, "GreaterShockingShrine") {
        add.push(mk("PhysicalDamageGainAsLightning", ModType::Base, f(30.0), "Greater Shocking Shrine", 0));
    }
    if has(player, "GreaterSkeletalShrine") {
        add.push(mk("PhysicalDamageGainAsChaos", ModType::Base, f(30.0), "Greater Skeletal Shrine", 0));
    }
    if has(player, "ImpenetrableShrine") {
        for n in ["Armour", "Evasion", "EnergyShield"] {
            add.push(mk(n, ModType::Inc, f(100.0), "Impenetrable Shrine", 0));
        }
    }
    if has(player, "MassiveShrine") {
        add.push(mk("Life", ModType::Inc, f(40.0), "Massive Shrine", 0));
        add.push(mk("AreaOfEffect", ModType::Inc, f(40.0), "Massive Shrine", 0));
    }
    if has(player, "ReplenishingShrine") {
        add.push(mk("ManaRegen", ModType::Inc, 200.0 * eff, "Replenishing Shrine", 0));
        add.push(mk("LifeRegenPercent", ModType::Base, 6.7 * eff, "Replenishing Shrine", 0));
    }
    if has(player, "ResistanceShrine") {
        add.push(mk("ElementalResist", ModType::Base, f(50.0), "Resistance Shrine", 0));
        add.push(mk("ElementalResistMax", ModType::Base, f(10.0), "Resistance Shrine", 0));
        add.push(mk("ChaosResistMax", ModType::Base, f(10.0), "Resistance Shrine", 0));
    }
    if has(player, "ResonatingShrine") {
        for n in ["PowerChargesMax", "FrenzyChargesMax", "EnduranceChargesMax"] {
            add.push(mk(n, ModType::Base, f(1.0), "Resonating Shrine", 0));
        }
    }
    if has(player, "LesserAccelerationShrine") && !has(player, "AccelerationShrine") {
        add.push(mk("ActionSpeed", ModType::Inc, f(10.0), "Lesser Acceleration Shrine", 0));
        add.push(mk("ProjectileSpeed", ModType::Inc, f(30.0), "Lesser Acceleration Shrine", 0));
    }
    if has(player, "LesserBrutalShrine") {
        add.push(mk("Damage", ModType::Inc, f(20.0), "Lesser Brutal Shrine", 0));
        add.push(mk("EnemyStunDuration", ModType::Inc, f(20.0), "Lesser Brutal Shrine", 0));
        add.push(mk("EnemyKnockbackChance", ModType::Inc, 100.0, "Lesser Brutal Shrine", 0));
    }
    if has(player, "LesserImpenetrableShrine") {
        for n in ["Armour", "Evasion", "EnergyShield"] {
            add.push(mk(n, ModType::Inc, f(50.0), "Lesser Impenetrable Shrine", 0));
        }
    }
    if has(player, "LesserMassiveShrine") {
        add.push(mk("Life", ModType::Inc, f(20.0), "Lesser Massive Shrine", 0));
        add.push(mk("AreaOfEffect", ModType::Inc, f(20.0), "Lesser Massive Shrine", 0));
    }
    if has(player, "LesserReplenishingShrine") {
        add.push(mk("ManaRegen", ModType::Inc, 100.0 * eff, "Lesser Replenishing Shrine", 0));
        add.push(mk("LifeRegenPercent", ModType::Base, 3.3 * eff, "Lesser Replenishing Shrine", 0));
    }
    if has(player, "LesserResistanceShrine") {
        add.push(mk("ElementalResist", ModType::Base, f(25.0), "Lesser Resistance Shrine", 0));
        add.push(mk("ElementalResistMax", ModType::Base, f(2.0), "Lesser Resistance Shrine", 0));
        add.push(mk("ChaosResistMax", ModType::Base, f(2.0), "Lesser Resistance Shrine", 0));
    }
    if has(player, "BloodShrineOfRats") {
        add.push(mk("ElementalDamageGainAsChaos", ModType::Base, f(30.0), "Blood Shrine of Rats", 0));
    }
    if has(player, "BloodShrineOfLocusts") {
        add.push(mk("DotMultiplier", ModType::Base, f(30.0), "Blood Shrine of Locusts", 0));
    }
    if has(player, "BloodShrineOfToads") {
        add.push(mk("BloodShrineExplodingToadTriggerChance", ModType::Base, f(25.0), "Blood Shrine of Toads", 0));
    }
    if has(player, "BloodShrineOfCrows") {
        add.push(mk("ChaosResist", ModType::Base, f(50.0), "Blood Shrine of Crows", 0));
        add.push(mk("ElementalDamageFromHitsTakenAsChaos", ModType::Base, f(10.0), "Blood Shrine of Crows", 0));
        add.push(mk("PhysicalDamageFromHitsTakenAsChaos", ModType::Base, f(10.0), "Blood Shrine of Crows", 0));
    }
    if has(player, "BloodShrineOfBats") {
        add.push(mk("EnemyCurseLimit", ModType::Base, f(1.0), "Blood Shrine of Bats", 0));
        add.push(Mod {
            name: pom_engine::sym!("ExtraCurse"),
            ty: ModType::List,
            value: Value::Map(Arc::new(vec![(pom_engine::sym!("skillId"), Value::Str(Arc::from("Enfeeble"))), (pom_engine::sym!("level"), Value::Num(1.0))])),
            flags: 0,
            keyword_flags: 0,
            source: Some(Arc::from("Blood Shrine of Bats")),
            tags: (vec![]).into(),
        });
    }
    for m in add {
        player.add_mod(m);
    }
}
