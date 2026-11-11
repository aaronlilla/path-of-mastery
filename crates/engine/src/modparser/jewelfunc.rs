// Port of ModParser.lua lines 6151-6593: jewelFuncList (radius-jewel functions). The "Other"
// wrapper serves both parse time and calc time, and the guard belongs there and nowhere else.
//
// A jewelFuncList entry parses to a `JewelFunc` mod whose value carries a *callable* rather than a
// plain value (`PVal::JewelFunc`). The callable is invoked by the calc engine (not this crate) up
// to `env.radiusJewelList` size times per node in radius, plus once more with `node = None` after
// all nodes are processed (Modules/CalcSetup.lua:147-150, 196-203, 293) -- see `JewelFn`'s doc.
use crate::modifier::{Mod, ModType, Tag};
use crate::modparser::types::tag as rtag;
use crate::sym::Sym;
pub use crate::value::Value;
use crate::fxhash::HashMap;
use std::sync::Arc;

// ===== Node/Out/Data: the three things a jewel func closure touches =====

/// The subset of Classes/PassiveTree.lua's node table every jewelFuncList entry actually reads.
/// `mod_list` is that node's own already-parsed mods (Lua `node.modList`), independent of
/// whatever the `out` ModList a func is handed currently contains.
pub struct JewelNode<'a> {
    pub id: i64,
    /// Lua `node.type`: "Normal" | "Notable" | "Keystone" | "Mastery" | "Socket" | "ClassStart" |
    /// "AscendClassStart".
    pub node_type: &'a str,
    pub is_tattoo: bool,
    /// Lua `node.conqueredBy` truthiness (Classes/PassiveSpec.lua): true once a timeless jewel has
    /// already rewritten this node. Real tree nodes never have this set outside a build with a
    /// timeless jewel socketed, so it is always `false` in this port's own golden test.
    pub conquered_by: bool,
    pub mod_list: &'a [Mod],
}

/// The `out` ModList a jewel func reads from and writes to (Classes/ModList.lua). jewelFuncList
/// only ever hands a func a plain array-backed ModList (never a ModDB), so this is a small,
/// self-contained port of exactly the methods these functions call (AddMod/MergeNewMod/NewMod/
/// AddList/Sum) rather than `crate::modstore::ModStore` -- keeping this module usable standalone,
/// ahead of the calc-engine port that will eventually drive real calls through a real ModStore.
#[derive(Default, Clone, Debug)]
pub struct JewelOut {
    pub mods: Vec<Mod>,
}

pub fn sum_mods(mods: &[Mod], ty: ModType, name: &str) -> f64 {
    let name_sym = Sym::new(name);
    // Classes/ModStore.lua SumInternal with cfg=nil: no flags/keywordFlags/source filter. Mods
    // with tags are skipped here -- real Sum would evaluate them against a live calc environment
    // (calcLib.mod) that this standalone module doesn't have, but every attribute mod a tree node
    // itself carries is untagged, so this never under/over-counts on real tree data.
    mods.iter().filter(|m| m.name == name_sym && m.ty == ty && m.tags.is_empty()).filter_map(|m| m.value.num()).sum()
}

impl JewelOut {
    /// Classes/ModStore.lua `NewMod` -> `AddMod(createMod(...))`.
    pub fn add_mod(&mut self, m: Mod) {
        self.mods.push(m);
    }

    pub fn new_mod(&mut self, name: &str, ty: ModType, value: Value, source: Option<Arc<str>>, flags: u64, keyword_flags: u64, tags: Vec<Tag>) {
        self.add_mod(Mod { name: Sym::new(name), ty, value, flags, keyword_flags, source, tags: (tags).into() });
    }

    /// Classes/ModList.lua `MergeNewMod` -> `MergeMod(createMod(...))`: for BASE/INC/MORE, adds
    /// the value into the first existing mod with identical name/type/flags/keywordFlags/tags
    /// (Modules/ModTools.lua `compareModParams`); otherwise appends as a new mod.
    pub fn merge_new_mod(&mut self, name: &str, ty: ModType, value: f64, source: Option<Arc<str>>, flags: u64, keyword_flags: u64, tags: Vec<Tag>) {
        let name_sym = Sym::new(name);
        if matches!(ty, ModType::Base | ModType::Inc | ModType::More) {
            for m in self.mods.iter_mut() {
                if m.name == name_sym && m.ty == ty && m.flags == flags && m.keyword_flags == keyword_flags && *m.tags == tags {
                    if let Some(existing) = m.value.num() {
                        m.value = Value::Num(existing + value);
                        return;
                    }
                }
            }
        }
        self.add_mod(Mod { name: name_sym, ty, value: Value::Num(value), flags, keyword_flags, source, tags: (tags).into() });
    }

    pub fn add_list(&mut self, other: &[Mod]) {
        self.mods.extend_from_slice(other);
    }

    pub fn sum(&self, ty: ModType, name: &str) -> f64 {
        sum_mods(&self.mods, ty, name)
    }
}

/// The Lua `data` table a jewel func closes over across every node in one radius jewel's range,
/// reset once per jewel instance (Modules/CalcSetup.lua:261-264: `wipeTable(rad.data);
/// rad.data.modSource = ...`), never per node. Real entries only ever use a handful of shapes
/// (named numeric accumulators, one nested ModList, or -- for exactly one entry, the Raised
/// Spectre Soul Eater threshold pair -- an array of independent sub-`data` tables), so this is a
/// small fixed struct instead of a generic dynamic table.
#[derive(Default, Clone, Debug)]
pub struct JewelData {
    pub mod_source: Option<Arc<str>>,
    pub nums: HashMap<&'static str, f64>,
    pub mod_list: Option<Vec<Mod>>,
    pub func_data: Vec<JewelData>,
}

impl JewelData {
    pub fn get(&self, key: &str) -> f64 {
        *self.nums.get(key).unwrap_or(&0.0)
    }
    pub fn add(&mut self, key: &'static str, v: f64) {
        *self.nums.entry(key).or_insert(0.0) += v;
    }
    /// Lua `data[key] ~= nil`: true once any node call has touched this accumulator, even if
    /// every contribution summed to exactly zero. Distinct from `get(key) != 0.0` -- needed for
    /// the one custom function (DexIntToMeleeBonus) whose finalisation checks existence
    /// (`data.Dex or data.Int`), not magnitude, unlike `getPerStat`'s own `data[stat] ~= 0`.
    pub fn touched(&self, key: &str) -> bool {
        self.nums.contains_key(key)
    }
}

/// One radius-jewel function, called by the calc engine with the three call shapes
/// Modules/CalcSetup.lua uses:
///   - once per node in radius during the first pass, for `kind == Other` only: `func(Some(node),
///     out, data)` where `out` starts as that node's own per-node ModList.
///   - once per node in radius during the second pass, for `Self`/`SelfUnalloc`/`Threshold`
///     (gated by allocation state, which is the calc engine's job, not this closure's).
///   - once more with `node = None` after every node has been processed, to let an accumulating
///     function (getPerStat, getThreshold, "Grants all bonuses of ...") emit its final mod(s).
pub type JewelFn = Arc<dyn Fn(Option<&JewelNode>, &mut JewelOut, &mut JewelData) + Send + Sync>;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum JewelKind {
    Other,
    SelfAlloc,
    SelfUnalloc,
    Threshold,
}
impl JewelKind {
    /// Matches the Lua `type` field exactly (ModParser.lua:6570,6573,6576,6589,6591).
    pub fn as_str(self) -> &'static str {
        match self {
            JewelKind::Other => "Other",
            JewelKind::SelfAlloc => "Self",
            JewelKind::SelfUnalloc => "SelfUnalloc",
            JewelKind::Threshold => "Threshold",
        }
    }
}

/// The value of a `JewelFunc` mod (ModParser.lua:6646,6651,6582,6591: `{func = ..., type =
/// ...}`). Returned by `lookup()`; parse.rs builds the actual two-key `PVal::Map` from its
/// `kind`/`func` fields (see `JewelFuncHandle` for how the callable itself is carried inside that
/// map, since `PVal` needs a per-field wrapper, not a whole-value one -- `ExtraJewelFunc`, the
/// Militant Faith wrapping in special_a.rs, embeds the same kind of callable inside a bigger map
/// alongside a `radius` key, so the JewelFunc/ExtraJewelFunc shape can't be one fixed variant).
#[derive(Clone)]
pub struct JewelFuncVal {
    pub kind: JewelKind,
    pub func: JewelFn,
}

/// A single `PVal` field holding a raw callable (the `func` key inside a `JewelFunc` or
/// `ExtraJewelFunc` mod's value map). Renders as the literal string `"<function>"` in the golden
/// JSON comparison, matching Lua's own serializer for a function value; `PartialEq` always
/// reports equal (the callable has no meaningful structural identity there), and correctness is
/// judged separately by the jewel function behavioral test.
#[derive(Clone)]
pub struct JewelFuncHandle(pub JewelFn);
impl std::fmt::Debug for JewelFuncHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<function>")
    }
}
impl PartialEq for JewelFuncHandle {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

// ===== Real-Mod/Value constructors (runtime counterpart of special/support.rs's PVal constructors) =====

pub fn mod_to_value(m: &Mod) -> Value {
    let mut fields = vec![
        (crate::sym!("name"), Value::Str(Arc::from(m.name.as_str()))),
        (crate::sym!("type"), Value::Str(Arc::from(m.ty.as_str()))),
        (crate::sym!("value"), m.value.clone()),
        (crate::sym!("flags"), Value::Num(m.flags as f64)),
        (crate::sym!("keywordFlags"), Value::Num(m.keyword_flags as f64)),
    ];
    if let Some(s) = &m.source {
        fields.push((crate::sym!("source"), Value::Str(s.clone())));
    }
    for (i, t) in m.tags.iter().enumerate() {
        fields.push((Sym::new(&(i + 1).to_string()), tag_to_value(t)));
    }
    Value::Map(Arc::new(fields))
}
pub fn tag_to_value(t: &Tag) -> Value {
    let mut fields = vec![(crate::sym!("type"), Value::Str(Arc::from(t.kind.as_str())))];
    for (k, v) in &t.fields {
        fields.push((*k, v.clone()));
    }
    Value::Map(Arc::new(fields))
}
pub fn sv(s: &str) -> Value {
    Value::Str(Arc::from(s))
}
pub fn nv(n: f64) -> Value {
    Value::Num(n)
}
pub fn bv(b: bool) -> Value {
    Value::Bool(b)
}
pub fn list_val(items: &[&str]) -> Value {
    Value::List(Arc::new(items.iter().map(|s| Value::Str(Arc::from(*s))).collect()))
}
/// `{{0,0},{50,1}}`: a `DistanceRamp` tag's `ramp` field, a list of `{distance, value}` pairs.
pub fn ramp_val(points: &[(f64, f64)]) -> Value {
    Value::List(Arc::new(points.iter().map(|(a, b)| Value::List(Arc::new(vec![Value::Num(*a), Value::Num(*b)]))).collect()))
}
pub fn tag(kind: &str, fields: Vec<(&str, Value)>) -> Tag {
    rtag(kind, fields)
}
/// `{ mod = <inner> }`: the ExtraSkillMod/MinionModifier/NodeModifier/EnemyModifier LIST wrap.
pub fn wrap_mod(inner: Mod) -> Value {
    Value::Map(Arc::new(vec![(crate::sym!("mod"), mod_to_value(&inner))]))
}
pub fn new_mod(name: &str, ty: ModType, value: Value, source: Option<Arc<str>>, flags: u64, keyword_flags: u64, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value, flags, keyword_flags, source, tags: (tags).into() }
}
pub fn flag_true(name: &str, tags: Vec<Tag>) -> Mod {
    new_mod(name, ModType::Flag, Value::Bool(true), None, 0, 0, tags)
}

// ===== Generic constructors mirroring ModParser.lua's local helper functions =====

/// ModParser.lua:18-39 `getSimpleConv`. `src_type` is for conversions where the source stat's own
/// mod type differs from the type being converted (e.g. "increased Life" -> a BASE resistance).
pub fn get_simple_conv(
    src_list: &'static [&'static str],
    dst: &'static str,
    ty: ModType,
    remove: bool,
    factor: Option<f64>,
    src_type: Option<ModType>,
) -> JewelFn {
    get_simple_conv_dyn(src_list, Arc::from(dst), ty, remove, factor, src_type)
}

/// Same as `get_simple_conv`, but for the one call site (special_a.rs's Militant Faith "Non-Unique
/// Jewels cause..." wrapping) where the destination stat name is built from a regex capture at
/// parse time instead of being one of the fixed jewelOtherFuncs literals.
pub fn get_simple_conv_dyn(src_list: &'static [&'static str], dst: Arc<str>, ty: ModType, remove: bool, factor: Option<f64>, src_type: Option<ModType>) -> JewelFn {
    Arc::new(move |node, out, _data| {
        let Some(node) = node else { return };
        let is_attr = |s: &str| matches!(s, "Dex" | "Int" | "Str");
        for src in src_list {
            for m in node.mod_list {
                let name = m.name.as_str();
                let type_ok = match src_type {
                    Some(st) => m.ty == st,
                    None => m.ty == ty,
                };
                if name == *src && type_ok && !(node.is_tattoo && is_attr(src)) {
                    let v = m.value.num().unwrap_or(0.0);
                    if remove {
                        out.merge_new_mod(src, ty, -v, m.source.clone(), m.flags, m.keyword_flags, (m.tags.clone()).into());
                    }
                    let out_val = match factor {
                        Some(f) => (v * f).floor(),
                        None => v,
                    };
                    out.merge_new_mod(&dst, ty, out_val, m.source.clone(), m.flags, m.keyword_flags, (m.tags.clone()).into());
                }
            }
        }
    })
}

/// ModParser.lua:6369-6377 `getPerStat`.
pub fn get_per_stat(dst: &'static str, mod_type: ModType, flags: u64, stat: &'static str, factor: f64) -> JewelFn {
    Arc::new(move |node, out, data| {
        if node.is_some() {
            let v = out.sum(ModType::Base, stat);
            data.add(stat, v);
        } else if data.get(stat) != 0.0 {
            let val = (data.get(stat) * factor).floor();
            out.new_mod(dst, mod_type, Value::Num(val), data.mod_source.clone(), flags, 0, vec![]);
        }
    })
}

/// ModParser.lua:6455-6479 `getThreshold`. `attrib` is 1 or 2 stat names (Lua allows a single
/// string or a `{ "A", "B" }` table); `value`/`flags`/`keyword_flags`/`tags` are the extra
/// `mod(name, modType, value, "", ...)` arguments after the always-literal `""` source.
pub fn get_threshold(
    attrib: &'static [&'static str],
    name: &'static str,
    mod_type: ModType,
    value: Value,
    flags: u64,
    keyword_flags: u64,
    tags: Vec<Tag>,
) -> JewelFn {
    Arc::new(move |node, out, data| {
        if node.is_some() {
            for &att in attrib {
                let v = out.sum(ModType::Base, att);
                data.add(att, v);
                data.add("total", v);
            }
        } else if data.get("total") >= 40.0 {
            out.add_mod(Mod {
                name: Sym::new(name),
                ty: mod_type,
                value: value.clone(),
                flags,
                keyword_flags,
                source: data.mod_source.clone(),
                tags: (tags.clone()).into(),
            });
        }
    })
}

/// ModParser.lua:6580-6589: a threshold line whose Lua value is a `{ getThreshold(...), ... }`
/// array runs every listed func with its own independent, per-index `data.funcData[index]` sub-
/// table (each seeded with the shared `data.modSource` every call) instead of sharing one `data`.
pub fn get_threshold_multi(funcs: Vec<JewelFn>) -> JewelFn {
    Arc::new(move |node, out, data| {
        if data.func_data.len() != funcs.len() {
            data.func_data = vec![JewelData::default(); funcs.len()];
        }
        let src = data.mod_source.clone();
        for (i, f) in funcs.iter().enumerate() {
            data.func_data[i].mod_source = src.clone();
            f(node, out, &mut data.func_data[i]);
        }
    })
}

/// ModParser.lua:6420-6435,6436-6451 "Grants all bonuses of Unallocated {Small,Notable} Passive
/// Skills in Radius": accumulates every non-"Condition:ConnectedTo" mod from each matching node's
/// (already radius-processed) `out` into `data.modList`, then dumps that list into `out` on the
/// nil-node finalisation call.
pub fn grants_all_bonuses(node_type: &'static str) -> JewelFn {
    Arc::new(move |node, out, data| {
        if let Some(n) = node {
            if n.node_type == node_type {
                let list = data.mod_list.get_or_insert_with(Vec::new);
                for m in out.mods.iter() {
                    if !m.name.as_str().starts_with("Condition:ConnectedTo") {
                        list.push(m.clone());
                    }
                }
            }
        } else if let Some(list) = &data.mod_list {
            out.add_list(list);
        }
    })
}

/// ModParser.lua:6552-6571: jewelOtherFuncs' shared wrapper. Behaviorally: skip a node a
/// timeless jewel has already rewritten (`node.conqueredBy`); otherwise run the real per-node
/// function. (The Lua source's actual mechanism -- reusing one closure shape for both a parse-time
/// call with regex captures and a calc-time call with `(node, out, data)` -- is pure plumbing with
/// no behavioral effect beyond this guard.)
pub fn other_wrap(f: JewelFn) -> JewelFn {
    Arc::new(move |node, out, data| {
        if let Some(n) = node {
            if n.conquered_by {
                return;
            }
        }
        f(node, out, data)
    })
}

// ===== Table entry shape + lookup =====

/// Raw regex captures (cap1..cap5) from a jewelFuncList pattern match -- same shape as
/// `special::support::SpecialArgs`, kept separate so this module has no dependency on `special`.
pub struct JewelArgs<'a> {
    pub c: [Option<&'a str>; 5],
}
impl<'a> JewelArgs<'a> {
    pub fn n(&self, k: usize) -> f64 {
        self.c[k - 1].and_then(crate::luapat::tonumber).unwrap_or(f64::NAN)
    }
    pub fn s(&self, k: usize) -> &'a str {
        self.c[k - 1].unwrap_or("")
    }
}
pub type JewelCtor = fn(&JewelArgs) -> JewelFn;

/// A jewelFuncList entry as originally written: either a fixed, already-fully-built closure (no
/// regex captures in the pattern -- matched only via the exact whole-line hash lookup,
/// ModParser.lua:6649-6652) or a constructor needing the match's captures (matched via the
/// find()-with-captures loop, ModParser.lua:6643-6648).
pub enum JewelEntry {
    Fixed(JewelFn),
    Ctor(JewelCtor),
}

pub struct JewelTableEntry {
    pub pattern: &'static str,
    pub kind: JewelKind,
    pub entry: JewelEntry,
}

struct JewelTables {
    /// No-capture entries, keyed by their already-lowercased literal text (ModParser.lua:6649).
    exact: HashMap<&'static str, (JewelKind, JewelFn)>,
    /// Capture-bearing entries, in source order (ModParser.lua:6643-6648's `pairs()` loop order is
    /// unreplicable, but the real table's patterns have mutually exclusive tails, so source order never actually matters).
    patterns: Vec<(&'static str, JewelKind, JewelCtor)>,
}

fn build_tables() -> JewelTables {
    let mut exact = HashMap::default();
    let mut patterns = Vec::new();
    let mut all = Vec::new();
    all.extend(super::jewelfunc_other::other_part1());
    all.extend(super::jewelfunc_other::other_part2());
    all.extend(super::jewelfunc_other::self_entries());
    all.extend(super::jewelfunc_other::self_unalloc_entries());
    all.extend(super::jewelfunc_threshold::threshold_part1());
    all.extend(super::jewelfunc_threshold::threshold_part2());
    for e in all {
        match e.entry {
            JewelEntry::Fixed(f) => {
                exact.insert(e.pattern, (e.kind, f));
            }
            JewelEntry::Ctor(c) => {
                patterns.push((e.pattern, e.kind, c));
            }
        }
    }
    JewelTables { exact, patterns }
}

fn tables() -> &'static JewelTables {
    static T: std::sync::OnceLock<JewelTables> = std::sync::OnceLock::new();
    T.get_or_init(build_tables)
}

/// ModParser.lua:6640-6652, the jewelFuncList part of `parseMod`: try every capture-bearing
/// pattern first (first match wins), then fall back to the exact whole-line lookup. `line_lower`
/// must already be lowercased (matching `line:lower()` at ModParser.lua:6642).
pub fn lookup(line_lower: &[u8]) -> Option<JewelFuncVal> {
    let t = tables();
    for (pat, kind, ctor) in &t.patterns {
        if let Ok(Some(fr)) = crate::luapat::find(line_lower, pat.as_bytes(), Some(1), false) {
            if !fr.caps.is_empty() {
                let cap_strings: [Option<String>; 5] = std::array::from_fn(|i| super::scan::cap_str(&fr.caps.get(i).cloned()));
                let cap_refs: [Option<&str>; 5] = std::array::from_fn(|i| cap_strings[i].as_deref());
                let args = JewelArgs { c: cap_refs };
                let func = if *kind == JewelKind::Other { other_wrap(ctor(&args)) } else { ctor(&args) };
                return Some(JewelFuncVal { kind: *kind, func });
            }
        }
    }
    if let Ok(s) = std::str::from_utf8(line_lower) {
        if let Some((kind, f)) = t.exact.get(s) {
            return Some(JewelFuncVal { kind: *kind, func: f.clone() });
        }
    }
    None
}
