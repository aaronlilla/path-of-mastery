//! Find a Timeless Jewel: upstream's `TreeTab:FindTimelessJewel` search (`searchSingleSocket`, `formatResults` and
//! the Search button), the jewel socket list and the node list the dialog offers. The seed tables come from
//! `pom_passives::timelessjewel` (`readLUT`), read through `NodeLut` so a full search is one pass over the seeds.
//!
//! Upstream sums weights in the iteration order of Lua tables (`pairs(targetNodes)`, `pairs(resultNodes)`) and sorts
//! with LuaJIT's unstable `table.sort`; both are reproduced (`pom_passives::ljhash`, `lua_sort`) so that the seeds,
//! their order and the floating point totals match. The order upstream walks a socket's radius in is recorded in
//! `data/timeless_radius_order.json`; a tree version without a record walks the radius in node id order.
//!
//! Not ported: the Abyss jewels (types 7-11) and building the trade URL.

use crate::lua_sort::lua_table_sort;
use crate::treeclick::TreePaths;
use pom_engine::cjson::J;
use pom_engine::fxhash::{HashMap, HashSet};
use pom_passives::ljhash::LjHash;
use pom_passives::timelessjewel::{seed_bounds, NodeLut, TimelessJewelData};
use pom_passives::treedata::{as_i64, str_list, TreeData};
use serde_json::{json, Value};
use std::rc::Rc;

/// `data.timelessJewelAdditions`: legion ids at or above this replace the node, below add to it.
const ADDITIONS: i64 = 337;

const IGNORED_MODS: [&str; 9] = ["Might of the Vaal", "Legacy of the Vaal", "Strength", "Add Strength", "Dex", "Add Dexterity", "Devotion", "Price of Glory", "Ward"];

/// `jewelTypes`: label, name (the id prefix), id.
pub const JEWEL_TYPES: [(&str, &str, i64); 11] = [
    ("Glorious Vanity", "vaal", 1),
    ("Lethal Pride", "karui", 2),
    ("Brutal Restraint", "maraketh", 3),
    ("Militant Faith", "templar", 4),
    ("Elegant Hubris", "eternal", 5),
    ("Heroic Tragedy", "kalguur", 6),
    ("Festering Vengeance", "abyss_murderous", 7),
    ("Extinguishing Grasp", "abyss_searching", 8),
    ("Baleful Dominion", "abyss_hypnotic", 9),
    ("Destructive Aspiration", "abyss_ghastly", 10),
    ("Reclaimed Malevolence", "abyss_special", 11),
];

/// Jewel types the search supports.
pub fn supported(jewel_type: i64) -> bool {
    (1..=11).contains(&jewel_type)
}

fn type_name(jewel_type: i64) -> &'static str {
    JEWEL_TYPES.iter().find(|t| t.2 == jewel_type).map(|t| t.1).unwrap_or("")
}

fn total_mod_name(jewel_type: i64) -> Option<&'static str> {
    match jewel_type {
        2 => Some("Strength"),
        3 => Some("Dexterity"),
        4 => Some("Devotion"),
        _ => None,
    }
}

fn total_ids(total: &str) -> &'static [&'static str] {
    match total {
        "total_strength" => &["karui_notable_add_strength", "karui_attribute_strength", "karui_small_strength"],
        "total_dexterity" => &["maraketh_notable_add_dexterity", "maraketh_attribute_dex", "maraketh_small_dex"],
        "total_devotion" => &["templar_notable_devotion", "templar_devotion_node", "templar_small_devotion"],
        _ => &[],
    }
}

fn is_reverse_total(id: &str) -> bool {
    matches!(
        id,
        "karui_notable_add_strength" | "karui_attribute_strength" | "karui_small_strength" | "maraketh_notable_add_dexterity" | "maraketh_attribute_dex" | "maraketh_small_dex" | "templar_notable_devotion" | "templar_devotion_node" | "templar_small_devotion"
    )
}

// ---- tree data ----

/// A `tree.legion.nodes` / `tree.legion.additions` entry.
pub struct LNode {
    pub id: String,
    pub dn: String,
    pub sd: Vec<String>,
    pub sorted_stats: Vec<String>,
    /// `stats[sortedStats[i]].index`.
    pub stat_index: Vec<i64>,
    /// `stats[sortedStats[i]]`: lowest, highest and `fmt` (`d` or `g`).
    pub stat_defs: Vec<(f64, f64, String)>,
    pub not: bool,
    pub ks: bool,
}

pub struct Legion {
    pub nodes: Vec<LNode>,
    pub additions: Vec<LNode>,
}

fn read_lnode(tree: &TreeData, v: J) -> LNode {
    let v = tree.deref(v);
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let sorted_stats = str_list(v.get("sortedStats").unwrap_or(J::NULL));
    let stats = v.get("stats");
    let stat_index = sorted_stats.iter().map(|k| stats.and_then(|s| s.get(k.as_str())).and_then(|s| s.get("index")).and_then(as_i64).unwrap_or(0)).collect();
    let stat_defs = sorted_stats
        .iter()
        .map(|k| {
            let d = stats.and_then(|s| s.get(k.as_str()));
            (d.and_then(|d| d.get("min")).and_then(|x| x.as_f64()).unwrap_or(0.0), d.and_then(|d| d.get("max")).and_then(|x| x.as_f64()).unwrap_or(0.0), d.and_then(|d| d.get("fmt")).and_then(|x| x.as_str()).unwrap_or("d").to_string())
        })
        .collect();
    LNode {
        id: text("id"),
        dn: text("dn"),
        sd: str_list(v.get("sd").unwrap_or(J::NULL)),
        sorted_stats,
        stat_index,
        stat_defs,
        not: v.get("not").and_then(|x| x.as_bool()).unwrap_or(false),
        ks: v.get("ks").and_then(|x| x.as_bool()).unwrap_or(false),
    }
}

fn legion_of(tree: &'static TreeData) -> Rc<Legion> {
    thread_local! {
        static CACHE: std::cell::RefCell<HashMap<usize, Rc<Legion>>> = std::cell::RefCell::new(HashMap::default());
    }
    let key = tree as *const TreeData as usize;
    if let Some(l) = CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return l;
    }
    let read = |name: &str| -> Vec<LNode> {
        tree.section("legion").and_then(|l| l.get(name)).and_then(|a| a.as_array()).map(|a| a.iter().map(|v| read_lnode(tree, v)).collect()).unwrap_or_default()
    };
    let l = Rc::new(Legion { nodes: read("nodes"), additions: read("additions") });
    CACHE.with(|c| c.borrow_mut().insert(key, l.clone()));
    l
}

/// The order upstream walks `socket.nodesInRadius[3]` in, per tree version and socket id.
fn radius_order(version: &str, socket: i64) -> Option<Rc<Vec<i64>>> {
    thread_local! {
        static ORDER: std::cell::RefCell<Option<HashMap<String, HashMap<i64, Rc<Vec<i64>>>>>> = const { std::cell::RefCell::new(None) };
    }
    ORDER.with(|o| {
        let mut o = o.borrow_mut();
        if o.is_none() {
            let mut all: HashMap<String, HashMap<i64, Rc<Vec<i64>>>> = HashMap::default();
            if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(include_str!("../data/timeless_radius_order.json")) {
                for (ver, sockets) in m {
                    let mut per: HashMap<i64, Rc<Vec<i64>>> = HashMap::default();
                    if let Value::Object(s) = sockets {
                        for (id, list) in s {
                            if let (Ok(id), Value::Array(a)) = (id.parse::<i64>(), list) {
                                per.insert(id, Rc::new(a.iter().filter_map(|x| x.as_i64()).collect()));
                            }
                        }
                    }
                    all.insert(ver, per);
                }
            }
            *o = Some(all);
        }
        o.as_ref().and_then(|m| m.get(version)).and_then(|m| m.get(&socket)).cloned()
    })
}

struct Geo {
    tree: &'static TreeData,
    version: String,
}

impl Geo {
    fn flag(&self, id: i64, key: &str) -> bool {
        self.tree.node(id).and_then(|n| n.get(key)).and_then(|v| v.as_bool()).unwrap_or(false)
    }

    fn text(&self, id: i64, key: &str) -> String {
        self.tree.node(id).and_then(|n| n.get(key)).and_then(|v| v.as_str()).unwrap_or("").to_string()
    }

    fn xy(&self, id: i64) -> (f64, f64) {
        let n = self.tree.node(id);
        let f = |k: &str| n.and_then(|n| n.get(k)).and_then(|v| v.as_f64()).unwrap_or(0.0);
        (f("x"), f("y"))
    }

    /// `nodesInRadius[3]` of a jewel socket, in the order upstream iterates it.
    fn radius(&self, socket: i64) -> Vec<i64> {
        let ids: Vec<i64> = self
            .tree
            .node(socket)
            .and_then(|n| n.get("nodesInRadius"))
            .and_then(|r| r.get(2usize))
            .and_then(|r| r.as_object())
            .map(|o| o.keys().filter_map(|k| k.parse::<i64>().ok()).collect())
            .unwrap_or_default();
        if let Some(order) = radius_order(&self.version, socket) {
            let set: HashSet<i64> = ids.iter().copied().collect();
            if order.len() == ids.len() && order.iter().all(|i| set.contains(i)) {
                return order.as_ref().clone();
            }
        }
        let mut ids = ids;
        ids.sort_unstable();
        ids
    }

    /// The jewel sockets the dialog lists (`self.build.spec.nodes` with `isJewelSocket`, charm sockets and cluster
    /// jewel expansion sockets excluded).
    fn sockets(&self) -> Vec<i64> {
        let mut out: Vec<i64> = self
            .tree
            .nodes
            .iter()
            .filter(|(_, n)| n.get("isJewelSocket").and_then(|v| v.as_bool()).unwrap_or(false) && n.get("name").and_then(|v| v.as_str()) != Some("Charm Socket"))
            .filter(|(_, n)| !n.get("expansionJewel").and_then(|e| e.get("parent")).is_some())
            .map(|(&id, _)| id)
            .collect();
        out.sort_unstable();
        out
    }
}

/// What the build contributes to the search.
pub struct Ctx {
    pub alloc: HashSet<i64>,
    pub granted: HashSet<i64>,
    pub path_dist: HashMap<i64, i64>,
    pub roots: HashSet<i64>,
    /// The tree graph the search walks for Reclaimed Malevolence: each node's links, its type and its ascendancy.
    pub linked: HashMap<i64, Vec<i64>>,
    pub kind: HashMap<i64, String>,
    pub ascendancy: HashMap<i64, String>,
    pub class_start: i64,
    /// The build's ascendancy (`curAscendClassName`).
    pub asc_name: Option<String>,
}

impl Ctx {
    pub fn new(paths: &TreePaths, granted: &[i64]) -> Ctx {
        let class = paths.classes.get(&paths.class_id);
        Ctx {
            alloc: paths.alloc.clone(),
            granted: granted.iter().copied().collect(),
            path_dist: paths.nodes.iter().map(|(&id, n)| (id, n.path_dist)).collect(),
            roots: paths.classes.values().map(|c| c.start_node_id).collect(),
            linked: paths.nodes.iter().map(|(&id, n)| (id, n.linked.clone())).collect(),
            kind: paths.nodes.iter().map(|(&id, n)| (id, n.kind.clone())).collect(),
            ascendancy: paths.nodes.iter().filter_map(|(&id, n)| n.ascendancy.clone().map(|a| (id, a))).collect(),
            class_start: class.map(|c| c.start_node_id).unwrap_or(-1),
            asc_name: class.and_then(|c| c.ascendancies.get(&paths.ascend_class_id)).map(|a| a.name.clone()).filter(|n| !n.is_empty()),
        }
    }

    fn allocated(&self, id: i64) -> bool {
        self.granted.contains(&id) || self.alloc.contains(&id)
    }

    /// `PassiveSpec:GetShortestPathToClassStart`: the allocated nodes from `root` to the build's class start, in the
    /// order a Lua table keyed by them is walked.
    fn path_to_class_start(&self, root: i64) -> Option<Vec<i64>> {
        if !self.alloc.contains(&root) {
            return None;
        }
        let mut parent: HashMap<i64, i64> = HashMap::default();
        let mut queue = vec![root];
        let mut o = 0;
        while o < queue.len() {
            let node = queue[o];
            o += 1;
            for &other in self.linked.get(&node).map(|v| v.as_slice()).unwrap_or(&[]) {
                if other == self.class_start {
                    let mut t = LjHash::new();
                    t.set(root, true);
                    t.set(other, true);
                    let mut cur = Some(node);
                    while let Some(c) = cur {
                        t.set(c, true);
                        cur = parent.get(&c).copied();
                    }
                    return Some(t.iterate());
                }
                let kind = |n: i64| self.kind.get(&n).map(|k| k.as_str()).unwrap_or("");
                if self.alloc.contains(&other) && kind(node) != "Mastery" && kind(other) != "ClassStart" && kind(other) != "AscendClassStart" && !parent.contains_key(&other) && other != root {
                    parent.insert(other, node);
                    queue.push(other);
                }
            }
        }
        None
    }
}

// ---- the dialog's lists ----

#[derive(Clone)]
pub struct SocketInfo {
    pub id: i64,
    pub label: String,
    pub keystone: String,
    pub allocated: bool,
}

fn socket_infos(geo: &Geo, ctx: &Ctx) -> Vec<SocketInfo> {
    let mut list: Vec<SocketInfo> = geo
        .sockets()
        .into_iter()
        .map(|id| {
            let keystone = match id {
                26725 => "Marauder".to_string(),
                54127 => "Duelist".to_string(),
                7960 => "Templar/Witch".to_string(),
                _ => {
                    let (sx, sy) = geo.xy(id);
                    let mut best = f64::INFINITY;
                    let mut name = "Unknown".to_string();
                    for n in geo.radius(id) {
                        if geo.flag(n, "isKeystone") {
                            let (x, y) = geo.xy(n);
                            let d = ((x - sx).powi(2) + (y - sy).powi(2)).sqrt();
                            if d < best {
                                best = d;
                                name = geo.text(n, "name");
                            }
                        }
                    }
                    name
                }
            };
            let allocated = ctx.alloc.contains(&id);
            let label = format!("{}{}: {}", if allocated { "# " } else { "" }, keystone, id);
            SocketInfo { id, label, keystone, allocated }
        })
        .collect();
    lua_table_sort(&mut list, &|a: &SocketInfo, b: &SocketInfo| a.label < b.label);
    list
}

/// `buildMods`: the entries of the "Search for Node" list for a jewel type.
pub fn mods(tree: &'static TreeData, jewel_type: i64) -> Value {
    let legion = legion_of(tree);
    let name = type_name(jewel_type);
    let prefix = format!("{name}_");
    let has_prefix = |id: &str| id.starts_with(&prefix) && id.len() > prefix.len();
    #[derive(Clone)]
    struct Entry {
        label: String,
        descriptions: Vec<String>,
        id: String,
        total: bool,
    }
    let mut mod_data: Vec<Entry> = Vec::new();
    let mut small: Vec<Entry> = Vec::new();
    for node in &legion.nodes {
        if has_prefix(&node.id) && !node.id.starts_with("abyss_special_ascendancy_notable_") && !IGNORED_MODS.contains(&node.dn.as_str()) && !node.ks {
            if node.not {
                let mut label = format!("{}{}{}", node.dn, " ".repeat(48), node.sd.first().cloned().unwrap_or_default());
                if let Some(s2) = node.sd.get(1) {
                    label.push(' ');
                    label.push_str(s2);
                }
                mod_data.push(Entry { label, descriptions: node.sd.clone(), id: node.id.clone(), total: false });
            } else {
                small.push(Entry { label: node.dn.clone(), descriptions: node.sd.clone(), id: node.id.clone(), total: false });
            }
        }
    }
    for add in &legion.additions {
        if has_prefix(&add.id) && !IGNORED_MODS.contains(&add.dn.as_str()) && name != "vaal" {
            mod_data.push(Entry { label: add.dn.clone(), descriptions: add.sd.clone(), id: add.id.clone(), total: false });
        }
    }
    lua_table_sort(&mut mod_data, &|a: &Entry, b: &Entry| a.label < b.label);
    lua_table_sort(&mut small, &|a: &Entry, b: &Entry| a.label < b.label);
    if let Some(t) = total_mod_name(jewel_type) {
        mod_data.insert(
            0,
            Entry { label: format!("Total {t}"), descriptions: vec![format!("This is a hybrid node containing all additions to {t}")], id: format!("total_{}", t.to_lowercase()), total: true },
        );
    }
    let find = |id: &str| -> Option<&LNode> { legion.nodes.iter().find(|n| n.id == id).or_else(|| legion.additions.iter().find(|n| n.id == id)) };
    let mut out: Vec<Value> = vec![json!({ "label": "..." })];
    for e in mod_data.iter().chain(small.iter()) {
        let (stat_count, l1, l2) = match find(&e.id) {
            Some(n) => {
                // `getLegionStatLabels`: Abyss nodes count their rolled stats, which can outnumber their lines.
                let count = if jewel_type >= 7 { n.sorted_stats.len() } else { n.sd.len() };
                if count > n.sd.len() {
                    (count, format!("Minimum value: {}", n.sd.first().cloned().unwrap_or_default()), format!("Maximum value: {}", n.sd.first().cloned().unwrap_or_default()))
                } else if count == 1 {
                    (count, n.sd.join(" + "), "None".to_string())
                } else {
                    (count, n.sd.first().cloned().unwrap_or("None".into()), n.sd.get(1).cloned().unwrap_or("None".into()))
                }
            }
            None => (0, "None".into(), "None".into()),
        };
        out.push(json!({ "label": e.label, "id": e.id, "descriptions": e.descriptions, "totalMod": e.total, "statCount": stat_count, "stat1": l1, "stat2": l2 }));
    }
    Value::Array(out)
}

/// Everything the dialog shows about the build: sockets, and per socket the notables in its radius the build has
/// (the "Protect allocated nodes from changing" list).
pub fn info(tree: &'static TreeData, version: &str, ctx: &Ctx) -> Value {
    let geo = Geo { tree, version: version.to_string() };
    let sockets = socket_infos(&geo, ctx);
    let mut list: Vec<Value> = vec![json!({ "id": -1, "label": "All Sockets", "keystone": "Multi-Socket Search", "allocated": false })];
    for s in &sockets {
        let mut near: Vec<(String, i64)> = Vec::new();
        for n in geo.radius(s.id) {
            if ctx.allocated(n) && geo.flag(n, "isNotable") {
                near.push((geo.text(n, "dn"), n));
            }
        }
        lua_table_sort(&mut near, &|a: &(String, i64), b: &(String, i64)| a.0 < b.0);
        // The socket's radius for the picker's preview: each node's offset from the socket, its kind (0 small, 1 notable,
        // 2 keystone, 3 socket) and whether the build has it.
        let (sx, sy) = geo.xy(s.id);
        let preview: Vec<Value> = geo
            .radius(s.id)
            .into_iter()
            .map(|n| {
                let (x, y) = geo.xy(n);
                let kind = if geo.flag(n, "isKeystone") { 2 } else if geo.flag(n, "isJewelSocket") { 3 } else if geo.flag(n, "isNotable") { 1 } else { 0 };
                json!([(x - sx).round() as i64, (y - sy).round() as i64, kind, ctx.allocated(n) as i64])
            })
            .collect();
        list.push(json!({
            "id": s.id, "label": s.label, "keystone": s.keystone, "allocated": s.allocated, "preview": preview,
            "allocatedNotables": near.iter().map(|(label, id)| json!({ "label": label, "id": id })).collect::<Vec<_>>(),
        }));
    }
    // Reclaimed Malevolence: the notables of the build's ascendancy it can replace, and the outcomes the search can be
    // limited to ("Required ascendancy outcome").
    let mut asc_notables: Vec<(String, i64)> = Vec::new();
    if let Some(asc) = &ctx.asc_name {
        for &n in &ctx.alloc {
            if ctx.ascendancy.get(&n) == Some(asc) && geo.flag(n, "isNotable") {
                asc_notables.push((geo.text(n, "dn"), n));
            }
        }
    }
    lua_table_sort(&mut asc_notables, &|a: &(String, i64), b: &(String, i64)| a.0 < b.0);
    let legion = legion_of(tree);
    let is_outcome = |id: &str| id.strip_prefix("abyss_special_ascendancy_notable_").is_some_and(|r| !r.is_empty() && r.bytes().all(|c| c.is_ascii_digit()));
    let mut outcomes: Vec<(String, String)> = legion.nodes.iter().filter(|n| is_outcome(&n.id)).map(|n| (n.dn.clone(), n.id.clone())).collect();
    lua_table_sort(&mut outcomes, &|a: &(String, String), b: &(String, String)| a.0 < b.0);
    json!({
        "sockets": list,
        "treeVersion": version,
        "ascendancyNotables": asc_notables.iter().map(|(label, id)| json!({ "label": label, "id": id })).collect::<Vec<_>>(),
        "ascendancyOutcomes": outcomes.iter().map(|(label, id)| json!({ "label": label, "id": id })).collect::<Vec<_>>(),
    })
}

// ---- search ----

pub struct Params {
    pub jewel_type: i64,
    pub socket_id: i64,
    pub socket_filter: bool,
    pub distance: i64,
    pub total_min: Option<f64>,
    pub search_list: String,
    pub fallback_list: String,
    /// Names (`dn`) of the notables the player ticked in "Protect allocated nodes from changing".
    pub protected: Vec<String>,
}

impl Params {
    pub fn from_json(v: &Value) -> Params {
        let text = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        Params {
            jewel_type: v.get("jewelType").and_then(|x| x.as_i64()).unwrap_or(1),
            socket_id: v.get("socketId").and_then(|x| x.as_i64()).unwrap_or(-1),
            socket_filter: v.get("socketFilter").and_then(|x| x.as_bool()).unwrap_or(false),
            distance: v.get("socketFilterDistance").and_then(|x| x.as_i64()).unwrap_or(0),
            total_min: v.get("totalMinimumWeight").and_then(|x| x.as_f64()),
            search_list: text("searchList"),
            fallback_list: text("searchListFallback"),
            protected: v.get("protected").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(),
        }
    }
}

/// A token of a weight row: a number or a word ("required").
#[derive(Clone)]
enum Tok {
    Num(f64),
    Word(String),
}

impl Tok {
    fn parse(s: &str) -> Tok {
        match lua_tonumber(s) {
            Some(n) => Tok::Num(n),
            None => Tok::Word(s.to_string()),
        }
    }
}

/// Lua's `tonumber` for the plain decimal forms the weight list holds.
fn lua_tonumber(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(h, 16).ok().map(|v| v as f64);
    }
    if t.chars().any(|c| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))) {
        return None;
    }
    t.parse::<f64>().ok()
}

/// `parseSearchList(0, ...)`: one row per line, tokens split on commas and white space.
fn parse_rows(text: &str) -> Vec<Vec<Tok>> {
    text.split(['\r', '\n']).filter(|l| !l.is_empty()).map(|l| l.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()).map(Tok::parse_owned).collect()).collect()
}

impl Tok {
    fn parse_owned(s: &str) -> Tok {
        // Row ids stay words even when they look numeric, as upstream compares them as strings.
        Tok::parse(s)
    }

    fn word(&self) -> String {
        match self {
            Tok::Word(w) => w.clone(),
            Tok::Num(n) => lua_num_str(*n),
        }
    }

    fn num(&self) -> Option<f64> {
        match self {
            Tok::Num(n) => Some(*n),
            Tok::Word(_) => None,
        }
    }
}

#[derive(Clone)]
struct Desired {
    id: String,
    weight: f64,
    weight2: f64,
    display: String,
    idx: usize,
}

/// One seed's matches for a desired node.
#[derive(Clone)]
struct Hit {
    desired: usize,
    total: f64,
    nodes: Vec<i64>,
}

#[derive(Default)]
struct SeedRes {
    hits: Vec<Hit>,
}

impl SeedRes {
    fn hit(&mut self, desired: usize) -> &mut Hit {
        if let Some(i) = self.hits.iter().position(|h| h.desired == desired) {
            return &mut self.hits[i];
        }
        self.hits.push(Hit { desired, total: 0.0, nodes: Vec::new() });
        self.hits.last_mut().unwrap()
    }

    fn weight(&self, desired: usize) -> f64 {
        self.hits.iter().find(|h| h.desired == desired).map(|h| h.total).unwrap_or(0.0)
    }

    fn has(&self, desired: usize) -> bool {
        self.hits.iter().any(|h| h.desired == desired)
    }
}

#[derive(Clone)]
pub struct Row {
    pub seed: i64,
    pub total: f64,
    pub socket_id: Option<i64>,
    pub socket_label: Option<String>,
    pub label: String,
    hits: Vec<Hit>,
}

struct SocketJob {
    socket: SocketInfo,
    multi: bool,
    desired: Vec<Desired>,
    by_id: HashMap<String, usize>,
    minimum: Vec<(String, f64)>,
    targets: Vec<i64>,
    luts: Vec<Option<NodeLut>>,
    /// Per target: (dn, name).
    names: Vec<(String, String)>,
    small_attr: i64,
    small_other: i64,
    next_seed: i64,
    seed_min: i64,
    seed_max: i64,
    step: i64,
    weights: Vec<f64>,
    res: Vec<Option<SeedRes>>,
    table: LjHash,
    /// Reclaimed Malevolence: the allocated path from the socket to the class start.
    zorath: Option<Vec<i64>>,
}

pub struct Run {
    tree: &'static TreeData,
    legion: Rc<Legion>,
    data: &'static TimelessJewelData,
    p: Params,
    ctx: Ctx,
    geo: Geo,
    sockets: Vec<SocketInfo>,
    queue: Vec<SocketInfo>,
    pos: usize,
    job: Option<SocketJob>,
    rows: Vec<Row>,
    desired_out: Vec<Desired>,
    seeds_done: i64,
    seeds_total: i64,
    pub done: bool,
    alloc_in_radius: usize,
}

/// Prepares a search; `step` does the work.
pub fn start(tree: &'static TreeData, version: &str, data: &'static TimelessJewelData, ctx: Ctx, p: Params) -> Result<Run, String> {
    if !supported(p.jewel_type) {
        return Err("This jewel type cannot be searched.".to_string());
    }
    let present = if p.jewel_type >= 7 { data.has_abyss_table(p.jewel_type) } else { data.has_table(p.jewel_type) };
    if !present {
        return Err(format!("The {} table is not installed.", JEWEL_TYPES.iter().find(|t| t.2 == p.jewel_type).map(|t| t.0).unwrap_or("jewel")));
    }
    let geo = Geo { tree, version: version.to_string() };
    let sockets = socket_infos(&geo, &ctx);
    let queue: Vec<SocketInfo> = if p.socket_id == -1 { sockets.clone() } else { sockets.iter().filter(|s| s.id == p.socket_id).cloned().collect() };
    let (lo, hi, step) = seed_bounds(p.jewel_type);
    let per = (hi - lo) / step + 1;
    let seeds_total = per * queue.len() as i64;
    // `setAllocatedNodes`: the notables of the radius the build has, for the protect rule of Militant Faith.
    let alloc_in_radius = if p.socket_filter && p.socket_id != -1 { geo.radius(p.socket_id).into_iter().filter(|&n| ctx.allocated(n) && geo.flag(n, "isNotable")).count() } else { 0 };
    Ok(Run { tree, legion: legion_of(tree), data, p, ctx, geo, sockets, queue, pos: 0, job: None, rows: Vec::new(), desired_out: Vec::new(), seeds_done: 0, seeds_total, done: false, alloc_in_radius })
}

impl Run {
    /// `searchSingleSocket` up to the seed loop.
    fn setup_socket(&self, socket: &SocketInfo, multi: bool) -> Option<SocketJob> {
        let p = &self.p;
        let geo = &self.geo;
        if !geo.flag(socket.id, "isJewelSocket") {
            return None;
        }
        let jt = p.jewel_type;
        let zorath = if jt == 11 { Some(self.ctx.path_to_class_start(socket.id)?) } else { None };
        let radius = if jt >= 7 { Vec::new() } else { geo.radius(socket.id) };
        let mut desired: Vec<Desired> = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::default();
        let mut minimum: Vec<(String, f64)> = Vec::new();
        let mut desired_idx = 0usize;

        let list = parse_rows(&p.search_list);
        let fallback = parse_rows(&p.fallback_list);
        let mut found: HashSet<String> = HashSet::default();
        let mut combined: Vec<Vec<Tok>> = Vec::new();
        for row in &list {
            if let Some(first) = row.first() {
                found.insert(first.word());
            }
            combined.push(row.clone());
        }
        for row in &fallback {
            if let Some(first) = row.first() {
                if !found.contains(&first.word()) {
                    combined.push(row.clone());
                }
            }
        }
        let combined_len = combined.len();
        for mut row in combined {
            if row.len() <= 1 {
                continue;
            }
            let mut display: Option<String> = None;
            let mut single = false;
            let mut id = row[0].word();
            if let Some(t) = total_mod_name(jt) {
                if id == format!("total_{}", t.to_lowercase()) {
                    id = "totalStat".to_string();
                    display = Some(t.to_string());
                }
            }
            if display.is_none() {
                if let Some(n) = self.legion.nodes.iter().find(|n| n.id == id) {
                    if jt > 1 && jt < 7 {
                        single = true;
                    }
                    display = Some(n.sd.join(" + "));
                }
            }
            if display.is_none() {
                if let Some(n) = self.legion.additions.iter().find(|n| n.id == id) {
                    single = jt < 7;
                    display = Some(n.sd.join(" + "));
                }
            }
            let Some(display) = display else { continue };
            row[0] = Tok::Word(id.clone());
            // `for i, val in ipairs(desiredNode)`: values read before the row is changed.
            let vals: Vec<Tok> = row.clone();
            for (i0, val) in vals.iter().enumerate() {
                let i = i0 + 1;
                if single && i == 2 {
                    let v = row.get(1).and_then(|t| t.num()).or_else(|| row.get(2).and_then(|t| t.num())).unwrap_or(1.0);
                    row[1] = Tok::Num(v);
                }
                if matches!(val, Tok::Word(w) if w == "required") {
                    row[i0] = if single && i == 2 { row[1].clone() } else { Tok::Num(0.0) };
                    let cur = row.get(3).and_then(|t| t.num());
                    if cur.map_or(true, |c| c < 0.001) {
                        while row.len() < 4 {
                            row.push(Tok::Num(0.0));
                        }
                        row[3] = Tok::Num(0.001);
                    }
                }
            }
            if let Some(w) = row.get(3).and_then(|t| t.num()) {
                if w > 0.0 {
                    minimum.push((id.clone(), w));
                }
            }
            if jt == 4 && !p.protected.is_empty() && p.protected.len() < self.alloc_in_radius && combined_len < self.alloc_in_radius {
                minimum.push((id.clone(), 1.0));
            }
            let w1 = row.get(1).and_then(|t| t.num()).unwrap_or(0.001);
            let w2 = row.get(2).and_then(|t| t.num()).unwrap_or(0.001);
            if let Some(&i) = by_id.get(&id) {
                desired[i].weight = w1;
                desired[i].weight2 = w2;
                desired[i].display = display;
            } else {
                desired_idx += 1;
                by_id.insert(id.clone(), desired.len());
                desired.push(Desired { id: id.clone(), weight: w1, weight2: w2, display, idx: desired_idx });
            }
        }

        let mut allocated: HashMap<i64, bool> = HashMap::default();
        if p.socket_filter {
            for &n in &radius {
                allocated.insert(n, self.ctx.allocated(n));
            }
        }
        let total_stat = by_id.contains_key("totalStat");
        let mut table = LjHash::new();
        let mut small_attr = 0i64;
        let mut small_other = 0i64;
        for &n in &radius {
            if self.ctx.roots.contains(&n) || geo.flag(n, "isJewelSocket") || geo.flag(n, "isKeystone") {
                continue;
            }
            if p.socket_filter {
                let ok = allocated.get(&n).copied().unwrap_or(false) || (p.distance > 0 && self.ctx.path_dist.get(&n).copied().unwrap_or(1000) <= p.distance);
                if !ok {
                    continue;
                }
            }
            let notable = geo.flag(n, "isNotable");
            if notable || jt == 1 {
                table.set(n, true);
            } else if total_stat {
                let dn = geo.text(n, "dn");
                if dn == "Strength" || dn == "Intelligence" || dn == "Dexterity" {
                    small_attr += 1;
                } else {
                    small_other += 1;
                }
            }
        }
        let targets = table.iterate();
        let luts: Vec<Option<NodeLut>> = targets.iter().map(|&n| self.data.node_lut(jt, n)).collect();
        let names = targets.iter().map(|&n| (geo.text(n, "dn"), geo.text(n, "name"))).collect();
        let (lo, hi, step) = seed_bounds(jt);
        let count = ((hi - lo) / step + 1) as usize;
        Some(SocketJob {
            socket: socket.clone(),
            multi,
            desired,
            by_id,
            minimum,
            targets,
            luts,
            names,
            small_attr,
            small_other,
            next_seed: lo,
            seed_min: lo,
            seed_max: hi,
            step,
            weights: vec![0.0; count],
            res: (0..count).map(|_| None).collect(),
            table: LjHash::new(),
            zorath,
        })
    }

    /// The seed loop of `searchSingleSocket`, for seeds up to `until` or the end.
    fn run_seeds(&mut self, job: &mut SocketJob, deadline: std::time::Instant) -> bool {
        let jt = self.p.jewel_type;
        let legion = self.legion.clone();
        let protected: HashSet<&str> = self.p.protected.iter().map(|s| s.as_str()).collect();
        let mut buf = [0i64; 8];
        let mut counter = 0u32;
        while job.next_seed <= job.seed_max {
            let seed = job.next_seed;
            job.next_seed += job.step;
            let si = ((seed - job.seed_min) / job.step) as usize;
            let seed_off = (seed / if jt == 5 { 20 } else { 1 }) - seed_bounds(jt).0 / (if jt == 5 { 20 } else { 1 });
            job.table.set(seed, true);
            let mut res = SeedRes::default();
            let mut weight = 0.0f64;
            let mut valid = true;
            if jt >= 7 {
                // Abyss files name the affected passives, so those are scored instead of every passive in the radius.
                let affected = self.data.read_abyss_lut_for(seed, job.socket.id, jt, job.zorath.as_deref(), self.ctx.asc_name.as_deref());
                let mut order = LjHash::new();
                for (n, _) in &affected {
                    order.set(*n, true);
                }
                for target in order.iterate() {
                    let Some((_, modification)) = affected.iter().find(|(n, _)| *n == target) else { continue };
                    let exists = self.tree.node(target).is_some();
                    let mut score = exists && !self.ctx.roots.contains(&target) && !self.geo.flag(target, "isJewelSocket") && !self.geo.flag(target, "isKeystone");
                    if score && !self.geo.text(target, "ascendancyName").is_empty() && protected.contains(self.geo.text(target, "dn").as_str()) {
                        valid = false;
                        break;
                    }
                    if score && self.p.socket_filter && job.zorath.is_none() {
                        let dist = self.ctx.path_dist.get(&target).copied().unwrap_or(1000);
                        score = self.ctx.allocated(target) || (self.p.distance > 0 && dist <= self.p.distance);
                    }
                    if !score {
                        continue;
                    }
                    for comp in modification {
                        let changed = if comp.ty == 1 { legion.nodes.get((comp.id - ADDITIONS) as usize) } else if comp.ty == 2 { legion.additions.get(comp.id as usize) } else { None };
                        let Some(changed) = changed else { continue };
                        let Some(&di) = job.by_id.get(&changed.id) else { continue };
                        let (w1, w2) = (job.desired[di].weight, job.desired[di].weight2);
                        let (_, roll1) = abyss_roll(changed, comp, 1);
                        let (has2, roll2) = abyss_roll(changed, comp, 2);
                        let mut w = w1 * roll1.unwrap_or(1.0);
                        if has2 {
                            w += w2 * roll2.unwrap_or(1.0);
                        }
                        let h = res.hit(di);
                        h.total += w;
                        h.nodes.push(target);
                        weight += w;
                    }
                }
            }
            for ti in 0..job.targets.len() {
                let Some(lut) = &job.luts[ti] else { continue };
                let n = lut.get(seed_off, &mut buf);
                if n == 0 {
                    continue;
                }
                let target = job.targets[ti];
                let dn = job.names[ti].0.as_str();
                let tname = job.names[ti].1.as_str();
                let mut cur_id: Option<String> = None;
                let mut cur_node: Option<&LNode> = None;
                if jt == 4 && protected.contains(dn) {
                    if buf[0] >= ADDITIONS {
                        valid = false;
                        break;
                    }
                    if !job.by_id.contains_key("totalStat") {
                        let idx = job.desired.iter().map(|d| d.idx).max().unwrap_or(0) + 1;
                        job.by_id.insert("totalStat".to_string(), job.desired.len());
                        job.desired.push(Desired { id: "totalStat".into(), weight: 0.1, weight2: 0.0, display: "Devotion".into(), idx });
                    }
                    cur_id = Some("totalStat".to_string());
                }
                if buf[0] >= ADDITIONS && !protected.contains(dn) {
                    cur_node = legion.nodes.get((buf[0] - ADDITIONS) as usize);
                    cur_id = cur_node.map(|c| c.id.clone());
                } else {
                    cur_node = legion.additions.get(buf[0] as usize);
                    cur_id = cur_node.map(|c| c.id.clone());
                }
                let total_stat_wanted = job.by_id.contains_key("totalStat");
                if total_stat_wanted && cur_id.as_deref().is_some_and(is_reverse_total) {
                    cur_id = Some("totalStat".to_string());
                }
                let di_opt = cur_id.as_ref().and_then(|k| job.by_id.get(k)).copied();
                let (w1, w2) = di_opt.map(|d| (job.desired[d].weight, job.desired[d].weight2)).unwrap_or((0.0, 0.0));
                if jt == 1 {
                    if n == 2 || n == 3 {
                        let Some(di) = di_opt else { continue };
                        let Some(node) = cur_node else { continue };
                        let at = |i: i64| buf.get(i as usize).copied().unwrap_or(0) as f64;
                        let mut w = w1 * node.stat_index.first().map(|&i| at(i)).unwrap_or(0.0);
                        if let Some(&i2) = node.stat_index.get(1) {
                            w += w2 * at(i2);
                        }
                        let h = res.hit(di);
                        h.nodes.push(target);
                        h.total += w;
                        weight += w;
                        let _ = tname;
                    } else if n == 6 || n == 8 {
                        for i in 0..n {
                            let add = legion.additions.get(buf[i] as usize);
                            let id = add.map(|a| a.id.clone());
                            if i < n / 2 {
                                let Some(id) = id else { continue };
                                let Some(&d2) = job.by_id.get(&id) else { continue };
                                let w = job.desired[d2].weight * buf[i + n / 2] as f64;
                                let h = res.hit(d2);
                                h.total += w;
                                h.nodes.push(target);
                                weight += w;
                            } else {
                                break;
                            }
                        }
                    }
                } else {
                    let Some(di) = di_opt else { continue };
                    let h = res.hit(di);
                    h.total += w1;
                    h.nodes.push(target);
                    weight += w1;
                }
            }
            if valid {
                if let Some(&di) = job.by_id.get("totalStat") {
                    let tw = res.hit(di).total;
                    let w = job.desired[di].weight;
                    let added = if jt == 4 {
                        w * (5 * job.small_other + 10 * job.small_attr) as f64 + tw * 4.0
                    } else {
                        w * (4 * job.small_other + 2 * job.small_attr) as f64 + tw * 19.0
                    };
                    res.hit(di).total += added;
                    weight += added;
                }
                for (id, min) in &job.minimum {
                    let got = job.by_id.get(id).map(|&d| res.weight(d)).unwrap_or(0.0);
                    if got < *min {
                        valid = false;
                        break;
                    }
                }
            }
            job.weights[si] = weight;
            if valid {
                job.res[si] = Some(res);
            } else {
                job.table.set(seed, false);
            }
            self.seeds_done += 1;
            counter += 1;
            if counter % 64 == 0 && std::time::Instant::now() >= deadline {
                return false;
            }
        }
        true
    }

    /// `formatResults` for one finished socket.
    fn finish_socket(&mut self, job: SocketJob) {
        let jt = self.p.jewel_type;
        let mut res = job.res;
        let mut rows: Vec<Row> = Vec::new();
        for seed in job.table.iterate() {
            let si = ((seed - job.seed_min) / job.step) as usize;
            let Some(r) = res[si].take() else { continue };
            let total = job.weights[si];
            let passes = self.p.total_min.map_or(true, |m| total >= m);
            if !(total > 0.0 && passes) {
                continue;
            }
            let prefix = if job.multi { format!("{} | ", job.socket.label) } else { String::new() };
            let mut label = format!("{prefix}{seed}:");
            if jt == 1 || jt == 3 || jt >= 7 {
                if seed < 1000 {
                    label = format!("  {label}");
                }
            } else if jt == 4 {
                if seed < 10000 {
                    label = format!("  {label}");
                }
            } else if seed < 10000 {
                label = format!("    {label}");
            } else if seed < 100000 {
                label = format!("  {label}");
            }
            let mut cols: Vec<Option<String>> = vec![None; 9];
            for d in &job.desired {
                let hit = r.hits.iter().find(|h| h.desired == job.by_id[&d.id]);
                if let Some(h) = hit {
                    if d.idx == 8 {
                        cols[8] = Some(" ...".to_string());
                    } else if d.idx < 8 {
                        cols[d.idx] = Some(format_search_value(h.total));
                    }
                } else if d.idx < 8 {
                    cols[d.idx] = Some("     0     ".to_string());
                }
            }
            // `table.concat` stops at the first hole.
            for c in cols.iter().skip(1) {
                match c {
                    Some(s) => label.push_str(s),
                    None => break,
                }
            }
            rows.push(Row {
                seed,
                total,
                socket_id: if job.multi { Some(job.socket.id) } else { None },
                socket_label: if job.multi { Some(job.socket.label.clone()) } else { None },
                label,
                hits: r.hits,
            });
        }
        self.rows.extend(rows);
        self.desired_out = job.desired;
    }

    /// Works for about `budget_ms`. Returns `(done, progress percent)`.
    pub fn step(&mut self, budget_ms: u64) -> (bool, i64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
        while !self.done {
            if self.job.is_none() {
                if self.pos >= self.queue.len() {
                    self.sort();
                    self.done = true;
                    break;
                }
                let s = self.queue[self.pos].clone();
                self.pos += 1;
                let multi = self.p.socket_id == -1;
                match self.setup_socket(&s, multi) {
                    Some(j) => self.job = Some(j),
                    None => continue,
                }
            }
            let mut job = self.job.take().unwrap();
            if self.run_seeds(&mut job, deadline) {
                self.finish_socket(job);
            } else {
                self.job = Some(job);
                break;
            }
            if std::time::Instant::now() >= deadline && self.pos < self.queue.len() {
                break;
            }
        }
        let pct = if self.done { 100 } else if self.seeds_total > 0 { self.seeds_done * 100 / self.seeds_total } else { 0 };
        (self.done, pct)
    }

    fn sort(&mut self) {
        if self.p.socket_id == -1 {
            lua_table_sort(&mut self.rows, &|a: &Row, b: &Row| {
                if a.total == b.total {
                    a.socket_label.as_deref().unwrap_or("") < b.socket_label.as_deref().unwrap_or("")
                } else {
                    a.total > b.total
                }
            });
        } else {
            lua_table_sort(&mut self.rows, &|a: &Row, b: &Row| a.total > b.total);
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    pub fn seeds_done(&self) -> i64 {
        self.seeds_done
    }

    /// `sharedResults.desiredNodes`: what the weight columns are, in order.
    pub fn desired_json(&self) -> Value {
        let mut d: Vec<&Desired> = self.desired_out.iter().collect();
        d.sort_by_key(|d| d.idx);
        Value::Array(d.iter().map(|d| json!({ "id": d.id, "displayName": d.display, "idx": d.idx, "weight": d.weight, "weight2": d.weight2 })).collect())
    }

    /// Rows `from..from+count` for the results list: seed, total, upstream's label and, per desired node, its
    /// weight and the names of the nodes the jewel changes to it.
    pub fn rows_json(&self, from: usize, count: usize) -> Value {
        let by_id: HashMap<usize, &Desired> = self.desired_out.iter().enumerate().map(|(i, d)| (i, d)).collect();
        let rows: Vec<Value> = self
            .rows
            .iter()
            .skip(from)
            .take(count)
            .map(|r| {
                let hits: Vec<Value> = r
                    .hits
                    .iter()
                    .filter_map(|h| {
                        let d = by_id.get(&h.desired)?;
                        let mut names: Vec<String> = Vec::new();
                        for &n in &h.nodes {
                            names.push(self.geo.text(n, "name"));
                        }
                        Some(json!({ "id": d.id, "idx": d.idx, "weight": h.total, "names": names }))
                    })
                    .collect();
                json!({
                    "seed": r.seed, "total": r.total, "totalText": lua_num_str(r.total), "label": r.label,
                    "socketId": r.socket_id, "socketLabel": r.socket_label, "hits": hits,
                })
            })
            .collect();
        let _ = &self.sockets;
        let _ = &self.tree;
        Value::Array(rows)
    }

    pub fn socket_label(&self, id: i64) -> Option<String> {
        self.sockets.iter().find(|s| s.id == id).map(|s| s.label.clone())
    }

    pub fn socket_keystone(&self, id: i64) -> Option<String> {
        self.sockets.iter().find(|s| s.id == id).map(|s| s.keystone.clone())
    }
}

// ---- number formatting upstream does ----

/// `formatSearchValue`.
pub fn format_search_value(x: f64) -> String {
    let s = format!(" {:06.2}", x);
    let s = gsub(&s, 2, &|b, i| if b[i] == b' ' && b[i + 1] == b'0' { Some((2, "   ".to_string())) } else { None });
    let s = gsub(&s, 2, &|b, i| if b[i] == b' ' && b[i + 1] == b'0' { Some((2, "   ".to_string())) } else { None });
    let s = gsub(&s, 3, &|b, i| if b[i + 1] == b'0' && b[i + 2] == b' ' { Some((3, "    ".to_string())) } else { None });
    let s = gsub(&s, 3, &|b, i| if b[i + 1] == b'0' && b[i + 2] == b' ' { Some((3, "    ".to_string())) } else { None });
    let s = gsub(&s, 3, &|b, i| if b[i] == b' ' && b[i + 1] == b' ' && b[i + 2] == b'.' { Some((3, "0.".to_string())) } else { None });
    gsub(&s, 3, &|b, i| if b[i] == b'.' && b[i + 1].is_ascii_digit() && b[i + 2] == b'0' { Some((3, format!(".{}  ", b[i + 1] as char))) } else { None })
}

/// Lua's `string.gsub` with a matcher that needs `width` bytes at the position.
fn gsub(s: &str, width: usize, f: &dyn Fn(&[u8], usize) -> Option<(usize, String)>) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if i + width <= b.len() {
            if let Some((len, rep)) = f(b, i) {
                out.push_str(&rep);
                i += len;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// `getAbyssJewelComponentRoll`: whether the node has a stat with this index, and the component's roll for it (a negative
/// roll of a stat that is shown positive is turned round).
fn abyss_roll(node: &LNode, comp: &pom_passives::abyss::AbyssComponent, stat_index: i64) -> (bool, Option<f64>) {
    let Some(i) = node.stat_index.iter().position(|&x| x == stat_index) else { return (false, None) };
    let roll = comp.rolls.get((stat_index - 1) as usize).map(|&r| r as f64);
    let roll = roll.map(|r| if r < 0.0 && node.stat_defs[i].0 >= 0.0 { -r } else { r });
    (true, roll)
}

// ---- fallback weights ----

/// `replaceHelperFunc`: puts `value` into a stat line in place of its roll range.
fn replace_helper(line: &str, key: &str, d: &(f64, f64, String), mut value: f64) -> String {
    if d.2 == "g" {
        if key.contains("per_minute") {
            value = ((value / 60.0) * 10.0 + 0.5).floor() / 10.0;
        } else if key.contains("permyriad") {
            value /= 100.0;
        } else if key.contains("_ms") {
            value /= 1000.0;
        }
    }
    let v = lua_num_str(value);
    if d.0 != d.1 {
        line.replace(&format!("({}-{})", lua_num_str(d.0), lua_num_str(d.1)), &v)
    } else if d.0 != value {
        line.replace(&lua_num_str(d.0), &v)
    } else {
        line.to_string()
    }
}

/// The first number in a stat line (upstream's `modList[1].value` for the hybrid "Total" entries).
fn first_number(s: &str) -> f64 {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && !(b[i].is_ascii_digit() || (b[i] == b'-' && i + 1 < b.len() && b[i + 1].is_ascii_digit())) {
        i += 1;
    }
    let start = i;
    i += 1;
    while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
        i += 1;
    }
    s[start.min(s.len())..i.min(s.len())].parse().unwrap_or(1.0)
}

/// The mod lines upstream adds for one entry of the node list, with the divisor its power is scaled by.
/// A node with several rolled stats gives one unit per stat (`calcMultiple`).
fn fallback_units(legion: &Legion, jt: i64, id: &str, total: bool) -> Vec<(Vec<String>, f64)> {
    let variable = jt == 1 || jt >= 7;
    let matches = |n: &LNode| n.id == id || (total && total_ids(id).contains(&n.id.as_str()));
    let per_stat = |n: &LNode| -> Vec<(Vec<String>, f64)> {
        // One line per stat at the value 100, as upstream's `data.describeStats` writes it (recorded in
        // `data/timeless_stat_lines.json`).
        if let Some(lines) = stat_lines(&n.id).filter(|l| l.len() == n.sorted_stats.len()) {
            return lines.iter().map(|l| (vec![l.clone()], 100.0)).collect();
        }
        if n.sd.len() != n.sorted_stats.len() {
            return Vec::new();
        }
        n.sorted_stats.iter().enumerate().map(|(i, k)| (vec![replace_helper(&n.sd[i], k, &n.stat_defs[i], 100.0)], 100.0)).collect()
    };
    if let Some(n) = legion.nodes.iter().find(|n| matches(n)) {
        if variable {
            if n.sorted_stats.len() > 1 {
                return per_stat(n);
            }
            let original = n.sd.first().cloned().unwrap_or_default();
            let line = match (n.sorted_stats.first(), n.stat_defs.first()) {
                (Some(k), Some(d)) => replace_helper(&original, k, d, 100.0),
                _ => original.clone(),
            };
            if line == original && n.sd.len() > 1 {
                return vec![(n.sd.clone(), 1.0)];
            }
            return vec![(vec![line.clone()], if line != original { 100.0 } else { 1.0 })];
        }
        let divisor = if total { first_number(n.sd.first().map(|s| s.as_str()).unwrap_or("")) } else { 1.0 };
        return vec![(n.sd.clone(), divisor)];
    }
    if let Some(n) = legion.additions.iter().find(|n| matches(n)) {
        if variable && n.sorted_stats.len() > 1 {
            return per_stat(n);
        }
        let original = n.sd.first().cloned().unwrap_or_default();
        let mut line = original.clone();
        if variable {
            for (k, d) in n.sorted_stats.iter().zip(&n.stat_defs) {
                line = replace_helper(&line, k, d, 100.0);
            }
        }
        let divisor = if !variable && total {
            first_number(&line)
        } else if line != original {
            // Upstream keeps the mod list it parsed on the addition (`modListGenerated`) and, when it finds it
            // there, does not set the divisor: only the first weights generated in a session are divided by 100.
            thread_local! {
                static GENERATED: std::cell::RefCell<HashSet<(usize, String)>> = std::cell::RefCell::new(HashSet::default());
            }
            let seen = GENERATED.with(|g| !g.borrow_mut().insert((legion as *const Legion as usize, n.id.clone())));
            if variable && seen { 1.0 } else { 100.0 }
        } else {
            1.0
        };
        return vec![(vec![line], divisor)];
    }
    Vec::new()
}

/// The per-stat lines of a Legion node with several rolled stats (see `fallback_units`).
fn stat_lines(id: &str) -> Option<Vec<String>> {
    thread_local! {
        static LINES: std::cell::RefCell<Option<HashMap<String, Vec<String>>>> = const { std::cell::RefCell::new(None) };
    }
    LINES.with(|l| {
        let mut l = l.borrow_mut();
        if l.is_none() {
            let mut m: HashMap<String, Vec<String>> = HashMap::default();
            if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(include_str!("../data/timeless_stat_lines.json")) {
                for (k, v) in o {
                    if let Value::Array(a) = v {
                        m.insert(k, a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect());
                    }
                }
            }
            *l = Some(m);
        }
        l.as_ref().and_then(|m| m.get(id)).cloned()
    })
}

fn power_value(env: &crate::Env, stat: &str) -> f64 {
    let x = if stat == "FullDPS" { crate::stat_value(env, "FullDPS").or_else(|| crate::stat_value(env, "CombinedDPS")) } else { crate::stat_value(env, stat) }.unwrap_or(0.0);
    if matches!(stat, "PhysicalTakenHit" | "LightningTakenHit" | "ColdTakenHit" | "FireTakenHit" | "ChaosTakenHit") {
        -x
    } else {
        x
    }
}

/// `setupFallbackWeights`: for every node of the jewel type's list, how much the build's `stat` gains when the node's
/// mods are added, as list text (`id, primary, secondary, 0`). The mods are counted through a custom modifier block of a
/// copy of the build, so the build itself does not change.
pub fn fallback_weights(session: &mut crate::session::Session, jewel_type: i64, stat: &str) -> Result<String, String> {
    let (tree, _, _) = context(session)?;
    let legion = legion_of(tree);
    let entries = mods(tree, jewel_type);
    let base_xml = session.xml().to_string();
    let full = stat == "FullDPS";
    let base = session.eval_xml(&base_xml, full, |env| power_value(env, stat))?;
    let mut lines: Vec<String> = Vec::new();
    for e in entries.as_array().into_iter().flatten() {
        let Some(id) = e.get("id").and_then(|v| v.as_str()) else { continue };
        let total = e.get("totalMod").and_then(|v| v.as_bool()).unwrap_or(false);
        let units = fallback_units(&legion, jewel_type, id, total);
        let mut w: Vec<f64> = Vec::new();
        for (text_lines, divisor) in units.iter().take(2) {
            let xml = crate::edit_config::add_custom_block(&base_xml, "Timeless weights", &text_lines.join("\n"))?;
            let v = session.eval_xml(&xml, full, |env| power_value(env, stat))?;
            w.push(if base == 0.0 { 0.0 } else { (v - base) / base.abs() / divisor });
        }
        let w1 = w.first().copied().unwrap_or(0.0);
        let w2 = w.get(1).copied();
        if w1 != 0.0 || w2.is_some_and(|x| x != 0.0) {
            let r = |x: f64| ((x * 100.0) * 1000.0 + 0.5).floor() / 1000.0;
            lines.push(format!("{}, {}, {}, 0", id, lua_num_str(r(w1)), lua_num_str(r(w2.unwrap_or(0.0)))));
        }
    }
    Ok(lines.join("\n"))
}

/// The tree, its version and what the build contributes (allocated, granted, path distances, class starts).
pub fn context(session: &mut crate::session::Session) -> Result<(&'static TreeData, String, Ctx), String> {
    session.ensure_node_list()?;
    let xml = session.xml().to_string();
    let parsed = pom_passives::xmlspec::parse_active_spec(&xml)?;
    let version = parsed.tree_version.clone().unwrap_or_else(|| "3_29".to_string());
    let tree = crate::cached_tree(&version)?;
    let base = crate::session::nodes_in_xml(&xml)?;
    // The same stats Node Power asks for, so the calculation runs to its last stage (a shorter one would leave a partial
    // setup behind for the next edit).
    session.eval_nodes(&base, &crate::nodepower::COMBINED)?;
    let paths = session.paths()?;
    let granted = session.granted_nodes();
    Ok((tree, version, Ctx::new(&paths, &granted)))
}

/// Whether the Legion tables are installed, and where they are read from.
pub fn data_status() -> Value {
    let dir = crate::timeless_jewel_data_dir();
    match crate::timeless_jewel_data() {
        None => json!({ "installed": false, "dir": dir.to_string_lossy(), "missing": ["NodeIndexMapping.lua"] }),
        Some(d) => {
            let missing: Vec<&str> = (1..=11)
                .filter(|&t| !d.table_present(t))
                .filter_map(|t| pom_passives::timelessjewel::table_name(t).or_else(|| pom_passives::abyss::abyss_file_name(t)))
                .collect();
            json!({ "installed": missing.is_empty(), "dir": dir.to_string_lossy(), "missing": missing })
        }
    }
}

/// Lua's `tostring` of a number (`%.14g`).
pub fn lua_num_str(x: f64) -> String {
    if x == x.trunc() && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    // %.14g: 14 significant digits, trailing zeros removed, exponent form outside 1e-4..1e14.
    let e = format!("{:.13e}", x);
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if !(-4..14).contains(&exp) {
        let m = mant.trim_end_matches('0').trim_end_matches('.');
        return format!("{}e{}{:02}", m, if exp < 0 { '-' } else { '+' }, exp.abs());
    }
    let decimals = (13 - exp).max(0) as usize;
    let s = format!("{:.*}", decimals, x);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}
