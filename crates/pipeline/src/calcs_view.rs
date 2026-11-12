//! The build text the Calcs tab calculates: `calcs.buildOutput(build, "CALCS")` is a second calculation of the same
//! build, not a copy of the main one. It takes its skill from the Calcs tab's own selection (`<Input
//! name="skill_number">` = the socket group, that group's `mainActiveSkillCalcs` = the skill in it) and reads the
//! `...Calcs` variant of the gem's part, minion, minion item set and minion skill, stage count and mine count
//! (CalcSetup.lua:1585-1590 and 1882-1886, CalcActiveSkill.lua:250, 623, 649, 694, 736, 924).
//!
//! The live engine only runs the MAIN calculation, so this builds the XML in which those choices are the build's own:
//! calculating that XML in the engine's one (EFFECTIVE) buff mode is the CALCS calculation. A Calcs tab set to another
//! buff mode (`misc_buffMode` COMBAT, BUFFED, UNBUFFED) is not reproduced: the engine has no such mode.
use pom_engine::data::GameData;
use roxmltree::{Document, Node};

struct Edits(Vec<(usize, usize, String)>);

impl Edits {
    /// Sets (or, with `None`, removes) attribute `name` of `node`.
    fn set(&mut self, node: &Node, name: &str, value: Option<&str>) {
        let existing = node.attributes().find(|a| a.name() == name);
        match (existing, value) {
            (Some(a), Some(v)) => self.0.push((a.range().start, a.range().end, format!("{name}=\"{}\"", esc(v)))),
            (Some(a), None) => self.0.push((a.range().start, a.range().end, String::new())),
            (None, Some(v)) => {
                let at = node.range().start + 1 + node.tag_name().name().len();
                self.0.push((at, at, format!(" {name}=\"{}\"", esc(v))));
            }
            (None, None) => {}
        }
    }

    fn apply(mut self, xml: &str) -> String {
        self.0.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        let mut out = xml.to_string();
        for (s, e, r) in self.0 {
            out.replace_range(s..e, &r);
        }
        out
    }
}

fn esc(v: &str) -> String {
    v.replace('&', "&amp;").replace('<', "&lt;").replace('"', "&quot;")
}

fn child_elems<'a, 'i>(n: &Node<'a, 'i>, name: &str) -> Vec<Node<'a, 'i>> {
    n.children().filter(|c| c.is_element() && c.tag_name().name() == name).collect()
}

/// A numeric attribute that isn't the literal `nil` upstream writes for an unset value.
fn num_attr(n: &Node, name: &str) -> Option<String> {
    n.attribute(name).filter(|v| v.trim().parse::<f64>().is_ok()).map(|v| v.to_string())
}

fn str_attr(n: &Node, name: &str) -> Option<String> {
    n.attribute(name).filter(|v| !v.is_empty() && *v != "nil").map(|v| v.to_string())
}

/// The active skill set's `<Skill>` elements (`SkillsTabClass:Load`'s rules, as `pom_skills::xmlskills` reads them).
fn active_groups<'a, 'i>(skills: &Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
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
                sets.retain(|s| s.0 != id);
                sets.push((id, child_elems(&c, "Skill")));
                order.push(id);
            }
            _ => {}
        }
    }
    let active_id = skills.attribute("activeSkillSet").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let chosen = sets.iter().position(|s| s.0 == active_id).or_else(|| order.first().and_then(|o| sets.iter().position(|s| s.0 == *o)));
    chosen.map(|i| sets.swap_remove(i).1).unwrap_or_default()
}

/// Step one: the group and skill the Calcs tab picked, and the stage, mine and minion-skill counts of every gem.
fn pick_group(xml: &str) -> Option<String> {
    let doc = Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    let root = doc.root_element();
    let build = child_elems(&root, "Build").into_iter().next()?;
    let skills = child_elems(&root, "Skills").into_iter().next();
    let groups = skills.as_ref().map(active_groups).unwrap_or_default();
    let skill_number = child_elems(&root, "Calcs")
        .into_iter()
        .next()
        .and_then(|c| c.children().filter(|n| n.is_element() && n.tag_name().name() == "Input" && n.attribute("name") == Some("skill_number")).filter_map(|n| n.attribute("number").and_then(|v| v.parse::<f64>().ok())).last())
        .map(|v| v as i64)
        .unwrap_or(1);
    let sel = skill_number.min(groups.len().max(1) as i64).max(1);
    let mut e = Edits(Vec::new());
    e.set(&build, "mainSocketGroup", Some(&sel.to_string()));
    if let Some(g) = groups.get(sel as usize - 1) {
        let idx = num_attr(g, "mainActiveSkillCalcs").unwrap_or_else(|| "1".to_string());
        e.set(g, "mainActiveSkill", Some(&idx));
    }
    if let Some(sk) = &skills {
        for gem in sk.descendants().filter(|n| n.is_element() && n.tag_name().name() == "Gem") {
            e.set(&gem, "skillStageCount", num_attr(&gem, "skillStageCountCalcs").as_deref());
            e.set(&gem, "skillMineCount", num_attr(&gem, "skillMineCountCalcs").as_deref());
            e.set(&gem, "skillMinionSkill", num_attr(&gem, "skillMinionSkillCalcs").as_deref());
        }
    }
    Some(e.apply(xml))
}

/// Step two: the Calcs main skill's own gem takes its `...Calcs` part, minion and minion item set.
fn pick_gem(xml: &str, group_xml_index: usize, gem_index: usize) -> Option<String> {
    let doc = Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    let root = doc.root_element();
    let skills = child_elems(&root, "Skills").into_iter().next()?;
    let groups = active_groups(&skills);
    let gem = child_elems(groups.get(group_xml_index)?, "Gem").into_iter().nth(gem_index)?;
    let mut e = Edits(Vec::new());
    e.set(&gem, "skillPart", num_attr(&gem, "skillPartCalcs").as_deref());
    e.set(&gem, "skillMinion", str_attr(&gem, "skillMinionCalcs").as_deref());
    e.set(&gem, "skillMinionItemSet", num_attr(&gem, "skillMinionItemSetCalcs").as_deref());
    Some(e.apply(xml))
}

/// The XML whose main-skill calculation is the Calcs tab's calculation (see the module doc).
pub fn calcs_view_xml(xml: &str, game: &'static GameData) -> String {
    let Some(step1) = pick_group(xml) else { return xml.to_string() };
    crate::reset_build_state();
    let mut level: Option<i64> = None;
    let sel = crate::build_env(&step1, game).ok().and_then(|env| {
        // `EstimatePlayerProgress` (Build.lua:898-914) moves an auto-level build to the level its allocated points imply
        // before the Calcs tab calculates; the stats the main calculation shows were made at the level the file saved.
        if is_auto_level(&step1) {
            let extra = env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("ExtraPoints")]);
            level = Some(estimated_level(env.points_used as f64, extra));
        }
        let m = crate::offence::select_main_skill(&env.xml_text, &env.active_skills)?;
        Some((m.group_xml_index?, m.gem_index?))
    });
    crate::reset_build_state();
    let mut out = match sel.and_then(|(g, i)| pick_gem(&step1, g, i)) {
        Some(x) => x,
        None => step1,
    };
    if let Some(l) = level {
        out = set_level(&out, l).unwrap_or(out);
    }
    out
}

fn is_auto_level(xml: &str) -> bool {
    Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() })
        .ok()
        .and_then(|doc| child_elems(&doc.root_element(), "Build").into_iter().next().map(|b| b.attribute("characterLevelAutoMode") == Some("true")))
        .unwrap_or(false)
}

fn set_level(xml: &str, level: i64) -> Option<String> {
    let doc = Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    let build = child_elems(&doc.root_element(), "Build").into_iter().next()?;
    let mut e = Edits(Vec::new());
    e.set(&build, "level", Some(&level.to_string()));
    Some(e.apply(xml))
}

/// `buildMode:EstimatePlayerProgress`'s level: the first act whose level range holds the points used (Build.lua:729-769,
/// 903-908).
fn estimated_level(points_used: f64, extra: f64) -> i64 {
    // (act's level, its quest points)
    const ACTS: [(f64, f64); 11] = [(1.0, 0.0), (12.0, 2.0), (22.0, 4.0), (32.0, 6.0), (40.0, 7.0), (44.0, 9.0), (50.0, 12.0), (54.0, 15.0), (60.0, 18.0), (64.0, 20.0), (67.0, 23.0)];
    let mut act = 0;
    loop {
        act += 1;
        let (act_level, quest_points) = ACTS[act - 1];
        let act_extra = if act > 2 { extra } else { 0.0 };
        let level = (points_used + 1.0 - quest_points - act_extra).max(act_level).min(100.0);
        if act == 11 || level <= ACTS[act].0 {
            return level as i64;
        }
    }
}

/// The buff mode the build's Calcs tab was saved in (`<Calcs><Input name="misc_buffMode" string="..."/>`, the last one
/// wins as `CalcsTab:Load` reads them in order); EFFECTIVE when the build saved none.
pub fn saved_buff_mode(xml: &str) -> pom_calc::setup::BuffMode {
    let name = Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() })
        .ok()
        .and_then(|doc| {
            let root = doc.root_element();
            let calcs = child_elems(&root, "Calcs").into_iter().next()?;
            let last = calcs.children().filter(|n| n.is_element() && n.tag_name().name() == "Input" && n.attribute("name") == Some("misc_buffMode")).filter_map(|n| n.attribute("string").map(|s| s.to_string())).last();
            last
        });
    pom_calc::setup::BuffMode::from_name(name.as_deref().unwrap_or("EFFECTIVE"))
}
