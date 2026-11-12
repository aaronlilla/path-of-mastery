use crate::ctx::ConfigCtx;
use crate::helpers::{b, list, map, mod_value, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::ModType;

fn combat_tag() -> pom_engine::modifier::Tag {
    tag("Condition", &[("var", s("Combat"))])
}

fn use_siphoning_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("UseSiphoningCharges", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn override_siphoning_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("SiphoningCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn use_challenger_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("UseChallengerCharges", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn override_challenger_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("ChallengerCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn use_blitz_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("UseBlitzCharges", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn override_blitz_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("BlitzCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn multiplier_gale_force(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:GaleForce",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("IgnoreCond", &[]), combat_tag(), tag("Condition", &[("var", s("CanGainGaleForce"))])],
    ));
}
fn override_inspiration_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("InspirationCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn use_ghost_shrouds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("UseGhostShrouds", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn override_ghost_shrouds(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("GhostShrouds", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn wait_for_max_seals(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("UseMaxUnleash", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn repeat_mode(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    match val.as_str().as_ref() {
        "AVERAGE" => {
            ctx.mods.push(new_mod("Condition:averageRepeat", ModType::Flag, b(true), "Config", vec![]));
            let inner = new_mod("Condition:averageRepeat", ModType::Flag, b(true), "Config", vec![]);
            ctx.mods.push(crate::helpers::mod_no_source_minion(inner));
        }
        "FINAL" | "FINAL_DPS" => {
            ctx.mods.push(new_mod("Condition:alwaysFinalRepeat", ModType::Flag, b(true), "Config", vec![]));
            let inner = new_mod("Condition:alwaysFinalRepeat", ModType::Flag, b(true), "Config", vec![]);
            ctx.mods.push(crate::helpers::mod_no_source_minion(inner));
        }
        _ => {}
    }
}
fn override_blood_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("BloodCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn override_spirit_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("SpiritCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn override_spirit_infusion(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("SpiritInfusion", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn minions_use_power_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("UsePowerCharges", ModType::Flag, b(true), "Config", vec![combat_tag()]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn minions_use_frenzy_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("UseFrenzyCharges", ModType::Flag, b(true), "Config", vec![combat_tag()]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn minions_use_endurance_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("UseEnduranceCharges", ModType::Flag, b(true), "Config", vec![combat_tag()]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn minions_override_power_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("PowerCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn minions_override_frenzy_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("FrenzyCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn minions_override_endurance_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("EnduranceCharges", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn multiplier_rampage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:Rampage", ModType::Base, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn multiplier_soul_eater(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SoulEaterStack", ModType::Base, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn multiplier_minion_soul_eater(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Multiplier:SoulEaterStack", ModType::Base, n(val.as_f64()), "Config", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), "Config", vec![]));
}
fn condition_focused(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Focused", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn buff_lifetap(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Lifetap", ModType::Flag, b(true), "Config", vec![combat_tag()]));
    ctx.mods.push(new_mod("FlaskLifeRecovery", ModType::Inc, n(20.0), "Lifetap", vec![]));
}
fn buff_onslaught(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Onslaught", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn buff_arcane_surge(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:ArcaneSurge", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn minion_buff_onslaught(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Condition:Onslaught", ModType::Flag, b(true), "Config", vec![combat_tag()]);
    ctx.mods.push(crate::helpers::mod_no_source_minion(inner));
}
fn buff_unholy_might(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:UnholyMight", ModType::Flag, b(true), "Config", vec![combat_tag()]));
    ctx.mods.push(new_mod("Condition:CanWither", ModType::Flag, b(true), "Unholy Might", vec![combat_tag()]));
}
fn minionbuff_unholy_might(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner1 = new_mod("Condition:UnholyMight", ModType::Flag, b(true), "Config", vec![combat_tag()]);
    ctx.mods.push(crate::helpers::mod_no_source_minion(inner1));
    let inner2 = new_mod("Condition:CanWither", ModType::Flag, b(true), "Unholy Might", vec![combat_tag()]);
    ctx.mods.push(crate::helpers::mod_no_source_minion(inner2));
}
fn buff_chaotic_might(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:ChaoticMight", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn buff_sacrificial_zeal(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:SacrificialZeal", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn minionbuff_chaotic_might(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Condition:ChaoticMight", ModType::Flag, b(true), "Config", vec![combat_tag()]);
    ctx.mods.push(crate::helpers::mod_no_source_minion(inner));
}
fn buff_phasing(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Phasing", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn buff_fortification(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Fortified", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn override_fortification(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("FortificationStacks", ModType::Override, n(val.as_f64()), "Config", vec![combat_tag()]));
}
fn buff_tailwind(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Tailwind", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn buff_adrenaline(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Adrenaline", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn condition_changed_stance_last_second(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:StanceChangeLastSecond", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn buff_alchemists_genius(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:AlchemistsGenius",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat_tag(), tag("Condition", &[("var", s("CanHaveAlchemistGenius"))])],
    ));
}
fn buff_vaal_arc_lucky_hits(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "LuckyHits",
        ModType::Flag,
        b(true),
        "Config",
        vec![
            tag("Condition", &[("varList", list(vec![s("Combat"), s("CanBeLucky")]))]),
            tag("SkillName", &[("skillName", s("Arc")), ("includeTransfigured", b(true))]),
        ],
    ));
}
fn buff_elusive(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let tags = || vec![combat_tag(), tag("Condition", &[("var", s("CanBeElusive"))])];
    ctx.mods.push(new_mod("Condition:Elusive", ModType::Flag, b(true), "Config", tags()));
    ctx.mods.push(new_mod("Elusive", ModType::Flag, b(true), "Config", tags()));
}
fn override_buff_elusive(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "ElusiveEffect",
        ModType::Override,
        n(val.as_f64()),
        "Config",
        vec![tag("GlobalEffect", &[("effectType", s("Buff"))])],
    ));
}
fn buff_divinity(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Divinity", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn multiplier_defiance(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:Defiance", ModType::Base, n(val.as_f64().min(10.0)), "Config", vec![combat_tag()]));
}
fn multiplier_rage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:RageStack",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("IgnoreCond", &[]), combat_tag(), tag("Condition", &[("var", s("CanGainRage"))])],
    ));
}
fn buff_wild_savagery(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:WildSavagery", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn condition_leeching(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Leeching", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn condition_leeching_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LeechingLife", ModType::Flag, b(true), "Config", vec![combat_tag()]));
    ctx.mods.push(new_mod("Condition:Leeching", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn condition_leeching_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LeechingEnergyShield", ModType::Flag, b(true), "Config", vec![combat_tag()]));
    ctx.mods.push(new_mod("Condition:Leeching", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn condition_leeching_mana(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LeechingMana", ModType::Flag, b(true), "Config", vec![combat_tag()]));
    ctx.mods.push(new_mod("Condition:Leeching", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn minions_condition_leeching_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner1 = new_mod("Condition:LeechingEnergyShield", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner1))]), "Config", vec![]));
    let inner2 = new_mod("Condition:Leeching", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner2))]), "Config", vec![]));
}
fn condition_using_flask(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:UsingFlask", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}
fn condition_used_amethyst_flask_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:UsedAmethystFlaskRecently",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat_tag(), tag("Condition", &[("var", s("HaveAmethystFlask"))])],
    ));
}
fn condition_used_ruby_flask_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:UsedRubyFlaskRecently",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat_tag(), tag("Condition", &[("var", s("HaveRubyFlask"))])],
    ));
}
fn condition_used_sapphire_flask_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:UsedSapphireFlaskRecently",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat_tag(), tag("Condition", &[("var", s("HaveSapphireFlask"))])],
    ));
}
fn condition_used_topaz_flask_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:UsedTopazFlaskRecently",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat_tag(), tag("Condition", &[("var", s("HaveTopazFlask"))])],
    ));
}
fn condition_using_tincture(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:UsingTincture", ModType::Flag, b(true), "Config", vec![combat_tag()]));
}

pub fn register(map: &mut HandlerMap) {
    map.insert("useSiphoningCharges", use_siphoning_charges);
    map.insert("overrideSiphoningCharges", override_siphoning_charges);
    map.insert("useChallengerCharges", use_challenger_charges);
    map.insert("overrideChallengerCharges", override_challenger_charges);
    map.insert("useBlitzCharges", use_blitz_charges);
    map.insert("overrideBlitzCharges", override_blitz_charges);
    map.insert("multiplierGaleForce", multiplier_gale_force);
    map.insert("overrideInspirationCharges", override_inspiration_charges);
    map.insert("useGhostShrouds", use_ghost_shrouds);
    map.insert("overrideGhostShrouds", override_ghost_shrouds);
    map.insert("waitForMaxSeals", wait_for_max_seals);
    map.insert("repeatMode", repeat_mode);
    map.insert("overrideBloodCharges", override_blood_charges);
    map.insert("overrideSpiritCharges", override_spirit_charges);
    map.insert("overrideSpiritInfusion", override_spirit_infusion);
    map.insert("minionsUsePowerCharges", minions_use_power_charges);
    map.insert("minionsUseFrenzyCharges", minions_use_frenzy_charges);
    map.insert("minionsUseEnduranceCharges", minions_use_endurance_charges);
    map.insert("minionsOverridePowerCharges", minions_override_power_charges);
    map.insert("minionsOverrideFrenzyCharges", minions_override_frenzy_charges);
    map.insert("minionsOverrideEnduranceCharges", minions_override_endurance_charges);
    map.insert("multiplierRampage", multiplier_rampage);
    map.insert("multiplierSoulEater", multiplier_soul_eater);
    map.insert("multiplierMinionSoulEater", multiplier_minion_soul_eater);
    map.insert("conditionFocused", condition_focused);
    map.insert("buffLifetap", buff_lifetap);
    map.insert("buffOnslaught", buff_onslaught);
    map.insert("buffArcaneSurge", buff_arcane_surge);
    map.insert("minionBuffOnslaught", minion_buff_onslaught);
    map.insert("buffUnholyMight", buff_unholy_might);
    map.insert("minionbuffUnholyMight", minionbuff_unholy_might);
    map.insert("buffChaoticMight", buff_chaotic_might);
    map.insert("buffSacrificialZeal", buff_sacrificial_zeal);
    map.insert("minionbuffChaoticMight", minionbuff_chaotic_might);
    map.insert("buffPhasing", buff_phasing);
    map.insert("buffFortification", buff_fortification);
    map.insert("overrideFortification", override_fortification);
    map.insert("buffTailwind", buff_tailwind);
    map.insert("buffAdrenaline", buff_adrenaline);
    map.insert("conditionChangedStanceLastSecond", condition_changed_stance_last_second);
    map.insert("buffAlchemistsGenius", buff_alchemists_genius);
    map.insert("buffVaalArcLuckyHits", buff_vaal_arc_lucky_hits);
    map.insert("buffElusive", buff_elusive);
    map.insert("overrideBuffElusive", override_buff_elusive);
    map.insert("buffDivinity", buff_divinity);
    map.insert("multiplierDefiance", multiplier_defiance);
    map.insert("multiplierRage", multiplier_rage);
    map.insert("buffWildSavagery", buff_wild_savagery);
    map.insert("conditionLeeching", condition_leeching);
    map.insert("conditionLeechingLife", condition_leeching_life);
    map.insert("conditionLeechingEnergyShield", condition_leeching_energy_shield);
    map.insert("conditionLeechingMana", condition_leeching_mana);
    map.insert("minionsConditionLeechingEnergyShield", minions_condition_leeching_energy_shield);
    map.insert("conditionUsingFlask", condition_using_flask);
    map.insert("conditionUsedAmethystFlaskRecently", condition_used_amethyst_flask_recently);
    map.insert("conditionUsedRubyFlaskRecently", condition_used_ruby_flask_recently);
    map.insert("conditionUsedSapphireFlaskRecently", condition_used_sapphire_flask_recently);
    map.insert("conditionUsedTopazFlaskRecently", condition_used_topaz_flask_recently);
    map.insert("conditionUsingTincture", condition_using_tincture);
}
