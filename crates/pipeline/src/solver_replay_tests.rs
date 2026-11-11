//! Fixes pinned on frozen replays and solve results (testdata/replay-*.xml, testdata/solve-result-*.xml), one test each.

use super::*;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn solver_on(xml: &str, goal: &str) -> Solver {
    clear::load_text_rules();
    pom_engine::modparser::text_rules::set_active(true);
    let goal: Goal = serde_json::from_str(goal).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    Solver::new(xml.to_string(), goal, serde_json::from_str(r#"{"timeBudgetMs":3600000,"threads":4}"#).unwrap(), shared, Arc::new(AtomicBool::new(false))).unwrap()
}

/// The Chaos Mastery's "Lose 10% of Life and Energy Shield when you use a Chaos Skill" reads as "-10 Life" with
/// the rest dropped (ModCache.lua 17462): a cost the score never sees. Lines the engine reads whole stay.
#[test]
fn partly_read_cost_lines_are_unpriced_downsides() {
    clear::load_text_rules();
    pom_engine::modparser::text_rules::set_active(true);
    assert!(unpriced_downside("Lose 10% of Life and Energy Shield when you use a Chaos Skill"));
    for ok in ["+1 to Level of all Chaos Skill Gems", "Lose 1.5 Life per second", "10% increased maximum Life", "Regenerate 2% of Life per second"] {
        assert!(!unpriced_downside(ok), "{ok}");
    }
    let (_, effects) = &*downside_passives("3_29");
    assert!(!effects.is_empty(), "no mastery effect read as a free cost");
}

/// On the ED replay (frozen ed-cli): the Chaos Mastery the build took goes, and the finish leaves no passive or
/// mastery effect with a free cost.
#[test]
fn ed_replay_gives_back_the_chaos_mastery() {
    let xml = fixture("replay-ed-cli.xml");
    let mut s = solver_on(&xml, &fixture("goal-ed.json"));
    let mut st = s.frozen_state(&xml).unwrap();
    let bad = s.downside(st.class);
    let held = |st: &State| st.masteries.iter().filter(|(n, e)| st.nodes.contains(n) && bad.1.contains(e)).count() + st.nodes.iter().filter(|n| bad.0.contains(n)).count();
    assert!(held(&st) > 0, "the frozen ED build holds no free-cost mastery");
    s.downside_pass(&mut st).unwrap();
    assert_eq!(held(&st), 0, "a free-cost mastery or passive left");
}

/// `finish` on a frozen replay, and the checks every finish must pass : the record's "after" is the
/// written build's, the last step is the listing's own, and every difference between the build given and the build
/// written is named by a logged step's changes. Returns the record.
fn finish_checked(file: &str, goal: &str, budget_ms: u64) -> Value {
    clear::load_text_rules();
    pom_engine::modparser::text_rules::set_active(true);
    let (before, after, rec) = finish::finish(fixture(file), &fixture(goal), &format!(r#"{{"timeBudgetMs":{budget_ms},"maxEvals":40000,"threads":6}}"#)).unwrap();
    let steps = rec["kept"].as_array().cloned().unwrap_or_default();
    let last = steps.last().expect("no step logged");
    assert_eq!(last["op"], "written", "{file}: the listing is no logged step");
    assert_eq!(rec["after"], last["after"], "{file}: the record's after is not the written build");
    let logged: HashSet<String> = steps.iter().flat_map(|s| s["changes"].as_array().cloned().unwrap_or_default()).filter_map(|c| c.as_str().map(String::from)).collect();
    let missing: Vec<String> = finish::xml_diff(&before, &after).into_iter().filter(|d| !logged.contains(d)).collect();
    assert!(missing.is_empty(), "{file}: changes no step names: {missing:#?}");
    rec
}

/// On the FS replay (frozen fs-cli): the record said 1.72M and EHP 12.2k from a track the
/// fallback threw away, the written build is 1.23M and 11.6k, and War Banner and three emptied flask slots were in no
/// repair.
#[test]
fn fs_replay_record_is_the_written_build() {
    finish_checked("replay-fs-cli.xml", "goal-fs.json", 240_000);
}

/// On the pconc app replay (frozen pconc-app): the finish took EHP 33.1k to 12.9k (suppression 60% to 8%) under
/// "attribute nodes" and "curse delivery". A repair that removes no hard failure keeps EHP within the 15% cap, and a
/// step that goes past it says so.
#[test]
fn pconc_app_replay_keeps_ehp_within_the_cap() {
    let rec = finish_checked("replay-pconc-app.xml", "goal-pconc.json", 240_000);
    let (b, a) = (rec["before"]["TotalEHP"].as_f64().unwrap(), rec["after"]["TotalEHP"].as_f64().unwrap());
    let cap = 1.0 - super::plan::TRADE_GIVE;
    // (every step past the cap says what it costs; the whole finish past it is unresolved)
    for s in rec["kept"].as_array().into_iter().flatten() {
        let (x, y) = (s["before"]["TotalEHP"].as_f64().unwrap_or(0.0), s["after"]["TotalEHP"].as_f64().unwrap_or(0.0));
        let w = s["what"].as_str().unwrap_or("");
        assert!(s["op"] == "written" || y >= x * cap || w.contains("TotalEHP"), "step [{}] EHP {x:.0} -> {y:.0} does not say so: {w}", s["op"]);
    }
    let said = rec["unresolved"].as_array().into_iter().flatten().any(|u| u.as_str().is_some_and(|u| u.contains("trade-off cap")));
    assert!(a >= b * cap || said, "EHP {b:.0} -> {a:.0} and the record does not say so: {}", rec["unresolved"]);
}

/// On the LA solve: 15 Withered stacks came from Withering Step, which withers only while its
/// buff lasts (toggle 0 stacks: 280k to 149k). Only a totem's own cast rate holds stacks; the config keeps what the
/// main skill's chance on hit keeps up and no more.
#[test]
fn la_solve_withering_step_holds_no_stacks() {
    let xml = fixture("solve-result-la.xml");
    let mut s = solver_on(&xml, &fixture("goal-la.json"));
    let st = s.frozen_state(&xml).unwrap();
    assert!(st.utils.iter().any(|u| withering(u)), "the LA solve has no Withered skill");
    let on_hit = if s.goal.assume.ailments { s.wither_on_hit(&st, &st.nodes, &st.vals) } else { 0.0 };
    let n = st.base.split("multiplierWitheredStackCount\" number=\"").nth(1).and_then(|r| r.split('"').next()).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    assert!(n <= on_hit + 1e-6, "Withered {n} with {on_hit:.2} from hits and no totem");
}

/// On the RF replay (frozen rf-cli): Inspiration counted 5 charges under Blood Magic, where the skill spends no
/// mana (toggle 0 charges: 1,046k to 835k). A support that gains charges from mana spent gets none on a skill that
/// spends none.
#[test]
fn rf_replay_inspiration_gets_no_charges_without_mana() {
    let xml = fixture("replay-rf-cli.xml");
    let mut s = solver_on(&xml, &fixture("goal-rf.json"));
    let st = s.frozen_state(&xml).unwrap();
    assert!(st.main.iter().any(|g| mana_spent_charges(g)), "no charge-on-mana-spent support in the RF link");
    let cost = s.scorer.names.iter().position(|n| n == "ManaPerSecondCost").and_then(|i| st.vals[i]);
    assert!(st.base.contains("<Input name=\"overrideInspirationCharges\" number=\"0\"/>"), "Inspiration charges counted with mana cost {cost:?}");
}

/// On the LA solve: Lightning Arrow hits dealt 8k of 280k; Decay support 152k and the Mirage's Decay 108k. The
/// asked skill's own share has a floor, a hard limit the build fails.
#[test]
fn la_solve_fails_the_own_skill_floor() {
    let xml = fixture("solve-result-la.xml");
    let mut s = solver_on(&xml, &fixture("goal-la.json"));
    let st = s.frozen_state(&xml).unwrap();
    let share = s.scorer.names.iter().position(|n| n == "Solver.OwnSkillShare").and_then(|i| st.vals[i]);
    assert!(share.is_some_and(|v| v < OWN_SHARE), "own share {share:?}");
    assert!(s.hard_unmet(&st).iter().any(|h| h == OWN_SHARE_LIMIT), "{:?}", s.hard_unmet(&st));
}

/// On the LA replay (frozen la-cli): the finish deleted Bismuth and Hybrid and left flask slots 4 and 5 empty
/// ("no flask that does fits"). No flask slot is left empty; a defence flask counts for its EHP.
#[test]
fn la_replay_leaves_no_flask_slot_empty() {
    let rec = finish_checked("replay-la-cli.xml", "goal-la.json", 240_000);
    let flasks = rec["flasks"].as_array().cloned().unwrap_or_default();
    assert_eq!(flasks.len(), 5, "flask slots filled: {flasks:?}");
}

/// On the ED solve: Fencoil's "Socketed Gems are Supported by Level 8 Trap" made Essence Drain a trap. A unique
/// whose socketed support changes the asked skill's delivery is worn only by a skill already delivered that way.
#[test]
fn delivery_changing_uniques_stay_out() {
    assert!(socketed_delivery("Socketed Gems are Supported by Level 8 Trap").contains(&pom_skills::skill_type::TRAPPED));
    assert!(socketed_delivery("Socketed Gems are Supported by Level 10 Added Fire Damage").is_empty());
    let names = |skill: Option<&str>| items::unique_list(&items::ItemRules::default(), 90, skill, &|_, _| true).into_iter().map(|u| u.name.clone()).collect::<Vec<_>>();
    assert!(names(None).iter().any(|n| n == "Fencoil"), "no Fencoil in the list at all");
    assert!(!names(Some("Essence Drain")).iter().any(|n| n == "Fencoil"), "Fencoil offered to Essence Drain");
}

/// Unwavering Stance with 10k evasion (LA solve), Precise Technique with crit nodes (LA replay). Nodes naming
/// the stat a keystone's "Never ..."/"Cannot ..." line switches off are dead.
#[test]
fn keystone_switch_offs_kill_their_nodes() {
    for (file, stem) in [("solve-result-la.xml", "eva"), ("replay-la-cli.xml", "cri")] {
        let xml = fixture(file);
        let mut s = solver_on(&xml, &fixture("goal-la.json"));
        let st = s.frozen_state(&xml).unwrap();
        let stems = s.keystone_stems(&st);
        assert!(stems.iter().any(|(_, x)| x == stem), "{file}: no {stem} switch-off read");
        let named: Vec<i64> = st.nodes.iter().copied().filter(|&n| !stems.iter().any(|(k, _)| *k == n) && s.node_info(n).1.split(|c: char| !c.is_ascii_alphabetic()).any(|w| w.starts_with(stem))).collect();
        assert!(!named.is_empty(), "{file}: no allocated {stem} node");
        assert!(named.iter().all(|&n| s.node_dead(&st, n)), "{file}: a {stem} node still counts");
    }
}
