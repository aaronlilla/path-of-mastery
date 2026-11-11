//! CalcSetup.lua:1228-1268: Quiver (Widowhail / tree "bonuses from equipped Quiver"), Gloves and Boots
//! ("increased bonuses gained from equipped Gloves/Boots") get their whole mod list scaled.
use crate::item_mods_for_slot;
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashMap;

/// `ModList:MergeMod` (ModList.lua:73-86): BASE/INC/MORE mods with identical name/type/flags/tags fold into the
/// first one (values summed, first source kept).
fn merge_mod_list(mods: &[Mod]) -> Vec<Mod> {
    let mut out: Vec<Mod> = Vec::new();
    for m in mods {
        if matches!(m.ty, ModType::Base | ModType::Inc | ModType::More) {
            if let Some(e) = out.iter_mut().find(|e| e.name == m.name && e.ty == m.ty && e.flags == m.flags && e.keyword_flags == m.keyword_flags && e.tags == m.tags) {
                if let (Some(a), Some(b)) = (e.value.num(), m.value.num()) {
                    e.value = Value::Num(a + b);
                    continue;
                }
            }
        }
        out.push(m.clone());
    }
    out
}

/// Returns the mods to add (plus Widowhail's `WidowHailMultiplier` mod), or None when none of these branches applies.
pub fn equipped_bonus_mods(
    item: &pom_item::Item,
    _slot_name: &str,
    scale: f64,
    mods: &[Mod],
    slots: &[(String, i64, bool)],
    items: &HashMap<i64, std::rc::Rc<pom_item::Item>>,
    tree: &ModStore,
) -> Option<(Vec<Mod>, Option<Mod>)> {
    let ty = item.item_type.as_deref()?;
    match ty {
        "Quiver" => {
            let eq = pom_engine::sym!("EffectOfBonusesFromQuiver");
            let tree_sum = tree.sum(ModType::Inc, None, &[eq]);
            let w1 = slots.iter().find(|(n, _, _)| n == "Weapon 1").and_then(|(_, id, _)| items.get(id));
            let is_widow = w1.map_or(false, |w| w.name.contains("Widowhail"));
            if !is_widow && !(tree_sum > 0.0) {
                return None;
            }
            let widow_hail_mod = match w1 {
                Some(w) => {
                    let own: f64 = item_mods_for_slot(w, "Weapon 1").iter().filter(|m| m.name == eq && m.ty == ModType::Inc).filter_map(|m| m.value.num()).sum();
                    1.0 + (own + tree_sum) / 100.0
                }
                None => 2.0,
            };
            let combined = merge_mod_list(mods);
            let list = pom_calc::perform::scale_add_list(&combined, scale * widow_hail_mod);
            let extra = Mod { name: pom_engine::sym!("WidowHailMultiplier"), ty: ModType::Base, value: Value::Num(widow_hail_mod), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Widowhail")), tags: (vec![]).into() };
            Some((list, Some(extra)))
        }
        "Gloves" | "Boots" => {
            let sym = Sym::new(if ty == "Gloves" { "EffectOfBonusesFromGloves" } else { "EffectOfBonusesFromBoots" });
            let f = (1.0 + tree.sum(ModType::Inc, None, &[sym]) / 100.0) * tree.more(None, &[sym]);
            if f == 1.0 {
                return None;
            }
            let mut combined = merge_mod_list(mods);
            // scaledList = ScaleAddList(combined, f-1); combined:MergeMod(mod, true) folds each into a matching entry only.
            let scaled = pom_calc::perform::scale_add_list(&combined, f - 1.0);
            for sm in scaled {
                if matches!(sm.ty, ModType::Base | ModType::Inc | ModType::More) {
                    if let Some(e) = combined.iter_mut().find(|e| e.name == sm.name && e.ty == sm.ty && e.flags == sm.flags && e.keyword_flags == sm.keyword_flags && e.tags == sm.tags) {
                        if let (Some(a), Some(b)) = (e.value.num(), sm.value.num()) {
                            e.value = Value::Num(a + b);
                        }
                    }
                }
            }
            Some((combined, None))
        }
        _ => None,
    }
}
