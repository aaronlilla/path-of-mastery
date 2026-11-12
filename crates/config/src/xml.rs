//! Port of the non-UI parts of `Classes/ConfigTab.lua`: loading the `<Config>` element out of a
//! build's XML (`ConfigTabClass:Load`), constructing per-config-set defaults (`NewConfigSet`),
//! and applying the custom-modifier-block text through `pom_engine::modparser::parse_mod`
//! (`ConfigTabClass:BuildModList`'s tail, after the `varList` dispatch loop).
use crate::gen::defaults::ALL_OPTION_DEFAULTS;
use crate::types::{OptionType, OptionValue, OwnedOptionValue};
use pom_engine::modifier::Mod;
use roxmltree::{Document, Node};
use pom_engine::fxhash::HashMap;

#[derive(Debug, Default, Clone)]
pub struct CustomModBlock {
    pub title: String,
    pub enabled: bool,
    pub text: String,
    /// Not in upstream's file format: the Find Timeless Jewel weights add the mods a line parses to even when part of
    /// the line is left over (upstream's `modLib.parseMod(line)` ignores the unparsed rest there, the custom modifier
    /// route drops such a line).
    pub partial: bool,
}

#[derive(Debug, Default, Clone)]
pub struct ConfigSet {
    pub id: i64,
    pub title: String,
    pub input: HashMap<String, OwnedOptionValue>,
    pub placeholder: HashMap<String, OwnedOptionValue>,
    pub custom_mods: Vec<CustomModBlock>,
}

#[derive(Debug, Default, Clone)]
pub struct ConfigData {
    pub active_config_set_id: i64,
    pub config_sets: HashMap<i64, ConfigSet>,
}

fn new_config_set(id: i64, title: &str) -> ConfigSet {
    let mut input = HashMap::default();
    let mut placeholder = HashMap::default();
    for meta in ALL_OPTION_DEFAULTS.iter() {
        if let Some(v) = &meta.default_state {
            input.insert(meta.var.to_string(), OwnedOptionValue::from_generated(v));
        }
        if let Some(v) = &meta.default_placeholder {
            placeholder.insert(meta.var.to_string(), OwnedOptionValue::from_generated(v));
        }
    }
    ConfigSet { id, title: title.to_string(), input, placeholder, custom_mods: vec![CustomModBlock { title: "Default".into(), enabled: true, text: String::new(), partial: false }] }
}

fn set_input_and_placeholder(node: &Node, set: &mut ConfigSet) {
    let name = match node.attribute("name") {
        Some(n) => n,
        None => return,
    };
    match node.tag_name().name() {
        "Input" => {
            if let Some(num) = node.attribute("number").and_then(|s| s.parse::<f64>().ok()) {
                set.input.insert(name.to_string(), OwnedOptionValue::Num(num));
            } else if let Some(s) = node.attribute("string") {
                let value = if name == "enemyIsBoss" {
                    // Backwards-compat transform for pre-3.20 saves (ConfigTab.lua's `Load`):
                    // titlecase the value, then rename the pre-league-mechanic labels.
                    let mut out = String::new();
                    let mut cap_next = true;
                    for c in s.to_lowercase().chars() {
                        if c.is_alphanumeric() && cap_next {
                            out.extend(c.to_uppercase());
                            cap_next = false;
                        } else {
                            out.push(c);
                            cap_next = !c.is_alphanumeric();
                        }
                    }
                    out.replace("Uber Atziri", "Boss").replace("Shaper", "Pinnacle").replace("Sirus", "Pinnacle")
                } else if name == "presetBossSkills" {
                    s.strip_prefix("Uber ").unwrap_or(s).to_string()
                } else {
                    s.to_string()
                };
                set.input.insert(name.to_string(), OwnedOptionValue::Str(value.into()));
            } else if let Some(b) = node.attribute("boolean") {
                set.input.insert(name.to_string(), OwnedOptionValue::Bool(b == "true"));
            }
        }
        "Placeholder" => {
            if let Some(num) = node.attribute("number").and_then(|s| s.parse::<f64>().ok()) {
                set.placeholder.insert(name.to_string(), OwnedOptionValue::Num(num));
            } else if let Some(s) = node.attribute("string") {
                // Faithful to upstream: a Placeholder element with a string attribute writes
                // into `input`, not `placeholder` (ConfigTabClass:Load's `setInputAndPlaceholder`).
                set.input.insert(name.to_string(), OwnedOptionValue::Str(s.into()));
            }
        }
        _ => {}
    }
}

/// Parses a build's full XML and returns its `<Config>` element's config sets, or `None` if the
/// build has no `<Config>` element at all (the "empty config" case still yields config set 1 with
/// pure construction defaults, matching `xml.empty` in upstream).
pub fn parse_config(xml_text: &str) -> Result<ConfigData, String> {
    // Only `<Config>` is read, so only it is parsed.
    let section = config_section(xml_text);
    let preserved = preserve_attr_newlines(section.unwrap_or("<Config/>"));
    let doc = Document::parse(&preserved).map_err(|e| format!("xml parse error: {e}"))?;
    let config_el = section.map(|_| doc.root_element());
    let mut data = ConfigData { active_config_set_id: 1, config_sets: HashMap::default() };
    let Some(config_el) = config_el else {
        data.config_sets.insert(1, new_config_set(1, "Default"));
        return Ok(data);
    };
    data.active_config_set_id = config_el.attribute("activeConfigSet").and_then(|s| s.parse().ok()).unwrap_or(1);

    let children: Vec<Node> = config_el.children().filter(|c| c.is_element()).collect();
    if children.is_empty() {
        data.config_sets.insert(1, new_config_set(1, "Default"));
        return Ok(data);
    }
    for node in &children {
        if node.tag_name().name() != "ConfigSet" {
            data.config_sets.entry(1).or_insert_with(|| new_config_set(1, "Default"));
            let set = data.config_sets.get_mut(&1).unwrap();
            if node.tag_name().name() == "CustomModifierBlock" {
                set.custom_mods.push(CustomModBlock {
                    title: node.attribute("title").unwrap_or("Default").to_string(),
                    enabled: node.attribute("enabled").map(|s| s == "true").unwrap_or(true),
                    text: node.text().unwrap_or("").to_string(),
                    partial: node.attribute("partial") == Some("true"),
                });
            } else {
                set_input_and_placeholder(node, set);
            }
        } else {
            let id: i64 = node.attribute("id").and_then(|s| s.parse().ok()).unwrap_or(1);
            let title = node.attribute("title").unwrap_or("Default").to_string();
            let mut set = new_config_set(id, &title);
            set.custom_mods.clear();
            for child in node.children().filter(|c| c.is_element()) {
                if child.tag_name().name() == "CustomModifierBlock" {
                    set.custom_mods.push(CustomModBlock {
                        title: child.attribute("title").unwrap_or("Default").to_string(),
                        enabled: child.attribute("enabled").map(|s| s == "true").unwrap_or(true),
                        text: child.text().unwrap_or("").to_string(),
                        partial: child.attribute("partial") == Some("true"),
                    });
                } else {
                    set_input_and_placeholder(&child, &mut set);
                }
            }
            data.config_sets.insert(id, set);
        }
    }
    // Migration/empty-block fallback (ConfigTabClass:Load): every config set ends up with at
    // least one custom-mod block.
    // Legacy `input.customMods` (ConfigTab.lua:926-933) migrates into a "Default" block when the
    // list is empty or a single empty block, and is then cleared from `input`.
    for set in data.config_sets.values_mut() {
        let legacy = match set.input.get("customMods") {
            Some(OwnedOptionValue::Str(s)) => s.to_string(),
            _ => String::new(),
        };
        let list_empty_ish = set.custom_mods.is_empty() || (set.custom_mods.len() == 1 && set.custom_mods[0].text.is_empty());
        if !legacy.is_empty() && list_empty_ish {
            set.custom_mods = vec![CustomModBlock { title: "Default".into(), enabled: true, text: legacy, partial: false }];
        } else if set.custom_mods.is_empty() {
            set.custom_mods.push(CustomModBlock { title: "Default".into(), enabled: true, text: String::new(), partial: false });
        }
        set.input.remove("customMods");
    }
    Ok(data)
}

/// `modLib.setSource` (Modules/ModTools.lua ~239) sets `mod.source`, and, when the mod's value is
/// itself a table with a nested `.mod` (the `MinionModifier`/`EnemyModifier`/`ExtraAura` wrapper
/// style), stamps that inner mod's `source` field too. Skip this step and a wrapped custom mod
/// gets a source on the outer mod only; the inner mod's map ends up missing `source` entirely,
/// which does not match the recording.
fn set_source_recursive(m: &mut Mod, source: &std::sync::Arc<str>) {
    m.source = Some(source.clone());
    if let pom_engine::value::Value::Map(fields) = &m.value {
        if let Some((_, inner)) = fields.iter().find(|(k, _)| k.as_str() == "mod") {
            if let pom_engine::value::Value::Map(inner_fields) = inner {
                let mut new_fields: Vec<(pom_engine::sym::Sym, pom_engine::value::Value)> =
                    inner_fields.iter().filter(|(k, _)| k.as_str() != "source").cloned().collect();
                new_fields.push((pom_engine::sym!("source"), pom_engine::value::Value::Str(source.clone())));
                new_fields.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
                let new_inner = pom_engine::value::Value::Map(std::sync::Arc::new(new_fields));
                let mut outer_fields: Vec<(pom_engine::sym::Sym, pom_engine::value::Value)> =
                    fields.iter().map(|(k, v)| if k.as_str() == "mod" { (k.clone(), new_inner.clone()) } else { (k.clone(), v.clone()) }).collect();
                outer_fields.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
                m.value = pom_engine::value::Value::Map(std::sync::Arc::new(outer_fields));
            }
        }
    }
}

/// Port of `BuildModList`'s tail: parses each enabled custom-modifier-block line through
/// `modparser::parse_mod` and appends the results to `mods`, tagged with a `Custom:<title>`
/// source, matching upstream. This includes `modLib.setSource`'s inner-mod stamp for wrapped
/// mods; see `set_source_recursive`.
pub fn apply_custom_mods(blocks: &[CustomModBlock], mods: &mut Vec<Mod>) {
    for block in blocks {
        if !block.enabled || block.text.is_empty() {
            continue;
        }
        // `"Custom:" .. (block.title or "Default")` (ConfigTab.lua's BuildModList): Lua's `or`
        // only falls back on nil, never on an empty string, so a block loaded with an explicit
        // empty `title=""` attribute stays "Custom:" (not "Custom:Default"). `block.title` here
        // is a plain `String`, never absent, so no fallback applies.
        let source: std::sync::Arc<str> = format!("Custom:{}", block.title).into();
        for line in block.text.split('\n') {
            let stripped = strip_escapes(line).trim().to_string();
            let (parsed, extra) = pom_engine::modparser::parse_mod(&stripped);
            if let Some(parsed) = parsed.filter(|_| block.partial || extra.is_none()) {
                for pmod in &parsed {
                    let mut m = pom_engine::modparser::types::pmod_to_mod(pmod);
                    set_source_recursive(&mut m, &source);
                    mods.push(m);
                }
            }
        }
    }
}

/// `StripEscapes` (Modules/Common.lua): removes the `^n`/`^xRRGGBB` color-escape sequences.
fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' {
            match chars.peek() {
                Some('x') | Some('X') => {
                    chars.next();
                    for _ in 0..6 {
                        chars.next();
                    }
                }
                Some(d) if d.is_ascii_digit() => {
                    chars.next();
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn to_owned_option_value(v: &OptionValue) -> OwnedOptionValue {
    OwnedOptionValue::from_generated(v)
}

/// Reads a value's effective numeric/list `OptionType` gate the same way BuildModList's dispatch
/// loop does, for callers building `input`/`placeholder` maps outside `xml::parse_config` (e.g.
/// tests). Not used by the golden test, which loads recorded maps directly.
pub fn option_type_of(var: &str) -> Option<OptionType> {
    ALL_OPTION_DEFAULTS.iter().find(|m| m.var == var).map(|m| m.ty)
}

/// XML attribute-value normalization turns a literal newline inside a quoted attribute into a space
/// (roxmltree follows the spec), but upstream parser keeps it - and multi-line `customMods`
/// inputs depend on that (each line is parsed separately). Rewrites raw `\n`/`\r\n`/`\r` inside
/// tag attribute values to `&#10;` so they survive the normalization.
/// The build's top-level `<Config ...>...</Config>` (or self-closing `<Config .../>`) element. Item and modifier
/// text is escaped, so a raw `<Config` can only start that element.
fn config_section(xml: &str) -> Option<&str> {
    let b = xml.as_bytes();
    let mut from = 0;
    let start = loop {
        let i = from + xml[from..].find("<Config")?;
        if matches!(b.get(i + 7), Some(b' ' | b'>' | b'/' | b'\t' | b'\r' | b'\n')) {
            break i;
        }
        from = i + 7;
    };
    let tag_end = start + xml[start..].find('>')?;
    if b[tag_end - 1] == b'/' {
        return Some(&xml[start..=tag_end]);
    }
    let end = tag_end + xml[tag_end..].find("</Config>")? + "</Config>".len();
    Some(&xml[start..end])
}

fn preserve_attr_newlines(xml: &str) -> std::borrow::Cow<'_, str> {
    if !xml.contains('\n') && !xml.contains('\r') {
        return std::borrow::Cow::Borrowed(xml);
    }
    let mut out = String::with_capacity(xml.len() + 64);
    let mut in_tag = false;
    let mut quote: Option<char> = None;
    let mut chars = xml.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                    out.push(c);
                } else if c == '\r' {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    out.push_str("&#10;");
                } else if c == '\n' {
                    out.push_str("&#10;");
                } else {
                    out.push(c);
                }
            }
            None => {
                if in_tag && (c == '"' || c == '\'') {
                    quote = Some(c);
                } else if c == '<' {
                    // `<!--`, `<![CDATA[` and `<?...?>` hold no attributes.
                    in_tag = !matches!(chars.peek(), Some('!') | Some('?'));
                } else if c == '>' {
                    in_tag = false;
                }
                out.push(c);
            }
        }
    }
    std::borrow::Cow::Owned(out)
}
