//! Tree edits beyond a plain click, as upstream's tree tab does them (`PassiveSpec.lua` SelectClass /
//! SelectAscendClass / SelectSecondaryAscendClass / IsClassConnected / ConnectToClass / ResetNodes, `PassiveTreeView`'s
//! click on a node of another ascendancy, `TreeTab:SaveMasteryPopup`, "Reset Tree/Tattoos"). Each works on the build
//! text: it changes the active `<Spec>`'s attributes and node list, and the spec build prunes what the class change
//! disconnects exactly as `BuildAllDependsAndPaths` does when upstream loads or edits a spec.

use crate::treeclick::{self, Click, TreePaths};
use pom_engine::fxhash::HashSet;

/// What stops an edit: nothing to do, or a class change that needs confirming (the target class id).
pub enum Stop {
    Nothing,
    ClassChange(i64),
}

pub type Edited = Result<String, Stop>;

fn is_start(kind: &str) -> bool {
    kind == "ClassStart" || kind == "AscendClassStart"
}

/// Byte range of the active `<Spec ...>` start tag (up to and including its `>`).
fn spec_tag(xml: &str) -> Result<std::ops::Range<usize>, String> {
    let tree_text = pom_passives::xmlspec::tree_element(xml).ok_or("missing <Tree>")?;
    let base = tree_text.as_ptr() as usize - xml.as_ptr() as usize;
    let doc = roxmltree::Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
    let tree = doc.root_element();
    let active = tree.attribute("activeSpec").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
    let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
    let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("missing <Spec>")?;
    let start = base + spec.range().start;
    let close = start + xml[start..].find('>').ok_or("bad <Spec>")?;
    Ok(start..close + 1)
}

/// `xml` with the active spec's attribute `name` set to `value`.
pub(crate) fn set_spec_attr(xml: &str, name: &str, value: &str) -> Result<String, String> {
    let r = spec_tag(xml)?;
    let tag = &xml[r.clone()];
    let key = format!(" {name}=\"");
    let new_tag = match tag.find(&key) {
        Some(i) => {
            let vs = i + key.len();
            let ve = vs + tag[vs..].find('"').ok_or("bad attribute")?;
            format!("{}{}{}", &tag[..vs], value, &tag[ve..])
        }
        None => {
            let end = if tag.ends_with("/>") { tag.len() - 2 } else { tag.len() - 1 };
            format!("{} {name}=\"{value}\"{}", &tag[..end], &tag[end..])
        }
    };
    Ok(format!("{}{}{}", &xml[..r.start], new_tag, &xml[r.end..]))
}

pub(crate) fn mastery_attr(m: &[(i64, i64)]) -> String {
    m.iter().map(|(n, e)| format!("{{{n},{e}}}")).collect::<Vec<_>>().join(",")
}

/// `xml` with the active spec's mastery choices set.
pub fn with_mastery_attr(xml: &str, m: &[(i64, i64)]) -> Result<String, String> {
    set_spec_attr(xml, "masteryEffects", &mastery_attr(m))
}

/// The build text with the given class, ascendancies, node list and mastery choices on its active spec.
pub(crate) fn compose(xml: &str, class: (i64, i64, i64), nodes: &[i64], masteries: &[(i64, i64)]) -> Result<String, String> {
    let x = set_spec_attr(xml, "classId", &class.0.to_string())?;
    let x = set_spec_attr(&x, "ascendClassId", &class.1.to_string())?;
    let x = set_spec_attr(&x, "secondaryAscendClassId", &class.2.to_string())?;
    let x = set_spec_attr(&x, "masteryEffects", &mastery_attr(masteries))?;
    crate::session::set_nodes_in_xml(&x, nodes)
}

/// The spec's own state of a text, as upstream has it after the edit: what it keeps allocated, and the mastery
/// choices of the masteries still allocated.
fn settled(xml: &str, paths: &TreePaths) -> Result<String, String> {
    let masteries: Vec<(i64, i64)> = paths.mastery_selections.iter().copied().filter(|(n, _)| paths.alloc.contains(n)).collect();
    compose(xml, (paths.class_id, paths.ascend_class_id, paths.secondary_ascend_class_id), &paths.alloc_sequence, &masteries)
}

/// `FindStartFromNode`: is there a path of allocated nodes from `node` to a start node.
fn find_start(paths: &TreePaths, node: i64, visited: &mut Vec<i64>, flag: &mut HashSet<i64>, no_ascend: bool) -> bool {
    flag.insert(node);
    visited.push(node);
    let Some(n) = paths.nodes.get(&node) else { return false };
    let node_asc = n.ascendancy.is_some();
    for &other in &n.linked {
        let start_index = visited.len();
        let Some(o) = paths.nodes.get(&other) else { continue };
        if !paths.alloc.contains(&other) {
            continue;
        }
        let reached = o.kind == "ClassStart" || o.kind == "AscendClassStart" || (!flag.contains(&other) && n.kind != "Mastery" && find_start(paths, other, visited, flag, no_ascend));
        if reached {
            if node_asc && o.ascendancy.is_none() {
                // Pathing out of Ascendant: un-visit the outside nodes.
                for v in visited.drain(start_index..) {
                    flag.remove(&v);
                }
            } else if !no_ascend || o.kind != "AscendClassStart" {
                return true;
            }
        }
    }
    false
}

/// `IsClassConnected`.
fn class_connected(paths: &TreePaths, class_id: i64) -> bool {
    let Some(start) = paths.classes.get(&class_id).and_then(|c| paths.nodes.get(&c.start_node_id)) else { return false };
    for &other in &start.linked {
        if !paths.alloc.contains(&other) {
            continue;
        }
        let mut flag = HashSet::default();
        flag.insert(other);
        let mut visited = Vec::new();
        let found = find_start(paths, other, &mut visited, &mut flag, true);
        if found {
            return true;
        }
    }
    false
}

/// `ConnectToClass`: the nodes to allocate to link the tree to the class's start node by the shortest route.
fn connect_path(paths: &TreePaths, class_id: i64) -> Option<Vec<i64>> {
    let target = paths.classes.get(&class_id)?.start_node_id;
    paths.nodes.get(&target)?;
    let main_tree = |id: i64| paths.nodes.get(&id).is_some_and(|n| n.ascendancy.is_none() && !is_start(&n.kind));
    let mut visited: HashSet<i64> = HashSet::default();
    let mut prev: pom_engine::fxhash::HashMap<i64, i64> = Default::default();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(target);
    visited.insert(target);
    let mut found = None;
    while let Some(node) = queue.pop_front() {
        let n = &paths.nodes[&node];
        if node != target && paths.alloc.contains(&node) && !is_start(&n.kind) {
            found = Some(node);
            break;
        }
        for &l in &n.linked {
            if main_tree(l) && visited.insert(l) {
                prev.insert(l, node);
                queue.push_back(l);
            }
        }
    }
    let found = found?;
    let mut back = vec![found];
    let mut cur = found;
    while cur != target {
        cur = *prev.get(&cur)?;
        back.push(cur);
    }
    Some(back[1..back.len() - 1].iter().copied().filter(|id| !paths.alloc.contains(id)).collect())
}

/// The node list without the class and ascendancy start nodes (a bloodline's start stays: it follows its own selection).
fn without_primary_starts(paths: &TreePaths, nodes: Vec<i64>) -> Vec<i64> {
    let bloodline_starts: HashSet<i64> = paths.alternate_ascendancies.values().filter_map(|a| a.start_node_id).collect();
    nodes.into_iter().filter(|id| bloodline_starts.contains(id) || !paths.nodes.get(id).is_some_and(|n| is_start(&n.kind))).collect()
}

fn current_nodes(paths: &TreePaths) -> Vec<i64> {
    paths.alloc_sequence.clone()
}

/// The mastery effect picked for a node (`SaveMasteryPopup`): the mastery is allocated along its path when it isn't, and
/// takes the effect. An effect another mastery already holds can't be assigned.
pub fn pick_mastery(xml: &str, paths: &TreePaths, node_id: i64, effect: i64) -> Result<Edited, String> {
    let Some(n) = paths.nodes.get(&node_id) else { return Ok(Err(Stop::Nothing)) };
    if n.kind != "Mastery" || !n.mastery_effects.contains(&effect) {
        return Ok(Err(Stop::Nothing));
    }
    if paths.mastery_selections.iter().any(|&(m, e)| e == effect && m != node_id) {
        return Ok(Err(Stop::Nothing));
    }
    let base = treeclick::with_node_list(xml, paths)?;
    let mut nodes = crate::session::nodes_in_xml(&base)?;
    if !paths.alloc.contains(&node_id) {
        if n.path.is_empty() {
            return Ok(Err(Stop::Nothing));
        }
        nodes = treeclick::alloc_nodes(n, &nodes, node_id);
    }
    let mut masteries: Vec<(i64, i64)> = paths.mastery_selections.iter().copied().filter(|(m, _)| *m != node_id).collect();
    masteries.push((node_id, effect));
    masteries.sort_unstable();
    Ok(Ok(compose(&base, (paths.class_id, paths.ascend_class_id, paths.secondary_ascend_class_id), &nodes, &masteries)?))
}

/// The click branch for a node of another ascendancy (`PassiveTreeView:OnKeyUp`), then the click itself.
pub fn choose_ascendancy(xml: &str, paths: &TreePaths, node_id: i64, confirm: Option<&str>, paths_for: &mut dyn FnMut(&str) -> Result<std::rc::Rc<TreePaths>, String>) -> Result<Edited, String> {
    let Some(n) = paths.nodes.get(&node_id) else { return Ok(Err(Stop::Nothing)) };
    if paths.alloc.contains(&node_id) {
        return Ok(Err(Stop::Nothing));
    }
    let base = treeclick::with_node_list(xml, paths)?;
    let nodes = crate::session::nodes_in_xml(&base)?;
    let masteries: Vec<(i64, i64)> = paths.mastery_selections.clone();
    let mut class = (paths.class_id, paths.ascend_class_id, paths.secondary_ascend_class_id);
    let mut nodes = nodes;
    if let Some(asc) = n.ascendancy.clone() {
        let bloodline = paths.alternate_ascendancies.iter().find(|(_, a)| a.internal_id.as_deref() == Some(asc.as_str())).map(|(&id, _)| id);
        if let Some(bid) = bloodline {
            if class.2 != bid {
                class.2 = bid;
            }
        } else {
            let cur_base = paths.classes.get(&class.0).and_then(|c| c.ascendancies.get(&class.1)).and_then(|a| a.internal_id.clone());
            let secondary_name = paths.alternate_ascendancies.get(&class.2).and_then(|a| a.internal_id.clone());
            let different = (class.1 == 0 || cur_base.as_deref() != Some(asc.as_str())) && secondary_name.as_deref() != Some(asc.as_str());
            if different {
                let same_class = paths.classes.get(&class.0).and_then(|c| c.ascendancies.iter().find(|(_, a)| a.internal_id.as_deref() == Some(asc.as_str())).map(|(&id, _)| id));
                if let Some(aid) = same_class {
                    class.1 = aid;
                } else {
                    let mut target = None;
                    let mut ids: Vec<&i64> = paths.classes.keys().collect();
                    ids.sort();
                    'find: for &cid in ids {
                        let c = &paths.classes[&cid];
                        let mut aids: Vec<&i64> = c.ascendancies.keys().collect();
                        aids.sort();
                        for &aid in aids {
                            if c.ascendancies[&aid].internal_id.as_deref() == Some(asc.as_str()) {
                                target = Some((cid, aid));
                                break 'find;
                            }
                        }
                    }
                    if let Some((cid, aid)) = target {
                        let used = paths.alloc.iter().filter(|id| paths.nodes.get(id).is_some_and(|m| !is_start(&m.kind) && m.ascendancy.is_none())).count();
                        if used == 0 || class_connected(paths, cid) {
                            class = (cid, aid, class.2);
                        } else {
                            match confirm {
                                None => return Ok(Err(Stop::ClassChange(cid))),
                                Some("reset") => class = (cid, aid, class.2),
                                Some("connect") => match connect_path(paths, cid) {
                                    Some(add) => {
                                        for id in add {
                                            if !nodes.contains(&id) {
                                                nodes.push(id);
                                            }
                                        }
                                        class = (cid, aid, class.2);
                                    }
                                    None => return Ok(Err(Stop::Nothing)),
                                },
                                Some(_) => return Ok(Err(Stop::Nothing)),
                            }
                        }
                    }
                }
            }
        }
    }
    // The switched spec, as upstream has it after SelectClass/SelectAscendClass (what they disconnect is gone).
    let nodes = without_primary_starts(paths, nodes);
    let switched = compose(&base, class, &nodes, &masteries)?;
    let p2 = paths_for(&switched)?;
    let settled_xml = settled(&switched, &p2)?;
    let p3 = paths_for(&settled_xml)?;
    match treeclick::click(&p3, &current_nodes(&p3), node_id) {
        Click::Nodes(list) => Ok(Ok(crate::session::set_nodes_in_xml(&settled_xml, &list)?)),
        _ => Ok(Err(Stop::Nothing)),
    }
}

/// The class and ascendancy dropdowns.
pub fn set_class(xml: &str, paths: &TreePaths, class_id: i64, ascend: Option<i64>, secondary: Option<i64>, paths_for: &mut dyn FnMut(&str) -> Result<std::rc::Rc<TreePaths>, String>) -> Result<Edited, String> {
    if !paths.classes.contains_key(&class_id) {
        return Ok(Err(Stop::Nothing));
    }
    let base = treeclick::with_node_list(xml, paths)?;
    let nodes = crate::session::nodes_in_xml(&base)?;
    let a = if class_id != paths.class_id { ascend.unwrap_or(0) } else { ascend.unwrap_or(paths.ascend_class_id) };
    // `SelectClass` leaves the secondary (bloodline) ascendancy as it is.
    let sec = secondary.unwrap_or(paths.secondary_ascend_class_id);
    // The spec allocates the start nodes of the new selection itself.
    let nodes = without_primary_starts(paths, nodes);
    let switched = compose(&base, (class_id, a, sec), &nodes, &paths.mastery_selections)?;
    let p2 = paths_for(&switched)?;
    Ok(Ok(settled(&switched, &p2)?))
}

/// `ResetNodes`: every node and mastery choice off, the class and ascendancy starts kept.
pub fn reset_tree(xml: &str, paths: &TreePaths) -> Result<Edited, String> {
    let base = treeclick::with_node_list(xml, paths)?;
    let keep: Vec<i64> = paths.alloc_sequence.iter().copied().filter(|id| paths.nodes.get(id).is_some_and(|n| is_start(&n.kind))).collect();
    Ok(Ok(compose(&base, (paths.class_id, paths.ascend_class_id, paths.secondary_ascend_class_id), &keep, &[])?))
}

/// One tattoo of the active spec's `<Overrides>` (`PassiveSpec:Save` writes node id, icon, effect image and name as
/// attributes and the stat lines as the element's text).
fn override_entry(node_id: i64, dn: &str, icon: &str, effect_image: &str, sd: &[String]) -> String {
    let e = crate::edit::esc;
    let lines: String = sd.iter().map(|l| format!("\n\t\t\t\t\t{}", e(l))).collect();
    format!("<Override activeEffectImage=\"{}\" dn=\"{}\" icon=\"{}\" nodeId=\"{node_id}\">{lines}\n\t\t\t\t</Override>", e(effect_image), e(dn), e(icon))
}

/// `TreeTab:ModifyNodePopup`'s Add and Reset Node: the tattoo `tattoo` (a key of the tree's tattoo table) replaces the
/// modifier of the node, or `None` takes the node's tattoo off (`RemoveTattooFromNode`). Upstream's data guarantees which
/// tattoos fit a node, so only the key and the node are checked: a key the tree doesn't have and a node the tree doesn't have are
/// refused with a message, and the 50-tattoo limit is shown but not enforced, as upstream does.
pub fn set_tattoo(xml: &str, paths: &TreePaths, node_id: i64, tattoo: Option<&str>) -> Result<Edited, String> {
    let parsed = pom_passives::xmlspec::parse_active_spec(xml)?;
    let current = parsed.overrides.iter().rev().find(|o| o.node_id == node_id);
    let new_entry = match tattoo {
        Some(key) => {
            if !paths.nodes.contains_key(&node_id) {
                return Err(format!("node {node_id} is not in the passive tree"));
            }
            let tree = crate::cached_tree(parsed.tree_version.as_deref().unwrap_or("3_29"))?;
            let table = tree.section("tattoo");
            let Some(t) = table.as_ref().and_then(|t| t.get("nodes")).and_then(|n| n.get(key)) else {
                return Err(format!("no tattoo \"{key}\" in this tree"));
            };
            let text = |k: &str| t.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let sd: Vec<String> = t.get("sd").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let (dn, icon, image) = (text("dn"), text("icon"), text("activeEffectImage"));
            if current.is_some_and(|c| c.dn == dn && c.icon == icon && c.active_effect_image == image && c.sd == sd) {
                return Ok(Err(Stop::Nothing));
            }
            Some(override_entry(node_id, &dn, &icon, &image, &sd))
        }
        None => {
            if current.is_none() {
                return Ok(Err(Stop::Nothing));
            }
            None
        }
    };
    // The active spec and its overrides, by byte range in `xml`.
    let tree_text = pom_passives::xmlspec::tree_element(xml).ok_or("missing <Tree>")?;
    let base = tree_text.as_ptr() as usize - xml.as_ptr() as usize;
    let doc = roxmltree::Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
    let tree = doc.root_element();
    let active = tree.attribute("activeSpec").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
    let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
    let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("missing <Spec>")?;
    let mut out = xml.to_string();
    // Take the node's old override out, whichever way it was written.
    let mut doomed: Vec<std::ops::Range<usize>> = Vec::new();
    for o in spec.children().filter(|c| c.has_tag_name("Overrides")) {
        for ov in o.children().filter(|c| c.has_tag_name("Override")) {
            if ov.attribute("nodeId").and_then(|v| v.parse::<i64>().ok()) == Some(node_id) {
                let mut r = (base + ov.range().start)..(base + ov.range().end);
                while r.start > 0 && xml.as_bytes()[r.start - 1].is_ascii_whitespace() {
                    r.start -= 1;
                }
                doomed.push(r);
            }
        }
    }
    for r in doomed.into_iter().rev() {
        out.replace_range(r, "");
    }
    let Some(entry) = new_entry else { return Ok(Ok(out)) };
    // Offsets moved with the removals: find the spec again in the new text.
    let tree_text = pom_passives::xmlspec::tree_element(&out).ok_or("missing <Tree>")?;
    let base = tree_text.as_ptr() as usize - out.as_ptr() as usize;
    let doc = roxmltree::Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
    let tree = doc.root_element();
    let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
    let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("missing <Spec>")?;
    let spec_start = base + spec.range().start;
    let spec_end = base + spec.range().end;
    let ov_el = spec.children().find(|c| c.has_tag_name("Overrides"));
    match ov_el {
        Some(o) => {
            let (a, b) = (base + o.range().start, base + o.range().end);
            if out[a..b].ends_with("/>") {
                out.replace_range(a..b, &format!("<Overrides>\n\t\t\t\t{entry}\n\t\t\t</Overrides>"));
            } else {
                let mut at = b - "</Overrides>".len();
                while at > a && out.as_bytes()[at - 1].is_ascii_whitespace() {
                    at -= 1;
                }
                out.insert_str(at, &format!("\n\t\t\t\t{entry}"));
            }
        }
        None => {
            let open_end = spec_start + out[spec_start..spec_end].find('>').ok_or("bad <Spec>")? + 1;
            if out[spec_start..open_end].ends_with("/>") {
                let head = out[spec_start..open_end - 2].to_string();
                out.replace_range(spec_start..open_end, &format!("{head}>\n\t\t\t<Overrides>\n\t\t\t\t{entry}\n\t\t\t</Overrides>\n\t\t</Spec>"));
            } else {
                let close = spec_end - "</Spec>".len();
                out.insert_str(close, &format!("\t<Overrides>\n\t\t\t\t{entry}\n\t\t\t</Overrides>\n\t\t"));
            }
        }
    }
    Ok(Ok(out))
}

/// "Remove All Tattoos": the active spec's overrides emptied.
pub fn reset_tattoos(xml: &str) -> Result<Edited, String> {
    let r = spec_tag(xml)?;
    let tree_end = xml[r.end..].find("</Spec>").map(|i| r.end + i).ok_or("missing </Spec>")?;
    let body = &xml[r.end..tree_end];
    let Some(a) = body.find("<Overrides") else { return Ok(Ok(xml.to_string())) };
    let a_abs = r.end + a;
    let open_end = a_abs + xml[a_abs..].find('>').ok_or("bad <Overrides>")? + 1;
    if xml[a_abs..open_end].ends_with("/>") {
        return Ok(Ok(xml.to_string()));
    }
    let close = open_end + xml[open_end..].find("</Overrides>").ok_or("missing </Overrides>")?;
    Ok(Ok(format!("{}{}", &xml[..open_end], &xml[close..])))
}
