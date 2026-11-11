//! Node-API addon for the desktop app's engine host (apps/desktop/src/engine-host). It runs on the engine host's
//! JavaScript thread, so the engine's per-thread caches (parsed items, socket groups, mod lines) persist across calls.
//!
//! Every function returns JSON text. A session's stats are kept between calls, so each result carries only the
//! stats that changed: `{"changed": [[statId, before, after], ...], "complete": bool}`.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pom_pipeline::session::Session;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;

mod items;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// The engine version the host reports (`NativeEngineModule.version`).
#[napi]
#[allow(non_upper_case_globals)]
pub const version: &str = env!("CARGO_PKG_VERSION");

struct Open {
    session: Session,
    stats: Map<String, Value>,
    /// Build texts before each committed edit (newest last), and the ones undone.
    undo: Vec<String>,
    redo: Vec<String>,
    /// The running node power calculation (see `node_power_start`).
    power: Option<pom_pipeline::nodepower::PowerRun>,
    /// The running optimize pathing search (see `optimize_start`).
    opt: Option<pom_pipeline::optimizer::OptRun>,
    /// The running timeless jewel search (see `timeless_start`).
    timeless: Option<pom_pipeline::timeless::Run>,
    /// The last answer of each read-only export that runs a calculation of its own (`skills_state`, `config_state`,
    /// `build_flags`), with everything it was computed from (the build text and the call's inputs): the same request
    /// again (a tab shown again, a section collapsed) is answered without calculating the build again.
    meta: HashMap<&'static str, (String, String)>,
}

impl Open {
    /// `f`'s answer for `key`, kept per export `name` until the key changes.
    fn meta(&mut self, name: &'static str, key: String, f: impl FnOnce(&mut Open) -> Result<String>) -> Result<String> {
        // The timeless tables' folder is part of what a calculation reads.
        let key = format!("{}\u{0}{key}", pom_pipeline::data_rev());
        if let Some((k, v)) = self.meta.get(name) {
            if *k == key {
                return Ok(v.clone());
            }
        }
        let v = f(self)?;
        self.meta.insert(name, (key, v.clone()));
        Ok(v)
    }
}

/// At most this many undo steps are kept per build.
const UNDO_MAX: usize = 200;

thread_local! {
    static SESSIONS: RefCell<HashMap<String, Open>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u64> = const { RefCell::new(1) };
    static INIT: std::sync::Once = const { std::sync::Once::new() };
}

/// The folder the engine reads its game data from: `POM_ENGINE_DATA`, and nothing relative to the working
/// directory. None when it is not set (the host reports that as an error from `load_build`).
fn data_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("POM_ENGINE_DATA").filter(|d| !d.is_empty()).map(std::path::PathBuf::from)
}

fn require_data_dir() -> Result<()> {
    match data_dir() {
        Some(d) if d.join("data_index.json").exists() => Ok(()),
        Some(d) => Err(Error::from_reason(format!("engine data not found in {}", d.display()))),
        None => Err(Error::from_reason("engine data folder not set (POM_ENGINE_DATA)".to_string())),
    }
}

fn init() {
    INIT.with(|once| {
        once.call_once(|| {
            // Every crate resolves its data folder from POM_ENGINE_DATA first, so naming it
            // is enough; nothing is read from the working directory or another checkout.
            let Some(dir) = data_dir() else { return };
            if std::env::var_os("POM_ENGINE_DATA").is_none() {
                std::env::set_var("POM_ENGINE_DATA", &dir);
            }
            let cache = dir.join("parse_cache.bin");
            if cache.exists() {
                let fp = pom_engine::modparser::parse::parse_cache_fingerprint(&dir);
                if let Err(e) = pom_engine::modparser::parse::load_parse_cache(&cache, fp, false) {
                    eprintln!("parse cache not loaded: {e}");
                }
            }
        })
    });
}

fn player(v: &Value) -> Map<String, Value> {
    v.get("player").and_then(|p| p.as_object()).cloned().unwrap_or_default()
}

/// Stats that differ between `before` and `after`, as `[id, before, after]` (a missing stat is null).
fn diff(before: &Map<String, Value>, after: &Map<String, Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for (k, v) in after {
        if before.get(k) != Some(v) {
            out.push(json!([k, before.get(k).cloned().unwrap_or(Value::Null), v]));
        }
    }
    for (k, v) in before {
        if !after.contains_key(k) {
            out.push(json!([k, v, Value::Null]));
        }
    }
    out
}

fn with_session<T>(build_id: &str, f: impl FnOnce(&mut Open) -> Result<T>) -> Result<T> {
    SESSIONS.with(|s| {
        let mut s = s.borrow_mut();
        let open = s.get_mut(build_id).ok_or_else(|| Error::from_reason(format!("unknown build id {build_id}")))?;
        f(open)
    })
}

/// Full stats of a build, without keeping it open (the host's hot-swap check).
#[napi]
pub fn recalculate(build_xml: String) -> Result<String> {
    require_data_dir()?;
    init();
    let mut session = Session::new(build_xml, pom_calc::data::game_data());
    let first = session.calc().map_err(Error::from_reason)?;
    let full = session.finish().unwrap_or(first.stats);
    Ok(full.to_string())
}

/// Opens a build and returns `{"buildId", "stats": {...}}` with every stat (FullDPS included).
#[napi]
pub fn load_build(build_xml: String) -> Result<String> {
    require_data_dir()?;
    init();
    let mut session = Session::new(build_xml, pom_calc::data::game_data());
    let first = session.calc().map_err(Error::from_reason)?;
    let full = session.finish().unwrap_or(first.stats);
    let stats = player(&full);
    let id = NEXT_ID.with(|n| {
        let mut n = n.borrow_mut();
        let id = format!("b{}", *n);
        *n += 1;
        id
    });
    let out = json!({ "buildId": id, "stats": Value::Object(stats.clone()) }).to_string();
    SESSIONS.with(|s| s.borrow_mut().insert(id, Open { session, stats, undo: Vec::new(), redo: Vec::new(), power: None, opt: None, timeless: None, meta: HashMap::new() }));
    Ok(out)
}

/// One boss fight of the open build (crates/sim): `options_json` is `{"boss": "Pinnacle"|"Uber", "life": n,
/// "forced": bool, "charges": "empty"|"full", "chargeRate": n, "dt": s, "runs": n, "seed": n}` (all optional; `runs` > 0 rolls that many
/// fights and returns a time-to-kill range). Returns the fight result
/// JSON (time to kill, DPS per second, condition changes, the engine's steady DPS). The open build is not changed.
#[napi]
pub fn fight_sim(build_id: String, options_json: String) -> Result<String> {
    let opts: Value = if options_json.trim().is_empty() { json!({}) } else { serde_json::from_str(&options_json).map_err(|e| Error::from_reason(format!("fight options json: {e}")))? };
    let xml = with_session(&build_id, |open| Ok(open.session.xml().to_string()))?;
    let r = pom_sim::simulate(&xml, &pom_sim::Opts::from_json(&opts)).map_err(Error::from_reason)?;
    Ok(r.to_string())
}

/// Allocates the node if it isn't, deallocates it if it is. Returns the stats that changed; when `complete` is
/// false the FullDPS stats (SkillDPS, FullDPS, FullDotDPS) are still to come from `finish`.
#[napi]
pub fn toggle_node(build_id: String, node_id: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let first = open.session.toggle_node(node_id).map_err(Error::from_reason)?;
        let mut after = player(&first.stats);
        if !first.complete {
            // Keep the previous FullDPS values until `finish` replaces them, so they don't show as removed.
            for k in ["SkillDPS", "FullDPS", "FullDotDPS"] {
                if let Some(v) = open.stats.get(k) {
                    after.insert(k.to_string(), v.clone());
                }
            }
        }
        let changed = diff(&open.stats, &after);
        open.stats = after;
        Ok(json!({ "changed": changed, "complete": first.complete }).to_string())
    })
}

/// The stats that clicking the node would change, without changing the build (the tree's hover tooltip). The
/// result is kept, so clicking the same node next returns immediately.
#[napi]
pub fn preview_node(build_id: String, node_id: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let first = open.session.preview_node(node_id).map_err(Error::from_reason)?;
        let mut after = player(&first.stats);
        if !first.complete {
            for k in ["SkillDPS", "FullDPS", "FullDotDPS"] {
                if let Some(v) = open.stats.get(k) {
                    after.insert(k.to_string(), v.clone());
                }
            }
        }
        Ok(json!({ "changed": diff(&open.stats, &after), "complete": first.complete }).to_string())
    })
}

/// Runs the FullDPS rows left by the last `toggle_node` and returns the stats that changed (null if none were left).
#[napi]
pub fn finish(build_id: String) -> Result<Option<String>> {
    with_session(&build_id, |open| {
        let Some(full) = open.session.finish() else { return Ok(None) };
        let after = player(&full);
        let changed = diff(&open.stats, &after);
        open.stats = after;
        Ok(Some(json!({ "changed": changed, "complete": true }).to_string()))
    })
}

/// The Calcs tab's breakdown tables for an open build, as `{"player": {stat: table}, "minion": {...} | null}` JSON text.
/// Computed on demand (a separate calculation in the breakdown mode), never as part of an ordinary result.
/// `buff_mode` is the Calcs tab's calculation mode (`UNBUFFED`, `BUFFED`, `COMBAT`, `EFFECTIVE`); without one the
/// build's saved mode is used.
#[napi]
pub fn breakdowns(build_id: String, buff_mode: Option<String>) -> Result<String> {
    with_session(&build_id, |open| {
        set_buff_mode(open, buff_mode.as_deref())?;
        open.session.breakdowns().map(|v| v.to_string()).map_err(Error::from_reason)
    })
}

/// Sets the Calcs tab's calculation mode of an open build for the next `calcs` / `breakdowns` (`None`: the mode the
/// build saved). Any other name than the four modes is an error rather than a silent UNBUFFED.
fn set_buff_mode(open: &mut Open, mode: Option<&str>) -> Result<()> {
    if let Some(m) = mode {
        if !matches!(m, "UNBUFFED" | "BUFFED" | "COMBAT" | "EFFECTIVE") {
            return Err(Error::from_reason(format!("unknown buff mode '{m}' (UNBUFFED, BUFFED, COMBAT or EFFECTIVE)")));
        }
    }
    open.session.set_calcs_buff_mode(mode);
    Ok(())
}

/// Frees what the session's last calculations left behind. The host calls it after posting a result, so the
/// freeing isn't part of the click.
#[napi]
pub fn collect(build_id: String) -> Result<()> {
    with_session(&build_id, |open| {
        open.session.collect();
        Ok(())
    })
}

/// The current build XML of an open session.
#[napi]
pub fn build_xml(build_id: String) -> Result<String> {
    with_session(&build_id, |open| Ok(open.session.xml().to_string()))
}

/// Closes a session.
#[napi]
pub fn close_build(build_id: String) {
    SESSIONS.with(|s| s.borrow_mut().remove(&build_id));
}

/// The diff of a result against the open build's stats; FullDPS stats still to come keep their previous values.
fn result_diff(open: &Open, first: &pom_pipeline::session::Stats) -> Map<String, Value> {
    let mut after = player(&first.stats);
    if !first.complete {
        for k in ["SkillDPS", "FullDPS", "FullDotDPS"] {
            if let Some(v) = open.stats.get(k) {
                after.insert(k.to_string(), v.clone());
            }
        }
    }
    after
}

/// `{"blocked"}` for a stopped edit; "ClassChange:<id>" also gives the target class as `blockedClass`.
fn blocked_reply(blocked: &str) -> String {
    match blocked.split_once(':') {
        Some((name, class)) => json!({ "blocked": name, "blockedClass": class.parse::<i64>().unwrap_or(0) }).to_string(),
        None => json!({ "blocked": blocked }).to_string(),
    }
}

fn opt_str(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// The build text an edit gives, or what stops it (a click that needs a choice first: `PickMastery`,
/// `OtherAscendancy`, `Nothing`). Edits: `{"kind":"clickNode","nodeId"}`, `{"kind":"setNodes","nodeIds":[...]}`,
/// `{"kind":"setItem","slot","itemText"|null}`, `{"kind":"setSlotItem","slot","itemId"}`,
/// `{"kind":"setConfig","key","value"|null}`, `{"kind":"setGem","group","gem","attr","value"|null}`,
/// `{"kind":"setGroup","group","attr","value"|null}`, `{"kind":"setXml","xml"}`. Groups and gems are 1-based.
fn edited_xml(session: &mut Session, edit: &Value) -> Result<std::result::Result<String, String>> {
    let e = |m: String| Error::from_reason(m);
    let xml = session.xml().to_string();
    // An edit on a granted group the build text does not have yet saves those groups first (as upstream does).
    let xml = pom_pipeline::tabdata_skills::with_synthetic_groups(session, &xml, edit).map_err(e)?;
    let field = |k: &str| edit.get(k).cloned().unwrap_or(Value::Null);
    let num = |k: &str| edit.get(k).and_then(|v| v.as_i64()).ok_or_else(|| Error::from_reason(format!("edit needs {k}")));
    let text = |k: &str| edit.get(k).and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or_else(|| Error::from_reason(format!("edit needs {k}")));
    let out = match edit.get("kind").and_then(|k| k.as_str()).unwrap_or("") {
        "clickNode" => match session.click_xml(num("nodeId")?).map_err(e)? {
            Ok(x) => x,
            Err(blocked) => return Ok(Err(format!("{blocked:?}"))),
        },
        "setNodes" => {
            let ids: Vec<i64> = edit.get("nodeIds").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default();
            pom_pipeline::session::set_nodes_in_xml(&xml, &ids).map_err(e)?
        }
        "setItem" => pom_pipeline::edit::set_item(&xml, &text("slot")?, opt_str(&field("itemText")).as_deref()).map_err(e)?,
        "setSlotItem" => pom_pipeline::edit::set_slot_item(&xml, &text("slot")?, num("itemId")?).map_err(e)?,
        "setConfig" => {
            let v = match field("value") {
                Value::Null => None,
                Value::Bool(b) => Some(pom_pipeline::edit::ConfigValue::Bool(b)),
                Value::Number(n) => Some(pom_pipeline::edit::ConfigValue::Num(n.as_f64().unwrap_or(0.0))),
                Value::String(s) => Some(pom_pipeline::edit::ConfigValue::Str(s)),
                other => return Err(e(format!("bad config value {other}"))),
            };
            pom_pipeline::edit::set_config_input(&xml, &text("key")?, v.as_ref()).map_err(e)?
        }
        "setGem" => pom_pipeline::edit::set_gem_attr(&xml, num("group")? as usize, num("gem")? as usize, &text("attr")?, opt_str(&field("value")).as_deref()).map_err(e)?,
        "setGroup" => pom_pipeline::edit::set_group_attr(&xml, num("group")? as usize, &text("attr")?, opt_str(&field("value")).as_deref()).map_err(e)?,
        "configSet" => {
            let opt_num = |k: &str| edit.get(k).and_then(|v| v.as_i64());
            let opt_text = |k: &str| edit.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
            pom_pipeline::edit_config::config_set(&xml, &text("op")?, opt_num("id"), opt_text("title").as_deref(), opt_num("to")).map_err(e)?
        }
        "setCustomMods" => {
            let blocks: Vec<(String, bool, String)> = edit
                .get("blocks")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|b| (b.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(), b.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true), b.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string()))
                        .collect()
                })
                .unwrap_or_default();
            pom_pipeline::edit_config::set_custom_mods(&xml, &blocks).map_err(e)?
        }
        "setXml" => text("xml")?,
        "pickMastery" | "chooseAscendancy" | "setClass" | "resetTree" | "resetTattoos" | "setTattoo" => {
            use pom_pipeline::treeedit::{self, Stop};
            let paths = session.paths().map_err(e)?;
            let kind = edit.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            let opt = |k: &str| edit.get(k).and_then(|v| v.as_i64());
            let r = match kind {
                "pickMastery" => treeedit::pick_mastery(&xml, &paths, num("nodeId")?, num("effectId")?),
                "chooseAscendancy" => {
                    let confirm = edit.get("confirm").and_then(|v| v.as_str());
                    let s: &Session = session;
                    treeedit::choose_ascendancy(&xml, &paths, num("nodeId")?, confirm, &mut |x| s.paths_for_xml(x))
                }
                "setClass" => {
                    let s: &Session = session;
                    treeedit::set_class(&xml, &paths, num("classId")?, opt("ascendClassId"), opt("secondaryAscendClassId"), &mut |x| s.paths_for_xml(x))
                }
                "resetTree" => treeedit::reset_tree(&xml, &paths),
                "setTattoo" => treeedit::set_tattoo(&xml, &paths, num("nodeId")?, edit.get("tattoo").and_then(|v| v.as_str())),
                _ => treeedit::reset_tattoos(&xml),
            }
            .map_err(e)?;
            match r {
                Ok(x) => x,
                Err(Stop::Nothing) => return Ok(Err("Nothing".to_string())),
                Err(Stop::ClassChange(c)) => return Ok(Err(format!("ClassChange:{c}"))),
            }
        }
        k if pom_pipeline::edit_skills::handles(k) => match pom_pipeline::edit_skills::skills_edit(&xml, edit).map_err(e)? {
            Some(x) => x,
            None => return Err(e(format!("unknown edit kind {k:?}"))),
        },
        other => return Err(e(format!("unknown edit kind {other:?}"))),
    };
    Ok(Ok(out))
}

/// Applies an edit (see `edited_xml`) and returns the stats that changed, like `toggle_node`, or `{"blocked"}`
/// when a click needs a choice first. The edit can be undone.
#[napi]
pub fn edit(build_id: String, edit_json: String) -> Result<String> {
    let edit: Value = serde_json::from_str(&edit_json).map_err(|e| Error::from_reason(format!("edit json: {e}")))?;
    let amend = edit.get("amend").and_then(|v| v.as_bool()).unwrap_or(false);
    with_session(&build_id, |open| {
        let before = open.session.xml().to_string();
        let xml = match edited_xml(&mut open.session, &edit)? {
            Ok(x) => x,
            Err(blocked) => return Ok(blocked_reply(&blocked)),
        };
        if xml == before {
            return Ok(json!({ "changed": [], "complete": true }).to_string());
        }
        let first = open.session.apply_xml(xml).map_err(Error::from_reason)?;
        let after = result_diff(open, &first);
        let changed = diff(&open.stats, &after);
        open.stats = after;
        // `amend`: the edit folds into the previous history entry (which keeps restoring the state before the user's
        // action); with nothing to amend it is pushed as usual.
        if !(amend && !open.undo.is_empty()) {
            open.undo.push(before);
            if open.undo.len() > UNDO_MAX {
                open.undo.remove(0);
            }
        }
        open.redo.clear();
        Ok(json!({ "changed": changed, "complete": first.complete }).to_string())
    })
}

/// The stats an edit would change, without changing the build (hover tooltips and what-if comparisons). The result
/// is kept, so applying the same edit next returns immediately.
#[napi]
pub fn preview_edit(build_id: String, edit_json: String) -> Result<String> {
    let edit: Value = serde_json::from_str(&edit_json).map_err(|e| Error::from_reason(format!("edit json: {e}")))?;
    with_session(&build_id, |open| {
        let xml = match edited_xml(&mut open.session, &edit)? {
            Ok(x) => x,
            Err(blocked) => return Ok(blocked_reply(&blocked)),
        };
        let first = open.session.preview_xml(xml).map_err(Error::from_reason)?;
        let after = result_diff(open, &first);
        Ok(json!({ "changed": diff(&open.stats, &after), "complete": first.complete }).to_string())
    })
}

/// The stats the build would have with the listed nodes counted as allocated, wherever they are on the tree (the
/// original's `addNodes` calculator override), without changing the build. `ids_json` is an array of node ids.
#[napi]
pub fn preview_add_nodes(build_id: String, ids_json: String) -> Result<String> {
    // Either `[ids]`, or `{"nodes": [ids], "xml": "build text"}` to calculate another build text with those nodes counted.
    let v: Value = serde_json::from_str(&ids_json).map_err(|e| Error::from_reason(format!("node ids json: {e}")))?;
    let (ids, xml): (Vec<i64>, Option<String>) = match &v {
        Value::Array(a) => (a.iter().filter_map(|x| x.as_i64()).collect(), None),
        Value::Object(o) => (o.get("nodes").and_then(|n| n.as_array()).map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default(), o.get("xml").and_then(|x| x.as_str()).map(|x| x.to_string())),
        _ => return Err(Error::from_reason("node ids json: expected an array or an object")),
    };
    with_session(&build_id, |open| {
        let first = open.session.preview_add_nodes(&ids, xml.as_deref()).map_err(Error::from_reason)?;
        let after = result_diff(open, &first);
        Ok(json!({ "changed": diff(&open.stats, &after), "complete": first.complete }).to_string())
    })
}

/// The stats the build would have with the listed allocated nodes taken out of the allocated set for the calculation
/// only (upstream's `removeNodes` calculator override, used by the tree's "Unallocating this node" tooltip), without
/// changing the build. `ids_json` is an array of node ids.
#[napi]
pub fn preview_remove_nodes(build_id: String, ids_json: String) -> Result<String> {
    let ids: Vec<i64> = serde_json::from_str(&ids_json).map_err(|e| Error::from_reason(format!("node ids json: {e}")))?;
    with_session(&build_id, |open| {
        let first = open.session.preview_remove_nodes(&ids).map_err(Error::from_reason)?;
        let after = result_diff(open, &first);
        Ok(json!({ "changed": diff(&open.stats, &after), "complete": first.complete }).to_string())
    })
}

/// Runs the FullDPS rows the last preview left and returns the stats that differ from the open build's (null when the
/// preview was complete). The open build and its stats are not changed.
#[napi]
pub fn finish_preview(build_id: String) -> Result<Option<String>> {
    with_session(&build_id, |open| {
        let Some(full) = open.session.finish_preview() else { return Ok(None) };
        let after = player(&full);
        Ok(Some(json!({ "changed": diff(&open.stats, &after), "complete": true }).to_string()))
    })
}

/// Steps back (`undo`) or forward (`redo`) through committed edits; returns the stats that changed, or null at
/// either end.
fn step(build_id: &str, back: bool) -> Result<Option<String>> {
    with_session(build_id, |open| {
        let target = if back { open.undo.pop() } else { open.redo.pop() };
        let Some(xml) = target else { return Ok(None) };
        let current = open.session.xml().to_string();
        let first = open.session.apply_xml(xml).map_err(Error::from_reason)?;
        if back {
            open.redo.push(current);
        } else {
            open.undo.push(current);
        }
        let after = result_diff(open, &first);
        let changed = diff(&open.stats, &after);
        open.stats = after;
        Ok(Some(json!({ "changed": changed, "complete": first.complete }).to_string()))
    })
}

#[napi]
pub fn undo(build_id: String) -> Result<Option<String>> {
    step(&build_id, true)
}

#[napi]
pub fn redo(build_id: String) -> Result<Option<String>> {
    step(&build_id, false)
}

/// How many undo and redo steps the build has: `{"undo": n, "redo": n}`.
#[napi]
pub fn history(build_id: String) -> Result<String> {
    with_session(&build_id, |open| Ok(json!({ "undo": open.undo.len(), "redo": open.redo.len() }).to_string()))
}

/// Builds what the next click needs (the tree's paths for the build as it now is). The host calls it after posting
/// a result, with `collect`, so a click without a hover first stays as fast as before.
#[napi]
pub fn prepare(build_id: String) -> Result<()> {
    with_session(&build_id, |open| open.session.prepare().map_err(Error::from_reason))
}

/// The build's tree for the tree view: allocated nodes, class, masteries, jewels, generated cluster nodes and nodes
/// the build changes (see `pom_pipeline::treeclick::tree_state`). Static node data comes from `tree_<version>.json`.
#[napi]
pub fn tree_state(build_id: String) -> Result<String> {
    with_session(&build_id, |open| open.session.tree_state().map(|v| v.to_string()).map_err(Error::from_reason))
}

/// Starts Node Power for the build as it is (any run before is dropped): the unallocated nodes within `max_depth` path
/// steps (null: all), ranked by `stat` (null: upstream's combined offence and defence). Returns the node count.
#[napi]
pub fn node_power_start(build_id: String, max_depth: Option<i64>, stat: Option<String>) -> Result<i64> {
    with_session(&build_id, |open| {
        open.power = None;
        let (run, total) = pom_pipeline::nodepower::start(&mut open.session, max_depth, stat).map_err(Error::from_reason)?;
        open.power = Some(run);
        Ok(total as i64)
    })
}

/// Works on the running Node Power for about `budget_ms` and returns `NodePowerStep` JSON.
#[napi]
pub fn node_power_step(build_id: String, budget_ms: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let Some(mut run) = open.power.take() else { return Ok(json!({ "active": false, "done": true, "progress": 0, "nodes": [] }).to_string()) };
        let r = pom_pipeline::nodepower::step(&mut open.session, &mut run, budget_ms.max(1) as u64).map_err(Error::from_reason)?;
        if !(r["done"].as_bool().unwrap_or(true)) {
            open.power = Some(run);
        }
        Ok(r.to_string())
    })
}

/// Starts Optimize pathing for the build as it is: objective `points` (fewer points, every notable, keystone, mastery
/// and socket kept) or a stat id (Life, TotalEHP, CombinedDPS, FullDPS, ...: a better value with no more points).
/// Returns `{"candidates": n}`.
#[napi]
pub fn optimize_start(build_id: String, objective: String) -> Result<String> {
    with_session(&build_id, |open| {
        open.opt = None;
        let (run, candidates) = pom_pipeline::optimizer::start(&mut open.session, objective).map_err(Error::from_reason)?;
        open.opt = Some(run);
        Ok(json!({ "candidates": candidates }).to_string())
    })
}

/// Works on the running search for about `budget_ms` and returns `OptimizeStep` JSON.
#[napi]
pub fn optimize_step(build_id: String, budget_ms: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let Some(mut run) = open.opt.take() else { return Ok(json!({ "active": false, "done": true, "progress": 0, "evaluated": 0, "best": null }).to_string()) };
        let r = pom_pipeline::optimizer::step(&mut open.session, &mut run, budget_ms.max(1) as u64).map_err(Error::from_reason)?;
        if !(r["done"].as_bool().unwrap_or(true)) {
            open.opt = Some(run);
        }
        Ok(r.to_string())
    })
}

/// Smart pathing: the fewest-point tree that reaches every wanted node and never enters an avoided one, as
/// `{"nodeIds"}` (for `setNodes`) or `{"unreachable": [ids]}`.
#[napi]
pub fn path_solve(build_id: String, wanted: Vec<i64>, avoided: Vec<i64>) -> Result<String> {
    with_session(&build_id, |open| Ok(pom_pipeline::optimizer::path_solve(&mut open.session, &wanted, &avoided).map_err(Error::from_reason)?.to_string()))
}

/// Drops the running search.
#[napi]
pub fn optimize_cancel(build_id: String) -> Result<()> {
    with_session(&build_id, |open| {
        open.opt = None;
        Ok(())
    })
}

/// Running and finished build solves (`solve_start`), by solve id, with the build they were started from. A new solve
/// of a build stops and replaces that build's previous one.
struct SolveEntry {
    build_id: String,
    handle: pom_pipeline::solver::Handle,
}

fn solves() -> &'static std::sync::Mutex<HashMap<String, SolveEntry>> {
    static S: std::sync::OnceLock<std::sync::Mutex<HashMap<String, SolveEntry>>> = std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Starts the build solver on the open build in the background (worker threads, each with its own engine session).
/// `goal_json` is the goal (`SolveGoal` in packages/protocol); `options_json` `{"timeBudgetMs", "threads"}` (threads at
/// most every core but two). Returns `{"solveId"}`.
#[napi]
pub fn solve_start(build_id: String, goal_json: String, options_json: Option<String>) -> Result<String> {
    require_data_dir()?;
    init();
    let xml = with_session(&build_id, |open| Ok(open.session.xml().to_string()))?;
    let handle = pom_pipeline::solver::start(xml, &goal_json, options_json.as_deref().unwrap_or("")).map_err(Error::from_reason)?;
    let id = NEXT_ID.with(|n| {
        let mut n = n.borrow_mut();
        *n += 1;
        format!("solve{}", *n)
    });
    let mut s = solves().lock().map_err(|_| Error::from_reason("solver table poisoned"))?;
    for e in s.values_mut().filter(|e| e.build_id == build_id) {
        e.handle.cancel();
    }
    s.retain(|_, e| e.build_id != build_id);
    s.insert(id.clone(), SolveEntry { build_id, handle });
    Ok(json!({ "solveId": id }).to_string())
}

/// The solve's best-so-far (`SolveSnapshot`): waits up to `budget_ms` for a newer one (0: answer at once).
#[napi]
pub fn solve_step(solve_id: String, budget_ms: i64) -> Result<String> {
    let shared = {
        let s = solves().lock().map_err(|_| Error::from_reason("solver table poisoned"))?;
        let e = s.get(&solve_id).ok_or_else(|| Error::from_reason(format!("unknown solve id {solve_id}")))?;
        e.handle.shared.clone()
    };
    // (waits without holding the table, so a cancel from elsewhere is not held up)
    let (m, cv) = &*shared;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms.max(0) as u64);
    let mut g = m.lock().map_err(|_| Error::from_reason("solve state poisoned"))?;
    let start_version = g.version;
    while g.version == start_version && !g.done {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        g = cv.wait_timeout(g, deadline - now).map_err(|_| Error::from_reason("solve state poisoned"))?.0;
    }
    let mut snap = g.snapshot.clone();
    if let Some(o) = snap.as_object_mut() {
        o.insert("solveId".into(), json!(solve_id));
    }
    Ok(snap.to_string())
}

/// Stops a solve; its results stay readable (`solve_result`) until the build's next solve.
#[napi]
pub fn solve_cancel(solve_id: String) -> Result<()> {
    let mut s = solves().lock().map_err(|_| Error::from_reason("solver table poisoned"))?;
    if let Some(e) = s.get_mut(&solve_id) {
        e.handle.cancel();
    }
    Ok(())
}

/// Sends plan leads (a JSON array of `SolvePlanLead`) into a running plan solve; they join its lead loop. Returns
/// `{"queued", "running"}` (running false: the solve already ended and never reads them).
#[napi]
pub fn solve_add_leads(solve_id: String, leads_json: String) -> Result<String> {
    let s = solves().lock().map_err(|_| Error::from_reason("solver table poisoned"))?;
    let e = s.get(&solve_id).ok_or_else(|| Error::from_reason(format!("unknown solve id {solve_id}")))?;
    Ok(e.handle.add_leads(&leads_json).map_err(Error::from_reason)?.to_string())
}

/// One result of the trade-off set as the whole build text (`{"xml"}`): the app applies it with the `setXml` edit,
/// one undo step.
#[napi]
pub fn solve_result(solve_id: String, index: u32) -> Result<String> {
    let s = solves().lock().map_err(|_| Error::from_reason("solver table poisoned"))?;
    let e = s.get(&solve_id).ok_or_else(|| Error::from_reason(format!("unknown solve id {solve_id}")))?;
    let xml = e.handle.result_xml(index as usize).ok_or_else(|| Error::from_reason(format!("no result {index}")))?;
    Ok(json!({ "xml": xml }).to_string())
}

/// One result by its record id (`id` on each result row, the sha256 of its build text): the same build text however the
/// list was re-sorted since the id was seen. `{"xml"}`.
#[napi]
pub fn solve_result_by_id(solve_id: String, id: String) -> Result<String> {
    let s = solves().lock().map_err(|_| Error::from_reason("solver table poisoned"))?;
    let e = s.get(&solve_id).ok_or_else(|| Error::from_reason(format!("unknown solve id {solve_id}")))?;
    let xml = e.handle.result_xml_by_id(&id).ok_or_else(|| Error::from_reason(format!("no result {id}")))?;
    Ok(json!({ "xml": xml }).to_string())
}

/// Whether the timeless jewel tables are installed: `{"installed", "dir", "missing": [...]}`.
#[napi]
pub fn timeless_status() -> Result<String> {
    init();
    Ok(pom_pipeline::timeless::data_status().to_string())
}

/// Reads the timeless jewel tables from `dir` from now on (null: the default folders).
#[napi]
pub fn timeless_set_data_dir(dir: Option<String>) -> Result<()> {
    pom_pipeline::set_timeless_data_dir(dir.map(std::path::PathBuf::from));
    Ok(())
}

/// The Find Timeless Jewel dialog's lists for the build: the sockets (with the notables the build has in each radius).
#[napi]
pub fn timeless_info(build_id: String) -> Result<String> {
    with_session(&build_id, |open| {
        let (tree, tver, ctx) = pom_pipeline::timeless::context(&mut open.session).map_err(Error::from_reason)?;
        let mut v = pom_pipeline::timeless::info(tree, &tver, &ctx);
        v["data"] = pom_pipeline::timeless::data_status();
        Ok(v.to_string())
    })
}

/// The "Search for Node" entries for a jewel type.
#[napi]
pub fn timeless_mods(build_id: String, jewel_type: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let (tree, _, _) = pom_pipeline::timeless::context(&mut open.session).map_err(Error::from_reason)?;
        Ok(pom_pipeline::timeless::mods(tree, jewel_type).to_string())
    })
}

/// Starts a timeless jewel search (any search before is dropped). `params_json`: `{jewelType, socketId (-1: all),
/// socketFilter, socketFilterDistance, totalMinimumWeight, searchList, searchListFallback, protected: [names]}`.
#[napi]
pub fn timeless_start(build_id: String, params_json: String) -> Result<String> {
    with_session(&build_id, |open| {
        open.timeless = None;
        let params: Value = serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
        let p = pom_pipeline::timeless::Params::from_json(&params);
        let data = pom_pipeline::timeless_jewel_data().ok_or_else(|| Error::from_reason("The timeless jewel data is not installed.".to_string()))?;
        let (tree, tver, ctx) = pom_pipeline::timeless::context(&mut open.session).map_err(Error::from_reason)?;
        open.timeless = Some(pom_pipeline::timeless::start(tree, &tver, data, ctx, p).map_err(Error::from_reason)?);
        Ok(json!({ "started": true }).to_string())
    })
}

/// Works on the running search for about `budget_ms`: `{"active", "done", "progress", "results"}`.
#[napi]
pub fn timeless_step(build_id: String, budget_ms: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let Some(run) = open.timeless.as_mut() else { return Ok(json!({ "active": false, "done": true, "progress": 0, "results": 0 }).to_string()) };
        let (done, progress) = run.step(budget_ms.max(1) as u64);
        Ok(json!({ "active": true, "done": done, "progress": progress, "results": run.row_count(), "seedsDone": run.seeds_done() }).to_string())
    })
}

/// Rows `from..from+count` of the finished search, with its weight columns.
#[napi]
pub fn timeless_rows(build_id: String, from: i64, count: i64) -> Result<String> {
    with_session(&build_id, |open| {
        let Some(run) = open.timeless.as_ref() else { return Ok(json!({ "total": 0, "rows": [], "desired": [] }).to_string()) };
        Ok(json!({ "total": run.row_count(), "rows": run.rows_json(from.max(0) as usize, count.max(0) as usize), "desired": run.desired_json() }).to_string())
    })
}

/// Fallback weights for a jewel type: how much the build's power stat `stat` gains from each node (list text).
#[napi]
pub fn timeless_fallback(build_id: String, jewel_type: i64, stat: String) -> Result<String> {
    with_session(&build_id, |open| {
        let list = pom_pipeline::timeless::fallback_weights(&mut open.session, jewel_type, &stat).map_err(Error::from_reason)?;
        Ok(json!({ "list": list }).to_string())
    })
}

/// Calculates the open build again from its text, as a fresh session (the timeless jewel tables, say, were not there
/// the first time). Returns the stats that differ; the build text and the undo history stay as they are.
#[napi]
pub fn recalc(build_id: String) -> Result<String> {
    with_session(&build_id, |open| {
        let xml = open.session.xml().to_string();
        let mut session = Session::new(xml, pom_calc::data::game_data());
        let first = session.calc().map_err(Error::from_reason)?;
        let full = session.finish().unwrap_or(first.stats);
        let stats = player(&full);
        let changed = diff(&open.stats, &stats);
        open.session = session;
        open.stats = stats;
        open.meta.clear();
        open.power = None;
        open.opt = None;
        open.timeless = None;
        Ok(json!({ "changed": changed, "complete": true }).to_string())
    })
}

/// Drops the running search and its results.
#[napi]
pub fn timeless_cancel(build_id: String) -> Result<()> {
    with_session(&build_id, |open| {
        open.timeless = None;
        Ok(())
    })
}

/// Every Configuration option of upstream (static): a JSON `ConfigCatalog`.
#[napi]
pub fn config_catalog() -> Result<String> {
    Ok(pom_pipeline::tabdata_config::config_catalog().to_string())
}

/// Upstream's display stats (label, format, colour, flags) for tooltip comparisons: a JSON array.
#[napi]
pub fn stat_meta() -> Result<String> {
    Ok(pom_pipeline::tabdata_config::stat_meta().to_string())
}

/// The mod browser's lines for the build's active passive tree version (`Modules/ConfigModBrowser.lua`): a JSON
/// `{ mods: [{ text, sources }] }` of the lines the mod parser accepts, in upstream's order.
#[napi]
pub fn config_mods(build_id: String) -> Result<String> {
    init();
    with_session(&build_id, |open| {
        pom_pipeline::config_mods::config_mods_for(open.session.xml(), pom_calc::data::game_data()).map(|v| v.to_string()).map_err(Error::from_reason)
    })
}

/// The build's config sets, inputs, option visibility and custom modifiers: a JSON `ConfigState`. It calculates the
/// build once more to see what the calculation used.
#[napi]
pub fn config_state(build_id: String) -> Result<String> {
    init();
    with_session(&build_id, |open| {
        let xml = open.session.xml().to_string();
        // It reads the session's current stats too, which the FullDPS rows complete after an edit.
        let key = format!("{xml}\u{0}{}", Value::Object(open.stats.clone()));
        open.meta("config_state", key, |open| {
            let stats = open.stats.clone();
            let state = open.session.inspect_main(|env, main| pom_pipeline::tabdata_config::config_state(&xml, env, main, &stats)).map_err(Error::from_reason)?;
            state.map(|v| v.to_string()).map_err(Error::from_reason)
        })
    })
}

/// Every gem in the game data (the Skills tab's gem picker): a JSON array of `GemInfo`.
#[napi]
pub fn gem_catalog() -> Result<String> {
    init();
    Ok(pom_pipeline::tabdata_skills::gem_catalog().to_string())
}

/// The build's skill sets, socket groups and gems: a JSON `SkillsState`.
#[napi]
pub fn skills_state(build_id: String) -> Result<String> {
    init();
    with_session(&build_id, |open| {
        let xml = open.session.xml().to_string();
        open.meta("skills_state", xml.clone(), |open| {
            // The calculation's own view of the groups (effective gem values, active skills, granted groups).
            let state = open.session.inspect(|env| pom_pipeline::tabdata_skills::skills_state_with(&xml, pom_calc::data::game_data(), Some(env))).map_err(Error::from_reason)?;
            state.map(|v| v.to_string()).map_err(Error::from_reason)
        })
    })
}

/// The gem picker's DPS figures: the percent change of `field` when each gem of `gem_ids_json` (a JSON array of
/// `data.gems` keys) is added to socket group `group` (or put in place of gem `replace`, 1-based, 0 = none). Returns
/// `{"power": {id: percent|null}, "base": number}`. The build is not changed; every gem costs one calculation.
#[napi]
pub fn gem_power(build_id: String, group: i64, field: String, gem_ids_json: String, replace: i64) -> Result<String> {
    init();
    let ids: Vec<String> = serde_json::from_str(&gem_ids_json).map_err(|e| Error::from_reason(format!("gem ids json: {e}")))?;
    with_session(&build_id, |open| {
        let (rows, base) = pom_pipeline::tabdata_skills::gem_power(&mut open.session, group.max(0) as usize, &field, &ids, if replace > 0 { Some(replace as usize) } else { None }).map_err(Error::from_reason)?;
        let mut power = Map::new();
        for (id, v) in rows {
            power.insert(id, v.map(|x| json!(x)).unwrap_or(Value::Null));
        }
        Ok(json!({ "power": Value::Object(power), "base": base }).to_string())
    })
}

/// The Calcs tab's sections for the build as it now is, rendered from the live engine's own calculation: the same JSON
/// `pom_breakdown::render::render_build` returns for a recorded build. It runs the calculation again, so ask for it only
/// when the tab is shown; clicks never pay for it.
/// `buff_mode` is the Calcs tab's calculation mode (`UNBUFFED`, `BUFFED`, `COMBAT`, `EFFECTIVE`); without one the
/// build's saved mode is used.
#[napi]
pub fn calcs(build_id: String, buff_mode: Option<String>) -> Result<String> {
    with_session(&build_id, |open| {
        set_buff_mode(open, buff_mode.as_deref())?;
        open.session.calcs().map(|v| v.to_string()).map_err(Error::from_reason)
    })
}

/// The Calcs tab with its popup data: `{sections, view, mainSkill}` JSON text. `collapsed` is a JSON object mapping
/// `"<section id>:<sub-section index>"` to a collapse state that replaces the build's saved one for that sub-section.
#[napi(js_name = "calcsView")]
pub fn calcs_view(build_id: String, collapsed: Option<String>) -> Result<String> {
    let mut over: std::collections::HashMap<(String, usize), bool> = Default::default();
    if let Some(text) = collapsed {
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| Error::from_reason(e.to_string()))?;
        if let Some(o) = v.as_object() {
            for (k, b) in o {
                if let (Some((id, idx)), Some(b)) = (k.rsplit_once(':'), b.as_bool()) {
                    if let Ok(i) = idx.parse::<usize>() {
                        over.insert((id.to_string(), i), b);
                    }
                }
            }
        }
    }
    with_session(&build_id, |open| open.session.calcs_view(&over).map(|v| v.to_string()).map_err(Error::from_reason))
}

/// Every minion the Spectre Library can hold (`data.spectres`), as `[{id, name}]` JSON text sorted by name then id.
#[napi(js_name = "spectreCatalog")]
pub fn spectre_catalog() -> Result<String> {
    thread_local! {
        static CATALOG: std::cell::OnceCell<String> = const { std::cell::OnceCell::new() };
    }
    CATALOG.with(|c| {
        if let Some(t) = c.get() {
            return Ok(t.clone());
        }
        let path = pom_pipeline::engine_data_dir().join("data_spectres.json");
        let text = std::fs::read_to_string(&path).map_err(|e| Error::from_reason(format!("{}: {e}", path.display())))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| Error::from_reason(e.to_string()))?;
        let mut rows: Vec<(String, String)> = v
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(id, m)| {
                        let name = m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()).or_else(|| pom_calc::data::minion_raw(id).and_then(|r| r.get("name")).and_then(|n| n.as_str()).map(|s| s.to_string())).unwrap_or_else(|| id.clone());
                        (id.clone(), name)
                    })
                    .collect()
            })
            .unwrap_or_default();
        rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
        let out = serde_json::Value::Array(rows.into_iter().map(|(id, name)| serde_json::json!({ "id": id, "name": name })).collect()).to_string();
        let _ = c.set(out.clone());
        Ok(out)
    })
}

/// The modifier table of one popup entry of the Calcs tab (JSON text; `null` when the stat has no modifiers).
#[napi(js_name = "calcsMods")]
pub fn calcs_mods(build_id: String, detail: String) -> Result<String> {
    let d: serde_json::Value = serde_json::from_str(&detail).map_err(|e| Error::from_reason(e.to_string()))?;
    with_session(&build_id, |open| open.session.calcs_mods(&d).map(|v| v.to_string()).map_err(Error::from_reason))
}

/// The `<ExportedBuffs>` blocks of the build file while its Export Support switch is on: `[[name, text], ...]`.
#[napi]
pub fn exported_buffs(build_id: String) -> Result<String> {
    with_session(&build_id, |open| open.session.exported_buffs().map(|v| v.to_string()).map_err(Error::from_reason))
}

/// The main skill the sidebar's display stats are conditioned on: `{"name", "flags": [...], "skillTypes": [...]}`
/// (`skillFlags` after the calculation, and the skill's type ids).
#[napi]
pub fn main_skill(build_id: String) -> Result<String> {
    with_session(&build_id, |open| open.session.main_skill().map(|v| v.to_string()).map_err(Error::from_reason))
}

fn player_for(build_id: Option<&str>) -> items::Player {
    let Some(id) = build_id else { return items::Player::default() };
    SESSIONS.with(|s| {
        let s = s.borrow();
        let Some(open) = s.get(id) else { return items::Player::default() };
        let num = |k: &str| open.stats.get(k).and_then(|v| v.as_f64());
        // The character level is the `level` attribute of `<Build>`.
        let xml = open.session.xml();
        let level = xml.find("<Build ").and_then(|i| {
            let tag = &xml[i..i + xml[i..].find('>').unwrap_or(0)];
            let p = tag.find(" level=\"")? + 8;
            tag[p..].split('"').next()?.parse::<f64>().ok()
        });
        items::Player { level, str_: num("Str"), dex: num("Dex"), int: num("Int") }
    })
}

/// Describes an item for the Items tab: the tooltip lines upstream draws and the facts the editor needs
/// (see `items::item_info`). `build_id` colours requirements against that build's attributes and level.
/// `options`: `{"dbMode": bool, "slotNum": 1|2, "sanitise": bool}` (all optional).
#[napi]
pub fn item_info(build_id: Option<String>, item_text: String, options: Option<String>) -> Result<String> {
    init();
    let o: Value = options.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
    let opts = items::Opts { db_mode: o["dbMode"].as_bool().unwrap_or(false), slot_num: o["slotNum"].as_u64().unwrap_or(1) as usize, sanitise: o["sanitise"].as_bool().unwrap_or(true) };
    let player = player_for(build_id.as_deref());
    Ok(items::item_info(pom_calc::data::game_data(), &item_text, &player, &opts).to_string())
}

/// Several items at once: `texts` is a JSON array of item texts; returns a JSON array of `item_info` results.
#[napi]
pub fn items_info(build_id: Option<String>, texts: String) -> Result<String> {
    init();
    let list: Vec<String> = serde_json::from_str(&texts).map_err(|e| Error::from_reason(format!("texts json: {e}")))?;
    let player = player_for(build_id.as_deref());
    let opts = items::Opts { db_mode: false, slot_num: 1, sanitise: false };
    let game = pom_calc::data::game_data();
    let out: Vec<Value> = list.iter().map(|t| items::item_info(game, t, &player, &opts)).collect();
    Ok(Value::Array(out).to_string())
}

/// Base lists, uniques and rare templates (see `items::catalog`). They come from the game data alone, so they are built
/// once per process and kept.
#[napi]
pub fn item_catalog() -> Result<String> {
    init();
    catalog_text().map_err(Error::from_reason)
}

/// Builds the item catalog on a thread of its own, so the first `item_catalog` call (the Items tab, about a second of
/// work) finds it ready instead of holding this thread.
#[napi]
pub fn item_catalog_prewarm() {
    init();
    if data_dir().is_none() {
        return;
    }
    // On the thread the background item reads use: reading every unique once leaves its caches (parsed mod lines)
    // warm, so the first build's reads take a fifth of the time. Nothing read here is kept as a result.
    info_thread().submit(Box::new(|| {
        let Ok(text) = catalog_text() else { return };
        let Ok(cat) = serde_json::from_str::<Value>(&text) else { return };
        let game = pom_calc::data::game_data();
        let opts = items::Opts { db_mode: false, slot_num: 1, sanitise: false };
        let player = items::Player::default();
        for u in cat.get("uniques").and_then(|u| u.as_array()).into_iter().flatten() {
            if let Some(t) = u.get("text").and_then(|t| t.as_str()) {
                let _ = items::item_info(game, t, &player, &opts);
            }
        }
    }));
}

fn catalog_text() -> std::result::Result<String, String> {
    static CATALOG: std::sync::OnceLock<std::result::Result<String, String>> = std::sync::OnceLock::new();
    CATALOG.get_or_init(|| items::catalog(pom_calc::data::game_data()).map(|v| v.to_string())).clone()
}

/// The text of a new item of `base_name` as the craft dialog makes it.
#[napi]
pub fn item_craft(base_name: String, rarity: String, title: Option<String>) -> Result<String> {
    init();
    items::craft(pom_calc::data::game_data(), &base_name, &rarity, title.as_deref()).map_err(Error::from_reason)
}

/// The modifier lists the item editor's dialogs pick from (see `items::mod_pool`); `kind`: `mods`, `corrupt`,
/// `enchant` or `anoint`.
#[napi]
pub fn item_pool(item_text: String, kind: String) -> Result<String> {
    init();
    items::mod_pool(pom_calc::data::game_data(), &item_text, &kind).map(|v| v.to_string()).map_err(Error::from_reason)
}

/// The modifiers that can roll on a base at an item level (`pom_item::modpool`): prefixes and suffixes with tier, level,
/// weight, numeric ranges and source, eldritch implicits, anoints and cluster skills. `options`: `{"influences": [...],
/// "extraTags": [...]}` or null. Cached per base, so the solver can ask per slot.
#[napi]
pub fn mod_pool(base: String, item_level: u32, options: Option<String>) -> Result<String> {
    init();
    let opts: pom_item::modpool::PoolOptions = match options.as_deref() {
        Some(s) if !s.trim().is_empty() && s.trim() != "null" => serde_json::from_str(s).map_err(|e| Error::from_reason(format!("bad options: {e}")))?,
        _ => Default::default(),
    };
    let pool = pom_item::modpool::mod_pool(pom_calc::data::game_data(), &base, item_level, &opts).map_err(Error::from_reason)?;
    serde_json::to_string(&pool).map_err(|e| Error::from_reason(e.to_string()))
}

/// The item text as the build file keeps it, rebuilt from text copied in the game (see `items::normalise_text`).
#[napi]
pub fn item_normalise(item_text: String) -> Result<String> {
    init();
    items::normalise_text(pom_calc::data::game_data(), &item_text).map_err(Error::from_reason)
}

/// The item text with the prefix and suffix rows of a crafted item written into it (see `items::apply_affixes`).
/// `choice`: `{"prefix": [{"id", "range"}, ...], "suffix": [...]}`.
#[napi]
pub fn item_affix(item_text: String, choice: String) -> Result<String> {
    init();
    let choice: Value = serde_json::from_str(&choice).map_err(|e| Error::from_reason(format!("choice json: {e}")))?;
    items::apply_affixes(pom_calc::data::game_data(), &item_text, &choice).map_err(Error::from_reason)
}

/// The stats the Items tab can sort and rank by (`data.powerStatList`): `[{"stat", "label", "negate", "items"}]`, in the
/// original's order. `items` is false for the entries upstream leaves out of item lists. Minion stats are not
/// listed: the engine's results carry the player's stats only.
#[napi]
pub fn power_stats() -> Result<String> {
    init();
    let game = pom_calc::data::game_data();
    let list = game.extra.get("powerStatList").map_err(Error::from_reason)?.ok_or_else(|| Error::from_reason("no powerStatList"))?;
    let mut out: Vec<Value> = Vec::new();
    let mut i = 1;
    while let Some(e) = list.get(i.to_string().as_str()) {
        i += 1;
        let Some(stat) = e.get("stat").and_then(|s| s.as_str()) else { continue };
        if stat.starts_with("Minion") {
            continue;
        }
        let ignore = e.get("ignoreForItems").is_some();
        out.push(json!({
            "stat": stat,
            "label": e.get("label").and_then(|l| l.as_str()).unwrap_or(stat),
            "negate": stat.ends_with("TakenHit"),
            "items": !ignore,
        }));
    }
    Ok(Value::Array(out).to_string())
}

/// What `stat` comes to for each candidate item put in its slots, in the open build (upstream's sort by a stat in the
/// item lists, and `getSortValue` in the modifier pickers). `candidates`: `[{"text", "slots": [...], "flask": bool}]`; a slot
/// is a slot name or `Jewel <node id>`. Each result is the best value over the candidate's slots, or null when none
/// could be calculated. A flask or tincture is switched on in the first empty flask slot (`toggleFlask`). The open build
/// does not change.
#[napi]
pub fn item_rank(build_id: String, stat: String, candidates: String) -> Result<String> {
    let list: Vec<Value> = serde_json::from_str(&candidates).map_err(|e| Error::from_reason(format!("candidates json: {e}")))?;
    with_session(&build_id, |open| {
        let job = std::sync::Arc::new(RankJob::new(open.session.xml(), &stat, list));
        let names: Vec<&str> = job.names.iter().map(|n| n.as_str()).collect();
        let threads = rank_threads(job.list.len());
        if threads <= 1 {
            let out: Vec<Value> = job.list.iter().map(|c| rank_one(&mut open.session, c, &job.base_xml, &names, job.full, &job.free_flask)).collect();
            return Ok(Value::Array(out).to_string());
        }
        let mut out = rank_on_pool(&job, threads);
        // A worker that stopped partway leaves its candidates to this thread, as before.
        for (i, v) in out.iter_mut().enumerate() {
            if v.is_none() {
                *v = Some(rank_one(&mut open.session, &job.list[i], &job.base_xml, &names, job.full, &job.free_flask));
            }
        }
        Ok(Value::Array(out.into_iter().map(|v| v.unwrap_or(Value::Null)).collect()).to_string())
    })
}

/// `item_rank` for the app's background ranking: the same values, worked out on the ranking workers while this thread
/// stays free, so a tree click or any other call is answered at once instead of after the ranking piece. The build's
/// text is taken now, so the values belong to the build as it is when this is called.
#[napi]
pub fn item_rank_background(build_id: String, stat: String, candidates: String) -> Result<AsyncTask<PoolTask>> {
    let list: Vec<Value> = serde_json::from_str(&candidates).map_err(|e| Error::from_reason(format!("candidates json: {e}")))?;
    let job = with_session(&build_id, |open| Ok(RankJob::new(open.session.xml(), &stat, list)))?;
    Ok(AsyncTask::new(PoolTask(Some(Box::new(move || {
        let job = std::sync::Arc::new(job);
        let out = rank_on_pool(&job, rank_threads(job.list.len()).max(1));
        if out.iter().any(|v| v.is_none()) {
            return Err("a ranking worker stopped".to_string());
        }
        Ok(Value::Array(out.into_iter().map(|v| v.unwrap_or(Value::Null)).collect()).to_string())
    })))))
}

/// `items_info` off this thread (the background ranking reads the item list's details with it).
#[napi]
pub fn items_info_background(build_id: Option<String>, texts: String) -> Result<AsyncTask<PoolTask>> {
    init();
    let list: Vec<String> = serde_json::from_str(&texts).map_err(|e| Error::from_reason(format!("texts json: {e}")))?;
    let player = player_for(build_id.as_deref());
    Ok(AsyncTask::new(PoolTask(Some(Box::new(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        // Always the same thread, so its caches (parsed mod lines) stay warm from one piece to the next.
        info_thread().submit(Box::new(move || {
            let opts = items::Opts { db_mode: false, slot_num: 1, sanitise: false };
            let game = pom_calc::data::game_data();
            let out: Vec<Value> = list.iter().map(|t| items::item_info(game, t, &player, &opts)).collect();
            let _ = tx.send(Value::Array(out).to_string());
        }));
        rx.recv().map_err(|_| "an item worker stopped".to_string())
    })))))
}

/// Work handed to a libuv thread by a `*_background` call; the work itself runs on the ranking workers (their stacks
/// are big enough for a calculation), this thread only waits for it.
pub struct PoolTask(Option<Box<dyn FnOnce() -> std::result::Result<String, String> + Send>>);

impl Task for PoolTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let f = self.0.take().ok_or_else(|| Error::from_reason("already run"))?;
        f().map_err(Error::from_reason)
    }
    fn resolve(&mut self, _env: Env, out: String) -> Result<String> {
        Ok(out)
    }
}

/// One `item_rank` call's inputs, owned so the ranking workers can share them.
struct RankJob {
    list: Vec<Value>,
    base_xml: String,
    names: Vec<String>,
    full: bool,
    free_flask: Option<String>,
}

impl RankJob {
    fn new(xml: &str, stat: &str, list: Vec<Value>) -> RankJob {
        use pom_pipeline::edit;
        let base_xml = xml.to_string();
        let filled = edit::equipped_slots(&base_xml);
        let free_flask = (1..=5).map(|n| format!("Flask {n}")).find(|n| !filled.iter().any(|(s, _)| s == n));
        // FullDPS falls back to the player's combined DPS when the build has no FullDPS skills (`GetFromOutput`).
        let full = stat == "FullDPS";
        let mut names = vec![stat.to_string()];
        if full {
            names.push("CombinedDPS".to_string());
        }
        RankJob { list, base_xml, names, full, free_flask }
    }
}

/// Each candidate is a whole calculation of the build with the item in, independent of the others, so they are shared
/// out over the pool of ranking workers, each with its own session of the same build (a session runs a fresh calc per
/// candidate either way). One at a time, ranking the item database took about 4 s. A candidate a worker did not get to
/// (it stopped) is None.
fn rank_on_pool(job: &std::sync::Arc<RankJob>, threads: usize) -> Vec<Option<Value>> {
    let (tx, rx) = std::sync::mpsc::channel::<(usize, Value)>();
    for t in 0..threads {
        let (job, tx) = (job.clone(), tx.clone());
        rank_pool().submit(Box::new(move || {
            let names: Vec<&str> = job.names.iter().map(|n| n.as_str()).collect();
            let mut session = Session::new(job.base_xml.clone(), pom_calc::data::game_data());
            for i in (t..job.list.len()).step_by(threads) {
                let v = rank_one(&mut session, &job.list[i], &job.base_xml, &names, job.full, &job.free_flask);
                if tx.send((i, v)).is_err() {
                    return;
                }
            }
        }));
    }
    drop(tx);
    let mut out = vec![None; job.list.len()];
    for (i, v) in rx {
        out[i] = Some(v);
    }
    out
}

/// The ranking workers: started on first use, kept for the life of the process. A job that panics is caught, so its
/// worker carries on (the caller computes what that job did not send).
struct RankPool {
    tx: std::sync::Mutex<std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>>,
}

impl RankPool {
    fn submit(&self, job: Box<dyn FnOnce() + Send>) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(job);
        }
    }
}

fn rank_pool() -> &'static RankPool {
    static POOL: std::sync::OnceLock<RankPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let rx = std::sync::Arc::new(std::sync::Mutex::new(rx));
        for t in 0..RANK_MAX_THREADS {
            let rx = rx.clone();
            let _ = std::thread::Builder::new().name(format!("rank-{t}")).stack_size(RANK_STACK).spawn(move || {
                pom_pipeline::set_item_cache_max(RANK_ITEM_CACHE);
                loop {
                    let job = match rx.lock() {
                        Ok(r) => match r.recv() {
                            Ok(j) => j,
                            Err(_) => return,
                        },
                        Err(_) => return,
                    };
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                }
            });
        }
        RankPool { tx: std::sync::Mutex::new(tx) }
    })
}

/// The one thread `items_info_background` reads items on.
fn info_thread() -> &'static RankPool {
    static POOL: std::sync::OnceLock<RankPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let _ = std::thread::Builder::new().name("items-info".into()).stack_size(RANK_STACK).spawn(move || {
            while let Ok(job) = rx.recv() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
            }
        });
        RankPool { tx: std::sync::Mutex::new(tx) }
    })
}

const RANK_MAX_THREADS: usize = 8;

/// Parsed items each ranking worker keeps (see `pom_pipeline::set_item_cache_max`): the build's own items and a few
/// hundred candidates, not a copy of the whole unique list per worker.
const RANK_ITEM_CACHE: usize = 256;

/// Stack for a ranking worker: the calculation recurses deeply, as on the main thread.
const RANK_STACK: usize = 64 * 1024 * 1024;

/// Worker threads for ranking `n` candidates: none below four (starting them costs more than it saves), at most eight,
/// and two cores left for the app. `POM_RANK_THREADS` overrides it (1: on this thread, as before).
fn rank_threads(n: usize) -> usize {
    if let Some(t) = std::env::var("POM_RANK_THREADS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return t.max(1).min(n.max(1)).min(RANK_MAX_THREADS);
    }
    if n < 4 {
        return 1;
    }
    let cores = std::thread::available_parallelism().map(|c| c.get()).unwrap_or(1);
    cores.saturating_sub(2).clamp(1, RANK_MAX_THREADS).min(n)
}

/// One candidate's value: the build with the item in each of its slots (the best of them), or the build as it is.
fn rank_one(session: &mut Session, c: &Value, base_xml: &str, names: &[&str], full: bool, free_flask: &Option<String>) -> Value {
    use pom_pipeline::edit;
    // `{"base": true}` asks for the build as it is, the value gains are measured from.
    if c.get("base").and_then(|b| b.as_bool()).unwrap_or(false) {
        let v = session.eval_xml_stats(base_xml, names, full).ok().and_then(|v| v[0].or_else(|| if full { v.get(1).copied().flatten() } else { None }));
        return v.map_or(Value::Null, |b| json!(b));
    }
    let text = c.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let flask = c.get("flask").and_then(|f| f.as_bool()).unwrap_or(false);
    let slots: Vec<String> = c.get("slots").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let mut best: Option<f64> = None;
    for slot in &slots {
        let xml = if let Some(node) = slot.strip_prefix("Jewel ").and_then(|n| n.parse::<i64>().ok()) {
            edit::add_item(base_xml, text).and_then(|(x, id)| edit::set_jewel_socket(&x, node, id))
        } else if flask {
            let target = free_flask.clone().unwrap_or_else(|| slot.clone());
            edit::set_item(base_xml, &target, Some(text)).and_then(|x| edit::set_slot_active(&x, &target, true))
        } else {
            edit::set_item(base_xml, slot, Some(text))
        };
        let Ok(xml) = xml else { continue };
        let Ok(v) = session.eval_xml_stats(&xml, names, full) else { continue };
        let value = v[0].or_else(|| if full { v.get(1).copied().flatten() } else { None });
        if let Some(x) = value {
            best = Some(best.map_or(x, |b: f64| b.max(x)));
        }
        if flask {
            break;
        }
    }
    best.map_or(Value::Null, |b| json!(b))
}

/// The "Effective flask stats" lines of a flask or tincture in the open build, as tooltip lines (empty for other items).
#[napi]
pub fn item_flask(build_id: String, item_text: String) -> Result<String> {
    init();
    let game = pom_calc::data::game_data();
    with_session(&build_id, |open| open.session.with_env(|env| items::flask_lines(game, env, &item_text)).map(|v| v.to_string()).map_err(Error::from_reason))
}

/// A skill's tooltip as the gem tooltip draws it (`{"name", "lines"}`), for the skills an item grants. `build_id` colours the
/// requirements against that build's level and attributes.
#[napi]
pub fn gem_tip(build_id: Option<String>, skill_id: String, level: f64) -> Result<String> {
    init();
    let player = player_for(build_id.as_deref());
    items::gem_tip(pom_calc::data::game_data(), &skill_id, level, &player).map(|v| v.to_string()).map_err(Error::from_reason)
}

/// Whether the open build's modifiers carry each of the flags named in `names` (a JSON array), as a JSON object of booleans:
/// what the Items tab needs to know to show a third ring slot (`AdditionalRingSlot`).
#[napi]
pub fn build_flags(build_id: String, names: String) -> Result<String> {
    let names: Vec<String> = serde_json::from_str(&names).map_err(|e| Error::from_reason(format!("names json: {e}")))?;
    with_session(&build_id, |open| {
        let key = format!("{}\u{0}{}", open.session.xml(), Value::from(names.clone()));
        open.meta("build_flags", key, |open| {
            open.session
                .with_env(|env| {
                    let mut out = Map::new();
                    for n in &names {
                        out.insert(n.clone(), json!(env.player.flag(None, &[pom_engine::sym::Sym::new(n)])));
                    }
                    Value::Object(out).to_string()
                })
                .map_err(Error::from_reason)
        })
    })
}

/// Character import: which cluster jewel passives of an imported character the build text should allocate. `hashes_ex`
/// (a JSON array of ids) and `jewel_data` (the answer's object) are what the site sent beside the node list; the answer is
/// `{"allocated": [...], "unmatched": [...]}` (see `pom_pipeline::cluster_import`). Reads the text only; nothing is kept.
#[napi]
pub fn resolve_imported_clusters(build_xml: String, hashes_ex: String, jewel_data: String) -> Result<String> {
    init();
    let ex: Vec<i64> = serde_json::from_str(&hashes_ex).map_err(|e| Error::from_reason(format!("hashes_ex json: {e}")))?;
    let jd: Value = serde_json::from_str(&jewel_data).map_err(|e| Error::from_reason(format!("jewel_data json: {e}")))?;
    let r = pom_pipeline::cluster_import::resolve_imported_clusters(&build_xml, &ex, &jd, pom_calc::data::game_data()).map_err(Error::from_reason)?;
    Ok(json!({ "allocated": r.allocated, "unmatched": r.unmatched }).to_string())
}
