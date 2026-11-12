//! What a click on a passive node does to the active spec, as upstream's tree view does it
//! (`PassiveTreeView:OnKeyUp` with `PassiveSpec:AllocNode` / `DeallocNode`): an allocated node is removed together
//! with every node that depends on it; an unallocated node is allocated along its path.

use crate::{cached_tree, cluster_jewel_data, cluster_jewel_input_from_item, items_section, parsed_item, timeless_jewel_data, GameData, HashMap};

/// The parts of the spec a click reads, for one build text.
pub struct TreePaths {
    /// Allocated node ids.
    pub alloc: pom_engine::fxhash::HashSet<i64>,
    /// Node id -> what a click on it needs.
    pub nodes: HashMap<i64, ClickNode>,
    /// The spec's class, ascendancies and mastery choices (for `with_node_list`).
    pub class_id: i64,
    pub ascend_class_id: i64,
    pub secondary_ascend_class_id: i64,
    pub mastery_selections: Vec<(i64, i64)>,
    /// Allocated nodes in the order the spec first allocated them.
    pub alloc_sequence: Vec<i64>,
    /// What the tree view draws that the static tree data doesn't have (see `tree_state`).
    pub state: serde_json::Value,
    /// Class and ascendancy tables, and the secondary (bloodline) ascendancies.
    pub classes: HashMap<i64, pom_passives::spec::ClassInfo>,
    pub alternate_ascendancies: HashMap<i64, pom_passives::spec::AscendInfo>,
}

pub struct ClickNode {
    /// The nodes allocating this one allocates (itself included), or empty when it can't be reached.
    pub path: Vec<i64>,
    /// The nodes deallocating this one deallocates (itself included).
    pub depends: Vec<i64>,
    pub kind: String,
    pub ascendancy: Option<String>,
    /// Intuitive Leap (or similar) reaches it: allocating it allocates only itself.
    pub leap: bool,
    /// A multiple-choice option, with its parent's other options.
    pub other_options: Vec<i64>,
    pub has_mastery_effects: bool,
    /// The effect ids a mastery offers.
    pub mastery_effects: Vec<i64>,
    /// Linked node ids (the ones that exist in the spec are the path graph).
    pub linked: Vec<i64>,
    /// The node has mods at all (upstream's `modKey ~= ""`), and what two nodes with the same effect share.
    pub has_mods: bool,
    pub mod_key: String,
    /// `node.pathDist`: the length of the path to the node (1000 when there is none).
    pub path_dist: i64,
}

/// What a click does.
#[derive(Debug, PartialEq)]
pub enum Click {
    /// The active spec's new node list.
    Nodes(Vec<i64>),
    /// An unallocated mastery: the player picks an effect first.
    PickMastery,
    /// A node of another ascendancy: the player confirms the class change first.
    OtherAscendancy,
    /// Nothing happens (no path, a class start, an unknown node).
    Nothing,
}

/// The spec of `xml_text` built with paths and dependents, the way setup builds it (same jewel inputs).
pub fn tree_paths(xml_text: &str, game: &'static GameData) -> Result<TreePaths, String> {
    let parsed = pom_passives::xmlspec::parse_active_spec(xml_text)?;
    let tree = cached_tree(parsed.tree_version.as_deref().unwrap_or("3_29"))?;
    let sec = items_section(xml_text);
    let mut jewel_inputs: HashMap<i64, pom_passives::clusterjewel::ClusterJewelInput> = HashMap::default();
    let mut jewel_info = serde_json::Map::new();
    let mut socketed: Vec<(i64, std::rc::Rc<pom_item::Item>)> = Vec::new();
    for (node_id, item_id) in &parsed.jewels {
        if let Some((id, raw, overrides)) = sec.items.iter().find(|(id, _, _)| id == item_id) {
            let item = parsed_item(raw, *id, overrides, game);
            socketed.push((*node_id, item.clone()));
            let mut info = serde_json::Map::new();
            info.insert("title".into(), serde_json::json!(item.title.clone().unwrap_or_else(|| item.name.clone())));
            info.insert("base".into(), serde_json::json!(item.base_name.clone().unwrap_or_default()));
            if let Some(r) = &item.jewel_radius_label {
                info.insert("radius".into(), serde_json::json!(r));
            }
            jewel_info.insert(node_id.to_string(), serde_json::Value::Object(info));
            if item.base_name.as_ref().is_some_and(|n| game.item_bases.contains_key(n)) {
                jewel_inputs.insert(*node_id, cluster_jewel_input_from_item(&item));
            }
        }
    }
    let seed = pom_passives::active_spec_jewel_seed(&parsed.jewels);
    let spec = pom_passives::spec_from_xml_full(tree, xml_text, Some(cluster_jewel_data()), &jewel_inputs, timeless_jewel_data(), Some(&seed))?;
    let alloc: pom_engine::fxhash::HashSet<i64> = spec.nodes.iter().filter(|(_, n)| n.alloc).map(|(&id, _)| id).collect();
    // The radius jewels as `env.radiusJewelList` holds them (granted nodes ignored): the allocated, socketed jewels in socket order.
    socketed.sort_by_key(|(s, _)| *s);
    let radius_sockets: Vec<(i64, &pom_item::Item)> = socketed.iter().filter(|(s, it)| spec.nodes.get(s).is_some_and(|n| n.alloc) && it.item_type.as_deref() == Some("Jewel")).map(|(s, it)| (*s, &**it)).collect();
    let (radius_jewels, _) = crate::radius::collect(&spec, &radius_sockets, game, &Default::default());
    let mut nodes: HashMap<i64, ClickNode> = HashMap::default();
    for (&id, n) in spec.nodes.iter() {
        // Intentionally differs from upstream (a bug there): its power cache keys on the mods alone, so nodes
        // a radius jewel covers (or tattoos) share the first node's score. Key = mods + type + tattoo + covering radius jewels.
        let mut mod_key = format!("{}|{}", n.kind, n.sd.join("
"));
        if n.is_tattoo {
            mod_key.push_str(&format!("|{}", n.override_type.as_deref().unwrap_or("")));
        }
        for (i, r) in radius_jewels.iter().enumerate() {
            if r.nodes.contains(&id) {
                mod_key.push_str(&format!("|{}", i + 1));
            }
        }
        let other_options = if n.is_multiple_choice_option {
            n.linked_ids.first().and_then(|p| spec.nodes.get(p)).map(|p| p.linked_ids.iter().copied().filter(|&o| o != id && spec.nodes.get(&o).is_some_and(|o| o.is_multiple_choice_option)).collect()).unwrap_or_default()
        } else {
            Vec::new()
        };
        nodes.insert(
            id,
            ClickNode {
                path: n.path.clone(),
                depends: n.depends.clone(),
                kind: n.kind.to_string(),
                ascendancy: n.ascendancy_name.as_ref().map(|a| a.to_string()),
                leap: !n.intuitive_leap_likes_affecting.is_empty(),
                other_options,
                has_mastery_effects: !n.mastery_effect_ids.is_empty(),
                mastery_effects: n.mastery_effect_ids.to_vec(),
                linked: n.linked_ids.to_vec(),
                has_mods: !n.mods.is_empty(),
                mod_key,
                path_dist: n.path_dist,
            },
        );
    }
    let mut mastery_selections: Vec<(i64, i64)> = spec.mastery_selections.iter().map(|(&n, &e)| (n, e)).collect();
    mastery_selections.sort_unstable();
    let mut alloc_sequence: Vec<i64> = Vec::new();
    for &id in &spec.alloc_log {
        if alloc.contains(&id) && !alloc_sequence.contains(&id) {
            alloc_sequence.push(id);
        }
    }
    for &id in &alloc {
        if !alloc_sequence.contains(&id) {
            alloc_sequence.push(id);
        }
    }
    let mut state = tree_state(&spec, &alloc_sequence, parsed.tree_version.as_deref().unwrap_or("3_29"));
    // Only sockets that still hold a jewel in the spec.
    jewel_info.retain(|k, _| k.parse::<i64>().ok().is_some_and(|n| spec.jewels.get(&n).is_some_and(|&i| i > 0)));
    state["jewelInfo"] = serde_json::Value::Object(jewel_info);
    Ok(TreePaths { classes: spec.classes.clone(), alternate_ascendancies: spec.alternate_ascendancies.clone(), alloc, nodes, alloc_sequence, state, class_id: spec.cur_class_id, ascend_class_id: spec.cur_ascend_class_id, secondary_ascend_class_id: spec.cur_secondary_ascend_class_id, mastery_selections })
}

/// The click on `node_id`, given the build's current node list `current` (kept in its order; new nodes go last).
pub fn click(paths: &TreePaths, current: &[i64], node_id: i64) -> Click {
    let Some(n) = paths.nodes.get(&node_id) else { return Click::Nothing };
    if n.kind == "ClassStart" || n.kind == "AscendClassStart" {
        return Click::Nothing;
    }
    if paths.alloc.contains(&node_id) {
        let mut drop: Vec<i64> = n.depends.clone();
        if !drop.contains(&node_id) {
            drop.push(node_id);
        }
        return Click::Nodes(current.iter().copied().filter(|id| !drop.contains(id)).collect());
    }
    if n.path.is_empty() {
        return Click::Nothing;
    }
    if let Some(asc) = &n.ascendancy {
        let ours = paths.alloc.iter().any(|id| paths.nodes.get(id).is_some_and(|m| m.ascendancy.as_deref() == Some(asc.as_str())));
        if !ours {
            return Click::OtherAscendancy;
        }
    }
    if n.kind == "Mastery" && n.has_mastery_effects {
        return Click::PickMastery;
    }
    Click::Nodes(alloc_nodes(n, current, node_id))
}

/// `current` with the node's path allocated (`AllocNode`): a node an Intuitive Leap reaches allocates only itself, and
/// a multiple-choice option drops its parent's other options.
pub fn alloc_nodes(n: &ClickNode, current: &[i64], node_id: i64) -> Vec<i64> {
    let add: Vec<i64> = if n.leap { vec![node_id] } else { n.path.clone() };
    let mut out: Vec<i64> = current.iter().copied().filter(|id| !n.other_options.contains(id)).collect();
    for id in add {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// `xml_text` with its active `<Spec>` given a node list when it has none (a build saved in the old format, with only
/// a tree URL): the decoded spec's class, ascendancies, mastery choices and allocated nodes, as the attributes the
/// original writes and reads ahead of the URL. Clicks and edits then work on the node list. Unchanged otherwise.
pub fn with_node_list(xml_text: &str, paths: &TreePaths) -> Result<String, String> {
    let tree_text = pom_passives::xmlspec::tree_element(xml_text).ok_or("missing <Tree>")?;
    let base = tree_text.as_ptr() as usize - xml_text.as_ptr() as usize;
    let doc = roxmltree::Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
    let tree = doc.root_element();
    let active = tree.attribute("activeSpec").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
    let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
    let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("missing <Spec>")?;
    if spec.attribute("nodes").is_some() {
        return Ok(xml_text.to_string());
    }
    // The start tag ends at the first '>' after its name (attribute values here can't contain '>').
    let start = base + spec.range().start;
    let close = start + xml_text[start..].find('>').ok_or("bad <Spec>")?;
    let insert_at = if xml_text[..close].ends_with('/') { close - 1 } else { close };
    // In the order the URL decode allocated them, so upstream's `allocNodes` fills in the same sequence.
    let nodes = &paths.alloc_sequence;
    let list: Vec<String> = nodes.iter().map(|n| n.to_string()).collect();
    let masteries: Vec<String> = paths.mastery_selections.iter().map(|(n, e)| format!("{{{n},{e}}}")).collect();
    let mut attrs = String::new();
    for (k, v) in [("classId", paths.class_id.to_string()), ("ascendClassId", paths.ascend_class_id.to_string()), ("secondaryAscendClassId", paths.secondary_ascend_class_id.to_string())] {
        if spec.attribute(k).is_none() {
            attrs.push_str(&format!(" {k}=\"{v}\""));
        }
    }
    if spec.attribute("masteryEffects").is_none() {
        attrs.push_str(&format!(" masteryEffects=\"{}\"", masteries.join(",")));
    }
    attrs.push_str(&format!(" nodes=\"{}\"", list.join(",")));
    Ok(format!("{}{}{}", &xml_text[..insert_at], attrs, &xml_text[insert_at..]))
}

/// The build's tree as the tree view draws it, beyond the static `tree_<version>.json`: the tree version, class and
/// ascendancies, allocated nodes, mastery choices, socketed jewels, every generated node (cluster-jewel subgraphs,
/// ids from 65536, placed on their proxy group's orbits like any node) and every node whose name or stats the build
/// changes (conquered by a timeless jewel, tattooed, overridden).
fn tree_state(spec: &pom_passives::spec::PassiveSpec, alloc_sequence: &[i64], version: &str) -> serde_json::Value {
    use serde_json::json;
    let mut generated = Vec::new();
    let mut changed = Vec::new();
    for (&id, n) in spec.nodes.iter() {
        let node = || {
            json!({
                "id": id, "kind": n.kind.to_string(), "name": n.dn.to_string(), "stats": n.sd.as_slice(),
                "group": n.group_id, "orbit": n.o, "orbitIndex": n.oidx, "linked": n.linked_ids.as_slice(),
                "ascendancy": n.ascendancy_name.as_ref().map(|a| a.to_string()), "socket": n.is_jewel_socket,
            })
        };
        if id >= 65536 || spec.generated_group.contains_key(&id) {
            let mut g = node();
            // The group of the proxy node of the socket this cluster hangs from, which is where the tree view places it.
            g["group"] = serde_json::json!(spec.generated_group.get(&id).copied().or(n.group_id));
            generated.push(g);
        } else if n.conquered_by.is_some() || n.is_tattoo || n.override_type.is_some() {
            let ov = spec.hash_overrides.get(&id);
            let text = |k: &str| ov.and_then(|o| o.get(k)).and_then(|v| v.as_str()).map(|v| v.to_string());
            let conquered_by = n.conquered_by.as_ref().map(|c| if c.conqueror_type.starts_with("abyss_") { "abyss" } else if c.conqueror_type.is_empty() { "other" } else { "timeless" });
            changed.push(json!({
                "id": id, "name": n.dn.to_string(), "stats": n.sd.as_slice(), "conquered": n.conquered_by.is_some(), "tattoo": n.is_tattoo,
                "isTattoo": n.is_tattoo, "icon": text("icon"), "activeEffectImage": text("activeEffectImage"), "conqueredBy": conquered_by,
            }));
        }
    }
    let mut masteries: Vec<(i64, i64)> = spec.mastery_selections.iter().map(|(&n, &e)| (n, e)).collect();
    masteries.sort_unstable();
    let mut jewels: Vec<(i64, i64)> = spec.jewels.iter().filter(|(_, &i)| i > 0).map(|(&n, &i)| (n, i)).collect();
    jewels.sort_unstable();
    // Allocated jewel sockets, which the Items tab lists as slots (`size` is the cluster socket's size, 0 to 2).
    let mut sockets: Vec<(i64, serde_json::Value)> = spec
        .nodes
        .iter()
        .filter(|(_, n)| n.is_jewel_socket && n.alloc)
        .map(|(&id, n)| (id, json!({ "id": id, "name": n.dn.to_string(), "size": n.expansion_jewel.as_ref().map(|e| e.size), "group": n.group_id })))
        .collect();
    sockets.sort_unstable_by_key(|s| s.0);
    let sockets: Vec<serde_json::Value> = sockets.into_iter().map(|s| s.1).collect();
    json!({
        "sockets": sockets,
        "treeVersion": version,
        "classId": spec.cur_class_id,
        "ascendClassId": spec.cur_ascend_class_id,
        "secondaryAscendClassId": spec.cur_secondary_ascend_class_id,
        "allocated": alloc_sequence,
        "masteries": masteries,
        "jewels": jewels,
        "generated": generated,
        "changed": changed,
    })
}
