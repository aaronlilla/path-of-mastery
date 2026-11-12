//! Config set and custom modifier edits on a build's XML (`ConfigTab.lua` Save/Load, `ConfigSetListControl.lua`):
//! activate, create, copy, rename, delete and reorder config sets, and replace the active set's custom modifier
//! blocks. Like `crate::edit`, each rewrites only the bytes it changes.
use roxmltree::{Document, Node};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn esc_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn elements<'a, 'i>(n: Node<'a, 'i>, name: &'a str) -> impl Iterator<Item = Node<'a, 'i>> + 'a {
    n.children().filter(move |c| c.is_element() && c.tag_name().name() == name)
}

fn start_tag(xml: &str, n: Node) -> std::ops::Range<usize> {
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

/// `n`'s start tag with `attr` set (added at the end when absent).
fn with_attr(xml: &str, n: Node, attr: &str, value: &str) -> (std::ops::Range<usize>, String) {
    let tag = start_tag(xml, n);
    let self_closing = xml[tag.clone()].ends_with("/>");
    let mut out = format!("<{}", n.tag_name().name());
    let mut seen = false;
    for a in n.attributes() {
        if a.name() == attr {
            seen = true;
            out.push_str(&format!(" {}=\"{}\"", a.name(), esc(value)));
        } else {
            out.push_str(&format!(" {}=\"{}\"", a.name(), esc(a.value())));
        }
    }
    if !seen {
        out.push_str(&format!(" {attr}=\"{}\"", esc(value)));
    }
    out.push_str(if self_closing { "/>" } else { ">" });
    (tag, out)
}

fn splice(xml: &str, range: std::ops::Range<usize>, with: &str) -> String {
    format!("{}{}{}", &xml[..range.start], with, &xml[range.end..])
}

fn parse(xml: &str) -> Result<Document<'_>, String> {
    Document::parse(xml).map_err(|e| format!("xml: {e}"))
}

/// Makes sure `<Config>` holds `<ConfigSet>` elements: a missing `<Config>` gets set 1, and a legacy one with its
/// inputs directly under it has them wrapped into set 1 (`ConfigTab:Load`).
fn with_sets(xml: &str) -> Result<String, String> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    let Some(config) = elements(root, "Config").next() else {
        let close = xml.rfind("</").ok_or("no root close tag")?;
        return Ok(splice(xml, close..close, "<Config activeConfigSet=\"1\"><ConfigSet id=\"1\" title=\"Default\"/></Config>"));
    };
    if elements(config, "ConfigSet").next().is_some() {
        return Ok(xml.to_string());
    }
    let (tag_range, new_tag) = with_attr(xml, config, "activeConfigSet", "1");
    let open_set = "<ConfigSet id=\"1\" title=\"Default\">";
    if xml[tag_range.clone()].ends_with("/>") {
        // `<Config/>`: becomes a pair holding one empty set.
        let open = new_tag.trim_end_matches("/>").to_string() + ">";
        return Ok(splice(xml, tag_range, &format!("{open}<ConfigSet id=\"1\" title=\"Default\"/></Config>")));
    }
    let end = config.range().end;
    let close = xml[..end].rfind("</Config>").ok_or("no </Config>")?;
    let mut out = String::with_capacity(xml.len() + 64);
    out.push_str(&xml[..tag_range.start]);
    out.push_str(&new_tag);
    out.push_str(open_set);
    out.push_str(&xml[tag_range.end..close]);
    out.push_str("</ConfigSet>");
    out.push_str(&xml[close..]);
    Ok(out)
}

fn set_id(n: Node) -> i64 {
    n.attribute("id").and_then(|s| s.parse().ok()).unwrap_or(1)
}

fn active_id(config: Node) -> i64 {
    config.attribute("activeConfigSet").and_then(|s| s.parse().ok()).unwrap_or(1)
}

/// The config set the loaders use for id `id`: the last element with it (`configSets[id]` is overwritten).
fn find_set<'a, 'i>(config: Node<'a, 'i>, id: i64) -> Option<Node<'a, 'i>> {
    elements(config, "ConfigSet").filter(|s| set_id(*s) == id).last()
}

/// One of: `activate`, `new`, `copy`, `delete`, `rename`, `move` (see `SetOp` in packages/protocol/src/tabs.ts).
pub fn config_set(xml: &str, op: &str, id: Option<i64>, title: Option<&str>, to: Option<i64>) -> Result<String, String> {
    let xml = with_sets(xml)?;
    let doc = parse(&xml)?;
    let config = elements(doc.root_element(), "Config").next().ok_or("no <Config>")?;
    let sets: Vec<Node> = elements(config, "ConfigSet").collect();
    let ids: Vec<i64> = {
        let mut v: Vec<i64> = Vec::new();
        for s in &sets {
            if !v.contains(&set_id(*s)) {
                v.push(set_id(*s));
            }
        }
        v
    };
    let need = |i: Option<i64>| -> Result<Node, String> { i.and_then(|i| find_set(config, i)).ok_or_else(|| "no such config set".to_string()) };
    let next_id = || (1..).find(|i| !ids.contains(i)).unwrap();
    match op {
        "activate" => {
            need(id)?;
            let (r, t) = with_attr(&xml, config, "activeConfigSet", &id.unwrap().to_string());
            Ok(splice(&xml, r, &t))
        }
        "new" => {
            let t = title.filter(|t| !t.trim().is_empty()).unwrap_or("New Config Set");
            let el = format!("<ConfigSet id=\"{}\" title=\"{}\"/>", next_id(), esc(t));
            Ok(append(&xml, config, &el))
        }
        "copy" => {
            let src = need(id)?;
            let nid = next_id();
            let t = title.map(|t| t.to_string()).unwrap_or_else(|| format!("{} (copy)", src.attribute("title").unwrap_or("Default")));
            let raw = &xml[src.range()];
            // Rewrite the start tag of the copy.
            let tag = start_tag(&xml, src);
            let rel = tag.start - src.range().start..tag.end - src.range().start;
            let self_closing = raw[rel.clone()].ends_with("/>");
            let new_tag = format!("<ConfigSet id=\"{nid}\" title=\"{}\"{}", esc(&t), if self_closing { "/>" } else { ">" });
            let copy = format!("{}{}{}", &raw[..rel.start], new_tag, &raw[rel.end..]);
            Ok(append(&xml, config, &copy))
        }
        "delete" => {
            need(id)?;
            if ids.len() < 2 {
                return Err("a build needs at least one config set".into());
            }
            let id = id.unwrap();
            let pos = ids.iter().position(|i| *i == id).unwrap();
            // Every element with that id goes (a repeated id is the same set).
            let mut out = xml.clone();
            for s in sets.iter().rev().filter(|s| set_id(**s) == id) {
                out = splice(&out, s.range(), "");
            }
            if active_id(config) == id {
                let remaining: Vec<i64> = ids.iter().copied().filter(|i| *i != id).collect();
                let next = remaining[(pos.max(1) - 1).min(remaining.len() - 1)];
                let doc2 = parse(&out)?;
                let c2 = elements(doc2.root_element(), "Config").next().ok_or("no <Config>")?;
                let (r, t) = with_attr(&out, c2, "activeConfigSet", &next.to_string());
                out = splice(&out, r, &t);
            }
            Ok(out)
        }
        "rename" => {
            let s = need(id)?;
            let t = title.filter(|t| !t.trim().is_empty()).ok_or("a config set needs a name")?;
            let (r, tag) = with_attr(&xml, s, "title", t);
            Ok(splice(&xml, r, &tag))
        }
        "move" => {
            let s = need(id)?;
            let to = to.ok_or("move needs a position")?.clamp(1, ids.len() as i64) as usize;
            let raw = xml[s.range()].to_string();
            let id = id.unwrap();
            let without = splice(&xml, s.range(), "");
            let doc2 = parse(&without)?;
            let c2 = elements(doc2.root_element(), "Config").next().ok_or("no <Config>")?;
            let rest: Vec<Node> = elements(c2, "ConfigSet").filter(|n| set_id(*n) != id).collect();
            // Insert before the set now at position `to` (1-based among the others), else at the end.
            match rest.get(to - 1) {
                Some(before) => Ok(splice(&without, before.range().start..before.range().start, &raw)),
                None => Ok(append(&without, c2, &raw)),
            }
        }
        other => Err(format!("unknown config set operation {other:?}")),
    }
}

fn append(xml: &str, parent: Node, text: &str) -> String {
    let tag = start_tag(xml, parent);
    if xml[tag.clone()].ends_with("/>") {
        let open = format!("{}>", &xml[tag.start..tag.end - 2]);
        return splice(xml, tag, &format!("{open}{text}</{}>", parent.tag_name().name()));
    }
    let end = parent.range().end;
    let close = xml[..end].rfind("</").unwrap_or(end);
    splice(xml, close..close, text)
}

/// Adds one enabled custom modifier block to the active config set, keeping the blocks it has. The Find Timeless Jewel
/// weights use it to count a passive's mods for one calculation without changing the build.
/// The block is `partial`: a line with unparsed text left over still counts, as upstream's weights do.
pub fn add_custom_block(xml: &str, title: &str, text: &str) -> Result<String, String> {
    let xml = with_sets(xml)?;
    let doc = parse(&xml)?;
    let config = elements(doc.root_element(), "Config").next().ok_or("no <Config>")?;
    let active = active_id(config);
    let set = find_set(config, active).or_else(|| elements(config, "ConfigSet").next()).ok_or("no config set")?;
    let block = format!("<CustomModifierBlock title=\"{}\" enabled=\"true\" partial=\"true\">{}</CustomModifierBlock>", esc(title), esc_text(text));
    Ok(append(&xml, set, &block))
}

/// Replaces the active config set's custom modifier blocks (`CustomModifierBlock` elements) with `blocks`
/// (title, enabled, text), and drops a legacy `customMods` input that would migrate back into the list.
pub fn set_custom_mods(xml: &str, blocks: &[(String, bool, String)]) -> Result<String, String> {
    let xml = with_sets(xml)?;
    let doc = parse(&xml)?;
    let config = elements(doc.root_element(), "Config").next().ok_or("no <Config>")?;
    let active = active_id(config);
    let set = find_set(config, active).or_else(|| elements(config, "ConfigSet").next()).ok_or("no config set")?;
    let new_text: String = blocks
        .iter()
        .map(|(title, enabled, text)| format!("<CustomModifierBlock title=\"{}\" enabled=\"{enabled}\">{}</CustomModifierBlock>", esc(title), esc_text(text)))
        .collect();
    // Remove old blocks and the legacy input from the back so ranges stay valid.
    let mut kill: Vec<std::ops::Range<usize>> = Vec::new();
    for c in set.children().filter(|c| c.is_element()) {
        let name = c.tag_name().name();
        if name == "CustomModifierBlock" || (name == "Input" && c.attribute("name") == Some("customMods")) {
            kill.push(c.range());
        }
    }
    let mut out = xml.clone();
    for r in kill.into_iter().rev() {
        out = splice(&out, r, "");
    }
    let doc2 = parse(&out)?;
    let c2 = elements(doc2.root_element(), "Config").next().ok_or("no <Config>")?;
    let set2 = find_set(c2, active).or_else(|| elements(c2, "ConfigSet").next()).ok_or("no config set")?;
    Ok(append(&out, set2, &new_text))
}

#[cfg(test)]
mod tests {
    use super::*;
    const X: &str = r#"<PathOfBuilding><Build level="90"/><Config activeConfigSet="1"><ConfigSet id="1" title="Default"><Input name="enemyIsBoss" string="Pinnacle"/><CustomModifierBlock title="Default" enabled="true">10% increased Damage</CustomModifierBlock></ConfigSet><ConfigSet id="2" title="Bossing"/></Config></PathOfBuilding>"#;
    const LEGACY: &str = r#"<PathOfBuilding><Build level="90"/><Config><Input name="useFrenzyCharges" boolean="true"/></Config></PathOfBuilding>"#;

    #[test]
    fn sets() {
        let x = config_set(X, "activate", Some(2), None, None).unwrap();
        assert!(x.contains(r#"<Config activeConfigSet="2">"#), "{x}");
        let x = config_set(X, "new", None, Some("Mapping"), None).unwrap();
        assert!(x.contains(r#"<ConfigSet id="3" title="Mapping"/></Config>"#), "{x}");
        let x = config_set(X, "copy", Some(1), None, None).unwrap();
        assert!(x.contains(r#"<ConfigSet id="3" title="Default (copy)"><Input name="enemyIsBoss" string="Pinnacle"/><CustomModifierBlock"#), "{x}");
        let x = config_set(X, "rename", Some(2), Some("Boss & Co"), None).unwrap();
        assert!(x.contains(r#"<ConfigSet id="2" title="Boss &amp; Co"/>"#), "{x}");
        let x = config_set(X, "move", Some(2), None, Some(1)).unwrap();
        assert!(x.find(r#"id="2""#).unwrap() < x.find(r#"id="1""#).unwrap(), "{x}");
        let x = config_set(X, "delete", Some(1), None, None).unwrap();
        assert!(!x.contains(r#"id="1""#) && x.contains(r#"<Config activeConfigSet="2">"#), "{x}");
        assert!(config_set(&x, "delete", Some(2), None, None).is_err());
    }

    #[test]
    fn legacy_config_becomes_set_one() {
        let x = config_set(LEGACY, "new", None, Some("B"), None).unwrap();
        assert!(x.contains(r#"<Config activeConfigSet="1"><ConfigSet id="1" title="Default"><Input name="useFrenzyCharges" boolean="true"/></ConfigSet><ConfigSet id="2" title="B"/></Config>"#), "{x}");
        let none = r#"<PathOfBuilding><Build level="90"/></PathOfBuilding>"#;
        let x = config_set(none, "new", None, None, None).unwrap();
        assert!(x.contains(r#"<ConfigSet id="1" title="Default"/><ConfigSet id="2" title="New Config Set"/>"#), "{x}");
    }

    #[test]
    fn custom_blocks() {
        let x = set_custom_mods(X, &[("A".into(), true, "5% increased Life\n<b>".into()), ("B".into(), false, String::new())]).unwrap();
        assert!(x.contains(r#"<Input name="enemyIsBoss" string="Pinnacle"/><CustomModifierBlock title="A" enabled="true">5% increased Life
&lt;b&gt;</CustomModifierBlock><CustomModifierBlock title="B" enabled="false"></CustomModifierBlock></ConfigSet>"#), "{x}");
        let y = set_custom_mods(&x, &[]).unwrap();
        assert!(!y.contains("CustomModifierBlock"), "{y}");
    }
}
