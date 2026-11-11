//! The Configuration tab's mod browser (`Modules/ConfigModBrowser.lua`, `OpenAddModPopup`): every modifier line the
//! build's passive tree and the item mod tables offer, deduplicated by template (numbers replaced by `#`), with where it
//! comes from, keeping the lines the mod parser accepts, sorted as upstream sorts them. Search and ranking
//! (`fuzzyScore`) are the client's.
use pom_engine::cjson::J;
use pom_engine::data::GameData;
use pom_engine::modparser::parse_mod;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

struct Entry {
    text: String,
    sources: BTreeSet<String>,
    supported: Option<bool>,
}

/// `getModTemplate`: ranges `(a-b)` and numbers become `#` (a sign kept before a range), lower case.
pub fn template_of(text: &str) -> String {
    let b: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let num_end = |from: usize| -> Option<usize> {
        // `%-?%d+%.?%d*`
        let mut j = from;
        if j < b.len() && b[j] == '-' {
            j += 1;
        }
        let start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == start {
            return None;
        }
        if j < b.len() && b[j] == '.' {
            j += 1;
        }
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        Some(j)
    };
    // Pass 1: `([%+-]?)%(NUM-NUM%)` -> sign .. "#"
    let mut stage1 = String::new();
    while i < b.len() {
        let sign_len = if b[i] == '+' || b[i] == '-' { 1 } else { 0 };
        let p = i + sign_len;
        if p < b.len() && b[p] == '(' {
            if let Some(e1) = num_end(p + 1) {
                if e1 < b.len() && b[e1] == '-' {
                    if let Some(e2) = num_end(e1 + 1) {
                        if e2 < b.len() && b[e2] == ')' {
                            if sign_len == 1 {
                                stage1.push(b[i]);
                            }
                            stage1.push('#');
                            i = e2 + 1;
                            continue;
                        }
                    }
                }
            }
        }
        stage1.push(b[i]);
        i += 1;
    }
    // Pass 2: `%d+%.?%d*` -> "#"
    let c: Vec<char> = stage1.chars().collect();
    let mut k = 0;
    while k < c.len() {
        if c[k].is_ascii_digit() {
            while k < c.len() && c[k].is_ascii_digit() {
                k += 1;
            }
            if k < c.len() && c[k] == '.' {
                k += 1;
            }
            while k < c.len() && c[k].is_ascii_digit() {
                k += 1;
            }
            out.push('#');
        } else {
            out.push(c[k]);
            k += 1;
        }
    }
    out.to_lowercase()
}

/// The sort key: the template without `#` and non-letters, single-spaced.
fn sort_key(template: &str) -> String {
    let mut s = String::new();
    let mut last_space = true;
    for ch in template.chars() {
        if ch.is_ascii_alphabetic() {
            s.push(ch);
            last_space = false;
        } else if !last_space {
            s.push(' ');
            last_space = true;
        }
    }
    s.trim().to_string()
}

fn add_line(set: &mut BTreeMap<String, Entry>, line: &str, source: &str, supported: Option<bool>) {
    let template = template_of(line);
    let e = set.entry(template).or_insert_with(|| Entry { text: line.to_string(), sources: BTreeSet::new(), supported: None });
    e.sources.insert(source.to_string());
    if let Some(s) = supported {
        if s && e.supported != Some(true) {
            e.text = line.to_string();
        }
        e.supported = Some(e.supported.unwrap_or(false) || s);
    }
}

fn parses(line: &str) -> bool {
    matches!(parse_mod(line), (Some(_), None))
}

fn str_list(v: J) -> Vec<String> {
    let Some(a) = v.as_array() else { return Vec::new() };
    a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
}

/// A Lua table that is an array or an object keyed "1", "2", ...: its element `i` (1-based).
fn lua_at(v: J, i: usize) -> Option<J> {
    if v.is_array() {
        v.get(i - 1)
    } else {
        v.get(i.to_string())
    }
}

fn add_item_mod(seen: &mut BTreeSet<String>, set: &mut BTreeMap<String, Entry>, game: &GameData, m: J, source: &str) {
    let group = m.get("group").and_then(|g| g.as_str()).unwrap_or("").to_string();
    if !seen.insert(group) {
        return;
    }
    let ranged = |line: &str| pom_item::parse::test_resolve_bare_ranges_at(line, 0.5, game);
    if let Some(hashes) = m.get("tradeHashes").and_then(|h| h.as_object()) {
        for (_, desc) in hashes.iter() {
            let line = str_list(desc).join(" ");
            let r = ranged(&line);
            add_line(set, &r, source, Some(parses(&r)));
        }
    } else {
        let mut i = 1;
        while let Some(l) = lua_at(m, i).and_then(|x| x.as_str()) {
            let r = ranged(l);
            add_line(set, &r, source, Some(parses(&r)));
            i += 1;
        }
    }
}

/// `config_mods` for the build text's active spec (its tree version).
pub fn config_mods_for(xml: &str, game: &'static GameData) -> Result<Value, String> {
    let version = pom_passives::xmlspec::parse_active_spec(xml).ok().and_then(|p| p.tree_version).unwrap_or_else(|| "3_6".to_string());
    thread_local! {
        static CACHE: std::cell::RefCell<std::collections::HashMap<String, Value>> = std::cell::RefCell::new(Default::default());
    }
    if let Some(v) = CACHE.with(|c| c.borrow().get(&version).cloned()) {
        return Ok(v);
    }
    let v = config_mods(&version, game)?;
    CACHE.with(|c| c.borrow_mut().insert(version, v.clone()));
    Ok(v)
}

/// `{ mods: [{ text, sources: [...] }] }` for a build on tree version `tree_version` (the active spec's).
pub fn config_mods(tree_version: &str, game: &'static GameData) -> Result<Value, String> {
    let tree = crate::cached_tree(tree_version)?;
    let root = tree.root;
    let mut set: BTreeMap<String, Entry> = BTreeMap::new();
    let mut ids: Vec<i64> = tree.nodes.keys().copied().collect();
    ids.sort_unstable();
    for id in ids {
        let node = tree.nodes[&id];
        let ty = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty == "Mastery" {
            if let Some(effects) = node.get("masteryEffects").map(|e| pom_passives::treedata::deref(root, e)).and_then(|e| e.as_array()) {
                for eff in effects.iter() {
                    let eff = pom_passives::treedata::deref(root, eff);
                    let stats = eff.get("stats").map(|s| pom_passives::treedata::deref(root, s)).map(str_list).unwrap_or_default();
                    for line in stats {
                        add_line(&mut set, &line, "Mastery Node", Some(parses(&line)));
                    }
                }
            }
            continue;
        }
        let stats = node.get("sd").map(|s| pom_passives::treedata::deref(root, s)).map(str_list).unwrap_or_default();
        let mods = node.get("mods").map(|m| pom_passives::treedata::deref(root, m));
        let mod_at = |i: usize| mods.and_then(|m| lua_at(m, i)).map(|m| pom_passives::treedata::deref(root, m));
        let mut i = 1;
        while i <= stats.len() {
            let mut combined = stats[i - 1].clone();
            while let Some(next) = mod_at(i + 1) {
                if next.get("combined").map(|c| c.as_bool().unwrap_or(true)).unwrap_or(false) && i < stats.len() {
                    combined = format!("{combined} {}", stats[i]);
                    i += 1;
                } else {
                    break;
                }
            }
            let supported = mod_at(i).map(|m| m.get("list").is_some() && m.get("extra").is_none()).unwrap_or(false);
            let prefix = if node.get("isBloodline").and_then(|b| b.as_bool()).unwrap_or(false) {
                "Bloodline "
            } else if node.get("ascendancyName").is_some() {
                "Ascendancy "
            } else {
                ""
            };
            add_line(&mut set, &combined, &format!("{prefix}{ty} Node"), Some(supported));
            i += 1;
        }
    }
    let mut seen = BTreeSet::new();
    if let Ok(Some(master)) = game.extra.get("masterMods") {
        let mut i = 0;
        while let Some(m) = master.get(i) {
            add_item_mod(&mut seen, &mut set, game, m, "Crafted mod");
            i += 1;
        }
    }
    if let Ok(Some(item_mods)) = game.extra.get("itemMods") {
        if let Some(cats) = item_mods.as_object() {
            for (name, cat) in cats.iter() {
                if name == "Item" || name == "JewelCluster" {
                    continue;
                }
                if let Some(mods) = cat.as_object() {
                    for (_, m) in mods.iter() {
                        add_item_mod(&mut seen, &mut set, game, m, "Item mod");
                    }
                }
            }
        }
    }
    for (key, source) in [("veiledMods", "Veiled mod"), ("beastCraft", "Item mod")] {
        if let Ok(Some(mods)) = game.extra.get(key) {
            if let Some(o) = mods.as_object() {
                for (_, m) in o.iter() {
                    add_item_mod(&mut seen, &mut set, game, m, source);
                }
            }
        }
    }
    let mut list: Vec<(String, String, &Entry)> = set.iter().filter(|(_, e)| e.supported == Some(true)).map(|(t, e)| (sort_key(t), t.clone(), e)).collect();
    list.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.text.cmp(&b.2.text)));
    let mods: Vec<Value> = list.into_iter().map(|(_, _, e)| json!({ "text": e.text, "sources": e.sources.iter().collect::<Vec<_>>() })).collect();
    Ok(json!({ "mods": mods }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates() {
        assert_eq!(template_of("+(10-20)% to Fire Resistance"), "+#% to fire resistance");
        assert_eq!(template_of("Adds (3-5) to 12.5 Damage"), "adds # to # damage");
        assert_eq!(template_of("-(5-10) Life"), "-# life");
    }

    #[test]
    fn sort_keys() {
        assert_eq!(sort_key("+#% to fire resistance"), "to fire resistance");
        assert_eq!(sort_key("adds # to # damage"), "adds to damage");
    }

    #[test]
    fn browser_lists_supported_lines() {
        let game = pom_calc::data::game_data();
        let v = config_mods("3_29", game).unwrap();
        let mods = v["mods"].as_array().unwrap();
        assert!(mods.len() > 1000, "{}", mods.len());
        assert!(mods.iter().any(|m| m["sources"].as_array().unwrap().iter().any(|s| s == "Notable Node")));
        assert!(mods.iter().any(|m| m["sources"].as_array().unwrap().iter().any(|s| s == "Item mod")));
        let texts: Vec<&str> = mods.iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert!(texts.iter().all(|t| parses(t)), "unsupported line listed");
    }
}
