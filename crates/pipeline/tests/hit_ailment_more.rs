//! Skill stats worded "more Damage with Hits and Ailments" carry KeywordFlag Hit|Ailment (786432), not 0.
//! Upstream's `bit.band(ModFlag.Hit, ModFlag.Ailment)` is 0, so the mod also scaled Decay and other non-ailment DoT.

#[test]
fn hit_and_ailment_more_is_hit_or_ailment_keyword() {
    // Run with POM_STRICT_COMPAT unset. Quality 20: Vaal Molten Strike has the stat only as a quality stat (0.5 per quality).
    for id in ["FlamethrowerTrap", "FrostBlades", "LightningStrike", "LightningStrikeAltX", "MoltenStrike", "MoltenStrikeAltX", "VaalMoltenStrike", "StaticStrikeAltX", "VolcanicFissure"] {
        let ge = pom_skills::data::granted_effect_by_skill_id(id).unwrap_or_else(|| panic!("{id}"));
        let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 20.0, None, &[], false);
        let flags: Vec<u64> = mods.iter().filter(|m| m.name.as_str() == "Damage").map(|m| m.keyword_flags).collect();
        assert!(flags.contains(&786432), "{id}: no Damage mod with Hit|Ailment keyword flags, got {flags:?}");
    }
}
