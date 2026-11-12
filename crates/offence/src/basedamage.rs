// Port of the "Calculate base hit damage" block inside CalcOffence.lua's second passList loop
// (3346-3358): for each of the 5 damage types, sets `output[<Type>MinBase]`/`[<Type>MaxBase]` from
// the pass's `source` table (a weapon's own `PhysicalMin`/`PhysicalMax`/etc for an attack pass, or
// `skillData` itself for a spell/DoT "Skill" pass) plus any flat added-damage mods. This is the
// literal source of the `<Type>MinBase`/`MaxBase` fields `conversion::calc_damage` reads - see that
// module's header for how the two fit together.
use crate::conversion::DMG_TYPES;
use crate::tools::calc_lib_mod;
use crate::weapon::WeaponSource;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

/// `baseMultiplier`/`damageEffectiveness` (CalcOffence.lua:3350-3351): the Lua prefers
/// `activeSkill.activeEffect.grantedEffectLevel.<field>` over `skillData.<field>`, but that gem
/// level-curve table isn't part of this crate's isolation layer (SkillView has no gem-data access).
/// `skillData.damageEffectiveness`/`.baseMultiplier`, when present, are themselves
/// copied from that same per-level gem data via a "SkillData" mod at setup time
/// (Modules/CalcSetup.lua:1950-1965), so reading them directly here reproduces the same value for
/// every build in the golden sample.
pub fn base_multiplier(skill_data_base_multiplier: Option<f64>) -> f64 {
    skill_data_base_multiplier.unwrap_or(1.0)
}
pub fn damage_effectiveness(skill_data_damage_effectiveness: Option<f64>) -> f64 {
    skill_data_damage_effectiveness.unwrap_or(1.0)
}

/// One damage type's `<Type>MinBase`/`<Type>MaxBase` (CalcOffence.lua:3346-3358).
pub fn assign_base_damage(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    cfg: Option<&Cfg>,
    source: &WeaponSource,
    base_multiplier: f64,
    damage_effectiveness: f64,
) -> HashMap<String, f64> {
    let mut out = HashMap::default();
    for damage_type in DMG_TYPES {
        let min_key = format!("{damage_type}Min");
        let max_key = format!("{damage_type}Max");
        let added_min = skill_mod_list.sum(ModType::Base, cfg, &[Sym::new(&min_key)]) + enemy_db.sum(ModType::Base, cfg, &[Sym::new(&format!("Self{min_key}"))]);
        let added_max = skill_mod_list.sum(ModType::Base, cfg, &[Sym::new(&max_key)]) + enemy_db.sum(ModType::Base, cfg, &[Sym::new(&format!("Self{max_key}"))]);
        if pom_engine::env::var("POM_DEBUG_BASE").is_ok() {
            eprintln!("BASE {damage_type} addedMin={added_min} de={damage_effectiveness} baseMult={base_multiplier} src={}", source.get(&min_key));
            for (v, m) in skill_mod_list.tabulate(Some(ModType::Base), cfg, &[Sym::new(&min_key)]) {
                let m = unsafe { &*m };
                eprintln!("   {:?} {:?} tags={:?}", m.source, v, m.tags.iter().map(|g| g.kind.as_str().to_string()).collect::<Vec<_>>());
            }
        }
        let added_name = format!("Added{damage_type}Damage");
        let added_mult = calc_lib_mod(skill_mod_list, cfg, &[added_name.as_str(), "AddedDamage"]);
        let base_min = (source.get(&min_key) + source.get(&format!("{damage_type}BonusMin"))) * base_multiplier + added_min * damage_effectiveness * added_mult;
        let base_max = (source.get(&max_key) + source.get(&format!("{damage_type}BonusMax"))) * base_multiplier + added_max * damage_effectiveness * added_mult;
        out.insert(format!("{min_key}Base"), base_min);
        out.insert(format!("{max_key}Base"), base_max);
    }
    out
}
