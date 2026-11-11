//! Drives `sections.rs`'s ported CalcSections.lua data against one recorded build, producing the
//! exact same JSON shape the recorded answer keys use, so grading can diff the two trees
//! directly. This is this crate's own
//! port of `Classes/CalcSectionControl.lua`'s `DrawContent` visibility/text-selection traversal
//! (section `CheckFlag` gate -> subsection `defaultCollapsed` -> row `CheckFlag` -> cell
//! `CheckFlag` + `formatCalcStr`), with every `Draw*`/`SetDraw*` call stripped out. The traversal
//! has to live in this crate rather than being pure lookup, because which rows render depends on
//! the build's flags.
use crate::checkflag::{check_flag, FlagObj};
use crate::format::{format_calc_str, format_extra, ModRenderCtx};
use crate::record::BreakdownBuild;
use crate::sections::Section;
use serde_json::{json, Value as J};

pub fn render_build(build: &BreakdownBuild, sections: &[Section]) -> J {
    render_build_with(build, sections, false)
}

fn detail_json(d: &crate::sections::Detail) -> J {
    let mut o = serde_json::Map::new();
    if let Some(v) = &d.label {
        o.insert("label".into(), json!(v));
    }
    if let Some(v) = &d.breakdown {
        o.insert("breakdown".into(), json!(v));
    }
    if let Some(v) = &d.mod_name {
        o.insert("modName".into(), json!(v));
    }
    if let Some(v) = &d.mod_type {
        o.insert("modType".into(), json!(v));
    }
    if let Some(v) = &d.cfg {
        o.insert("cfg".into(), json!(v));
    }
    if d.enemy {
        o.insert("enemy".into(), json!(true));
    }
    if let Some(v) = &d.actor {
        o.insert("actor".into(), json!(v));
    }
    if let Some(v) = &d.mod_source {
        o.insert("modSource".into(), json!(v));
    }
    if d.gear_only {
        o.insert("gearOnly".into(), json!(true));
    }
    J::Object(o)
}

/// The cell's entries that pass their own flags (`CalcBreakdownControl:SetBreakdownData`'s `CheckFlag(sectionData)`).
pub fn passing_details<'a>(details: &'a [crate::sections::Detail], skill_flags: &std::collections::HashMap<String, bool>, output: &J) -> Vec<&'a crate::sections::Detail> {
    details
        .iter()
        .filter(|d| {
            let f = FlagObj { flag: d.flag.as_deref(), not_flag: d.not_flag.as_deref(), flag_list: d.flag_list.as_deref(), not_flag_list: d.not_flag_list.as_deref(), player_flag: d.player_flag.as_deref(), have_output: d.have_output.as_deref() };
            check_flag(&f, skill_flags, output)
        })
        .collect()
}

/// `render_build`, and with `with_details` also what the popup needs: each section's width and group, each
/// sub-section's `collapsed` state and, per row, `cellDetails` (the entries a hover on each cell shows).
pub fn render_build_with(build: &BreakdownBuild, sections: &[Section], with_details: bool) -> J {
    let ctx = ModRenderCtx {
        player_store: &build.player_store,
        skill_store: build.skill_mod_list_store.as_deref(),
        enemy_store: build.enemy_store.as_deref(),
        cfgs: &build.cfgs,
    };
    let output = &build.player_output;
    let skill_flags = &build.skill_flags;

    let mut out = Vec::new();
    for section in sections {
        // CalcSectionClass:CalcSectionControl sets `self.flag`/`self.notFlag` from
        // `subSection[1].data.flag`/`.notFlag` (the *first* subsection only).
        let first = &section.sub_sections[0];
        let sec_flag = FlagObj { flag: first.flag.as_deref(), not_flag: first.not_flag.as_deref(), flag_list: None, not_flag_list: None, player_flag: None, have_output: None };
        let sec_enabled = check_flag(&sec_flag, skill_flags, output);

        // `UpdateSize`: a section whose flags pass is still hidden unless at least one of its rows passes theirs, whether or
        // not its sub-section is collapsed.
        let any_row = sec_enabled
            && section.sub_sections.iter().any(|sub| {
                sub.rows.iter().any(|row| {
                    let f = FlagObj { flag: row.flag.as_deref(), not_flag: row.not_flag.as_deref(), flag_list: row.flag_list.as_deref(), not_flag_list: row.not_flag_list.as_deref(), player_flag: row.player_flag.as_deref(), have_output: row.have_output.as_deref() };
                    check_flag(&f, skill_flags, output)
                })
            });
        let mut sub_out = Vec::new();
        for (sub_idx, sub) in section.sub_sections.iter().enumerate() {
            // `subSec.collapsed` starts at `default_collapsed` but a build's saved XML can
            // override it per subsection (see `record::BreakdownBuild::collapsed`'s doc comment);
            // use the recorded live value when we have it.
            let collapsed = build.collapsed.get(&(section.id.clone(), sub_idx)).copied().unwrap_or(sub.default_collapsed);
            let mut extra_text: Option<String> = None;
            let mut rows_out = Vec::new();
            // The header text is drawn whether the sub-section is open or not (CalcSectionControl.lua:459); the recorded
            // answer keys leave it out for a collapsed one, so only the Calcs screen's own render (`with_details`) adds it.
            if sec_enabled && (!collapsed || with_details) {
                if let Some(extra) = &sub.extra {
                    extra_text = Some(format_extra(extra, output, &ctx));
                }
            }
            if sec_enabled && !collapsed {
                for row in &sub.rows {
                    let row_flag = FlagObj {
                        flag: row.flag.as_deref(),
                        not_flag: row.not_flag.as_deref(),
                        flag_list: row.flag_list.as_deref(),
                        not_flag_list: row.not_flag_list.as_deref(),
                        player_flag: row.player_flag.as_deref(),
                        have_output: row.have_output.as_deref(),
                    };
                    if !check_flag(&row_flag, skill_flags, output) {
                        continue;
                    }
                    let mut cells_out = Vec::new();
                    let mut cell_details: Vec<J> = Vec::new();
                    let mut cell_idx: Vec<usize> = Vec::new();
                    for (cell_i, cell) in row.cells.iter().enumerate() {
                        let cell_flag = FlagObj { flag: cell.flag.as_deref(), not_flag: cell.not_flag.as_deref(), flag_list: None, not_flag_list: None, player_flag: None, have_output: cell.have_output.as_deref() };
                        if let Some(fmt) = &cell.format {
                            if check_flag(&cell_flag, skill_flags, output) {
                                cells_out.push(J::String(format_calc_str(fmt, output, &ctx, &cell.details)));
                                if with_details {
                                    cell_idx.push(cell_i);
                                    cell_details.push(J::Array(passing_details(&cell.details, skill_flags, output).into_iter().map(detail_json).collect()));
                                }
                            }
                        }
                    }
                    if with_details {
                        rows_out.push(json!({ "label": row.label, "cells": cells_out, "cellDetails": cell_details, "cellIdx": cell_idx, "cols": row.cells.len(), "bgCol": row.bg_col, "color": row.color, "textSize": row.text_size }));
                    } else {
                        rows_out.push(json!({ "label": row.label, "cells": cells_out }));
                    }
                }
            }
            if with_details {
                // The row with no label whose cells are all plain texts ("Uptime", "Physical:"): the column titles. The
                // original hides it by an output flag (Warcries: CreateWarcryOffensiveCalcSection), so it counts only when its flags pass.
                let columns: J = sub
                    .rows
                    .iter()
                    .find(|r| {
                        r.label.is_none()
                            && !r.cells.is_empty()
                            && r.cells.iter().all(|c| c.format.as_deref().is_some_and(|f| !f.contains('{')))
                            && check_flag(
                                &FlagObj {
                                    flag: r.flag.as_deref(),
                                    not_flag: r.not_flag.as_deref(),
                                    flag_list: r.flag_list.as_deref(),
                                    not_flag_list: r.not_flag_list.as_deref(),
                                    player_flag: r.player_flag.as_deref(),
                                    have_output: r.have_output.as_deref(),
                                },
                                skill_flags,
                                output,
                            )
                    })
                    .map(|r| J::Array(r.cells.iter().map(|c| J::String(c.format.clone().unwrap_or_default())).collect()))
                    .unwrap_or(J::Null);
                sub_out.push(json!({ "label": sub.label, "extra": extra_text, "rows": rows_out, "collapsed": collapsed, "columns": columns }));
            } else {
                sub_out.push(json!({ "label": sub.label, "extra": extra_text, "rows": rows_out }));
            }
        }
        if with_details {
            out.push(json!({ "id": section.id, "enabled": sec_enabled, "shown": any_row, "width": section.width, "group": section.group, "colour": section.colour, "subSections": sub_out }));
        } else {
            out.push(json!({ "id": section.id, "enabled": sec_enabled, "subSections": sub_out }));
        }
    }
    J::Array(out)
}
