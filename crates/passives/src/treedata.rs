//! Loads `engine-data/tree_<version>.json` directly as JSON (not through pom-engine's typed
//! `data::tree::PassiveTree`, which does not resolve `$ref`).
//!
//! The data exporter's serializer dedups any Lua table it has already visited into a
//! `{"$ref": "<path>"}` pointing at the first path that reached it. Jewel sockets inline a full
//! copy of every node in their radius under `nodesInRadius`, and the top-level `nodes` map is
//! walked in lexicographic string-key order, so whenever a socket's id sorts before a nearby
//! node's own id, that node's canonical `tree.nodes.<id>` entry is replaced by a `$ref` into the
//! socket's `nodesInRadius` blob instead of holding real fields. Measured on tree_3_29.json: 2314
//! of 3352 "nodes" entries (69%) are bare `$ref` stubs. This module resolves every node once at
//! load time so the rest of the crate never sees a stub.

use crate::stats::process_stats;
use pom_engine::modparser::types::PMod;
use pom_engine::cjson::J;
use pom_engine::fxhash::HashMap;
use std::path::Path;

pub struct TreeData {
    /// The raw `tree` object (root of tree_<version>.json), kept for $ref resolution and for
    /// sections not worth a dedicated accessor (classes, masteryEffects, tattoo, sockets, ...).
    pub root: J,
    /// Every node id, resolved ($ref-followed) to its real object inside `root`. Excludes the "root" node
    /// (no numeric id) the same way PassiveSpec:Init excludes groupless nodes.
    pub nodes: HashMap<i64, J>,
    /// Each node's modList, computed once here (matching Classes/PassiveTree.lua `ProcessStats`
    /// running once at tree-load time, shared by every spec built from this tree) rather than
    /// per-`PassiveSpec` — re-running `modLib.parseMod` over every tree node on every build load
    /// was the dominant cost in the golden test (measured well over 1s/build on the full corpus).
    /// Shared with every spec node built from this tree, so a reset node keeps the same list (and the
    /// pipeline's per-list conversion cache keeps hitting).
    pub node_mods: HashMap<i64, std::sync::Arc<Vec<PMod>>>,
}

fn parse_segment(seg: &str) -> (Option<&str>, Vec<usize>) {
    // "nodesInRadius[1]" -> ("nodesInRadius", [1]); "18901" -> ("18901", []); "[3]" -> (None, [3])
    let mut idxs = Vec::new();
    let mut key_end = seg.len();
    if let Some(b) = seg.find('[') {
        key_end = b;
        let mut rest = &seg[b..];
        while let Some(stripped) = rest.strip_prefix('[') {
            if let Some(close) = stripped.find(']') {
                if let Ok(n) = stripped[..close].parse::<usize>() {
                    idxs.push(n);
                }
                rest = &stripped[close + 1..];
            } else {
                break;
            }
        }
    }
    let key = &seg[..key_end];
    (if key.is_empty() { None } else { Some(key) }, idxs)
}

/// Resolves a `$ref` path (as emitted by the data exporter, always rooted at "tree") against
/// `root` (which IS the "tree" object, so a leading "tree." prefix is stripped). Array indices in
/// the path are 1-based (Lua convention), converted to 0-based here.
pub fn resolve_path(root: J, path: &str) -> Option<J> {
    let rest = path.strip_prefix("tree.").or_else(|| path.strip_prefix("tree")).unwrap_or(path);
    let mut cur = root;
    if rest.is_empty() {
        return Some(cur);
    }
    for seg in rest.split('.') {
        let (key, idxs) = parse_segment(seg);
        if let Some(k) = key {
            cur = cur.get(k)?;
        }
        for i in idxs {
            // Lua 1-based -> 0-based
            cur = cur.get(i.saturating_sub(1))?;
        }
    }
    Some(cur)
}

/// Follows a value through `$ref` chains (bounded, to survive an unexpected cycle) until it lands
/// on a real (non-`$ref`) value.
pub fn deref(root: J, mut v: J) -> J {
    for _ in 0..16 {
        let Some(obj) = v.as_object() else { return v };
        let Some(path) = obj.get("$ref").and_then(|p| p.as_str()) else { return v };
        match resolve_path(root, path) {
            Some(next) => v = next,
            None => return v,
        }
    }
    v
}

impl TreeData {
    pub fn load(dir: &Path, tree_file: &str) -> Result<TreeData, String> {
        let path = dir.join(tree_file);
        // Kept for the rest of the process in the compact form (`pom_engine::cjson`); `nodes` points into it.
        let root = pom_engine::cjson::doc(&path)?;
        let mut nodes = HashMap::default();
        if let Some(obj) = root.get("nodes").and_then(|v| v.as_object()) {
            for (k, v) in obj.iter() {
                if k == "root" {
                    continue;
                }
                let Ok(id) = k.parse::<i64>() else { continue };
                nodes.insert(id, deref(root, v));
            }
        } else if let Some(arr) = root.get("nodes").and_then(|v| v.as_array()) {
            // tree_2_6 exports its node table as a list: every node carries its own id.
            for v in arr.iter() {
                let v = deref(root, v);
                if let Some(id) = v.get("id").and_then(as_i64) {
                    nodes.insert(id, v);
                }
            }
        }
        let mut node_mods: HashMap<i64, Vec<PMod>> = pom_engine::fxhash::map_with_capacity(nodes.len());
        for (&id, v) in &nodes {
            let sd = str_list(v.get("sd").unwrap_or(J::NULL));
            node_mods.insert(id, process_stats(&sd, id));
        }
        // Classes/PassiveTree.lua adds this directly via `modList:NewMod(...)` after the tree
        // loads (not from an `sd` line), to every Normal node connected to any class's start
        // node, allocated or not: `for classId, class in pairs(self.classes) do ... for _, nodeId
        // in ipairs(startNode.linkedId) do if node.type == "Normal" then
        // node.modList:NewMod("Condition:ConnectedTo"..class.name.."Start", "FLAG", true,
        // "Tree:"..nodeId) end end end`.
        if let Some(classes) = root.get("classes").and_then(|v| v.as_object()) {
            for class in classes.values() {
                let Some(class_name) = class.get("name").and_then(|v| v.as_str()) else { continue };
                let Some(start_id) = class.get("startNodeId").and_then(as_i64) else { continue };
                let Some(start_node) = nodes.get(&start_id) else { continue };
                let linked = i64_list(start_node.get("linkedId").unwrap_or(J::NULL));
                for linked_id in linked {
                    let is_normal = nodes.get(&linked_id).map(|n| n.get("type").and_then(|t| t.as_str()) == Some("Normal")).unwrap_or(false);
                    if !is_normal {
                        continue;
                    }
                    let mods = node_mods.entry(linked_id).or_default();
                    mods.push(PMod {
                        name: format!("Condition:ConnectedTo{class_name}Start"),
                        ty: "FLAG".to_string(),
                        value: pom_engine::modparser::types::PVal::Bool(true),
                        flags: 0,
                        keyword_flags: 0,
                        source: Some(format!("Tree:{linked_id}")),
                        tags: Vec::new(),
                        unreachable_tags: Vec::new(),
                    });
                }
            }
        }
        let node_mods = node_mods.into_iter().map(|(id, m)| (id, std::sync::Arc::new(m))).collect();
        Ok(TreeData { root, nodes, node_mods })
    }

    pub fn node(&self, id: i64) -> Option<J> {
        self.nodes.get(&id).copied()
    }
    /// A node's `g` field indexes `tree.groups`, whose own export shape differs by tree version:
    /// newer trees (confirmed on 3_21 and 3_29) export it as a JSON object keyed by the same
    /// number `g` holds, but older ones (confirmed on 2_6, 3_10, 3_14) export it as a plain JSON
    /// array, where `g` is a Lua 1-based index into that array (matching the same
    /// 1-based-to-0-based convention `resolve_path` already applies to a bracketed `$ref`
    /// segment like `"tree.groups[565].nodes"`, e.g. group 565 there is array index 564). Getting
    /// this wrong silently returns the wrong group's nodes (a real one, just the wrong one), so
    /// `find_cluster_socket` finds nothing and a cluster jewel's own sockets never get generated.
    pub fn group(&self, group_id: i64) -> Option<J> {
        let groups = self.root.get("groups")?;
        match groups.as_array() {
            Some(arr) => arr.get((group_id - 1) as usize),
            None => groups.get(group_id.to_string()),
        }
    }

    /// Resolves a value that may itself be a `$ref` (e.g. a node's embedded "group" field, or an
    /// alias-map entry like clusterNodeMap/sockets/keystoneMap that points into "nodes").
    pub fn deref(&self, v: J) -> J {
        deref(self.root, v)
    }

    pub fn section(&self, key: &str) -> Option<J> {
        self.root.get(key)
    }
}

// ---- small Value helpers used throughout the crate ----

pub fn as_i64(v: J) -> Option<i64> {
    if v.is_number() {
        return v.as_i64().or_else(|| v.as_f64().map(|f| f as i64));
    }
    v.as_str().and_then(|s| s.parse().ok())
}

pub fn as_str(v: J) -> Option<&'static str> {
    v.as_str()
}

pub fn as_bool(v: J) -> bool {
    v.as_bool().unwrap_or(false)
}

pub fn str_list(v: J) -> Vec<String> {
    if let Some(a) = v.as_array() {
        return a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
    }
    let Some(o) = v.as_object() else { return Vec::new() };
    let mut keys: Vec<usize> = o.keys().filter_map(|k| k.parse().ok()).collect();
    keys.sort();
    keys.into_iter().filter_map(|k| o.get(&k.to_string()).and_then(|x| x.as_str()).map(|s| s.to_string())).collect()
}

pub fn i64_list(v: J) -> Vec<i64> {
    if let Some(a) = v.as_array() {
        return a.iter().filter_map(as_i64).collect();
    }
    let Some(o) = v.as_object() else { return Vec::new() };
    let mut keys: Vec<usize> = o.keys().filter_map(|k| k.parse().ok()).collect();
    keys.sort();
    keys.into_iter().filter_map(|k| o.get(&k.to_string()).and_then(as_i64)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tree_2_6 exports its node table as a list; every node must still load by its id (the class start included).
    #[test]
    fn tree_2_6_nodes_load_by_id() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../engine-data");
        let tree = TreeData::load(&dir, "tree_2_6.json").unwrap();
        assert!(tree.node(50986).is_some(), "Duelist class start");
        assert!(tree.node(33795).is_some(), "Slayer ascendancy start");
        assert!(tree.nodes.len() > 1700);
    }
}
