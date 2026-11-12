//! Port of `calcs.defenceForConditionals(env, actor)` (Modules/CalcDefence.lua lines 481-508).
use crate::snapshot::ArmourData;
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

pub const ARMOUR_SLOTS: &[&str] = &["Helmet", "Gloves", "Boots", "Body Armour", "Weapon 2", "Weapon 3"];

pub fn defence_for_conditionals(store: &ModStore, item_armour: &HashMap<String, ArmourData>, output: &mut HashMap<String, f64>) {
    for &slot in ARMOUR_SLOTS {
        let Some(armour) = item_armour.get(slot) else { continue };
        if !store.flag(None, &[Sym::new(&format!("GainNoWardFrom{slot}"))]) && armour.ward > 0.0 {
            output.insert(format!("WardOn{slot}"), armour.ward);
        }
        if !store.flag(None, &[Sym::new(&format!("GainNoEnergyShieldFrom{slot}"))]) && armour.energy_shield > 0.0 {
            output.insert(format!("EnergyShieldOn{slot}"), armour.energy_shield);
        }
        if !store.flag(None, &[Sym::new(&format!("GainNoArmourFrom{slot}"))]) && armour.armour > 0.0 {
            output.insert(format!("ArmourOn{slot}"), armour.armour);
        }
        if !store.flag(None, &[Sym::new(&format!("GainNoEvasionFrom{slot}"))]) && armour.evasion > 0.0 {
            output.insert(format!("EvasionOn{slot}"), armour.evasion);
        }
    }
}
