//! Parses the socketed-gem input a build's `<Skills>` XML carries: `Classes/SkillsTab.lua`'s
//! `SkillsTabClass:Load`/`LoadSkill`, the non-UI subset (`ProcessSocketGroup`'s gem-data
//! resolution, not its UI-only `color`/`nameSpec`/error-message bookkeeping).
//!
//! **Not ported**: item-granted extra socket groups (`Modules/CalcSetup.lua` lines ~1460-1520,
//! synthesized from `ExtraSkill`/`GlobalGrantSkill` item mods, e.g. "Grants level 15 Vengeance
//! Skill" on a rare/unique item) and tree-granted skills (keystone/notable "Grants Skill" mods,
//! `isTreeSkill` groups with no `slot`). Only the real, XML-declared socket groups are read here.
use crate::data::{self, game_data};
use pom_engine::data::gems::GemData;
use roxmltree::{Document, Node};
use pom_engine::fxhash::HashMap;
use std::sync::OnceLock;

/// One `<Gem>` child of a socket group: `Classes/SkillsTab.lua:461-514`'s `gemInstance`, resolved
/// through `ProcessSocketGroup`'s gem-data lookup (lines 1161-1208) down to the fields
/// `Modules/CalcSetup.lua`'s active-skill-list build actually reads.
#[derive(Clone)]
pub struct GemInstance {
    pub gem_data: Option<&'static GemData>,
    /// Set only when `gem_data` is `None` but a bare `skillId` still resolves to a real
    /// `GrantedEffect` (`data.skills[skillId]`, no owning gem - item/tree-granted skill ids that
    /// happen to appear with an explicit `skillId` attribute rather than a synthesized group).
    pub granted_effect: Option<&'static pom_engine::data::gems::GrantedEffect>,
    pub level: f64,
    /// `gemInstance.level` before `calcLib.validateGemLevel` clamps the active effect's copy (`srcInstance.level`).
    pub raw_level: f64,
    pub quality: f64,
    pub enabled: bool,
    pub count: i64,
    /// `child.attrib.skillPart`, overridden by the group's own `skillPart` attribute for the
    /// first gem only (`LoadSkill` line 516-518).
    pub skill_part: Option<i64>,
    /// `child.attrib.skillMineCount` (MAIN mode; CalcActiveSkill.lua:623).
    pub skill_mine_count: Option<f64>,
    /// `<Gem skillStageCount="N">` (`srcInstance.skillStageCount`).
    pub skill_stage_count: Option<f64>,
    /// `srcInstance.skillMinion` / `skillMinionSkill` / `skillMinionItemSet` (MAIN mode; CalcActiveSkill.lua:698-701, 741).
    pub skill_minion: Option<String>,
    pub skill_minion_skill: Option<i64>,
    pub skill_minion_item_set: Option<i64>,
    /// `enableGlobal1`/`enableGlobal2`: whether the gem's primary/secondary granted effect is
    /// used as an active skill when `hasGlobalEffect` gates it (hybrid gems only). Index 0 is
    /// `enableGlobal1` (defaults `true`), index 1 is `enableGlobal2` (defaults `false`).
    pub enable_global: [bool; 2],
    /// `gemInstance.matchesSocket` (`SkillsTab:UpdateSocketGroups`): the gem's colour matches the
    /// colour of the item socket it sits in, worth `MatchingSocketQualityBonus` quality.
    pub matches_socket: bool,
    /// Sum of matching `GemProperty` `level`/`quality` bonuses (`applyGemMods`, CalcSetup.lua:381-415):
    /// item/tree "+N to Level/Quality of ... Gems" mods, added to the effect's level/quality.
    pub level_bonus: f64,
    pub quality_bonus: f64,
    /// `effect.gemPropertyInfo`: the `GemProperty` values that matched this gem.
    pub gem_property_info: Vec<crate::assemble::GemProp>,
    /// `gemCfg.socketColor` / `gemCfg.socketNum` (CalcSetup.lua:1773-1774), set by `apply_gem_props`.
    pub socket_color: Option<char>,
    pub socket_num: Option<usize>,
}

impl GemInstance {
    /// `gemInstance.quality + (matchesSocket and MatchingSocketQualityBonus or 0)` (CalcSetup.lua:1680/1757).
    pub fn actual_quality(&self) -> f64 {
        self.quality + if self.matches_socket { 10.0 } else { 0.0 } + self.quality_bonus
    }
    /// `activeEffect.level` after `applyGemMods`.
    pub fn effective_level(&self) -> f64 {
        self.level + self.level_bonus
    }
}

#[derive(Clone)]
pub struct SocketGroup {
    pub enabled: bool,
    pub label: Option<String>,
    pub slot: Option<String>,
    pub source: Option<String>,
    /// `imbuedSupport` attribute (SkillsTab.lua:455-458): only takes effect on a group in an item slot.
    pub imbued_support: Option<String>,
    pub main_active_skill: i64,
    pub main_active_skill_calcs: i64,
    pub gem_list: Vec<GemInstance>,
}

/// `data.gemsByGameId[gameId][variantId]`, plus the `grantedEffectId == skillId` fallback scan
/// `LoadSkill` uses when no `variantId` attribute is present (pre-3.23 saves - the common case in
/// this corpus). Built once from `data_gems.json`'s own `gameId`/`variantId` fields.
fn gems_by_game_id() -> &'static HashMap<String, Vec<(&'static str, &'static GemData)>> {
    static IDX: OnceLock<HashMap<String, Vec<(&'static str, &'static GemData)>>> = OnceLock::new();
    IDX.get_or_init(|| {
        let mut m: HashMap<String, Vec<(&'static str, &'static GemData)>> = HashMap::default();
        // `data::sorted_gems()`, not `&game_data().gems` directly - see its doc comment (this
        // Vec's element order decides `resolve_gem`'s tie-break when two variants under the same
        // `gameId` share a `grantedEffectId`, and a raw `HashMap` iteration order isn't
        // reproducible between runs).
        for (key, gem) in data::sorted_gems() {
            if let Some(game_id) = &gem.game_id {
                m.entry(game_id.clone()).or_default().push((key, gem));
            }
        }
        m
    })
}

/// Resolves an XML `<Gem gemId="..." variantId="..." skillId="...">` to the `GemData` it names,
/// mirroring `LoadSkill`'s gemId branch (lines 464-486) followed by `ProcessSocketGroup`'s
/// `data.gems[gemInstance.gemId]` re-lookup (lines 1169-1177), which is a no-op once the first
/// step already found the right variant.
fn resolve_gem(game_id: &str, variant_id: Option<&str>, skill_id: Option<&str>) -> Option<&'static GemData> {
    let variants = gems_by_game_id().get(game_id)?;
    // Faithful to `LoadSkill` (lines 464-486): `variantId` is tried first, then `skillId`'s
    // `grantedEffectId` match - and if NEITHER resolves, `gemData` stays nil (no further
    // fallback). A blind "just pick a variant" fallback is wrong here, not just unfaithful: a
    // legacy/renamed gem (e.g. an old save's `variantId="Riposte"`/`skillId="Riposte"`, long
    // since renamed to "Glacial Shield Swipe" in current game data) has zero real matching
    // variants, and guessing `.first()` silently produces a wrong, unrelated skill instead of
    // correctly leaving the gem unresolved (`errMsg` set, no active skill) - confirmed directly
    // against a sample build.
    // SkillsTab.lua:468-476 is `if variantId then ... elseif skillId then ...`: a stale `variantId` that names no
    // variant of the gameId leaves the gem unresolved even when `skillId` would have matched.
    if let Some(vid) = variant_id {
        return variants.iter().find(|(_, g)| g.variant_id.as_deref() == Some(vid)).map(|(_, gem)| *gem);
    }
    if let Some(sid) = skill_id {
        // Ambiguous when more than one variant shares the same `grantedEffectId` (a base Vaal
        // gem and its runtime-generated "AltX"/"AltY" alternate-quality sibling both report the
        // same `grantedEffectId` in this export - `Modules/Data.lua`'s `toAddGems` synthesizes
        // those at runtime, lines 1127-1148, and the exported JSON doesn't fully capture the
        // distinction). Upstream resolves this via LuaJIT's real table iteration order over
        // `possibleVariants` (not reproduced here - see `crates/passives/src/ljhash.rs` for the
        // precedent this would need); as an approximation, prefer the variant whose own id
        // doesn't carry an Alt suffix (the base gem, matching every sample build checked so far).
        let matches: Vec<(&str, &GemData)> = variants.iter().filter(|(_, g)| g.granted_effect_id.as_deref() == Some(sid)).copied().collect();
        let picked = matches.iter().find(|(key, _)| !key.ends_with("AltX") && !key.ends_with("AltY")).or_else(|| matches.first());
        if let Some((_, gem)) = picked {
            return Some(gem);
        }
    }
    None
}

fn attr_bool(node: &Node, name: &str) -> bool {
    node.attribute(name).map(|s| s == "true").unwrap_or(false)
}
fn attr_f64(node: &Node, name: &str) -> Option<f64> {
    node.attribute(name).and_then(|s| s.parse::<f64>().ok())
}
fn attr_i64(node: &Node, name: &str) -> Option<i64> {
    node.attribute(name).and_then(|s| s.parse::<i64>().ok())
}

/// `calcLib.validateGemLevel(gemInstance)` as run by `ProcessSocketGroup` (SkillsTab.lua:1225) on the gem's level.
pub fn validated_level(gem_data: Option<&'static GemData>, granted_effect: Option<&'static pom_engine::data::gems::GrantedEffect>, level: f64) -> f64 {
    let ge = granted_effect.or_else(|| gem_data.and_then(data::gem_primary_effect));
    match ge.and_then(|g| g.id.as_deref()) {
        Some(id) => crate::modlist::validate_gem_level_nat(id, level, gem_data.and_then(|g| g.natural_max_level).map(|n| n as f64)),
        None => level,
    }
}

fn load_gem(child: &Node, group_source: Option<&str>) -> GemInstance {
    let mut gem_data = None;
    let mut granted_effect = None;
    // `Modules/CalcSetup.lua`'s per-frame item/tree-granted-skill loop (lines 1464-1505)
    // unconditionally sets `activeGemInstance.gemId = nil` **every time**, for both a freshly
    // created synthetic group and one already found matching in `build.skillsTab.socketGroupList`
    // (a previously-saved synthetic group, persisted in this build's own `<Skills>` XML with a
    // `source` attribute but never a `gemId` one - confirmed empirically, no sample build's
    // persisted `source`-carrying `<Skill>`'s `<Gem>` ever has `gemId`). `ProcessSocketGroup` then
    // re-resolves it through the `elseif gemInstance.skillId` branch (`Classes/SkillsTab.lua`
    // lines 1178-1187): `local gemId = data.gemForSkill[gemInstance.skillId]` - looking up a
    // **string** (`gemInstance.skillId`) in a table whose keys are `GrantedEffect` **Lua table
    // objects** (`data.gemForSkill[gem.grantedEffect] = gemId`, `Modules/Data.lua`:1094, keyed by
    // primary-effect object identity, never by string id). A string key can never equal a table
    // key, so this lookup is *always* nil for every item/tree-granted skill, regardless of
    // whether some real gem happens to grant the same effect - a genuine, confirmed engine quirk
    // (not reproduced by this crate's own `data::gem_for_skill`, which *is* string-keyed and would
    // wrongly resolve a real gem here). So: any gem belonging to a `source`-carrying group (this
    // crate's `group_source`) always resolves to the bare `GrantedEffect` via `data.skills`, never
    // through a real `GemData`, matching every sample build's `slotName == nil` for these skills
    // (`skillCfg.slotName` itself is gated on `gemInstance.gemData` truthiness downstream -
    // `CalcActiveSkill.lua`:475, `CalcSetup.lua`:1769/1837-1839 - see `assemble.rs`).
    if group_source.is_some() {
        if let Some(skill_id) = child.attribute("skillId") {
            granted_effect = data::granted_effect_by_skill_id(skill_id);
        }
    } else if let Some(game_id) = child.attribute("gemId") {
        gem_data = resolve_gem(game_id, child.attribute("variantId"), child.attribute("skillId"));
    } else if let Some(skill_id) = child.attribute("skillId") {
        // `LoadSkill` lines 487-494 + `ProcessSocketGroup` lines 1178-1187, for a *non*-synthetic
        // group (`group_source` is `None` here, so the per-frame reset above never runs): a bare
        // `skillId` (no `gemId`) is first resolved by `LoadSkill` itself, whose own lookup *is*
        // correctly object-keyed (`gemInstance.gemId = data.gemForSkill[grantedEffect]`, using the
        // `GrantedEffect` object from `data.skills[skillId]`, not the string) - so a real gem
        // *can* be found here, unlike the synthetic-group case above.
        if data::granted_effect_by_skill_id(skill_id).is_some() {
            if let Some(gem_key) = data::gem_for_skill(skill_id) {
                gem_data = game_data().gems.get(gem_key);
            } else {
                granted_effect = data::granted_effect_by_skill_id(skill_id);
            }
        }
    }
    if gem_data.is_none() && granted_effect.is_none() && group_source.is_none() {
        // `ProcessSocketGroup`'s final fallback (lines 1193-1201): when neither `gemId` nor
        // `skillId` resolved to anything (a legacy/renamed gem's stale `variantId`/`skillId`,
        // see `resolve_gem`'s doc comment), retry by the gem's own display name.
        let name_spec = child.attribute("nameSpec").unwrap_or("");
        if !name_spec.trim().is_empty() {
            gem_data = data::find_skill_gem(name_spec);
        }
    }
    if gem_data.is_none() && granted_effect.is_none() && group_source.is_some() {
        // A saved item/tree-granted group whose `skillId` is stale (no `data.skills` entry, e.g. `SummonRockGolem`) still
        // goes through `LoadSkill`'s `ProcessSocketGroup` nameSpec fallback (SkillsTab.lua:1193-1201), which sets
        // `gemInstance.skillId` to the found gem's granted effect. CalcSetup's later `gemId = nil` reset then leaves the
        // bare granted effect, exactly as for a group whose `skillId` resolved directly.
        let name_spec = child.attribute("nameSpec").unwrap_or("");
        if !name_spec.trim().is_empty() {
            granted_effect = data::find_skill_gem(name_spec).and_then(data::gem_primary_effect);
        }
    }
    let quality = attr_f64(child, "quality").unwrap_or(0.0);
    let raw_level = attr_f64(child, "level").unwrap_or(1.0);
    let level = validated_level(gem_data, granted_effect, raw_level);
    GemInstance {
        gem_data,
        granted_effect,
        level,
        raw_level,
        quality,
        // `not child.attrib.enabled and true or child.attrib.enabled == "true"`: absent -> true.
        enabled: child.attribute("enabled").map(|s| s == "true").unwrap_or(true),
        count: attr_i64(child, "count").unwrap_or(1),
        skill_part: attr_i64(child, "skillPart"),
        skill_mine_count: attr_f64(child, "skillMineCount"),
        skill_stage_count: attr_f64(child, "skillStageCount"),
        skill_minion: child.attribute("skillMinion").map(|s| s.to_string()),
        skill_minion_skill: attr_i64(child, "skillMinionSkill"),
        skill_minion_item_set: attr_i64(child, "skillMinionItemSet"),
        enable_global: [child.attribute("enableGlobal1").map(|s| s == "true").unwrap_or(true), attr_bool(child, "enableGlobal2")],
        matches_socket: false,
        level_bonus: 0.0,
        quality_bonus: 0.0,
        gem_property_info: Vec::new(),
        socket_color: None,
        socket_num: None,
    }
}

/// Builds the single `GemInstance` a synthetic item/tree-granted socket group carries
/// (`Modules/CalcSetup.lua`'s `activeGemInstance`, lines 1488-1503): always a bare-`skillId`
/// resolution (`gemId` forced `nil` - see `load_gem`'s doc comment), `quality = 0`,
/// `enableGlobal1 = true`. `level` comes from the granting mod's own value field;
/// `noSupports`/`triggered` live on the enclosing `SocketGroup`/support-gathering, not here.
pub fn synthetic_gem_instance(skill_id: &str, level: f64) -> Option<GemInstance> {
    let granted_effect = data::granted_effect_by_skill_id(skill_id)?;
    let level_arg = level;
    let level = validated_level(None, Some(granted_effect), level);
    Some(GemInstance { gem_data: None, granted_effect: Some(granted_effect), level, raw_level: level_arg, quality: 0.0, enabled: true, count: 1, skill_part: None, skill_mine_count: None, skill_stage_count: None, skill_minion: None, skill_minion_skill: None, skill_minion_item_set: None, enable_global: [true, false], matches_socket: false, level_bonus: 0.0, quality_bonus: 0.0, gem_property_info: Vec::new(), socket_color: None, socket_num: None })
}

fn load_socket_group(node: &Node) -> SocketGroup {
    let source = node.attribute("source");
    let mut gem_list: Vec<GemInstance> = node.children().filter(|c| c.is_element() && c.tag_name().name() == "Gem").map(|c| load_gem(&c, source)).collect();
    if let Some(part) = attr_i64(node, "skillPart") {
        if let Some(first) = gem_list.first_mut() {
            first.skill_part = Some(part);
        }
    }
    SocketGroup {
        enabled: attr_bool(node, "active") || attr_bool(node, "enabled"),
        label: node.attribute("label").filter(|s| !s.is_empty()).map(|s| s.to_string()),
        slot: node.attribute("slot").map(|s| s.to_string()),
        source: node.attribute("source").map(|s| s.to_string()),
        imbued_support: node.attribute("imbuedSupport").filter(|_| node.attribute("slot").is_some()).map(|s| s.to_string()),
        main_active_skill: attr_i64(node, "mainActiveSkill").unwrap_or(1),
        main_active_skill_calcs: attr_i64(node, "mainActiveSkillCalcs").unwrap_or(1),
        gem_list,
    }
}

/// Identifies a build's XML text by content: a word-at-a-time hash of every byte plus the length.
pub fn xml_key(xml_text: &str) -> (u64, usize) {
    let mut h: u64 = 0;
    let b = xml_text.as_bytes();
    let mut chunks = b.chunks_exact(8);
    for c in &mut chunks {
        h = (h.rotate_left(5) ^ u64::from_le_bytes(c.try_into().unwrap())).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    for &x in chunks.remainder() {
        h = (h.rotate_left(5) ^ x as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    (h, b.len())
}

/// `xml_key` of the build XML with its `<Tree>...</Tree>` element left out: the passive tree is the part a tree
/// click changes, so parsers that never read it can keep their result across clicks.
pub fn xml_key_without_tree(xml_text: &str) -> (u64, usize) {
    // Inside `scope_xml_key` for this same text, the key was computed once already.
    if let Some((p, l, k)) = KEY_SCOPE.with(|c| c.get()) {
        if p == xml_text.as_ptr() as usize && l == xml_text.len() {
            return k;
        }
    }
    xml_key_without_tree_live(xml_text)
}

thread_local! {
    static KEY_SCOPE: std::cell::Cell<Option<(usize, usize, (u64, usize))>> = const { std::cell::Cell::new(None) };
}

/// While the returned guard lives, `xml_key_without_tree(xml_text)` returns the key computed here instead of hashing
/// the whole build again: one build load looks up a dozen memoized parsers. The text can't change or move while
/// borrowed, so its address identifies it for that long.
pub struct XmlKeyScope(Option<(usize, usize, (u64, usize))>);
impl Drop for XmlKeyScope {
    fn drop(&mut self) {
        // Keep this scope's keys (every section but `<Tree>`) for `scope_hint`.
        if let Some((p, l, key)) = KEY_SCOPE.with(|c| c.get()) {
            let sections = SECTION_KEYS.with(|c| c.borrow().iter().filter(|e| e.0 == p && e.1 == l && e.2 != "Tree").map(|e| (e.2, e.3)).collect());
            LAST_SCOPE.with(|c| *c.borrow_mut() = Some(ScopeKeys { key, sections }));
        }
        KEY_SCOPE.with(|c| c.set(self.0));
        SECTION_KEYS.with(|c| c.borrow_mut().clear());
    }
}
pub fn scope_xml_key(xml_text: &str) -> XmlKeyScope {
    SECTION_KEYS.with(|c| c.borrow_mut().clear());
    let (p, l) = (xml_text.as_ptr() as usize, xml_text.len());
    let key = match SCOPE_HINT.with(|h| h.borrow_mut().take()) {
        Some(h) => {
            SECTION_KEYS.with(|c| c.borrow_mut().extend(h.sections.iter().map(|&(n, k)| (p, l, n, k))));
            h.key
        }
        None => xml_key_without_tree_live(xml_text),
    };
    let prev = KEY_SCOPE.with(|c| c.replace(Some((p, l, key))));
    XmlKeyScope(prev)
}

thread_local! {
    static TREE_HINT: std::cell::Cell<Option<(usize, usize, usize, usize)>> = const { std::cell::Cell::new(None) };
}

/// While set, `xml_section(text, "Tree")` of exactly this text (same address and length) is `text[start..end]`,
/// which the caller built. `clear_tree_hint` must follow before the text is dropped.
pub fn set_tree_hint(xml_text: &str, start: usize, end: usize) {
    TREE_HINT.with(|h| h.set(Some((xml_text.as_ptr() as usize, xml_text.len(), start, end))));
}

pub fn clear_tree_hint() {
    TREE_HINT.with(|h| h.set(None));
    // A scope hint no calculation consumed (a patched evaluation reads none) must not reach the next text, which can
    // differ outside `<Tree>`: an edit that adds an item would then calculate with the keys of the text before it.
    SCOPE_HINT.with(|h| *h.borrow_mut() = None);
}

fn pom_passives_free_tree_hint(xml_text: &str) -> Option<&str> {
    let (p, l, s, e) = TREE_HINT.with(|h| h.get())?;
    (p == xml_text.as_ptr() as usize && l == xml_text.len()).then(|| &xml_text[s..e])
}

/// The keys of one scoped build text outside `<Tree>`: its `xml_key_without_tree` and the section keys computed.
#[derive(Clone)]
pub struct ScopeKeys {
    key: (u64, usize),
    sections: Vec<(&'static str, (u64, usize))>,
}

thread_local! {
    static LAST_SCOPE: std::cell::RefCell<Option<ScopeKeys>> = const { std::cell::RefCell::new(None) };
    static SCOPE_HINT: std::cell::RefCell<Option<ScopeKeys>> = const { std::cell::RefCell::new(None) };
}

/// The keys of the last closed scope.
pub fn last_scope_keys() -> Option<ScopeKeys> {
    LAST_SCOPE.with(|c| c.borrow().clone())
}

/// The next `scope_xml_key` uses `keys` instead of hashing its text. Only for a text that equals, outside
/// `<Tree>`, the one `keys` came from (the caller checks with `same_outside_tree`).
pub fn scope_hint(keys: ScopeKeys) {
    SCOPE_HINT.with(|h| *h.borrow_mut() = Some(keys));
}

/// Whether `a` and `b` are byte for byte equal outside their `<Tree>` elements.
pub fn same_outside_tree(a: &str, b: &str) -> bool {
    fn range(x: &str) -> Option<(usize, usize)> {
        let bytes = x.as_bytes();
        let mut from = 0;
        let start = loop {
            let i = from + x[from..].find("<Tree")?;
            if matches!(bytes.get(i + 5), Some(&c) if c == b' ' || c == b'>' || c == b'/' || c.is_ascii_whitespace()) {
                break i;
            }
            from = i + 5;
        };
        Some((start, start + x[start..].find("</Tree>")? + "</Tree>".len()))
    }
    match (range(a), range(b)) {
        (Some((sa, ea)), Some((sb, eb))) => a[..sa] == b[..sb] && a[ea..] == b[eb..],
        _ => false,
    }
}

fn xml_key_without_tree_live(xml_text: &str) -> (u64, usize) {
    let b = xml_text.as_bytes();
    let mut start = None;
    let mut from = 0;
    while let Some(i) = xml_text[from..].find("<Tree") {
        let at = from + i;
        if matches!(b.get(at + 5), Some(b' ' | b'>' | b'/' | b'\t' | b'\r' | b'\n')) {
            start = Some(at);
            break;
        }
        from = at + 5;
    }
    let Some(start) = start else { return xml_key(xml_text) };
    let Some(end) = xml_text[start..].find("</Tree>").map(|i| start + i + "</Tree>".len()) else { return xml_key(xml_text) };
    let (h1, l1) = xml_key(&xml_text[..start]);
    let (h2, l2) = xml_key(&xml_text[end..]);
    (h1.rotate_left(17) ^ h2.wrapping_mul(0x9e3779b97f4a7c15), (l1 << 32) | l2)
}

/// Memoizes `f`, a pure function of the build XML that never reads its `<Tree>` element, per thread: the calc
/// and every tree click call these parsers many times on text that only differs in the tree. `tag` names the
/// function so results of different types never collide.
pub fn memo_xml<T: Clone + 'static>(tag: &'static str, xml_text: &str, f: impl FnOnce() -> T) -> T {
    use std::any::Any;
    thread_local! {
        static MEMO: std::cell::RefCell<pom_engine::fxhash::HashMap<&'static str, ((u64, usize), Box<dyn Any>)>> = Default::default();
    }
    let key = xml_key_without_tree(xml_text);
    if let Some(v) = MEMO.with(|m| m.borrow().get(tag).filter(|e| e.0 == key).and_then(|e| e.1.downcast_ref::<T>().cloned())) {
        return v;
    }
    let v = f();
    MEMO.with(|m| m.borrow_mut().insert(tag, (key, Box::new(v.clone()))));
    v
}

/// The active skill set's socket-group list, in document order (`SkillsTabClass:Load`,
/// `SetActiveSkillSet`). Old-format saves (bare `<Skill>` children directly under `<Skills>`) are
/// treated as a single implicit skill set (id 1); `activeSkillSet` picks among `<SkillSet>`
/// children when present.
pub fn parse_active_socket_groups(xml_text: &str) -> Result<Vec<SocketGroup>, String> {
    socket_groups_shared(xml_text).map(|v| (*v).clone())
}

/// `parse_active_socket_groups` without copying: every setup stage re-reads the same <Skills>, so the last
/// parse is kept (keyed by the `<Skills>` element) and shared with read-only callers.
pub fn socket_groups_shared(xml_text: &str) -> Result<std::rc::Rc<Vec<SocketGroup>>, String> {
    memo_sections("socket_groups", xml_text, &["Skills"], || parse_active_socket_groups_inner(xml_text).map(std::rc::Rc::new))
}

/// The top-level element `<name ...>...</name>` (or a self-closing `<name .../>`) of a build's XML. Item and
/// custom-modifier text inside is escaped, so a raw `<name` can only start the element itself.
pub fn xml_section<'a>(xml_text: &'a str, name: &str) -> Option<&'a str> {
    if name == "Tree" {
        if let Some(t) = pom_passives_free_tree_hint(xml_text) {
            return Some(t);
        }
    }
    let b = xml_text.as_bytes();
    let open = format!("<{name}");
    let mut from = 0;
    let start = loop {
        let i = from + xml_text[from..].find(&open)?;
        if matches!(b.get(i + open.len()), Some(b' ' | b'>' | b'/' | b'\t' | b'\r' | b'\n')) {
            break i;
        }
        from = i + open.len();
    };
    let tag_end = start + xml_text[start..].find('>')?;
    if b[tag_end - 1] == b'/' {
        return Some(&xml_text[start..=tag_end]);
    }
    let close = format!("</{name}>");
    let end = tag_end + xml_text[tag_end..].find(&close)? + close.len();
    Some(&xml_text[start..end])
}

thread_local! {
    /// Section keys computed inside the current `scope_xml_key` (same text address and length).
    static SECTION_KEYS: std::cell::RefCell<Vec<(usize, usize, &'static str, (u64, usize))>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// `xml_key` of the top-level element `name` (a fixed marker when there is none), computed once per section while a
/// `scope_xml_key` for this text is open: several parsers key on `<Items>`, the largest part of a build.
fn section_key(xml_text: &str, name: &'static str) -> (u64, usize) {
    let (p, l) = (xml_text.as_ptr() as usize, xml_text.len());
    let scoped = KEY_SCOPE.with(|c| c.get()).is_some_and(|(sp, sl, _)| sp == p && sl == l);
    if scoped {
        if let Some(k) = SECTION_KEYS.with(|c| c.borrow().iter().find(|e| e.0 == p && e.1 == l && e.2 == name).map(|e| e.3)) {
            return k;
        }
    }
    let k = match xml_section(xml_text, name) {
        Some(sec) => xml_key(sec),
        None => (0x9e37_79b9_7f4a_7c15, usize::MAX >> 1),
    };
    if scoped {
        SECTION_KEYS.with(|c| c.borrow_mut().push((p, l, name, k)));
    }
    k
}

/// Memoizes `f`, a pure function of the named top-level sections of the build XML, per thread (the last result
/// per `tag`): an edit to one part of a build (an item, a config input, a gem) leaves the parsers of the other
/// parts cached.
pub fn memo_sections<T: Clone + 'static>(tag: &'static str, xml_text: &str, sections: &[&'static str], f: impl FnOnce() -> T) -> T {
    use std::any::Any;
    thread_local! {
        static MEMO: std::cell::RefCell<pom_engine::fxhash::HashMap<&'static str, ((u64, usize), Box<dyn Any>)>> = Default::default();
    }
    let mut h: u64 = 0;
    let mut len = 0usize;
    for (i, name) in sections.iter().enumerate() {
        let (sh, sl) = section_key(xml_text, name);
        h = (h.rotate_left(17) ^ sh).wrapping_mul(0x517c_c1b7_2722_0a95) ^ i as u64;
        len = len.wrapping_mul(31).wrapping_add(sl);
    }
    let key = (h, len);
    if let Some(v) = MEMO.with(|m| m.borrow().get(tag).filter(|e| e.0 == key).and_then(|e| e.1.downcast_ref::<T>().cloned())) {
        return v;
    }
    let v = f();
    MEMO.with(|m| m.borrow_mut().insert(tag, (key, Box::new(v.clone()))));
    v
}
fn parse_active_socket_groups_inner(xml_text: &str) -> Result<Vec<SocketGroup>, String> {
    // Only `<Skills>` is read, so only it is parsed.
    let Some(section) = xml_section(xml_text, "Skills") else { return Ok(Vec::new()) };
    let doc = Document::parse(section).map_err(|e| format!("xml parse error: {e}"))?;
    let skills_el = doc.root_element();
    // SkillsTabClass:Load: walk the children in order; a bare <Skill> lands in set 1 (created when
    // no set is ordered yet), a <SkillSet> makes its own set from its <Skill> children.
    let mut order: Vec<i64> = Vec::new();
    let mut sets: Vec<(i64, Vec<SocketGroup>)> = Vec::new();
    for c in skills_el.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "Skill" => {
                if order.is_empty() {
                    order.push(1);
                    sets.retain(|s| s.0 != 1);
                    sets.push((1, Vec::new()));
                }
                let g = load_socket_group(&c);
                if let Some(set) = sets.iter_mut().find(|s| s.0 == 1) {
                    set.1.push(g);
                }
            }
            "SkillSet" => {
                let id = c.attribute("id").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
                let groups: Vec<SocketGroup> = c.children().filter(|x| x.is_element() && x.tag_name().name() == "Skill").map(|x| load_socket_group(&x)).collect();
                sets.retain(|s| s.0 != id);
                sets.push((id, groups));
                order.push(id);
            }
            _ => {}
        }
    }
    let active_id = skills_el.attribute("activeSkillSet").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let chosen = sets.iter().position(|s| s.0 == active_id).or_else(|| order.first().and_then(|o| sets.iter().position(|s| s.0 == *o)));
    Ok(chosen.map(|i| sets.swap_remove(i).1).unwrap_or_default())
}

/// `build.mainSocketGroup` (`<Build mainSocketGroup="N">`, 1-based) and
/// `build.itemsTab.activeItemSet.useSecondWeaponSet` (`<Items useSecondWeaponSet="true/false">`).
/// `CalcSetup.lua`:1608's `if index == env.mainSocketGroup or (group.enabled and
/// group.slotEnabled) then` processes a socket group into `env.player.activeSkillList` if it's
/// either the build's selected main skill (regardless of its own `enabled`/weapon-set state - a
/// persisted-disabled or off-weapon-set group can still be the current main skill) or itself
/// enabled and on the active weapon set.
#[derive(Clone)]
pub struct BuildMeta {
    pub main_socket_group: i64,
    pub use_second_weapon_set: bool,
}

pub fn parse_build_meta(xml_text: &str) -> Result<BuildMeta, String> {
    memo_sections("parse_build_meta", xml_text, &["Build", "Items"], || parse_build_meta_inner(xml_text))
}

fn parse_build_meta_inner(xml_text: &str) -> Result<BuildMeta, String> {
    // Two attributes: only the start tags of `<Build>` and `<Items>` are parsed.
    let main_socket_group = start_tag_attr(xml_text, "Build", "mainSocketGroup")?.and_then(|v| v.parse::<i64>().ok()).unwrap_or(1);
    Ok(BuildMeta { main_socket_group, use_second_weapon_set: active_item_set_uses_second_weapon_set(xml_text)? })
}

/// `build.itemsTab.activeItemSet.useSecondWeaponSet` as `ItemsTab:Load` leaves it: the flag belongs to the active
/// `<ItemSet>` (`activeItemSet` id, else the first set in document order, `SetActiveItemSet` line 1593-1595). The
/// `<Items useSecondWeaponSet>` attribute is read only when the build has no `<ItemSet>` at all (line 1319), so a
/// saved build whose set flag and root attribute disagree (the app's weapon set toggle edits only the set) follows
/// the set.
fn active_item_set_uses_second_weapon_set(xml_text: &str) -> Result<bool, String> {
    let Some(sec) = xml_section(xml_text, "Items") else { return Ok(false) };
    let root_flag = |tag_src: &str| -> Result<bool, String> {
        let end = tag_src.find('>').map(|i| i + 1).unwrap_or(tag_src.len());
        let tag = if tag_src[..end].ends_with("/>") { tag_src[..end].to_string() } else { format!("{}</Items>", &tag_src[..end]) };
        let doc = Document::parse(&tag).map_err(|e| format!("xml parse error: {e}"))?;
        Ok(doc.root_element().attribute("useSecondWeaponSet") == Some("true"))
    };
    // No `<ItemSet` anywhere in the section: only the root attribute can speak (cheap, no full parse).
    if !sec.contains("<ItemSet") {
        return root_flag(sec);
    }
    let doc = Document::parse(sec).map_err(|e| format!("xml parse error: {e}"))?;
    let items_el = doc.root_element();
    let active_id = items_el.attribute("activeItemSet").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let id_of = |e: &roxmltree::Node| e.attribute("id").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let mut sets = items_el.children().filter(|c| c.is_element() && c.tag_name().name() == "ItemSet");
    let set = items_el.children().find(|c| c.is_element() && c.tag_name().name() == "ItemSet" && id_of(c) == active_id).or_else(|| sets.next());
    Ok(set.is_some_and(|s| s.attribute("useSecondWeaponSet") == Some("true")))
}

/// Attribute `attr` of the top-level element `name`, parsed from its start tag alone.
pub fn start_tag_attr(xml_text: &str, name: &str, attr: &str) -> Result<Option<String>, String> {
    let Some(sec) = xml_section(xml_text, name) else { return Ok(None) };
    let end = sec.find('>').map(|i| i + 1).unwrap_or(sec.len());
    let tag = if sec[..end].ends_with("/>") { sec[..end].to_string() } else { format!("{}</{name}>", &sec[..end]) };
    let doc = Document::parse(&tag).map_err(|e| format!("xml parse error: {e}"))?;
    let v = doc.root_element().attribute(attr).map(|s| s.to_string());
    Ok(v)
}

/// `Classes/ItemsTab.lua`:153-172: a slot named `"Weapon 1"`/`"Weapon 2"` (containing `"Weapon"`,
/// not ending ` Swap`) belongs to weapon set 1; its `" Swap"`-suffixed sibling (and that
/// sibling's abyssal-socket slots) belongs to weapon set 2. Every other slot has no weapon set at
/// all (`slot.weaponSet` stays `nil`), so it's never gated by the active weapon set.
fn slot_weapon_set(slot_name: &str) -> Option<u8> {
    if !slot_name.contains("Weapon") {
        return None;
    }
    Some(if slot_name.contains("Swap") { 2 } else { 1 })
}

/// `group.slotEnabled` (`CalcSetup.lua`:1605-1606): `not slot or not slot.weaponSet or
/// slot.weaponSet == (useSecondWeaponSet and 2 or 1)`.
pub fn slot_enabled(group_slot: &Option<String>, use_second_weapon_set: bool) -> bool {
    let Some(slot) = group_slot else { return true };
    match slot_weapon_set(slot) {
        None => true,
        Some(ws) => ws == if use_second_weapon_set { 2 } else { 1 },
    }
}

#[cfg(test)]
mod weapon_set_tests {
    use super::*;

    fn meta(items: &str) -> bool {
        let xml = format!("<PathOfBuilding><Build mainSocketGroup=\"1\"/>{items}</PathOfBuilding>");
        parse_build_meta(&xml).unwrap().use_second_weapon_set
    }

    // ItemsTab:Load keeps the flag on the active ItemSet; the app's weapon set toggle edits only the ItemSet.
    #[test]
    fn follows_the_active_item_set_not_the_root_attribute() {
        assert!(meta(r#"<Items activeItemSet="1" useSecondWeaponSet="false"><ItemSet useSecondWeaponSet="true" id="1"/></Items>"#));
        assert!(!meta(r#"<Items activeItemSet="1" useSecondWeaponSet="true"><ItemSet useSecondWeaponSet="false" id="1"/></Items>"#));
    }

    #[test]
    fn picks_the_set_named_by_active_item_set_else_the_first() {
        let sets = |active: &str| format!(r#"<Items activeItemSet="{active}" useSecondWeaponSet="false"><ItemSet useSecondWeaponSet="false" id="3"/><ItemSet useSecondWeaponSet="true" id="7"/></Items>"#);
        assert!(meta(&sets("7")));
        assert!(!meta(&sets("3")));
        // An id that names no set falls back to the first set in document order (SetActiveItemSet).
        assert!(!meta(&sets("99")));
    }

    #[test]
    fn root_attribute_only_when_there_is_no_item_set() {
        assert!(meta(r#"<Items activeItemSet="1" useSecondWeaponSet="true"/>"#));
        assert!(!meta(r#"<Items activeItemSet="1" useSecondWeaponSet="false"/>"#));
        assert!(!meta(""));
    }
}
