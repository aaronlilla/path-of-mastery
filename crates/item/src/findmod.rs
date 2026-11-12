//! Port of `ItemClass:FindModifierSubstring` (Classes/Item.lua:289-333), the item-mod-line text
//! search behind `ItemCondition`'s `searchCond` tags ("if there are no Life modifiers on equipped
//! Body Armour"). `data.itemTagSpecial`/`data.itemTagSpecialExclusionPattern` come from the
//! exported `data_itemTagSpecial.json`/`data_itemTagSpecialExclusionPattern.json`.
use crate::item::Item;
use pom_engine::data::GameData;
use pom_engine::luapat::find;
use pom_engine::fxhash::HashMap;

/// substring -> lower-cased slot name -> Lua patterns.
type TagTable = HashMap<String, HashMap<String, Vec<String>>>;

#[derive(Default)]
pub struct ItemTagData {
    pub special: TagTable,
    pub exclusion: TagTable,
}

fn load_table(game: &GameData, key: &str) -> TagTable {
    let mut out = TagTable::default();
    let Ok(Some(v)) = game.extra.get(key) else { return out };
    let Some(obj) = v.as_object() else { return out };
    for (sub, slots) in obj {
        let mut m = HashMap::default();
        if let Some(sobj) = slots.as_object() {
            for (slot, list) in sobj {
                let pats = list.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                m.insert(slot.to_string(), pats);
            }
        }
        out.insert(sub.to_string(), m);
    }
    out
}

impl ItemTagData {
    pub fn load(game: &GameData) -> ItemTagData {
        ItemTagData { special: load_table(game, "itemTagSpecial"), exclusion: load_table(game, "itemTagSpecialExclusionPattern") }
    }
}

fn lua_find(s: &str, pat: &str) -> bool {
    matches!(find(s.as_bytes(), pat.as_bytes(), None, false), Ok(Some(_)))
}

/// `substring` and `slot_name` are already lower-cased by the caller (as ModStore.lua:717 does).
pub fn find_modifier_substring(item: &Item, substring: &str, slot_name: &str, tags: &ItemTagData) -> bool {
    let explicit = substring.contains("explicit ");
    let substring = substring.replace("explicit ", "");
    let mut lines: Vec<&crate::item::ModLine> = item.explicit_mod_lines.iter().collect();
    if !explicit {
        for bucket in [&item.enchant_mod_lines, &item.scourge_mod_lines, &item.implicit_mod_lines, &item.crucible_mod_lines] {
            lines.extend(bucket.iter());
        }
    }
    let excl = tags.exclusion.get(&substring).and_then(|m| m.get(slot_name));
    let special = tags.special.get(&substring).and_then(|m| m.get(slot_name));
    let modifier_pat = format!("{substring} modifier");
    for v in lines {
        if v.disabled || !crate::buildmod::is_line_active(&v.variant_list, item.variant_count, item.selected_variant, &item.alt_variants) {
            continue;
        }
        let line = v.line.to_lowercase();
        if lua_find(&line, &substring) && !lua_find(&line, &modifier_pat) {
            let excluded = excl.map(|l| l.iter().any(|p| lua_find(&line, &p.to_lowercase()))).unwrap_or(false);
            if !excluded {
                return true;
            }
        }
        if let Some(l) = special {
            if l.iter().any(|p| lua_find(&line, &p.to_lowercase())) {
                return true;
            }
        }
    }
    false
}
