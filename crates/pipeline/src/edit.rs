//! Edits to a build's XML for a session (`crate::session::Session`): equip an item, set a config input, change a
//! gem or a socket group. Each finds the element the loaders read (the active item, config or skill set, chosen the
//! same way they choose it), rewrites that element's start tag or inserts a new element, and leaves every other
//! byte of the XML as it was.
use roxmltree::{Document, Node};

/// A config input's value, as `<Input name="..." boolean|number|string="..."/>` stores it.
#[derive(Clone, Debug)]
pub enum ConfigValue {
    Bool(bool),
    Num(f64),
    Str(String),
}

pub(crate) fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub(crate) fn esc_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub(crate) fn elements<'a, 'i>(n: Node<'a, 'i>, name: &'a str) -> impl Iterator<Item = Node<'a, 'i>> + 'a {
    n.children().filter(move |c| c.is_element() && c.tag_name().name() == name)
}

/// Byte range of `n`'s start tag (`<Tag ...>` or `<Tag .../>`).
pub(crate) fn start_tag(xml: &str, n: Node) -> std::ops::Range<usize> {
    let start = n.range().start;
    let b = xml.as_bytes();
    let mut q: Option<u8> = None;
    let mut i = start;
    while i < n.range().end {
        match (q, b[i]) {
            (None, b'"') | (None, b'\'') => q = Some(b[i]),
            (Some(c), x) if c == x => q = None,
            (None, b'>') => return start..i + 1,
            _ => {}
        }
        i += 1;
    }
    start..n.range().end
}

/// `n`'s start tag with `attr` set to `value` (added at the end when absent), or removed when `value` is `None`.
fn with_attr(xml: &str, n: Node, attr: &str, value: Option<&str>) -> (std::ops::Range<usize>, String) {
    let tag = start_tag(xml, n);
    let self_closing = xml[tag.clone()].ends_with("/>");
    let mut out = format!("<{}", n.tag_name().name());
    let mut seen = false;
    for a in n.attributes() {
        if a.name() == attr {
            seen = true;
            if let Some(v) = value {
                out.push_str(&format!(" {}=\"{}\"", a.name(), esc(v)));
            }
        } else {
            out.push_str(&format!(" {}=\"{}\"", a.name(), esc(a.value())));
        }
    }
    if !seen {
        if let Some(v) = value {
            out.push_str(&format!(" {attr}=\"{}\"", esc(v)));
        }
    }
    out.push_str(if self_closing { "/>" } else { ">" });
    (tag, out)
}

pub(crate) fn splice(xml: &str, range: std::ops::Range<usize>, with: &str) -> String {
    format!("{}{}{}", &xml[..range.start], with, &xml[range.end..])
}

/// Inserts `text` as the last child of `parent` (turning a self-closing `<Parent/>` into a pair).
pub(crate) fn append_child(xml: &str, parent: Node, text: &str) -> String {
    let tag = start_tag(xml, parent);
    if xml[tag.clone()].ends_with("/>") {
        let open = format!("{}>", &xml[tag.start..tag.end - 2]);
        return splice(xml, tag, &format!("{open}{text}</{}>", parent.tag_name().name()));
    }
    let end = parent.range().end;
    let close = xml[..end].rfind("</").unwrap_or(end);
    splice(xml, close..close, text)
}

pub(crate) fn parse(xml: &str) -> Result<Document<'_>, String> {
    Document::parse(xml).map_err(|e| format!("xml: {e}"))
}

/// Sets config input `key` in the active config set (`None` removes it), as `ConfigTab:Load` reads them.
pub fn set_config_input(xml: &str, key: &str, value: Option<&ConfigValue>) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let element = value.map(|v| match v {
        ConfigValue::Bool(b) => format!("<Input name=\"{}\" boolean=\"{b}\"/>", esc(key)),
        ConfigValue::Num(n) => format!("<Input name=\"{}\" number=\"{}\"/>", esc(key), num(*n)),
        ConfigValue::Str(s) => format!("<Input name=\"{}\" string=\"{}\"/>", esc(key), esc(s)),
    });
    let Some(config) = elements(root, "Config").next() else {
        let Some(e) = element else { return Ok(xml.to_string()) };
        return Ok(append_child(xml, root, &format!("<Config>{e}</Config>")));
    };
    let active: i64 = config.attribute("activeConfigSet").and_then(|s| s.parse().ok()).unwrap_or(1);
    let sets: Vec<Node> = elements(config, "ConfigSet").collect();
    // Legacy saves keep the inputs directly under <Config> (set 1).
    let set = if sets.is_empty() { config } else { sets.iter().rev().find(|s| s.attribute("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(1) == active).copied().ok_or("active <ConfigSet> missing")? };
    match (elements(set, "Input").filter(|i| i.attribute("name") == Some(key)).last(), element) {
        (Some(old), Some(e)) => Ok(splice(xml, old.range(), &e)),
        (Some(old), None) => Ok(splice(xml, old.range(), "")),
        (None, Some(e)) => Ok(append_child(xml, set, &e)),
        (None, None) => Ok(xml.to_string()),
    }
}

/// The active item set's element (`ItemsTab:Load`): the `<ItemSet>` whose id is `activeItemSet`, else the first,
/// else `<Items>` itself for a legacy save with bare `<Slot>`s.
fn active_item_set<'a, 'i>(items: Node<'a, 'i>) -> Node<'a, 'i> {
    let active: i64 = items.attribute("activeItemSet").and_then(|s| s.parse().ok()).unwrap_or(1);
    elements(items, "ItemSet").find(|s| s.attribute("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(1) == active).or_else(|| elements(items, "ItemSet").next()).unwrap_or(items)
}

/// Equips item `item_id` (0 = nothing) in `slot` of the active item set.
pub fn set_slot_item(xml: &str, slot: &str, item_id: i64) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let Some(items) = elements(root, "Items").next() else {
        return Ok(append_child(xml, root, &format!("<Items activeItemSet=\"1\"><ItemSet id=\"1\"><Slot name=\"{}\" itemId=\"{item_id}\"/></ItemSet></Items>", esc(slot))));
    };
    let set = active_item_set(items);
    if let Some(s) = elements(set, "Slot").filter(|s| s.attribute("name") == Some(slot)).last() {
        let (r, t) = with_attr(xml, s, "itemId", Some(&item_id.to_string()));
        return Ok(splice(xml, r, &t));
    }
    Ok(append_child(xml, set, &format!("<Slot name=\"{}\" itemId=\"{item_id}\"/>", esc(slot))))
}

/// Adds an item (its text as the item tab saves it) and returns the new XML and the item's id.
pub fn add_item(xml: &str, item_text: &str) -> Result<(String, i64), String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let items = elements(root, "Items").next();
    let next_id = items.map(|i| elements(i, "Item").filter_map(|it| it.attribute("id").and_then(|v| v.parse::<i64>().ok())).max().unwrap_or(0)).unwrap_or(0) + 1;
    let element = format!("<Item id=\"{next_id}\">{}</Item>", esc_text(item_text));
    let out = match items {
        Some(items) => append_child(xml, items, &element),
        None => append_child(xml, root, &format!("<Items activeItemSet=\"1\">{element}<ItemSet id=\"1\"/></Items>")),
    };
    Ok((out, next_id))
}

/// Equips `item_text` in `slot` (adding it as a new item), or empties the slot when `None`.
pub fn set_item(xml: &str, slot: &str, item_text: Option<&str>) -> Result<String, String> {
    match item_text {
        None => set_slot_item(xml, slot, 0),
        Some(t) => {
            let (with_item, id) = add_item(xml, t)?;
            set_slot_item(&with_item, slot, id)
        }
    }
}

/// The active skill set's socket groups (`<Skill>` elements) in the order `SkillsTabClass:Load` builds them.
pub(crate) fn active_socket_groups<'a, 'i>(skills: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    let mut order: Vec<i64> = Vec::new();
    let mut sets: Vec<(i64, Vec<Node<'a, 'i>>)> = Vec::new();
    for c in skills.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "Skill" => {
                if order.is_empty() {
                    order.push(1);
                    sets.retain(|s| s.0 != 1);
                    sets.push((1, Vec::new()));
                }
                if let Some(set) = sets.iter_mut().find(|s| s.0 == 1) {
                    set.1.push(c);
                }
            }
            "SkillSet" => {
                let id = c.attribute("id").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
                let groups: Vec<Node> = elements(c, "Skill").collect();
                sets.retain(|s| s.0 != id);
                sets.push((id, groups));
                order.push(id);
            }
            _ => {}
        }
    }
    let active = skills.attribute("activeSkillSet").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let chosen = sets.iter().position(|s| s.0 == active).or_else(|| order.first().and_then(|o| sets.iter().position(|s| s.0 == *o)));
    chosen.map(|i| sets.swap_remove(i).1).unwrap_or_default()
}

/// Sets attribute `attr` of socket group `group` (1-based, active skill set), e.g. `enabled`.
pub fn set_group_attr(xml: &str, group: usize, attr: &str, value: Option<&str>) -> Result<String, String> {
    let doc = parse(xml)?;
    let skills = elements(doc.root_element(), "Skills").next().ok_or("no <Skills>")?;
    let groups = active_socket_groups(skills);
    let g = groups.get(group.wrapping_sub(1)).ok_or("no such socket group")?;
    let (r, t) = with_attr(xml, *g, attr, value);
    Ok(splice(xml, r, &t))
}

/// Sets attribute `attr` of gem `gem` (1-based) in socket group `group` (1-based), e.g. `level`, `quality`,
/// `enabled`.
pub fn set_gem_attr(xml: &str, group: usize, gem: usize, attr: &str, value: Option<&str>) -> Result<String, String> {
    let doc = parse(xml)?;
    let skills = elements(doc.root_element(), "Skills").next().ok_or("no <Skills>")?;
    let groups = active_socket_groups(skills);
    let g = groups.get(group.wrapping_sub(1)).ok_or("no such socket group")?;
    let gems: Vec<Node> = elements(*g, "Gem").collect();
    let e = gems.get(gem.wrapping_sub(1)).ok_or("no such gem")?;
    let (r, t) = with_attr(xml, *e, attr, value);
    Ok(splice(xml, r, &t))
}

/// Attribute `attr` of gem `gem` in socket group `group` (both 1-based, active skill set), and how many gems the
/// group has.
pub fn gem_attr(xml: &str, group: usize, gem: usize, attr: &str) -> Option<(Option<String>, usize)> {
    let doc = Document::parse(xml).ok()?;
    let skills = elements(doc.root_element(), "Skills").next()?;
    let groups = active_socket_groups(skills);
    let g = groups.get(group.wrapping_sub(1))?;
    let gems: Vec<Node> = elements(*g, "Gem").collect();
    Some((gems.get(gem.wrapping_sub(1)).and_then(|e| e.attribute(attr)).map(|s| s.to_string()), gems.len()))
}

/// The active item set's non-empty slots as (name, item id).
pub fn equipped_slots(xml: &str) -> Vec<(String, i64)> {
    let Ok(doc) = Document::parse(xml) else { return Vec::new() };
    let Some(items) = elements(doc.root_element(), "Items").next() else { return Vec::new() };
    elements(active_item_set(items), "Slot").filter_map(|s| Some((s.attribute("name")?.to_string(), s.attribute("itemId")?.parse::<i64>().ok().filter(|&i| i > 0)?))).collect()
}

/// Turns a flask or tincture slot of the active item set on or off (`active="true"`), adding the slot when missing.
pub fn set_slot_active(xml: &str, slot: &str, active: bool) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let Some(items) = elements(root, "Items").next() else { return Err("no <Items>".into()) };
    let set = active_item_set(items);
    let value = if active { "true" } else { "false" };
    if let Some(s) = elements(set, "Slot").filter(|s| s.attribute("name") == Some(slot)).last() {
        let (r, t) = with_attr(xml, s, "active", Some(value));
        return Ok(splice(xml, r, &t));
    }
    Ok(append_child(xml, set, &format!("<Slot name=\"{}\" itemId=\"0\" active=\"{value}\"/>", esc(slot))))
}

/// Puts item `item_id` (0 = nothing) in the jewel socket `node_id` of the active passive tree.
pub fn set_jewel_socket(xml: &str, node_id: i64, item_id: i64) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let tree = elements(root, "Tree").next().ok_or("no <Tree>")?;
    let active: usize = tree.attribute("activeSpec").and_then(|s| s.parse().ok()).unwrap_or(1);
    let specs: Vec<Node> = elements(tree, "Spec").collect();
    let spec = *specs.get(active.wrapping_sub(1)).or_else(|| specs.first()).ok_or("no <Spec>")?;
    let entry = format!("<Socket nodeId=\"{node_id}\" itemId=\"{item_id}\"/>");
    let Some(sockets) = elements(spec, "Sockets").next() else {
        return Ok(append_child(xml, spec, &format!("<Sockets>{entry}</Sockets>")));
    };
    let id = node_id.to_string();
    if let Some(s) = elements(sockets, "Socket").filter(|s| s.attribute("nodeId") == Some(id.as_str())).last() {
        let (r, t) = with_attr(xml, s, "itemId", Some(&item_id.to_string()));
        return Ok(splice(xml, r, &t));
    }
    Ok(append_child(xml, sockets, &entry))
}

#[cfg(test)]
mod tests {
    use super::*;
    const X: &str = r#"<PathOfBuilding><Build level="90"/><Skills activeSkillSet="1"><SkillSet id="1"><Skill enabled="true"><Gem nameSpec="Arc" level="20" quality="0" enabled="true"/></Skill></SkillSet></Skills><Items activeItemSet="1"><Item id="1">Rarity: RARE
X</Item><ItemSet id="1"><Slot name="Ring 1" itemId="1"/></ItemSet></Items><Config activeConfigSet="1"><ConfigSet id="1" title="Default"><Input name="enemyIsBoss" string="Pinnacle"/></ConfigSet></Config></PathOfBuilding>"#;
    #[test]
    fn edits() {
        let x = set_gem_attr(X, 1, 1, "level", Some("21")).unwrap();
        assert!(x.contains(r#"<Gem nameSpec="Arc" level="21" quality="0" enabled="true"/>"#));
        let x = set_config_input(X, "useFrenzyCharges", Some(&ConfigValue::Bool(true))).unwrap();
        assert!(x.contains(r#"<Input name="enemyIsBoss" string="Pinnacle"/><Input name="useFrenzyCharges" boolean="true"/></ConfigSet>"#));
        let x = set_config_input(X, "enemyIsBoss", None).unwrap();
        assert!(x.contains(r#"<ConfigSet id="1" title="Default"></ConfigSet>"#));
        let x = set_item(X, "Ring 2", Some("Rarity: RARE\nY & Z")).unwrap();
        assert!(x.contains("<Item id=\"2\">Rarity: RARE\nY &amp; Z</Item>"), "{x}");
        assert!(x.contains(r#"<Slot name="Ring 1" itemId="1"/><Slot name="Ring 2" itemId="2"/></ItemSet>"#));
        let x = set_slot_item(X, "Ring 1", 0).unwrap();
        assert!(x.contains(r#"<Slot name="Ring 1" itemId="0"/>"#));
    }
}
