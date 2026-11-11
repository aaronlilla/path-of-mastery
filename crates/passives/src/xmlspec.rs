//! Parses the active `<Spec>` element out of a build's XML (PassiveSpec.lua `Load`): the
//! new-format attributes (classId/ascendClassId/nodes/masteryEffects/...), the legacy `<URL>`
//! element, and `<Sockets>`. `<Overrides>` (tattoos) is parsed but not yet applied by `spec.rs`.

use roxmltree::{Document, Node};

#[derive(Debug, Default, Clone)]
pub struct ParsedSpec {
    pub title: Option<String>,
    pub tree_version: Option<String>,
    pub cluster_hash_format_version: Option<i64>,
    pub class_id: Option<i64>,
    pub ascend_class_id: Option<i64>,
    pub secondary_ascend_class_id: i64,
    /// Present only for the new (post node-hash-list) save format.
    pub hash_list: Option<Vec<i64>>,
    pub mastery_effects: Vec<(i64, i64)>,
    /// Legacy format: a GGG (or poeplanner) tree URL to decode instead of `hash_list`.
    pub url: Option<String>,
    pub jewels: Vec<(i64, i64)>,
    pub overrides: Vec<OverrideNode>,
}

#[derive(Debug, Clone)]
pub struct OverrideNode {
    pub node_id: i64,
    pub dn: String,
    pub icon: String,
    pub active_effect_image: String,
    pub sd: Vec<String>,
}

fn attr<'a>(n: &'a Node, name: &str) -> Option<&'a str> {
    n.attribute(name)
}

fn attr_i64(n: &Node, name: &str) -> Option<i64> {
    attr(n, name).and_then(|s| s.parse().ok())
}

/// The build XML's `<Tree ...>...</Tree>` element as text (not `<TreeView>`), if present.
pub fn tree_element(xml_text: &str) -> Option<&str> {
    if let Some((p, l, s, e)) = TREE_HINT.with(|h| h.get()) {
        if p == xml_text.as_ptr() as usize && l == xml_text.len() {
            return Some(&xml_text[s..e]);
        }
    }
    let b = xml_text.as_bytes();
    let mut from = 0;
    while let Some(i) = xml_text[from..].find("<Tree") {
        let at = from + i;
        if matches!(b.get(at + 5), Some(b' ' | b'>' | b'/' | b'\t' | b'\r' | b'\n')) {
            let end = xml_text[at..].find("</Tree>")? + at + "</Tree>".len();
            return Some(&xml_text[at..end]);
        }
        from = at + 5;
    }
    None
}

thread_local! {
    static TREE_HINT: std::cell::Cell<Option<(usize, usize, usize, usize)>> = const { std::cell::Cell::new(None) };
}

/// While set, `tree_element` of exactly this text (same address and length) is `xml_text[start..end]`, which the
/// caller built and so knows to be its `<Tree>` element. `clear_tree_hint` must follow before the text is dropped.
pub fn set_tree_hint(xml_text: &str, start: usize, end: usize) {
    TREE_HINT.with(|h| h.set(Some((xml_text.as_ptr() as usize, xml_text.len(), start, end))));
}

pub fn clear_tree_hint() {
    TREE_HINT.with(|h| h.set(None));
    SPEC_HINT.with(|h| *h.borrow_mut() = None);
}

thread_local! {
    static SPEC_HINT: std::cell::RefCell<Option<(usize, usize, ParsedSpec)>> = const { std::cell::RefCell::new(None) };
}

/// While set (until `clear_tree_hint`), `parse_active_spec` of exactly this text returns `spec`, which the caller
/// derived from a text that differs from this one only in the active spec's node list.
pub fn set_spec_hint(xml_text: &str, spec: ParsedSpec) {
    SPEC_HINT.with(|h| *h.borrow_mut() = Some((xml_text.as_ptr() as usize, xml_text.len(), spec)));
}

/// `ParsedSpec::hash_list` for a `nodes` attribute value, parsed as `parse_active_spec` parses it.
pub fn parse_hash_list(nodes_attr: &str) -> Vec<i64> {
    nodes_attr.split(',').filter_map(|s| s.trim().parse().ok()).collect()
}

/// Parses the build XML and returns the active `<Spec>`'s data (root -> Tree[activeSpec] -> Spec). Only the
/// `<Tree>` element is read, so it alone is parsed, and the result is kept per thread keyed by its text:
/// setup asks twice per build, and a session re-asks after every edit that isn't to the tree.
pub fn parse_active_spec(xml_text: &str) -> Result<ParsedSpec, String> {
    if let Some(s) = SPEC_HINT.with(|h| h.borrow().as_ref().filter(|e| e.0 == xml_text.as_ptr() as usize && e.1 == xml_text.len()).map(|e| e.2.clone())) {
        return Ok(s);
    }
    let Some(tree) = tree_element(xml_text) else { return parse_active_spec_doc(xml_text) };
    thread_local! {
        static LAST: std::cell::RefCell<Option<(String, Result<ParsedSpec, String>)>> = const { std::cell::RefCell::new(None) };
    }
    if let Some(r) = LAST.with(|c| c.borrow().as_ref().filter(|e| e.0 == tree).map(|e| e.1.clone())) {
        return r;
    }
    let r = parse_active_spec_doc(&format!("<PathOfBuilding>{tree}</PathOfBuilding>"));
    LAST.with(|c| *c.borrow_mut() = Some((tree.to_string(), r.clone())));
    r
}

fn parse_active_spec_doc(xml_text: &str) -> Result<ParsedSpec, String> {
    let doc = Document::parse(xml_text).map_err(|e| format!("xml parse error: {e}"))?;
    let root = doc.root_element();
    let tree_el = root
        .children()
        .find(|c| c.is_element() && c.tag_name().name() == "Tree")
        .ok_or("missing <Tree>")?;
    let active_spec: usize = tree_el.attribute("activeSpec").and_then(|s| s.parse().ok()).unwrap_or(1);
    let specs: Vec<Node> = tree_el.children().filter(|c| c.is_element() && c.tag_name().name() == "Spec").collect();
    let spec_el = specs
        .get(active_spec.saturating_sub(1))
        .or_else(|| specs.first())
        .ok_or("no <Spec> elements")?;
    parse_spec_element(spec_el)
}

fn parse_spec_element(spec_el: &Node) -> Result<ParsedSpec, String> {
    let mut out = ParsedSpec {
        title: attr(spec_el, "title").map(|s| s.to_string()),
        tree_version: attr(spec_el, "treeVersion").map(|s| s.to_string()),
        cluster_hash_format_version: attr_i64(spec_el, "clusterHashFormatVersion"),
        class_id: attr_i64(spec_el, "classId"),
        ascend_class_id: attr_i64(spec_el, "ascendClassId"),
        secondary_ascend_class_id: attr_i64(spec_el, "secondaryAscendClassId").unwrap_or(0),
        ..Default::default()
    };

    if let Some(nodes_attr) = attr(spec_el, "nodes") {
        out.hash_list = Some(parse_hash_list(nodes_attr));
        if out.cluster_hash_format_version.is_none() {
            out.cluster_hash_format_version = Some(1);
        }
    } else if out.cluster_hash_format_version.is_none() {
        out.cluster_hash_format_version = Some(2);
    }

    if let Some(me) = attr(spec_el, "masteryEffects") {
        // "{mastery,effect},{mastery,effect},..."
        let mut rest = me;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            if let Some(close) = after.find('}') {
                let pair = &after[..close];
                let mut parts = pair.split(',');
                if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
                    if let (Ok(m), Ok(e)) = (a.trim().parse::<i64>(), b.trim().parse::<i64>()) {
                        out.mastery_effects.push((m, e));
                    }
                }
                rest = &after[close + 1..];
            } else {
                break;
            }
        }
    }

    for child in spec_el.children().filter(|c| c.is_element()) {
        match child.tag_name().name() {
            "URL" => {
                if let Some(text) = child.text() {
                    out.url = Some(text.trim().to_string());
                }
            }
            "Sockets" => {
                for socket in child.children().filter(|c| c.is_element() && c.tag_name().name() == "Socket") {
                    if let (Some(node_id), Some(item_id)) = (attr_i64(&socket, "nodeId"), attr_i64(&socket, "itemId")) {
                        if item_id > 0 {
                            out.jewels.push((node_id, item_id));
                        }
                    }
                }
            }
            "Overrides" => {
                for ov in child.children().filter(|c| c.is_element() && c.tag_name().name() == "Override") {
                    let Some(node_id) = attr_i64(&ov, "nodeId") else { continue };
                    let sd: Vec<String> = ov
                        .children()
                        .filter(|c| c.is_text())
                        .filter_map(|c| c.text())
                        .flat_map(|t| t.lines())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    out.overrides.push(OverrideNode {
                        node_id,
                        dn: attr(&ov, "dn").unwrap_or("").to_string(),
                        icon: attr(&ov, "icon").unwrap_or("").to_string(),
                        active_effect_image: attr(&ov, "activeEffectImage").unwrap_or("").to_string(),
                        sd,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(out)
}
