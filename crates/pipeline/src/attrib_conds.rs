//! The "Set conditions" head of `doActorAttribsConditions` (Modules/CalcPerform.lua:146-283): the
//! weapon/off-hand/armour-slot conditions (`UsingShield`, `DualWielding`, `Using<Flag>`, ...) and,
//! in combat mode, the main-skill recency conditions (`AttackedRecently`, `HitRecently`, ...).
//!
//! Not modelled (documented, not faked): `weaponData.countsAsAll1H` (Varunastra: the extra
//! `UsingAxe/Sword/...` conditions), Graft slots, `env.aegisModList`'s `UsingShield`, and thrusting
//! sword `subType` in the dual-wield "different weapon types" comparison.
use pom_engine::sym::Sym;
use pom_skills::assemble::ComputedSkill;
use pom_skills::data::{weapon_type_info, BuildItemTypes};
use pom_engine::fxhash::HashMap;

fn weapon_label(ty: &str) -> String {
    // `weaponTypeInfo[type].label or subType or type` - only "label" is in the data.
    let v = pom_skills::data::game_data().extra.get("weaponTypeInfo").expect("weaponTypeInfo section missing").expect("weaponTypeInfo section failed to parse");
    v.get(ty).and_then(|i| i.get("label")).and_then(|l| l.as_str()).map(|s| s.to_string()).unwrap_or_else(|| ty.to_string())
}

/// Conditions from the equipped weapons/off-hand/armour (CalcPerform.lua:146-262).
pub fn weapon_conditions(item_types: &BuildItemTypes, item_slots: &HashMap<String, i64>, weapon_data: &HashMap<String, Vec<serde_json::Value>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let w1 = item_types.weapon1_type(item_slots, |t| weapon_type_info(t).is_some());
    // CalcSetup.lua:1567: a `countsAsDualWielding` Weapon 1 takes its `weaponData[2]` as weaponData2.
    let w1_data = weapon_data.get("Weapon 1");
    let counts_as_dual = w1_data.and_then(|w| w.first()).and_then(|v| v.get("countsAsDualWielding")).and_then(|v| v.as_bool()).unwrap_or(false);
    let w2 = if counts_as_dual {
        w1_data.and_then(|w| w.get(1)).and_then(|v| v.get("type")).and_then(|t| t.as_str()).map(|t| t.to_string())
    } else {
        item_types.weapon2_type(item_slots, |t| weapon_type_info(t).is_some())
    };
    let has_w2_item = item_slots.contains_key("Weapon 2");
    if item_types.item_type_for_slot(item_slots, "Weapon 2") == Some("Shield") {
        out.push("UsingShield".into());
    } else if !has_w2_item {
        out.push("OffHandIsEmpty".into());
    }
    let mut add_weapon = |ty: &str, out: &mut Vec<String>| {
        if let Some(info) = weapon_type_info(ty) {
            out.push(format!("Using{}", info.flag));
            if info.melee {
                out.push("UsingMeleeWeapon".into());
            }
            out.push(if info.one_hand { "UsingOneHandedWeapon".into() } else { "UsingTwoHandedWeapon".into() });
        }
    };
    let all_1h = |slot: &str, out: &mut Vec<String>| {
        if item_types.counts_as_all_1h(slot) {
            // Varunastra (CalcPerform.lua:160-173): counts as every one handed melee weapon type.
            for c in ["UsingAxe", "UsingSword", "UsingDagger", "UsingMace", "UsingClaw", "WieldingDifferentWeaponTypes"] {
                out.push(c.into());
            }
        }
    };
    if w1 == "None" {
        out.push("Unarmed".into());
        if !has_w2_item && !item_slots.contains_key("Gloves") {
            out.push("Unencumbered".into());
        }
        // `Using..Unarmed` is set through the generic branch's sibling below only for a real weapon.
    } else {
        add_weapon(&w1, &mut out);
        all_1h("Weapon 1", &mut out);
    }
    for slot in ["Helmet", "Body Armour", "Gloves", "Boots"] {
        if item_slots.contains_key(slot) {
            out.push(format!("Using{slot}"));
        }
    }
    if let Some(w2) = &w2 {
        add_weapon(w2, &mut out);
        all_1h("Weapon 2", &mut out);
    }
    if let Some(w2) = &w2 {
        out.push("DualWielding".into());
        let (a1, a2) = (item_types.counts_as_all_1h("Weapon 1"), item_types.counts_as_all_1h("Weapon 2"));
        if (w1 == "Claw" || a1) && (w2 == "Claw" || a2) {
            out.push("DualWieldingClaws".into());
        }
        if (w1 == "Dagger" || a1) && (w2 == "Dagger" || a2) {
            out.push("DualWieldingDaggers".into());
        }
        if weapon_label(&w1) != weapon_label(w2) {
            if let (Some(i1), Some(i2)) = (weapon_type_info(&w1), weapon_type_info(w2)) {
                if i1.one_hand && i2.one_hand {
                    out.push("WieldingDifferentWeaponTypes".into());
                }
            }
        }
    }
    out
}

/// Main-skill recency conditions (CalcPerform.lua:263-297), `env.mode_combat` only.
pub fn combat_conditions(main: &ComputedSkill, triggered: bool) -> Vec<String> {
    let f = |k: &str| main.skill_flags.contains(k);
    let mut out: Vec<String> = Vec::new();
    let (trap, mine, totem) = (f("trap"), f("mine"), f("totem"));
    if !triggered && !trap && !mine && !totem {
        if f("attack") {
            out.push("AttackedRecently".into());
        } else if f("spell") {
            out.push("CastSpellRecently".into());
        }
        if main.skill_types.contains(&pom_skills::skill_type::MOVEMENT) {
            out.push("UsedMovementSkillRecently".into());
        }
        if f("minion") && !f("permanentMinion") {
            out.push("UsedMinionSkillRecently".into());
        }
        if main.skill_types.contains(&pom_skills::skill_type::VAAL) {
            out.push("UsedVaalSkillRecently".into());
        }
        if main.skill_types.contains(&pom_skills::skill_type::CHANNEL) {
            out.push("Channelling".into());
        }
    }
    if f("hit") && !trap && !mine && !totem {
        out.push("HitRecently".into());
        if f("spell") {
            out.push("HitSpellRecently".into());
        }
    }
    if totem {
        out.push("HaveTotem".into());
        out.push("SummonedTotemRecently".into());
        if f("hit") {
            out.push("TotemsHitRecently".into());
            if f("spell") {
                out.push("TotemsSpellHitRecently".into());
            }
        }
    }
    if mine {
        out.push("DetonatedMinesRecently".into());
    }
    if trap {
        out.push("TriggeredTrapsRecently".into());
    }
    out
}

pub fn sym(s: &str) -> Sym {
    Sym::new(s)
}

/// The `weaponData1`/`weaponData2` tables the `Condition` tag evaluator reads (`countsAsAll1H` and the `AddedUsing<Type>` flags
/// `doActorAttribsConditions` writes, CalcPerform.lua:160-201). Only weapons that count as all one handed types get a table.
pub fn actor_weapon_maps(
    item_types: &BuildItemTypes,
    item_slots: &HashMap<String, i64>,
    weapon_data: &HashMap<String, Vec<serde_json::Value>>,
) -> (HashMap<std::sync::Arc<str>, pom_engine::modstore::types::ScalarValue>, HashMap<std::sync::Arc<str>, pom_engine::modstore::types::ScalarValue>) {
    use pom_engine::modstore::types::ScalarValue as S;
    use pom_engine::fxhash::HashSet;
    let mut conds: HashSet<&'static str> = HashSet::default();
    let flag_cond = |ty: &str| -> Option<&'static str> {
        match weapon_type_info(ty)?.flag.as_str() {
            "Axe" => Some("UsingAxe"),
            "Sword" => Some("UsingSword"),
            "Dagger" => Some("UsingDagger"),
            "Mace" => Some("UsingMace"),
            "Claw" => Some("UsingClaw"),
            _ => None,
        }
    };
    let all = ["UsingAxe", "UsingSword", "UsingDagger", "UsingMace", "UsingClaw"];
    let build = |slot: &str, ty: Option<String>, conds: &mut HashSet<&'static str>| -> HashMap<std::sync::Arc<str>, S> {
        let mut m: HashMap<std::sync::Arc<str>, S> = HashMap::default();
        let Some(ty) = ty else { return m };
        if let Some(c) = flag_cond(&ty) {
            conds.insert(c);
        }
        if !item_types.counts_as_all_1h(slot) {
            return m;
        }
        let name = weapon_data.get(slot).and_then(|w| w.first()).and_then(|v| v.get("name")).and_then(|n| n.as_str()).unwrap_or("");
        m.insert("countsAsAll1H".into(), S::Bool(true));
        for c in all {
            let added = if c == "UsingSword" { name.contains("Varunastra") || !conds.contains(c) } else { !conds.contains(c) };
            m.insert(format!("Added{c}").into(), S::Bool(added));
            conds.insert(c);
        }
        m
    };
    let w1_ty = item_types.weapon1_type(item_slots, |t| weapon_type_info(t).is_some());
    let w1 = build("Weapon 1", if w1_ty == "None" { None } else { Some(w1_ty) }, &mut conds);
    let w2_ty = item_types.weapon2_type(item_slots, |t| weapon_type_info(t).is_some());
    let w2 = build("Weapon 2", w2_ty, &mut conds);
    (w1, w2)
}
