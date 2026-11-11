//! Foulborn uniques: which explicit lines of a unique can be turned into their mutated form (or back), and the lines
//! that replace them (`ItemClass:ParseRaw`'s `mutatedLines` / `checkMod`, `ItemClass:MutateMod`). The renderer swaps the
//! item text with these, the way upstream's checkbox calls `MutateMod`.
use super::*;
use pom_item::parse::normalise_mod_line;

/// `ItemClass:CheckModLineVariant` on the parsed item.
fn matched(item: &Item, wanted: &[String]) -> Option<Vec<usize>> {
    let mut used = vec![false; item.explicit_mod_lines.len()];
    let mut out = Vec::with_capacity(wanted.len());
    for w in wanted {
        let want = normalise_mod_line(w);
        let found = item.explicit_mod_lines.iter().enumerate().find(|(i, ml)| !used[*i] && normalise_mod_line(&ml.line) == want && line_active(item, ml));
        let (i, _) = found?;
        used[i] = true;
        out.push(i);
    }
    Some(out)
}

fn tag_prefix(item: &Item, first: &ModLine, new_tags: &[String], mutated: bool) -> String {
    let mut p = String::new();
    if let Some(v) = first.variant_list.as_ref().filter(|v| !v.contains(&i64::MIN)) {
        p.push_str(&format!("{{variant:{}}}", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")));
    }
    if let Some(v) = &first.version_list {
        p.push_str(&format!("{{version:{}}}", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")));
    }
    if let Some(v) = &first.variant_group_list {
        p.push_str(&format!("{{group:{}}}", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")));
    }
    let _ = item;
    if !new_tags.is_empty() {
        p.push_str(&format!("{{tags:{}}}", new_tags.join(",")));
    }
    if mutated {
        p.push_str("{mutated}");
    }
    p
}

/// The mutable lines of the item: `[{rawLines, modId, newModId, mutated, replace}]`. `replace` is what the lines turn into
/// when the checkbox is clicked.
pub(super) fn pool(game: &'static GameData, item: &Item, mods: &pom_engine::cjson::J) -> Result<Value, String> {
    let title = item.title.as_deref().unwrap_or("");
    let key = title.strip_prefix("Foulborn ").or_else(|| title.strip_prefix("foulborn ")).unwrap_or(title);
    let might = key.to_lowercase().contains("might of the meek");
    let pairs = game.extra.get("foulbornMap")?.and_then(|m| m.get(key));
    let mut out: Vec<Value> = Vec::new();
    if let (Some(pairs), false) = (pairs.and_then(|p| p.as_object()), might) {
        for (orig, foul) in pairs.iter() {
            let Some(foul) = foul.as_str().map(|s| s.to_string()) else { continue };
            for (mod_id, new_id, is_mut) in [(orig.to_string(), foul.clone(), false), (foul.clone(), orig.to_string(), true)] {
                let Some(src) = mod_entry(mods, if is_mut { "Foulborn" } else { "ItemExclusive" }, &mod_id) else { continue };
                let Some(dst) = mod_entry(mods, if is_mut { "ItemExclusive" } else { "Foulborn" }, &new_id) else { continue };
                let lines = mod_lines(&src);
                if lines.is_empty() {
                    continue;
                }
                let idx = matched(item, &[lines.join(" ")]).or_else(|| matched(item, &lines));
                let Some(idx) = idx else { continue };
                let first = &item.explicit_mod_lines[idx[0]];
                let prefix = tag_prefix(item, first, &str_list(dst.get("modTags")), !is_mut);
                let replace: Vec<String> = mod_lines(&dst).iter().map(|l| format!("{prefix}{l}")).collect();
                let raw: Vec<usize> = idx.iter().filter_map(|i| (item.explicit_mod_lines[*i].raw_line != usize::MAX).then_some(item.explicit_mod_lines[*i].raw_line)).collect();
                if raw.len() != idx.len() {
                    continue;
                }
                out.push(json!({ "rawLines": raw, "modId": mod_id, "newModId": new_id, "mutated": is_mut, "replace": replace }));
            }
        }
    }
    Ok(json!({ "mutations": out }))
}
