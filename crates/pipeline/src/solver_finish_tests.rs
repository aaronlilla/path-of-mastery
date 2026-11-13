//! What the finish check must catch in the Templar Flicker Strike result (testdata/finish-flicker.xml, the
//! app's top result for "templar build with a unique weapon with flicker strike", mid league, mapping).

use super::*;

const GOAL: &str = r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"limits":{"resists":75,"pool":3000,"attributes":true,"reservation":true,"warnings":true,"cost":true},"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"mapping","playMode":"mapping","ailments":true,"charges":true}}"#;

fn fixture() -> String {
    std::fs::read_to_string(format!("{}/testdata/finish-flicker.xml", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// The text of `<Item id="id">` in the fixture.
fn item(id: usize) -> String {
    let x = fixture();
    let a = x.find(&format!("<Item id=\"{id}\">")).unwrap() + format!("<Item id=\"{id}\">").len();
    x[a..a + x[a..].find("</Item>").unwrap()].to_string()
}

fn solver() -> Solver {
    let goal: Goal = serde_json::from_str(GOAL).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
}

fn eval_fixture(s: &Solver) -> Vals {
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    eval_one(&mut None, &Cand::Xml(Arc::new(fixture())), &names).unwrap()
}

fn limit(s: &Solver, v: &Vals, name: &str) -> f64 {
    let i = s.scorer.limits.iter().position(|l| l.name == name).unwrap_or_else(|| panic!("no limit {name}"));
    s.scorer.deficits(v)[i]
}

/// Eyes of the Greatwolf with "Selected Variant: 11" (Damage) and alt 19 (Crit Multiplier): its Power and Endurance
/// Charge on Kill lines (variants 22 and 23) are not on the item, so they earn no config switch.
#[test]
fn config_sources_read_only_the_selected_variant() {
    let amulet = item(7);
    let hits = config::line_hits(&config::item_lines(&amulet), "Eyes of the Greatwolf");
    let keys: Vec<&str> = hits.iter().map(|(s, _, _)| config::data().sw[*s].key.as_str()).collect();
    assert!(!keys.contains(&"usePowerCharges") && !keys.contains(&"useEnduranceCharges"), "a line of an unselected variant earned a switch: {hits:?}");
    // (the selected variants' lines are still read)
    let lines = config::item_lines(&amulet);
    assert!(lines.iter().any(|l| l.contains("increased Damage")) && lines.iter().any(|l| l.contains("Critical Strike Multiplier")), "{lines:?}");
    assert!(!lines.iter().any(|l| l.contains("{variant")), "tags stay on: {lines:?}");
}

/// Every config switch in a result's text is listed with a reason: the solver's own (kept switches, crit recently,
/// setup buffs), or one the goal sets (bandit, pantheon: in the base text before any switch).
#[test]
fn every_switch_set_is_listed() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    let xml = Arc::new(s.render(&st).unwrap());
    let vals = s.eval(vec![Cand::Xml(xml.clone())]).pop().flatten().unwrap();
    let (xml, vals, kept, _) = s.settle_config(&st, xml, vals);
    let xml = s.with_crit_flag(&xml, &vals);
    let listed: Vec<String> = kept.iter().map(|o| o.key.clone()).chain(s.owned_switches(&xml).into_iter().map(|(k, _)| k.to_string())).collect();
    let cfg = &xml[xml.find("<Config").unwrap()..xml.find("</Config>").unwrap()];
    let mut hidden = Vec::new();
    for (i, _) in cfg.match_indices("<Input name=\"") {
        let k = &cfg[i + 13..i + 13 + cfg[i + 13..].find('"').unwrap()];
        // (a switch written false undoes an upstream default the solver decided against: nothing is assumed on)
        let off = cfg[i..].split("/>").next().is_some_and(|t| t.contains("boolean=\"false\""));
        // (the bandit is the goal's, listed with the solve)
        if !off && k != "bandit" && !listed.iter().any(|l| l == k) && !s.base_xml.contains(&format!("<Input name=\"{k}\"")) {
            hidden.push(k.to_string());
        }
    }
    assert!(hidden.is_empty(), "set but not listed: {hidden:?}");
}

/// Foulborn Utula's Hunger: "+(1200-1800) to maximum Energy Shield if there are no Defence Modifiers on other Equipped
/// Items". Upstream checks the other items for the word "defence", so the helmet's "58% increased Armour and Evasion" does
/// not stop it; the game does. The solver does not pair them.
#[test]
fn utulas_es_needs_no_defence_lines_elsewhere() {
    let (body, helmet, ring) = (item(4), item(3), item(8));
    assert!(body.contains("no Defence Modifiers on other Equipped Items"));
    assert!(items::fake_no_defence(&[body.as_str(), helmet.as_str()]), "armour and evasion on the helmet is a defence modifier");
    assert!(!items::fake_no_defence(&[body.as_str(), ring.as_str()]), "a ring with resists and attributes has none");
}

/// Hard limits hold without flask effects: the result's fire and lightning resistances were 81% only with its
/// Bismuth, Ruby and Topaz flasks on (5% and 4% without).
#[test]
fn resist_limits_hold_without_flasks() {
    let s = solver();
    let v = eval_fixture(&s);
    let d = limit(&s, &v, "Fire resistance 75%");
    assert!(d > 0.0, "fire resistance counted the flasks");
}

/// A flask used only when the player becomes frozen (the Bismuth's "Used when you become Frozen") does not count.
#[test]
fn flask_used_when_frozen_does_not_count() {
    let s = solver();
    let v = eval_fixture(&s);
    let i = s.scorer.names.iter().position(|n| n == "Solver.FlaskUptimeMap1").unwrap();
    assert!(v[i].unwrap_or(0.0) < 1.0, "a flask used when frozen counted as sustained");
    // The rerun's Topaz ("Used when you Hit a Rare or Unique Enemy") and Jade ("Used when you use a Life Flask").
    let x = std::fs::read_to_string(format!("{}/testdata/finish-flicker2.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let v = eval_one(&mut None, &Cand::Xml(Arc::new(x)), &names).unwrap();
    for n in ["Solver.FlaskUptimeMap4", "Solver.FlaskUptimeMap5"] {
        let i = s.scorer.names.iter().position(|m| m == n).unwrap();
        assert!(v[i].unwrap_or(0.0) < 1.0, "{n}: a flask used on a rare hit or with a life flask counted as sustained");
    }
}

/// Mana: 19.4 regeneration a second against Flicker Strike's 37.4; the 75.6 of mana recoup upstream averages over the
/// damage of its EHP calculation is not income while mapping.
#[test]
fn mana_recoup_is_not_skill_sustain() {
    let s = solver();
    let v = eval_fixture(&s);
    let d = limit(&s, &v, "Mana cost sustainable");
    assert!(d > 0.0, "mana cost passed on recoup from damage taken");
}

/// A melee build keeps a life flask in Flask 1: a utility flask there is not worn.
#[test]
fn melee_build_keeps_a_life_flask() {
    let s = solver();
    let f1 = s.slots.iter().position(|d| d.name == "Flask 1").unwrap();
    let g = (*s.start_gear).clone();
    assert!(s.with_piece(&g, f1, Some(s.empty_craft("Bismuth Flask").unwrap())).is_none(), "a Bismuth Flask took the life flask's slot");
    let life = s.life_flask().unwrap();
    assert!(life.xml.contains("Life Flask") && life.xml.contains("Immunity to Bleeding"), "the life flask removes bleeding");
    assert!(s.with_piece(&g, f1, Some(life)).is_some());
}

/// The rerun's uninfluenced Haunted Bascinet holds "+4 to maximum Fortification". That is the fossil (Delve) mod
/// DelveArmourFortifyEffect, which upstream's data lets spawn on str_int_armour helmets, not the Crusader-only suffix
/// (FortifyEffectInfluence, helmet_crusader): no influenced family is on a base without that influence, and none joins it.
#[test]
fn uninfluenced_helmet_has_no_influence_lines() {
    let plain = items::base_info_craft("Haunted Bascinet", 86, 90, &[], false, &[], 1).unwrap();
    assert!(plain.fams.iter().all(|f| f.influence.is_none()), "an influenced family on an uninfluenced base");
    let fort: Vec<_> = plain.fams.iter().filter(|f| f.lines.iter().any(|l| l.contains("maximum Fortification"))).collect();
    assert!(fort.iter().all(|f| f.source == "delve"), "{:?}", fort.iter().map(|f| f.source).collect::<Vec<_>>());
    let crus = items::base_info_craft("Haunted Bascinet", 86, 90, &[], false, &["crusader".to_string()], 1).unwrap();
    let f = crus.fams.iter().position(|f| f.influence.as_deref() == Some("crusader")).expect("a crusader family");
    assert!(items::CraftRules::legal(&crus, &[], f));
    assert!(!items::CraftRules::legal(&plain_with(&crus, &[]), &[], f), "a crusader family joined an item without crusader");
}

/// `b` with its influence set replaced.
fn plain_with(b: &items::BaseInfo, inf: &[&str]) -> items::BaseInfo {
    items::BaseInfo { influences: inf.iter().map(|s| s.to_string()).collect(), fams: b.fams.clone(), name: b.name.clone(), item_type: b.item_type.clone(), sub_type: b.sub_type.clone(), implicit: b.implicit.clone(), anoints: b.anoints.clone(), header: b.header.clone(), ..*b }
}

/// A mark curses one enemy: while mapping it is no charge source, no "enemy is cursed" and no utility pick; a bossing
/// solve may still use it.
#[test]
fn marks_count_only_on_a_boss() {
    let raw: Value = serde_json::from_str(include_str!("../../../engine-data/config-sources.json")).unwrap();
    let mut marks = 0;
    for sw in raw["switches"].as_array().unwrap() {
        for src in sw["sources"].as_array().into_iter().flatten() {
            if src["kind"] == "skill" && src["match"].as_str().unwrap_or("").ends_with(" Mark") {
                assert_eq!(src["modes"], json!(["bossing"]), "{} from {}", sw["key"], src["match"]);
                marks += 1;
            }
        }
        if sw["key"] == "conditionEnemyCursed" {
            let case = sw["valueRule"]["cases"].as_array().unwrap().iter().find(|c| c["when"] == json!(["mark"])).expect("mark case");
            assert_eq!((case["mapping"].clone(), case["bossing"].clone()), (json!(false), json!(true)));
        }
    }
    assert!(marks >= 3);
    let mut g: Goal = serde_json::from_str(GOAL).unwrap();
    assert!(!catalog(90, &g).iter().any(|x| x.name == "Poacher's Mark"));
    g.assume.play_mode = Some(PlayMode::Bossing);
    assert!(catalog(90, &g).iter().any(|x| x.name == "Poacher's Mark"));
}

/// The result's cost line priced the gear only: Greater Multistrike (an exceptional gem, about 34 divine uncorrupted
/// on poe.ninja) and the main skill's 6-link (1500 Orbs of Fusing on the bench) were free. Both count now, and the
/// mid-league budget (10 divine) refuses the gem.
#[test]
fn cost_counts_bought_gems_and_links() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    let main = |second: &str, n: usize| -> Vec<&'static str> { ["Flicker Strike", second, "Brutality", "Melee Physical Damage", "Ruthless", "Fortify"].iter().take(n).map(|x| g(x)).collect() };
    let cost = |s: &mut Solver, m: Vec<&'static str>| {
        let st = s.initial_state(c[0], Some((m, Vec::new())), None).unwrap();
        s.gear_cost(&st.gear)
    };
    let (greater, plain6, plain4) = (cost(&mut s, main("Greater Multistrike", 6)), cost(&mut s, main("Multistrike", 6)), cost(&mut s, main("Multistrike", 4)));
    assert!(greater - plain6 > 20.0, "Greater Multistrike is not priced: {greater} vs {plain6}");
    assert!(plain6 - plain4 > 0.3, "the 6-link is not priced: {plain6} vs {plain4}");
    // Over the mid-league budget: the gem layer does not take it.
    let st = s.initial_state(c[0], Some((main("Multistrike", 5), Vec::new())), None).unwrap();
    let mut gms = main("Multistrike", 5);
    gms[1] = g("Greater Multistrike");
    let r = s.try_setups_plain(&st, vec![(gms, Vec::new())]).unwrap();
    assert!(r.is_none_or(|n| !n.main.contains(&g("Greater Multistrike"))), "Greater Multistrike taken on a 10 divine budget");
}

/// The Grey Spire ("Has no Sockets") left 19 gems on 18 sockets; Fenumus' Toxins' "Power
/// Charge on hitting an Enemy affected by a Spider's Web" earned power charges with no Aspect of the Spider; Flask 1 was
/// an Eternal Life Flask with no bleed removal and reduced recovery.
#[test]
fn gear_holds_the_gems_life_flask_and_no_web_charges() {
    let fen = ["10% chance to gain a Power Charge on hitting an Enemy affected by a Spider's Web".to_string()];
    let keys: Vec<String> = config::line_hits(&fen, "Fenumus' Toxins").iter().map(|(k, _, _)| config::data().sw[*k].key.clone()).collect();
    assert!(!keys.iter().any(|k| k.contains("PowerCharge")), "Fenumus' web line earns {keys:?}");
    let hit = ["20% chance to gain a Power Charge on Hit".to_string()];
    assert!(config::line_hits(&hit, "x").iter().any(|(k, _, _)| config::data().sw[*k].key == "usePowerCharges"), "plain on-hit line lost");

    let mut s = solver();
    // (second rerun: Mirror Arrow, a bow skill, sat in a claw build)
    assert!(!s.gems.iter().any(|x| x.name == "Mirror Arrow"), "a bow skill offered to Flicker Strike");
    assert!(s.gems.iter().any(|x| x.name == "Leap Slam"), "a melee movement skill dropped");
    let c = s.candidates().unwrap();
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    let main: Vec<&'static str> = ["Flicker Strike", "Multistrike", "Fortify", "Ruthless", "Brutality"].iter().map(|x| g(x)).collect();
    let utils: Vec<&'static str> = ["Wrath", "Smite", "Blood Rage", "Herald of Ash", "Enfeeble", "Leap Slam", "Vaal Grace", "Purity of Fire", "Precision", "Grace", "Flesh and Stone", "Herald of Purity", "Determination"].iter().map(|x| g(x)).collect();
    let mut st = s.initial_state(c[0], Some((main, utils)), None).unwrap();
    s.price_gems(&mut st);
    assert_eq!(st.gear.sockets_need.0, 18);
    assert!(s.sockets_ok(&st.gear, None), "18 gems fit 24 sockets");
    let spire = items::unique_list(&ItemRules::default(), 90, None, &|_, _| true).into_iter().find(|u| u.name == "The Grey Spire").expect("Grey Spire");
    let w = s.slot_of(SlotKind::Weapon1).unwrap();
    s.with_piece(&st.gear, w, Some(items::unique_piece(&spire))).expect("Grey Spire wearable");
    let mut more = st.clone();
    more.utils.push(g("Arctic Armour"));
    s.price_gems(&mut more);
    assert!(s.with_piece(&more.gear, w, Some(items::unique_piece(&spire))).is_none(), "19 gems on The Grey Spire's 18 sockets");

    let f = s.life_flask_slot().expect("melee life flask slot");
    let good = s.life_flask().unwrap();
    assert!(s.with_piece(&st.gear, f, Some(good.clone())).is_some(), "the bleed life flask");
    let mut bad = good.clone();
    bad.xml = Arc::new(good.xml.lines().filter(|l| !l.contains("Bleeding")).collect::<Vec<_>>().join("\n"));
    assert!(s.with_piece(&st.gear, f, Some(bad)).is_none(), "a life flask with no bleed removal");
}

/// A cluster jewel with no notable (the result's Large Cluster Jewel: six "12% increased Physical Damage" passives and
/// two sockets) is never designed. Mid league: the items layer spends the budget, no notable fits, and the bare jewel
/// used to be kept. Mirror (no budget): designs exist and each has a notable.
#[test]
fn no_cluster_jewel_without_a_notable() {
    let has_notable = |d: &State| d.gear.sockets.iter().filter(|x| !x.kept && x.xml.contains("Cluster Jewel")).all(|x| x.xml.contains("Added Passive Skill is"));
    for wealth in ["mirror", "mid-league"] {
        let goal: Goal = serde_json::from_str(&GOAL.replace("mid-league", wealth)).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let c = s.candidates().unwrap();
        let mut st = s.initial_state(c[0], None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        let ds = s.cluster_designs(&st).unwrap();
        assert!(ds.iter().all(has_notable), "{wealth}: a cluster jewel without a notable");
        if wealth == "mirror" {
            assert!(!ds.is_empty(), "no cluster design at all with no budget");
        }
    }
}

/// The ascendancy comparison: the expert phase gave its whole screen to the class the opening scored best, so the beam
/// had one root and every final build was that ascendancy. Two Templar ascendancies scouted alike each get a realized
/// build out of the expert phase.
#[test]
fn expert_realizes_every_scouted_ascendancy() {
    let goal: Goal = serde_json::from_str(GOAL).unwrap();
    let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":900000,"maxEvals":30000,"threads":6}"#).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
    let cands = s.candidates().unwrap();
    let mut st0 = s.initial_state(cands[0], None, None).unwrap();
    s.gem_layer(&mut st0, false).unwrap();
    s.items_layer(&mut st0, false).unwrap();
    let mut scouted = Vec::new();
    for &ci in cands.iter().take(2) {
        let mut st = s.initial_state(ci, Some((st0.main.clone(), st0.utils.clone())), Some(st0.gear.clone())).unwrap();
        s.grow(&mut st, true).unwrap();
        scouted.push(st);
    }
    let out = s.expert(&scouted).unwrap();
    let got: Vec<String> = out.iter().map(|x| format!("{} {:.3}", s.ctx[x.class].label, x.score)).collect();
    for st in &scouted {
        assert!(out.iter().any(|o| o.class == st.class), "{} has no realized build: {got:?}", s.ctx[st.class].label);
    }
}

/// A result held 13 utility skills and 3.5k life. The default life-and-ES floor follows the wealth
/// tier (mid league 4.5k); a floor the goal sets itself (not the 3000 default) stays.
#[test]
fn life_floor_follows_wealth() {
    let floor = |w: &str, pool: f64| -> f64 {
        let g: Goal = serde_json::from_str(&format!(r#"{{"skill":"Flicker Strike","wealth":{w},"limits":{{"pool":{pool}}}}}"#)).unwrap();
        let (s, _) = Scorer::new(&g).unwrap();
        let l = s.limits.iter().find(|l| l.name.starts_with("Life at least")).unwrap();
        match l.check {
            Check::AtLeast(_, p) => p,
            _ => panic!(),
        }
    };
    assert_eq!(floor(r#""mid-league""#, -1.0), 4500.0);
    assert!(floor(r#""league-start""#, -1.0) < 4500.0 && floor(r#""rich""#, -1.0) > 4500.0 && floor(r#""mirror""#, -1.0) >= floor(r#""rich""#, -1.0));
    assert_eq!(floor(r#""mid-league""#, 2000.0), 2000.0);
    assert_eq!(floor("null", -1.0), 3000.0);
}

/// Utility skills the player presses (curse, guard, movement, warcry, debuff, offering) are capped at five, the weakest
/// dropped; auras and golems are set and forget and stay.
#[test]
fn pressed_utility_skills_are_capped() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    let main: Vec<&'static str> = ["Flicker Strike", "Multistrike", "Fortify", "Ruthless", "Brutality"].iter().map(|x| g(x)).collect();
    let utils: Vec<&'static str> = ["Enfeeble", "Leap Slam", "Molten Shell", "Ancestral Cry", "Bone Offering", "Wither", "Plague Bearer", "Precision", "Grace", "Determination"].iter().map(|x| g(x)).collect();
    let mut st = s.initial_state(c[0], Some((main, utils)), None).unwrap();
    let n = |s: &Solver, st: &State| st.utils.iter().filter(|u| s.pressed(u)).count();
    assert!(n(&s, &st) > 5, "fixture has {} pressed", n(&s, &st));
    s.trim_pressed(&mut st).unwrap();
    // (this goal maps: two buttons besides the main skill)
    assert_eq!(n(&s, &st), 2);
    for a in ["Precision", "Grace", "Determination"] {
        assert!(st.utils.contains(&g(a)), "{a} (an aura) dropped");
    }
    assert!(st.utils.contains(&g("Leap Slam")), "the movement skill was dropped");
}

/// The mapping result wore Enfeeble, Smite and a Steelskin the basics fill added after the trim: the fill takes no
/// pressed skill once the play mode's buttons are taken.
#[test]
fn basics_fill_keeps_the_press_cap() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    let main: Vec<&'static str> = ["Flicker Strike", "Multistrike", "Fortify"].iter().map(|x| g(x)).collect();
    let mut st = s.initial_state(c[0], Some((main, vec![g("Enfeeble"), g("Smite")])), None).unwrap();
    s.rebase(&mut st).unwrap();
    assert_eq!(s.presses(&st), 2);
    match s.add_utility(&st, Kind::Guard).unwrap() {
        Ok(n) => panic!("a guard went past the cap: {:?}", n.utils.iter().map(|u| gem_name(u)).collect::<Vec<_>>()),
        Err(_) => {}
    }
}

/// The flask enchant "Used when you Use a Travel Skill" fires only on a travel skill: the flask is not up in the mapping rotation.
#[test]
fn travel_skill_flask_enchant_does_not_count() {
    assert!(flask_fires_on_event("Used when you Use a Travel Skill") && flask_fires_on_event("Used when you Use a Guard Skill"));
    assert!(!flask_fires_on_event("Used when Charges reach full") && !flask_fires_on_event("(60-70)% increased effect"));
}

/// Sweep: Fortify (needs Melee) on Righteous Fire and Poisonous Concoction; a bow utility under a spell; chaos resistance
/// not a limit; energy shield counted as life under Eldritch Battery.
#[test]
fn sweep_gem_and_limit_rules() {
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    assert!(!support_fits(g("Fortify"), g("Righteous Fire")) && !support_fits(g("Fortify"), g("Poisonous Concoction")));
    assert!(support_fits(g("Fortify"), g("Flicker Strike")));
    assert_eq!((pool_of(3000.0, 3000.0, 2000.0, true, true, 50.0), pool_of(3000.0, 3000.0, 2000.0, false, true, 50.0), pool_of(3000.0, 3000.0, 2000.0, false, false, 50.0)), (3000.0, 5000.0, 3000.0));
    let goal: Goal = serde_json::from_str(r#"{"skill":"Righteous Fire","level":90}"#).unwrap();
    let (sc, _) = Scorer::new(&goal).unwrap();
    assert!(sc.limits.iter().any(|l| l.name.starts_with("Chaos resistance")), "no chaos limit");
    // a spell main skill leaves no weapon for an attack utility skill
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    assert!(!s.gems.iter().any(|x| x.name == "Mirror Arrow"), "a bow skill offered to Righteous Fire");
    // a mine is pressed by hand even where the data tags it as an aura (Pyroclast Mine)
    assert!(!s.gems.iter().any(|x| x.name == "Pyroclast Mine" && x.kind == Kind::Aura), "Pyroclast Mine counted as an aura");
}

/// The node with this name in the ascendancy of class context `class`.
fn asc_node(s: &Solver, class: usize, name: &str) -> i64 {
    *s.ctx[class].paths.nodes.keys().find(|&&id| s.node_info(id).0 == name && s.ctx[class].is_asc(id)).unwrap_or_else(|| panic!("no node {name}"))
}

/// Ascendancy nodes the setup cannot use are not taken (Shaper of Flames under Elemental Focus), and a second
/// totem skill counts against the totem limit.
#[test]
fn dead_nodes_and_totem_limit() {
    let goal: Goal = serde_json::from_str(r#"{"skill":"Arc","className":"Witch","ascendancy":"Elementalist","level":90}"#).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let c = s.candidates().unwrap();
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    let mut st = s.initial_state(c[0], Some((vec![g("Arc"), g("Elemental Focus")], vec![])), None).unwrap();
    let shaper = asc_node(&s, c[0], "Shaper of Flames");
    assert!(s.node_dead(&st, shaper), "Shaper of Flames under Elemental Focus");
    st.main = vec![g("Arc")];
    assert!(!s.node_dead(&st, shaper), "Shaper of Flames without it");
    let (w, d) = (g("Wither"), g("Decoy Totem"));
    assert_eq!((s.totem_count(&st.main, &[w]), s.totem_count(&st.main, &[w, d])), (1, 2));
}

/// The main skill's group carries the slot of the item that holds its link; movement speed is a limit.
#[test]
fn groups_sit_in_slots_and_movement_is_a_limit() {
    let mut s = solver();
    assert!(s.scorer.limits.iter().any(|l| l.name.starts_with("Movement speed at least")), "no movement limit");
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    let xml = s.render(&st).unwrap();
    assert!(xml.contains("slot=\""), "no skill group carries slot=");
}

/// The Flicker result's TotalEHP read 922 million at a smallest maximum hit of 125 thousand; the EHP target
/// holds to a multiple of that hit, so it cannot outweigh the damage.
#[test]
fn ehp_target_is_capped_by_the_smallest_max_hit() {
    let g: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","targets":[{"name":"EHP","metric":"ehp"}]}"#).unwrap();
    let (sc, _) = Scorer::new(&g).unwrap();
    let i = |n: &str| sc.names.iter().position(|x| x == n).unwrap();
    let mut v: Vals = vec![None; sc.names.len()];
    v[i("TotalEHP")] = Some(9.2e8);
    assert_eq!(sc.target_value(&sc.targets[0], &v), 9.2e8, "no max hit read: uncapped");
    for d in ["Physical", "Lightning", "Cold", "Fire"] {
        v[i(&format!("{d}MaximumHitTaken"))] = Some(100_000.0);
    }
    v[i("ChaosMaximumHitTaken")] = Some(5_000.0);
    assert_eq!(sc.target_value(&sc.targets[0], &v), 5_000.0 * EHP_MAX_HIT_MULT, "the weakest type caps, not the second weakest");
    assert_eq!(sc.shown_value(&sc.targets[0], &v), 9.2e8, "the shown number is upstream's");
}

/// Promise sweep: a deliberate pool of 3000 on a mid-league goal stays 3000; unset takes the tier's floor.
#[test]
fn pool_3000_is_honoured_and_unset_takes_the_tier_floor() {
    let floor = |pool: &str| {
        let g: Goal = serde_json::from_str(&format!(r#"{{"skill":"Flicker Strike","wealth":"mid-league","targets":[{{"name":"DPS"}}],"limits":{{{pool}}}}}"#)).unwrap();
        let (sc, _) = Scorer::new(&g).unwrap();
        sc.limits.iter().find_map(|l| match l.check { Check::AtLeast(_, p) if l.name.starts_with("Life at least") => Some(p), _ => None }).unwrap()
    };
    assert_eq!(floor(r#""pool":3000"#), 3000.0);
    assert!(floor("") > 3000.0, "unset: the mid-league floor");
}

#[test]
fn warning_keys_read_as_plain_text() {
    assert_eq!(warning_name("LifePercentCostPercentCostWarningList"), "Life cost not payable");
    assert_eq!(warning_name("ESCostWarningList"), "ES cost not payable");
}

fn sweep_solver(goal: &str, fixture: &str) -> Solver {
    let xml = std::fs::read_to_string(format!("{}/testdata/{fixture}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let goal: Goal = serde_json::from_str(goal).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    Solver::new(xml, goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
}

const TORNADO: &str = r#"{"wealth":"mid-league","level":90,"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"assume":{"playMode":"mapping"},"skill":"Tornado Shot","className":"Ranger"}"#;
const PCONC: &str = r#"{"wealth":"mid-league","level":90,"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"assume":{"playMode":"mapping"},"skill":"Poisonous Concoction","className":"Shadow"}"#;

/// Sweep: Tornado Shot came out with no support at all, every single support failing the mana-cost limit.
#[test]
fn tornado_shot_gets_supports() {
    let mut s = sweep_solver(TORNADO, "sweep-tornado.xml");
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], Some((vec![s.main_gem], vec![])), None).unwrap();
    // (the sweep result's own items on it)
    let mut g = (*st.gear).clone();
    g.pieces = s.player_pieces.clone();
    g.ready = true;
    st.gear = Arc::new(g);
    s.rebase(&mut st).unwrap();
    s.gem_layer(&mut st, false).unwrap();
    assert!(st.main.len() > 1, "no support on the main skill");
}

/// Sweep: Poisonous Concoction came back at 72 of 75 lightning resistance; a final pass closes it (or leaves the shortfall listed).
#[test]
fn small_resist_shortfall_is_repaired() {
    let mut s = sweep_solver(PCONC, "sweep-pconc.xml");
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    let before = st.viol;
    assert!(before > 0.0, "fixture meets its limits");
    s.repair_limits(&mut st).unwrap();
    assert!(st.viol < before, "shortfall not reduced");
}

/// A guard skill with Cast when Damage Taken and a hex with Blasphemy fire by themselves: offered, not pressed by hand.
#[test]
fn automated_guard_and_curse_are_not_pressed() {
    let s = solver();
    let auto = |name: &str| s.gems.iter().find(|g| g.kind == Kind::Auto && g.name == name).unwrap_or_else(|| panic!("no automated {name}")).id;
    let (guard, hex) = (auto("Steelskin + Cast when Damage Taken"), auto("Enfeeble + Blasphemy"));
    assert!(!s.pressed(guard) && !s.pressed(hex));
    assert!(s.pressed(find_gem("Steelskin").unwrap()) && s.pressed(find_gem("Enfeeble").unwrap()));
    assert!(!s.gems.iter().any(|g| g.kind == Kind::Auto && g.name.contains("Mark On Hit")), "a mark needs a boss; this goal maps");
}

/// An aura buff that comes from using the skill (Smite's, no reservation) is pressed like a warcry,
/// not a set-and-forget aura (a banner, placed for a duration, too); auras and heralds that reserve stay set and forget.
#[test]
fn buff_from_use_is_pressed() {
    let s = solver();
    for n in ["Smite", "War Banner"] {
        assert!(s.pressed(find_gem(n).unwrap()), "{n} counted as a set-and-forget aura");
    }
    for n in ["Determination", "Herald of Ash"] {
        assert!(!s.pressed(find_gem(n).unwrap()), "{n} is set and forget");
    }
}

/// Review of 903b100e8: the basics fill ran after the dead-piece pass and put a movement gem back beside Flicker
/// Strike (itself one), and it could add a gem for a skill the gear grants (Kaom's Sign's Enduring Cry).
#[test]
fn basics_count_the_main_mover_and_skip_granted_gems() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    let (n, _) = s.fill_basics(&st).unwrap();
    let after = n.as_ref().unwrap_or(&st);
    assert!(!after.utils.iter().any(|u| s.moves(u)), "a movement gem beside Flicker Strike: {:?}", after.utils.iter().map(|g| gem_name(g)).collect::<Vec<_>>());
    let ring = s.slots.iter().position(|d| d.name == "Ring 1").unwrap();
    let kaom = s.uniques.iter().find(|u| u.name == "Kaom's Sign").cloned().expect("Kaom's Sign");
    let mut t = st.clone();
    t.gear = Arc::new(s.with_piece(&st.gear, ring, Some(items::unique_piece(&kaom))).expect("wears it"));
    s.rebase(&mut t).unwrap();
    let ec = find_gem("Enduring Cry").unwrap();
    s.gems.retain(|g| g.kind != Kind::Utility || g.id == ec);
    let r = s.add_utility(&t, Kind::Utility).unwrap();
    assert!(r.as_ref().map_or(true, |n| !n.utils.contains(&ec)), "an Enduring Cry gem beside the ring that grants it");
}

/// The bossing fixture's Flicker Strike in a full 6-link (it fills the body armour), `auras` beside it and March of the
/// Legion (Divine Blessing) on the feet; with `crowded`, filler auras first take every socket outside the boots, so
/// `auras` have to go in the boots.
fn blessing_state(auras: &[&str], crowded: bool) -> (Solver, State) {
    let mut s = sweep_solver(&GOAL.replace(r#""metric":"combined""#, r#""metric":"boss""#).replace("mapping", "bossing"), "finish-boss-oneshot.xml");
    let c = s.candidates().unwrap();
    let main: Vec<&'static str> = std::iter::once(s.main_gem).chain(["Multistrike", "Fortify", "Close Combat", "Additional Accuracy", "Momentum"].iter().map(|n| find_gem(n).unwrap())).collect();
    let mut st = s.initial_state(c[0], Some((main.clone(), Vec::new())), None).unwrap();
    let boots = s.slot_of(SlotKind::Boots).unwrap();
    let m = s.uniques.iter().find(|u| u.name == "March of the Legion").cloned().expect("March of the Legion");
    st.gear = Arc::new(s.with_piece(&st.gear, boots, Some(items::unique_piece(&m))).expect("wears it"));
    let room: usize = (0..s.slots.len()).filter(|&i| i != boots && matches!(s.slots[i].kind, SlotKind::Weapon1 | SlotKind::Weapon2 | SlotKind::Body | SlotKind::Helmet | SlotKind::Gloves)).map(|i| s.piece_sockets(&st.gear, i).0).sum::<usize>() - main.len();
    const FILL: [&str; 22] = ["Clarity", "Vitality", "Precision", "Flesh and Stone", "Malevolence", "Pride", "Purity of Fire", "Purity of Lightning", "Herald of Ash", "Herald of Ice", "Herald of Thunder", "Herald of Purity", "Herald of Agony", "Anger", "Wrath", "Hatred", "Grace", "Determination", "Discipline", "Haste", "Zealotry", "Purity of Ice"];
    let fill: Vec<&str> = if crowded { FILL.iter().copied().filter(|f| !auras.contains(f)).take(room).collect() } else { Vec::new() };
    assert_eq!(fill.len(), if crowded { room } else { 0 }, "not enough filler auras for {room} sockets");
    st.utils = fill.iter().chain(auras).map(|n| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"))).collect();
    s.rebase(&mut st).unwrap();
    (s, st)
}

/// Auras in an item whose support makes them blessings (March of the Legion's Divine Blessing)
/// are timed buffs the player presses: they count under the press cap, and one blessing at most stays.
#[test]
fn blessing_auras_are_pressed_one_at_most() {
    let (s, mut st) = blessing_state(&["Anger", "Wrath", "Hatred"], true);
    let b = s.blessed(&st);
    assert!(b.len() > 1, "the boots' auras read as standing auras");
    s.trim_pressed(&mut st).unwrap();
    assert!(s.blessed(&st).len() <= 1, "two blessings kept: {:?}", s.blessed(&st).iter().map(|g| gem_name(g)).collect::<Vec<_>>());
}

/// An aura goes in the blessing boots only when no other item has room: with the helmet and gloves free, Purity of
/// Elements stays a standing aura.
#[test]
fn auras_keep_out_of_blessing_items_when_room_elsewhere() {
    let (s, st) = blessing_state(&["Purity of Elements"], false);
    assert!(s.blessed(&st).is_empty(), "an aura was made a blessing with free sockets elsewhere");
}

/// The stun chip's soft push reaches a tree keystone whose text reads "Cannot be Stunned"
/// (the Unwavering Stance class): the catalog holds it and allocating it lowers the soft cost (the chip is met).
#[test]
fn stun_push_reaches_cannot_be_stunned_keystones() {
    let mut s = sweep_solver(&GOAL.replace(r#""metric":"combined""#, r#""metric":"boss""#).replace("mapping", "bossing"), "finish-boss-oneshot.xml");
    let c = s.candidates().unwrap();
    let stun = s.part_catalog(c[0]).iter().find_map(|p| match p.kind { parts::PartKind::Node(id) if s.node_info(id).1.contains("cannot be stunned") => Some(id), _ => None }).expect("a Cannot be Stunned keystone in the catalog");
    // (the screen's own probe: the node pinned on the state's node list, as when it prices a tree part; a node pasted
    // into the build text off the tree's paths is dropped by the engine)
    let st = s.initial_state(c[0], None, None).unwrap();
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let k = s.scorer.names.iter().position(|n| n == "SelfStunChance").expect("the stun chip's stat is read");
    let miss = |pin: Vec<i64>| {
        let mut nodes = s.full_nodes(&st);
        nodes.extend(&pin);
        let v = eval_one(&mut None, &Cand::Nodes { base: Arc::new(st.base.to_string()), nodes, mastery: None, pin }, &names).unwrap();
        (s.scorer.soft_missed(&v), v[k])
    };
    let ((a, _), (b, _)) = (miss(Vec::new()), miss(vec![stun]));
    assert!(b < a, "the keystone moved no soft cost: {a} -> {b}");
}

/// Resistances and ailment immunity cannot rest on a blessing (up only while pressed):
/// Purity of Elements pushed into March of the Legion is taken out.
#[test]
fn no_resists_on_a_blessing() {
    let (s, mut st) = blessing_state(&["Anger", "Purity of Elements"], true);
    let poe = find_gem("Purity of Elements").unwrap();
    assert!(s.blessed(&st).contains(&poe), "Purity of Elements sits in the boots: {:?}", s.blessed(&st).iter().map(|g| gem_name(g)).collect::<Vec<_>>());
    s.trim_pressed(&mut st).unwrap();
    assert!(!s.blessed(&st).contains(&poe), "resists rest on a blessing");
}

/// A belt with "Can't use Flask in Fifth Slot" (Micro-Distillery Belt's implicit) leaves the fifth
/// flask slot empty.
#[test]
fn blocked_flask_slot_stays_empty() {
    let s = solver();
    let f5 = s.slots.iter().position(|d| d.name == "Flask 5").unwrap();
    let belt = s.slot_of(SlotKind::Belt).unwrap();
    let flask = items::craft_piece(&s.base_craft("Bismuth Flask", &[]).unwrap(), Vec::new(), None, s.item_level);
    let g = s.with_piece(&s.start_gear, f5, Some(flask.clone())).expect("a flask in slot 5");
    let b = items::craft_piece(&s.base_craft("Micro-Distillery Belt", &[]).unwrap(), Vec::new(), None, s.item_level);
    let g = s.with_piece(&g, belt, Some(b)).expect("wears the belt");
    assert!(g.pieces[f5].is_none(), "a flask stayed in the blocked slot");
    assert!(s.with_piece(&g, f5, Some(flask)).is_none(), "a flask went into the blocked slot");
}

/// Two flasks with the same "during Effect" line (stun avoidance on a Bismuth and an
/// Aquamarine) are one effect taken twice: the second is refused.
#[test]
fn one_flask_per_during_effect_line() {
    let s = solver();
    let slot = |n: &str| s.slots.iter().position(|d| d.name == n).unwrap();
    let with_stun = |base: &str| {
        let b = s.base_craft(base, &[]).unwrap();
        let f = b.fams.iter().position(|f| f.lines.iter().any(|l| l.contains("Avoid being Stunned during Effect"))).expect("a stun avoidance suffix");
        items::craft_piece(&b, vec![f], None, s.item_level)
    };
    let g = s.with_piece(&s.start_gear, slot("Flask 3"), Some(with_stun("Bismuth Flask"))).expect("the first flask");
    assert!(s.with_piece(&g, slot("Flask 4"), Some(with_stun("Aquamarine Flask"))).is_none(), "the same during-effect line went on a second flask");
    let plain = items::craft_piece(&s.base_craft("Aquamarine Flask", &[]).unwrap(), Vec::new(), None, s.item_level);
    assert!(s.with_piece(&g, slot("Flask 4"), Some(plain)).is_some(), "a flask without that line was refused");
}

/// Elemental Focus (`cannot_inflict_status_ailments`) taken into the bossing link after the lead
/// was set: the finish reads the ailments again, so "Enemy is Ignited" goes.
#[test]
fn finish_drops_ailments_the_link_cannot_inflict() {
    let mut s = sweep_solver(&GOAL.replace(r#""metric":"combined""#, r#""metric":"boss""#).replace("mapping", "bossing"), "finish-boss-oneshot.xml");
    let x = std::fs::read_to_string(format!("{}/testdata/finish-boss-oneshot.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let re = regex::Regex::new(r#"nameSpec="([^"]*)""#).unwrap();
    let groups: Vec<Vec<&'static str>> = x.split("<Skill ").skip(1).map(|g| re.captures_iter(g.split("</Skill>").next().unwrap()).filter_map(|c| find_gem(&c[1])).collect()).collect();
    let c = s.candidates().unwrap();
    let k = *c.iter().find(|&&i| s.ctx[i].asc_name.as_deref() == Some("Inquisitor")).expect("an Inquisitor context");
    let mut st = s.initial_state(k, Some((groups[0].clone(), Vec::new())), None).unwrap();
    let mut g = (*st.gear).clone();
    g.pieces = s.player_pieces.clone();
    g.ready = true;
    st.gear = Arc::new(g);
    s.rebase(&mut st).unwrap();
    s.assume_ailments(&mut st).unwrap();
    let ign = r#"name="conditionEnemyIgnited" boolean="true""#;
    assert!(s.render(&st).unwrap().contains(ign), "the fixture ignites");
    let ef = find_gem("Elemental Focus").unwrap();
    let last = st.main.len() - 1;
    st.main[last] = ef;
    s.rebase(&mut st).unwrap();
    s.finish_checks(&mut st).unwrap();
    assert!(!s.render(&st).unwrap().contains(ign), "Enemy is Ignited stayed beside Elemental Focus");
}

/// A mapping solve spent 10.7 of 10 divine: the basics fill added Fortify as a sixth link (the bench's 6-link cost)
/// without the budget check. Over budget, the basics fill buys nothing dearer.
#[test]
fn basics_fill_keeps_the_budget() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    st.main = ["Flicker Strike", "Multistrike", "Melee Physical Damage", "Brutality", "Impale"].iter().map(|n| find_gem(n).unwrap()).collect();
    // (a unique dearer than the whole tier's budget: the gear is over budget already)
    let budget = s.goal.wealth.and_then(|w| w.budget()).unwrap();
    // (worn directly: the gear search would not pick it)
    let mb = items::unique_list(&items::ItemRules::default(), 90, None, &|_, _| true).into_iter().find(|u| u.name == "Mageblood").unwrap();
    assert!(s.unique_cost(&mb.name) > budget + 1.0, "a unique dearer than the budget");
    let mut u = (*st.gear).clone();
    u.pieces[s.slot_of(SlotKind::Belt).unwrap()] = Some(items::unique_piece(&mb));
    st.gear = Arc::new(u);
    s.rebase(&mut st).unwrap();
    let before = s.gear_cost(&st.gear);
    assert!(before > budget, "the gear is over budget: {before}");
    match s.add_support(&st, "fortify").unwrap() {
        Ok(n) => assert!(s.gear_cost(&n.gear) <= before + 1e-9, "the basics fill bought a dearer setup: {before:.2} -> {:.2} ({:?})", s.gear_cost(&n.gear), n.main.iter().map(|g| gem_name(g)).collect::<Vec<_>>()),
        // (review 253bcd4bf: a budget refusal says so)
        Err(why) => assert_ne!(why, "none available", "a budget refusal reads as nothing available"),
    }
}

/// The mid-league floor is life alone for a life build; only an energy shield build (Chaos
/// Inoculation, Low Life, most of the pool in shield) counts life plus shield.
#[test]
fn life_build_needs_life_alone_for_the_floor() {
    let floor = 4500.0;
    assert_eq!(pool_of(1000.0, 1000.0, 5000.0, false, false, 50.0), 6000.0, "most of the pool in shield");
    assert!(pool_of(3000.0, 3000.0, 2000.0, false, false, 50.0) < floor, "3k life + 2k ES passed the floor: {}", pool_of(3000.0, 3000.0, 2000.0, false, false, 50.0));
}

/// A seasoned player counts the life left after reservations. Blood Magic auras that leave
/// 1,260 of 4,200 life (30%) with 1,500 shield are a glass life build, not Low Life; a real Low Life build (45%
/// unreserved, under upstream's 50% threshold, shield well above that life) counts its shield.
#[test]
fn floor_counts_unreserved_life() {
    let floor = 4500.0;
    assert_eq!(pool_of(4200.0, 1260.0, 1500.0, false, false, 50.0), 1260.0, "Blood Magic reserving life counted shield");
    assert!(pool_of(4200.0, 1260.0, 1500.0, false, false, 50.0) < floor);
    assert_eq!(pool_of(5000.0, 5000.0, 0.0, false, false, 50.0), 5000.0, "unreserved life build");
    assert_eq!(pool_of(2000.0, 900.0, 6000.0, false, false, 50.0), 6900.0, "Low Life at 45% unreserved");
    assert_eq!(pool_of(3000.0, 1200.0, 2600.0, false, false, 50.0), 3800.0, "Low Life at 40%, shield below the life total");
    assert_eq!(pool_of(3000.0, 1200.0, 2600.0, false, false, 35.0), 1200.0, "a build's own low-life share");
}

/// Frenzy Charges the build keeps up: Flicker Strike spends one per use, so kill chances that make less than its use
/// rate do not hold the switch on; minimum charges and enough generation do.
#[test]
fn frenzy_count_follows_generation_against_spending() {
    let l = |s: &str| vec![s.to_string()];
    // the fixture's lines: 4% and 10% on kill while mapping (5 kills a second) = 0.7 a second
    let kills = config::frenzy_gen(&["4% chance to gain a Frenzy Charge on Kill".to_string(), "10% chance to gain a Frenzy Charge on Kill".to_string()], 4.0, 0.0, true);
    assert!((kills - 0.7).abs() < 1e-9, "{kills}");
    assert_eq!(config::frenzy_gen(&l("10% chance to gain a Frenzy Charge on Kill"), 4.0, 0.0, false), 0.0, "no kills while bossing");
    assert!((config::frenzy_gen(&l("5% chance to gain a Frenzy Charge on Hit"), 4.0, 0.0, true) - 0.2).abs() < 1e-9);
    assert!((config::frenzy_gen(&l("Gain a Frenzy Charge every 2 seconds"), 4.0, 0.0, true) - 0.5).abs() < 1e-9);
    // a charge on critical strike comes at the crit rate: at 50% crit, half the on-hit rate
    let hit = config::frenzy_gen(&l("Gain a Frenzy Charge on Hit"), 4.0, 0.5, false);
    let crit = config::frenzy_gen(&l("Gain a Frenzy Charge on Critical Strike"), 4.0, 0.5, false);
    assert!((hit - 4.0).abs() < 1e-9 && (crit - 2.0).abs() < 1e-9, "{hit} {crit}");
    // the skill's own chance on hit at 20% quality (Flicker Strike: 15% + 0.5% per quality), and a skill that hits
    // three times per use spends one charge per use
    let fl = find_gem("Flicker Strike").unwrap();
    assert!((config::skill_frenzy_on_hit(fl) - 0.25).abs() < 1e-9, "{}", config::skill_frenzy_on_hit(fl));
    assert!((config::uses_per_sec(6.0, 3.0) - 2.0).abs() < 1e-9);
    // Flicker spends 4 a second: 0.7 + its own 15% x 4 = 1.3 a second keeps 1.3 / 4 x 3 = 0.975 charges up: none
    assert_eq!(config::frenzy_count(kills + 0.6, 4.0, 3.0, 0.0), 0);
    // Flicker making 0.8 a second against 1.0 spent was given 2 charges and its bypass; it holds none
    assert_eq!(config::frenzy_count(2.0, 4.0, 3.0, 0.0), 0);
    assert_eq!(config::frenzy_count(0.8, 1.0, 3.0, 0.0), 0);
    assert_eq!(config::frenzy_count(4.0, 4.0, 3.0, 0.0), 3);
    assert_eq!(config::frenzy_count(0.0, 4.0, 3.0, 1.0), 1, "a minimum charge is always there");
    // a build that only collects: 0.05 a second is half a charge in the 10 s they last; 1.25 fills it
    assert_eq!(config::frenzy_count(0.05, 0.0, 3.0, 0.0), 0);
    assert_eq!(config::frenzy_count(1.25, 0.0, 3.0, 0.0), 3);
}

fn solver_of_arc() -> Solver {
    let goal: Goal = serde_json::from_str(r#"{"skill":"Arc","className":"Witch","level":90}"#).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
}

/// A candidate over the totem limit never reaches an evaluation.
#[test]
fn candidate_over_the_totem_limit_is_rejected() {
    let mut s = solver_of_arc();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], Some((vec![find_gem("Arc").unwrap()], vec![])), None).unwrap();
    let (w, d) = (find_gem("Wither").unwrap(), find_gem("Decoy Totem").unwrap());
    let before = s.evals.load(Ordering::Relaxed);
    s.try_setups_plain(&st, vec![(st.main.clone(), vec![w, d])]).unwrap();
    assert_eq!(s.evals.load(Ordering::Relaxed), before, "two totems were evaluated under a limit of one");
    s.try_setups_plain(&st, vec![(st.main.clone(), vec![w])]).unwrap();
    assert!(s.evals.load(Ordering::Relaxed) > before, "one totem is still tried");
}

/// Every socketed item has a Sockets line; the main skill's gems are one link in the body, with the colours the
/// gems need, and the sockets and colours cost something.
#[test]
fn socketed_items_carry_sockets_lines() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let g = |n: &str| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"));
    let main: Vec<&'static str> = ["Flicker Strike", "Multistrike", "Fortify", "Ruthless", "Brutality"].iter().map(|x| g(x)).collect();
    let mut st = s.initial_state(c[0], Some((main, vec![g("Enfeeble"), g("Grace")])), None).unwrap();
    let body = s.slot_of(SlotKind::Body).unwrap();
    let plate = s.base_craft("Astral Plate", &[]).unwrap();
    st.gear = Arc::new(s.with_piece(&st.gear, body, Some(items::craft_piece(&plate, vec![], None, s.item_level))).expect("a body armour"));
    s.price_gems(&mut st);
    let xml = s.render(&st).unwrap();
    let lines: Vec<String> = xml.lines().map(|l| l.trim().to_string()).filter(|l| l.starts_with("Sockets: ")).collect();
    let plan = s.socket_plan(&st.gear, &st.gear.groups);
    let b = plan.iter().find(|p| p.slot == body).expect("the body armour is planned");
    let line = b.line.clone().expect("a Sockets line for the body armour");
    assert!(line.split(' ').any(|grp| grp.split('-').count() == 5), "no 5-link in {line}");
    assert!(lines.iter().any(|l| l.contains(&line)), "the line is not in the result text");
    assert!(plan.iter().filter(|p| p.line.is_some()).all(|p| lines.iter().any(|l| Some(l.trim_start_matches("Sockets: ")) == p.line.as_deref())), "an item without its line");
    assert!(s.socket_cost(&st.gear) > 0.0, "sockets and colours cost nothing");
}

/// Resolute Technique with crit gear and Mind over Matter with little free mana go through the review.
#[test]
fn keystone_review_handles_real_conflicts() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    let (rt, mom, tree) = {
        let ctx = &s.ctx[c[0]];
        let by_name = |n: &str| *ctx.paths.nodes.keys().find(|&&id| s.node_info(id).0.eq_ignore_ascii_case(n) && ctx.kind(id) == "Keystone").unwrap_or_else(|| panic!("no keystone {n}"));
        let (rt, mom) = (by_name("Resolute Technique"), by_name("Mind over Matter"));
        let tree = ctx.tree_for(&[rt, mom], &st.nodes).expect("both reachable");
        let add: Vec<i64> = tree.iter().copied().filter(|n| !st.nodes.contains(n) && ctx.is_main(*n)).collect();
        (rt, mom, add)
    };
    st.nodes.extend(tree);
    s.rebase(&mut st).unwrap();
    let before = st.score;
    let changed = s.keystone_review(&mut st).unwrap();
    let has = |st: &State, id: i64| st.nodes.contains(&id);
    for id in [rt, mom] {
        // a keystone given back is banned from the tree; one kept is not
        assert_eq!(!has(&st, id), s.banned.borrow().contains(&id));
    }
    assert!(!changed || st.score >= before - 0.1);
}

/// A crit line made dead by Resolute Technique is given back by the dead-mod pass.
#[test]
fn dead_mod_pass_gives_back_crit_lines_under_resolute_technique() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let mut st = s.initial_state(c[0], None, None).unwrap();
    let tree = {
        let ctx = &s.ctx[c[0]];
        let rt = *ctx.paths.nodes.keys().find(|&&id| s.node_info(id).0 == "Resolute Technique" && ctx.kind(id) == "Keystone").unwrap();
        let tree = ctx.tree_for(&[rt], &st.nodes).unwrap();
        tree.iter().copied().filter(|n| !st.nodes.contains(n) && ctx.is_main(*n)).collect::<Vec<i64>>()
    };
    st.nodes.extend(tree);
    let amu = s.slot_of(SlotKind::Amulet).unwrap();
    let base = s.base_craft("Onyx Amulet", &[]).unwrap();
    let rt = vec!["Resolute Technique".to_string()];
    let crit = (0..base.fams.len()).find(|&f| base.fams[f].source == "normal" && parts::line_is_dead(&rt, &base.fams[f].lines.join("\n"))).expect("a crit family on amulets");
    let p = items::craft_piece(&base, vec![crit], None, s.item_level);
    st.gear = Arc::new(s.with_piece(&st.gear, amu, Some(p)).expect("the crit amulet can be worn"));
    s.rebase(&mut st).unwrap();
    assert!(s.dead_mod_pass(&mut st).unwrap(), "the dead line stayed");
    if let Some(items::Design::Craft { base, mods, .. }) = st.gear.pieces[amu].as_ref().map(|p| p.design.clone()) {
        assert!(!mods.iter().any(|&m| parts::line_is_dead(&rt, &base.fams[m].lines.join("\n"))), "a dead line is still on the amulet");
    }
}

/// A time cap already reached before a probe batch or a screen is a cut, not a failure: the base still evaluates
/// once and the solve goes on. (This used to die with "probe base did not evaluate"
/// when a lead's items share ended inside a sensitivity batch, and with "state did not evaluate" in the screen.)
#[test]
fn probe_and_screen_survive_a_time_cut() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    s.phase_end.set(s.spent());
    assert!(s.stop(), "the cap is reached");
    let (base, gains, _) = s.probe_gains(&st, &[vec!["+500 to maximum Life"]]).unwrap();
    assert!(base.is_finite() && base != 0.0 && gains[0] > 0.0, "the probe still measures: {base} {gains:?}");
    let parts: Vec<_> = s.part_catalog(st.class).into_iter().take(60).collect();
    let sc = s.screen(&st, &parts, &[], 0).unwrap();
    assert_eq!(sc.root.len(), parts.len());
    assert!(sc.root.iter().take(46).any(|g| *g != 0.0), "the first chunk ran");
}

/// Every phase mark follows the tries, never the clock: a slow PC (the clock ahead of the tries, inside the budget)
/// gets the same marks, and no time-limit line. The clock only cuts: at the time budget, or at the leads phase's wall
/// share, and only a cut writes the line.
#[test]
fn phase_marks_follow_tries_not_the_clock() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    let xml = Arc::new(s.render(&st).unwrap());
    assert!(s.eval(vec![Cand::Xml(xml.clone()), Cand::Xml(xml)])[0].is_some());
    let e = s.evals.load(Ordering::Relaxed);
    // (the tries so far are a quarter of the budget)
    (s.budget_ms, s.max_evals) = (600_000, e * 4);
    let ago = |secs: u64| std::time::Instant::now() - std::time::Duration::from_secs(secs);
    s.started = ago(300);
    assert_eq!(s.spent(), 150_000, "the clock (300 s) moved the phase marks");
    assert!(!s.stop() && !s.behind.get(), "no cut inside the budget, and no time-limit line");
    s.leads_tries.set(true);
    assert!(s.stop() && s.behind.get(), "past the leads phase's wall share: cut, and said");
    s.leads_tries.set(false);
    s.behind.set(false);
    s.started = ago(601);
    assert!(s.stop() && s.behind.get(), "past the time budget: cut, and said");
}

/// A dual-wield lead's off hand: a second copy held there; a lead that moves to a weapon it does not wear twice drops
/// the old copy instead of keeping it beside the new weapon.
#[test]
fn off_hand_follows_the_dual_lead() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    let w2 = s.slot_of(SlotKind::Weapon2).unwrap();
    let pieces: Vec<items::Piece> = s.slot_bases(w2).into_iter().filter_map(|b| s.empty_craft(&b).ok()).filter(|p| !p.two_hand).take(2).collect();
    assert!(pieces.len() == 2 && pieces[0].label != pieces[1].label, "two one-hand bases");
    let (a, b) = (&pieces[0], &pieces[1]);
    let mut d = s.with_weapon(&st, a).unwrap();
    assert!(s.set_off_hand(&mut d, a, true, false));
    assert!(d.gear.held.contains(&w2) && d.gear.pieces[w2].as_ref().is_some_and(|p| p.label == a.label), "the copy is held in the off hand");
    // (the held copy crafted on since: its label is no longer the weapon's)
    let mut g = (*d.gear).clone();
    if let Some(p) = g.pieces[w2].as_mut() {
        p.label = format!("{} (crafted)", p.label);
    }
    d.gear = Arc::new(g);
    let mut n = s.with_weapon(&d, b).unwrap();
    assert!(s.set_off_hand(&mut n, b, false, true));
    assert!(!n.gear.held.contains(&w2) && n.gear.pieces[w2].is_none(), "the old copy stayed beside the new weapon");
}

/// A bossing finish one boss skill preset one-shots (a fire spell preset: the Pinnacle read missed it) fails "Survives
/// every boss skill" in its result, so its one-shot chip and a met limit cannot both show; a long wind-up preset
/// (Atziri Flameblast) keeps its chip but does not count.
#[test]
fn one_shot_chip_fails_the_survive_limit() {
    let goal: Goal = serde_json::from_str(&GOAL.replace(r#""metric":"combined""#, r#""metric":"boss""#).replace("mapping", "bossing")).unwrap();
    assert_eq!(goal.assume.mode(), PlayMode::Bossing);
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let xml = Arc::new(std::fs::read_to_string(format!("{}/testdata/finish-boss-oneshot.xml", env!("CARGO_MANIFEST_DIR"))).unwrap());
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let mut v = eval_one(&mut None, &Cand::Xml(xml.clone()), &names).unwrap();
    let chips = s.boss_check(&xml, &mut v);
    assert!(!chips.is_empty(), "the fixture is one-shot by a preset");
    let long: Vec<String> = crate::solver_boss::preset_names().into_iter().filter(|n| crate::solver_boss::long_windup(n)).collect();
    let counted = chips.iter().any(|c| !long.iter().any(|n| c.starts_with(&format!("Mechanic: {n}, "))));
    let d = limit(&s, &v, "Survives every boss skill");
    assert!(if counted { d > 0.0 } else { d == 0.0 }, "chips {chips:?} with the limit at {d}");
}

/// The bossing finish ran three banners and an Enduring Cry gem beside Kaom's Sign ("Grants Level 10 Enduring Cry
/// Skill"): one banner at a time, and no gem for a skill the gear grants.
#[test]
fn one_banner_and_no_gem_the_gear_grants() {
    let b: Vec<&'static str> = ["Dread Banner", "War Banner"].iter().map(|n| find_gem(n).unwrap()).collect();
    assert!(utils_ok(&b[..1], &[]), "one banner");
    assert!(!utils_ok(&b, &[]), "two banners ran at once");
    let s = solver();
    let r = s.slots.iter().position(|d| d.name == "Ring 1").unwrap();
    let k = s.uniques.iter().find(|u| u.name == "Kaom's Sign").cloned().expect("Kaom's Sign");
    let g = s.with_piece(&s.start_gear, r, Some(items::unique_piece(&k))).expect("wears it");
    let granted = granted_skills(&g);
    let ec = find_gem("Enduring Cry").unwrap();
    assert!(granted.contains(&"enduring cry".to_string()), "granted {granted:?}");
    assert!(!utils_ok(&[ec], &granted), "a gem for the skill the ring grants");
}

/// A missing soft basic costs a small score (taken when cheap, never worth much damage): the mapping finish without
/// Fortify scores SOFT_NUDGE below the same numbers with 20 stacks, and no limit moves.
#[test]
fn missing_soft_basic_costs_a_little_score() {
    let s = solver();
    let x = std::fs::read_to_string(format!("{}/testdata/finish-map.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let v = eval_one(&mut None, &Cand::Xml(Arc::new(x)), &names).unwrap();
    let f = s.scorer.names.iter().position(|n| n == "FortificationStacks").expect("Fortify is read");
    assert!(v[f].unwrap_or(0.0) <= 0.0, "the fixture has no Fortify");
    let mut up = v.clone();
    up[f] = Some(20.0);
    let w: Vec<f64> = s.scorer.targets.iter().map(|t| t.weight).collect();
    let ((a, va), (b, vb)) = (s.scorer.score(&v, &w), s.scorer.score(&up, &w));
    assert!((b - a - SOFT_NUDGE).abs() < 1e-9 && va == vb, "Fortify missing costs {} (limits {va} / {vb})", b - a);
}

/// One kick turn kicks every chain of a final, so the stall check after it reads all of them, not one flat chain.
#[test]
fn kick_turn_runs_every_chain() {
    let mut s = solver();
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    // (layers after the kick stop at once: only the kicks themselves run)
    s.phase_end.set(s.spent());
    let mut chains: Vec<(State, u64)> = (1..=KICK_CHAINS as u64).map(|seed| (st.clone(), seed)).collect();
    s.kick_turn(&mut chains, 0).unwrap();
    assert!(chains.iter().zip(1u64..).all(|(c, seed)| c.1 != seed), "a chain was not kicked this turn: {:?}", chains.iter().map(|c| c.1).collect::<Vec<_>>());
}

/// A flask up part of the time does not lift the stats only limits read: a strength line during the effect of the
/// rerun's life flask (up 87% of the time) leaves the strength the requirement limit reads where it was.
#[test]
fn part_time_flask_does_not_lift_limit_stats() {
    let s = solver();
    let x = std::fs::read_to_string(format!("{}/testdata/finish-flicker2.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let lifted = x.replace("Recover Full Life at the end of the Effect", "+40 to Strength during Effect");
    assert_ne!(x, lifted);
    let i = s.names.iter().position(|n| n == "Str").unwrap();
    let v = s.eval(vec![Cand::Xml(Arc::new(x)), Cand::Xml(Arc::new(lifted))]);
    let (a, b) = (v[0].as_ref().unwrap()[i], v[1].as_ref().unwrap()[i]);
    assert_eq!(a, b, "the part-time flask lifted the strength the requirement limit reads");
}

/// Promise sweep: chosen-mod uniques cost the tier table's price, not the cheapest listing; fixed costs (gems,
/// must-use uniques) count in the gear cost and past the budget stop further buying instead of freezing the search.
#[test]
fn made_to_order_and_fixed_costs_are_charged() {
    let mut s = sweep_solver(TORNADO, "sweep-tornado.xml");
    s.slots[0].locked = true;
    assert!(s.made_cost("Watcher's Eye", 2) > 1.0, "a Watcher's Eye with 2 chosen lines is not the 0.04 listing");
    let mut g = (*s.start_gear).clone();
    g.gems = 161.0;
    assert!(s.affordable(&g, None), "gems over the budget on their own: not a freeze");
    g.gems = 0.0;
    let before = s.gear_cost(&g);
    g.pieces = vec![None; s.slots.len()];
    g.pieces[0] = Some(items::Piece { item_type: "Belt".into(), two_hand: false, design: items::Design::Unique("Mageblood".into()), xml: Arc::new(String::new()), label: "Mageblood".into() });
    assert!(s.gear_cost(&g) > before + 1.0, "a must-use unique is bought");
}

/// The same goal and seed give the same result on any machine: the solve counts evaluations, and nothing it decides
/// reads the clock or depends on which worker took a task (fixed tries, time cap).
#[test]
fn same_goal_same_result_on_any_thread_count() {
    let run = |threads: usize| {
        let goal: Goal = serde_json::from_str(GOAL).unwrap();
        let opts: Options = serde_json::from_str(&format!(r#"{{"timeBudgetMs":600000,"maxEvals":12000,"threads":{threads}}}"#)).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        s.run().unwrap();
        let best = s.archive.iter().max_by(|a, b| a.score.total_cmp(&b.score)).unwrap();
        (best.score, best.xml.to_string(), s.archive.len())
    };
    let (a, b) = (run(1), run(2));
    assert!(a.0 == b.0 && a.1 == b.1 && a.2 == b.2, "the result moved with the thread count");
}

/// The part-time flask ratio is the base's own: another build text of the same length at the same address (a freed
/// base's memory reused, made here by editing the text in place) gets its own ratio, not the old one.
#[test]
fn flask_ratio_is_not_shared_by_same_length_bases() {
    // (a clear goal: it reads the mapping uptime, where this fixture's life flask is up part of the time; a DPS target
    // would score at the fight's, `Goal::settle`, where no flask of it is up)
    let goal: Goal = serde_json::from_str(&GOAL.replace(r#""metric":"combined""#, r#""metric":"clear""#)).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let names: Vec<String> = s.scorer.names.to_vec();
    let nm: Vec<&str> = names.iter().map(|n| n.as_str()).collect();
    // (the rerun: its life flask is up part of the time; given an evasion line during its effect, so the edit below moves EHP)
    let x = std::fs::read_to_string(format!("{}/testdata/finish-flicker2.xml", env!("CARGO_MANIFEST_DIR"))).unwrap().replace("Recover Full Life at the end of the Effect", "50% increased Evasion Rating during Effect");
    let v = eval_one(&mut None, &Cand::Xml(Arc::new(x.clone())), &nm).unwrap();
    let up: Vec<f64> = (1..=5).map(|k| names.iter().position(|n| *n == format!("Solver.FlaskUptimeMap{k}")).and_then(|i| v[i]).unwrap_or(0.0)).collect();
    assert!(up.iter().any(|u| *u > 0.0 && *u < 0.999), "no flask up part of the time: {up:?}");
    let mask = up.iter().enumerate().filter(|(_, u)| **u >= 0.999).fold(0u8, |m, (k, _)| m | (1 << k));
    let a_text = set_flask_flags(&x, mask);
    let b_text = a_text.replace("50% increased Evasion", "90% increased Evasion");
    assert!(a_text.len() == b_text.len() && a_text != b_text);
    let nodes = crate::session::nodes_in_xml(&a_text).unwrap();
    let cand = |b: &Arc<String>| Cand::Nodes { base: b.clone(), nodes: nodes.clone(), mastery: None, pin: Vec::new() };
    let ehp = names.iter().position(|n| n == "TotalEHP").unwrap();
    let mut a = Arc::new(a_text);
    let mut sess = None;
    let va = eval_one(&mut sess, &cand(&a), &nm).unwrap();
    Arc::make_mut(&mut a).replace_range(.., &b_text);
    let vb = eval_one(&mut sess, &cand(&a), &nm).unwrap();
    let (bt, nodes2, names2) = (b_text.clone(), nodes.clone(), names.clone());
    let fresh = std::thread::Builder::new().stack_size(WORKER_STACK).spawn(move || {
        let nm: Vec<&str> = names2.iter().map(|n| n.as_str()).collect();
        eval_one(&mut None, &Cand::Nodes { base: Arc::new(bt), nodes: nodes2, mastery: None, pin: Vec::new() }, &nm).unwrap()
    }).unwrap().join().unwrap();
    assert!(va[ehp] != fresh[ehp], "the edit does not move EHP: the test shows nothing");
    assert_eq!(vb[ehp], fresh[ehp], "the second text read the first one's flask ratio");
}

/// The mapping finish carried Bodyswap beside Flicker Strike (itself a movement skill): taking it out moves nothing,
/// so the dead-piece pass gives it back and the gem layer adds no second movement skill. What pays stays.
#[test]
fn dead_piece_pass_gives_back_what_moves_nothing() {
    let mut s = sweep_solver(GOAL, "finish-map.xml");
    let x = std::fs::read_to_string(format!("{}/testdata/finish-map.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let re = regex::Regex::new(r#"nameSpec="([^"]*)""#).unwrap();
    let groups: Vec<Vec<&'static str>> = x.split("<Skill ").skip(1).map(|g| re.captures_iter(g.split("</Skill>").next().unwrap()).map(|c| find_gem(&c[1]).unwrap()).collect()).collect();
    let main = groups[0].clone();
    let utils: Vec<&'static str> = groups[1..].iter().map(|g| g[0]).collect();
    let c = s.candidates().unwrap();
    let k = *c.iter().find(|&&i| s.ctx[i].asc_name.as_deref() == Some("Guardian")).expect("a Guardian context");
    let mut st = s.initial_state(k, Some((main, utils)), None).unwrap();
    let mut g = (*st.gear).clone();
    g.pieces = s.player_pieces.clone();
    g.ready = true;
    st.gear = Arc::new(g);
    s.rebase(&mut st).unwrap();
    let bodyswap = find_gem("Bodyswap").unwrap();
    assert!(st.utils.contains(&bodyswap) && st.nodes.contains(&11420), "the fixture carries Bodyswap and Arcanist's Dominion");
    let (before, viol) = (st.score, st.viol);
    s.dead_piece_pass(&mut st).unwrap();
    assert!(!st.utils.contains(&bodyswap), "Bodyswap stayed for nothing");
    assert!(st.score >= before - 1e-6 && st.viol <= viol + 1e-9, "the pass cost something");
    // (Flicker Strike is the movement skill: the gem layer adds none beside it)
    s.gem_layer(&mut st, false).unwrap();
    assert!(!st.utils.iter().any(|u| s.moves(u)), "a second movement skill came back: {:?}", st.utils.iter().map(|g| gem_name(g)).collect::<Vec<_>>());
}

/// Past the search's stop the finishing passes still evaluate inside the reserve, and not beyond it.
#[test]
fn finishing_reserve_evaluates_then_stops() {
    let s = solver();
    let cand = || vec![Cand::Xml(Arc::new(fixture()))];
    s.evals.store(s.max_evals * (100 - FINAL_RESERVE_PCT / 2) / 100, Ordering::Relaxed);
    assert!(s.stop(), "the search is over");
    assert!(s.eval(cand())[0].is_none(), "the search gets nothing from the reserve");
    s.finalizing.set(true);
    assert!(!s.stop());
    assert!(s.eval(cand())[0].is_some(), "a finishing pass evaluates inside the reserve");
    s.evals.store(s.max_evals, Ordering::Relaxed);
    assert!(s.stop() && s.eval(cand())[0].is_none(), "nothing beyond the reserve");
}

/// Run A's best build (Poisonous Concoction, bossing) failed "Survives every boss skill" by 0.20 on Maven Memory Game
/// alone (7.5 s of pattern the player follows): now a mechanic chip and no shortfall.
#[test]
fn run_a_memory_game_is_a_mechanic_not_a_shortfall() {
    let goal: Goal = serde_json::from_str(&GOAL.replace(r#""metric":"combined""#, r#""metric":"boss""#).replace("mapping", "bossing")).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let s = Solver::new(blank_build_xml(95), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let xml = Arc::new(std::fs::read_to_string(format!("{}/testdata/run-a-best.xml", env!("CARGO_MANIFEST_DIR"))).unwrap());
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let mut v = eval_one(&mut None, &Cand::Xml(xml.clone()), &names).unwrap();
    let chips = s.boss_check(&xml, &mut v);
    println!("chips {chips:?}");
    assert!(chips.iter().any(|c| c.starts_with("Mechanic: Maven Memory Game, ")), "no mechanic chip: {chips:?}");
    assert!(!chips.iter().any(|c| c.contains("Memory Game") && c.starts_with("One-shot")), "{chips:?}");
    assert_eq!(limit(&s, &v, "Survives every boss skill"), 0.0, "run A was short by 0.20 on Memory Game");
}
