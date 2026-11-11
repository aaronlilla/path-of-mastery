//! `output.SelfHitDamage` (CalcOffence.lua:5959-6099) and `calcs.applyDmgTakenConversion` (CalcDefence.lua:84).
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_engine::fxhash::HashMap;
use pom_offence::sf;

const TYPES: [&str; 5] = ["Physical", "Lightning", "Cold", "Fire", "Chaos"];

fn sy(s: &str) -> Sym {
    Sym::new(s)
}
fn syms(v: &[String]) -> Vec<Sym> {
    v.iter().map(|s| sy(s)).collect()
}
fn round0(x: f64) -> f64 {
    (x + 0.5).floor()
}
fn title(s: &str) -> String {
    // string.gsub(" "..s, "%W%l", upper):sub(2): uppercases each lowercase letter after a non-alphanumeric
    let mut out = String::new();
    let mut prev = ' ';
    for c in s.chars() {
        if !prev.is_alphanumeric() && c.is_ascii_lowercase() {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
        prev = c;
    }
    out
}

/// Boneshatter of Complex Trauma loses all Trauma on reaching `max` (Multiplier:TraumaStacksMax), so the self-damage never scales past it.
/// No max stat (vanilla Boneshatter, Carnage) stays uncapped; upstream never caps.
pub fn trauma_self_stacks(stacks: f64, max: f64) -> f64 {
    if max > 0.0 && pom_offence::data::pom_fixes_on() { stacks.min(max) } else { stacks }
}

fn apply_dmg_taken_conversion(sml: &ModStore, out: &HashMap<String, f64>, source: &str, base: f64, lines: &mut Vec<String>) -> f64 {
    let bd_on = pom_offence::bd::on();
    let o = |k: &str| out.get(k).copied();
    let elemental = matches!(source, "Fire" | "Cold" | "Lightning");
    let mut shift = [0.0f64; 5];
    let mut total_as = 0.0;
    for (i, t) in TYPES.iter().enumerate() {
        let mut names = vec![format!("{source}DamageTakenAs{t}"), format!("{source}DamageFromHitsTakenAs{t}")];
        if elemental {
            names.push(format!("ElementalDamageTakenAs{t}"));
            names.push(format!("ElementalDamageFromHitsTakenAs{t}"));
        }
        shift[i] = sml.sum(ModType::Base, None, &syms(&names));
        total_as += shift[i];
    }
    let mut total = 0.0;
    for (i, t) in TYPES.iter().enumerate() {
        let taken_as = if *t == source { (1.0 - total_as / 100.0).max(0.0) } else { shift[i] / 100.0 };
        if taken_as == 0.0 {
            continue;
        }
        let damage = base * taken_as;
        let names = syms(&["DamageTaken".to_string(), format!("{t}DamageTaken"), "DamageTakenWhenHit".to_string(), format!("{t}DamageTakenWhenHit")]);
        let mut inc = sml.sum(ModType::Inc, None, &names);
        let mut more = sml.more(None, &names);
        if matches!(*t, "Lightning" | "Cold" | "Fire") {
            let en = [sy("ElementalDamageTaken"), sy("ElementalDamageTakenWhenHit")];
            inc += sml.sum(ModType::Inc, None, &en);
            more *= sml.more(None, &en);
        }
        let taken_mods = ((1.0 + inc / 100.0) * more).max(0.0);
        let reduction = if sml.flag(None, &[sy(&format!("SelfIgnoreBase{t}DamageReduction"))]) {
            0.0
        } else {
            o(&format!("Base{t}DamageReductionWhenHit")).or_else(|| o(&format!("Base{t}DamageReduction"))).unwrap_or(0.0)
        };
        let resist = if sml.flag(None, &[sy(&format!("SelfIgnore{t}Resistance"))]) {
            0.0
        } else {
            o(&format!("{t}ResistWhenHit")).or_else(|| o(&format!("{t}Resist"))).unwrap_or(0.0)
        };
        let res_mult = 1.0 - resist / 100.0;
        let pct_armour = (if !sml.flag(None, &[sy(&format!("ArmourDoesNotApplyTo{t}DamageTaken"))]) { sml.sum(ModType::Base, None, &[sy(&format!("ArmourAppliesTo{t}DamageTaken"))]) } else { 0.0 }).min(100.0);
        let ward_based = *t == "Physical" && sml.flag(None, &[sy("PhysicalReductionBasedOnWard")]);
        let dr_max = o("DamageReductionMax").unwrap_or(0.0);
        let mut armour_reduct = 0.0;
        if pct_armour > 0.0 || ward_based {
            let mut eff_armour = (o("Armour").unwrap_or(0.0) * pct_armour / 100.0) * (1.0 + o("ArmourDefense").unwrap_or(0.0));
            if ward_based {
                let m = sml.override_(None, &[sy("PhysicalReductionBasedOnWardPercent")]).and_then(|v| v.num()).unwrap_or(0.0) / 100.0;
                eff_armour = o("Ward").unwrap_or(0.0) * m;
            }
            let eff_damage = damage * res_mult;
            armour_reduct = round0(if eff_armour != 0.0 && damage * res_mult != 0.0 { eff_armour / (eff_armour + eff_damage * 5.0) * 100.0 } else { 0.0 });
            armour_reduct = dr_max.min(armour_reduct);
        }
        let reduct_mult = (1.0 - (dr_max.min(armour_reduct + reduction)).max(0.0) / 100.0) * taken_mods;
        total += damage * (res_mult * reduct_mult);
        if bd_on {
            // CalcDefence.lua:155-164
            let combined = res_mult * reduct_mult;
            lines.push(format!("{t} Damage Taken"));
            if taken_as != 1.0 {
                lines.push(sf!("^8=^7 %d^8 (Base Damage)^7 * %.2f^8 (Damage taken as %s)", base, taken_as, *t));
            }
            if combined != 1.0 {
                lines.push(sf!("^8=^7 %d^8 (%s Damage)^7 * %.4f^8 (Damage taken multi)", damage, *t, combined));
            }
            lines.push(sf!("^8=^7 %d^8 (%s Damage taken)", damage * combined, *t));
            lines.push(String::new());
        }
    }
    total
}

/// Total `SelfHitDamage` (None when no source applied). `out` is the player's output.
pub fn self_hit_damage(sml: &ModStore, mod_db: &ModStore, out: &HashMap<String, f64>, skill_name: &str, skill_is_ignite: bool, skill_cfg: &pom_engine::modstore::types::Cfg) -> Option<f64> {
    let o = |k: &str| out.get(k).copied();
    let mut total: Option<f64> = None;
    let mut add = |v: f64| total = Some(total.unwrap_or(0.0) + v);
    let bd_on = pom_offence::bd::on();
    // CalcOffence.lua:6091-6100: each handler's lines, a "" after each, the last "" removed.
    let mut parts: Vec<Vec<String>> = Vec::new();
    let mut part = |header: String, mut lines: Vec<String>, footer: String| {
        let mut v = vec![header, String::new()];
        v.append(&mut lines);
        v.push(footer);
        parts.push(v);
    };
    let list_ty = |v: &Value| match v.get(sy("damageType")) {
        Value::Str(s) => title(s),
        _ => String::new(),
    };
    let base_dmg = |v: &Value| v.get(sy("baseDamage")).num();
    let dmg_mult = |v: &Value| v.get(sy("dmgMult")).num();
    // Heartbound Loop
    if skill_name == "Summon Skeletons" {
        let (mut ty, mut val) = (None, None::<f64>);
        for v in sml.list(None, &[sy("HeartboundLoopSelfDamage")]) {
            val = Some(val.unwrap_or(0.0) + base_dmg(&v).unwrap_or(0.0));
            ty = Some(list_ty(&v));
        }
        if let (Some(t), Some(d)) = (ty, val) {
            let mut lines = Vec::new();
            let tot = apply_dmg_taken_conversion(sml, out, &t, d, &mut lines);
            let per = o("SummonedMinionsPerCast").unwrap_or(0.0);
            add(tot * per);
            if bd_on {
                part(sf!("Heartbound Loop base damage: %d", d), lines, sf!("Total Heartbound Loop damage taken per cast/attack: %.2f * %d ^8(minions per cast)^7 = %.2f", tot, per, tot * per));
            }
        }
    }
    // Storm Secret
    if skill_name == "Herald of Thunder" {
        let (mut ty, mut val) = (None, None::<f64>);
        for v in sml.list(None, &[sy("StormSecretSelfDamage")]) {
            val = Some(val.unwrap_or(0.0) + base_dmg(&v).unwrap_or(0.0));
            ty = Some(list_ty(&v));
        }
        if let (Some(t), Some(d)) = (ty, val) {
            let mut lines = Vec::new();
            let tot = apply_dmg_taken_conversion(sml, out, &t, d, &mut lines);
            add(tot);
            if bd_on {
                part(sf!("Storm Secret base damage: %d", d), lines, sf!("Total Storm Secret damage taken per Herald of Thunder Hit: %.2f", tot));
            }
        }
    }
    // Eye of Innocence
    if let Some(v) = sml.list(None, &[sy("EyeOfInnocenceSelfDamage")]).first() {
        if skill_is_ignite {
            if let Some(d) = base_dmg(v) {
                let mut lines = Vec::new();
                let tot = apply_dmg_taken_conversion(sml, out, &list_ty(v), d, &mut lines);
                add(tot);
                if bd_on {
                    part(sf!("Eye of Innocence base damage: %d", d), lines, sf!("Total Eye of Innocence damage taken per cast/attack: %.2f ", tot));
                }
            }
        }
    }
    // Echoes of Creation
    if let Some(v) = sml.list(None, &[sy("EchoesOfCreationSelfDamage")]).first() {
        if let (Some(m), Some(g)) = (dmg_mult(v), o("GlobalWarcryUptimeRatio")) {
            let mut count = g / 100.0;
            if sml.flag(None, &[sy("Condition:WarcryMaxHit")]) {
                count = mod_db.sum(ModType::Base, None, &[sy("Multiplier:ExertingWarcryCount")]);
            }
            let life = o("Life").unwrap_or(0.0);
            let mut lines = Vec::new();
            let tot = apply_dmg_taken_conversion(sml, out, &list_ty(v), life * m / 100.0 * count, &mut lines);
            add(tot);
            if bd_on {
                part(sf!("Echoes of Creation base damage: %d ^8(Life)^7 * %d%% * %.2f ^8(Avg. Warcry Count)^7 = %.2f", life, m, count, life * m / 100.0 * count), lines, sf!("Total Echoes of Creation damage taken per Attack: %.2f ", tot));
            }
        }
    }
    // Scold's Bridle
    if let Some(v) = sml.list(None, &[sy("ScoldsBridleSelfDamage")]).first() {
        if let (true, Some(m)) = (o("ManaHasCost").map_or(false, |x| x != 0.0), dmg_mult(v)) {
            let mana = o("ManaCost").unwrap_or(0.0);
            let mut lines = Vec::new();
            let tot = apply_dmg_taken_conversion(sml, out, &list_ty(v), mana * m / 100.0, &mut lines);
            add(tot);
            if bd_on {
                part(sf!("Scold's Bridle base damage: %d ^8(Mana Cost)^7 * %d%% = %.2f", mana, m, mana * m / 100.0), lines, sf!("Total Scold's Bridle damage taken per cast/attack: %.2f ", tot));
            }
        }
    }
    // Trauma
    if sml.flag(None, &[sy("HasTrauma")]) {
        let stacks = trauma_self_stacks(sml.sum(ModType::Base, None, &[sy("Multiplier:TraumaStacks")]).max(1.0), sml.sum(ModType::Base, None, &[sy("Multiplier:TraumaStacksMax")]));
        let per = sml.sum(ModType::Base, None, &[sy("TraumaSelfDamageTakenLife")]);
        let mut lines = Vec::new();
        let tot = apply_dmg_taken_conversion(sml, out, "Physical", per * stacks, &mut lines);
        add(tot);
        if bd_on {
            let kind = if sml.sum(ModType::Base, Some(skill_cfg), &[sy("Multiplier:SustainableTraumaStacks")]) == stacks { "sustainable" } else { "current" };
            part(sf!("%d ^8(base %s damage)^7 * %.2f ^8(%s trauma)^7 = %.2f %s damage", per, "Physical", stacks, kind, per * stacks, "Physical"), lines, sf!("Total Trauma damage taken per cast/attack: %.2f ", tot));
        }
    }
    // Enmity's Embrace
    {
        let (mut ty, mut val) = (None, None::<f64>);
        for v in sml.list(None, &[sy("EnmitysEmbraceSelfDamage")]) {
            val = Some(val.unwrap_or(0.0) + base_dmg(&v).unwrap_or(0.0));
            ty = Some(list_ty(&v));
        }
        if let (Some(t), Some(d)) = (ty, val) {
            let mut lines = Vec::new();
            let tot = apply_dmg_taken_conversion(sml, out, &t, d, &mut lines);
            add(tot);
            if bd_on {
                part(sf!("Enmity's Embrace base damage: %d", d), lines, sf!("Total Enmity's Embrace damage taken per cast/attack: %.2f ", tot));
            }
        }
    }
    // Forbidden Rite: CalcOffence.lua:6088 loops `ipairs({["FRDamageTaken"] = "Forbidden Rite"})`, a table with only a
    // string key, so the loop body never runs and `FRDamageTaken` never reaches `SelfHitDamage` in upstream.
    if bd_on && !parts.is_empty() {
        pom_offence::bd::set_pass(None);
        let mut t = serde_json::Value::Array(vec![]);
        let n = parts.len();
        for (i, p) in parts.into_iter().enumerate() {
            for l in p {
                pom_offence::bd::ins_s(&mut t, l);
            }
            if i + 1 < n {
                pom_offence::bd::ins_s(&mut t, "");
            }
        }
        pom_offence::bd::cur(|b| pom_offence::bd::set(b, "SelfHitDamage", t));
    }
    total
}
