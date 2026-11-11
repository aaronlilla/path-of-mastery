//! "Calculate maximum and apply the strongest non-damaging ailments" (CalcPerform.lua:3467-3624):
//! per Chill/Shock/Scorch/Brittle/Sap, `output.Maximum<A>` / `output.Current<A>` and the enemy-side
//! mods (`ailments[..].mods(num)`) that follow from them, then the chill/shock multiplier top-up.
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

fn s(n: &str) -> Sym {
    Sym::new(n)
}
fn sum(st: &ModStore, ty: ModType, names: &[&str]) -> f64 {
    let n: Vec<Sym> = names.iter().map(|x| s(x)).collect();
    st.sum(ty, None, &n)
}
fn flag(st: &ModStore, names: &[&str]) -> bool {
    let n: Vec<Sym> = names.iter().map(|x| s(x)).collect();
    st.flag(None, &n)
}
fn over(st: &ModStore, name: &str) -> Option<f64> {
    st.override_(None, &[s(name)]).and_then(|v| v.num())
}
fn cond(var: &str) -> Tag {
    Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from(var)))] }
}
fn stacks(var: &str, limit: f64) -> Tag {
    Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), Value::Str(Arc::from(var))), (pom_engine::sym!("limit"), Value::Num(limit))] }
}
fn mk(name: &str, ty: ModType, value: f64, source: &str, tags: Vec<Tag>) -> Mod {
    Mod { name: s(name), ty, value: Value::Num(value), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (tags).into() }
}

/// data.nonDamagingAilment: (name, condition, max, precision)
const AILMENTS: [(&str, &str, f64, i32); 5] = [
    ("Chill", "Chilled", 30.0, 0),
    ("Shock", "Shocked", 50.0, 0),
    ("Scorch", "Scorched", 30.0, 0),
    ("Brittle", "Brittle", 6.0, 2),
    ("Sap", "Sapped", 20.0, 0),
];

fn ailment_mods(name: &str, num: f64, player: &ModStore, enemy: &ModStore, out: &mut HashMap<String, f64>, guaranteed_bonechill: bool) -> Vec<Mod> {
    let stack_max = |a: &str| over(player, &format!("{a}StacksMax")).unwrap_or_else(|| sum(player, ModType::Base, &[&format!("{a}StacksMax")]));
    match name {
        "Chill" => {
            let mut mods = vec![mk("ActionSpeed", ModType::Inc, -num, "Chill", vec![cond("Chilled")])];
            if flag(player, &["ChillEffectIncDamageTaken"]) {
                mods.push(mk("DamageTaken", ModType::Inc, num, "Ahuana's Bite", vec![cond("Chilled")]));
            } else if flag(player, &["ChillEffectIncColdDamageTaken"]) {
                mods.push(mk("ColdDamageTaken", ModType::Inc, num, "Chilled by Hits", vec![cond("Chilled")]));
            } else if flag(player, &["ChillingAreaIncColdDamageTaken"]) {
                mods.push(mk("ColdDamageTaken", ModType::Inc, num, "Chilling Area", vec![cond("Chilled")]));
            } else if out.get("HasBonechill").is_some_and(|v| *v != 0.0) && (guaranteed_bonechill || sum(enemy, ModType::Base, &["ChillVal"]) > 0.0) {
                mods.push(mk("ColdDamageTaken", ModType::Inc, num, "Bonechill", vec![cond("Chilled")]));
            }
            if flag(player, &["ChillEffectLessDamageDealt"]) {
                mods.push(mk("Damage", ModType::More, -num / 2.0, "Shaper of Winter", vec![cond("Chilled")]));
            }
            mods
        }
        "Shock" => {
            if flag(player, &["ShockCanStack"]) {
                let lim = stack_max("Shock");
                out.insert("CurrentShock".into(), num * sum(enemy, ModType::Base, &["Multiplier:ShockStacks"]).min(lim));
                vec![
                    mk("DamageTaken", ModType::Inc, num, "Shock", vec![cond("Shocked"), stacks("ShockStacks", lim)]),
                    mk("DamageTakenByShock", ModType::Inc, num, "Shock Stacks", vec![cond("Shocked"), stacks("ShockStacks", lim)]),
                ]
            } else {
                vec![mk("DamageTaken", ModType::Inc, num, "Shock", vec![cond("Shocked")])]
            }
        }
        "Scorch" => {
            if flag(player, &["ScorchCanStack"]) {
                let lim = stack_max("Scorch");
                out.insert("CurrentScorch".into(), num * sum(enemy, ModType::Base, &["Multiplier:ScorchStacks"]).min(lim));
                vec![
                    mk("ElementalResist", ModType::Base, -num, "Scorch", vec![cond("Scorched"), stacks("ScorchStacks", lim)]),
                    mk("ElementalResistByScorch", ModType::Base, -num, "Scorch Stacks", vec![cond("Scorched"), stacks("ScorchStacks", lim)]),
                ]
            } else {
                vec![mk("ElementalResist", ModType::Base, -num, "Scorch", vec![cond("Scorched")])]
            }
        }
        "Brittle" => vec![mk("SelfCritChance", ModType::Base, num, "Brittle", vec![cond("Brittle")])],
        _ => vec![mk("Damage", ModType::More, -num, "Sap", vec![cond("Sapped")])],
    }
}

pub fn apply_ailments(
    player: &mut ModStore,
    enemy: &mut ModStore,
    output: &mut HashMap<String, f64>,
    active_skills: &[pom_skills::assemble::ComputedSkill],
    main: Option<&pom_skills::assemble::ComputedSkill>,
    guaranteed_bonechill: bool,
) {
    for (ailment, condition, data_max, precision) in AILMENTS {
        let a = ailment;
        let (base, ovr, min) = (format!("{a}Base"), format!("{a}Override"), format!("{a}Minimum"));
        let avoided = flag(enemy, &[&format!("Condition:Already{condition}")])
            || flag(enemy, &[&format!("{a}Immune"), "ElementalAilmentImmune"])
            || sum(enemy, ModType::Base, &[&format!("Avoid{a}"), "AvoidAilments", "AvoidElementalAilments"]) >= 100.0;
        // `enemyDB:Sum(..) > 0 or modDB:Sum(..)`: a number is always truthy in Lua, so the gate is only `avoided`.
        if avoided {
            continue;
        }
        let mut override_ = 0.0f64;
        let mut minimum = 0.0f64;
        let names = [s(&base), s(&ovr), s(&min)];
        let found: Vec<Mod> = player.tabulate(Some(ModType::Base), None, &names).into_iter().map(|(_, m)| unsafe { (*m).clone() }).collect();
        for m in found {
            let mut effect = m.value.num().unwrap_or(0.0);
            let scales = m.name.as_str() == base || m.name.as_str() == min;
            if m.name.as_str() == ovr {
                enemy.add_mod(Mod { name: s(&format!("Condition:{condition}")), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: m.source.clone(), tags: (vec![]).into() });
            }
            if scales {
                let effect_name = format!("Enemy{a}Effect");
                let use_skill = a != "Scorch" && a != "Sap" && a != "Brittle"
                    && main.map_or(false, |mn| {
                        mn.skill_flags.contains("hit") && !sum_list(&mn.skill_mod_list, "Cannot", a) && flag(player, &["ChecksHighestDamage"])
                    });
                if use_skill {
                    let snap = crate::buffs::player_snapshot(player);
                    let mut st = ModStore::new_list(Some(snap.clone()), snap.actor.clone());
                    for x in &main.unwrap().skill_mod_list {
                        st.add_mod(x.clone());
                    }
                    effect *= pom_calc::tools::mod_(&st, None, &[s(&effect_name)]);
                } else {
                    effect *= pom_calc::tools::mod_(player, None, &[s(&effect_name)]);
                }
            }
            effect *= pom_calc::tools::mod_(enemy, None, &[s(&format!("Self{a}Effect"))]);
            if scales {
                player.add_mod(Mod { name: s(&ovr), ty: ModType::Base, value: Value::Num(effect), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
                if m.name.as_str() == min {
                    minimum += effect;
                }
            }
            override_ = override_.max(effect).max(minimum);
        }
        let max_key = format!("{a}Max");
        let mut max_ailment = over(player, &max_key).unwrap_or(0.0);
        if over(player, &max_key).is_none() {
            for sk in active_skills {
                let st_sum = sk.skill_mod_list.iter().filter(|m| m.name.as_str() == max_key && m.ty == ModType::Base).filter_map(|m| m.value.num()).sum::<f64>();
                // baseSkillModList has the player's modDB as parent, so its Sum includes the global mods too.
                let skill_max = data_max + st_sum + sum(player, ModType::Base, &[&max_key]);
                if skill_max > max_ailment {
                    max_ailment = skill_max;
                }
            }
        }
        output.insert(format!("Maximum{a}"), max_ailment);
        let scale = 10f64.powi(precision);
        let cur = (override_.max(sum(enemy, ModType::Base, &[&format!("{a}Val")])).min(max_ailment) * scale).floor() / scale;
        output.insert(format!("Current{a}"), cur);
        for m in ailment_mods(a, cur, player, enemy, output, guaranteed_bonechill) {
            enemy.add_mod(m);
        }
        enemy.add_mod(mk(&format!("Condition:Already{condition}"), ModType::Flag, 0.0, "", vec![cond(condition)]).with_flag_true());
    }
    let chill_mult = sum(enemy, ModType::Base, &["Multiplier:ChillEffect"]);
    if let Some(c) = output.get("CurrentChill").copied() {
        if chill_mult < c {
            enemy.add_mod(mk("Multiplier:ChillEffect", ModType::Base, c - chill_mult, "", vec![]));
        }
    }
    let shock_mult = sum(enemy, ModType::Base, &["Multiplier:ShockEffect"]);
    if let Some(c) = output.get("CurrentShock").copied() {
        if shock_mult < c {
            enemy.add_mod(mk("Multiplier:ShockEffect", ModType::Base, c - shock_mult, "", vec![]));
        }
    }
}

/// `skill.baseSkillModList:Flag(nil, "Cannot"..ailment)`
fn sum_list(mods: &[Mod], prefix: &str, a: &str) -> bool {
    let n = format!("{prefix}{a}");
    mods.iter().any(|m| m.name.as_str() == n && m.ty == ModType::Flag && matches!(m.value, Value::Bool(true)))
}

trait FlagTrue {
    fn with_flag_true(self) -> Self;
}
impl FlagTrue for Mod {
    fn with_flag_true(mut self) -> Self {
        self.ty = ModType::Flag;
        self.value = Value::Bool(true);
        self
    }
}

pub(crate) fn skill_store(player_snap: &Arc<ModStore>, c: &pom_skills::assemble::ComputedSkill) -> ModStore {
    let mut st = ModStore::new_list(Some(player_snap.clone()), player_snap.actor.clone());
    for m in &c.skill_mod_list {
        st.add_mod(m.clone());
    }
    st
}

fn flag_mod(name: &str, source: &str) -> Mod {
    Mod { name: s(name), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from(source)), tags: (vec![]).into() }
}

/// Skill-sourced guaranteed ailments inside the early per-skill loop (CalcPerform.lua:1388-1434):
/// Shocked Ground, Summon Skitterbots. Returns the indices of the "guaranteed chill" skills, which
/// `late_guaranteed_chills` turns into `ChillOverride` once the buffs are merged.
/// Also sets `output.HasBonechill` (1393) and returns `hasGuaranteedBonechill` (1415, 1432) with the chill skills.
pub fn early_skill_ailments(player: &mut ModStore, enemy: &mut ModStore, output: &mut HashMap<String, f64>, active_skills: &[pom_skills::assemble::ComputedSkill]) -> (Vec<usize>, bool) {
    let snap = crate::buffs::player_snapshot(player);
    let src_skill = pom_engine::modstore::types::Cfg { source: Some(Arc::from("Skill")), ..Default::default() };
    let mut chill_skills = Vec::new();
    let mut guaranteed_bonechill = false;
    for (i, c) in active_skills.iter().enumerate() {
        // The skill's store is needed only by the checks below that read it; built on first use.
        let st_cell = std::cell::OnceCell::new();
        let st = || st_cell.get_or_init(|| skill_store(&snap, c));
        let name = c.name.as_str();
        let support_bonechill = matches!(crate::offence::skill_data_map(player, c).get("supportBonechill"), Some(pom_engine::modstore::types::ScalarValue::Bool(true)));
        if support_bonechill && (c.skill_types.contains(&pom_skills::skill_type::CHILLING_AREA) || c.skill_types.contains(&pom_skills::skill_type::NON_HIT_CHILL) || !st().flag(None, &[pom_engine::sym!("CannotChill")])) {
            output.insert("HasBonechill".into(), 1.0);
        }
        if name == "Vaal Lightning Trap" || name == "Shock Ground" {
            let effect = st().sum(ModType::Base, None, &[pom_engine::sym!("ShockedGroundEffect")]) * (1.0 + st().sum(ModType::Inc, None, &[pom_engine::sym!("EnemyShockEffect")]) / 100.0);
            player.add_mod(mk("ShockOverride", ModType::Base, effect, "Shocked Ground", vec![Tag { kind: pom_engine::sym!("ActorCondition"), fields: vec![(pom_engine::sym!("actor"), Value::Str(Arc::from("enemy"))), (pom_engine::sym!("var"), Value::Str(Arc::from("OnShockedGround")))] }]));
        }
        if name == "Summon Skitterbots" {
            let ail = st().sum(ModType::Inc, None, &[pom_engine::sym!("SkitterbotAilmentEffect")]);
            let affect_player = st().flag(None, &[pom_engine::sym!("SkitterbotAffectPlayer")]);
            let sides = [
                ("Shock", "Shocked", 15.0, "SkitterbotsCannotShock", true),
                ("Chill", "Chilled", 10.0, "SkitterbotsCannotChill", true),
                ("Scorch", "Scorched", 10.0, "ScorchingSkitterbot", false),
            ];
            for (a, cond_name, default, gate, negate) in sides {
                let g = st().flag(None, &[s(gate)]);
                if g == negate {
                    continue;
                }
                let effect = default * (1.0 + (st().sum(ModType::Inc, Some(&src_skill), &[s(&format!("Enemy{a}Effect"))]) + ail) / 100.0);
                player.add_mod(mk(&format!("{a}Override"), ModType::Base, effect, name, vec![]));
                enemy.add_mod(flag_mod(&format!("Condition:{cond_name}"), name));
                if affect_player {
                    player.add_mod(flag_mod(a, name));
                    player.add_mod(mk(&format!("Self{a}Override"), ModType::Base, effect, name, vec![]));
                }
                if a == "Chill" && support_bonechill {
                    guaranteed_bonechill = true;
                    player.add_mod(flag_mod("SkitterbotBonechill", name));
                }
            }
        } else if c.skill_flags.contains("guaranteedChill")
            || c.skill_types.contains(&pom_skills::skill_type::CHILLING_AREA)
            || (c.skill_types.contains(&pom_skills::skill_type::NON_HIT_CHILL) && !st().flag(None, &[pom_engine::sym!("CannotChill")]))
        {
            chill_skills.push(i);
            enemy.add_mod(flag_mod("Condition:Chilled", name));
            if support_bonechill {
                guaranteed_bonechill = true;
            }
        }
    }
    (chill_skills, guaranteed_bonechill)
}

/// "Calculate guaranteed chills after buffs" (CalcPerform.lua:3378-3382).
pub fn late_guaranteed_chills(player: &mut ModStore, active_skills: &[pom_skills::assemble::ComputedSkill], chill_skills: &[usize]) {
    let snap = crate::buffs::player_snapshot(player);
    for &i in chill_skills {
        let c = &active_skills[i];
        let st = skill_store(&snap, c);
        let cfg = crate::buffs::skill_cfg(c);
        let effect = 10.0 * pom_calc::tools::mod_(&st, Some(&cfg), &[pom_engine::sym!("EnemyChillEffect")]);
        player.add_mod(mk("ChillOverride", ModType::Base, effect, &c.name, vec![]));
    }
}

/// "Fix the configured impale stacks on the enemy" (CalcPerform.lua:3384-3392): a missing config uses the
/// maximum number of stacks; a larger one is replaced by it.
pub fn fix_impale_stacks(player: &ModStore, enemy: &mut ModStore) {
    use pom_engine::modstore::store::Backing;
    let max = sum(player, ModType::Base, &["ImpaleStacksMax"]) * (1.0 + sum(player, ModType::Base, &["ImpaleAdditionalDurationChance"]) / 100.0);
    let name = "Multiplier:ImpaleStacks";
    if !enemy.has_mod(ModType::Base, None, &[s(name)]) {
        enemy.add_mod(mk(name, ModType::Base, max, "Config", vec![cond("Combat")]));
    } else if enemy.sum(ModType::Base, None, &[s(name)]) > max {
        let new = mk(name, ModType::Base, max, "Config", vec![cond("Combat")]);
        let mut done = false;
        if let Backing::Db(map) = &mut enemy.backing {
            if let Some(v) = map.get_mut(&s(name)) {
                for m in v.iter_mut() {
                    if m.ty == ModType::Base && m.flags == 0 && m.keyword_flags == 0 && m.source.as_deref() == Some("Config") {
                        *m = new.clone();
                        done = true;
                        break;
                    }
                }
            }
        }
        if !done {
            enemy.add_mod(new);
        }
    }
}

/// "Apply exposures" (CalcPerform.lua:3628-3658): the weakest `<Element>Exposure` on the enemy becomes
/// an enemy resistance mod, and sets `Condition:AppliedExposureRecently` on the player.
pub fn apply_exposures(player: &mut ModStore, enemy: &mut ModStore, tree_version: &str) {
    let mut it = tree_version.split('_');
    let major: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let minor: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    for element in ["Fire", "Cold", "Lightning"] {
        let ee = flag(player, &["ElementalEquilibrium"]);
        let hit = flag(enemy, &[&format!("Condition:HitBy{element}Damage")]);
        if !(major <= 3.0 && minor <= 15.0 || !ee || !hit) {
            continue;
        }
        let mut min = f64::INFINITY;
        let mut source: Option<Arc<str>> = Some(Arc::from(""));
        for (v, m) in enemy.tabulate(Some(ModType::Base), None, &[s(&format!("{element}Exposure"))]) {
            let v = v.num().unwrap_or(0.0);
            if v < min {
                min = v;
                // SAFETY: `tabulate` returns pointers into `enemy`, alive here.
                source = unsafe { &*m }.source.clone();
            }
        }
        if min == f64::INFINITY {
            continue;
        }
        for (v, _) in player.tabulate(Some(ModType::Base), None, &[pom_engine::sym!("ExtraExposure"), s(&format!("Extra{element}Exposure"))]) {
            min += v.num().unwrap_or(0.0);
        }
        let inc = sum(player, ModType::Inc, &["ExposureEffect", &format!("{element}ExposureEffect")]);
        if inc != 0.0 {
            min *= 1.0 + inc / 100.0;
        }
        enemy.add_mod(Mod { name: s(&format!("Condition:Has{element}Exposure")), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from("")), tags: (vec![]).into() });
        // m_min(min, modDB:Override(nil, "ExposureMin")): a nil override leaves `min` as is.
        let val = match over(player, "ExposureMin") { Some(o) => min.min(o), None => min };
        enemy.add_mod(Mod { name: s(&format!("{element}Resist")), ty: ModType::Base, value: Value::Num(val), flags: 0, keyword_flags: 0, source, tags: (vec![]).into() });
        player.add_mod(Mod { name: pom_engine::sym!("Condition:AppliedExposureRecently"), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(Arc::from("")), tags: (vec![]).into() });
    }
    // Handle consecrated ground effects on enemies (CalcPerform.lua:3661-3665).
    if flag(enemy, &["Condition:OnConsecratedGround"]) {
        let effect = 1.0 + sum(player, ModType::Inc, &["ConsecratedGroundEffect"]) / 100.0;
        let v = (sum(enemy, ModType::Inc, &["DamageTakenConsecratedGround"]) * effect).floor();
        enemy.add_mod(Mod { name: pom_engine::sym!("DamageTaken"), ty: ModType::Inc, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(Arc::from("Consecrated Ground")), tags: (vec![]).into() });
    }
}
