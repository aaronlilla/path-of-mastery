//! Port of Data/ModMap.lua's `AffixData` apply functions, dispatched from the 8
//! `MapPrefix1..4` / `MapSuffix1..4` config options via `mapAffixDropDownFunction`
//! (Modules/ConfigOptions.lua, top of file). Out of the nominal ConfigOptions.lua scope, but the
//! actual apply logic for those 8 options lives here, not in ConfigOptions.lua itself.
//!
//! Entries omitted from `Data/ModMap.lua`'s `AffixData` that have no `apply` at all
//! (the ~20 "Abhorrent" / "of Bloodlines" style flavor-only affixes, plus "Punishing", "Mirrored",
//! "of Balance", "of Transience", "of Blinding", whose `apply` bodies are empty) are no-ops here
//! too: `apply_affix` returns without pushing any mod for them.
use crate::ctx::ConfigCtx;
use crate::helpers::{new_mod, tag};
use pom_engine::modifier::ModType;
use pom_engine::modparser::flags::mod_flag;

/// `val` is 1-based (matches Lua's `values[val]`): for "list" affixes it's the selected tier
/// (1..3), for "count" it's `4 - selIndex` (mapModDropDownFunction's roll-range tier index), for
/// "check" it's unused. `roll_range` (0..100) only matters for "count" affixes.
pub fn apply_affix(name: &str, val: f64, roll_range: f64, mod_effect: f64, ctx: &mut ConfigCtx) {
    let v = val as usize;
    match name {
        "Armoured" => {
            let values = [20.0, 30.0, 40.0];
            push_enemy(ctx, "PhysicalDamageReduction", ModType::Base, values[v - 1] * mod_effect, "Map mod Armoured", vec![]);
        }
        "Hexproof" => push_enemy_flag(ctx, "Hexproof", "Map mod Hexproof", vec![]),
        "Hexwarded" => {
            let values = [25.0, 40.0, 60.0];
            push_enemy(ctx, "CurseEffectOnSelf", ModType::More, -values[v - 1] * mod_effect, "Map mod Hexwarded", vec![]);
        }
        "Resistant" => {
            let values = [(20.0, 15.0), (30.0, 20.0), (40.0, 25.0)];
            let (ele, chaos) = values[v - 1];
            push_enemy(ctx, "ElementalResist", ModType::Base, ele * mod_effect, "Map mod Resistant", vec![]);
            push_enemy(ctx, "ChaosResist", ModType::Base, chaos * mod_effect, "Map mod Resistant", vec![]);
        }
        "Unwavering" => {
            let values = [(15.0, 19.0), (20.0, 24.0), (25.0, 30.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "AvoidStun", ModType::Base, 100.0, "Map mod Unwavering", vec![]);
            push_enemy(ctx, "Life", ModType::More, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Unwavering", vec![]);
        }
        "Fecund" => {
            let values = [(20.0, 29.0), (30.0, 39.0), (40.0, 49.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "Life", ModType::More, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Fecund", vec![]);
        }
        "Unstoppable" => push_enemy(ctx, "MinimumActionSpeed", ModType::Max, 100.0, "Map mod Unstoppable", vec![]),
        "Impervious" => {
            let values = [20.0, 35.0, 50.0];
            let dmg = values[v - 1] * mod_effect;
            push_enemy(ctx, "AvoidPoison", ModType::Base, dmg, "Map mod Impervious", vec![]);
            push_enemy(ctx, "AvoidImpale", ModType::Base, dmg, "Map mod Impervious", vec![]);
            push_enemy(ctx, "AvoidBleed", ModType::Base, dmg, "Map mod Impervious", vec![]);
        }
        "Oppressive" => {
            let values = [30.0, 45.0, 60.0];
            push_enemy(ctx, "SpellSuppressionChance", ModType::Base, values[v - 1] * mod_effect, "Map mod Oppressive", vec![]);
        }
        "Buffered" => {
            let values = [(20.0, 29.0), (30.0, 39.0), (40.0, 49.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "LifeGainAsEnergyShield", ModType::Base, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Buffered", vec![]);
        }
        "Titan's" => {
            let values = [(25.0, 45.0), (30.0, 55.0), (35.0, 70.0)];
            let (life, aoe) = values[v - 1];
            let cond = tag("Condition", &[("var", crate::helpers::s("RareOrUnique"))]);
            push_enemy(ctx, "Life", ModType::More, life * mod_effect, "Map mod Titan's", vec![cond.clone()]);
            push_enemy(ctx, "AreaOfEffect", ModType::Inc, aoe * mod_effect, "Map mod Titan's", vec![cond]);
        }
        "Savage" => {
            let values = [(14.0, 17.0), (18.0, 21.0), (22.0, 25.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "Damage", ModType::Inc, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Savage", vec![]);
        }
        "Burning" => {
            let values = [(50.0, 69.0), (70.0, 89.0), (90.0, 110.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "PhysicalDamageGainAsFire", ModType::Base, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Burning", vec![]);
        }
        "Freezing" => {
            let values = [(50.0, 69.0), (70.0, 89.0), (90.0, 110.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "PhysicalDamageGainAsCold", ModType::Base, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Freezing", vec![]);
        }
        "Shocking" => {
            let values = [(50.0, 69.0), (70.0, 89.0), (90.0, 110.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "PhysicalDamageGainAsLightning", ModType::Base, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Shocking", vec![]);
        }
        "Profane" => {
            let values = [(0.0, 0.0), (21.0, 25.0), (31.0, 35.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "PhysicalDamageGainAsChaos", ModType::Base, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Profane", vec![]);
            push_player_flag(ctx, "Condition:CanBeWithered", "Map mod Profane", vec![]);
        }
        "Fleet" => {
            // Attack and cast speed use the same values in upstream, so only that one is applied.
            let values = [(20.0, 25.0), (25.0, 35.0), (35.0, 45.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "Speed", ModType::Inc, (lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod Fleet", vec![]);
        }
        "Conflagrating" => {
            push_enemy(ctx, "IgniteChance", ModType::Base, 100.0, "Map mod Conflagrating", vec![]);
            push_enemy_flag(ctx, "AllDamageIgnites", "Map mod Conflagrating", vec![]);
        }
        "Impaling" => {
            let values = [25.0, 40.0, 60.0];
            let m = new_mod("ImpaleChance", ModType::Base, crate::helpers::n(values[v - 1] * mod_effect), "Map mod Impaling", vec![]);
            let mut m = m;
            m.flags = mod_flag::Attack;
            ctx.enemy.push(m);
        }
        "Empowered" => {
            let values = [0.0, 15.0, 20.0];
            push_enemy(ctx, "ElementalAilmentChance", ModType::Base, values[v - 1] * mod_effect, "Map mod Empowered", vec![]);
        }
        "Overlord's" => {
            let values = [(15.0, 20.0), (20.0, 25.0), (25.0, 30.0)];
            let (dmg, spd) = values[v - 1];
            let cond = tag("Condition", &[("var", crate::helpers::s("RareOrUnique"))]);
            push_enemy(ctx, "Damage", ModType::Inc, dmg * mod_effect, "Map mod Overlord's", vec![cond.clone()]);
            push_enemy(ctx, "Speed", ModType::Inc, spd * mod_effect, "Map mod Overlord's", vec![cond]);
        }
        "Punishing" | "Mirrored" => {} // empty apply body in upstream
        "of Balance" => {} // commented-out mod in upstream
        "of Congealment" => {
            push_enemy_flag(ctx, "CannotLeechLifeFromSelf", "Map mod of Congealment", vec![]);
            push_enemy_flag(ctx, "CannotLeechManaFromSelf", "Map mod of Congealment", vec![]);
            push_enemy_flag(ctx, "CannotLeechEnergyShieldFromSelf", "Map mod of Congealment", vec![]);
        }
        "of Drought" => {
            let values = [30.0, 40.0, 50.0];
            push_player(ctx, "FlaskChargesGained", ModType::Inc, -values[v - 1] * mod_effect, "Map mod of Drought", vec![]);
        }
        "of Exposure" => {
            let values = [(0.0, 0.0), (5.0, 8.0), (9.0, 12.0)];
            let (lo, hi) = values[v - 1];
            if hi != 0.0 {
                let roll = (lo + (hi - lo) * roll_range / 100.0) * mod_effect;
                for stat in ["FireResistMax", "ColdResistMax", "LightningResistMax", "ChaosResistMax"] {
                    push_player(ctx, stat, ModType::Base, -roll, "Map mod of Exposure", vec![]);
                }
            }
        }
        "of Impotence" => {
            let values = [15.0, 20.0, 25.0];
            push_player(ctx, "AreaOfEffect", ModType::More, -values[v - 1] * mod_effect, "Map mod of Impotence", vec![]);
        }
        "of Insulation" => {
            let values = [30.0, 50.0, 70.0];
            push_enemy(ctx, "AvoidElementalAilments", ModType::Base, values[v - 1] * mod_effect, "Map mod of Insulation", vec![]);
        }
        "of Miring" => {
            let values = [(10.0, 30.0), (15.0, 40.0), (20.0, 50.0)];
            let (supp, acc) = values[v - 1];
            push_player(ctx, "SpellSuppressionEffect", ModType::Base, -supp * mod_effect, "Map mod of Miring", vec![]);
            push_enemy(ctx, "Accuracy", ModType::Inc, acc * mod_effect, "Map mod of Miring", vec![]);
        }
        "of Rust" => {
            let values = [(20.0, 20.0), (30.0, 25.0), (40.0, 30.0)];
            let (block, armour) = values[v - 1];
            push_player(ctx, "BlockChance", ModType::Inc, -block * mod_effect, "Map mod of Rust", vec![]);
            push_player(ctx, "Armour", ModType::More, -armour * mod_effect, "Map mod of Rust", vec![]);
        }
        "of Smothering" => {
            let values = [20.0, 40.0, 60.0];
            let v = values[v - 1] * mod_effect;
            push_player(ctx, "LifeRecoveryRate", ModType::More, -v, "Map mod of Smothering", vec![]);
            push_player(ctx, "EnergyShieldRecoveryRate", ModType::More, -v, "Map mod of Smothering", vec![]);
        }
        "of Stasis" => {
            push_player_flag(ctx, "NoLifeRegen", "Map mod of Stasis", vec![]);
            push_player_flag(ctx, "NoEnergyShieldRegen", "Map mod of Stasis", vec![]);
            push_player_flag(ctx, "NoManaRegen", "Map mod of Stasis", vec![]);
        }
        "of Toughness" => {
            let values = [(25.0, 30.0), (31.0, 35.0), (36.0, 40.0)];
            let (lo, hi) = values[v - 1];
            push_enemy(ctx, "SelfCritMultiplier", ModType::Inc, -(lo + (hi - lo) * roll_range / 100.0) * mod_effect, "Map mod of Toughness", vec![]);
        }
        "of Fatigue" => {
            let values = [20.0, 30.0, 40.0];
            push_player(ctx, "CooldownRecovery", ModType::More, -values[v - 1] * mod_effect, "Map mod of Fatigue", vec![]);
        }
        "of Transience" => {} // empty apply body in upstream
        "of Doubt" => {
            let values = [25.0, 40.0, 60.0];
            let m = new_mod(
                "AuraEffect", ModType::Inc, crate::helpers::n(-values[v - 1] * mod_effect), "Map mod of Doubt",
                vec![tag("SkillType", &[("skillType", crate::helpers::n(SKILL_TYPE_AURA))]), tag("SkillType", &[("skillType", crate::helpers::n(SKILL_TYPE_APPLIES_CURSE)), ("neg", crate::helpers::b(true))])],
            );
            ctx.mods.push(m);
        }
        "of Imprecision" => {
            let values = [15.0, 20.0, 25.0];
            push_player(ctx, "Accuracy", ModType::More, -values[v - 1] * mod_effect, "Map mod of Imprecision", vec![]);
        }
        "of Blinding" => {} // no mod in upstream (comment: "SHOULD THIS BE SUPPORTED?")
        "of Venom" => push_enemy(ctx, "PoisonChance", ModType::Base, 100.0, "Map mod of Venom", vec![]),
        "of Deadliness" => {
            let values = [((160.0, 200.0), (30.0, 35.0)), ((260.0, 300.0), (36.0, 40.0)), ((360.0, 400.0), (41.0, 45.0))];
            let ((clo, chi), (mlo, mhi)) = values[v - 1];
            push_enemy(ctx, "CritChance", ModType::Inc, (clo + (chi - clo) * roll_range / 100.0) * mod_effect, "Map mod of Deadliness", vec![]);
            push_enemy(ctx, "CritMultiplier", ModType::Base, (mlo + (mhi - mlo) * roll_range / 100.0) * mod_effect, "Map mod of Deadliness", vec![]);
        }
        _ => {} // the ~20 flavor-only affixes ("Abhorrent", "of Bloodlines", ...) have no `apply` at all
    }
}

// SkillType.Aura / SkillType.AppliesCurse (Data/Global.lua's SkillType enum ids).
const SKILL_TYPE_AURA: f64 = 39.0;
const SKILL_TYPE_APPLIES_CURSE: f64 = 69.0;

fn push_enemy(ctx: &mut ConfigCtx, name: &str, ty: ModType, value: f64, source: &str, tags: Vec<pom_engine::modifier::Tag>) {
    debug_assert!(!matches!(ty, ModType::Flag | ModType::FlagLower), "use push_enemy_flag for {name}");
    ctx.enemy.push(new_mod(name, ty, crate::helpers::n(value), source, tags));
}
fn push_player(ctx: &mut ConfigCtx, name: &str, ty: ModType, value: f64, source: &str, tags: Vec<pom_engine::modifier::Tag>) {
    debug_assert!(!matches!(ty, ModType::Flag | ModType::FlagLower), "use push_player_flag for {name}");
    ctx.mods.push(new_mod(name, ty, crate::helpers::n(value), source, tags));
}
/// FLAG-type mods always carry a boolean `true` value in upstream (`modList:NewMod(name,
/// "FLAG", true, source)`), never a number.
fn push_enemy_flag(ctx: &mut ConfigCtx, name: &str, source: &str, tags: Vec<pom_engine::modifier::Tag>) {
    ctx.enemy.push(new_mod(name, ModType::Flag, crate::helpers::b(true), source, tags));
}
fn push_player_flag(ctx: &mut ConfigCtx, name: &str, source: &str, tags: Vec<pom_engine::modifier::Tag>) {
    ctx.mods.push(new_mod(name, ModType::Flag, crate::helpers::b(true), source, tags));
}
