//! What the Calcs tab needs beyond the section rows: the state of its skill controls (`CalcsTab`'s "View Skill Details"
//! section and `Build:RefreshSkillSelectControls`) and the modifier tables of its breakdown popups
//! (`CalcBreakdownControl:AddModSection`). Both read the finished Calcs-mode calculation that `calcs` keeps.
use crate::offence::Captured;
use crate::Env;
use pom_breakdown as bd;
use serde_json::{json, Value};
use std::cell::RefCell;

thread_local! {
    /// The names of the minion skills the last calculation made for the main skill's minion (`minion.activeSkillList`).
    static MINION_SKILLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Called by the minion setup with the names of the skills it created, in order.
pub(crate) fn note_minion_skills(names: Vec<String>) {
    MINION_SKILLS.with(|m| *m.borrow_mut() = names);
}

pub(crate) fn clear_minion_skills() {
    MINION_SKILLS.with(|m| m.borrow_mut().clear());
    LISTS.with(|l| *l.borrow_mut() = Lists::default());
}

/// `output.BuffList`, `output.CurseList` and `output.Minion.BuffList` of the last Calcs-mode calculation (Calcs.lua:762-863).
#[derive(Default, Clone)]
pub(crate) struct Lists {
    pub buff: String,
    pub curse: String,
    pub minion_buff: String,
}

/// The modifiers behind the buff and debuff lists with their values (`breakdown.SkillBuffs.modList` and `SkillDebuffs.modList`).
#[derive(Default)]
pub(crate) struct ListRows {
    pub buffs: Vec<(bd::value::Value, bd::modifier::Mod)>,
    pub debuffs: Vec<(bd::value::Value, bd::modifier::Mod)>,
    pub minion_buffs: Vec<(bd::value::Value, bd::modifier::Mod)>,
}

thread_local! {
    static LISTS: RefCell<Lists> = RefCell::new(Lists::default());
    static LIST_ROWS: RefCell<ListRows> = RefCell::new(ListRows::default());
}

pub(crate) fn set_list_rows(r: ListRows) {
    LIST_ROWS.with(|c| *c.borrow_mut() = r);
}

pub(crate) fn take_list_rows() -> ListRows {
    LIST_ROWS.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

pub(crate) fn set_lists(l: Lists) {
    LISTS.with(|c| *c.borrow_mut() = l);
}

/// Lua's `tostring` of a count.
pub(crate) fn lua_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

const SHRINES: &[(&str, &str)] = &[
    ("AccelerationShrine", "Acceleration Shrine"),
    ("BrutalShrine", "Brutal Shrine"),
    ("DiamondShrine", "Diamond Shrine"),
    ("DivineShrine", "Divine Shrine"),
    ("EchoingShrine", "Echoing Shrine"),
    ("GloomShrine", "Gloom Shrine"),
    ("GreaterFreezingShrine", "Greater Freezing Shrine"),
    ("GreaterShockingShrine", "Greater Shocking Shrine"),
    ("GreaterSkeletalShrine", "Greater Skeletal Shrine"),
    ("ImpenetrableShrine", "Impenetrable Shrine"),
    ("MassiveShrine", "Massive Shrine"),
    ("ReplenishingShrine", "Replenishing Shrine"),
    ("ResistanceShrine", "Resistance Shrine"),
    ("ResonatingShrine", "Resonating Shrine"),
    ("LesserAccelerationShrine", "Lesser Acceleration Shrine"),
    ("LesserBrutalShrine", "Lesser Brutal Shrine"),
    ("LesserImpenetrableShrine", "Lesser Impenetrable Shrine"),
    ("LesserMassiveShrine", "Lesser Massive Shrine"),
    ("LesserReplenishingShrine", "Lesser Replenishing Shrine"),
    ("LesserResistanceShrine", "Lesser Resistance Shrine"),
    ("BloodShrineOfRats", "Blood Shrine of Rats"),
    ("BloodShrineOfLocusts", "Blood Shrine of Locusts"),
    ("BloodShrineOfToads", "Blood Shrine of Toads"),
    ("BloodShrineOfCrows", "Blood Shrine of Crows"),
    ("BloodShrineOfBats", "Blood Shrine of Bats"),
];

/// Whether any modifier of the store carries a `Multiplier` (or threshold) tag on `var`, in `var` or `varList`
/// (`mainEnv.multipliersUsed[var]`: the main calculation looked the multiplier up).
fn mod_uses(m: &pom_engine::modifier::Mod, var: &str) -> bool {
    let var_sym = pom_engine::sym::Sym::new("var");
    let list_sym = pom_engine::sym::Sym::new("varList");
    m.tags.iter().any(|t| {
        matches!(t.kind.as_str(), "Multiplier" | "MultiplierThreshold")
            && (matches!(t.get(var_sym), pom_engine::value::Value::Str(s) if s.as_ref() == var)
                || matches!(t.get(list_sym), pom_engine::value::Value::List(l) if l.iter().any(|x| matches!(x, pom_engine::value::Value::Str(s) if s.as_ref() == var))))
    })
}

fn multiplier_used(store: &pom_engine::modstore::store::ModStore, var: &str) -> bool {
    let var_sym = pom_engine::sym::Sym::new("var");
    let list_sym = pom_engine::sym::Sym::new("varList");
    let mut used = false;
    let mut visit = |m: &pom_engine::modifier::Mod| {
        if used {
            return;
        }
        used = m.tags.iter().any(|t| {
            matches!(t.kind.as_str(), "Multiplier" | "MultiplierThreshold")
                && (matches!(t.get(var_sym), pom_engine::value::Value::Str(s) if s.as_ref() == var)
                    || matches!(t.get(list_sym), pom_engine::value::Value::List(l) if l.iter().any(|x| matches!(x, pom_engine::value::Value::Str(s) if s.as_ref() == var))))
        });
    };
    let mut cur = Some(store);
    while let Some(st) = cur {
        match &st.backing {
            pom_engine::modstore::store::Backing::List(l) => l.iter().for_each(&mut visit),
            pom_engine::modstore::store::Backing::Db(m) => m.values().flatten().for_each(&mut visit),
        }
        cur = st.parent.as_deref();
    }
    used
}

/// The player's `output.CombatList` (Calcs.lua:597-740): charges, then the flags that are on, then the shrines.
pub(crate) fn player_combat_list(store: &pom_engine::modstore::store::ModStore, others: &[&pom_engine::modstore::store::ModStore], skills: &[pom_skills::assemble::ComputedSkill], output: &dyn Fn(&str) -> f64, cruelty: bool) -> String {
    let multiplier_used = |s: &pom_engine::modstore::store::ModStore, var: &str| multiplier_used(s, var) || others.iter().any(|o| multiplier_used(o, var)) || skills.iter().any(|c| c.skill_mod_list.iter().any(|m| mod_uses(m, var)));
    let flag = |n: &str| store.flag(None, &[pom_engine::sym::Sym::new(n)]);
    let mut l: Vec<String> = Vec::new();
    let charge = |l: &mut Vec<String>, key: &str, label: &str| {
        if output(key) > 0.0 {
            l.push(format!("{} {label}", lua_num(output(key))));
        }
    };
    charge(&mut l, "PowerCharges", "Power Charges");
    charge(&mut l, "AbsorptionCharges", "Absorption Charges");
    charge(&mut l, "FrenzyCharges", "Frenzy Charges");
    charge(&mut l, "AfflictionCharges", "Affliction Charges");
    charge(&mut l, "EnduranceCharges", "Endurance Charges");
    charge(&mut l, "BrutalCharges", "Brutal Charges");
    charge(&mut l, "BrineCharges", "Brine Charges");
    charge(&mut l, "SiphoningCharges", "Siphoning Charges");
    charge(&mut l, "ChallengerCharges", "Challenger Charges");
    charge(&mut l, "BlitzCharges", "Blitz Charges");
    if multiplier_used(store, "InspirationCharge") {
        l.push(format!("{} Inspiration Charges", lua_num(output("InspirationCharges"))));
    }
    charge(&mut l, "GhostShrouds", "Ghost Shrouds");
    charge(&mut l, "CrabBarriers", "Crab Barriers");
    if multiplier_used(store, "BloodCharge") {
        l.push(format!("{} Blood Charges", lua_num(output("BloodCharges"))));
    }
    if multiplier_used(store, "SpiritCharge") {
        l.push(format!("{} Spirit Charges", lua_num(output("SpiritCharges"))));
    }
    if multiplier_used(store, "SpiritInfusion") {
        l.push(format!("{} Spirit Infusions", lua_num(output("SpiritInfusions"))));
    }
    if cruelty {
        l.push("Cruelty".to_string());
    }
    for (f, n) in [("Fortify", "Fortify"), ("Onslaught", "Onslaught"), ("UnholyMight", "Unholy Might"), ("ChaoticMight", "Chaotic Might"), ("Tailwind", "Tailwind"), ("Adrenaline", "Adrenaline"), ("AlchemistsGenius", "Alchemist's Genius"), ("HerEmbrace", "Her Embrace")] {
        if flag(f) {
            l.push(n.to_string());
        }
    }
    for (f, n) in SHRINES {
        if flag(f) {
            l.push((*n).to_string());
        }
    }
    if flag("Elusive") {
        l.push("Elusive".to_string());
    }
    l.join(", ")
}

/// The minion's `output.Minion.CombatList` (Calcs.lua:808-850).
pub(crate) fn minion_combat_list(store: &pom_engine::modstore::store::ModStore, output: &dyn Fn(&str) -> f64) -> String {
    let flag = |n: &str| store.flag(None, &[pom_engine::sym::Sym::new(n)]);
    let mut l: Vec<String> = Vec::new();
    for (k, n) in [("PowerCharges", "Power Charges"), ("FrenzyCharges", "Frenzy Charges"), ("EnduranceCharges", "Endurance Charges")] {
        if output(k) > 0.0 {
            l.push(format!("{} {n}", lua_num(output(k))));
        }
    }
    for (f, n) in [("Fortify", "Fortify"), ("Onslaught", "Onslaught"), ("UnholyMight", "Unholy Might"), ("ChaoticMight", "Chaotic Might"), ("Tailwind", "Tailwind"), ("DiamondShrine", "Diamond Shrine"), ("MassiveShrine", "Massive Shrine")] {
        if flag(f) {
            l.push(n.to_string());
        }
    }
    l.join(", ")
}

fn sorted(set: std::collections::HashSet<String>) -> Vec<String> {
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

fn skill_data_num(cap: &Captured, key: &str) -> Option<f64> {
    match cap.skill_data.get(key) {
        Some(pom_engine::modstore::types::ScalarValue::Num(n)) => Some(*n),
        _ => None,
    }
}

/// The skill controls' state for the player's Calcs skill: which controls apply, their lists and the selected entry.
pub(crate) fn view_info(env: &Env, caps: &[Captured], show_minion: bool, buff_mode: &str) -> Value {
    let player = caps.iter().find(|c| !c.minion);
    let minion = caps.iter().find(|c| c.minion);
    let Some(pc) = player else { return Value::Null };
    let displayed = if show_minion { minion.unwrap_or(pc) } else { pc };
    let ge = pom_skills::data::all_skills().get(&pc.main.granted_effect_id);
    let parts: Vec<String> = ge
        .and_then(pom_skills::data::parts)
        .map(|a| a.iter().filter_map(|p| p.as_object().and_then(|o| o.get("name")).and_then(|n| n.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let part = pc.main.gem_skill_part.unwrap_or(1).max(1);
    let part_stages = ge.and_then(pom_skills::data::parts).and_then(|a| a.get((part as usize).saturating_sub(1))).and_then(|p| p.as_object()).map(|o| o.contains_key("stages")).unwrap_or(false);
    let stage_min = ge.and_then(pom_skills::data::parts).and_then(|a| a.get((part as usize).saturating_sub(1))).and_then(|p| p.as_object()).and_then(|o| o.get("stagesMin")).and_then(|v| v.as_f64());
    let stage_default = skill_data_num(pc, "stagesMax").or(stage_min).or_else(|| skill_data_num(pc, "stagesMin")).unwrap_or(1.0);
    let player_flags = crate::calcs::skill_flags(env, pc);
    let displayed_flags = crate::calcs::skill_flags(env, displayed);
    let minions: Vec<Value> = pc
        .main
        .minion_list
        .iter()
        .map(|id| {
            let name = pom_calc::data::minion_raw(id).and_then(|r| r.get("name")).and_then(|n| n.as_str()).unwrap_or(id).to_string();
            json!({ "id": id, "label": name })
        })
        .collect();
    let minion_selected = pc.main.src_skill_minion.clone().filter(|m| pc.main.minion_list.contains(m)).or_else(|| pc.main.minion_list.first().cloned());
    let minion_skills = if minion.is_some() { MINION_SKILLS.with(|m| m.borrow().clone()) } else { Vec::new() };
    let have_minion = player_flags.contains("haveMinion") || minion.is_some();
    let lists = LISTS.with(|l| l.borrow().clone());
    let out = |k: &str| env.output.get(k).copied().unwrap_or(0.0);
    let player_lists = json!({
        "buff": lists.buff,
        "combat": player_combat_list(&env.player, &[&pc.skill_mod_list, &env.enemy], &env.active_skills, &out, pc.skill_mod_list.flag(None, &[pom_engine::sym::Sym::new("Cruelty")])),
        "curse": lists.curse,
    });
    let minion_lists = minion.map(|m| {
        let mo = |k: &str| m.output.get(k).copied().unwrap_or(0.0);
        json!({ "buff": lists.minion_buff, "combat": minion_combat_list(&m.player, &mo), "curse": lists.curse })
    });
    json!({
        "lists": player_lists,
        "minionLists": minion_lists,
        "showMinion": show_minion && minion.is_some(),
        "buffMode": buff_mode,
        "skillName": pc.main.name,
        "flags": sorted(displayed_flags),
        "playerFlags": sorted(player_flags),
        "haveMinion": have_minion,
        "parts": parts,
        "part": part,
        "partHasStages": part_stages,
        "stageCount": pc.main.stage_count,
        "stageDefault": stage_default,
        "mineCount": pc.main.active_mine_count,
        "minions": minions,
        "minion": minion_selected,
        "spectre": pc.main.is_spectre,
        "minionHasItemSet": pc.main.minion_has_item_set,
        "minionItemSet": pc.main.src_skill_minion_item_set,
        "minionSkills": minion_skills,
        "minionSkill": pc.main.src_skill_minion_skill.unwrap_or(1),
    })
}

/// The modifier table of one popup entry, as `CalcBreakdownControl:AddModSection` builds it.
pub(crate) fn mod_table(build: &bd::record::BreakdownBuild, rows: &ListRows, detail: &Value) -> Option<Value> {
    let skill_name = |id: &str| pom_skills::data::granted_effect_by_skill_id(id).and_then(|g| g.name.clone());
    // The buff and debuff lists carry their own modifiers (`breakdown.modList`).
    match detail.get("breakdown").and_then(|v| v.as_str()) {
        Some("SkillBuffs") => {
            let minion = detail.get("minion").and_then(|v| v.as_bool()).unwrap_or(false);
            return bd::popup::mod_list_section(if minion { &rows.minion_buffs } else { &rows.buffs }, &skill_name);
        }
        Some("SkillDebuffs") => return bd::popup::mod_list_section(&rows.debuffs, &skill_name),
        _ => {}
    }
    let get_s = |k: &str| detail.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    let d = bd::sections::Detail {
        label: get_s("label"),
        breakdown: get_s("breakdown"),
        mod_type: get_s("modType"),
        cfg: get_s("cfg"),
        enemy: detail.get("enemy").and_then(|v| v.as_bool()).unwrap_or(false),
        actor: get_s("actor"),
        mod_source: get_s("modSource"),
        mod_name: detail.get("modName").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()),
        flag: None,
        not_flag: None,
        player_flag: None,
        have_output: None,
        flag_list: None,
        not_flag_list: None,
        gear_only: false,
    };
    let ctx = bd::format::ModRenderCtx { player_store: &build.player_store, skill_store: build.skill_mod_list_store.as_deref(), enemy_store: build.enemy_store.as_deref(), cfgs: &build.cfgs };
    bd::popup::mod_section(&d, &ctx, &skill_name)
}

/// `<Calcs><Input name=".." string=".."/>` of the build text (the Calcs tab's saved inputs).
pub(crate) fn calcs_input_string(xml: &str, name: &str) -> Option<String> {
    let doc = roxmltree::Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    let calcs = doc.root_element().children().find(|n| n.is_element() && n.tag_name().name() == "Calcs")?;
    calcs
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "Input" && n.attribute("name") == Some(name))
        .filter_map(|n| n.attribute("string").map(|s| s.to_string()))
        .last()
}
