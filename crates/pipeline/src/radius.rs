//! Radius jewels: the `env.radiusJewelList` half of `calcs.initEnv` (CalcSetup.lua:872-932) and the
//! per-node/`finishJewels` half of `calcs.buildModListForNode`/`buildModListForNodeList`
//! (CalcSetup.lua:112-300). A jewel's `JewelFunc` callables (`pom_item::buildmod::jewel_funcs`) run
//! against every node in its radius, then once more with no node to emit accumulated mods.
//!
//! Not ported: `ExtraJewelFunc` (Militant Faith / `override.extraJewelFuncs`), the default
//! `Self` tally function (its data feeds only tooltips), `PassiveSkillHasOtherEffect`'s
//! `NodeModifier` replacement, and keystone nodes (held aside for Perform, unaffected here).
use pom_engine::modifier::{Mod, ModType};
use pom_engine::modparser::jewelfunc::{JewelData, JewelFn, JewelKind, JewelNode, JewelOut};
use pom_engine::modparser::types::pmod_to_mod;
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_passives::node::Node;
use pom_engine::fxhash::HashSet;

pub struct RadiusJewel {
    pub nodes: HashSet<i64>,
    pub func: JewelFn,
    pub kind: JewelKind,
    pub data: JewelData,
}

/// `spec.nodes[socketId].nodesInRadius[radiusIndex]`. A cluster-jewel expansion socket (`expansionJewel.parent`) is either
/// excluded from `spec.nodes` (PassiveSpec.lua:54) or rebuilt as a synthetic socket by `BuildSubgraph` (PassiveSpec.lua:2160),
/// and neither carries the tree's precomputed `nodesInRadius`, so its radius is empty.
fn socket_radius_nodes(spec: &pom_passives::spec::PassiveSpec, socket_id: i64, idx: i64) -> HashSet<i64> {
    let Some(node) = spec.tree.node(socket_id) else { return HashSet::default() };
    if node.get("expansionJewel").and_then(|e| e.get("parent")).is_some() {
        return HashSet::default();
    }
    node.get("nodesInRadius")
        .and_then(|nr| nr.get((idx - 1).max(0) as usize))
        .and_then(|r| r.as_object())
        .map(|o| o.keys().filter_map(|k| k.parse::<i64>().ok()).collect())
        .unwrap_or_default()
}

/// `env.radiusJewelList` plus `env.extraRadiusNodeList` for the socketed jewels that have a
/// radius. `sockets` is (socket node id, item) in slot order, already filtered to allocated sockets.
pub fn collect(spec: &pom_passives::spec::PassiveSpec, sockets: &[(i64, &pom_item::Item)], game: &pom_engine::data::GameData, granted: &pom_engine::fxhash::HashSet<i64>) -> (Vec<RadiusJewel>, Vec<i64>) {
    let mut list = Vec::new();
    let mut extra: Vec<i64> = Vec::new();
    for (socket_id, item) in sockets {
        let Some(idx) = item.jewel_radius_index else { continue };
        let funcs = pom_item::buildmod::jewel_funcs(item);
        if funcs.is_empty() {
            continue;
        }
        let in_radius = socket_radius_nodes(spec, *socket_id, idx);
        for f in funcs {
            if f.kind != JewelKind::SelfAlloc {
                for id in &in_radius {
                    if spec.nodes.get(id).map_or(false, |n| !n.alloc) && !extra.contains(id) {
                        extra.push(*id);
                    }
                }
            }
            let data = JewelData { mod_source: Some(format!("Tree:{socket_id}").into()), ..Default::default() };
            list.push(RadiusJewel { nodes: in_radius.clone(), func: f.func, kind: f.kind, data });
        }
    }
    // `override.extraJewelFuncs` (CalcSetup.lua:905-931, filled from `env.modDB:Tabulate("LIST", "ExtraJewelFunc")` at
    // CalcSetup.lua:1429): "Non-Unique Jewels cause ... in a <radius> radius" mods held by allocated tree nodes. Every
    // socketed non-unique, non-relic jewel gets one radius entry per such mod, whether or not it has a radius itself.
    let mut extra_funcs: Vec<(String, pom_engine::modparser::jewelfunc::JewelFn)> = Vec::new();
    let mut node_ids: Vec<i64> = spec.nodes.values().filter(|n| n.alloc || granted.contains(&n.id)).map(|n| n.id).collect();
    node_ids.sort_unstable();
    for id in node_ids {
        for pm in spec.nodes[&id].mods.iter().filter(|m| m.name == "ExtraJewelFunc" && m.ty == "LIST") {
            let pom_engine::modparser::types::PVal::Map(fields) = &pm.value else { continue };
            let mut radius = None;
            let mut func = None;
            for (k, v) in fields {
                match (k.as_str(), v) {
                    ("radius", pom_engine::modparser::types::PVal::Str(r)) => radius = Some(r.to_string()),
                    ("func", pom_engine::modparser::types::PVal::JewelFunc(h)) => func = Some(h.0.clone()),
                    _ => {}
                }
            }
            if let (Some(r), Some(f)) = (radius, func) {
                extra_funcs.push((r, f));
            }
        }
    }
    if !extra_funcs.is_empty() {
        for (socket_id, item) in sockets {
            if item.rarity == "UNIQUE" || item.rarity == "RELIC" {
                continue;
            }
            for (label, f) in &extra_funcs {
                let idx = pom_item::parse::jewel_radius_index_for_label(game, label);
                let in_radius = idx.map(|idx| socket_radius_nodes(spec, *socket_id, idx)).unwrap_or_default();
                for id in &in_radius {
                    if spec.nodes.get(id).map_or(false, |n| !n.alloc) && !extra.contains(id) {
                        extra.push(*id);
                    }
                }
                // Both ModParser funcs open with `if node and not node.conqueredBy` (the second also filters node type).
                let inner = f.clone();
                let func: JewelFn = std::sync::Arc::new(move |node, out, data| {
                    if node.map_or(true, |n| n.conquered_by) {
                        return;
                    }
                    inner(node, out, data)
                });
                let data = JewelData { mod_source: Some(format!("Tree:{socket_id}").into()), ..Default::default() };
                list.push(RadiusJewel { nodes: in_radius, func, kind: JewelKind::Other, data });
            }
        }
    }
    extra.sort_unstable();
    (list, extra)
}

/// `PassiveSkillHasNoEffect`/`AllocatedPassiveSkillHasNoEffect` wipe, then `PassiveSkillEffect`
/// scaling through `ScaleAddList` (CalcSetup.lua:167-192).
pub fn apply_effect_scaling(mods: Vec<Mod>, alloc: bool) -> Vec<Mod> {
    let has = |n: &str| mods.iter().any(|m| m.name.as_str() == n);
    if !has("PassiveSkillEffect") && !has("PassiveSkillHasNoEffect") && !has("AllocatedPassiveSkillHasNoEffect") {
        return mods;
    }
    let mut list = ModStore::new_list(None, None);
    for m in &mods {
        list.add_mod(m.clone());
    }
    if list.flag(None, &[pom_engine::sym!("PassiveSkillHasNoEffect")]) || (alloc && list.flag(None, &[pom_engine::sym!("AllocatedPassiveSkillHasNoEffect")])) {
        return Vec::new();
    }
    if !has("PassiveSkillEffect") {
        return mods;
    }
    let sym = pom_engine::sym!("PassiveSkillEffect");
    let scale = (1.0 + list.sum(ModType::Inc, None, &[sym]) / 100.0) * list.more(None, &[sym]);
    if scale != 1.0 {
        pom_calc::perform::scale_add_list(&mods, scale)
    } else {
        mods
    }
}

/// `calcs.buildModListForNode` for one non-keystone node.
pub fn node_mod_list(node: &Node, alloc: bool, rads: &mut [RadiusJewel]) -> Vec<Mod> {
    let base: Vec<Mod> = crate::node_mods(&node.mods).to_vec();
    let mut out = JewelOut { mods: base.clone() };
    let jn = JewelNode { id: node.id, node_type: &node.kind, is_tattoo: node.is_tattoo, conquered_by: node.conquered_by.is_some(), mod_list: &base };
    let is_mastery = node.kind == "Mastery";
    for rad in rads.iter_mut() {
        // ModParser.lua:6552-6566: every jewelOtherFuncs entry returns early for nodes touched by a timeless jewel.
        if rad.kind == JewelKind::Other && !is_mastery && !jn.conquered_by && rad.nodes.contains(&node.id) {
            (rad.func)(Some(&jn), &mut out, &mut rad.data);
        }
    }
    out.mods = apply_effect_scaling(std::mem::take(&mut out.mods), alloc);
    for rad in rads.iter_mut() {
        if is_mastery || !rad.nodes.contains(&node.id) {
            continue;
        }
        let run = match rad.kind {
            JewelKind::Threshold => true,
            JewelKind::SelfAlloc => alloc,
            JewelKind::SelfUnalloc => !alloc,
            JewelKind::Other => false,
        };
        if run {
            (rad.func)(Some(&jn), &mut out, &mut rad.data);
        }
    }
    // CalcSetup.lua:218-233: `PassiveSkillHasOtherEffect` swaps the node's whole mod list for the
    // `NodeModifier` LIST mods' inner mods (Transformed notables), only when there is at least one.
    if out.mods.iter().any(|m| m.name.as_str() == "PassiveSkillHasOtherEffect") {
        let mut list = ModStore::new_list(None, None);
        for m in &out.mods {
            list.add_mod(m.clone());
        }
        if list.flag(None, &[pom_engine::sym!("PassiveSkillHasOtherEffect")]) {
            let new_mods: Vec<Mod> = out
                .mods
                .iter()
                .filter(|m| m.name.as_str() == "NodeModifier" && m.ty == ModType::List)
                .filter_map(|m| match &m.value {
                    pom_engine::value::Value::Map(fields) => fields
                        .iter()
                        .find(|(k, _)| k.as_str() == "mod")
                        .and_then(|(_, v)| if let pom_engine::value::Value::Map(inner) = v { Some(crate::actor_misc::map_to_mod(inner)) } else { None }),
                    _ => None,
                })
                .collect();
            if !new_mods.is_empty() {
                out.mods = new_mods;
            }
        }
    }
    out.mods
}

/// Runs the final `rad.func(nil, modList, rad.data)` pass over the accumulated node mod list.
pub fn finish(all: Vec<Mod>, rads: &mut [RadiusJewel]) -> Vec<Mod> {
    let mut out = JewelOut { mods: all };
    for rad in rads.iter_mut() {
        (rad.func)(None, &mut out, &mut rad.data);
    }
    out.mods
}
