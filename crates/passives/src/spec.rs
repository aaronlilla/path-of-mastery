//! Port of Classes/PassiveSpec.lua's calculation-relevant state and methods.
//!
//! Scope for this pass (see crate root docs for the full breakdown): tree copy/init, allocation
//! from a node-id list, `BuildAllDependsAndPaths` (paths/depends/points), mastery effect
//! selection, `EncodeURL`/`DecodeURL`, and node.modList building via `pom_engine::modparser`.
//! Timeless/abyss conquered-node replacement and cluster-jewel subgraphs are separate modules
//! (see `clusterjewel.rs`); tattoo hash-overrides are plumbed through `ReplaceNode` but the XML
//! `<Overrides>` parser is not wired up yet.

use crate::clusterjewel::{build_subgraph, ClusterJewelData, ClusterJewelInput};
use pom_engine::cjson::J;
use crate::ljhash::LjHash;
use crate::node::Node;
use crate::stats::process_stats;
use crate::timelessjewel::TimelessJewelData;
use crate::treedata::{as_bool, as_i64, i64_list, str_list, TreeData};
use pom_engine::modparser::types::{PMod, PVal};
use std::collections::VecDeque;
use pom_engine::fxhash::{HashMap, HashSet};

/// `data.timelessJewelAdditions` (`Modules/Data.lua`): the number of Legion addition entries
/// (`tree.legion.additions`), used to tell a Legion LUT's "add a small bonus" ids apart from its
/// "replace with this node" ids (an id >= this is a node id offset by this amount).
const TIMELESS_JEWEL_ADDITIONS: i64 = 337;

/// Port of `PassiveSpec.lua`'s local `timelessJewelTypeByConqueror` table (`BuildAllDependsAndPaths`).
pub fn timeless_jewel_type_by_conqueror(conqueror_type: &str) -> Option<i64> {
    match conqueror_type {
        "vaal" => Some(1),
        "karui" => Some(2),
        "maraketh" => Some(3),
        "templar" => Some(4),
        "eternal" => Some(5),
        "kalguur" => Some(6),
        "abyss_murderous" => Some(7),
        "abyss_searching" => Some(8),
        "abyss_hypnotic" => Some(9),
        "abyss_ghastly" => Some(10),
        "abyss_special" => Some(11),
        _ => None,
    }
}

/// `round(val, 1)` (`Modules/Common.lua`): floor(val * 10 + 0.5) / 10.
fn round1(val: f64) -> f64 {
    (val * 10.0 + 0.5).floor() / 10.0
}

/// Port of `BuildAllDependsAndPaths`'s local `replaceHelperFunc`: substitutes a rolled `value`
/// into a legion template's stat-description line, in place of the range (or, for a fixed-value
/// stat, the bare number) that the template's own `stats[statKey]` entry recorded. `stat_mod` is
/// that entry's raw JSON (`fmt`/`min`/`max`).
/// Lua's default number-to-string coercion (`%.14g`-like): whole numbers print with no decimal
/// point (matches a stat's `min`/`max`, which are exported as JSON numbers but can be fractional,
/// e.g. `0.2` for a permyriad-displayed leech stat, not just integers).
fn lua_num_str(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn replace_helper(stat_line: &str, stat_key: &str, stat_mod: J, mut value: f64) -> String {
    let fmt = stat_mod.get("fmt").and_then(|v| v.as_str()).unwrap_or("");
    if fmt == "g" {
        if stat_key.contains("per_minute") {
            value = round1(value / 60.0);
        } else if stat_key.contains("permyriad") {
            value /= 100.0;
        } else if stat_key.contains("_ms") {
            value /= 1000.0;
        }
    }
    let min = stat_mod.get("min").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let max = stat_mod.get("max").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let value_str = lua_num_str(value);
    if min != max {
        stat_line.replace(&format!("({}-{})", lua_num_str(min), lua_num_str(max)), &value_str)
    } else if min != value {
        stat_line.replace(&lua_num_str(min), &value_str)
    } else {
        stat_line.to_string()
    }
}

#[derive(Clone, Debug, Default)]
pub struct AscendInfo {
    pub name: String,
    pub internal_id: Option<String>,
    pub start_node_id: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct ClassInfo {
    pub name: String,
    pub start_node_id: i64,
    pub ascendancies: HashMap<i64, AscendInfo>,
}

thread_local! {
    /// Node ids the next spec builds keep allocated although nothing connects them (a node-power evaluation adds one
    /// node's mods to the build, as upstream's `addNodes` does, without its path).
    pub static PIN_ALLOC: std::cell::RefCell<Vec<i64>> = const { std::cell::RefCell::new(Vec::new()) };
    /// When set, `build_all_depends_and_paths` skips the path search for the tree view (see there).
    pub static SKIP_PATHS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Forces the full depends loop in a stats-only pass (the check in `spec_from_xml_full`).
    pub static FULL_DEPENDS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub struct PassiveSpec<'t> {
    pub tree: &'t TreeData,
    pub nodes: crate::node::NodeMap,
    pub classes: HashMap<i64, ClassInfo>,
    pub alternate_ascendancies: HashMap<i64, AscendInfo>,
    pub mastery_effect_sd: std::sync::Arc<HashMap<i64, Vec<String>>>,

    pub tree_version: String,
    pub cur_class_id: i64,
    pub cur_ascend_class_id: i64,
    pub cur_secondary_ascend_class_id: i64,
    pub mastery_selections: HashMap<i64, i64>,
    pub jewels: HashMap<i64, i64>,
    /// Key order of `self.jewels` as LuaJIT's `pairs(self.jewels)` would traverse it (the values
    /// live in `jewels`; this only tracks which keys are present and in what slot order).
    jewels_lj: LjHash,
    /// Tattoo `<Overrides>` (`self.hashOverrides`): node id -> the resolved `tree.tattoo.nodes[dn]`
    /// template (already substituted by sprite if the exact `dn` wasn't found, matching `Load`'s
    /// fallback; see `lib.rs`). Applied by `build_all_depends_and_paths` via `ReplaceNode`.
    pub hash_overrides: HashMap<i64, J>,
    /// Explicit stand-in for real equipped-item data (`pom-item` is still an empty stub): keyed
    /// by the node id the jewel is socketed into, same as `jewels`. The golden test harness
    /// populates this from the recorder's own dump of `item.jewelData`/`item.clusterJewel`.
    pub cluster_jewel_inputs: HashMap<i64, ClusterJewelInput>,
    /// Legion jewel lookup tables (see `timelessjewel.rs`), used by `build_all_depends_and_paths`
    /// for conquered-node replacement. `None` skips that step entirely (matches upstream when
    /// no build has a conquered node, and lets callers that don't care about timeless jewels avoid
    /// loading ~70MB of lookup tables).
    pub timeless_data: Option<&'t TimelessJewelData>,
    /// Ids of every node this spec generated via `BuildSubgraph`, so `BuildAllDependsAndPaths` can
    /// find them by id like any other tree node.
    generated_node_ids: HashSet<i64>,
    /// Generated node id -> the group of the proxy node of the socket its subgraph hangs from (what the tree view places it on).
    pub generated_group: HashMap<i64, i64>,
    /// Mirrors `self.allocSubgraphNodes`: hash-list ids that named a node `import_from_node_list`
    /// couldn't find yet because cluster-jewel subgraphs generate that id's node later, in
    /// `build_cluster_jewel_graphs`. Applied (allocated) once that node exists.
    pending_subgraph_alloc: Vec<i64>,
    /// A character import's cluster data (`spec.extended_hashes` / `spec.jewel_data`): generated nodes it names are allocated.
    pub import_clusters: Option<std::rc::Rc<crate::import_clusters::ImportClusters>>,
    /// `self.clusterHashFormatVersion < 2`: this build's `<Spec>` predates the current cluster
    /// node-id layout (`xmlspec.rs` defaults this to `true` whenever `clusterHashFormatVersion`
    /// is missing but a `nodes=` hash list is present, matching `Load`'s own default). Set once
    /// by `lib.rs` from the parsed XML; `build_subgraph` reads it to also resolve each socket's
    /// pre-migration ("legacy") id, and `apply_legacy_cluster_node_remap` moves the player's
    /// saved allocation from that legacy id onto the current one.
    pub needs_legacy_cluster_conversion: bool,
    /// `(legacy_id, current_id)` pairs collected from every subgraph rebuilt this pass (see
    /// `clusterjewel::SubGraph::legacy_node_map`), drained and applied once by
    /// `apply_legacy_cluster_node_remap` after every socket has its subgraph.
    legacy_cluster_node_map: Vec<(i64, i64)>,

    /// Mirrors `self.allocNodes`'s key set in LuaJIT's own hash-part slot order (see
    /// `ljhash.rs`), updated by `alloc_insert`/`alloc_remove` at every point that corresponds to a
    /// Lua `self.allocNodes[id] = node` / `= nil`. `pairs(self.allocNodes)` in upstream
    /// (`BuildAllDependsAndPaths`'s depends pass, the 0-1 BFS root list, `EncodeURL`) reads this
    /// instead of an arbitrary Rust `HashMap` order. Assumes one `import_from_node_list`/
    /// `decode_url` call per spec instance (true for this crate's callers): `self.allocNodes`
    /// starts genuinely empty in upstream too, so `reset_nodes`'s deletions of an
    /// already-empty table are no-ops there and are skipped here rather than tracked.
    alloc_order: LjHash,
    /// Every allocation in the order it happened (repeats included): a node list written in this order makes the
    /// original insert into `allocNodes` in the same sequence (see `pom_pipeline::treeclick::with_node_list`).
    pub alloc_log: Vec<i64>,
    /// Set while `import_from_node_list` selects the class: the passes the selects would run are left to the pass that
    /// follows the node list (see there).
    defer_depends: bool,
    /// A node was allocated or removed since the last `build_all_depends_and_paths` started (its pruning included).
    pub(crate) alloc_changed: bool,
    /// Set by `spec_from_xml_full`: leave the pass after the node list to `build_cluster_jewel_graphs`, which runs
    /// one anyway once subgraphs exist (see `import_from_node_list`).
    pub(crate) defer_node_list_depends: bool,
    /// The pass after the node list was left to `build_cluster_jewel_graphs`.
    pub(crate) node_list_depends_deferred: bool,
    /// The last dependency pass left jewel sockets' distances to `class_start_distance`.
    lazy_distance: bool,

    pub allocated_mastery_count: i32,
    pub allocated_notable_count: i32,
    pub allocated_keystone_count: i32,
}

impl<'t> PassiveSpec<'t> {
    /// Port of PassiveSpec.lua `Init`: copies the tree's nodes, excluding proxy/groupless nodes
    /// and expansion-jewel sockets that have a parent (nested cluster template positions, not
    /// real base-tree sockets), and computes each node's initial modList.
    pub fn new(tree: &'t TreeData) -> PassiveSpec<'t> {
        let mut pf = crate::PfT::new();
        // The pristine node map is the same for every spec built from one loaded tree: build it once, clone per spec.
        thread_local! {
            static TEMPLATE: std::cell::RefCell<HashMap<(usize, usize), crate::node::NodeMap>> = std::cell::RefCell::new(HashMap::default());
        }
        let tkey = (tree as *const TreeData as usize, tree.nodes.len());
        let cached = TEMPLATE.with(|c| c.borrow().get(&tkey).cloned());
        let nodes = match cached {
            Some(n) => n,
            None => {
                let n = Self::pristine_nodes(tree);
                TEMPLATE.with(|c| c.borrow_mut().insert(tkey, n.clone()));
                n
            }
        };
        pf.lap("new.nodes");
        // The class and alternate-ascendancy tables are per tree: read once, copied per spec.
        type Tables = (HashMap<i64, ClassInfo>, HashMap<i64, AscendInfo>);
        thread_local! {
            static TABLES: std::cell::RefCell<HashMap<usize, std::rc::Rc<Tables>>> = std::cell::RefCell::new(HashMap::default());
        }
        let tables = match TABLES.with(|c| c.borrow().get(&tkey.0).cloned()) {
            Some(t) => t,
            None => {
                let t = std::rc::Rc::new((Self::load_classes(tree), Self::load_alt_ascendancies(tree)));
                TABLES.with(|c| c.borrow_mut().insert(tkey.0, t.clone()));
                t
            }
        };
        let classes = tables.0.clone();
        pf.lap("new.classes");
        let alternate_ascendancies = tables.1.clone();
        pf.lap("new.alt");
        let mastery_effect_sd = Self::load_mastery_effects(tree);
        pf.lap("new.mastery");
        let tree_version = tree
            .section("treeVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        PassiveSpec {
            tree,
            nodes,
            classes,
            alternate_ascendancies,
            mastery_effect_sd,
            tree_version,
            cur_class_id: 0,
            cur_ascend_class_id: 0,
            cur_secondary_ascend_class_id: 0,
            mastery_selections: HashMap::default(),
            jewels: HashMap::default(),
            jewels_lj: LjHash::new(),
            hash_overrides: HashMap::default(),
            cluster_jewel_inputs: HashMap::default(),
            timeless_data: None,
            generated_node_ids: HashSet::default(),
            generated_group: HashMap::default(),
            pending_subgraph_alloc: Vec::new(),
            import_clusters: crate::import_clusters::current(),
            needs_legacy_cluster_conversion: false,
            legacy_cluster_node_map: Vec::new(),
            alloc_order: LjHash::new(),
            alloc_log: Vec::new(),
            defer_depends: false,
            alloc_changed: false,
            defer_node_list_depends: false,
            node_list_depends_deferred: false,
            lazy_distance: false,
            allocated_mastery_count: 0,
            allocated_notable_count: 0,
            allocated_keystone_count: 0,
        }
    }

    fn pristine_nodes(tree: &TreeData) -> crate::node::NodeMap {
    let mut nodes = crate::node::NodeHashMap::default();
    for (&id, v) in &tree.nodes {
        let has_group = v.get("g").and_then(as_i64).is_some();
        let is_proxy = as_bool(v.get("isProxy").unwrap_or(J::NULL));
        let group_is_proxy = v
            .get("g")
            .and_then(as_i64)
            .and_then(|g| tree.group(g))
            .map(|g| as_bool(g.get("isProxy").unwrap_or(J::NULL)))
            .unwrap_or(false);
        let expansion_parent = v.get("expansionJewel").and_then(|ej| ej.get("parent")).is_some();
        if !has_group || is_proxy || group_is_proxy || expansion_parent {
            continue;
        }
        let mut node = Node::from_tree(id, *v, tree);
        node.is_tattoo = as_bool(v.get("isTattoo").unwrap_or(J::NULL));
        // Precomputed once per tree load in treedata.rs (matches ProcessStats running once
        // when upstream Lua tree loads, shared by every spec built from it).
        node.mods = tree.node_mods.get(&id).cloned().unwrap_or_default();
        nodes.insert(id, std::rc::Rc::new(node));
    }

        crate::node::NodeMap::pristine(nodes)
    }

    fn load_classes(tree: &TreeData) -> HashMap<i64, ClassInfo> {
        let mut out = HashMap::default();
        let Some(classes) = tree.section("classes").and_then(|v| v.as_object()) else { return out };
        for (k, v) in classes {
            let Ok(class_id) = k.parse::<i64>() else { continue };
            let name = v.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let start_node_id = v.get("startNodeId").and_then(as_i64).unwrap_or(0);
            let mut ascendancies = HashMap::default();
            if let Some(asc_map) = v.get("classes").and_then(|v| v.as_object()) {
                for (ak, av) in asc_map {
                    let Ok(asc_id) = ak.parse::<i64>() else { continue };
                    ascendancies.insert(
                        asc_id,
                        AscendInfo {
                            name: av.get("name").and_then(|s| s.as_str()).unwrap_or("None").to_string(),
                            internal_id: av.get("id").and_then(|s| s.as_str()).map(|s| s.to_string()),
                            start_node_id: av.get("startNodeId").and_then(as_i64),
                        },
                    );
                }
            }
            out.insert(class_id, ClassInfo { name, start_node_id, ascendancies });
        }
        out
    }

    fn load_alt_ascendancies(tree: &TreeData) -> HashMap<i64, AscendInfo> {
        let mut out = HashMap::default();
        if let Some(aa) = tree.section("alternate_ascendancies").and_then(|v| v.as_object()) {
            for (k, v) in aa {
                let Ok(id) = k.parse::<i64>() else { continue };
                out.insert(
                    id,
                    AscendInfo {
                        name: v.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        internal_id: v.get("id").and_then(|s| s.as_str()).map(|s| s.to_string()),
                        start_node_id: v.get("startNodeId").and_then(as_i64),
                    },
                );
            }
        }
        out
    }

    /// The tree's mastery effect stat lines, read once per loaded tree.
    fn load_mastery_effects(tree: &TreeData) -> std::sync::Arc<HashMap<i64, Vec<String>>> {
        thread_local! {
            static CACHE: std::cell::RefCell<HashMap<usize, std::sync::Arc<HashMap<i64, Vec<String>>>>> = std::cell::RefCell::new(HashMap::default());
        }
        let key = tree as *const TreeData as usize;
        if let Some(m) = CACHE.with(|c| c.borrow().get(&key).cloned()) {
            return m;
        }
        let m = std::sync::Arc::new(Self::read_mastery_effects(tree));
        CACHE.with(|c| c.borrow_mut().insert(key, m.clone()));
        m
    }

    fn read_mastery_effects(tree: &TreeData) -> HashMap<i64, Vec<String>> {
        let mut out = HashMap::default();
        if let Some(me) = tree.section("masteryEffects").and_then(|v| v.as_object()) {
            for (k, v) in me {
                let Ok(id) = k.parse::<i64>() else { continue };
                let sd_val = v.get("sd").map(|s| tree.deref(s)).unwrap_or(J::NULL);
                out.insert(id, str_list(sd_val));
            }
        }
        out
    }

    // ---- allocation ----

    /// `pairs(env.allocNodes)` order: CalcSetup.lua:771 `env.allocNodes = copyTable(env.spec.allocNodes, true)` re-inserts
    /// the nodes into a fresh table in the spec table's `pairs` order, so the copy's hash layout (and traversal
    /// order) is that of a table built by those inserts.
    pub fn env_alloc_order(&self) -> Vec<i64> {
        let mut h = LjHash::new();
        for id in self.alloc_order.iterate() {
            h.set(id, true);
        }
        h.iterate()
    }

    /// Mirrors a Lua `node.alloc = true; self.allocNodes[id] = node`.
    fn alloc_insert(&mut self, id: i64) {
        self.alloc_changed = true;
        if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
            n.alloc = true;
        }
        self.alloc_order.set(id, true);
        self.alloc_log.push(id);
    }

    /// Mirrors a Lua `node.alloc = false; self.allocNodes[id] = nil`.
    fn alloc_remove(&mut self, id: i64) {
        self.alloc_changed = true;
        if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
            n.alloc = false;
        }
        self.alloc_order.set(id, false);
    }

    /// CalcSetup's `override.removeNodes`: the allocated nodes in `ids` stop counting as allocated for one calculation, and
    /// nothing else about the spec changes (conquered and replaced nodes, radius jewel effects and cluster nodes stay as
    /// they are, no path or dependency pass runs). The notable, keystone and mastery counts follow, as in upstream.
    pub fn remove_for_calc(&mut self, ids: &[i64]) {
        for &id in ids {
            let Some(n) = self.nodes.get(&id) else { continue };
            if !n.alloc {
                continue;
            }
            match n.kind.as_str() {
                "Mastery" => self.allocated_mastery_count -= 1,
                "Notable" => self.allocated_notable_count -= 1,
                "Keystone" => self.allocated_keystone_count -= 1,
                _ => {}
            }
            self.alloc_remove(id);
        }
    }

    pub fn reset_nodes(&mut self) {
        // Only a touched node can be allocated (see `NodeMap`).
        for i in 0..self.nodes.touched().len() {
            let id = self.nodes.touched()[i];
            let n = &self.nodes[&id];
            if n.alloc && n.kind != "ClassStart" && n.kind != "AscendClassStart" {
                crate::node::node_mut(&mut self.nodes, &id).unwrap().alloc = false;
            }
        }
        self.mastery_selections.clear();
    }

    fn reset_ascend_class(&mut self) {
        let id = self.classes.get(&self.cur_class_id).and_then(|class| {
            class
                .ascendancies
                .get(&self.cur_ascend_class_id)
                .or_else(|| class.ascendancies.get(&0))
                .and_then(|a| a.start_node_id)
        });
        if let Some(id) = id {
            self.alloc_remove(id);
        }
    }

    pub fn select_class(&mut self, class_id: i64) {
        let old_start = self.classes.get(&self.cur_class_id).map(|c| c.start_node_id);
        if let Some(old_start) = old_start {
            self.alloc_remove(old_start);
        }
        self.reset_ascend_class();
        self.cur_class_id = class_id;
        let start = self.classes.get(&class_id).map(|c| c.start_node_id);
        if let Some(start) = start {
            self.alloc_insert(start);
        }
        self.select_ascend_class(0);
    }

    pub fn select_ascend_class(&mut self, ascend_class_id: i64) {
        self.reset_ascend_class();
        self.cur_ascend_class_id = ascend_class_id;
        let start = self
            .classes
            .get(&self.cur_class_id)
            .and_then(|c| c.ascendancies.get(&ascend_class_id).or_else(|| c.ascendancies.get(&0)))
            .and_then(|a| a.start_node_id);
        if let Some(id) = start {
            self.alloc_insert(id);
        }
        if !self.defer_depends {
            self.build_all_depends_and_paths();
        }
    }

    pub fn select_secondary_ascend_class(&mut self, ascend_class_id: i64) {
        if self.alternate_ascendancies.is_empty() {
            return;
        }
        let old_id = self.alternate_ascendancies.get(&self.cur_secondary_ascend_class_id).and_then(|a| a.start_node_id);
        if let Some(id) = old_id {
            self.alloc_remove(id);
        }
        self.cur_secondary_ascend_class_id = ascend_class_id;
        if ascend_class_id != 0 {
            let new_id = self.alternate_ascendancies.get(&ascend_class_id).and_then(|a| a.start_node_id);
            if let Some(id) = new_id {
                self.alloc_insert(id);
            }
        }
        if !self.defer_depends {
            self.build_all_depends_and_paths();
        }
    }

    /// Port of `ImportFromNodeList`.
    pub fn import_from_node_list(
        &mut self,
        class_id: i64,
        ascend_class_id: i64,
        secondary_ascend_class_id: i64,
        hash_list: &[i64],
        mastery_effects: &HashMap<i64, i64>,
    ) {
        self.reset_nodes();
        // Each select below ends in `build_all_depends_and_paths`, run while only the start nodes are allocated and
        // no mastery is selected. In a stats-only run (`SKIP_PATHS`, no path search) such a pass leaves nothing the
        // pass after the node list doesn't recompute from scratch: no radius or abyss jewel is allocated, nothing
        // can be pruned, and dn/sd/mods, depends, conquests and counts are all reset at its start. So it is skipped.
        self.defer_depends = SKIP_PATHS.with(|c| c.get());
        self.select_class(class_id);
        self.select_ascend_class(ascend_class_id);
        self.select_secondary_ascend_class(secondary_ascend_class_id);
        self.defer_depends = false;
        self.mastery_selections.clear();
        for (&mastery, &effect) in mastery_effects {
            if effect < 65536 {
                self.mastery_selections.insert(mastery, effect);
            }
        }
        for &id in hash_list {
            match self.nodes.get(&id) {
                Some(node) => {
                    if node.kind != "Mastery" || self.mastery_selections.contains_key(&id) {
                        self.alloc_insert(id);
                    }
                }
                // Cluster-jewel subgraph node: doesn't exist until build_cluster_jewel_graphs
                // generates it. Queued exactly like upstream's `self.allocSubgraphNodes`.
                None => self.pending_subgraph_alloc.push(id),
            }
        }
        // With cluster jewels this pass runs again after their subgraphs are built, and the second pass recomputes
        // everything the first sets. Only the first pass's pruning (and mastery drops) would reach the subgraph build.
        // Subgraphs hang off a single socket, so they can't connect main-tree nodes, and the second pass prunes
        // the same main-tree nodes the first would have, unless a radius jewel's carve-out protects some (a
        // subgraph socket can hold one). So the first pass is skipped when no jewel has a carve-out, and
        // `spec_from_xml_full` rebuilds without skipping whenever the second pass removes anything.
        if self.defer_node_list_depends && !self.has_radius_carve_out() {
            self.node_list_depends_deferred = true;
            return;
        }
        self.build_all_depends_and_paths();
    }

    /// Some jewel input can protect a node from orphan pruning (Intuitive-Leap-like or Impossible Escape).
    fn has_radius_carve_out(&self) -> bool {
        self.cluster_jewel_inputs.values().any(|j| j.jewel_radius_index.is_some() && (j.intuitive_leap_like || !j.impossible_escape_keystones.is_empty()))
    }

    pub fn count_alloc_nodes(&self) -> (i32, i32, i32, i32) {
        let (mut used, mut asc_used, mut secondary_asc_used, mut sockets) = (0, 0, 0, 0);
        for node in self.nodes.values() {
            if !node.alloc || node.kind == "ClassStart" || node.kind == "AscendClassStart" {
                continue;
            }
            if let Some(asc_name) = &node.ascendancy_name {
                if !node.is_multiple_choice_option {
                    asc_used += 1;
                    // Classes/PassiveTree.lua keys secondaryAscendNameMap by ascendClass.id (its
                    // internal id like "Olroth"), which is what node.ascendancyName holds, not
                    // the display name.
                    if self.alternate_ascendancies.values().any(|a| a.internal_id.as_deref() == Some(asc_name.as_str())) {
                        secondary_asc_used += 1;
                    }
                }
            } else {
                used += 1;
            }
            if node.kind == "Socket" {
                sockets += 1;
            }
        }
        (used, asc_used, secondary_asc_used, sockets)
    }

    fn dealloc_single_node(&mut self, id: i64) {
        let is_mastery = self.nodes.get(&id).map(|n| n.kind == "Mastery").unwrap_or(false);
        self.alloc_remove(id);
        if is_mastery {
            self.mastery_selections.remove(&id);
        }
    }


    /// Port of `BuildAllDependsAndPaths`. Scope note: upstream also computes jewel-radius
    /// (Intuitive Leap-like) dependency carve-outs from equipped jewels; not wired up here yet
    /// (see crate root docs), so `intuitiveLeapLikesAffecting` is always empty. Legion (timeless
    /// jewel) conquered-node replacement (`self.timeless_data`) is implemented; see
    /// `apply_conquered_nodes`. Abyss conquered-node replacement is not (see `timelessjewel.rs`).
    /// Everything else (depends, paths, connectedToStart, points) is a faithful line-for-line port.
    pub fn build_all_depends_and_paths(&mut self) {
        // Counts this pass's own pruning too: see `build_cluster_jewel_graphs`.
        self.alloc_changed = false;
        // "Read Abyss changes before resetting the nodes" (PassiveSpec.lua:1111-1126).
        let mut pf = crate::PfT::new();
        let abyss_conquests = self.read_abyss_conquests();
        pf.lap("bad.read_abyss");
        // Only a touched node can hold any of this (see `NodeMap`); written only where something is set.
        for i in 0..self.nodes.touched().len() {
            let id = self.nodes.touched()[i];
            let n = &self.nodes[&id];
            if !n.depends.is_empty() || !n.intuitive_leap_likes_affecting.is_empty() || n.conquered_by.is_some() {
                let node = crate::node::node_mut(&mut self.nodes, &id).unwrap();
                node.depends.clear();
                node.intuitive_leap_likes_affecting.clear();
                node.conquered_by = None;
            }
        }
        // Reset every real tree node back to its canonical (un-conquered, un-tattooed) dn/sd/mods
        // before applying either replacement this pass, matching upstream's own per-node
        // `self:ReplaceNode(node, self.tree.nodes[id])` reset right before the hash_overrides/
        // conquered-node branches. Without this, calling this function more than once per spec
        // (`import_from_node_list`, then `build_cluster_jewel_graphs`'s PostLoad pass) compounds an
        // earlier call's ADD-mode mods (e.g. a conquered Normal node's "+2 to Dexterity" mod) a
        // second time. Scoped to nodes that exist in `self.tree.nodes` (cluster-jewel-generated
        // nodes have no tree counterpart and aren't touched); masteries are included even though
        // upstream special-cases an unallocated, all-options-shown one, because this crate
        // doesn't track that display-only state and the golden harness never samples an
        // unallocated node's dn/mods anyway (see `apply_conquered_nodes`'s own scope note).
        // A dirty node was written, so it is touched (see `NodeMap`).
        for i in 0..self.nodes.touched().len() {
            let id = self.nodes.touched()[i];
            if self.generated_node_ids.contains(&id) {
                continue;
            }
            if !self.nodes.get(&id).is_some_and(|n| n.dirty) {
                continue;
            }
            let tree = self.tree;
            let Some(tree_node) = tree.node(id) else { continue };
            let mods = tree.node_mods.get(&id).cloned().unwrap_or_default();
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                n.dn = tree_node.get("dn").and_then(|v| v.as_str()).unwrap_or("").into();
                n.sd = std::sync::Arc::new(str_list(tree_node.get("sd").unwrap_or(J::NULL)));
                n.mods = mods;
                n.is_tattoo = as_bool(tree_node.get("isTattoo").unwrap_or(J::NULL));
                n.override_type = None;
                n.dirty = false;
            }
        }
        pf.lap("bad.reset_nodes");
        // Apply tattoo hash overrides (ReplaceNode) before the depends/paths pass, matching the
        // original's ordering (`if self.hashOverrides[node.id] then self:ReplaceNode(...) end`,
        // `BuildAllDependsAndPaths` line ~1213). `hash_overrides` already holds each override's
        // resolved `tree.tattoo.nodes[dn]` template (`lib.rs` populates it from `<Overrides>`).
        // A Runegraft (`overrideType == "AlternateMastery"`) represents one fixed modifier rather
        // than the usual list of selectable Mastery effects; upstream tracks that by leaving
        // `allMasteryOptions` false so a later pass doesn't expand it with every possible effect.
        // This port doesn't track `allMasteryOptions` at all (see `node.rs`) since the golden
        // harness only ever samples an allocated node, and an unallocated Mastery's "show every
        // option" text is never graded (`apply_conquered_nodes`'s scope note says the same for
        // conquered nodes): the `ReplaceNode` below is the only observable effect here.
        // Moved out for the loop (the replacement never reads it) instead of copying every template per pass.
        let overrides = std::mem::take(&mut self.hash_overrides);
        for (&id, template) in overrides.iter() {
            self.replace_node_with_json(id, *template);
        }
        self.hash_overrides = overrides;
        // Radius-jewel scan (`BuildAllDependsAndPaths`, original lines ~1128-1408): the
        // Intuitive-Leap-like / Impossible-Escape `intuitiveLeapLikesAffecting` carve-outs, plus
        // Legion conquered-node replacement (jewelType 1-6 only). Scoped to allocated nodes only.
        // The golden harness's `nodeMods`/`pathSample` fields never sample an unallocated node's
        // dn/mods, and neither carve-out adds a new allocated or linked id to the tree; each only
        // protects or replaces one that's already allocated. So an unallocated node's
        // `intuitiveLeapLikesAffecting`/`conqueredBy` can't be observed here, even though the
        // original computes it too. Revisit if that harness field set changes.
        pf.lap("bad.overrides");
        self.scan_radius_jewels();
        self.apply_abyss_conquests(abyss_conquests);
        pf.lap("bad.scan_radius");
        for i in 0..self.nodes.touched().len() {
            let id = self.nodes.touched()[i];
            if self.nodes[&id].alloc {
                crate::node::node_mut(&mut self.nodes, &id).unwrap().depends.push(id);
            }
        }

        // Mastery effect selection: assign the selected effect's stats to allocated mastery
        // nodes; drop the selection if the effect no longer exists or the node isn't allocated.
        self.allocated_mastery_count = 0;
        self.allocated_notable_count = 0;
        self.allocated_keystone_count = 0;
        let selections: Vec<(i64, i64)> = self.mastery_selections.iter().map(|(&k, &v)| (k, v)).collect();
        let debug = pom_engine::env::var("PASSIVE_SPEC_DEBUG").is_ok();
        for (id, effect_id) in selections {
            let is_mastery_alloc = self.nodes.get(&id).map(|n| n.kind == "Mastery" && n.alloc).unwrap_or(false);
            if debug {
                eprintln!(
                    "mastery sel id={id} effect={effect_id} present={} kind={:?} alloc={:?} effect_sd_present={}",
                    self.nodes.contains_key(&id),
                    self.nodes.get(&id).map(|n| n.kind.clone()),
                    self.nodes.get(&id).map(|n| n.alloc),
                    self.mastery_effect_sd.contains_key(&effect_id)
                );
            }
            if !is_mastery_alloc {
                // Matches upstream's own `else` branch for this same condition (`if effect
                // and self.allocNodes[id] then ... else self.nodes[id].alloc = false;
                // self.allocNodes[id] = nil; self.masterySelections[id] = nil end`): a
                // `masterySelections` entry for a mastery node that never actually got allocated
                // (not in the hash list, or a tree-version change dropped it) doesn't just sit
                // there unapplied, it gets removed, so `EncodeURL` and a later reload don't keep
                // reporting a mastery selection for a node that was never really on the tree.
                self.dealloc_single_node(id);
                self.mastery_selections.remove(&id);
                continue;
            }
            match self.mastery_effect_sd.get(&effect_id).cloned() {
                Some(sd) => {
                    // A Runegraft (tattoo `overrideType == "AlternateMastery"`) still needs a
                    // `masterySelections` entry to reach this branch at all (see upstream's
                    // own condition just above this match), but once here it's the hash-override
                    // template, not "effectId"'s own sd, that wins: `if self.hashOverrides[id]
                    // then self:ReplaceNode(node, self.hashOverrides[id]) else node.sd =
                    // effect.sd end`, `self.tree:ProcessStats(node)` right after either branch.
                    // That final `ProcessStats` call re-parses `node.sd` fresh, sourced to this
                    // node's own real id ("Tree:<id>"): it's what actually produces the graded
                    // `modList`, discarding whatever `ReplaceNode`'s own verbatim modList copy
                    // (the template's own pre-sourced mods, e.g. "Tree:runegraft_15") just set.
                    // Skipping the `ReplaceNode` dn/sd swap entirely would let the plain
                    // mastery-effect selection silently overwrite a tattoo's own text every time
                    // this pass reruns.
                    if let Some(template) = self.hash_overrides.get(&id).copied() {
                        let dn = template.get("dn").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let (sd, mods) = shared_stats(id, str_list(template.get("sd").unwrap_or(J::NULL)));
                        if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                            n.dirty = true;
                            n.dn = dn.into();
                            n.sd = sd;
                            n.mods = mods;
                            n.is_tattoo = as_bool(template.get("isTattoo").unwrap_or(J::NULL));
                            n.override_type = template.get("overrideType").and_then(|v| v.as_str()).map(|s| s.into());
                        }
                    } else {
                        let (sd, mods) = shared_stats(id, sd);
                        if debug {
                            eprintln!("  -> sd={sd:?} mods.len={}", mods.len());
                        }
                        if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                            n.dirty = true;
                            n.sd = sd;
                            n.mods = mods;
                        }
                    }
                    self.allocated_mastery_count += 1;
                }
                None => {
                    self.dealloc_single_node(id);
                    self.mastery_selections.remove(&id);
                }
            }
        }
        for &id in self.nodes.touched() {
            let node = &self.nodes[&id];
            if node.alloc && node.kind == "Notable" {
                self.allocated_notable_count += 1;
            }
            if node.alloc && node.kind == "Keystone" {
                self.allocated_keystone_count += 1;
            }
        }

        pf.lap("bad.mastery");
        // ---- depends / connectedToStart ----
        // `pairs(self.allocNodes)` order: a snapshot taken once, since `DeallocSingleNode` below
        // (pruning orphans) only ever clears keys during this same pass, never inserts. A node
        // pruned by an earlier id in this list is skipped when its own turn comes, exactly like a
        // real Lua `next()` skipping a slot cleared before it got there.
        //
        // `potential_deps`/`intuitive_leaps` port upstream's `potentialDeps`/`intuitiveLeaps`
        // tables (original lines ~1470-1624): the Intuitive-Leap-like/Impossible-Escape carve-out
        // to the depends/orphan-pruning pass above. Iterated here in sorted-key order for a
        // deterministic run; upstream's real Lua table order could differ when more than one
        // radius jewel's carve-out overlaps the same node or dependency chain, which every comment
        // on this feature so far has called vanishingly rare in practice (see `radius_jewels`).
        let mut potential_deps: HashMap<i64, Vec<i64>> = HashMap::default();
        let mut intuitive_leaps: HashMap<i64, Vec<i64>> = HashMap::default();
        let alloc_ids: Vec<i64> = self.alloc_order.iterate();
        // The start-node search runs over dense arrays of the nodes allocated now (only they can be walked, and none
        // gets allocated during this pass); pruning below clears `g.alloc` along with the node's own flag.
        let mut g = AllocGraph::new(&self.nodes, &alloc_ids);
        // Stats-only pass (`SKIP_PATHS`): the depends lists this loop builds, and the Intuitive-Leap bookkeeping, are
        // read only to prune a node that reaches no start, and only that node's own list is read. Nothing outside
        // the spec reads them. So a node that reaches a start is settled by one reverse search from the start nodes
        // (`reach`, with `find_start`'s step rules), keeping only `connected_to_start`; start nodes are never pruned
        // and skipped; any other node runs the loop body below unchanged, and the search is redone after a prune.
        // POM_CHECK_FASTDEP=1 builds every spec both ways and reports a difference (see `spec_from_xml_full`).
        let hybrid = SKIP_PATHS.with(|c| c.get()) && !FULL_DEPENDS.with(|c| c.get());
        let reach_of = |g: &AllocGraph| -> (Vec<bool>, Vec<u32>) {
            let n = g.ids.len();
            let mut parent: Vec<u32> = vec![u32::MAX; n];
            let mut reached = vec![false; n];
            let mut queue: VecDeque<u32> = VecDeque::new();
            // Links need not be symmetric (older trees): `find_start` steps along a node's own list, so the search
            // walks back along the nodes whose list holds the node.
            // (flat: `rev_nodes[rev_start[x]..rev_start[x + 1]]`, in the order the per-node lists would hold them)
            let mut rev_start = vec![0u32; n + 1];
            for m in 0..n {
                for &(_, x) in &g.adj[m] {
                    rev_start[x as usize + 1] += 1;
                }
            }
            for x in 0..n {
                rev_start[x + 1] += rev_start[x];
            }
            let mut fill = rev_start.clone();
            let mut rev_nodes = vec![0u32; rev_start[n] as usize];
            for m in 0..n {
                for &(_, x) in &g.adj[m] {
                    rev_nodes[fill[x as usize] as usize] = m as u32;
                    fill[x as usize] += 1;
                }
            }
            for x in 0..n {
                if g.alloc[x] && g.is_start[x] {
                    reached[x] = true;
                    queue.push_back(x as u32);
                }
            }
            while let Some(x) = queue.pop_front() {
                for k in rev_start[x as usize]..rev_start[x as usize + 1] {
                    let m = rev_nodes[k as usize] as usize;
                    if !g.alloc[m] || reached[m] {
                        continue;
                    }
                    // the step m -> x
                    if g.is_mastery[m] && !g.is_start[x as usize] {
                        continue;
                    }
                    if g.has_asc[m] && !g.has_asc[x as usize] {
                        continue;
                    }
                    reached[m] = true;
                    parent[m] = x;
                    queue.push_back(m as u32);
                }
            }
            (reached, parent)
        };
        let mut reach = hybrid.then(|| reach_of(&g));
        for id in alloc_ids {
            if let Some((reached, parent)) = &reach {
                let Some(&i) = g.index.get(&id) else { continue };
                let i = i as usize;
                if !g.alloc[i] || g.is_start[i] {
                    continue;
                }
                // A neighbour that is a start, or reaches one on a path avoiding this node.
                let avoids = |mut o: usize| -> bool {
                    loop {
                        if o == i {
                            return false;
                        }
                        if parent[o] == u32::MAX {
                            return true;
                        }
                        o = parent[o] as usize;
                    }
                };
                if g.adj[i].iter().any(|&(_, o)| g.alloc[o as usize] && (g.is_start[o as usize] || (reached[o as usize] && avoids(o as usize)))) {
                    if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                        n.connected_to_start = true;
                    }
                    continue;
                }
            }
            let Some(&i) = g.index.get(&id) else { continue };
            if !g.alloc[i as usize] {
                continue;
            }
            g.visited[i as usize] = true;
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                n.connected_to_start = false;
            }
            let mut any_start_found = g.is_start[i as usize];
            for k in 0..g.adj[i as usize].len() {
                let (other_id, o) = g.adj[i as usize][k];
                if !g.alloc[o as usize] {
                    continue;
                }
                if self.nodes[&id].depends.contains(&other_id) {
                    continue;
                }
                if g.is_start[o as usize] {
                    any_start_found = true;
                    crate::node::node_mut(&mut self.nodes, &id).unwrap().connected_to_start = true;
                    continue;
                }
                let mut visited_dense = Vec::new();
                let found = g.find_start(o, &mut visited_dense, false);
                let visited: Vec<i64> = visited_dense.iter().map(|&v| g.ids[v as usize]).collect();
                for &v in &visited_dense {
                    g.visited[v as usize] = false;
                }
                if found {
                    any_start_found = true;
                    crate::node::node_mut(&mut self.nodes, &id).unwrap().connected_to_start = true;
                } else {
                    // `id`'s new depends, appended in `visited` order once the loop is done (nothing in it reads them).
                    let mut new_deps: Vec<i64> = Vec::with_capacity(visited.len());
                    let mut dep_ids: Option<HashSet<i64>> = None;
                    let any_jewel_input = !self.cluster_jewel_inputs.is_empty();
                    for vid in &visited {
                        let v = &self.nodes[vid];
                        let is_mastery = v.kind == "Mastery";
                        if is_mastery {
                            let linked_v = v.linked_ids.clone();
                            let alloc_link_count = linked_v.iter().filter(|l| self.nodes.get(l).map(|n| n.alloc).unwrap_or(false)).count();
                            let mut other_path = false;
                            if alloc_link_count > 1 {
                                let dep_ids = dep_ids.get_or_insert_with(|| visited.iter().cloned().collect());
                                for l in linked_v.iter() {
                                    if self.nodes.get(l).map(|n| n.alloc).unwrap_or(false) && !dep_ids.contains(l) {
                                        other_path = true;
                                    }
                                }
                            }
                            if !other_path {
                                new_deps.push(*vid);
                            }
                        } else if !v.intuitive_leap_likes_affecting.is_empty() {
                            // `n` depends on an Intuitive-Leap-like/Impossible-Escape radius jewel
                            // itself, so whether `id` truly depends on `n` is resolved later, once
                            // `id`'s own depends (via `potential_deps`) are known.
                            potential_deps.entry(*vid).or_default().push(id);
                        } else {
                            new_deps.push(*vid);
                        }
                        if !is_mastery && any_jewel_input {
                            let affected = self.nodes_in_intuitive_leap_like_radius(*vid);
                            if !affected.is_empty() {
                                intuitive_leaps.entry(id).or_default().extend(affected);
                            }
                        }
                    }
                    if !new_deps.is_empty() {
                        crate::node::node_mut(&mut self.nodes, &id).unwrap().depends.extend(new_deps);
                    }
                }
            }
            g.visited[i as usize] = false;
            if !any_start_found {
                let deps = self.nodes[&id].depends.clone();
                for dep_id in deps {
                    if let Some(socket_id) = self.orphan_prune_override(dep_id) {
                        // Hold off on pruning: an allocated Intuitive-Leap-like or Impossible-
                        // Escape jewel could still support this node (original lines ~1548-1581).
                        intuitive_leaps.entry(socket_id).or_default().push(dep_id);
                    } else {
                        self.dealloc_single_node(dep_id);
                        if let Some(&d) = g.index.get(&dep_id) {
                            g.alloc[d as usize] = false;
                        }
                    }
                }
                if reach.is_some() {
                    reach = Some(reach_of(&g));
                }
            }
        }
        // Resolve `potentialDeps`: a node `n` reachable only through an Intuitive-Leap-like/
        // Impossible-Escape-protected dead end really depends on the processing node `pdep` only
        // once `pdep` itself already depends on every radius jewel protecting `n` (original lines
        // ~1470/~1589-1604).
        let mut potential_dep_keys: Vec<i64> = potential_deps.keys().copied().collect();
        potential_dep_keys.sort_unstable();
        for n_id in potential_dep_keys {
            let affecting = self.nodes.get(&n_id).map(|n| n.intuitive_leap_likes_affecting.clone()).unwrap_or_default();
            let mut seen: HashSet<i64> = HashSet::default();
            for pdep_id in potential_deps[&n_id].clone() {
                let all_dep = affecting.iter().all(|provider| self.nodes.get(&pdep_id).map(|n| n.depends.contains(provider)).unwrap_or(false));
                if all_dep && seen.insert(pdep_id) {
                    if let Some(n) = crate::node::node_mut(&mut self.nodes, &pdep_id) {
                        n.depends.push(n_id);
                    }
                }
            }
        }
        // Resolve `intuitiveLeaps`: a node `dep` behind a radius-jewel-protected dead end (or an
        // orphan the jewel-radius override protected above) depends on the node/socket that
        // reached it, provided `dep` isn't already connected some other way and that node/socket
        // already depends on every radius jewel protecting `dep` (original lines ~1471/~1606-1624).
        let mut intuitive_leap_keys: Vec<i64> = intuitive_leaps.keys().copied().collect();
        intuitive_leap_keys.sort_unstable();
        for key_id in intuitive_leap_keys {
            if !self.nodes.contains_key(&key_id) {
                continue;
            }
            let mut seen: HashSet<i64> = HashSet::default();
            for dep_id in intuitive_leaps[&key_id].clone() {
                let dep_connected = self.nodes.get(&dep_id).map(|n| n.connected_to_start).unwrap_or(false);
                if dep_connected {
                    continue;
                }
                let dep_affecting = self.nodes.get(&dep_id).map(|n| n.intuitive_leap_likes_affecting.clone()).unwrap_or_default();
                let all_dep = dep_affecting.iter().all(|provider| self.nodes.get(&key_id).map(|n| n.depends.contains(provider)).unwrap_or(false));
                if all_dep && seen.insert(dep_id) {
                    if let Some(n) = crate::node::node_mut(&mut self.nodes, &key_id) {
                        n.depends.push(dep_id);
                    }
                }
            }
        }

        pf.lap("bad.depends");
        // ---- paths (multi-source 0-1 BFS) ----
        // An untouched node already has path_dist 1000, no path and distance 0 (see `NodeMap`).
        for i in 0..self.nodes.touched().len() {
            let id = self.nodes.touched()[i];
            let node = &self.nodes[&id];
            let path_dist = if node.alloc && node.intuitive_leap_likes_affecting.is_empty() { 0 } else { 1000 };
            let socket = node.is_jewel_socket || node.expansion_jewel.is_some();
            if node.path_dist != path_dist || !node.path.is_empty() || (socket && node.distance_to_class_start != 0) {
                let node = crate::node::node_mut(&mut self.nodes, &id).unwrap();
                node.path_dist = path_dist;
                node.path.clear();
                if socket {
                    node.distance_to_class_start = 0;
                }
            }
        }
        // `for _, node in pairs(self.allocNodes) do ... t_insert(rootList, node) end`: this order
        // seeds the 0-1 BFS queue below, so it decides which of several equal-length paths to a
        // frontier node upstream records.
        let root_list: Vec<i64> = self
            .alloc_order
            .iterate()
            .into_iter()
            .filter(|id| self.nodes.get(id).map(|n| n.intuitive_leap_likes_affecting.is_empty() || n.connected_to_start).unwrap_or(false))
            .collect();
        // The path search below only fills `path` and `path_dist`, which the tree view shows and no stat reads; a
        // stats-only caller skips it with `SKIP_PATHS`. `distance_to_class_start` (read by jewel scaling) is
        // computed separately after it and always runs.
        let skip_paths = SKIP_PATHS.with(|c| c.get());
        let mut queue: VecDeque<i64> = VecDeque::new();
        for &id in &root_list {
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                n.path_dist = 0;
                n.path.clear();
            }
            if !skip_paths {
                queue.push_back(id);
            }
        }
        while let Some(id) = queue.pop_front() {
            let Some(node) = self.nodes.get(&id) else { continue };
            let node_dist = node.path_dist;
            let node_path = node.path.clone();
            let node_type = node.kind.clone();
            let node_asc = node.ascendancy_name.clone();
            let linked = node.linked_ids.clone();
            for other_id in linked.iter().copied() {
                let Some(other) = self.nodes.get(&other_id) else { continue };
                let weight = if other.alloc { 0 } else { 1 };
                let dist_via = node_dist + weight;
                let other_type = other.kind.clone();
                let other_asc = other.ascendancy_name.clone();
                let other_path_dist = other.path_dist;
                let can_traverse = node_type != "Mastery"
                    && other_type != "ClassStart"
                    && other_type != "AscendClassStart"
                    && (node_asc == other_asc || (node_dist == 0 && other_asc.is_none()));
                if dist_via < other_path_dist && can_traverse {
                    if weight == 0 {
                        queue.push_front(other_id);
                    } else {
                        queue.push_back(other_id);
                    }
                    let mut new_path = vec![other_id];
                    new_path.extend(&node_path);
                    if let Some(n) = crate::node::node_mut(&mut self.nodes, &other_id) {
                        n.path_dist = dist_via;
                        n.path = new_path;
                    }
                }
            }
        }
        pf.lap("bad.bfs");
        // A stats-only pass leaves the distances to `class_start_distance`, asked for only by a jewel whose effect
        // grows with it; the search there reads the same final state.
        self.lazy_distance = skip_paths;
        if skip_paths {
            return;
        }
        for &id in &root_list {
            let is_socket_or_exp = self.nodes.get(&id).map(|n| n.is_jewel_socket || n.expansion_jewel.is_some()).unwrap_or(false);
            if is_socket_or_exp {
                self.set_node_distance_to_class_start(id);
            }
        }
    }

    /// `node.distanceToClassStart` of an allocated jewel socket (0 for a node that isn't connected).
    pub fn class_start_distance(&self, id: i64) -> i64 {
        if !self.lazy_distance {
            return self.nodes.get(&id).map_or(0, |n| n.distance_to_class_start);
        }
        let Some(n) = self.nodes.get(&id) else { return 0 };
        if !(n.is_jewel_socket || n.expansion_jewel.is_some()) || !n.alloc || !n.connected_to_start {
            return 0;
        }
        if self.classes.get(&self.cur_class_id).is_none() {
            return n.distance_to_class_start;
        }
        self.distance_search(id)
    }

    // ---- radius jewels (timeless/conqueror, Intuitive Leap-like, Impossible Escape) ----

    /// Allocated sockets holding any radius jewel (`item.jewelRadiusIndex` set, `jewelData`
    /// present, not `limitDisabled`), matching `BuildAllDependsAndPaths`'s `radiusJewels`
    /// gathering loop (original lines ~1128-1139). `self.jewels` has no defined iteration order
    /// in this port (a plain `HashMap`, unlike upstream's Lua table); sorted by node id
    /// instead for a deterministic, reproducible run. This only matters when two radius jewels'
    /// radii overlap the same node and disagree, vanishingly rare in practice.
    fn radius_jewels(&self) -> Vec<(i64, ClusterJewelInput)> {
        let jewel_ids = self.jewel_keys_in_pairs_order();
        let mut out = Vec::new();
        for socket_id in jewel_ids {
            let Some(input) = self.cluster_jewel_inputs.get(&socket_id) else { continue };
            if input.jewel_radius_index.is_none() || input.limit_disabled {
                continue;
            }
            if !self.nodes.get(&socket_id).map(|n| n.alloc).unwrap_or(false) {
                continue;
            }
            out.push((socket_id, input.clone()));
        }
        out
    }

    /// Whether `node_id` falls in `key_name`'s (a real tree keystone's display name) own radius
    /// at `radius_index0` (0-based). Port of `NodeInKeystoneRadius`/the `impossibleEscapeKeystones`
    /// loop's per-keystone radius check: looks the keystone up via `tree.keystoneMap`, which may
    /// itself be a `$ref` into `tree.nodes` (see `treedata.rs`'s `deref`), so it must be resolved
    /// before reading `nodesInRadius` off it.
    fn node_in_keystone_radius(&self, key_name: &str, node_id: i64, radius_index0: usize) -> bool {
        self.keystone_radius_set(key_name, radius_index0).contains(&node_id)
    }

    fn keystone_radius_set(&self, key_name: &str, radius_index0: usize) -> std::rc::Rc<HashSet<i64>> {
        // The keystone's radius set, read from the tree once per (tree, keystone, radius).
        thread_local! {
            static SETS: std::cell::RefCell<HashMap<(usize, String, usize), std::rc::Rc<HashSet<i64>>>> = std::cell::RefCell::new(HashMap::default());
        }
        let key = (self.tree as *const TreeData as usize, key_name.to_string(), radius_index0);
        let set = match SETS.with(|c| c.borrow().get(&key).cloned()) {
            Some(s) => s,
            None => {
                let set: HashSet<i64> = self
                    .tree
                    .section("keystoneMap")
                    .and_then(|k| k.get(key_name))
                    .map(|km| self.tree.deref(km))
                    .and_then(|key_node| key_node.get("nodesInRadius"))
                    .and_then(|nr| nr.get(radius_index0))
                    .and_then(|r| r.as_object())
                    .map(|r| r.keys().filter_map(|k| k.parse::<i64>().ok()).collect())
                    .unwrap_or_default();
                let set = std::rc::Rc::new(set);
                SETS.with(|c| c.borrow_mut().insert(key, set.clone()));
                set
            }
        };
        set
    }

    /// Port of `NodesInIntuitiveLeapLikeRadius`: allocated nodes in `socket_id`'s own jewel's
    /// radius (when that jewel is Intuitive-Leap-like), plus allocated nodes in the radius of any
    /// keystone its Impossible Escape protects. Distinct from `intuitive_leap_likes_affecting`
    /// (which nodes a radius jewel protects, set by `scan_radius_jewels`): this instead asks,
    /// given a node that is itself an allocated jewel socket, which already-allocated nodes its
    /// own jewel would protect.
    fn nodes_in_intuitive_leap_like_radius(&self, socket_id: i64) -> Vec<i64> {
        let mut result = Vec::new();
        let Some(jewel) = self.cluster_jewel_inputs.get(&socket_id) else { return result };
        let Some(radius_index) = jewel.jewel_radius_index else { return result };
        let radius_index0 = (radius_index - 1).max(0) as usize;
        let collect_radius = |obj: Option<pom_engine::cjson::JObj>, result: &mut Vec<i64>| {
            let Some(obj) = obj else { return };
            let mut ids: Vec<i64> = obj.keys().filter_map(|k| k.parse::<i64>().ok()).collect();
            ids.sort_unstable();
            for nid in ids {
                if self.nodes.get(&nid).map(|n| n.alloc).unwrap_or(false) {
                    result.push(nid);
                }
            }
        };
        if jewel.intuitive_leap_like {
            let in_radius = self.tree.node(socket_id).and_then(|n| n.get("nodesInRadius")).and_then(|nr| nr.get(radius_index0)).and_then(|r| r.as_object());
            collect_radius(in_radius, &mut result);
        }
        for key_name in &jewel.impossible_escape_keystones {
            let Some(km) = self.tree.section("keystoneMap").and_then(|k| k.get(key_name)) else { continue };
            let key_node = self.tree.deref(km);
            let in_radius = key_node.get("nodesInRadius").and_then(|nr| nr.get(radius_index0)).and_then(|r| r.as_object());
            collect_radius(in_radius, &mut result);
        }
        result
    }

    /// `pairs(self.jewels)` key order (LuaJIT hash-slot order). Falls back to sorted order if
    /// `jewels` was filled without going through `set_jewel` (never in the pipeline).
    pub fn jewel_keys_in_pairs_order(&self) -> Vec<i64> {
        let ordered = self.jewels_lj.iterate();
        if ordered.len() == self.jewels.len() && ordered.iter().all(|k| self.jewels.contains_key(k)) {
            return ordered;
        }
        let mut ids: Vec<i64> = self.jewels.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// `self.jewels[node] = item`.
    pub fn set_jewel(&mut self, node: i64, item: i64) {
        self.jewels.insert(node, item);
        self.jewels_lj.set(node, true);
    }

    /// Port of the orphan-pruning override inside `BuildAllDependsAndPaths`'s `if not
    /// anyStartFound` branch (original lines ~1551-1581): before an orphaned dependency
    /// (`dep_id`) is actually pruned, check every allocated socket's jewel (regardless of
    /// `limitDisabled`, unlike `radius_jewels`, matching upstream's own unfiltered
    /// `pairs(self.jewels)` scan here) for whether it protects `dep_id` via an Intuitive-Leap-like
    /// or Impossible-Escape radius. Returns the protecting socket id on the first match (the
    /// original `break`s on its first match too), or `None` if nothing protects it.
    fn orphan_prune_override(&self, dep_id: i64) -> Option<i64> {
        let socket_ids = self.jewel_keys_in_pairs_order();
        for socket_id in socket_ids {
            if !self.nodes.get(&socket_id).map(|n| n.alloc).unwrap_or(false) {
                continue;
            }
            let Some(jewel) = self.cluster_jewel_inputs.get(&socket_id) else { continue };
            let Some(radius_index) = jewel.jewel_radius_index else { continue };
            let radius_index0 = (radius_index - 1).max(0) as usize;
            if jewel.intuitive_leap_like {
                let in_radius = self
                    .tree
                    .node(socket_id)
                    .and_then(|n| n.get("nodesInRadius"))
                    .and_then(|nr| nr.get(radius_index0))
                    .and_then(|r| r.as_object())
                    .map(|r| r.contains_key(&dep_id.to_string()))
                    .unwrap_or(false);
                if in_radius {
                    return Some(socket_id);
                }
            }
            for key_name in &jewel.impossible_escape_keystones {
                if self.node_in_keystone_radius(key_name, dep_id, radius_index0) {
                    return Some(socket_id);
                }
            }
        }
        None
    }

    /// Port of `BuildAllDependsAndPaths`'s radius-jewel scan (original lines ~1169-1203), for
    /// every allocated node except ClassStart, Socket and ascendancy nodes: sets
    /// `node.intuitive_leap_likes_affecting` (Intuitive-Leap-like and Impossible-Escape
    /// carve-outs) and `node.conquered_by` (Legion conqueror metadata, jewelType 1-6 only; an
    /// Abyss one, jewelType >= 7, is handled through `abyssConquests` in upstream, not
    /// ported, see `timelessjewel.rs`). Immediately applies the conquest too
    /// (`ReplaceNode`/`NodeAdditionOrReplacementFromString`, upstream's separate second loop
    /// at lines ~1211+) when `self.timeless_data` is loaded, mirroring how this port has always
    /// folded that second pass into this one; `node.conquered_by` is still recorded even without
    /// timeless data loaded; only the actual replacement is skipped.
    /// Node ids in `nodesInRadius[radius_index0]` of a jewel socket, cached per tree, socket and radius.
    fn nodes_in_radius_set(&self, socket_id: i64, radius_index0: usize) -> std::rc::Rc<HashSet<i64>> {
        thread_local! {
            static SETS: std::cell::RefCell<HashMap<(usize, i64, usize), std::rc::Rc<HashSet<i64>>>> = std::cell::RefCell::new(HashMap::default());
        }
        let key = (self.tree as *const TreeData as usize, socket_id, radius_index0);
        if let Some(s) = SETS.with(|c| c.borrow().get(&key).cloned()) {
            return s;
        }
        let set: HashSet<i64> = self
            .tree
            .node(socket_id)
            .and_then(|n| n.get("nodesInRadius"))
            .and_then(|nr| nr.get(radius_index0))
            .and_then(|r| r.as_object())
            .map(|r| r.keys().filter_map(|k| k.parse::<i64>().ok()).collect())
            .unwrap_or_default();
        let set = std::rc::Rc::new(set);
        SETS.with(|c| c.borrow_mut().insert(key, set.clone()));
        set
    }

    fn scan_radius_jewels(&mut self) {
        let radius_jewels = self.radius_jewels();
        if radius_jewels.is_empty() {
            return;
        }
        // Every node in radius is conquered, allocated or not (PassiveSpec.lua:1141-1190 loops
        // `pairs(self.nodes)`); an unallocated notable can still be granted later ("Allocates X" anoints).
        // Each jewel's `nodesInRadius` set, read once instead of once per node (tree geometry never changes).
        let radius_sets: Vec<std::rc::Rc<HashSet<i64>>> = radius_jewels
            .iter()
            .map(|(socket_id, jewel)| self.nodes_in_radius_set(*socket_id, (jewel.jewel_radius_index.unwrap_or(1) - 1).max(0) as usize))
            .collect();
        // Only a node in some jewel's radius (or an Impossible Escape keystone's) can be affected; every other
        // node is a no-op below. The rest keep their order.
        let mut in_any_radius: HashSet<i64> = HashSet::default();
        for (ji, (_, jewel)) in radius_jewels.iter().enumerate() {
            if jewel.intuitive_leap_like || jewel.conquered_by.is_some() {
                in_any_radius.extend(radius_sets[ji].iter().copied());
            }
            let radius_index0 = (jewel.jewel_radius_index.unwrap_or(1) - 1).max(0) as usize;
            for key_name in &jewel.impossible_escape_keystones {
                in_any_radius.extend(self.keystone_radius_set(key_name, radius_index0).iter().copied());
            }
        }
        let alloc_ids: Vec<i64> = self.nodes.keys().copied().filter(|id| in_any_radius.contains(id)).collect();
        for id in alloc_ids {
            let (is_keystone, skip) = {
                let n = &self.nodes[&id];
                (n.kind == "Keystone", n.kind == "ClassStart" || n.kind == "Socket" || n.ascendancy_name.is_some())
            };
            if skip {
                continue;
            }
            let mut affecting: Vec<i64> = Vec::new();
            let mut conquered_by: Option<(i64, String, Option<String>)> = None;
            for (ji, (socket_id, jewel)) in radius_jewels.iter().enumerate() {
                // Lua 1-based `jewelRadiusIndex` -> 0-based index into the exported tree JSON's
                // `nodesInRadius` array (see `ClusterJewelInput::jewel_radius_index`'s doc).
                let radius_index0 = (jewel.jewel_radius_index.unwrap_or(1) - 1).max(0) as usize;
                let in_own_radius = radius_sets[ji].contains(&id);
                if in_own_radius {
                    if jewel.intuitive_leap_like && !(jewel.intuitive_leap_keystone_only && !is_keystone) {
                        affecting.push(*socket_id);
                    }
                    if let Some(cb) = &jewel.conquered_by {
                        let jewel_type = timeless_jewel_type_by_conqueror(&cb.conqueror_type);
                        if jewel_type.map(|t| t < 7).unwrap_or(true) {
                            conquered_by = Some((cb.id, cb.conqueror_type.clone(), cb.conqueror_id.clone()));
                        }
                    }
                }
                for key_name in &jewel.impossible_escape_keystones {
                    if self.node_in_keystone_radius(key_name, id, radius_index0) {
                        affecting.push(*socket_id);
                    }
                }
            }
            if !affecting.is_empty() {
                if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                    n.intuitive_leap_likes_affecting = affecting;
                }
            }
            let Some((seed, conqueror_type, conqueror_id)) = conquered_by else { continue };
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &id) {
                n.conquered_by = Some(crate::node::ConqueredBy { id: seed as f64, conqueror_type: conqueror_type.clone() });
            }
            if let Some(timeless) = self.timeless_data {
                self.apply_conquest(id, seed, &conqueror_type, conqueror_id.as_deref(), timeless);
                self.reconnect_node_to_class_start(id);
            }
        }
    }

    /// Port of the `node.conqueredBy and node.type ~= "Socket"` replacement branch (Notable,
    /// Keystone, Normal), Legion types only (`jewelType 1-6`; see `timelessjewel.rs`).
    fn apply_conquest(&mut self, node_id: i64, seed: i64, conqueror_type: &str, conqueror_id: Option<&str>, timeless: &TimelessJewelData) {
        // A conquest rewrites only this node's dn/sd/mods/isTattoo/overrideType, from the tree's data, the seed and
        // the node's own text. Starting from the node's pristine state (not dirty: no tattoo or earlier replacement)
        // the result is always the same, so it is kept per tree and replayed; the spec is rebuilt several times per
        // edit and a timeless jewel conquers dozens of nodes.
        type Replaced = Option<(crate::node::NStr, std::sync::Arc<Vec<String>>, std::sync::Arc<Vec<PMod>>, bool, Option<crate::node::NStr>, bool)>;
        thread_local! {
            static MEMO: std::cell::RefCell<HashMap<(usize, i64, i64, String, Option<String>), Replaced>> = std::cell::RefCell::new(HashMap::default());
        }
        if !self.nodes.get(&node_id).is_some_and(|n| !n.dirty) {
            return self.apply_conquest_live(node_id, seed, conqueror_type, conqueror_id, timeless);
        }
        let key = (self.tree as *const TreeData as usize, node_id, seed, conqueror_type.to_string(), conqueror_id.map(|s| s.to_string()));
        if let Some(r) = MEMO.with(|m| m.borrow().get(&key).cloned()) {
            if let (Some((dn, sd, mods, is_tattoo, override_type, dirty)), Some(n)) = (r, crate::node::node_mut(&mut self.nodes, &node_id)) {
                n.dn = dn;
                n.sd = sd;
                n.mods = mods;
                n.is_tattoo = is_tattoo;
                n.override_type = override_type;
                n.dirty = dirty;
            }
            return;
        }
        self.apply_conquest_live(node_id, seed, conqueror_type, conqueror_id, timeless);
        // A table that is not in the folder yet (still being unpacked) gave no replacement; that is not kept.
        if !timeless.table_present(timeless_jewel_type_by_conqueror(conqueror_type).unwrap_or(5)) {
            return;
        }
        let r: Replaced = self.nodes.get(&node_id).filter(|n| n.dirty).map(|n| (n.dn.clone(), n.sd.clone(), n.mods.clone(), n.is_tattoo, n.override_type.clone(), n.dirty));
        MEMO.with(|m| {
            let mut m = m.borrow_mut();
            if m.len() > 5_000 {
                m.clear();
            }
            m.insert(key, r);
        });
    }

    fn apply_conquest_live(&mut self, node_id: i64, seed: i64, conqueror_type: &str, conqueror_id: Option<&str>, timeless: &TimelessJewelData) {
        let jewel_type = timeless_jewel_type_by_conqueror(conqueror_type).unwrap_or(5);
        let kind = self.nodes[&node_id].kind.clone();
        match kind.as_str() {
            "Notable" => {
                let lut = timeless.read_lut(seed, node_id, jewel_type);
                if lut.is_empty() {
                    return; // "Missing LUT": matches upstream's ConPrintf-and-skip.
                }
                if jewel_type == 1 {
                    self.apply_glorious_vanity_result(node_id, &lut);
                } else {
                    // Non-Glorious-Vanity types always return exactly one global id: >=
                    // TIMELESS_JEWEL_ADDITIONS is a full node replacement, otherwise it's an
                    // addition id (a small bonus line added, not a replacement).
                    for &global_id in &lut {
                        if global_id >= TIMELESS_JEWEL_ADDITIONS {
                            let idx0 = (global_id - TIMELESS_JEWEL_ADDITIONS) as usize;
                            self.replace_node_by_legion_index(node_id, idx0);
                        } else {
                            self.apply_legion_addition(node_id, global_id, " \n");
                        }
                    }
                }
            }
            "Keystone" => {
                // `conqueror.id`, not the seed: which named historical conqueror (e.g.
                // "maraketh_keystone_1_v2" for Balbala), independent of the roll.
                if let Some(conqueror_id) = conqueror_id {
                    let match_str = format!("{conqueror_type}_keystone_{conqueror_id}");
                    if let Some(idx) = self.legion_node_index_by_id(&match_str) {
                        self.replace_node_by_legion_index(node_id, idx);
                    }
                }
            }
            "Normal" => self.apply_conquest_normal(node_id, seed, conqueror_type, jewel_type, timeless),
            _ => {}
        }
    }

    fn apply_conquest_normal(&mut self, node_id: i64, seed: i64, conqueror_type: &str, jewel_type: i64, timeless: &TimelessJewelData) {
        const ATTRIBUTES: [&str; 3] = ["Dexterity", "Intelligence", "Strength"];
        match conqueror_type {
            "vaal" => {
                let lut = timeless.read_lut(seed, node_id, jewel_type);
                let Some(&global_id) = lut.first() else { return }; // "Missing LUT"
                let Some(idx) = usize::try_from(global_id - TIMELESS_JEWEL_ADDITIONS).ok() else { return };
                self.replace_node_by_legion_index(node_id, idx);
                // The template's sd (now node.sd, post-replace) gets its roll substituted in from
                // the LUT's second element, one sd line at a time (PassiveSpec.lua re-replaces
                // node.sd wholesale on every line, matching that exactly, bugs included).
                let Some(&roll) = lut.get(1) else { return };
                let sd_lines = self.nodes[&node_id].sd.clone();
                let Some(legion) = self.legion_node_json(idx) else { return };
                let sorted_stats = str_list(legion.get("sortedStats").unwrap_or(J::NULL));
                let stats = legion.get("stats").unwrap_or(J::NULL);
                for (i, line) in sd_lines.iter().enumerate() {
                    let Some(stat_key) = sorted_stats.get(i) else { continue };
                    let Some(stat_mod) = stats.get(stat_key) else { continue };
                    let replaced = replace_helper(line, stat_key, stat_mod, roll as f64);
                    self.node_addition_or_replacement_from_string(node_id, &replaced, true);
                }
            }
            "karui" => {
                let amount = if self.is_conquest_attribute_node(node_id, &ATTRIBUTES) { "2" } else { "4" };
                self.node_addition_or_replacement_from_string(node_id, &format!(" \n+{amount} to Strength"), false);
            }
            "maraketh" => {
                let amount = if self.is_conquest_attribute_node(node_id, &ATTRIBUTES) { "2" } else { "4" };
                self.node_addition_or_replacement_from_string(node_id, &format!(" \n+{amount} to Dexterity"), false);
            }
            "kalguur" => {
                let amount = if self.is_conquest_attribute_node(node_id, &ATTRIBUTES) { "1" } else { "2" };
                self.node_addition_or_replacement_from_string(node_id, &format!(" \n{amount}% increased Ward"), false);
            }
            "templar" => {
                if self.is_conquest_attribute_node(node_id, &ATTRIBUTES) {
                    if let Some(idx) = self.legion_node_index_by_id("templar_devotion_node") {
                        self.replace_node_by_legion_index(node_id, idx);
                    }
                } else {
                    self.node_addition_or_replacement_from_string(node_id, " \n+5 to Devotion", false);
                }
            }
            "eternal" => {
                if let Some(idx) = self.legion_node_index_by_id("eternal_small_blank") {
                    self.replace_node_by_legion_index(node_id, idx);
                }
            }
            _ => {}
        }
    }

    /// Port of `GetShortestPathToClassStart`: node ids on the shortest allocated path from `root_id`
    /// to the current class's start node (`None` when the root is not allocated or unreachable).
    fn shortest_path_to_class_start(&self, root_id: i64) -> Option<Vec<i64>> {
        let root = self.nodes.get(&root_id)?;
        if !root.alloc {
            return None;
        }
        let target = self.classes.get(&self.cur_class_id)?.start_node_id;
        let mut parent: HashMap<i64, i64> = HashMap::default();
        let mut queue: VecDeque<i64> = VecDeque::new();
        queue.push_back(root_id);
        while let Some(nid) = queue.pop_front() {
            let node = self.nodes.get(&nid)?;
            for &other_id in node.linked_ids.iter() {
                if other_id == target {
                    let mut path = vec![root_id, other_id];
                    let mut cur = Some(nid);
                    while let Some(c) = cur {
                        path.push(c);
                        cur = parent.get(&c).copied();
                    }
                    return Some(path);
                }
                let Some(other) = self.nodes.get(&other_id) else { continue };
                if other.alloc && node.kind != "Mastery" && other.kind != "ClassStart" && other.kind != "AscendClassStart" && !parent.contains_key(&other_id) && other_id != root_id {
                    parent.insert(other_id, nid);
                    queue.push_back(other_id);
                }
            }
        }
        None
    }

    /// The `abyssConquests` gather at the top of `BuildAllDependsAndPaths` (PassiveSpec.lua:1111-1126):
    /// (node id, seed, conqueror type, modification) for every allocated Abyss timeless jewel socket.
    fn read_abyss_conquests(&self) -> Vec<(i64, i64, String, Vec<crate::abyss::AbyssComponent>)> {
        let mut out: Vec<(i64, i64, String, Vec<crate::abyss::AbyssComponent>)> = Vec::new();
        let Some(timeless) = self.timeless_data else { return out };
        for socket_id in self.jewel_keys_in_pairs_order() {
            let Some(input) = self.cluster_jewel_inputs.get(&socket_id) else { continue };
            let Some(cb) = &input.conquered_by else { continue };
            let Some(jt) = timeless_jewel_type_by_conqueror(&cb.conqueror_type) else { continue };
            if jt < 7 || input.limit_disabled || !self.nodes.get(&socket_id).map(|n| n.alloc).unwrap_or(false) {
                continue;
            }
            let path = if jt == 11 { self.shortest_path_to_class_start(socket_id) } else { None };
            for (nid, m) in timeless.read_abyss_lut(cb.id, socket_id, jt, path.as_deref()) {
                if let Some(e) = out.iter_mut().find(|e| e.0 == nid) {
                    *e = (nid, cb.id, cb.conqueror_type.clone(), m);
                } else {
                    out.push((nid, cb.id, cb.conqueror_type.clone(), m));
                }
            }
        }
        out
    }

    /// The `jewelType >= 7` branch of the "If node is conquered, replace it or add mods" loop.
    /// A node a radius jewel already conquered (Legion type) keeps that conquest.
    fn apply_abyss_conquests(&mut self, conquests: Vec<(i64, i64, String, Vec<crate::abyss::AbyssComponent>)>) {
        for (node_id, seed, conqueror_type, comps) in conquests {
            let Some(n) = crate::node::node_mut(&mut self.nodes, &node_id) else { continue };
            if n.conquered_by.is_some() {
                continue;
            }
            n.conquered_by = Some(crate::node::ConqueredBy { id: seed as f64, conqueror_type: conqueror_type.clone() });
            let kind = n.kind.clone();
            if kind == "Socket" {
                continue;
            }
            if kind != "Mastery" {
                for comp in &comps {
                    let (template, replaces) = match comp.ty {
                        1 => (usize::try_from(comp.id - TIMELESS_JEWEL_ADDITIONS).ok().and_then(|i| self.legion_node_json(i)), true),
                        2 => (usize::try_from(comp.id).ok().and_then(|i| self.legion_addition_json(i)), false),
                        _ => (None, false),
                    };
                    let Some(template) = template else { continue }; // "Unhandled Abyss component ID"
                    if replaces {
                        self.replace_node_with_json(node_id, template);
                    }
                    let sd = str_list(template.get("sd").unwrap_or(J::NULL));
                    let stats = template.get("stats").unwrap_or(J::NULL);
                    for (i, line) in sd.iter().enumerate() {
                        let mut line = line.clone();
                        if let Some(obj) = stats.as_object() {
                            for (stat_key, stat_mod) in obj {
                                let idx = stat_mod.get("index").and_then(as_i64).unwrap_or(0);
                                let Some(&roll) = usize::try_from(idx - 1).ok().and_then(|k| comp.rolls.get(k)) else { continue };
                                line = replace_helper(&line, stat_key, stat_mod, roll as f64);
                            }
                        }
                        let s = if replaces { line } else { format!(" \n{line}") };
                        self.node_addition_or_replacement_from_string(node_id, &s, replaces && i == 0);
                    }
                }
            }
            self.reconnect_node_to_class_start(node_id);
        }
    }

    fn is_conquest_attribute_node(&self, node_id: i64, attributes: &[&str]) -> bool {
        let n = &self.nodes[&node_id];
        attributes.contains(&n.dn.as_str()) || n.is_tattoo
    }

    /// Port of the Glorious Vanity (`jewelType == 1`) Notable branch: `headerSize` 2/3 is a single
    /// replacement node with one rolled stat; 6/8 picks "Might of the Vaal" or "Legacy of the
    /// Vaal" by a bias vote and adds one line per distinct addition id (summed rolls).
    fn apply_glorious_vanity_result(&mut self, node_id: i64, lut: &[i64]) {
        let header_size = lut.len();
        match header_size {
            2 | 3 => {
                let Some(idx) = usize::try_from(lut[0] - TIMELESS_JEWEL_ADDITIONS).ok() else { return };
                let Some(legion) = self.legion_node_json(idx) else { return };
                let sd = str_list(legion.get("sd").unwrap_or(J::NULL));
                let sorted_stats = str_list(legion.get("sortedStats").unwrap_or(J::NULL));
                let stats = legion.get("stats").unwrap_or(J::NULL);
                self.replace_node_by_legion_index(node_id, idx);
                for (i, line) in sd.iter().enumerate() {
                    let Some(stat_key) = sorted_stats.get(i) else { continue };
                    let Some(stat_mod) = stats.get(stat_key) else { continue };
                    let stat_index = stat_mod.get("index").and_then(as_i64).unwrap_or(0);
                    let Some(&value) = lut.get(stat_index as usize) else { continue };
                    let replaced = replace_helper(line, stat_key, stat_mod, value as f64);
                    self.node_addition_or_replacement_from_string(node_id, &replaced, i == 0);
                }
            }
            6 | 8 => {
                let half = header_size / 2;
                let mut bias = 0i64;
                for &v in &lut[..half] {
                    if v <= 21 {
                        bias += 1;
                    } else {
                        bias -= 1;
                    }
                }
                // legionNodes[77]/[78] (1-based) = "might of the vaal" / "legacy of the vaal".
                let idx = if bias >= 0 { 76 } else { 77 };
                self.replace_node_by_legion_index(node_id, idx);
                let mut additions: Vec<(i64, i64)> = Vec::new(); // (addition id, summed roll), insertion order
                for i in 0..half {
                    let add_id = lut[i];
                    let roll = lut[half + i];
                    match additions.iter_mut().find(|(a, _)| *a == add_id) {
                        Some((_, r)) => *r += roll,
                        None => additions.push((add_id, roll)),
                    }
                }
                for (add_id, roll) in additions {
                    let Some(addition) = self.legion_addition_json(add_id as usize) else { continue };
                    let sd = str_list(addition.get("sd").unwrap_or(J::NULL));
                    let stats = addition.get("stats").unwrap_or(J::NULL);
                    for line in &sd {
                        let mut replaced = line.clone();
                        if let Some(stats_obj) = stats.as_object() {
                            for (stat_key, stat_mod) in stats_obj {
                                replaced = replace_helper(&replaced, stat_key, stat_mod, roll as f64);
                            }
                        }
                        self.node_addition_or_replacement_from_string(node_id, &replaced, false);
                    }
                }
            }
            _ => {} // "Unhandled Glorious Vanity headerSize": matches upstream's ConPrintf-and-skip.
        }
    }

    // ---- legion template lookups (`tree.legion.nodes`/`tree.legion.additions`) ----

    /// A Legion keystone that's a reskin of a real passive-tree keystone (e.g. Vaal's "Eternal
    /// Youth") is exported as a `$ref` into `tree.keystoneMap` rather than inline (22 of the 381
    /// `legion.nodes` entries in `tree_3_29.json`, including every "_v2" legacy keystone variant:
    /// the data exporter's table-identity dedup replaces the second occurrence of a
    /// shared Lua table with a `$ref` to wherever it first appeared, and the "_v2" keystones are
    /// exactly that: the same effect a real tree keystone already grants, listed a second time
    /// under the Legion id `TreeTab.lua` looks up by name). Every accessor here derefs before use.
    fn legion_node_json(&self, idx0: usize) -> Option<J> {
        let v = self.tree.section("legion")?.get("nodes")?.get(idx0)?;
        Some(self.tree.deref(v))
    }

    fn legion_addition_json(&self, idx0: usize) -> Option<J> {
        let v = self.tree.section("legion")?.get("additions")?.get(idx0)?;
        Some(self.tree.deref(v))
    }

    fn legion_node_index_by_id(&self, id_str: &str) -> Option<usize> {
        let nodes = self.tree.section("legion")?.get("nodes")?.as_array()?;
        nodes.iter().position(|n| self.tree.deref(n).get("id").and_then(|v| v.as_str()) == Some(id_str))
    }

    /// Port of the Legion LUT "add" case (`legionAdditions[add_id + 1]`, Lua 1-based; `add_id`
    /// 0-based here): appends every one of the addition's `sd` lines, each prefixed as the
    /// original does at this call site.
    fn apply_legion_addition(&mut self, node_id: i64, add_id: i64, prefix: &str) {
        let Some(addition) = self.legion_addition_json(add_id as usize) else { return };
        let sd = str_list(addition.get("sd").unwrap_or(J::NULL));
        for line in &sd {
            self.node_addition_or_replacement_from_string(node_id, &format!("{prefix}{line}"), false);
        }
    }

    /// Port of `ReplaceNode` when the replacement source is a `tree.legion.nodes` template: copies
    /// dn/sd/mods/isTattoo/overrideType, preserving the template's own already-sourced mods
    /// (`crate::stats::flatten_node_mods_json`; see that function's doc comment for why this
    /// doesn't reparse `sd` through `process_stats`).
    fn replace_node_by_legion_index(&mut self, node_id: i64, idx0: usize) {
        let Some(legion) = self.legion_node_json(idx0) else { return };
        self.replace_node_with_json(node_id, legion);
    }

    /// Port of `ReplaceNode` for any JSON-shaped template (a `tree.legion.nodes`/`tree.tattoo.nodes`
    /// entry, or a hash-override's copy of one): copies dn/sd/mods/isTattoo/overrideType, preserving
    /// the template's own already-sourced mods (`crate::stats::flatten_node_mods_json`; see that
    /// function's doc comment for why this doesn't reparse `sd` through `process_stats`).
    fn replace_node_with_json(&mut self, node_id: i64, template: J) {
        // A template (a tattoo from the tree's data) is read once per tree; its fields don't depend on the node.
        type Fields = std::rc::Rc<(crate::node::NStr, std::sync::Arc<Vec<String>>, std::sync::Arc<Vec<PMod>>, bool, Option<crate::node::NStr>)>;
        thread_local! {
            static MEMO: std::cell::RefCell<HashMap<(usize, String, String, String, String), Fields>> = std::cell::RefCell::new(HashMap::default());
        }
        let text = |k: &str| template.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let key = (self.tree as *const TreeData as usize, text("dn"), text("icon"), text("activeEffectImage"), text("overrideType"));
        let fields = match MEMO.with(|m| m.borrow().get(&key).cloned()) {
            Some(f) => f,
            None => {
                let f: Fields = std::rc::Rc::new((
                    template.get("dn").and_then(|v| v.as_str()).unwrap_or("").into(),
                    std::sync::Arc::new(str_list(template.get("sd").unwrap_or(J::NULL))),
                    std::sync::Arc::new(crate::stats::flatten_node_mods_json(template.get("mods").unwrap_or(J::NULL))),
                    as_bool(template.get("isTattoo").unwrap_or(J::NULL)),
                    template.get("overrideType").and_then(|v| v.as_str()).map(|s| s.into()),
                ));
                MEMO.with(|m| m.borrow_mut().insert(key, f.clone()));
                f
            }
        };
        let Some(n) = crate::node::node_mut(&mut self.nodes, &node_id) else { return };
        n.dirty = true;
        n.dn = fields.0.clone();
        n.sd = fields.1.clone();
        n.mods = fields.2.clone();
        n.is_tattoo = fields.3;
        n.override_type = fields.4.clone();
    }

    /// Port of `NodeAdditionOrReplacementFromString`, restricted to how conquered-node replacement
    /// calls it: a single (possibly `\n`-separated) `sd` string, sourced as `Tree:<node_id>` same
    /// as any other mod on this node (`crate::stats::process_stats` already does exactly this
    /// parse-and-source pass). `replacement` true overwrites `sd`/`mods`; false appends.
    fn node_addition_or_replacement_from_string(&mut self, node_id: i64, sd_line: &str, replacement: bool) {
        let lines: Vec<String> = sd_line.split('\n').map(|s| s.to_string()).filter(|s| !s.is_empty()).collect();
        let mut mods = process_stats(&[sd_line.to_string()], node_id);
        let Some(n) = crate::node::node_mut(&mut self.nodes, &node_id) else { return };
        n.dirty = true;
        if replacement {
            n.sd = std::sync::Arc::new(lines);
            n.mods = std::sync::Arc::new(mods);
        } else {
            // `node.sd` concatenates existing-then-new (`tableConcat(node.sd, addition.sd)`), but
            // the graded field is `node.modList`, which upstream builds addition-first:
            // `modList:AddList(addition.modList); modList:AddList(node.modList)`. Mirror that
            // order here even though it disagrees with `sd`'s.
            std::sync::Arc::make_mut(&mut n.sd).extend(lines);
            mods.extend(n.mods.iter().cloned());
            n.mods = std::sync::Arc::new(mods);
        }
    }

    /// Port of `ReconnectNodeToClassStart`.
    fn reconnect_node_to_class_start(&mut self, node_id: i64) {
        let (kind, linked) = {
            let Some(n) = self.nodes.get(&node_id) else { return };
            (n.kind.clone(), n.linked_ids.clone())
        };
        if kind != "Normal" {
            return;
        }
        let mut new_mods = Vec::new();
        for &linked_id in linked.iter() {
            for class in self.classes.values() {
                if linked_id == class.start_node_id {
                    new_mods.push(PMod {
                        name: format!("Condition:ConnectedTo{}Start", class.name),
                        ty: "FLAG".to_string(),
                        value: PVal::Bool(true),
                        flags: 0,
                        keyword_flags: 0,
                        source: Some(format!("Tree:{linked_id}")),
                        tags: Vec::new(),
                        unreachable_tags: Vec::new(),
                    });
                }
            }
        }
        if let Some(n) = crate::node::node_mut(&mut self.nodes, &node_id) {
            n.dirty = true;
            std::sync::Arc::make_mut(&mut n.mods).extend(new_mods);
        }
    }

    /// Port of `SetNodeDistanceToClassStart`.
    fn set_node_distance_to_class_start(&mut self, root_id: i64) {
        let Some(root) = self.nodes.get(&root_id) else { return };
        if !root.alloc || !root.connected_to_start {
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &root_id) {
                n.distance_to_class_start = 0;
            }
            return;
        }
        if self.classes.get(&self.cur_class_id).is_none() {
            return;
        }
        let result = self.distance_search(root_id);
        if let Some(n) = crate::node::node_mut(&mut self.nodes, &root_id) {
            n.distance_to_class_start = result;
        }
    }

    /// Steps from `root_id` to the class start over allocated nodes (not through a mastery or a start node).
    fn distance_search(&self, root_id: i64) -> i64 {
        let Some(target_id) = self.classes.get(&self.cur_class_id).map(|c| c.start_node_id) else { return 0 };
        let mut dist_to_root: HashMap<i64, i64> = HashMap::default();
        dist_to_root.insert(root_id, 0);
        let mut queue: VecDeque<i64> = VecDeque::new();
        queue.push_back(root_id);
        let mut result = 0;
        'outer: while let Some(id) = queue.pop_front() {
            let cur_dist = dist_to_root[&id] + 1;
            let (linked, node_type) = {
                let n = &self.nodes[&id];
                (n.linked_ids.clone(), n.kind.clone())
            };
            for other_id in linked.iter().copied() {
                if other_id == target_id {
                    result = cur_dist - 1;
                    break 'outer;
                }
                let Some(other) = self.nodes.get(&other_id) else { continue };
                if other.alloc && node_type != "Mastery" && other.kind != "ClassStart" && other.kind != "AscendClassStart" && !dist_to_root.contains_key(&other_id) {
                    dist_to_root.insert(other_id, cur_dist);
                    queue.push_back(other_id);
                }
            }
        }
        result
    }

    // ---- cluster jewels ----

    /// Port of `BuildClusterJewelGraphs`, current (non-legacy) hash format only: scans the base
    /// tree's Large jewel sockets for an allocated, valid cluster jewel and recursively expands
    /// each one's subgraph. Call once after allocation, before the final
    /// `build_all_depends_and_paths` (matching `PostLoad`'s `self:BuildClusterJewelGraphs()`,
    /// which itself calls `BuildAllDependsAndPaths` again at the end).
    pub fn build_cluster_jewel_graphs(&mut self, cj_data: &ClusterJewelData) {
        let debug = pom_engine::env::var("PASSIVE_SPEC_DEBUG").is_ok();
        // Whether this changes the spec at all: a subgraph built, a legacy remap applied or a subgraph node allocated.
        let mut changed = false;
        let Some(sockets) = self.tree.section("sockets").and_then(|v| v.as_object()) else { return };
        let large_socket_ids: Vec<i64> = sockets.keys().filter_map(|k| k.parse::<i64>().ok()).collect();
        for socket_id in large_socket_ids {
            let is_candidate = self
                .nodes
                .get(&socket_id)
                .map(|n| n.alloc && n.expansion_jewel.as_ref().map(|ej| ej.size == 2).unwrap_or(false))
                .unwrap_or(false);
            if debug && self.cluster_jewel_inputs.contains_key(&socket_id) {
                eprintln!(
                    "candidate socket={socket_id} alloc={:?} ej={:?} in_nodes={} jewel_valid={:?}",
                    self.nodes.get(&socket_id).map(|n| n.alloc),
                    self.nodes.get(&socket_id).and_then(|n| n.expansion_jewel.clone()),
                    self.nodes.contains_key(&socket_id),
                    self.cluster_jewel_inputs.get(&socket_id).map(|j| j.cluster_jewel_valid)
                );
            }
            if !is_candidate {
                continue;
            }
            changed |= self.expand_socket(cj_data, socket_id, None);
        }

        // `ApplyLegacyClusterNodeRemap` runs *before* `allocSubgraphNodes` is applied below: its
        // main job for this crate's corpus is translating a legacy socket id sitting in that
        // pending list (queued by `import_from_node_list` because the legacy id, excluded from
        // `self.nodes` at `Init` by its own `expansionJewel.parent`, never resolved to a node)
        // onto the current-format id that actually got generated.
        if self.needs_legacy_cluster_conversion {
            changed |= !self.legacy_cluster_node_map.is_empty();
            self.apply_legacy_cluster_node_remap();
        }

        // (Re-)allocate subgraph nodes: matches `self.allocSubgraphNodes` being applied after
        // every socket in the base tree has had its subgraph (re)built.
        let pending = std::mem::take(&mut self.pending_subgraph_alloc);
        for id in pending {
            if self.nodes.contains_key(&id) {
                self.alloc_insert(id);
                changed = true;
            }
        }
        // When nothing changed here or since the last pass began (a spec loaded from a URL allocates its nodes after it;
        // a pass that pruned leaves stale depends on the pruned nodes), this pass would run on exactly the state the
        // last one left, and
        // that state is its own fixed point: dirty nodes are reset and replaced the same way, every node still
        // allocated is connected (the earlier pass pruned the rest), and depends, counts and conquests are rebuilt
        // from the same allocation. A stats-only run (`SKIP_PATHS`) skips it. POM_CHECK_BAD5=1 runs it anyway and
        // reports any spec it would have changed.
        if !changed && !self.alloc_changed && !self.node_list_depends_deferred && SKIP_PATHS.with(|c| c.get()) {
            if pom_engine::env::var_os("POM_CHECK_BAD5").is_some() {
                let before = self.state_parts();
                self.build_all_depends_and_paths();
                let after = self.state_parts();
                if after != before {
                    let diff: Vec<String> = before.iter().zip(after.iter()).filter(|(a, b)| a != b).take(3).map(|(a, b)| format!("{a} => {b}")).collect();
                    eprintln!("BAD5 CHANGED {} {:?}", pom_engine::env::var("POM_BUILD_NAME").unwrap_or_default(), diff);
                }
            }
            return;
        }
        self.build_all_depends_and_paths();
    }

    pub(crate) fn state_parts(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut ids: Vec<i64> = self.nodes.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let n = &self.nodes[&id];
            out.push(format!("{id} alloc={} dep={:?} conn={} vis={} dist={} il={:?}", n.alloc, n.depends, n.connected_to_start, n.visited, n.distance_to_class_start, n.intuitive_leap_likes_affecting));
            out.push(format!("{id} dn={} sd={:?} tat={} ov={:?} dirty={} pd={} path={:?} conq={:?}", n.dn, n.sd, n.is_tattoo, n.override_type, n.dirty, n.path_dist, n.path, n.conquered_by.as_ref().map(|c| c.id)));
            out.push(format!("{id} mods={:?}", n.mods));
        }
        out.push(format!("order {:?}", self.alloc_order.iterate()));
        out.push(format!("counts {} {} {}", self.allocated_mastery_count, self.allocated_notable_count, self.allocated_keystone_count));
        out
    }

    /// A hash of everything `build_all_depends_and_paths` sets, for checking that a skipped pass changes nothing.
    #[allow(dead_code)]
    fn state_digest(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let mut ids: Vec<i64> = self.nodes.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let n = &self.nodes[&id];
            (id, n.alloc, &n.depends, n.connected_to_start, n.visited, n.distance_to_class_start, &n.intuitive_leap_likes_affecting).hash(&mut h);
            (n.dn.as_str(), &*n.sd, n.is_tattoo, n.override_type.as_deref(), n.dirty, n.path_dist, &n.path).hash(&mut h);
            format!("{:?}", n.mods).hash(&mut h);
            n.conquered_by.as_ref().map(|c| (c.id.to_bits(), c.conqueror_type.clone())).hash(&mut h);
        }
        self.alloc_order.iterate().hash(&mut h);
        let mut ms: Vec<(i64, i64)> = self.mastery_selections.iter().map(|(&k, &v)| (k, v)).collect();
        ms.sort_unstable();
        ms.hash(&mut h);
        (self.allocated_mastery_count, self.allocated_notable_count, self.allocated_keystone_count).hash(&mut h);
        h.finish()
    }

    /// Port of `ApplyLegacyClusterNodeRemap`: once every socket has its subgraph (rebuilt against
    /// the *current* node-id layout), move the player's saved allocation, and jewel ownership,
    /// off any pre-migration ("legacy") id `build_subgraph` recorded in
    /// `self.legacy_cluster_node_map` onto that socket's current id. A no-op when this build
    /// isn't a legacy-format save (`self.legacy_cluster_node_map` is always empty then, since
    /// `build_subgraph` only populates it under `needs_legacy_cluster_conversion`).
    fn apply_legacy_cluster_node_remap(&mut self) {
        if self.legacy_cluster_node_map.is_empty() {
            return;
        }
        // `self.legacyClusterNodeMap[legacyNodeId] = currentNodeId`: a plain map, last write per
        // legacy id wins (vanishingly unlikely to matter here; two subgraphs would have to
        // resolve the very same legacy id).
        let mut map: HashMap<i64, i64> = HashMap::default();
        for (legacy_id, current_id) in std::mem::take(&mut self.legacy_cluster_node_map) {
            map.insert(legacy_id, current_id);
        }
        // Translate `self.allocSubgraphNodes` (this port's `pending_subgraph_alloc`) through the
        // map first (`GetMappedClusterNodeId`), deduplicating while preserving order exactly like
        // upstream's `convertedNodeIds`/`seenNodeIds`: a legacy id that never resolved to a
        // real node (excluded from `self.nodes` at `Init` by its own `expansionJewel.parent`)
        // only ever reaches allocation through this list, not through `self.allocNodes` below.
        let mut seen_pending: HashSet<i64> = HashSet::default();
        let mut converted_pending: Vec<i64> = Vec::new();
        for id in std::mem::take(&mut self.pending_subgraph_alloc) {
            let mapped = map.get(&id).copied().filter(|m| self.nodes.contains_key(m)).unwrap_or(id);
            if seen_pending.insert(mapped) {
                converted_pending.push(mapped);
            }
        }
        self.pending_subgraph_alloc = converted_pending;
        let debug = pom_engine::env::var("PASSIVE_SPEC_DEBUG").is_ok();
        for (&legacy_id, &current_id) in &map {
            let legacy_alloc = self.nodes.get(&legacy_id).map(|n| n.alloc).unwrap_or(false);
            let current_exists = self.nodes.contains_key(&current_id);
            if debug {
                eprintln!("apply_legacy_cluster_node_remap: legacy={legacy_id} current={current_id} legacy_alloc={legacy_alloc} current_exists={current_exists}");
            }
            if legacy_id != current_id && legacy_alloc && current_exists {
                self.alloc_remove(legacy_id);
                self.alloc_insert(current_id);
            }
        }
        // `GetMappedClusterNodeId`: remap unconditionally, but only when the mapped-to node
        // actually exists; otherwise a jewel stays on its original (unmapped) socket id.
        // `for nodeId, itemId in pairs(self.jewels) do convertedJewels[mapped(nodeId)] = itemId end`:
        // when two keys land on the same target the later one in LuaJIT's traversal order wins,
        // and `convertedJewels` is a fresh table built in that order.
        let order = self.jewel_keys_in_pairs_order();
        let old_jewels = std::mem::take(&mut self.jewels);
        self.jewels_lj = LjHash::new();
        for node_id in order {
            let item_id = old_jewels[&node_id];
            let mapped = map.get(&node_id).copied().filter(|m| self.nodes.contains_key(m)).unwrap_or(node_id);
            self.set_jewel(mapped, item_id);
        }
    }

    /// Expands one socket's jewel (if it has a valid one recorded) and recurses into any Socket
    /// node the new subgraph itself generates, mirroring `BuildSubgraph`'s own recursive call at
    /// its end (`if node.type == "Socket" then ... self:BuildSubgraph(jewel, node, id, ...)`).
    /// Returns whether it changed the spec (it returns early, changing nothing, unless the socket holds a valid
    /// cluster jewel that yields a subgraph).
    fn expand_socket(&mut self, cj_data: &ClusterJewelData, socket_id: i64, id_base: Option<i64>) -> bool {
        let debug = pom_engine::env::var("PASSIVE_SPEC_DEBUG").is_ok();
        let Some(jewel) = self.cluster_jewel_inputs.get(&socket_id).cloned() else {
            if debug {
                eprintln!("expand_socket({socket_id}): no jewel input");
            }
            return false;
        };
        if !jewel.cluster_jewel_valid {
            if debug {
                eprintln!("expand_socket({socket_id}): jewel not valid");
            }
            return false;
        }
        let Some(ej) = self.nodes.get(&socket_id).and_then(|n| n.expansion_jewel.clone()) else {
            if debug {
                eprintln!("expand_socket({socket_id}): node missing or has no expansion_jewel");
            }
            return false;
        };
        // A subgraph and its nodes' parsed mods follow from the tree, the socket and the jewel alone, so they are
        // built once per distinct input and replayed (the spec is rebuilt on every click).
        type Built = std::rc::Rc<Option<(crate::clusterjewel::SubGraph, Vec<Node>)>>;
        thread_local! {
            static MEMO: std::cell::RefCell<HashMap<String, Built>> = std::cell::RefCell::new(HashMap::default());
        }
        let key = format!("{:x} {socket_id} {} {} {} {id_base:?} {} {jewel:?}", self.tree as *const TreeData as usize, ej.index, ej.size, ej.proxy, self.needs_legacy_cluster_conversion);
        let built: Built = match MEMO.with(|m| m.borrow().get(&key).cloned()) {
            Some(b) => b,
            None => {
                let subgraph = build_subgraph(self.tree, cj_data, &jewel, socket_id, ej.index, ej.size, ej.proxy, id_base, self.needs_legacy_cluster_conversion);
                let b = std::rc::Rc::new(subgraph.map(|subgraph| {
                    let nodes = subgraph
                        .nodes
                        .iter()
                        .map(|gn| {
                            let expansion_jewel = gn.expansion_jewel.map(|ej| crate::node::ExpansionJewel { index: ej.index, size: ej.size, proxy: ej.proxy, parent: None });
                            let mut node = Node::new_generated(gn.id, gn.kind.clone(), gn.dn.clone(), gn.sd.clone(), gn.o, gn.oidx, gn.is_jewel_socket, expansion_jewel);
                            node.mods = std::sync::Arc::new(process_stats(&node.sd, node.id));
                            // `clusterJewelIncEffect`'s `PassiveSkillEffect` INC (`modList:NewMod(...)`, appended
                            // after `ProcessNode`'s own sd-parsed mods, not part of `sd` text itself).
                            std::sync::Arc::make_mut(&mut node.mods).extend(gn.extra_mods.iter().cloned());
                            node
                        })
                        .collect();
                    (subgraph, nodes)
                }));
                MEMO.with(|m| {
                    let mut m = m.borrow_mut();
                    if m.len() >= 2_000 {
                        m.clear();
                    }
                    m.insert(key, b.clone());
                });
                b
            }
        };
        if debug {
            eprintln!("expand_socket({socket_id}): needs_legacy={} ej={ej:?} jewel_size={} jewel_size_idx={} subgraph_nodes={:?} legacy_map={:?}", self.needs_legacy_cluster_conversion, jewel.size, jewel.size_index, built.as_ref().as_ref().map(|s| s.0.nodes.iter().map(|n| (n.id, n.kind.clone())).collect::<Vec<_>>()), built.as_ref().as_ref().map(|s| s.0.legacy_node_map.clone()));
        }
        let Some((subgraph, nodes)) = built.as_ref() else { return false };
        self.legacy_cluster_node_map.extend(subgraph.legacy_node_map.iter().copied());

        let proxy_group = self.tree.node(ej.proxy).and_then(|n| n.get("g").and_then(as_i64));
        let mut generated_socket_ids = Vec::new();
        for node in nodes {
            if let Some(g) = proxy_group {
                self.generated_group.insert(node.id, g);
            }
            if node.kind == "Socket" {
                generated_socket_ids.push(node.id);
            }
            self.nodes.insert(node.id, node.clone());
            self.generated_node_ids.insert(node.id);
        }
        for &(a, b) in &subgraph.connectors {
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &a) {
                std::sync::Arc::make_mut(&mut n.linked_ids).push(b);
            }
            if let Some(n) = crate::node::node_mut(&mut self.nodes, &b) {
                std::sync::Arc::make_mut(&mut n.linked_ids).push(a);
            }
        }
        // Allocation is applied once, after every socket's subgraph exists, by
        // `build_cluster_jewel_graphs` draining `pending_subgraph_alloc` -- not here. An import queues the nodes its
        // `hashes_ex` names first (`addToAllocatedSubgraphNodes`), so a socket among them is expanded below.
        if let Some(imp) = self.import_clusters.clone() {
            for node in nodes {
                if self.pending_subgraph_alloc.contains(&node.id) {
                    continue;
                }
                if let Some(h) = imp.matches(ej.proxy, node.kind.as_str(), node.oidx) {
                    self.pending_subgraph_alloc.push(node.id);
                    imp.matched.borrow_mut().push(h);
                }
            }
        }
        for sid in generated_socket_ids {
            if self.pending_subgraph_alloc.contains(&sid) && self.cluster_jewel_inputs.get(&sid).map(|j| j.cluster_jewel_valid).unwrap_or(false) {
                self.expand_socket(cj_data, sid, Some(subgraph.id));
            }
        }
        true
    }

    // ---- URL encode/decode ----

    /// Port of `EncodeURL`.
    pub fn encode_url(&self, prefix: &str) -> String {
        let mut a: Vec<u8> = vec![0, 0, 0, 6, self.cur_class_id as u8, (((self.cur_secondary_ascend_class_id as u32) << 2) | self.cur_ascend_class_id as u32) as u8];
        let mut node_count = 0u32;
        let mut cluster_count = 0u32;
        let mut mastery_count = 0u32;
        let mut cluster_ids: Vec<u8> = Vec::new();
        let mut mastery_ids: Vec<u8> = Vec::new();
        // `for id, node in pairs(self.allocNodes) do` order, not numeric order: the recorded
        // answer's byte layout depends on it.
        let alloc_ids: Vec<i64> = self.alloc_order.iterate();
        for id in alloc_ids {
            let node = &self.nodes[&id];
            if node.kind != "ClassStart" && node.kind != "AscendClassStart" && id < 65536 && node_count < 255 {
                a.push((id / 256) as u8);
                a.push((id % 256) as u8);
                node_count += 1;
                if let Some(&effect_id) = self.mastery_selections.get(&id) {
                    mastery_ids.push((effect_id / 256) as u8);
                    mastery_ids.push((effect_id % 256) as u8);
                    mastery_ids.push((id / 256) as u8);
                    mastery_ids.push((id % 256) as u8);
                    mastery_count += 1;
                }
            } else if id >= 65536 {
                let cluster_id = id - 65536;
                cluster_ids.push((cluster_id / 256) as u8);
                cluster_ids.push((cluster_id % 256) as u8);
                cluster_count += 1;
            }
        }
        a.insert(6, node_count as u8);
        a.push(cluster_count as u8);
        a.extend(cluster_ids);
        a.push(mastery_count as u8);
        a.extend(mastery_ids);

        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&a);
        format!("{}{}", prefix, encoded.replace('+', "-").replace('/', "_"))
    }

    /// Port of `AllocateDecodedNodes`.
    fn allocate_decoded_nodes(&mut self, bytes: &[u8], is_cluster: bool, big_endian: bool) {
        let mut i = 0;
        while i + 1 < bytes.len() {
            let id = if big_endian {
                bytes[i] as i64 * 256 + bytes[i + 1] as i64
            } else {
                bytes[i] as i64 + bytes[i + 1] as i64 * 256
            };
            let id = if is_cluster { id + 65536 } else { id };
            if self.nodes.contains_key(&id) {
                self.alloc_insert(id);
            }
            i += 2;
        }
    }

    /// Port of `AllocateMasteryEffects`, GGG big-endian tree-URL variant only: unlike the
    /// poeplanner ("little") branch, this one never allocates the mastery node itself — the
    /// original's `self.allocNodes[id].sd = ...` assumes `AllocateDecodedNodes` already put it
    /// there via the main node list, and errors otherwise. `build_all_depends_and_paths` (called
    /// once after every `AllocateDecodedNodes`/`AllocateMasteryEffects` call in `decode_url`)
    /// applies the selection's sd/mods, so this only needs to record the selection, and dealloc
    /// when the effect no longer exists on this tree (matching upstream's `self.allocNodes[id]
    /// = nil`).
    fn allocate_mastery_effects(&mut self, bytes: &[u8]) {
        let mut i = 0;
        while i + 3 < bytes.len() {
            let effect_id = bytes[i] as i64 * 256 + bytes[i + 1] as i64;
            let id = bytes[i + 2] as i64 * 256 + bytes[i + 3] as i64;
            if self.mastery_effect_sd.contains_key(&effect_id) {
                self.mastery_selections.insert(id, effect_id);
            } else {
                self.alloc_remove(id);
            }
            i += 4;
        }
    }

    /// Port of `DecodeURL` (the GGG official-site tree URL format; poeplanner links are out of
    /// scope for this pass).
    pub fn decode_url(&mut self, url: &str) -> Result<(), String> {
        use base64::Engine;
        let tail = url.rsplit('/').next().unwrap_or(url);
        let b64 = tail.replace('-', "+").replace('_', "/");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("bad base64: {e}"))?;
        if bytes.len() < 6 {
            return Err("Invalid tree link (unrecognised format)".to_string());
        }
        let ver = (bytes[0] as u32) << 24 | (bytes[1] as u32) << 16 | (bytes[2] as u32) << 8 | bytes[3] as u32;
        if ver > 6 {
            return Err(format!("Invalid tree link (unknown version number '{ver}')"));
        }
        let class_id = bytes[4] as i64;
        let ascendancy_ids = if ver >= 4 { bytes[5] } else { 0 };
        let ascend_class_id = (ascendancy_ids & 3) as i64;
        let secondary_ascend_class_id = ((ascendancy_ids & 12) >> 2) as i64;
        if !self.classes.contains_key(&class_id) {
            return Err(format!("Invalid tree link (bad class ID '{class_id}')"));
        }
        self.reset_nodes();
        self.select_class(class_id);
        self.select_ascend_class(ascend_class_id);
        self.select_secondary_ascend_class(secondary_ascend_class_id);

        let nodes_start: usize = if ver >= 4 { 7 } else { 6 };
        let node_count = if ver >= 5 { bytes.get(6).copied().unwrap_or(0) as usize } else { 0 };
        // Lua: nodesEnd = 7 + b:byte(7)*2 (1-based index, inclusive of the last node byte). A
        // Rust exclusive slice bound at position N covers the same bytes as a Lua inclusive index
        // N (Rust start = Lua start - 1, but Rust end stays numerically equal to Lua's end), so
        // this keeps the literal "7" from upstream rather than the 0-based "6".
        let nodes_end: usize = if ver >= 5 { 7 + node_count * 2 } else { bytes.len() };
        let node_bytes = bytes.get(nodes_start..nodes_end.min(bytes.len())).unwrap_or(&[]);
        self.allocate_decoded_nodes(node_bytes, false, true);
        if ver < 5 {
            return Ok(());
        }

        let cluster_start = nodes_end;
        let cluster_count = bytes.get(cluster_start).copied().unwrap_or(0) as usize;
        let cluster_end = cluster_start + 1 + cluster_count * 2;
        let cluster_bytes = bytes.get(cluster_start + 1..cluster_end.min(bytes.len())).unwrap_or(&[]);
        self.allocate_decoded_nodes(cluster_bytes, true, true);
        if ver < 6 {
            return Ok(());
        }

        let mastery_start = cluster_end;
        let mastery_count = bytes.get(mastery_start).copied().unwrap_or(0) as usize;
        let mastery_end = mastery_start + 1 + mastery_count * 4;
        let mastery_bytes = bytes.get(mastery_start + 1..mastery_end.min(bytes.len())).unwrap_or(&[]);
        self.allocate_mastery_effects(mastery_bytes);
        // Upstream's DecodeURL does not call BuildAllDependsAndPaths at its end; the caller's
        // PostLoad -> BuildClusterJewelGraphs does exactly once (see lib.rs).
        Ok(())
    }
}

pub fn i64_from_json(v: J) -> Option<i64> {
    as_i64(v)
}
pub fn i64_list_from_json(v: J) -> Vec<i64> {
    i64_list(v)
}

/// The allocated nodes of a spec as dense arrays, for `FindStartFromNode` (the per-node start search of
/// `build_all_depends_and_paths`): `adj` keeps each node's links in order, minus links to nodes that are missing
/// or not allocated when the pass starts (the search skips those anyway).
struct AllocGraph {
    index: std::collections::HashMap<i64, u32, std::hash::BuildHasherDefault<crate::node::IdHasher>>,
    ids: Vec<i64>,
    adj: Vec<Vec<(i64, u32)>>,
    is_start: Vec<bool>,
    is_ascend_start: Vec<bool>,
    is_mastery: Vec<bool>,
    has_asc: Vec<bool>,
    alloc: Vec<bool>,
    visited: Vec<bool>,
}

impl AllocGraph {
    fn new(nodes: &crate::node::NodeMap, alloc_ids: &[i64]) -> AllocGraph {
        let ids: Vec<i64> = alloc_ids.iter().copied().filter(|id| nodes.get(id).is_some_and(|n| n.alloc)).collect();
        let pinned: Vec<i64> = PIN_ALLOC.with(|p| p.borrow().clone());
        let index: std::collections::HashMap<i64, u32, std::hash::BuildHasherDefault<crate::node::IdHasher>> = ids.iter().enumerate().map(|(i, &id)| (id, i as u32)).collect();
        let n = ids.len();
        let mut g = AllocGraph { index, ids, adj: Vec::with_capacity(n), is_start: Vec::with_capacity(n), is_ascend_start: Vec::with_capacity(n), is_mastery: Vec::with_capacity(n), has_asc: Vec::with_capacity(n), alloc: vec![true; n], visited: vec![false; n] };
        for k in 0..n {
            let node = &nodes[&g.ids[k]];
            let adj: Vec<(i64, u32)> = node.linked_ids.iter().filter_map(|l| g.index.get(l).map(|&i| (*l, i))).collect();
            g.adj.push(adj);
            g.is_ascend_start.push(node.kind == "AscendClassStart");
            g.is_start.push(node.kind == "ClassStart" || node.kind == "AscendClassStart" || pinned.contains(&g.ids[k]));
            g.is_mastery.push(node.kind == "Mastery");
            g.has_asc.push(node.ascendancy_name.is_some());
        }
        g
    }

    /// Port of `FindStartFromNode`: whether a class or ascendancy start can be reached from `node` through
    /// allocated nodes not yet visited, adding every node it visits to `visited`.
    fn find_start(&mut self, node: u32, visited: &mut Vec<u32>, no_ascend: bool) -> bool {
        let n = node as usize;
        self.visited[n] = true;
        visited.push(node);
        let (node_has_ascendancy, node_is_mastery) = (self.has_asc[n], self.is_mastery[n]);
        for k in 0..self.adj[n].len() {
            let o = self.adj[n][k].1 as usize;
            let start_index = if node_has_ascendancy { Some(visited.len()) } else { None };
            if !self.alloc[o] {
                continue;
            }
            let found = if self.is_start[o] {
                true
            } else if !self.visited[o] && !node_is_mastery {
                self.find_start(o as u32, visited, no_ascend)
            } else {
                false
            };
            if found {
                if node_has_ascendancy && !self.has_asc[o] {
                    if let Some(si) = start_index {
                        for v in visited.split_off(si) {
                            self.visited[v as usize] = false;
                        }
                    }
                } else if !no_ascend || !self.is_ascend_start[o] {
                    return true;
                }
            }
        }
        false
    }
}

/// `process_stats(sd, id)` of a chosen mastery effect or a tattoo, shared between calculations: the same node and lines
/// always give the same mods. A fresh list per calculation also gave the pipeline's per-list conversion cache (keyed by
/// the list's address) a new entry every time, so a run of calculations on one thread kept tens of thousands of copies.
/// A later change to a node's lists (`Arc::make_mut`) copies, so the kept lists never change.
type SharedStats = (std::sync::Arc<Vec<String>>, std::sync::Arc<Vec<PMod>>);
fn shared_stats(id: i64, sd: Vec<String>) -> SharedStats {
    thread_local! {
        static MEMO: std::cell::RefCell<HashMap<(i64, Vec<String>), SharedStats>> = std::cell::RefCell::new(HashMap::default());
    }
    let key = (id, sd);
    if let Some(v) = MEMO.with(|m| m.borrow().get(&key).cloned()) {
        return v;
    }
    let v = (std::sync::Arc::new(key.1.clone()), std::sync::Arc::new(process_stats(&key.1, id)));
    MEMO.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= 20_000 {
            m.clear();
        }
        m.insert(key, v.clone());
    });
    v
}
