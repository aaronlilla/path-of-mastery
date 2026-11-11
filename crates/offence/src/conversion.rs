// Port of Modules/CalcOffence.lua: buildConversionTable (1938-1996), calcDamage (70-141),
// calcAilmentSourceDamage (143-154). The damage-conversion/combine kernel: pure functions of a
// skillModList (ModStore) + skillCfg (Cfg) + a per-pass `output` map already holding each damage
// type's `<Type>MinBase`/`<Type>MaxBase` (set by the weapon/skill base-damage assignment step,
// CalcOffence.lua's passList loop - NOT ported yet). Grading this module reads
// those two Base fields straight out of the recording (they're real `output` table fields
// once set, so they survive into the recorded `outputAfter`/`mainHandOutput`/`offHandOutput`
// snapshots) rather than computing them - a legitimate isolation test of this kernel alone.
use crate::area::round;
use crate::bd;
use crate::sf;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

pub const DMG_TYPES: [&str; 5] = ["Physical", "Lightning", "Cold", "Fire", "Chaos"];
const IS_ELEMENTAL: [&str; 3] = ["Fire", "Cold", "Lightning"];

fn is_elemental(t: &str) -> bool {
    IS_ELEMENTAL.contains(&t)
}

/// One entry of `activeSkill.conversionTable[damageType]`: `conversion`/`gain` per destination
/// type (as fractions, e.g. 0.5 for 50%), the combined `<type>` fraction (conversion+gain) used
/// only for the Lua's per-destination breakdown text (not reproduced here - no gradable output
/// field reads it), and `mult` (the fraction of this type's damage that stays as itself, i.e.
/// `1 - min(total converted, 1)`).
#[derive(Clone, Debug, Default)]
pub struct DmgTableEntry {
    pub conversion: HashMap<&'static str, f64>,
    pub gain: HashMap<&'static str, f64>,
    /// `dmgTable[type] = (conversion + add[type]) / 100` (CalcOffence.lua:1980): conversion and
    /// gain-as combined, which is what `calcDamage` reads (`conversionTable[otherType][damageType]`).
    pub total: HashMap<&'static str, f64>,
    pub mult: f64,
}

pub struct ConversionTable(pub HashMap<&'static str, DmgTableEntry>);

impl ConversionTable {
    pub fn get(&self, t: &str) -> &DmgTableEntry {
        self.0.get(t).unwrap_or_else(|| panic!("conversionTable missing damage type {t}"))
    }
}

/// `buildConversionTable(cfg)` (CalcOffence.lua:1938-1987).
pub fn build_conversion_table(skill_mod_list: &ModStore, cfg: Option<&Cfg>) -> ConversionTable {
    let mut table = HashMap::default();
    for damage_type_index in 0..4 {
        let damage_type = DMG_TYPES[damage_type_index];
        let mut global_conv: HashMap<&'static str, f64> = HashMap::default();
        let mut skill_conv: HashMap<&'static str, f64> = HashMap::default();
        let mut add: HashMap<&'static str, f64> = HashMap::default();
        let mut global_total = 0.0;
        let mut skill_total = 0.0;
        for other_type in DMG_TYPES.iter().skip(damage_type_index + 1) {
            let mut names = vec![format!("{damage_type}DamageConvertTo{other_type}")];
            if is_elemental(damage_type) {
                names.push(format!("ElementalDamageConvertTo{other_type}"));
            }
            if damage_type != "Chaos" {
                names.push(format!("NonChaosDamageConvertTo{other_type}"));
            }
            let syms: Vec<Sym> = names.iter().map(|s| Sym::new(s)).collect();
            let gc = skill_mod_list.sum(ModType::Base, cfg, &syms).max(0.0);
            global_conv.insert(other_type, gc);
            global_total += gc;

            let sc_sym = [Sym::new(&format!("Skill{damage_type}DamageConvertTo{other_type}"))];
            let sc = skill_mod_list.sum(ModType::Base, cfg, &sc_sym).max(0.0);
            skill_conv.insert(other_type, sc);
            skill_total += sc;

            let mut add_names = vec![format!("{damage_type}DamageGainAs{other_type}")];
            if is_elemental(damage_type) {
                add_names.push(format!("ElementalDamageGainAs{other_type}"));
            }
            if damage_type != "Chaos" {
                add_names.push(format!("NonChaosDamageGainAs{other_type}"));
            }
            let add_syms: Vec<Sym> = add_names.iter().map(|s| Sym::new(s)).collect();
            let a = skill_mod_list.sum(ModType::Base, cfg, &add_syms).max(0.0);
            if pom_engine::env::var("POM_DEBUG_GAIN").is_ok() {
                for (v, m) in skill_mod_list.tabulate(Some(ModType::Base), cfg, &add_syms) {
                    let m = unsafe { &*m };
                    eprintln!("GAIN {damage_type}->{other_type} {:?} {} {}", v, m.name.as_str(), m.source.as_deref().unwrap_or("nil"));
                }
            }
            add.insert(other_type, a);
        }
        if skill_total > 100.0 {
            let factor = 100.0 / skill_total;
            for v in skill_conv.values_mut() {
                *v *= factor;
            }
            for v in global_conv.values_mut() {
                *v = 0.0;
            }
        } else if global_total + skill_total > 100.0 {
            let factor = (100.0 - skill_total) / global_total;
            for v in global_conv.values_mut() {
                *v *= factor;
            }
        }
        let mut entry = DmgTableEntry::default();
        let mut converted_total = 0.0;
        for (&t, &gv) in global_conv.iter() {
            let conversion = round(gv + skill_conv[t]);
            entry.conversion.insert(t, conversion / 100.0);
            entry.gain.insert(t, add[t] / 100.0);
            entry.total.insert(t, (conversion + add[t]) / 100.0);
            converted_total += conversion;
        }
        entry.mult = 1.0 - (converted_total / 100.0).min(1.0);
        if pom_engine::env::var("POM_DEBUG_CT").is_ok() {
            let mut g: Vec<String> = entry.gain.iter().map(|(k, v)| format!("{k}={v}")).collect();
            g.sort();
            let mut c: Vec<String> = entry.conversion.iter().map(|(k, v)| format!("{k}={v}")).collect();
            c.sort();
            eprintln!("CT {damage_type} gain[{}] conv[{}] mult={}", g.join(","), c.join(","), entry.mult);
        }
        table.insert(damage_type, entry);
    }
    table.insert("Chaos", DmgTableEntry { mult: 1.0, ..Default::default() });
    ConversionTable(table)
}

/// The `typeFlags` bitmask calcDamage threads through recursion (CalcOffence.lua:35-45): which
/// damage-type-specific `<Type>Damage` modifier names apply to the current combine, accumulated
/// as conversions recurse (`bor(typeFlags, dmgTypeFlags.flags[damageType])`).
#[derive(Copy, Clone, Default)]
pub struct DmgTypeFlags(pub u32);
impl DmgTypeFlags {
    pub fn flag_for(t: &str) -> u32 {
        match t {
            "Physical" => 0x01,
            "Lightning" => 0x02,
            "Cold" => 0x04,
            "Fire" => 0x08,
            "Elemental" => 0x0E,
            "Chaos" => 0x10,
            _ => 0,
        }
    }
    pub fn with(self, t: &str) -> DmgTypeFlags {
        DmgTypeFlags(self.0 | Self::flag_for(t))
    }
    /// `damageStatsForTypes[k]` (CalcOffence.lua:53-63): "Damage" plus every `<Type>Damage` whose
    /// flag bit is set, walked in `dmgTypeFlags.order` (Physical, Lightning, Cold, Fire,
    /// Elemental, Chaos).
    pub fn mod_names(self) -> Vec<String> {
        let mut names = vec!["Damage".to_string()];
        for t in ["Physical", "Lightning", "Cold", "Fire", "Elemental", "Chaos"] {
            if self.0 & Self::flag_for(t) != 0 {
                names.push(format!("{t}Damage"));
            }
        }
        names
    }
}

/// `calcDamage(activeSkill, output, cfg, breakdown, damageType, typeFlags, convDst)`
/// (CalcOffence.lua:70-141). `output` is the per-pass output map (`output.MainHand`/`OffHand` for
/// an attack, or the actor's own top-level output for a spell/DoT skill) holding
/// `<Type>MinBase`/`<Type>MaxBase`; `conv_dst` is `Some` only for the internal recursive
/// conversion-source calls (never at the top-level call site), matching the Lua's `convDst`
/// parameter. Returns `(min, max)`, rounded to whole numbers only when `conv_dst` is `None`
/// (converted intermediate amounts stay fractional, exactly as the Lua comment says).
#[allow(clippy::too_many_arguments)]
pub fn calc_damage(
    skill_mod_list: &ModStore,
    output: &HashMap<String, f64>,
    cfg: Option<&Cfg>,
    conversion_table: &ConversionTable,
    damage_type: &str,
    type_flags: DmgTypeFlags,
    conv_dst: Option<&str>,
    bd_key: Option<&str>,
) -> (f64, f64) {
    let type_flags = type_flags.with(damage_type);

    let mut add_min = 0.0;
    let mut add_max = 0.0;
    for other_type in DMG_TYPES {
        if other_type == damage_type {
            break;
        }
        let conv_mult = conversion_table.get(other_type).total.get(damage_type).copied().unwrap_or(0.0);
        if conv_mult > 0.0 {
            let (min, max) = calc_damage(skill_mod_list, output, cfg, conversion_table, other_type, type_flags, Some(damage_type), bd_key);
            add_min += min * conv_mult;
            add_max += max * conv_mult;
        }
    }
    let base_min = *output.get(&format!("{damage_type}MinBase")).unwrap_or(&0.0);
    let base_max = *output.get(&format!("{damage_type}MaxBase")).unwrap_or(&0.0);
    if base_min == 0.0 && base_max == 0.0 {
        // No base damage for this type, don't need to calculate modifiers
        if let Some(key) = bd_key {
            if add_min != 0.0 || add_max != 0.0 {
                let total = format!("{} to {}", bd::tostr(round(add_min)), bd::tostr(round(add_max)));
                let mut fields = vec![("source", bd::s(damage_type)), ("convSrc", bd::s(total.clone())), ("total", bd::s(total))];
                if let Some(cd) = conv_dst {
                    let e = conversion_table.get(damage_type);
                    fields.push(("convDst", bd::s(sf!("%d%% to %s", e.conversion.get(cd).copied().unwrap_or(0.0) * 100.0, cd))));
                    fields.push(("gainDst", bd::s(sf!("%d%% gained as %s", e.gain.get(cd).copied().unwrap_or(0.0) * 100.0, cd))));
                }
                bd::cur(|b| bd::ins(bd::t(bd::t(b, key), "damageTypes"), bd::row(fields)));
            }
        }
        return if conv_dst.is_some() { (add_min, add_max) } else { (round(add_min), round(add_max)) };
    }

    let mod_names = type_flags.mod_names();
    let syms: Vec<Sym> = mod_names.iter().map(|s| Sym::new(s)).collect();
    let inc = 1.0 + skill_mod_list.sum(ModType::Inc, cfg, &syms) / 100.0;
    let more = skill_mod_list.more(cfg, &syms);
    let generic_more_min = skill_mod_list.more(cfg, &[pom_engine::sym!("MinDamage")]);
    let generic_more_max = skill_mod_list.more(cfg, &[pom_engine::sym!("MaxDamage")]);
    let more_min_damage = skill_mod_list.more(cfg, &[Sym::new(&format!("Min{damage_type}Damage"))]);
    let more_max_damage = skill_mod_list.more(cfg, &[Sym::new(&format!("Max{damage_type}Damage"))]);
    let inc_min_damage = 1.0 + skill_mod_list.sum(ModType::Inc, cfg, &[Sym::new(&format!("Min{damage_type}Damage"))]) / 100.0;
    let inc_max_damage = 1.0 + skill_mod_list.sum(ModType::Inc, cfg, &[Sym::new(&format!("Max{damage_type}Damage"))]) / 100.0;

    if pom_engine::env::var("POM_DEBUG_CALCDMG").is_ok() {
        let mut lines: Vec<String> = Vec::new();
        for (ty, tn) in [(ModType::More, "MORE"), (ModType::Inc, "INC")] {
            for (v, m) in skill_mod_list.tabulate(Some(ty), cfg, &syms) {
                let m = unsafe { &*m };
                lines.push(format!("{tn} {:?} {} {}", v, m.name.as_str(), m.source.as_deref().unwrap_or("nil")));
            }
        }
        eprintln!("CALCDMG {damage_type} conv={} base={base_min} inc={inc} more={more} gmin={generic_more_min} :: {}", conv_dst.is_some(), lines.join(" | "));
    }
    if let Some(key) = bd_key {
        if bd::on() {
            let e = conversion_table.get(damage_type);
            let mut fields = vec![
                ("source", bd::s(damage_type)),
                ("base", bd::s(format!("{} to {}", bd::tostr(base_min), bd::tostr(base_max)))),
                ("inc", bd::opt_s((inc != 1.0).then(|| format!("x {}", bd::tostr(inc))))),
                ("more", bd::opt_s((more != 1.0).then(|| format!("x {}", bd::tostr(more))))),
                ("convSrc", bd::opt_s((add_min != 0.0 || add_max != 0.0).then(|| format!("{} to {}", bd::tostr(round(add_min)), bd::tostr(round(add_max)))))),
                ("total", bd::s(format!("{} to {}", bd::tostr(round(base_min * inc * more + add_min)), bd::tostr(round(base_max * inc * more + add_max))))),
            ];
            if let Some(cd) = conv_dst {
                let c = e.conversion.get(cd).copied().unwrap_or(0.0);
                let g = e.gain.get(cd).copied().unwrap_or(0.0);
                fields.push(("convDst", bd::opt_s((c > 0.0).then(|| sf!("%d%% to %s", c * 100.0, cd)))));
                fields.push(("gainDst", bd::opt_s((g > 0.0).then(|| sf!("%d%% gained as %s", g * 100.0, cd)))));
            }
            bd::cur(|b| bd::ins(bd::t(bd::t(b, key), "damageTypes"), bd::row(fields)));
        }
    }
    let min = ((base_min * inc * more) * generic_more_min + add_min) * more_min_damage * inc_min_damage;
    let max = ((base_max * inc * more) * generic_more_max + add_max) * more_max_damage * inc_max_damage;
    if conv_dst.is_some() {
        (min, max)
    } else {
        (round(min), round(max))
    }
}

/// `calcAilmentSourceDamage(activeSkill, output, cfg, breakdown, damageType, typeFlags)`
/// (CalcOffence.lua:143-154): the full (pre-conversion-loss) hit damage of `damageType`, used as
/// an ailment's source-damage base. `min(damageType) * conversionTable[damageType].mult`.
pub fn calc_ailment_source_damage(
    skill_mod_list: &ModStore,
    output: &HashMap<String, f64>,
    cfg: Option<&Cfg>,
    conversion_table: &ConversionTable,
    damage_type: &str,
    type_flags: DmgTypeFlags,
    bd_key: Option<&str>,
) -> (f64, f64) {
    let (min, max) = calc_damage(skill_mod_list, output, cfg, conversion_table, damage_type, type_flags, None, bd_key);
    let conv_mult = conversion_table.get(damage_type).mult;
    if let Some(key) = bd_key {
        if conv_mult != 1.0 {
            bd::cur(|b| {
                let t = bd::t(b, key);
                bd::ins_s(t, "Source damage:");
                bd::ins_s(t, sf!("%d to %d ^8(total damage)", min, max));
                bd::ins_s(t, sf!("x %g ^8(%g%% converted to other damage types)", conv_mult, (1.0 - conv_mult) * 100.0));
                bd::ins_s(t, sf!("= %d to %d", min * conv_mult, max * conv_mult));
            });
        }
    }
    (min * conv_mult, max * conv_mult)
}
