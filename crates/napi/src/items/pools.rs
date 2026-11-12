//! The modifier pools the item editor adds to: the Crucible passive tree's modifiers, the prefix and suffix rows of a
//! crafted item with their tiers, and writing those rows back into the item text (`ItemClass:Craft`).
use super::*;
use pom_engine::cjson::J;
use std::collections::HashSet;

static DROP_ONLY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();

/// `Data/DelveDropOnly.lua` and `Data/IncursionDropOnly.lua`: for each drop-restricted modifier id, the item types it
/// comes on (generated from the game data; the modifiers themselves are in engine-data's itemMods).
pub(super) fn drop_only() -> &'static Value {
    DROP_ONLY.get_or_init(|| serde_json::from_str(include_str!("../../data/drop_only.json")).unwrap_or(Value::Null))
}

/// The lower-cased text of every modifier line of the item (what `ItemClass:ParseRaw` tests for its flags).
pub(super) fn all_lines_lower(item: &Item) -> Vec<String> {
    [&item.enchant_mod_lines, &item.scourge_mod_lines, &item.implicit_mod_lines, &item.explicit_mod_lines, &item.crucible_mod_lines, &item.class_requirement_mod_lines]
        .into_iter()
        .flat_map(|b| b.iter().filter(|ml| !ml.disabled).map(|ml| ml.line.to_lowercase()))
        .collect()
}

/// How many enchantment slots the item has (1 to 4), from its "can have N additional enchantment modifiers" lines.
pub(super) fn max_enchants(lines: &[String]) -> usize {
    let mut n = 1;
    for l in lines {
        match l.as_str() {
            "can have a second enchantment modifier" | "can have 1 additional enchantment modifiers" => n = n.max(2),
            "can have 2 additional enchantment modifiers" => n = n.max(3),
            "can have 3 additional enchantment modifiers" => n = n.max(4),
            _ => {}
        }
    }
    n
}

/// `ItemClass:GetModSpawnWeight` with its include and exclude tag sets (the restrict-tag flags that only some uniques set
/// are not modelled).
fn weight_ex(m: &J, base_tags: &HashSet<String>, include: &[&str], exclude: &[&str], inf: &HashMap<String, String>) -> f64 {
    let hit = |k: &str| (base_tags.contains(k) || include.contains(&k) || inf.values().any(|v| v == k)) && !exclude.contains(&k);
    let keys = str_list(m.get("weightKey"));
    let vals: Vec<f64> = m.get("weightVal").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
    let mut w = 0.0;
    for (i, k) in keys.iter().enumerate() {
        if hit(k) {
            let elevated = inf.values().any(|v| v == k) && jstr(m, "affix").is_some_and(|a| a.contains("Elevated"));
            w = if elevated { 1000.0 } else { vals.get(i).copied().unwrap_or(0.0) };
            break;
        }
    }
    let mk = str_list(m.get("weightMultiplierKey"));
    let mv: Vec<f64> = m.get("weightMultiplierVal").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
    for (i, k) in mk.iter().enumerate() {
        if hit(k) {
            w = w * mv.get(i).copied().unwrap_or(100.0) / 100.0;
            break;
        }
    }
    w
}

/// The label of a group of modifier tiers: ranges and numbers become `#` (`UpdateAffixControl`).
fn series_label(line: &str) -> String {
    let b: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let numeric = |c: char| c.is_ascii_digit() || c == '.';
    while i < b.len() {
        // "(a-b)" ranges, with optional signs.
        if b[i] == '(' {
            let mut j = i + 1;
            if j < b.len() && b[j] == '-' {
                j += 1;
            }
            let s1 = j;
            while j < b.len() && numeric(b[j]) {
                j += 1;
            }
            if j > s1 && j < b.len() && b[j] == '-' {
                j += 1;
                if j < b.len() && b[j] == '-' {
                    j += 1;
                }
                let s2 = j;
                while j < b.len() && numeric(b[j]) {
                    j += 1;
                }
                if j > s2 && j < b.len() && b[j] == ')' {
                    out.push('#');
                    i = j + 1;
                    continue;
                }
            }
        }
        if b[i].is_ascii_digit() || (b[i] == '-' && i + 1 < b.len() && b[i + 1].is_ascii_digit()) {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j < b.len() && b[j] == '.' && j + 1 < b.len() && b[j + 1].is_ascii_digit() {
                j += 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
            }
            out.push('#');
            i = j;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// The prefix and suffix limits of a crafted item (`ItemClass:ParseRaw` after the modifier lines): magic items have 1 and 1,
/// rares 3 and 3 (2 and 2 for jewels and grafts), moved by "+N Prefix Modifiers allowed" lines.
pub(super) fn affix_limits(item: &Item, ty: &str, lines: &[String]) -> (usize, usize) {
    let adj = |word: &str| -> Option<i64> {
        let mut found: Option<i64> = None;
        for l in lines {
            let pat = format!(" {word} modifier");
            if let Some(at) = l.find(&pat) {
                if l[at..].contains(" allowed") {
                    let head = &l[..at];
                    let num: String = head.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
                    let sign = head[..head.len() - num.len()].chars().last();
                    if let Ok(n) = num.parse::<i64>() {
                        found = Some(found.unwrap_or(0) + if sign == Some('-') { -n } else { n });
                    }
                }
            }
        }
        found
    };
    let (p, s) = (adj("prefix"), adj("suffix"));
    if item.rarity == "MAGIC" {
        if p.is_some() || s.is_some() {
            return (((p.unwrap_or(0) + 1).clamp(0, 2)) as usize, ((s.unwrap_or(0) + 1).clamp(0, 2)) as usize);
        }
        return (1, 1);
    }
    let total: i64 = if ty == "Jewel" || ty == "Graft" { 4 } else { 6 };
    if p.is_some() || s.is_some() {
        return (((p.unwrap_or(0) + total / 2).clamp(0, total)) as usize, ((s.unwrap_or(0) + total / 2).clamp(0, total)) as usize);
    }
    ((total / 2) as usize, (total / 2) as usize)
}

/// The item's chosen affixes from its `Prefix:` and `Suffix:` lines: (is prefix, modifier id or affix name, range).
fn affix_spec(text: &str) -> Vec<(bool, String, Option<f64>, bool)> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            let (is_prefix, rest) = if let Some(r) = l.strip_prefix("Prefix:") {
                (true, r)
            } else if let Some(r) = l.strip_prefix("Suffix:") {
                (false, r)
            } else {
                return None;
            };
            let rest = rest.trim();
            let range = rest.find("{range:").and_then(|i| rest[i + 7..].split('}').next().and_then(|v| v.split(',').next()).and_then(|v| v.parse::<f64>().ok()));
            let fractured = rest.starts_with("{fractured}");
            let mut id = rest;
            while let Some(r) = id.strip_prefix('{') {
                match r.find('}') {
                    Some(i) => id = &r[i + 1..],
                    None => break,
                }
            }
            Some((is_prefix, id.trim().to_string(), range, fractured))
        })
        .collect()
}

/// The Crucible modifiers the item's five tree nodes can hold, and which ones it has (`AddCrucibleModifierToDisplayItem`):
/// `{"nodes": [[{id, lines, tier, type, tags}...] x5], "selected": [id|null x5]}`.
pub(super) fn crucible(game: &'static GameData, item: &Item, tags: &HashSet<String>, inf: &HashMap<String, String>) -> Result<Value, String> {
    let tbl = game.extra.get("crucible")?.ok_or("no crucible data")?;
    let title = item.title.clone().unwrap_or_default();
    let listed = |name: &str| game.extra.get(name).ok().flatten().is_some_and(|o| o.get(title.as_str()).is_some());
    let mut include: Vec<&str> = Vec::new();
    if listed("casterTagCrucibleUniques") {
        include.push("caster_unique_weapon");
    }
    if listed("minionTagCrucibleUniques") {
        include.push("minion_unique_weapon");
    }
    let lines = all_lines_lower(item);
    let has = |l: &str| lines.iter().any(|x| x == l);
    let support_only = has("has a crucible passive skill tree with only support passive skills");
    let shield_tree = has("has a crucible passive skill tree");
    let two_hand_sword = has("has a two handed sword crucible passive skill tree");
    let can_have = |m: &J| -> bool {
        if support_only {
            let keys = str_list(m.get("weightKey"));
            let vals: Vec<f64> = m.get("weightVal").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            return keys.iter().position(|k| k == "crucible_unique_staff").is_some_and(|i| vals.get(i).copied().unwrap_or(0.0) != 0.0);
        }
        if shield_tree {
            return weight_ex(m, tags, &["crucible_unique_helmet", "shield"], &[], inf) > 0.0;
        }
        if two_hand_sword {
            return weight_ex(m, tags, &["two_hand_weapon"], &["one_hand_weapon"], inf) > 0.0;
        }
        weight_ex(m, tags, &include, &[], inf) > 0.0
    };
    let have: HashSet<String> = item.crucible_mod_lines.iter().map(|l| l.line.clone()).collect();
    let mut nodes: Vec<Vec<(bool, String, Value)>> = vec![Vec::new(); 5];
    let mut selected: Vec<Value> = vec![Value::Null; 5];
    if let Some(o) = tbl.as_object() {
        for (id, m) in o.iter() {
            if !can_have(&m) {
                continue;
            }
            let mlines = mod_lines(&m);
            let locs: Vec<usize> = m.get("nodeLocation").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as usize).collect()).unwrap_or_default();
            if locs.is_empty() {
                continue;
            }
            if mlines.first().is_some_and(|l| have.contains(l)) && mlines.get(1).is_none_or(|l| have.contains(l)) {
                let first = locs[0];
                let slot = if (1..=5).contains(&first) && !selected[first - 1].is_null() && locs.len() > 1 { locs[1] } else { first };
                if (1..=5).contains(&slot) {
                    selected[slot - 1] = json!(id);
                }
            }
            let entry = json!({ "id": id, "lines": mlines, "tier": m.get("tier").and_then(|t| t.as_f64()), "type": jstr(&m, "type"), "tags": str_list(m.get("modTags")) });
            let merge_only = jstr(&m, "type").as_deref() == Some("MergeOnly");
            for loc in locs {
                if (1..=5).contains(&loc) {
                    nodes[loc - 1].push((merge_only, id.to_string(), entry.clone()));
                }
            }
        }
    }
    let nodes: Vec<Value> = nodes
        .into_iter()
        .map(|mut v| {
            v.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
            Value::Array(v.into_iter().map(|x| x.2).collect())
        })
        .collect();
    Ok(json!({ "nodes": nodes, "selected": selected }))
}

/// The rows of a crafted magic or rare item: for each prefix and suffix slot, the modifier chosen and the groups of tiers it
/// can take (`UpdateAffixControl`). A group is a run of modifiers with the same stat order, lowest level first.
pub(super) fn affixes(item: &Item, text: &str, ty: &str, tags: &HashSet<String>, inf: &HashMap<String, String>, table: &J, mods: &J, cluster_tag: Option<&str>) -> Result<Value, String> {
    let include: Vec<&str> = cluster_tag.into_iter().collect();
    let lines = all_lines_lower(item);
    let (pre_lim, suf_lim) = affix_limits(item, ty, &lines);
    let spec = affix_spec(text);
    let o = table.as_object().ok_or("no affix table")?;
    // The id a spec entry stands for: the id itself, else the modifier whose affix name it is.
    let resolve_id = |name: &str| -> Option<String> {
        if name == "None" {
            return None;
        }
        if table.get(name).is_some() {
            return Some(name.to_string());
        }
        o.iter().find(|(_, m)| jstr(&resolve(mods, *m), "affix").as_deref() == Some(name)).map(|(k, _)| k.to_string())
    };
    let pick = |is_prefix: bool, n: usize| -> (Option<String>, Option<f64>, bool) { spec.iter().filter(|e| e.0 == is_prefix).nth(n).map(|e| (resolve_id(&e.1), e.2, e.3)).unwrap_or((None, None, false)) };
    let mut state: Vec<(bool, usize, Option<String>, Option<f64>, bool)> = Vec::new();
    for i in 0..pre_lim {
        let (id, r, f) = pick(true, i);
        state.push((true, i, id, r, f));
    }
    for i in 0..suf_lim {
        let (id, r, f) = pick(false, i);
        state.push((false, i, id, r, f));
    }
    let delve = |m: &J| matches!(jstr(m, "affix").as_deref(), Some("Subterranean") | Some("of the Underground"));
    let mut rows: Vec<Value> = Vec::new();
    for (is_prefix, idx, sel, range, fractured) in &state {
        let want = if *is_prefix { "Prefix" } else { "Suffix" };
        let mut excluded: HashSet<String> = HashSet::new();
        for (p2, i2, id2, _, _) in &state {
            if (p2, i2) != (is_prefix, idx) {
                if let Some(g) = id2.as_ref().and_then(|id| table.get(id.as_str())).map(|m| resolve(mods, m)).and_then(|m| jstr(&m, "group")) {
                    excluded.insert(g);
                }
            }
        }
        let mut list: Vec<(Vec<f64>, usize, f64, String, J)> = Vec::new();
        for (id, m) in o.iter() {
            let m = resolve(mods, m);
            if jstr(&m, "type").as_deref() != Some(want) || delve(&m) {
                continue;
            }
            if jstr(&m, "group").is_some_and(|g| excluded.contains(&g)) {
                continue;
            }
            let ok = weight_ex(&m, tags, &include, &[], inf) > 0.0;
            if ok || sel.as_deref() == Some(id) {
                let so: Vec<f64> = m.get("statOrder").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
                list.push((so, mod_lines(&m).len(), m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0), id.to_string(), m));
            }
        }
        list.sort_by(|a, b| {
            for i in 0..a.1.max(b.1) {
                if i >= a.1 {
                    return std::cmp::Ordering::Less;
                }
                if i >= b.1 {
                    return std::cmp::Ordering::Greater;
                }
                let (x, y) = (a.0.get(i).copied().unwrap_or(0.0), b.0.get(i).copied().unwrap_or(0.0));
                if x != y {
                    return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
                }
            }
            a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal).then(a.3.cmp(&b.3))
        });
        let mut groups: Vec<Value> = Vec::new();
        let mut last_order: Option<Vec<f64>> = None;
        for (so, _, level, id, m) in &list {
            let ml = mod_lines(m);
            let entry = json!({ "id": id, "lines": ml, "level": level });
            if last_order.as_ref() != Some(so) {
                let label = ml.join("/");
                let have_range = has_bare_range(&label);
                groups.push(json!({ "label": label, "haveRange": have_range, "mods": [entry] }));
                last_order = Some(so.clone());
            } else if let Some(g) = groups.last_mut() {
                if let Some(a) = g["mods"].as_array_mut() {
                    a.push(entry);
                }
                let n = g["mods"].as_array().map(|a| a.len()).unwrap_or(0);
                if n == 2 {
                    let label = series_label(g["label"].as_str().unwrap_or(""));
                    g["label"] = json!(label);
                    g["haveRange"] = json!(true);
                }
            }
        }
        rows.push(json!({ "type": want, "index": idx, "selected": sel, "range": range, "fractured": fractured, "groups": groups }));
    }
    Ok(json!({ "prefixLimit": pre_lim, "suffixLimit": suf_lim, "rows": rows }))
}

/// Writes the item's chosen affixes (`ItemClass:Craft`): the `Prefix:` and `Suffix:` lines, the modifier lines they stand for,
/// the magic item's name and the level requirement. `choice` is `{"prefix": [{"id", "range"}...], "suffix": [...]}`.
/// Crafted and custom modifier lines stay; every other explicit line is replaced.
pub fn apply_affixes(game: &'static GameData, text: &str, choice: &Value) -> Result<String, String> {
    let item = pom_item::parse::parse_raw_with_id(text, true, None, game);
    let base_name = item.base_name.clone().ok_or("the item's base is not recognised")?;
    let base = game.item_bases.get(&base_name).ok_or("unknown base")?;
    let ty = base.base_type.clone().unwrap_or_default();
    let sub = base.extra.get("subType").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let mods = game.extra.get("itemMods")?.ok_or("no item mods")?;
    let table = [format!("{ty}{sub}"), ty.clone(), "Item".to_string()].into_iter().find(|t| mods.get(t.as_str()).is_some()).unwrap_or_else(|| "Item".into());
    let affixes = mods.get(table.as_str()).ok_or("no affix table")?;
    let mut lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let tag_chain = |l: &str| -> String {
        let mut s = l;
        let mut tags = String::new();
        while let Some(r) = s.strip_prefix('{') {
            match r.find('}') {
                Some(i) => {
                    tags.push_str(&r[..i]);
                    tags.push(',');
                    s = &r[i + 1..];
                }
                None => break,
            }
        }
        tags
    };
    lines.retain(|l| !l.starts_with("Prefix:") && !l.starts_with("Suffix:"));
    // The explicit block: after the implicit lines, before the trailing flags.
    let at = lines.iter().position(|l| l.starts_with("Implicits:"));
    let n_imp = at.and_then(|i| lines[i].trim_start_matches("Implicits:").trim().parse::<usize>().ok()).unwrap_or(0);
    let start = at.map(|i| i + 1 + n_imp).unwrap_or_else(|| spec_end(&lines)).min(lines.len());
    let mut end = lines.len();
    while end > start && (["Corrupted", "Mirrored", "Split", "Fractured Item", "Synthesised Item", "Unmodifiable", "Unidentified"].contains(&lines[end - 1].as_str()) || lines[end - 1].starts_with("Foil Unique")) {
        end -= 1;
    }
    let keep: Vec<String> = lines[start..end].iter().filter(|l| tag_chain(l).split(',').any(|x| x == "crafted" || x == "custom")).cloned().collect();
    lines.drain(start..end);

    let mut spec_lines: Vec<String> = Vec::new();
    let mut new_lines: Vec<(f64, usize, String)> = Vec::new();
    let mut name_prefix = String::new();
    let mut name_suffix = String::new();
    let mut level = base.req.as_ref().and_then(|r| r.get("level")).copied().unwrap_or(0.0);
    for (key, label) in [("prefix", "Prefix"), ("suffix", "Suffix")] {
        for c in choice.get(key).and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            let id = c.get("id").and_then(|i| i.as_str());
            let range = c.get("range").and_then(|r| r.as_f64()).unwrap_or(0.5);
            let fractured = c.get("fractured").and_then(|f| f.as_bool()).unwrap_or(false);
            let Some(id) = id else {
                spec_lines.push(format!("{label}: None"));
                continue;
            };
            let m = resolve(&mods, affixes.get(id).ok_or_else(|| format!("unknown modifier {id}"))?);
            spec_lines.push(format!("{label}: {}{{range:{}}}{id}", if fractured { "{fractured}" } else { "" }, fmt_range(range)));
            if key == "prefix" {
                name_prefix = format!("{} {}", jstr(&m, "affix").unwrap_or_default(), name_prefix);
            } else {
                name_suffix = format!("{} {}", name_suffix, jstr(&m, "affix").unwrap_or_default());
            }
            level = level.max((m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0) * 0.8).floor());
            let tags = str_list(m.get("modTags"));
            let so: Vec<f64> = m.get("statOrder").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            for (i, l) in mod_lines(&m).iter().enumerate() {
                let mut t = String::new();
                if !tags.is_empty() {
                    t.push_str(&format!("{{tags:{}}}", tags.join(",")));
                }
                t.push_str(if key == "prefix" { "{prefix}" } else { "{suffix}" });
                if fractured {
                    t.push_str("{fractured}");
                }
                if has_bare_range(l) {
                    t.push_str(&format!("{{range:{}}}", fmt_range(range)));
                }
                t.push_str(l);
                new_lines.push((so.get(i).copied().unwrap_or(0.0), new_lines.len(), t));
            }
        }
    }
    new_lines.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    let mut block: Vec<String> = new_lines.into_iter().map(|x| x.2).collect();
    block.extend(keep);
    for (k, b) in block.into_iter().enumerate() {
        lines.insert(start + k, b);
    }
    // The spec lines go after `Crafted: true`.
    let crafted_at = match lines.iter().position(|l| l == "Crafted: true") {
        Some(i) => i + 1,
        None => {
            let i = spec_end(&lines);
            lines.insert(i, "Crafted: true".to_string());
            i + 1
        }
    };
    for (k, sl) in spec_lines.into_iter().enumerate() {
        lines.insert(crafted_at + k, sl);
    }
    // A magic item is named by its affixes.
    if item.rarity == "MAGIC" {
        if let Some(ri) = lines.iter().position(|l| l.starts_with("Rarity:")) {
            if ri + 1 < lines.len() {
                let clean_base = match base_name.find(" (") {
                    Some(i) if base_name.ends_with(')') => base_name[..i].to_string(),
                    _ => base_name.clone(),
                };
                lines[ri + 1] = format!("{name_prefix}{clean_base}{name_suffix}").trim().to_string();
            }
        }
    }
    // The requirement is the highest of the base's and 80% of each modifier's level.
    if level > 0.0 {
        let l = format!("LevelReq: {}", level as i64);
        match lines.iter().position(|x| x.starts_with("LevelReq:")) {
            Some(i) => lines[i] = l,
            None => {
                let i = lines.iter().position(|x| x.starts_with("Implicits:")).unwrap_or_else(|| spec_end(&lines));
                lines.insert(i, l);
            }
        }
    }
    Ok(lines.join("\n"))
}


/// The implicit modifiers the Add Implicit dialog offers (`AddImplicitPopup`): Searing Exarch and Eater of Worlds implicits for
/// non-unique armour with that influence, and Vestigial implicits for the uniques that take them. Returns
/// `{"sources": [{"id", "label", "groups": [{"label", "mods": [{"id", "lines", "tags", "type", "level", "title"?}]}]}]}`.
pub(super) fn implicits(game: &'static GameData, item: &Item, ty: &str, tags: &HashSet<String>, inf: &HashMap<String, String>, mods: &J, table: &J) -> Result<Value, String> {
    let mut sources: Vec<Value> = Vec::new();
    let title_lower = item.title.as_deref().map(|t| t.to_lowercase());
    // Vestigial: only on uniques of an armour type that also come from the core drop pool.
    if item.rarity == "UNIQUE" {
        let types_ok = game.extra.get("vestigialUniqueBaseTypes").ok().flatten().is_some_and(|t| t.get(ty).is_some());
        if let (true, Some(maps), Some(vest)) = (types_ok, game.extra.get("vestigialModMappings").ok().flatten(), mods.get("Vestigial")) {
            // Each unique's title with its base and whether it has a source line (not part of the core drop pool).
            let mut uniques: HashMap<String, (String, bool)> = HashMap::new();
            if let Some(groups) = game.extra.get("uniques").ok().flatten().and_then(|u| u.as_object()) {
                for (group, arr) in groups.iter() {
                    if group == "generated" || group == "race" || group == "new" {
                        continue;
                    }
                    if let Some(a) = arr.as_array() {
                        for t in a.iter().filter_map(|x| x.as_str()) {
                            let mut l = t.lines();
                            let (Some(name), Some(base)) = (l.next(), l.next()) else { continue };
                            let source = t.lines().any(|x| x.starts_with("Source:"));
                            uniques.insert(name.to_lowercase(), (base.to_string(), source));
                        }
                    }
                }
            }
            let own = title_lower.as_deref().and_then(|t| uniques.get(t)).cloned();
            let own_ok = own.as_ref().is_some_and(|(_, source)| !source) || title_lower.as_deref() == Some("stasis prison");
            if own_ok {
                let mut list: Vec<(String, String, Value)> = Vec::new();
                if let Some(o) = maps.as_object() {
                    for (id, title) in o.iter() {
                        let Some(title) = title.as_str() else { continue };
                        let tl = title.to_lowercase();
                        let Some((base, _)) = uniques.get(&tl) else { continue };
                        if game.item_bases.get(base).and_then(|b| b.base_type.clone()).as_deref() != Some(ty) || title_lower.as_deref() == Some(tl.as_str()) {
                            continue;
                        }
                        let Some(m) = vest.get(id).map(|e| resolve(mods, e)) else { continue };
                        let group = jstr(&m, "group").unwrap_or_default();
                        let mut e = entry_json(id, &m, "implicit", "VESTIGIAL");
                        e["title"] = json!(title);
                        list.push((group, id.to_string(), json!({ "label": mod_lines(&m).join("/"), "mods": [e] })));
                    }
                }
                list.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
                let groups: Vec<Value> = list.into_iter().map(|x| x.2).collect();
                if !groups.is_empty() {
                    sources.push(json!({ "id": "VESTIGIAL", "label": "Vestigial", "groups": groups }));
                }
            }
        }
    }
    // Eldritch implicits: armour that is not unique and carries that influence.
    if item.rarity != "UNIQUE" && item.rarity != "RELIC" && ["Helmet", "Body Armour", "Gloves", "Boots"].contains(&ty) {
        for (key, label, ty_name) in [("cleansing", "Searing Exarch", "Exarch"), ("tangle", "Eater of Worlds", "Eater")] {
            if !item.influence.get(key).copied().unwrap_or(false) {
                continue;
            }
            let mut found: Vec<(Vec<f64>, usize, f64, String, J)> = Vec::new();
            if let Some(o) = table.as_object() {
                for (id, e) in o.iter() {
                    let m = resolve(mods, e);
                    if jstr(&m, "type").as_deref() != Some(ty_name) || weight_ex(&m, tags, &[], &[], inf) <= 0.0 {
                        continue;
                    }
                    let so: Vec<f64> = m.get("statOrder").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
                    found.push((so, mod_lines(&m).len(), m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0), id.to_string(), m));
                }
            }
            // Group by the modifier group without its presence suffix; groups by stat order, tiers by presence then stat order.
            let strip = |g: &str| g.replace("PinnaclePresence", "").replace("UniquePresence", "");
            let rank = |g: &str| if g.contains("PinnaclePresence") { 2 } else if g.contains("UniquePresence") { 1 } else { 0 };
            let mut order: Vec<String> = Vec::new();
            let mut by_group: HashMap<String, Vec<usize>> = HashMap::new();
            found.sort_by(|a, b| a.3.cmp(&b.3));
            for (i, f) in found.iter().enumerate() {
                let g = strip(&jstr(&f.4, "group").unwrap_or_default());
                if !by_group.contains_key(&g) {
                    order.push(g.clone());
                }
                by_group.entry(g).or_default().push(i);
            }
            let first_of = |g: &String| &found[by_group[g][0]];
            order.sort_by(|a, b| {
                let (x, y) = (first_of(a), first_of(b));
                for i in 0..x.1.max(y.1) {
                    if i >= x.1 {
                        return std::cmp::Ordering::Less;
                    }
                    if i >= y.1 {
                        return std::cmp::Ordering::Greater;
                    }
                    let (p, q) = (x.0.get(i).copied().unwrap_or(0.0), y.0.get(i).copied().unwrap_or(0.0));
                    if p != q {
                        return p.partial_cmp(&q).unwrap_or(std::cmp::Ordering::Equal);
                    }
                }
                y.2.partial_cmp(&x.2).unwrap_or(std::cmp::Ordering::Equal)
            });
            let trailing = |id: &str| id.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect::<String>().parse::<i64>().unwrap_or(0);
            let mut groups: Vec<Value> = Vec::new();
            for g in &order {
                let mut idx = by_group[g].clone();
                idx.sort_by(|&a, &b| {
                    let (x, y) = (&found[a], &found[b]);
                    let (gx, gy) = (jstr(&x.4, "group").unwrap_or_default(), jstr(&y.4, "group").unwrap_or_default());
                    rank(&gx).cmp(&rank(&gy)).then(x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal)).then(trailing(&x.3).cmp(&trailing(&y.3)))
                });
                let entries: Vec<Value> = idx.iter().map(|&i| entry_json(&found[i].3, &found[i].4, "implicit", &ty_name.to_uppercase())).collect();
                let first_lines = mod_lines(&found[idx[0]].4).join("/");
                groups.push(json!({ "label": series_label(&first_lines), "mods": entries }));
            }
            if !groups.is_empty() {
                sources.push(json!({ "id": ty_name.to_uppercase(), "label": label, "groups": groups }));
            }
        }
    }
    Ok(json!({ "sources": sources }))
}

/// The skills a cluster jewel can be crafted with, and its added passive count range (`UpdateClusterJewelControls`):
/// `{"size", "minNodes", "maxNodes", "skills": [{"id", "name", "enchant": [...]}], "selected", "nodeCount"}`.
pub(super) fn cluster(game: &'static GameData, item: &Item, base_name: &str) -> Result<Value, String> {
    let cj = game.extra.get("clusterJewels")?.and_then(|c| c.get("jewels")).and_then(|j| j.get(base_name)).ok_or("this is not a cluster jewel")?;
    let mut skills: Vec<(String, Value)> = Vec::new();
    if let Some(o) = cj.get("skills").and_then(|s| s.as_object()) {
        for (id, sk) in o.iter() {
            if ["affliction_strength", "affliction_dexterity", "affliction_intelligence"].contains(&id) {
                continue;
            }
            let name = jstr(&sk, "name").unwrap_or_else(|| id.to_string());
            skills.push((name.clone(), json!({ "id": id, "name": name, "enchant": str_list(sk.get("enchant")) })));
        }
    }
    skills.sort_by(|a, b| a.0.cmp(&b.0));
    let min = cj.get("minNodes").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let max = cj.get("maxNodes").and_then(|v| v.as_f64()).unwrap_or(min);
    Ok(json!({
        "size": jstr(&cj, "size"), "minNodes": min, "maxNodes": max,
        "skills": skills.into_iter().map(|x| x.1).collect::<Vec<_>>(),
        "selected": item.jewel_data.cluster_jewel_skill, "nodeCount": item.jewel_data.cluster_jewel_node_count,
    }))
}
