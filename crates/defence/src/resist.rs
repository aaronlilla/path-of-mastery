//! Port of `calcs.resistances(actor)` (Modules/CalcDefence.lua lines 512-648).
use crate::data::misc;
use crate::tools::mod_;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;

const RESIST_TYPES: &[&str] = &["Fire", "Cold", "Lightning", "Chaos"];
fn is_elemental(e: &str) -> bool {
    matches!(e, "Fire" | "Cold" | "Lightning")
}

/// `modDB:Sum("BASE", nil, name, isElemental[elem] and "ElementalX")`: the Lua passes a `false`
/// extra name when the elemental alias does not apply, which is simply "no second name" to Sum.
fn sum_elem(store: &ModStore, ty: ModType, base: &str, elem_alias: Option<&str>) -> f64 {
    let mut names = vec![Sym::new(base)];
    if let Some(a) = elem_alias {
        names.push(Sym::new(a));
    }
    store.sum(ty, None, &names)
}

pub fn resistances(store: &mut ModStore, output: &mut HashMap<String, f64>) {
    output.insert("PhysicalResist".into(), 0.0);

    // Max-resistance conversion pass.
    for &res_from in RESIST_TYPES {
        let mut max_res: Option<f64> = None;
        for &res_to in RESIST_TYPES {
            let conv = store.sum(ModType::Base, None, &[Sym::new(&format!("{res_from}MaxResConvertTo{res_to}"))]) / 100.0;
            if conv != 0.0 {
                let max_res = *max_res.get_or_insert_with(|| {
                    store
                        .tabulate(Some(ModType::Base), None, &[Sym::new(&format!("{res_from}ResistMax"))])
                        .into_iter()
                        .filter_map(|(v, m)| {
                            let src = unsafe { (*m).source.clone() };
                            if src.as_deref() != Some("Base") { v.num() } else { None }
                        })
                        .sum::<f64>()
                });
                if max_res != 0.0 {
                    store.add_mod(crate::modbuild::m(
                        &format!("{res_to}ResistMax"),
                        ModType::Base,
                        max_res * conv,
                        &format!("{res_from} To {res_to} Max Resistance Conversion"),
                    ));
                }
            }
        }
    }

    // Resistance (INC/MORE/BASE) conversion pass.
    for &res_from in RESIST_TYPES {
        let mut res: Option<f64> = None;
        for &res_to in RESIST_TYPES {
            let conv = store.sum(ModType::Base, None, &[Sym::new(&format!("{res_from}ResConvertTo{res_to}"))]) / 100.0;
            if conv != 0.0 {
                let res_val = *res.get_or_insert_with(|| {
                    store
                        .tabulate(Some(ModType::Base), None, &[Sym::new(&format!("{res_from}Resist"))])
                        .into_iter()
                        .filter_map(|(v, m)| {
                            let src = unsafe { (*m).source.clone() };
                            if src.as_deref() != Some("Base") { v.num() } else { None }
                        })
                        .sum::<f64>()
                });
                if res_val != 0.0 {
                    store.add_mod(crate::modbuild::m(
                        &format!("{res_to}Resist"),
                        ModType::Base,
                        res_val * conv,
                        &format!("{res_from} To {res_to} Resistance Conversion"),
                    ));
                }
                let inc_mods: Vec<(f64, Option<std::sync::Arc<str>>)> = store
                    .tabulate(Some(ModType::Inc), None, &[Sym::new(&format!("{res_from}Resist"))])
                    .into_iter()
                    .map(|(v, m)| (v.num().unwrap_or(0.0), unsafe { (*m).source.clone() }))
                    .collect();
                for (val, src) in inc_mods {
                    store.add_mod(crate::modbuild::m(&format!("{res_to}Resist"), ModType::Inc, val * conv, src.as_deref().unwrap_or("")));
                }
                let more_mods: Vec<(f64, Option<std::sync::Arc<str>>)> = store
                    .tabulate(Some(ModType::More), None, &[Sym::new(&format!("{res_from}Resist"))])
                    .into_iter()
                    .map(|(v, m)| (v.num().unwrap_or(0.0), unsafe { (*m).source.clone() }))
                    .collect();
                for (val, src) in more_mods {
                    store.add_mod(crate::modbuild::m(&format!("{res_to}Resist"), ModType::More, val * conv, src.as_deref().unwrap_or("")));
                }
            }
        }
    }

    // Melding of the Flesh.
    if store.flag(None, &[pom_engine::sym!("ElementalResistMaxIsHighestResistMax")]) {
        let mut highest = 0.0;
        let mut highest_type = "";
        for &elem in RESIST_TYPES {
            let resist_max = store
                .override_(None, &[Sym::new(&format!("{elem}ResistMax"))])
                .and_then(|v| v.num())
                .unwrap_or_else(|| misc("MaxResistCap").min(sum_elem(store, ModType::Base, &format!("{elem}ResistMax"), is_elemental(elem).then_some("ElementalResistMax"))));
            if resist_max > highest && is_elemental(elem) {
                highest = resist_max;
                highest_type = elem;
            }
        }
        for &elem in RESIST_TYPES {
            if is_elemental(elem) {
                store.add_mod(crate::modbuild::m(&format!("{elem}ResistMax"), ModType::Override, highest, &format!("{highest_type} Melding of the Flesh")));
            }
        }
    }

    let dot_cfg = Cfg { flags: pom_engine::modparser::flags::mod_flag::Dot, keyword_flags: 0, ..Default::default() };

    for &elem in RESIST_TYPES {
        let elem_alias = is_elemental(elem).then_some("ElementalResistMax");
        let min = misc("ResistFloor");
        let max = store
            .override_(None, &[Sym::new(&format!("{elem}ResistMax"))])
            .and_then(|v| v.num())
            .unwrap_or_else(|| misc("MaxResistCap").min(sum_elem(store, ModType::Base, &format!("{elem}ResistMax"), elem_alias)));
        let totem_alias = is_elemental(elem).then_some("TotemElementalResistMax");
        let totem_max = store
            .override_(None, &[Sym::new(&format!("Totem{elem}ResistMax"))])
            .and_then(|v| v.num())
            .unwrap_or_else(|| misc("MaxResistCap").min(sum_elem(store, ModType::Base, &format!("Totem{elem}ResistMax"), totem_alias)));

        let total_override = store.override_(None, &[Sym::new(&format!("{elem}Resist"))]).and_then(|v| v.num());
        let (mut total, dot_total) = if let Some(t) = total_override {
            (t, None)
        } else {
            let base = sum_elem(store, ModType::Base, &format!("{elem}Resist"), is_elemental(elem).then_some("ElementalResist"));
            let names: Vec<Sym> = if is_elemental(elem) {
                vec![Sym::new(&format!("{elem}Resist")), pom_engine::sym!("ElementalResist")]
            } else {
                vec![Sym::new(&format!("{elem}Resist"))]
            };
            let inc = mod_(store, None, &names).max(0.0);
            let dot_base = store.sum(ModType::Base, Some(&dot_cfg), &names);
            (base * inc, Some(dot_base * inc))
        };

        let totem_total_override = store.override_(None, &[Sym::new(&format!("Totem{elem}Resist"))]).and_then(|v| v.num());
        let mut totem_total = if let Some(t) = totem_total_override {
            t
        } else {
            let base = sum_elem(store, ModType::Base, &format!("Totem{elem}Resist"), is_elemental(elem).then_some("TotemElementalResist"));
            let names: Vec<Sym> = if is_elemental(elem) {
                vec![Sym::new(&format!("Totem{elem}Resist")), pom_engine::sym!("TotemElementalResist")]
            } else {
                vec![Sym::new(&format!("Totem{elem}Resist"))]
            };
            base * mod_(store, None, &names).max(0.0)
        };

        total = total.trunc();
        let dot_total = dot_total.map(|d| d.trunc()).unwrap_or(total);
        totem_total = totem_total.trunc();
        let min = min.trunc();
        let max = max.trunc();
        let totem_max = totem_max.trunc();

        let final_ = total.min(max).max(min);
        let dot_final = dot_total.min(max).max(min);
        let totem_final = totem_total.min(totem_max).max(min);

        output.insert(format!("{elem}Resist"), final_);
        output.insert(format!("{elem}ResistTotal"), total);
        output.insert(format!("{elem}ResistOverCap"), (total - max).max(0.0));
        output.insert(format!("{elem}ResistOver75"), (final_ - 75.0).max(0.0));
        output.insert(format!("Missing{elem}Resist"), (max - final_).max(0.0));
        output.insert(format!("{elem}ResistOverTime"), dot_final);
        output.insert(format!("Totem{elem}Resist"), totem_final);
        output.insert(format!("Totem{elem}ResistTotal"), totem_total);
        output.insert(format!("Totem{elem}ResistOverCap"), (totem_total - totem_max).max(0.0));
        output.insert(format!("MissingTotem{elem}Resist"), (totem_max - totem_final).max(0.0));
        crate::bd_def::resist(elem, min, max, total, totem_max, totem_total);
        // `output` is a live table in upstream: a later resist's PerStat mod (e.g. "+1% to
        // Chaos Resistance per 1% Lightning Resistance") reads `output.LightningResist` mid-loop.
        let mut actor = store.actor.as_deref().cloned().unwrap_or_default();
        for k in ["Resist", "ResistTotal", "ResistOverCap", "ResistOver75", "ResistOverTime"] {
            let key = format!("{elem}{k}");
            if let Some(v) = output.get(&key) {
                actor.output.insert(Sym::new(&key), *v);
            }
        }
        store.actor = Some(std::sync::Arc::new(actor));
    }
}
