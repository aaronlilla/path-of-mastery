//! Things the game does not allow that the audit of the bench builds found (proof/tasks/legality-3): Sacrifice at full life,
//! Arcane Surge beside Lifetap, a guard skill counted always up. Fixtures are the bench's best.xml for Essence Drain and Spark.

use super::*;

const ED_GOAL: &str = r#"{"skill":"Essence Drain","level":100,"rolls":"perfect","targets":[{"name":"Combined DPS","metric":"combined"},{"name":"EHP","metric":"ehp","value":37921}]}"#;
const SPARK_GOAL: &str = r#"{"skill":"Spark of the Nova","level":100,"rolls":"perfect","targets":[{"name":"Combined DPS","metric":"combined"},{"name":"EHP","metric":"ehp","value":252675}]}"#;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn solver_of(goal: &str) -> Solver {
    let goal: Goal = serde_json::from_str(goal).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    Solver::new(blank_build_xml(100), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
}

/// Essence Drain with Sacrifice casts 2 times a second and takes 20% of its life each cast, against 356 life a second of
/// regeneration: the life limit has to see that.
#[test]
fn sacrifice_life_counts_against_sustain() {
    let s = solver_of(ED_GOAL);
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let v = eval_one(&mut None, &Cand::Xml(Arc::new(fixture("legal3-ed.xml"))), &names).unwrap();
    let i = s.scorer.limits.iter().position(|l| l.name == "Life cost and self-damage sustainable").expect("the life sustain limit");
    let d = s.scorer.deficits(&v)[i];
    assert!(d > 0.0, "Sacrifice's life per second is not counted in the sustain limit");
}

/// Arcane Surge triggers on mana the supported skill spends; with Lifetap it spends none. The setup is not tried.
#[test]
fn arcane_surge_not_beside_lifetap() {
    let mut s = solver_of(ED_GOAL);
    let c = s.candidates().unwrap();
    let st = s.initial_state(c[0], None, None).unwrap();
    let (lt, asg) = (find_gem("Lifetap").unwrap(), find_gem("Arcane Surge").unwrap());
    let before = s.evals.load(Ordering::Relaxed);
    s.try_setups_plain(&st, vec![(vec![st.main[0], lt, asg], vec![])]).unwrap();
    assert_eq!(s.evals.load(Ordering::Relaxed), before, "a Lifetap + Arcane Surge link was evaluated");
    s.try_setups_plain(&st, vec![(vec![st.main[0], asg], vec![])]).unwrap();
    assert!(s.evals.load(Ordering::Relaxed) > before, "Arcane Surge alone is still tried");
}

/// Arcane Cloak: 3 s up, 4 s cooldown that does not recover during the buff, so 3/7 of the time. The pool scores the
/// build as the mix of it with and without the skill.
#[test]
fn guard_skill_weighted_by_uptime() {
    let s = solver_of(SPARK_GOAL);
    let xml = Arc::new(fixture("legal3-spark.xml"));
    let u = 3.0 / 7.0;
    let i = s.scorer.names.iter().position(|n| n == "CombinedDPS").unwrap();
    let names: Vec<&str> = s.scorer.names.iter().map(|n| n.as_str()).collect();
    let on = eval_one(&mut None, &Cand::Xml(xml.clone()), &names).unwrap()[i].unwrap();
    let at = xml.find("<Gem nameSpec=\"Arcane Cloak\"").expect("Arcane Cloak in the build");
    let off_text = format!("{}{}", &xml[..at], xml[at..].replacen("enabled=\"true\"", "enabled=\"false\"", 1));
    let off = eval_one(&mut None, &Cand::Xml(Arc::new(off_text)), &names).unwrap()[i].unwrap();
    let got = s.pool.eval(vec![Cand::Xml(xml)], &s.names, &s.cancel).pop().unwrap().unwrap()[i].unwrap();
    assert!(off < on, "Arcane Cloak adds damage");
    assert!((got - (u * on + (1.0 - u) * off)).abs() < 1.0, "scored {got}");
}

/// Withered stacks are what the Wither totem keeps up (cast rate x Withered duration x totems, at most 15), read from
/// the build's own Wither group; the old fixed 15 overstated Essence Drain's.
#[test]
fn withered_stacks_follow_the_totem() {
    let ed = solver_of(ED_GOAL).wither_stacks(&fixture("legal3-ed.xml"));
    let spark = solver_of(SPARK_GOAL).wither_stacks(&fixture("legal3-spark.xml"));
    assert!(ed.is_some_and(|n| n > 1.0 && n < 14.5), "ED totem does not keep 15 stacks up: {ed:?}");
    assert_eq!(spark, Some(15.0));
}

/// A solver-made item (through `with_piece`, the gate every item passes) never holds two mods of one group, a second
/// bench craft without "Can have up to 3 Crafted Modifiers", or more than two crafts beside it. Hybrid mods that only
/// share wording (pure attack speed and the Elder attack speed / attack speed if killed recently) are separate groups
/// in the game data (ModExplicit.lua) and stay allowed.
#[test]
fn solver_items_follow_mod_group_and_craft_limits() {
    use items::{craft_piece, SlotKind};
    let s = solver_of(r#"{"skill":"Flicker Strike","level":90,"targets":[{"name":"DPS"}],"wealth":"mirror"}"#);
    let (gl, wp) = (s.slot_of(SlotKind::Gloves).unwrap(), s.slot_of(SlotKind::Weapon1).unwrap());
    let b = s.base_craft("Spiked Gloves", &[]).unwrap();
    let take = |slot: usize, b: &Arc<BaseInfo>, m: &[usize]| s.with_piece(&s.start_gear, slot, Some(craft_piece(b, m.to_vec(), None, s.item_level))).is_some();
    let fam = |b: &BaseInfo, f: &dyn Fn(&items::Fam) -> bool| (0..b.fams.len()).filter(|&i| f(&b.fams[i])).collect::<Vec<_>>();
    // the same group twice: a rolled life prefix and the bench life craft
    let life = fam(&b, &|f| f.group == "IncreasedLife" && f.source == "normal")[0];
    let life_craft = fam(&b, &|f| f.group == "IncreasedLife" && f.source == "bench")[0];
    // bench crafts in distinct groups: two prefixes, one suffix, and the multimod (a suffix)
    let multi = fam(&b, &|f| f.group == "ItemGenerationCanHaveMultipleCraftedMods")[0];
    let mut crafts: Vec<usize> = Vec::new();
    for want in [true, true, false] {
        let c = fam(&b, &|f| f.source == "bench" && f.prefix == want && f.group != "ItemGenerationCanHaveMultipleCraftedMods" && f.group != "IncreasedLife");
        crafts.push(*c.iter().find(|&&c| !crafts.iter().any(|&x| b.fams[x].group == b.fams[c].group)).unwrap());
    }
    let cases: Vec<(Vec<usize>, bool)> = vec![
        (vec![life, life_craft], false),
        (vec![crafts[0], crafts[1]], false),
        (vec![multi, crafts[0], crafts[1]], true),
        (vec![multi, crafts[0], crafts[1], crafts[2]], false),
    ];
    for (m, ok) in &cases {
        let got = take(gl, &b, m);
        assert_eq!(got, *ok);
    }
    let axe = s.base_craft("Apex Cleaver", &["elder".to_string()]).unwrap();
    let pure = fam(&axe, &|f| f.group == "LocalIncreasedAttackSpeed" && f.source == "normal")[0];
    let elder = fam(&axe, &|f| f.group == "AttackSpeedKilledRecently")[0];
    assert!(take(wp, &axe, &[pure, elder]));
}

/// Gems sit only in sockets that exist (pconc solve: the main 6-link in an empty body slot, Wither + Spell Totem
/// in the main hand Poisonous Concoction needs empty). A skill whose weaponTypes allow no weapon leaves the main hand
/// without sockets; once the bases are chosen, an empty slot holds none, and the render keeps out what does not fit.
#[test]
fn gems_sit_only_in_real_sockets() {
    let mut s = solver_of(r#"{"skill":"Poisonous Concoction","level":90}"#);
    let c = s.candidates().unwrap();
    let sup: Vec<&'static str> = ["Unbound Ailments", "Void Manipulation", "Critical Strike Affliction", "Added Chaos Damage", "Pierce"].iter().map(|n| find_gem(n).unwrap()).collect();
    let main: Vec<&'static str> = std::iter::once(s.main_gem).chain(sup).collect();
    let mut st = s.initial_state(c[0], Some((main, vec![find_gem("Clarity").unwrap()])), None).unwrap();
    let (w1, body, gloves) = (s.slot_of(SlotKind::Weapon1).unwrap(), s.slot_of(SlotKind::Body).unwrap(), s.slot_of(SlotKind::Gloves).unwrap());
    let mut g = (*st.gear).clone();
    g.pieces = vec![None; s.slots.len()];
    g.ready = false;
    let groups = s.gem_groups(&st.main, &st.utils);
    assert!(!s.assign_groups(&g, &groups).contains(&Some(w1)), "gems in the main hand pconc needs empty");
    // bases chosen: gloves only, the body left empty
    g.ready = true;
    g.pieces[gloves] = Some(s.empty_craft("Spiked Gloves").unwrap());
    let at = s.assign_groups(&g, &groups);
    assert!(at.iter().all(|a| *a != Some(body) && *a != Some(w1)), "gems in an empty slot: {at:?}");
    st.gear = Arc::new(g);
    let xml = s.render(&st).unwrap();
    let main_group = xml.split("<Skill ").nth(1).unwrap().split("</Skill>").next().unwrap();
    assert_eq!(main_group.matches("<Gem ").count(), 4, "the main link holds more gems than the gloves' 4 sockets: {main_group}");
}
