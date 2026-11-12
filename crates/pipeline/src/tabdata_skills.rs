//! What the Skills tab reads from the engine: the gem catalog (every gem in the game data, for the gem picker) and the
//! build's skill sets, socket groups and gems (`SkillsState`, see packages/protocol/src/tabs.ts).
use crate::edit_skills::{skills_view, El};
use pom_engine::data::gems::GemData;
use pom_engine::data::GameData;
use pom_skills::data;
use pom_skills::xmlskills::{self, GemInstance};
use serde_json::{json, Map, Value};

fn colour_of(color: Option<i64>) -> &'static str {
    match color {
        Some(1) => "str",
        Some(2) => "dex",
        Some(3) => "int",
        _ => "w",
    }
}

fn is_exceptional(gem: &GemData, legacy_awakened: bool) -> bool {
    legacy_awakened || gem.tag_string.as_deref().is_some_and(|t| t.contains("Exceptional"))
}

/// Every gem upstream's gem list offers (`GemSelectControl:PopulateGemList`): `hideFromGemList` ones are left out.
pub fn gem_catalog() -> Value {
    let mut out = Vec::new();
    for (key, gem) in data::sorted_gems() {
        let Some(ge) = data::gem_primary_effect(gem) else { continue };
        if data::extra(ge, "hideFromGemList").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let secondary = data::gem_secondary_effect(gem);
        let legacy = data::extra(ge, "legacy").and_then(|v| v.as_bool()).unwrap_or(false);
        let plus = data::extra(ge, "plusVersionOf").is_some();
        let support = data::is_support(ge);
        let exceptional = is_exceptional(gem, legacy && plus);
        let mut tags: Vec<&str> = gem.tags.iter().filter(|(_, v)| **v).map(|(k, _)| k.as_str()).collect();
        tags.sort_unstable();
        let transfigured_of = ["AltX", "AltY", "AltZ"].iter().find_map(|s| key.strip_suffix(s)).and_then(|base| pom_calc::data::game_data().gems.get(base)).and_then(|b| b.name.clone());
        let mut o = Map::new();
        o.insert("id".into(), json!(key));
        o.insert("gameId".into(), json!(gem.game_id.clone().unwrap_or_else(|| key.to_string())));
        if let Some(v) = &gem.variant_id {
            o.insert("variantId".into(), json!(v));
        }
        o.insert("name".into(), json!(gem.name.clone().or_else(|| ge.name.clone()).unwrap_or_default()));
        o.insert("colour".into(), json!(colour_of(ge.color)));
        o.insert("support".into(), json!(support));
        o.insert("exceptional".into(), json!(exceptional));
        o.insert("legacy".into(), json!(legacy));
        o.insert("vaal".into(), json!(gem.vaal_gem));
        if let Some(t) = transfigured_of {
            o.insert("transfiguredOf".into(), json!(t));
        }
        o.insert("tags".into(), json!(tags));
        let natural = gem.natural_max_level.unwrap_or(ge.levels.len() as i64);
        o.insert("naturalMaxLevel".into(), json!(natural));
        o.insert("maxLevel".into(), json!(ge.levels.len()));
        o.insert("levelReq".into(), json!(ge.levels.iter().map(|l| l.level_requirement.unwrap_or(1.0)).collect::<Vec<_>>()));
        o.insert("reqStr".into(), json!(gem.req_str));
        o.insert("reqDex".into(), json!(gem.req_dex));
        o.insert("reqInt".into(), json!(gem.req_int));
        o.insert("plusVersion".into(), json!(plus));
        let imbued_ok = support && !gem.tag_string.as_deref().is_some_and(|t| t.contains("Exceptional")) && !(legacy && plus) && secondary.map_or(true, data::is_support);
        o.insert("imbuedOk".into(), json!(imbued_ok));
        o.insert("effectName".into(), json!(ge.name.clone().unwrap_or_default()));
        if let Some(s) = secondary.and_then(|s| s.name.clone()) {
            o.insert("secondaryEffectName".into(), json!(s));
        }
        out.push(Value::Object(o));
    }
    Value::Array(out)
}

/// The slots a group can be socketed in, as `SkillsTab`'s `groupSlotDropList` lists them.
const SLOTS: &[(&str, &str)] = &[
    ("Weapon 1", "Weapon 1"),
    ("Weapon 2", "Weapon 2"),
    ("Weapon 1 Swap", "Weapon 1 (Swap)"),
    ("Weapon 2 Swap", "Weapon 2 (Swap)"),
    ("Helmet", "Helmet"),
    ("Body Armour", "Body Armour"),
    ("Gloves", "Gloves"),
    ("Boots", "Boots"),
    ("Amulet", "Amulet"),
    ("Ring 1", "Ring 1"),
    ("Ring 2", "Ring 2"),
    ("Ring 3", "Ring 3"),
    ("Belt", "Belt"),
];

fn attr_bool(e: &El, k: &str, default: bool) -> bool {
    e.attr(k).map(|v| v == "true").unwrap_or(default)
}

fn effect_of(g: &GemInstance) -> Option<&'static pom_engine::data::gems::GrantedEffect> {
    g.granted_effect.or_else(|| g.gem_data.and_then(data::gem_primary_effect))
}

fn source_name(source: &str) -> String {
    let mut parts = source.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(_), Some(_), Some(name)) => name.to_string(),
        (Some(_), Some(name), None) => name.to_string(),
        _ => source.to_string(),
    }
}

/// An equipped item as the "Socketed in" menu and the sockets row show it.
struct SlotItem {
    id: i64,
    item: std::rc::Rc<pom_item::Item>,
}

/// `SkillsTab` state for the open build text.
pub fn skills_state(xml: &str, game: &'static GameData) -> Result<Value, String> {
    skills_state_with(xml, game, None)
}

/// `skills_state` with the calculation's env: effective gem levels and qualities (item and tree bonuses), the real
/// active skills of each group, why a gem does nothing, and the item-granted groups the calculation adds to the list.
pub fn skills_state_with(xml: &str, game: &'static GameData, env: Option<&crate::Env>) -> Result<Value, String> {
    let view = skills_view(xml)?;
    let sg = xmlskills::socket_groups_shared(xml)?;
    let meta = xmlskills::parse_build_meta(xml)?;
    let main_group = meta.main_socket_group;

    // Equipped items by slot name (the active item set, swap slots included).
    let mut slot_items: Vec<(String, SlotItem)> = Vec::new();
    let sec = crate::items_section(xml);
    if let Some((_, slots)) = &sec.set {
        for (name, item_id, _) in slots {
            let Some(name) = name else { continue };
            if *item_id <= 0 {
                continue;
            }
            let Some((id, raw, ov)) = sec.items.iter().find(|(i, _, _)| i == item_id) else { continue };
            let item = crate::parsed_item(raw, *id, ov, game);
            if item.base_name.as_ref().is_some_and(|n| game.item_bases.contains_key(n)) {
                slot_items.push((name.clone(), SlotItem { id: *id, item }));
            }
        }
    }
    let item_for = |slot: &str| slot_items.iter().find(|(n, _)| n == slot).map(|(_, i)| i);

    let o = &view.skills;
    // `SkillsTab:Load`: `SelByValue` keeps the list's first entry when the saved value is not one of its values.
    let pick = |v: Option<&str>, allowed: &[&str], absent: &'static str| -> String {
        match v {
            None => absent.to_string(),
            Some(v) if allowed.contains(&v) => v.to_string(),
            Some(_) => allowed[0].to_string(),
        }
    };
    let mode = if o.attr("matchGemLevelToCharacterLevel") == Some("true") {
        "characterLevel".to_string()
    } else {
        match o.attr("defaultGemLevel") {
            Some(v) if v.parse::<f64>().is_ok() => "normalMaximum".to_string(),
            v => pick(v, &["normalMaximum", "corruptedMaximum", "awakenedMaximum", "characterLevel", "levelOne"], "normalMaximum"),
        }
    };
    let sort_field = pick(o.attr("sortGemsByDPSField"), &["FullDPS", "CombinedDPS", "TotalDPS", "AverageDamage", "TotalDot", "BleedDPS", "IgniteDPS", "TotalPoisonDPS", "TotalEHP"], "CombinedDPS");
    let show_support = pick(o.attr("showSupportGemTypes"), &["ALL", "NORMAL", "EXCEPTIONAL"], "ALL");
    let options = json!({
        "defaultGemLevel": mode,
        "defaultGemQuality": o.attr("defaultGemQuality").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0).clamp(0.0, 23.0),
        "sortGemsByDPS": attr_bool(o, "sortGemsByDPS", true),
        "sortGemsByDPSField": sort_field,
        "showSupportGemTypes": show_support,
        "showLegacyGems": attr_bool(o, "showLegacyGems", false),
    });

    // matchesSocket: `SkillsTab:UpdateSocketGroups` (split links continue where the last group with the slot ended).
    let mut slot_counts: std::collections::HashMap<String, usize> = Default::default();
    let mut groups = Vec::new();
    for (gi, gel) in view.groups.iter().enumerate() {
        let raw_gems = gel.children();
        let loaded = sg.get(gi);
        let slot = gel.attr("slot").map(|s| s.to_string());
        let source = gel.attr("source").map(|s| s.to_string());
        let enabled = attr_bool(gel, "active", false) || attr_bool(gel, "enabled", false);
        let offset = slot.as_ref().map(|s| slot_counts.get(s).copied().unwrap_or(0)).unwrap_or(0);
        let mut gems = Vec::new();
        let mut actives = Vec::new();
        let mut names = Vec::new();
        for (i, raw) in raw_gems.iter().enumerate() {
            let inst = loaded.and_then(|g| g.gem_list.get(i));
            let ge = inst.and_then(effect_of);
            let gem = inst.and_then(|g| g.gem_data);
            let name_spec = gem.and_then(|g| g.name.clone()).or_else(|| ge.and_then(|g| g.name.clone())).unwrap_or_else(|| raw.attr("nameSpec").unwrap_or("").to_string());
            let known = ge.is_some();
            let support = ge.is_some_and(data::is_support);
            let secondary = gem.and_then(data::gem_secondary_effect);
            let level = inst.map(|g| g.level).unwrap_or_else(|| raw.attr("level").and_then(|v| v.parse().ok()).unwrap_or(1.0));
            let quality = inst.map(|g| g.quality).unwrap_or(0.0);
            let enabled_g = inst.map(|g| g.enabled).unwrap_or(true);
            let mut matches = false;
            if let (Some(s), Some(ge)) = (&slot, ge) {
                if let Some(it) = item_for(s) {
                    if it.item.socket_always_matches {
                        matches = true;
                    } else {
                        let c = ge.color.and_then(|c| ['R', 'G', 'B'].get((c - 1) as usize).copied());
                        matches = matches_at(&it.item, offset + i, c);
                    }
                }
            }
            let enable_global = inst.map(|g| g.enable_global).unwrap_or([true, false]);
            let primary_active = ge.is_some_and(|g| !data::is_support(g) && !data::is_unsupported(g)) && (!ge.is_some_and(data::has_global_effect) || enable_global[0]);
            let secondary_active = secondary.is_some_and(|g| !data::is_support(g) && !data::is_unsupported(g)) && enable_global[1];
            let natural = gem.and_then(|g| g.natural_max_level).unwrap_or(0);
            let max_level = ge.map(|g| g.levels.len()).unwrap_or(0);
            let mut o = Map::new();
            o.insert("index".into(), json!(i + 1));
            o.insert("nameSpec".into(), json!(name_spec));
            if let Some(g) = gem {
                o.insert("gemId".into(), json!(gem_key(g)));
            }
            if let Some(s) = ge.and_then(|g| g.id.clone()) {
                o.insert("skillId".into(), json!(s));
            } else if let Some(s) = raw.attr("skillId") {
                o.insert("skillId".into(), json!(s));
            }
            o.insert("known".into(), json!(known));
            if !known && !name_spec.trim().is_empty() {
                o.insert("errMsg".into(), json!(format!("Unrecognised gem name '{name_spec}'")));
            }
            o.insert("colour".into(), json!(colour_of(ge.and_then(|g| g.color))));
            o.insert("support".into(), json!(support));
            o.insert("level".into(), json!(level));
            o.insert("quality".into(), json!(quality));
            o.insert("enabled".into(), json!(enabled_g));
            o.insert("enableGlobal1".into(), json!(enable_global[0]));
            o.insert("enableGlobal2".into(), json!(enable_global[1]));
            o.insert("count".into(), json!(inst.map(|g| g.count).unwrap_or(1)));
            o.insert("matchesSocket".into(), json!(matches));
            // Item and tree level/quality bonuses (`GemProperty` mods) come from the calculation's mod lists, which a
            // saved build text alone does not give: only the socket-colour quality is added here.
            let (eff_level, eff_quality) = effective_of(env, gi, i, ge, level, quality + if matches { xmlskills_bonus() } else { 0.0 });
            o.insert("effectiveLevel".into(), json!(eff_level));
            o.insert("effectiveQuality".into(), json!(eff_quality));
            o.insert("naturalMaxLevel".into(), json!(natural));
            o.insert("maxLevel".into(), json!(max_level));
            o.insert("vaal".into(), json!(gem.is_some_and(|g| g.vaal_gem) && secondary.is_some()));
            o.insert("effectName".into(), json!(ge.and_then(|g| g.name.clone()).unwrap_or_else(|| name_spec.clone())));
            if let Some(s) = secondary.and_then(|s| s.name.clone()) {
                o.insert("secondaryEffectName".into(), json!(s));
            }
            o.insert("hasCount".into(), json!(primary_active || secondary_active));
            if !known {
                o.insert("inactiveReason".into(), json!("(Unsupported)"));
            } else if !enabled_g {
                o.insert("inactiveReason".into(), json!("(Disabled)"));
            } else if let (Some(env), Some(ge)) = (env, ge) {
                if enabled && support {
                    if let Some(r) = support_reason(env, gi, ge) {
                        o.insert("inactiveReason".into(), json!(r));
                    }
                }
            }
            if env.is_none() {
                if enabled_g && primary_active {
                    let n = ge.and_then(|g| g.name.clone()).unwrap_or_default();
                    names.push(n.clone());
                    actives.push(json!({"index": actives.len() + 1, "name": n, "gem": i + 1}));
                }
                if enabled_g && secondary_active {
                    let n = secondary.and_then(|g| g.name.clone()).unwrap_or_default();
                    actives.push(json!({"index": actives.len() + 1, "name": n, "gem": i + 1}));
                }
            }
            gems.push(Value::Object(o));
        }
        if let Some(s) = &slot {
            slot_counts.insert(s.clone(), offset + raw_gems.len());
        }
        if let Some(env) = env {
            // The calculation's own active skill list for this group (`displaySkillList`): the main-skill picker.
            for (k, sk) in env.active_skills.iter().filter(|s| s.group_xml_index == Some(gi)).enumerate() {
                names.push(sk.name.clone());
                actives.push(json!({"index": k + 1, "name": sk.name, "gem": sk.gem_index.map(|g| g + 1).unwrap_or(1)}));
            }
        }
        let label = gel.attr("label").unwrap_or("");
        let display = if !label.trim().is_empty() {
            label.to_string()
        } else if names.is_empty() {
            "<No active skills>".to_string()
        } else {
            names.join(", ")
        };
        let slot_inactive = !xmlskills::slot_enabled(&slot, meta.use_second_weapon_set);
        let mut g = Map::new();
        g.insert("index".into(), json!(gi + 1));
        g.insert("label".into(), json!(label));
        g.insert("displayLabel".into(), json!(display));
        if let Some(s) = &slot {
            g.insert("slot".into(), json!(s));
        }
        if let Some(s) = &source {
            g.insert("source".into(), json!(s));
            g.insert("sourceName".into(), json!(source_name(s)));
        }
        g.insert("enabled".into(), json!(enabled));
        g.insert("slotInactive".into(), json!(slot_inactive));
        g.insert("includeInFullDPS".into(), json!(attr_bool(gel, "includeInFullDPS", false)));
        if let Some(c) = gel.attr("groupCount").and_then(|v| v.parse::<i64>().ok()) {
            g.insert("groupCount".into(), json!(c));
        }
        g.insert("mainActiveSkill".into(), json!(gel.attr("mainActiveSkill").and_then(|v| v.parse::<i64>().ok()).unwrap_or(1)));
        if let Some(i) = gel.attr("imbuedSupport").filter(|_| slot.is_some()) {
            g.insert("imbuedSupport".into(), json!(i));
        }
        g.insert("gems".into(), Value::Array(gems));
        g.insert("activeSkills".into(), Value::Array(actives));
        groups.push(Value::Object(g));
    }

    // Item- and tree-granted groups the calculation adds to the list but the saved build does not have yet (upstream
    // appends them to `socketGroupList` and saves them). Editing one writes it into the build text first.
    if let Some(env) = env {
        let mut seen: Vec<usize> = Vec::new();
        for sk in env.active_skills.iter().filter(|s| s.group_xml_index.is_none() && s.group_source.is_some() && s.has_src_instance) {
            let key = sk.group_index.unwrap_or(0);
            if sk.granted_effect_id.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key);
            let ge = data::granted_effect_by_skill_id(&sk.granted_effect_id);
            let source = sk.group_source.clone().unwrap_or_default();
            let mut gem = Map::new();
            gem.insert("index".into(), json!(1));
            gem.insert("nameSpec".into(), json!(sk.name));
            gem.insert("skillId".into(), json!(sk.granted_effect_id));
            gem.insert("known".into(), json!(true));
            gem.insert("colour".into(), json!(colour_of(ge.and_then(|g| g.color))));
            gem.insert("support".into(), json!(false));
            gem.insert("level".into(), json!(sk.level));
            gem.insert("quality".into(), json!(0));
            gem.insert("enabled".into(), json!(true));
            gem.insert("enableGlobal1".into(), json!(true));
            gem.insert("enableGlobal2".into(), json!(false));
            gem.insert("count".into(), json!(1));
            gem.insert("matchesSocket".into(), json!(false));
            gem.insert("effectiveLevel".into(), json!(sk.level));
            gem.insert("effectiveQuality".into(), json!(sk.quality));
            gem.insert("naturalMaxLevel".into(), json!(0));
            gem.insert("maxLevel".into(), json!(ge.map(|g| g.levels.len()).unwrap_or(0)));
            gem.insert("vaal".into(), json!(false));
            gem.insert("effectName".into(), json!(sk.name));
            gem.insert("hasCount".into(), json!(true));
            let mut g = Map::new();
            g.insert("index".into(), json!(groups.len() + 1));
            g.insert("label".into(), json!(""));
            g.insert("displayLabel".into(), json!(sk.name));
            if let Some(s) = &sk.group_slot {
                g.insert("slot".into(), json!(s));
            }
            g.insert("source".into(), json!(source));
            g.insert("sourceName".into(), json!(source_name(&source)));
            g.insert("synthetic".into(), json!(true));
            g.insert("enabled".into(), json!(true));
            g.insert("slotInactive".into(), json!(false));
            g.insert("includeInFullDPS".into(), json!(false));
            g.insert("mainActiveSkill".into(), json!(1));
            g.insert("gems".into(), json!([Value::Object(gem)]));
            g.insert("activeSkills".into(), json!([{"index": 1, "name": sk.name, "gem": 1}]));
            groups.push(Value::Object(g));
        }
    }

    // The skills items in the inactive weapon set grant: groups upstream also saves, listed here and never calculated.
    if let Some(env) = env {
        for (slot, source, skill_id, level) in &env.inactive_item_grants {
            let Some(ge) = data::granted_effect_by_skill_id(skill_id) else { continue };
            if groups.iter().any(|g| g.get("source").and_then(|v| v.as_str()) == Some(source.as_str()) && g.get("slot").and_then(|v| v.as_str()) == Some(slot.as_str())) {
                continue;
            }
            let name = ge.name.clone();
            let gem = json!({"index": 1, "nameSpec": name, "skillId": skill_id, "known": true, "colour": colour_of(ge.color), "support": false, "level": level, "quality": 0, "enabled": true, "enableGlobal1": true, "enableGlobal2": false, "count": 1, "matchesSocket": false, "effectiveLevel": level, "effectiveQuality": 0, "naturalMaxLevel": 0, "maxLevel": ge.levels.len(), "vaal": false, "effectName": name, "hasCount": true});
            groups.push(json!({"index": groups.len() + 1, "label": "", "displayLabel": name, "slot": slot, "source": source, "sourceName": source_name(source), "synthetic": true, "enabled": true, "slotInactive": true, "includeInFullDPS": false, "mainActiveSkill": 1, "gems": [gem], "activeSkills": [{"index": 1, "name": name, "gem": 1}]}));
        }
    }

    let slots: Vec<Value> = SLOTS
        .iter()
        .map(|(slot, label)| {
            let mut o = Map::new();
            o.insert("slot".into(), json!(slot));
            o.insert("label".into(), json!(label));
            if let Some(it) = item_for(slot) {
                let base = it.item.base_name.clone().unwrap_or_default();
                let limit = game.item_bases.get(&base).and_then(|b| b.socket_limit);
                let mut item = Map::new();
                item.insert("id".into(), json!(it.id));
                item.insert("name".into(), json!(it.item.name));
                item.insert("rarity".into(), json!(it.item.rarity));
                item.insert("base".into(), json!(base));
                item.insert("sockets".into(), json!(it.item.sockets.iter().map(|s| s.color.to_string()).collect::<Vec<_>>()));
                item.insert("linkGroups".into(), json!(it.item.sockets.iter().map(|s| s.group).collect::<Vec<_>>()));
                if let Some(l) = limit {
                    item.insert("socketLimit".into(), json!(l));
                }
                item.insert("canHaveSockets".into(), json!(limit.is_some()));
                o.insert("item".into(), Value::Object(item));
            }
            Value::Object(o)
        })
        .collect();

    let sets: Vec<Value> = view.sets.iter().map(|(id, title, n)| json!({"id": id, "title": title.clone().unwrap_or_else(|| "Default".to_string()), "groups": n})).collect();
    Ok(json!({
        "sets": sets,
        "activeSet": view.active_id,
        "mainGroup": main_group,
        "options": options,
        "groups": groups,
        "slots": slots,
    }))
}

/// The stat the gem picker sorts by, read from a finished calculation the way `GemSelectControl:DPSBuilder` does:
/// the field itself for FullDPS, else a minion's CombinedDPS when the main skill has a minion, else the field.
fn sort_stat(env: &crate::Env, field: &str) -> f64 {
    if field == "FullDPS" {
        if let Some(v) = crate::stat_value(env, field) {
            return v;
        }
    }
    if let Some((_, _, m)) = &env.minion_info {
        if let Some(v) = m.get("CombinedDPS") {
            return *v;
        }
    }
    crate::stat_value(env, field).unwrap_or(0.0)
}

/// The percent change of `field` when each of `gem_ids` is added to socket group `group` (1-based), or put in place of
/// gem `replace` (1-based), as the gem picker's sort cache (`GemSelectControl:UpdateSortCache`/`DPSBuilder`) computes it.
/// Only the gems upstream evaluates get a number: supports that apply to one of the group's active skills (decided by
/// the calculation of the edited build) and active gems with a global effect; the rest are `None`. Also returns the
/// base value of the stat. A group the build text does not hold, or one granted by an item, gets `None` for every gem.
pub fn gem_power(session: &mut crate::session::Session, group: usize, field: &str, gem_ids: &[String], replace: Option<usize>) -> Result<(Vec<(String, Option<f64>)>, f64), String> {
    let xml = session.xml().to_string();
    let full = field == "FullDPS";
    // The base is the same for every chunk of gems the picker asks about: calculated once per build text and stat.
    let rev = crate::data_rev();
    let base = match &session.gem_base {
        Some((x, r, f, fu, b)) if *x == xml && *r == rev && f == field && *fu == full => *b,
        _ => {
            let b = session.eval_xml(&xml, full, |env| sort_stat(env, field))?;
            session.gem_base = Some((xml.clone(), rev, field.to_string(), full, b));
            b
        }
    };
    let gi = group.wrapping_sub(1);
    let mut out = Vec::with_capacity(gem_ids.len());
    for id in gem_ids {
        let Some((_, gem)) = data::sorted_gems().iter().find(|(k, _)| *k == id.as_str()) else {
            out.push((id.clone(), None));
            continue;
        };
        let Some(ge) = data::gem_primary_effect(gem) else {
            out.push((id.clone(), None));
            continue;
        };
        let support = data::is_support(ge);
        if !support && !data::has_global_effect(ge) {
            out.push((id.clone(), None));
            continue;
        }
        let edit = match replace {
            Some(n) => json!({"kind": "setGemSkill", "group": group, "gem": n, "gemId": id}),
            None => json!({"kind": "addGem", "group": group, "gem": {"gemId": id}}),
        };
        let edited = match crate::edit_skills::skills_edit(&xml, &edit) {
            Ok(Some(x)) => x,
            _ => {
                out.push((id.clone(), None));
                continue;
            }
        };
        let ge_id = ge.id.clone();
        let (value, applies) = session.eval_xml(&edited, full, |env| {
            let applies = !support
                || env.active_skills.iter().filter(|s| s.group_xml_index == Some(gi)).any(|s| s.effect_list.iter().any(|&i| s.support_list.get(i).is_some_and(|(sge, _, _)| sge.id == ge_id)));
            (sort_stat(env, field), applies)
        })?;
        let pct = if !applies {
            None
        } else if base != 0.0 {
            Some((value - base) / base.abs() * 100.0)
        } else if value == 0.0 {
            Some(0.0)
        } else {
            None
        };
        out.push((id.clone(), pct));
    }
    Ok((out, base))
}

/// For an edit on a group the build text does not have yet (a granted group `skills_state_with` listed after the saved
/// ones): the build text with every such group saved first, as upstream saves them. Other edits pass unchanged.
pub fn with_synthetic_groups(session: &mut crate::session::Session, xml: &str, edit: &Value) -> Result<String, String> {
    let kind = edit.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if !matches!(kind, "setGroup" | "setGem" | "setMainGroup" | "setMainActiveSkill") {
        return Ok(xml.to_string());
    }
    let Some(group) = edit.get("group").and_then(|v| v.as_u64()) else { return Ok(xml.to_string()) };
    let saved = skills_view(xml)?.groups.len() as u64;
    if group <= saved {
        return Ok(xml.to_string());
    }
    let list = session
        .inspect(|env| {
            let mut seen: Vec<usize> = Vec::new();
            let mut out = Vec::new();
            for sk in env.active_skills.iter().filter(|s| s.group_xml_index.is_none() && s.group_source.is_some() && s.has_src_instance) {
                let key = sk.group_index.unwrap_or(0);
                if sk.granted_effect_id.is_empty() || seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                out.push(json!({"source": sk.group_source, "slot": sk.group_slot, "skillId": sk.granted_effect_id, "name": sk.name, "level": sk.level}));
            }
            out
        })?;
    if list.is_empty() {
        return Ok(xml.to_string());
    }
    Ok(crate::edit_skills::skills_edit(xml, &json!({"kind": "addSourceGroups", "groups": list}))?.unwrap_or_else(|| xml.to_string()))
}

/// A gem's level and quality as the calculation uses them (`AddSocketGroupTooltip`'s `srcInstance` vs effect values):
/// the active effect's own level and quality, or the support's entry in the group's support list (item and tree
/// bonuses and the socket-colour quality included). Falls back to the saved values with only the socket match.
fn effective_of(env: Option<&crate::Env>, gi: usize, gem_idx: usize, ge: Option<&'static pom_engine::data::gems::GrantedEffect>, level: f64, quality: f64) -> (f64, f64) {
    let (Some(env), Some(ge)) = (env, ge) else { return (level, quality) };
    let group_skills = || env.active_skills.iter().filter(move |s| s.group_xml_index == Some(gi));
    if let Some(sk) = group_skills().find(|s| s.gem_index == Some(gem_idx) && s.granted_effect_id == ge.id.clone().unwrap_or_default()) {
        return (sk.level, sk.gem_effective.1 + sk.skill_data.quality_bonus);
    }
    if let Some(id) = ge.id.as_deref() {
        for sk in group_skills() {
            if let Some((_, l, q)) = sk.support_list.iter().find(|(sge, _, _)| sge.id.as_deref() == Some(id)) {
                return (*l, *q);
            }
        }
        if let Some(sk) = group_skills().find(|s| s.gem_index == Some(gem_idx)) {
            return (sk.gem_effective.0, sk.gem_effective.1);
        }
    }
    (level, quality)
}

/// Why an enabled support in an enabled group does nothing (`AddSocketGroupTooltip`): replaced by a better copy of the
/// same support, or unable to support any of the group's active skills.
fn support_reason(env: &crate::Env, gi: usize, ge: &'static pom_engine::data::gems::GrantedEffect) -> Option<&'static str> {
    let skills: Vec<_> = env.active_skills.iter().filter(|s| s.group_xml_index == Some(gi)).collect();
    if skills.is_empty() {
        return None;
    }
    let id = ge.id.as_deref()?;
    let listed = skills.iter().any(|s| s.support_list.iter().any(|(sge, _, _)| sge.id.as_deref() == Some(id)));
    if !listed {
        return Some("(Superseded)");
    }
    let applies = skills.iter().any(|s| s.effect_list.iter().any(|&i| s.support_list.get(i).is_some_and(|(sge, _, _)| sge.id.as_deref() == Some(id))));
    if applies {
        None
    } else {
        Some("(Cannot apply to any of the active skills)")
    }
}

fn matches_at(item: &pom_item::Item, idx: usize, colour: Option<char>) -> bool {
    match (item.sockets.get(idx), colour) {
        (Some(s), Some(c)) => s.color == c,
        _ => false,
    }
}

/// `data.misc.MatchingSocketQualityBonus`.
fn xmlskills_bonus() -> f64 {
    pom_skills::assemble::MATCHING_SOCKET_QUALITY_BONUS
}

/// The `data.gems` key of a resolved gem (the id `addGem` takes).
fn gem_key(g: &'static GemData) -> String {
    data::sorted_gems().iter().find(|(_, x)| std::ptr::eq(*x, g)).map(|(k, _)| k.to_string()).or_else(|| g.game_id.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_complete() {
        let c = gem_catalog();
        let a = c.as_array().unwrap();
        assert!(a.len() > 700, "{}", a.len());
        let arc = a.iter().find(|g| g["name"] == "Arc").unwrap();
        assert_eq!(arc["colour"], "int");
        assert_eq!(arc["support"], false);
        assert!(a.iter().any(|g| g["transfiguredOf"] == "Arc"));
        assert!(a.iter().any(|g| g["exceptional"] == true && g["support"] == true));
        assert!(a.iter().any(|g| g["imbuedOk"] == true));
    }
}
