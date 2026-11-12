//! Skill edits for the Skills tab: skill sets, socket groups and gems, as XML edits (`edit.rs` style). Only the
//! `<Skills>` element is rewritten (its children are kept as the text they were, except the one being changed), plus
//! the `<Build mainSocketGroup>` and `<Calcs><Input name="skill_number">` numbers when a group moves, as
//! `SkillListControl:OnOrderChange`/`OnSelDelete` keep them.
use crate::edit::{append_child, elements, esc, parse, splice, start_tag};
use pom_engine::data::gems::GemData;
use pom_skills::data;
use roxmltree::Node;
use serde_json::Value;

/// Edit kinds this module handles.
pub fn handles(kind: &str) -> bool {
    matches!(
        kind,
        "skillSet" | "addGroup" | "removeGroup" | "removeAllGroups" | "moveGroup" | "addGem" | "removeGem" | "moveGem" | "orderGems" | "setGemSkill" | "setMainGroup" | "setMainActiveSkill" | "setSkillsOption" | "addSourceGroups"
    )
}

/// An element as the edits see it: attributes in order, children as the text they were.
#[derive(Clone, Debug)]
pub struct El {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub kids: Vec<String>,
}

impl El {
    fn new(name: &str) -> El {
        El { name: name.to_string(), attrs: Vec::new(), kids: Vec::new() }
    }
    fn from_node(xml: &str, n: Node) -> El {
        let kids = n.children().filter(|c| c.is_element()).map(|c| xml[c.range()].to_string()).collect();
        El { name: n.tag_name().name().to_string(), attrs: n.attributes().map(|a| (a.name().to_string(), a.value().to_string())).collect(), kids }
    }
    fn from_text(text: &str) -> Result<El, String> {
        let doc = parse(text)?;
        Ok(El::from_node(text, doc.root_element()))
    }
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    fn set(&mut self, name: &str, value: Option<&str>) {
        match (self.attrs.iter().position(|(k, _)| k == name), value) {
            (Some(i), Some(v)) => self.attrs[i].1 = v.to_string(),
            (Some(i), None) => {
                self.attrs.remove(i);
            }
            (None, Some(v)) => self.attrs.push((name.to_string(), v.to_string())),
            (None, None) => {}
        }
    }
    fn open(&self) -> String {
        let mut s = format!("<{}", self.name);
        for (k, v) in &self.attrs {
            s.push_str(&format!(" {k}=\"{}\"", esc(v)));
        }
        s
    }
    fn to_xml(&self) -> String {
        if self.kids.is_empty() {
            format!("{}/>", self.open())
        } else {
            format!("{}>{}</{}>", self.open(), self.kids.concat(), self.name)
        }
    }
}

/// `<Skills>` with its sets. A legacy file keeps `<Skill>` directly under `<Skills>`: those become `<SkillSet id="1">`
/// (the loader reads them as set 1 already).
struct SkillsDoc {
    skills: El,
    /// The `<SkillSet>` elements, in order.
    sets: Vec<El>,
    /// Other children of `<Skills>`, kept after the sets.
    other: Vec<String>,
}

impl SkillsDoc {
    fn from_text(skills: Option<&str>) -> Result<SkillsDoc, String> {
        let Some(text) = skills else {
            let mut set = El::new("SkillSet");
            set.set("id", Some("1"));
            let mut skills = El::new("Skills");
            skills.set("activeSkillSet", Some("1"));
            return Ok(SkillsDoc { skills, sets: vec![set], other: Vec::new() });
        };
        let mut el = El::from_text(text)?;
        let mut sets: Vec<El> = Vec::new();
        let mut other = Vec::new();
        let mut bare: Option<El> = None;
        for k in std::mem::take(&mut el.kids) {
            let child = El::from_text(&k)?;
            match child.name.as_str() {
                "SkillSet" => sets.push(child),
                "Skill" => {
                    let b = bare.get_or_insert_with(|| {
                        let mut s = El::new("SkillSet");
                        s.set("id", Some("1"));
                        s
                    });
                    b.kids.push(k);
                }
                _ => other.push(k),
            }
        }
        if let Some(b) = bare {
            sets.retain(|s| s.attr("id") != Some("1"));
            sets.insert(0, b);
        }
        if sets.is_empty() {
            let mut set = El::new("SkillSet");
            set.set("id", Some("1"));
            sets.push(set);
        }
        Ok(SkillsDoc { skills: el, sets, other })
    }

    fn set_id(s: &El) -> i64 {
        s.attr("id").and_then(|v| v.parse().ok()).unwrap_or(1)
    }

    /// Index of the active set (`SetActiveSkillSet`: the saved id, else the first).
    fn active(&self) -> usize {
        let id: i64 = self.skills.attr("activeSkillSet").and_then(|v| v.parse().ok()).unwrap_or(1);
        self.sets.iter().position(|s| Self::set_id(s) == id).unwrap_or(0)
    }

    fn to_xml(&self) -> String {
        let mut el = self.skills.clone();
        el.kids = self.sets.iter().map(|s| s.to_xml()).chain(self.other.iter().cloned()).collect();
        el.to_xml()
    }
}

/// What the Skills tab shows of `<Skills>`: the `<Skills>` attributes, each set's id, title and group count, the active
/// set's id and its groups' elements (attributes and gem texts).
pub struct SkillsView {
    pub skills: El,
    pub sets: Vec<(i64, Option<String>, usize)>,
    pub active_id: i64,
    pub groups: Vec<El>,
}

pub fn skills_view(xml: &str) -> Result<SkillsView, String> {
    let doc_x = parse(xml)?;
    let skills_text = elements(doc_x.root_element(), "Skills").next().map(|n| &xml[n.range()]);
    let doc = SkillsDoc::from_text(skills_text)?;
    let ai = doc.active();
    let sets = doc.sets.iter().map(|s| (SkillsDoc::set_id(s), s.attr("title").map(|t| t.to_string()), s.kids.len())).collect();
    let groups = doc.sets[ai].kids.iter().map(|k| El::from_text(k)).collect::<Result<Vec<_>, _>>()?;
    Ok(SkillsView { skills: doc.skills.clone(), sets, active_id: SkillsDoc::set_id(&doc.sets[ai]), groups })
}

impl El {
    /// The element's child elements parsed (a group's `<Gem>`s).
    pub fn children(&self) -> Vec<El> {
        self.kids.iter().filter_map(|k| El::from_text(k).ok()).collect()
    }
}

fn group_el(set: &El, group: usize) -> Result<El, String> {
    El::from_text(set.kids.get(group.wrapping_sub(1)).ok_or("no such socket group")?)
}

fn editable(g: &El) -> Result<(), String> {
    if g.attr("source").is_some() {
        return Err("This socket group is created by an equipped item and cannot be changed.".into());
    }
    Ok(())
}

/// The numbers of the build's main socket group and the calcs tab's chosen skill, as `Build.lua` and `CalcsTab.lua`
/// keep them. Both are 1-based group indices.
struct Mains {
    main: i64,
    calcs: Option<i64>,
}

fn read_mains(xml: &str) -> Mains {
    let Ok(doc) = parse(xml) else { return Mains { main: 1, calcs: None } };
    let root = doc.root_element();
    let main = elements(root, "Build").next().and_then(|b| b.attribute("mainSocketGroup")).and_then(|v| v.parse().ok()).unwrap_or(1);
    let calcs = elements(root, "Calcs").next().and_then(|c| elements(c, "Input").find(|i| i.attribute("name") == Some("skill_number"))).and_then(|i| i.attribute("number")).and_then(|v| v.parse().ok());
    Mains { main, calcs }
}

fn write_mains(xml: &str, m: &Mains, old: &Mains) -> Result<String, String> {
    let mut out = xml.to_string();
    if m.main != old.main {
        out = set_build_attr(&out, "mainSocketGroup", &m.main.to_string())?;
    }
    if m.calcs != old.calcs {
        if let Some(n) = m.calcs {
            out = set_calcs_skill_number(&out, n)?;
        }
    }
    Ok(out)
}

fn set_build_attr(xml: &str, attr: &str, value: &str) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let Some(build) = elements(root, "Build").next() else { return Err("no <Build>".into()) };
    let mut el = El::from_node(xml, build);
    let tag = start_tag(xml, build);
    let self_closing = xml[tag.clone()].ends_with("/>");
    el.set(attr, Some(value));
    let open = el.open();
    Ok(splice(xml, tag, &format!("{open}{}", if self_closing { "/>" } else { ">" })))
}

fn set_calcs_skill_number(xml: &str, n: i64) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let input = format!("<Input name=\"skill_number\" number=\"{n}\"/>");
    let Some(calcs) = elements(root, "Calcs").next() else {
        return Ok(append_child(xml, root, &format!("<Calcs>{input}</Calcs>")));
    };
    if let Some(i) = elements(calcs, "Input").find(|i| i.attribute("name") == Some("skill_number")) {
        return Ok(splice(xml, i.range(), &input));
    }
    Ok(append_child(xml, calcs, &input))
}

/// `SkillListClass:OnOrderChange` for an index (main skill group or calcs skill number).
fn reorder_index(idx: i64, from: i64, to: i64) -> i64 {
    if idx == from {
        to
    } else if idx > from && idx <= to {
        idx - 1
    } else if idx < from && idx >= to {
        idx + 1
    } else {
        idx
    }
}

/// A group was inserted at `at`: later groups shift down by one.
fn index_after_insert(idx: i64, at: i64) -> i64 {
    if idx >= at {
        idx + 1
    } else {
        idx
    }
}

/// A group was deleted at `at` (`OnSelDelete`'s `updateActiveSocketGroupIndex`).
fn index_after_delete(idx: i64, at: i64) -> i64 {
    if idx > at {
        idx - 1
    } else {
        idx
    }
}

/// `SkillsTab:ProcessGemLevel`.
fn default_level(gem: &'static GemData, mode: &str, char_level: f64) -> f64 {
    let ge = data::gem_primary_effect(gem);
    let natural = gem.natural_max_level.unwrap_or(20) as f64;
    match mode {
        "levelOne" => 1.0,
        "awakenedMaximum" => natural + 1.0,
        "corruptedMaximum" => {
            if ge.is_some_and(|g| data::extra(g, "plusVersionOf").is_some()) {
                natural
            } else {
                natural + 1.0
            }
        }
        "characterLevel" => {
            let Some(ge) = ge else { return natural };
            let mut max = natural as usize;
            if max == 0 || max > ge.levels.len() {
                max = ge.levels.len();
            }
            for l in (1..=max).rev() {
                if ge.levels[l - 1].level_requirement.unwrap_or(0.0) <= char_level {
                    return l as f64;
                }
            }
            1.0
        }
        _ => natural,
    }
}

struct Opts {
    level_mode: String,
    quality: f64,
    char_level: f64,
}

fn read_opts(skills: &El, xml: &str) -> Opts {
    let level_mode = match skills.attr("defaultGemLevel") {
        Some(v) if v.parse::<f64>().is_err() => v.to_string(),
        _ if skills.attr("matchGemLevelToCharacterLevel") == Some("true") => "characterLevel".to_string(),
        _ => "normalMaximum".to_string(),
    };
    let quality = skills.attr("defaultGemQuality").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0).clamp(0.0, 23.0);
    let char_level = parse(xml).ok().and_then(|d| elements(d.root_element(), "Build").next().and_then(|b| b.attribute("level")).and_then(|v| v.parse().ok())).unwrap_or(1.0);
    Opts { level_mode, quality, char_level }
}

fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn gem_by_id(id: &str) -> Result<&'static GemData, String> {
    data::game_data().gems.get(id).ok_or_else(|| format!("unknown gem {id}"))
}

/// A `<Gem>` as `SkillsTab:Save` writes it.
fn gem_el(gem: &'static GemData, level: f64, quality: f64, enabled: bool, count: i64) -> El {
    let mut e = El::new("Gem");
    let b = |v: bool| if v { "true" } else { "false" };
    e.attrs.push(("nameSpec".into(), gem.name.clone().unwrap_or_default()));
    if let Some(s) = &gem.granted_effect_id {
        e.attrs.push(("skillId".into(), s.clone()));
    }
    if let Some(s) = &gem.game_id {
        e.attrs.push(("gemId".into(), s.clone()));
    }
    if let Some(s) = &gem.variant_id {
        e.attrs.push(("variantId".into(), s.clone()));
    }
    e.attrs.push(("level".into(), num(level)));
    e.attrs.push(("quality".into(), num(quality)));
    e.attrs.push(("enabled".into(), b(enabled).into()));
    e.attrs.push(("enableGlobal1".into(), "true".into()));
    e.attrs.push(("enableGlobal2".into(), "false".into()));
    e.attrs.push(("count".into(), count.to_string()));
    e
}

fn gem_from_spec(spec: &Value, opts: &Opts) -> Result<El, String> {
    let id = spec.get("gemId").and_then(|v| v.as_str()).ok_or("gem needs gemId")?;
    let gem = gem_by_id(id)?;
    let level = spec.get("level").and_then(|v| v.as_f64()).unwrap_or_else(|| default_level(gem, &opts.level_mode, opts.char_level));
    let quality = spec.get("quality").and_then(|v| v.as_f64()).unwrap_or(opts.quality);
    let enabled = spec.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let count = spec.get("count").and_then(|v| v.as_i64()).unwrap_or(1);
    Ok(gem_el(gem, level, quality, enabled, count))
}

fn new_group(spec: Option<&Value>, opts: &Opts) -> Result<El, String> {
    let mut g = El::new("Skill");
    let get_s = |k: &str| spec.and_then(|s| s.get(k)).and_then(|v| v.as_str());
    let get_b = |k: &str, d: bool| spec.and_then(|s| s.get(k)).and_then(|v| v.as_bool()).unwrap_or(d);
    g.attrs.push(("enabled".into(), get_b("enabled", true).to_string()));
    g.attrs.push(("includeInFullDPS".into(), get_b("includeInFullDPS", false).to_string()));
    g.attrs.push(("label".into(), get_s("label").unwrap_or("").to_string()));
    if let Some(slot) = get_s("slot").filter(|s| !s.is_empty() && *s != "None") {
        g.attrs.push(("slot".into(), slot.to_string()));
    }
    g.attrs.push(("mainActiveSkill".into(), "1".into()));
    g.attrs.push(("mainActiveSkillCalcs".into(), "1".into()));
    if let (Some(imb), true) = (get_s("imbuedSupport").filter(|s| !s.is_empty()), g.attr("slot").is_some()) {
        g.attrs.push(("imbuedSupport".into(), imb.to_string()));
    }
    if let Some(gems) = spec.and_then(|s| s.get("gems")).and_then(|v| v.as_array()) {
        for gem in gems {
            g.kids.push(gem_from_spec(gem, opts)?.to_xml());
        }
    }
    Ok(g)
}

fn idx(edit: &Value, k: &str) -> Result<usize, String> {
    edit.get(k).and_then(|v| v.as_u64()).map(|v| v as usize).ok_or_else(|| format!("edit needs {k}"))
}

fn parse_gems(g: &El) -> Result<Vec<El>, String> {
    g.kids.iter().map(|k| El::from_text(k)).collect()
}

fn unparse_gems(g: &mut El, gems: Vec<El>) {
    g.kids = gems.iter().map(|e| e.to_xml()).collect();
}

fn new_set_id(doc: &SkillsDoc) -> i64 {
    doc.sets.iter().map(SkillsDoc::set_id).max().unwrap_or(0) + 1
}

/// Applies a skill edit to the build text. `Ok(None)` when `edit` is not one of this module's kinds.
pub fn skills_edit(xml: &str, edit: &Value) -> Result<Option<String>, String> {
    let kind = edit.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if !handles(kind) {
        return Ok(None);
    }
    let old = read_mains(xml);
    let mut mains = Mains { main: old.main, calcs: old.calcs };
    let doc_x = parse(xml)?;
    let root = doc_x.root_element();
    let skills_text = elements(root, "Skills").next().map(|n| &xml[n.range()]);
    let mut doc = SkillsDoc::from_text(skills_text)?;
    let ai = doc.active();
    let opts = read_opts(&doc.skills, xml);
    let mut out_xml: Option<String> = None;
    match kind {
        "skillSet" => {
            let op = edit.get("op").and_then(|v| v.as_str()).unwrap_or("");
            let id = edit.get("id").and_then(|v| v.as_i64());
            let find = |doc: &SkillsDoc| -> Result<usize, String> {
                let id = id.ok_or("edit needs id")?;
                doc.sets.iter().position(|s| SkillsDoc::set_id(s) == id).ok_or_else(|| "no such skill set".to_string())
            };
            match op {
                "activate" => {
                    let i = find(&doc)?;
                    let sid = SkillsDoc::set_id(&doc.sets[i]);
                    doc.skills.set("activeSkillSet", Some(&sid.to_string()));
                }
                "new" => {
                    let nid = new_set_id(&doc);
                    let mut s = El::new("SkillSet");
                    s.set("id", Some(&nid.to_string()));
                    if let Some(t) = edit.get("title").and_then(|v| v.as_str()) {
                        s.set("title", Some(t));
                    }
                    doc.sets.push(s);
                }
                "copy" => {
                    let i = find(&doc)?;
                    let nid = new_set_id(&doc);
                    let mut s = doc.sets[i].clone();
                    s.set("id", Some(&nid.to_string()));
                    let title = edit.get("title").and_then(|v| v.as_str()).map(|t| t.to_string()).or_else(|| s.attr("title").map(|t| format!("{t} (copy)")));
                    s.set("title", title.as_deref());
                    doc.sets.push(s);
                }
                "delete" => {
                    let i = find(&doc)?;
                    if doc.sets.len() < 2 {
                        return Err("A build needs at least one skill set.".into());
                    }
                    let was_active = i == ai;
                    doc.sets.remove(i);
                    if was_active {
                        let ni = i.saturating_sub(1).min(doc.sets.len() - 1);
                        let sid = SkillsDoc::set_id(&doc.sets[ni]);
                        doc.skills.set("activeSkillSet", Some(&sid.to_string()));
                    }
                }
                "rename" => {
                    let i = find(&doc)?;
                    let t = edit.get("title").and_then(|v| v.as_str()).ok_or("edit needs title")?;
                    doc.sets[i].set("title", if t.is_empty() { None } else { Some(t) });
                }
                "move" => {
                    let i = find(&doc)?;
                    let to = idx(edit, "to")?.clamp(1, doc.sets.len()) - 1;
                    let s = doc.sets.remove(i);
                    doc.sets.insert(to, s);
                }
                other => return Err(format!("unknown skill set op {other:?}")),
            }
            // Activating a set changes which groups `mainSocketGroup` points into; the number itself is the build's.
        }
        "addGroup" => {
            let g = new_group(edit.get("group"), &opts)?;
            let set = &mut doc.sets[ai];
            let n = set.kids.len();
            let at = edit.get("at").and_then(|v| v.as_u64()).map(|v| (v as usize).clamp(1, n + 1)).unwrap_or(n + 1);
            set.kids.insert(at - 1, g.to_xml());
            if at <= n {
                mains.main = index_after_insert(mains.main, at as i64);
                mains.calcs = mains.calcs.map(|c| index_after_insert(c, at as i64));
            }
        }
        "removeGroup" => {
            let gi = idx(edit, "group")?;
            let set = &mut doc.sets[ai];
            let g = group_el(set, gi)?;
            editable(&g).map_err(|_| "This socket group cannot be deleted as it is created by an equipped item.".to_string())?;
            set.kids.remove(gi - 1);
            mains.main = index_after_delete(mains.main, gi as i64);
            mains.calcs = mains.calcs.map(|c| index_after_delete(c, gi as i64));
        }
        "removeAllGroups" => {
            doc.sets[ai].kids.clear();
        }
        "moveGroup" => {
            let from = idx(edit, "from")?;
            let set = &mut doc.sets[ai];
            let n = set.kids.len();
            if from == 0 || from > n {
                return Err("no such socket group".into());
            }
            let to = idx(edit, "to")?.clamp(1, n);
            let k = set.kids.remove(from - 1);
            set.kids.insert(to - 1, k);
            mains.main = reorder_index(mains.main, from as i64, to as i64);
            mains.calcs = mains.calcs.map(|c| reorder_index(c, from as i64, to as i64));
        }
        "addGem" | "removeGem" | "moveGem" | "orderGems" | "setGemSkill" => {
            let gi = idx(edit, "group")?;
            let set = &mut doc.sets[ai];
            let mut g = group_el(set, gi)?;
            editable(&g)?;
            let mut gems = parse_gems(&g)?;
            match kind {
                "addGem" => {
                    let e = gem_from_spec(edit.get("gem").ok_or("edit needs gem")?, &opts)?;
                    let at = edit.get("at").and_then(|v| v.as_u64()).map(|v| (v as usize).clamp(1, gems.len() + 1)).unwrap_or(gems.len() + 1);
                    gems.insert(at - 1, e);
                }
                "removeGem" => {
                    let n = idx(edit, "gem")?;
                    if n == 0 || n > gems.len() {
                        return Err("no such gem".into());
                    }
                    gems.remove(n - 1);
                }
                "moveGem" => {
                    let from = idx(edit, "from")?;
                    if from == 0 || from > gems.len() {
                        return Err("no such gem".into());
                    }
                    let to = idx(edit, "to")?.clamp(1, gems.len());
                    let e = gems.remove(from - 1);
                    gems.insert(to - 1, e);
                }
                "orderGems" => {
                    let order: Vec<usize> = edit.get("order").and_then(|v| v.as_array()).ok_or("edit needs order")?.iter().filter_map(|v| v.as_u64().map(|x| x as usize)).collect();
                    let mut seen = vec![false; gems.len()];
                    if order.len() != gems.len() || order.iter().any(|&o| o == 0 || o > gems.len() || std::mem::replace(&mut seen[o - 1], true)) {
                        return Err("order must list every gem once".into());
                    }
                    let old = gems.clone();
                    gems = order.iter().map(|&o| old[o - 1].clone()).collect();
                }
                _ => {
                    let n = idx(edit, "gem")?;
                    if n == 0 || n > gems.len() {
                        return Err("no such gem".into());
                    }
                    let id = edit.get("gemId").and_then(|v| v.as_str()).ok_or("edit needs gemId")?;
                    let gem = gem_by_id(id)?;
                    let old = &gems[n - 1];
                    // A new gem takes the default level (SkillsTab.lua: `gemInstance.level = self:ProcessGemLevel(gemInstance.gemData)`);
                    // quality, enabled and count stay with the row.
                    let level = default_level(gem, &opts.level_mode, opts.char_level);
                    let quality: f64 = old.attr("quality").and_then(|v| v.parse().ok()).unwrap_or(0.0);
                    let enabled = old.attr("enabled") != Some("false");
                    let count: i64 = old.attr("count").and_then(|v| v.parse().ok()).unwrap_or(1);
                    gems[n - 1] = gem_el(gem, level, quality, enabled, count);
                }
            }
            unparse_gems(&mut g, gems);
            set.kids[gi - 1] = g.to_xml();
        }
        "setMainGroup" => {
            let gi = idx(edit, "group")?;
            if gi == 0 || gi > doc.sets[ai].kids.len() {
                return Err("no such socket group".into());
            }
            mains.main = gi as i64;
            // The calcs tab follows the main skill (`CalcsTab` takes the build's main group on load).
            if mains.calcs.is_some() {
                mains.calcs = Some(gi as i64);
            }
        }
        // Saves item- or node-granted groups the calculation added (see `tabdata_skills::skills_state_with`), as the
        // original saves them: appended to the set as `<Skill source=...>` with the granted skill's gem.
        "addSourceGroups" => {
            let list = edit.get("groups").and_then(|v| v.as_array()).ok_or("edit needs groups")?;
            let set = &mut doc.sets[ai];
            for g in list {
                let text = |k: &str| g.get(k).and_then(|v| v.as_str()).unwrap_or("");
                let mut e = El::new("Skill");
                e.set("enabled", Some("true"));
                e.set("includeInFullDPS", Some("false"));
                if !text("slot").is_empty() {
                    e.set("slot", Some(text("slot")));
                }
                e.set("source", Some(text("source")));
                e.set("mainActiveSkill", Some("1"));
                let mut gem = El::new("Gem");
                gem.set("nameSpec", Some(text("name")));
                gem.set("skillId", Some(text("skillId")));
                gem.set("level", Some(&num(g.get("level").and_then(|v| v.as_f64()).unwrap_or(1.0))));
                gem.set("quality", Some("0"));
                gem.set("enabled", Some("true"));
                gem.set("enableGlobal1", Some("true"));
                gem.set("enableGlobal2", Some("false"));
                gem.set("count", Some("1"));
                e.kids.push(gem.to_xml());
                set.kids.push(e.to_xml());
            }
        }
        "setMainActiveSkill" => {
            let gi = idx(edit, "group")?;
            let skill = idx(edit, "skill")?;
            let set = &mut doc.sets[ai];
            let mut g = group_el(set, gi)?;
            g.set("mainActiveSkill", Some(&skill.max(1).to_string()));
            set.kids[gi - 1] = g.to_xml();
        }
        "setSkillsOption" => {
            let attr = edit.get("attr").and_then(|v| v.as_str()).unwrap_or("");
            if !["defaultGemLevel", "defaultGemQuality", "sortGemsByDPS", "sortGemsByDPSField", "showSupportGemTypes", "showLegacyGems"].contains(&attr) {
                return Err(format!("unknown skills option {attr:?}"));
            }
            let v = match edit.get("value") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Bool(b)) => b.to_string(),
                Some(Value::Number(n)) => {
                    let x = n.as_f64().unwrap_or(0.0);
                    num(if attr == "defaultGemQuality" { x.clamp(0.0, 23.0) } else { x })
                }
                _ => return Err("edit needs value".into()),
            };
            doc.skills.set(attr, Some(&v));
            if attr == "defaultGemLevel" {
                doc.skills.set("matchGemLevelToCharacterLevel", None);
            }
        }
        _ => return Ok(None),
    }
    let new_skills = doc.to_xml();
    let doc_x = parse(xml)?;
    let root = doc_x.root_element();
    let mut text = match elements(root, "Skills").next() {
        Some(n) => splice(xml, n.range(), &new_skills),
        None => append_child(xml, root, &new_skills),
    };
    if mains.main != old.main || mains.calcs != old.calcs {
        text = write_mains(&text, &mains, &old)?;
    }
    out_xml.replace(text);
    Ok(out_xml)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const X: &str = r#"<PathOfBuilding><Build level="90" mainSocketGroup="2"/><Skills activeSkillSet="1" defaultGemQuality="5"><SkillSet id="1"><Skill enabled="true" label="A" slot="Helmet" mainActiveSkill="1"><Gem nameSpec="Arc" skillId="Arc" gemId="Metadata/Items/Gems/SkillGemArc" level="20" quality="0" enabled="true" enableGlobal1="true" enableGlobal2="false" count="1"/><Gem nameSpec="Added Fire Damage" level="20" quality="0" enabled="true"/></Skill><Skill enabled="true" label="B"><Gem nameSpec="Fireball" level="20" quality="0" enabled="true"/></Skill><Skill enabled="true" source="Item:1:X"><Gem nameSpec="Y" level="1"/></Skill></SkillSet></Skills><Calcs><Input name="skill_number" number="2"/></Calcs></PathOfBuilding>"#;

    fn run(xml: &str, e: Value) -> String {
        skills_edit(xml, &e).unwrap().unwrap()
    }
    fn mains(x: &str) -> (i64, Option<i64>) {
        let m = read_mains(x);
        (m.main, m.calcs)
    }

    #[test]
    fn move_group_keeps_main() {
        let x = run(X, json!({"kind":"moveGroup","from":2,"to":1}));
        assert!(x.find("label=\"B\"").unwrap() < x.find("label=\"A\"").unwrap());
        assert_eq!(mains(&x), (1, Some(1)));
        let x = run(X, json!({"kind":"moveGroup","from":1,"to":3}));
        assert_eq!(mains(&x), (1, Some(1)));
    }

    #[test]
    fn add_remove_group_shift_main() {
        let x = run(X, json!({"kind":"addGroup","at":1,"group":{"label":"N"}}));
        assert_eq!(mains(&x), (3, Some(3)));
        assert!(x.contains(r#"label="N""#));
        let x = run(X, json!({"kind":"removeGroup","group":1}));
        assert_eq!(mains(&x), (1, Some(1)));
        assert!(skills_edit(X, &json!({"kind":"removeGroup","group":3})).is_err());
    }

    #[test]
    fn gem_edits() {
        let x = run(X, json!({"kind":"removeGem","group":1,"gem":1}));
        assert!(!x.contains(r#"nameSpec="Arc""#) && x.contains("Added Fire Damage"));
        let x = run(X, json!({"kind":"moveGem","group":1,"from":1,"to":2}));
        assert!(x.find("Added Fire Damage").unwrap() < x.find("nameSpec=\"Arc\"").unwrap());
        let x = run(X, json!({"kind":"orderGems","group":1,"order":[2,1]}));
        assert!(x.find("Added Fire Damage").unwrap() < x.find("nameSpec=\"Arc\"").unwrap());
        assert!(skills_edit(X, &json!({"kind":"orderGems","group":1,"order":[1,1]})).is_err());
        assert!(skills_edit(X, &json!({"kind":"addGem","group":3,"gem":{"gemId":"x"}})).is_err());
        let id = data::sorted_gems().iter().find(|(_, g)| g.name.as_deref() == Some("Fireball")).map(|(k, _)| *k).unwrap();
        let x = run(X, json!({"kind":"addGem","group":2,"gem":{"gemId":id}}));
        assert!(x.contains(r#"gemId="Metadata/Items/Gems/SkillGemFireball""#), "{x}");
        // Default quality from the Skills options (5), level from the default-level mode (normal maximum 20).
        let g = x.split("label=\"B\"").nth(1).unwrap();
        assert!(g.contains(r#"quality="5""#) && g.contains(r#"level="20""#), "{g}");
        let x = run(X, json!({"kind":"setGemSkill","group":2,"gem":1,"gemId":id}));
        assert!(x.contains(r#"skillId="Fireball""#));
        // The new gem takes the default level, not the old gem's.
        let low = X.replacen(r#"nameSpec="Fireball" level="20""#, r#"nameSpec="Fireball" level="3""#, 1);
        let z = run(&low, json!({"kind":"setGemSkill","group":2,"gem":1,"gemId":id}));
        assert!(z.split("label=\"B\"").nth(1).unwrap().contains(r#"level="20""#), "{z}");
    }

    #[test]
    fn sets_and_options() {
        let x = run(X, json!({"kind":"skillSet","op":"new","title":"Bossing"}));
        assert!(x.contains(r#"<SkillSet id="2" title="Bossing"/>"#), "{x}");
        let y = run(&x, json!({"kind":"skillSet","op":"activate","id":2}));
        assert!(y.contains(r#"activeSkillSet="2""#));
        let z = run(&y, json!({"kind":"addGroup"}));
        assert_eq!(z.matches("<Skill ").count(), 4);
        let c = run(X, json!({"kind":"skillSet","op":"copy","id":1,"title":"Copy"}));
        assert_eq!(c.matches("<Skill ").count(), 6);
        let d = run(&c, json!({"kind":"skillSet","op":"delete","id":1}));
        assert!(d.contains(r#"activeSkillSet="2""#) && d.matches("<Skill ").count() == 3);
        assert!(skills_edit(X, &json!({"kind":"skillSet","op":"delete","id":1})).is_err());
        let o = run(X, json!({"kind":"setSkillsOption","attr":"defaultGemQuality","value":40}));
        assert!(o.contains(r#"defaultGemQuality="23""#));
        let m = run(X, json!({"kind":"setMainGroup","group":1}));
        assert_eq!(mains(&m), (1, Some(1)));
    }

    #[test]
    fn legacy_bare_skills_become_set_one() {
        let legacy = r#"<PathOfBuilding><Build level="90"/><Skills><Skill enabled="true"><Gem nameSpec="Arc"/></Skill></Skills></PathOfBuilding>"#;
        let x = run(legacy, json!({"kind":"skillSet","op":"new"}));
        assert!(x.contains(r#"<SkillSet id="1"><Skill"#) && x.contains(r#"<SkillSet id="2"/>"#), "{x}");
    }
}
