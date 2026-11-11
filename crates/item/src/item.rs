//! Port of the `Item` struct fields set by `Classes/Item.lua`'s `ParseRaw`. Field names mirror
//! the Lua `self.*` fields exactly (see the answer-key recorder) so the
//! golden test can compare field-by-field without a translation table.
//!
//! Scope note: this port covers `ParseRaw`'s header/metadata parsing and mod-line bucketing
//! (implicit/explicit/enchant/scourge/crucible split, line flags, and per-line `modList` via
//! `pom_engine::modparser::parse_mod`), plus `BuildModList`/`BuildModListForSlotNum`'s local-mod
//! removal and final `mod_list`/`slot_mod_list` construction (`buildmod.rs`). It does NOT compute
//! the derived `armourData`/`weaponData`/`flaskData`/`tinctureData` numeric structs, or rebuild
//! `sockets` from a `SocketCount`/`NoSockets` local mod -- see `buildmod.rs` module docs for the
//! exact cut line and the answer-key grader for how mismatches from that gap are bucketed separately from
//! real parsing bugs.
use pom_engine::modifier::Mod;
use pom_engine::modparser::types::PMod;
use pom_engine::fxhash::HashMap;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Socket {
    pub color: char,
    pub group: i64,
}

/// Port of `data.clusterJewels.jewels[baseName]` (Modules/Data.lua export), looked up once when
/// the item's base is matched (Item.lua line 1052: `self.clusterJewel = data.clusterJewels and
/// data.clusterJewels.jewels[self.baseName]`). Only the fields `BuildModListForSlotNum`'s jewel
/// branch actually reads (Item.lua lines 2486-2516: `.size`, `.minNodes`/`.maxNodes` for the
/// node-count clamp, `.skills` for `clusterJewelSkill` validation) are kept; `pom-passives`' own
/// `ClusterJewelData` (`crates/passives/src/clusterjewel.rs`) carries the rest (notable/small/
/// socket indices, orbit offsets) for subgraph generation, which is that crate's concern, not this
/// one's.
#[derive(Debug, Clone, Default)]
pub struct ClusterJewelBaseInfo {
    pub size: String,
    pub size_index: i64,
    pub min_nodes: i64,
    pub max_nodes: i64,
    /// Valid `clusterJewelSkill` tags for this base size (`self.clusterJewel.skills` keys).
    pub skills: pom_engine::fxhash::HashSet<String>,
}

/// Port of `item.jewelData.conqueredBy` (a Legion/Abyss timeless jewel's conqueror stamp, parsed
/// off its own "bathed in the blood of..."-style flavour line by `crates/engine`'s modparser as a
/// `JewelData` LIST mod, `ModParser.lua` lines 5829-5854). `conqueror_type`/`conqueror_id` are
/// empty/`None` in the (never expected in real data) case the conqueror name didn't resolve
/// against `conquerorList` -- upstream would leave `jewelData.conqueredBy.conqueror` as `nil`
/// entirely in that case, which nothing downstream actually guards against reading.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConqueredBy {
    pub id: i64,
    pub conqueror_type: String,
    pub conqueror_id: Option<String>,
}

/// Port of `self.jewelData` (Item.lua lines 2465-2517, the `elseif self.type == "Jewel"` branch of
/// `BuildModListForSlotNum`): non-mutating `modList:List(...)` reads gathered into one struct.
/// Built by `buildmod.rs::build_jewel_data`, once per jewel item (jewels are always a single slot,
/// never weapon/ring-scoped). Field names mirror the Lua `jewelData.*` keys.
#[derive(Debug, Clone, Default)]
pub struct JewelData {
    pub cluster_jewel_keystone: Option<String>,
    pub cluster_jewel_notables: Vec<String>,
    pub cluster_jewel_added_mods: Vec<String>,
    pub cluster_jewel_skill: Option<String>,
    pub cluster_jewel_socket_count: Option<i64>,
    pub cluster_jewel_socket_count_override: Option<i64>,
    pub cluster_jewel_node_count: Option<i64>,
    pub cluster_jewel_nothingness_count: Option<i64>,
    pub cluster_jewel_smalls_are_nothingness: bool,
    pub cluster_jewel_inc_effect: Option<f64>,
    /// `jewelData.corruptedMagicJewelIncEffect`/`corruptedRareJewelIncEffect`/`jewelIncEffectFromClassStart`
    /// (read by CalcSetup.lua's jewel-slot merge).
    pub corrupted_magic_jewel_inc_effect: Option<f64>,
    pub corrupted_rare_jewel_inc_effect: Option<f64>,
    pub jewel_inc_effect_from_class_start: Option<f64>,
    /// The three-way OR/AND chain at Item.lua lines 2514-2516, reduced to its real truth value
    /// (this crate's `JewelData` is typed, unlike the Lua table, so there's no separate "truthy
    /// but not a bool" shape to preserve -- see `buildmod.rs`'s doc comment on `build_jewel_data`).
    pub cluster_jewel_valid: bool,
    /// `item.jewelData.radiusIndex`: only ever set by a "affects/only affects passives in ... ring"
    /// mod line (a *variable*-radius jewel); see `Item::jewel_radius_index` for the final,
    /// consumed value (which also covers the fixed-radius "Radius: <Label>" spec-line case).
    pub radius_index: Option<i64>,
    pub intuitive_leap_like: bool,
    pub intuitive_leap_keystone_only: bool,
    pub impossible_escape_keystones: Vec<String>,
    /// `item.jewelData.limitDisabled`: **not** set anywhere in `Item.lua`/`ModParser.lua` -- the
    /// original only ever writes this from `Modules/CalcSetup.lua` (lines 852/866), which decides,
    /// across every equipped jewel sharing a `Limited to N` limit, which extra copies beyond N get
    /// disabled. Out of this crate's scope (no single item can compute it from its own raw text);
    /// always `false` here. A caller building a `pom_passives::clusterjewel::ClusterJewelInput` map
    /// from real items (e.g. `crates/pipeline`) needs to port that `CalcSetup.lua` algorithm itself
    /// if it wants this field to be real.
    pub limit_disabled: bool,
    pub conquered_by: Option<ConqueredBy>,
}

#[derive(Debug, Clone, Default)]
pub struct Requirements {
    pub str_: f64,
    pub dex: f64,
    pub int: f64,
    pub level: Option<f64>,
    pub str_mod: Option<f64>,
    pub dex_mod: Option<f64>,
    pub int_mod: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct ModLine {
    pub line: String,
    pub mod_tags: Vec<String>,
    pub range: Option<f64>,
    pub corrupted_range: Option<f64>,
    /// Port of `modLine.order`: a unique item's canonical stat-display order, looked up from
    /// `data.itemMods.ItemExclusive` by exact (or number-normalized) line text. Only ever set for
    /// a `UNIQUE`/`RELIC` item whose raw text is an "advanced copy" (`item.advanced_copy`); see
    /// `parse.rs`'s `assign_unique_stat_order` and `sort_crafted_mod_lines`.
    pub order: Option<f64>,
    pub extra: Option<String>,
    pub mod_group: Option<String>,
    pub mod_list: Option<Vec<PMod>>,
    /// From a `{variant:N,M,...}` tag: the 1-based variant indices this line applies to. `None`
    /// means the line applies to every variant.
    pub variant_list: Option<Vec<i64>>,
    /// From `{version:N,...}` / `{group:N,...}` tags (Item.lua:876-893): variant-group item lines.
    pub version_list: Option<Vec<i64>>,
    pub variant_group_list: Option<Vec<i64>>,
    // Line flags (see Item.lua's `lineFlags` table).
    pub crafted: bool,
    pub crucible: bool,
    pub custom: bool,
    pub disabled: bool,
    pub eater: bool,
    pub enchant: bool,
    pub exarch: bool,
    pub fractured: bool,
    pub implicit: bool,
    pub scourge: bool,
    pub synthesis: bool,
    pub mutated: bool,
    pub unscalable: bool,
    /// `modLine.valueScalar` (the catalyst scalar); `None` means 1.
    pub value_scalar: Option<f64>,
    pub prefix: bool,
    pub suffix: bool,
    pub unveiled: bool,
    pub vestigial: bool,
    /// Index of the raw text line this mod line came from, among the non-blank trimmed lines (the app's item
    /// editor uses it to change that line in the item text). Not part of upstream.
    pub raw_line: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ModMagnitudeMod {
    pub tags: Vec<String>,
    pub any_tags: Option<[String; 2]>,
    pub quality: f64,
    pub multiplier: Option<f64>,
    pub mod_type: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Item {
    /// `self.limit` (Item.lua:703): "Limited to: N" on a Jewel.
    pub limit: Option<f64>,
    /// Set by the caller before `build_mod_lists` (corpus items have a real id from the build
    /// XML; uniques don't, matching upstream's `self.id or -1`).
    pub id: Option<i64>,
    pub raw: String,
    pub name: String,
    pub name_prefix: String,
    pub name_suffix: String,
    pub title: Option<String>,
    /// Port of `self.foulborn` (Item.lua lines 1597-1608): true once any explicit line is found
    /// `.mutated` (see `parse.rs`'s `detect_foulborn`), which also forces a "Foulborn " title
    /// prefix. Not graded directly -- kept for field-for-field parity with upstream and for
    /// any future consumer.
    pub foulborn: bool,
    pub base_name: Option<String>,
    pub rarity: String,
    pub item_type: Option<String>,
    /// Port of `self.clusterJewel` (Item.lua line 1052), looked up (last-match-wins, same as
    /// `item_type`/`requirements`/`default_socket_color` above) every time the base line matches.
    /// `None` for a non-cluster-jewel base (including every non-jewel item).
    pub cluster_jewel: Option<ClusterJewelBaseInfo>,
    /// Port of `self.jewelRadiusLabel` (Item.lua line 691): the raw leading-word match off a
    /// "Radius: <Label>" spec line, kept mainly so `"Variable"` can be told apart from a real,
    /// already-resolved label. Jewel-only; `None` for a non-jewel item or a jewel with no `Radius:`
    /// line at all (most rares/magics never carry one).
    pub jewel_radius_label: Option<String>,
    /// Port of `self.jewelRadiusIndex`: for a fixed-radius jewel (`Radius: Small`/etc.), resolved
    /// directly off the `Radius:` spec line via `data.jewelRadius`'s label lookup (`parse.rs`'s
    /// `jewel_radius_index_for_label`); for a *variable*-radius jewel (`Radius: Variable`, e.g.
    /// Impossible Escape/Combat Focus), deferred until `jewel_data.radius_index` is known (a mod
    /// line like "Affects passives in medium ring") -- `buildmod.rs::build_mod_lists` applies that
    /// deferred assignment right after computing `jewel_data`, mirroring `ParseRaw`'s own
    /// `if deferJewelRadiusIndexAssignment then self.jewelRadiusIndex = self.jewelData.radiusIndex
    /// end` (Item.lua line 1637-1639).
    pub jewel_radius_index: Option<i64>,
    /// Port of the local `deferJewelRadiusIndexAssignment` (Item.lua line 694): `true` once a
    /// `Radius: Variable` spec line is seen. Not itself a graded/consumed field -- purely internal
    /// bookkeeping between `parse.rs` and `buildmod.rs`.
    pub defer_jewel_radius_index: bool,
    /// Port of `self.jewelData` (see `JewelData`'s own doc comment). Only ever populated (by
    /// `buildmod.rs::build_jewel_data`) for a `item_type == "Jewel"` item; stays `Default::default()`
    /// otherwise, same as upstream never building a `jewelData` table for a non-jewel item.
    pub jewel_data: JewelData,
    pub quality: Option<f64>,
    pub item_level: Option<f64>,
    pub talisman_tier: Option<f64>,
    pub corrupted: bool,
    pub mirrored: bool,
    pub split: bool,
    pub fractured: bool,
    pub synthesised: bool,
    pub veiled: bool,
    pub foil_type: Option<String>,
    pub class_restriction: Option<String>,
    pub catalyst: Option<i64>,
    pub catalyst_quality: Option<f64>,
    pub requirements: Requirements,
    pub sockets: Vec<Socket>,
    /// Port of `self.defaultSocketColor` (Item.lua line 1057): set once, when the base is matched,
    /// from the base's own str/dex/int requirement (highest wins, str/tie defaults to red). Used
    /// both to fill in missing sockets for a fixed-`socketLimit` base and by the `buildmod.rs`
    /// socket-count/no-sockets/abyssal-socket rebuild.
    pub default_socket_color: char,
    /// `self.abyssalSocketCount` (Item.lua:2641; 0 with "Has no Sockets").
    pub abyssal_socket_count: i64,
    /// `self.socketedJewelEffectModifier` (Item.lua:2691): `1 + local SocketedJewelEffect INC / 100`.
    /// Set by `buildmod::build_mod_lists`; `Default` leaves it 0 until then.
    pub socketed_jewel_effect_modifier: f64,
    /// `self.sockets.colourAlwaysMatches` (Item.lua:2688; Dialla's Malefaction).
    pub socket_always_matches: bool,
    pub influence: HashMap<&'static str, bool>,

    pub implicit_mod_lines: Vec<ModLine>,
    pub explicit_mod_lines: Vec<ModLine>,
    pub enchant_mod_lines: Vec<ModLine>,
    pub scourge_mod_lines: Vec<ModLine>,
    pub crucible_mod_lines: Vec<ModLine>,
    pub class_requirement_mod_lines: Vec<ModLine>,

    /// Set by `parse_raw` for `build_mod_lists` to consume; mirrors `self.variant` resolution
    /// (`#variantList` when nothing else selected it) and the "Selected Variant:" spec line.
    pub variant_count: i64,
    pub selected_variant: Option<i64>,
    /// Mirrors `self.hasAltVariant.. and self.variantAlt..`: additional variant indices that are
    /// ALSO active alongside `selected_variant` (`CheckModLineVariant`'s `or` chain, lines
    /// 2137-2143). A line tagged for any of these is included even though it isn't the primary
    /// selected variant.
    pub alt_variants: Vec<i64>,

    /// Port of `self.advancedCopy` (Item.lua line 899): set once an explicit `{range:N}` tag is
    /// seen anywhere in the raw text (a plain `{corruptedRange:N}` tag does not set it). Gates
    /// `sortCraftedModLines` and the unique-item stat-order lookup at the end of `parse_raw`; see
    /// their doc comments there.
    pub advanced_copy: bool,

    /// `self.crafted` (Item.lua:792, "Crafted: true" spec line).
    pub crafted: bool,
    /// `self.modMagnitudeMods` (Item.lua:1207-1302): "N% increased explicit ... modifier magnitudes".
    pub mod_magnitude_mods: Vec<ModMagnitudeMod>,

    /// The final per-slot-number-scoped mod list(s): `BuildModListForSlotNum`'s output. Weapons
    /// get 2 slots, rings get 3; everything else gets a single unscoped list in `mod_list`.
    pub mod_list: Option<Vec<Mod>>,
    pub slot_mod_list: Option<Vec<Vec<Mod>>>,

    /// Port of `self.weaponData`/`self.armourData`/`self.flaskData`/`self.tinctureData`: the
    /// derived numeric structs `BuildModListForSlotNum` computes for a weapon, armour, flask, or
    /// tincture base (Item.lua lines ~2288-2464). Each is stored as a plain JSON map, matching
    /// upstream's untyped Lua table field for field (see `buildmod.rs` for the computation
    /// and the answer-key grader for how it's graded against the recorded answer key). `weapon_data` holds
    /// one entry per weapon slot, always 2, matching `self.weaponData[1]`/`[2]`; the other three
    /// are per-item, matching upstream's single `self.armourData`/etc. table. `tincture_data`
    /// is computed the same way but has no recorded answer key: the recorder's
    /// `dumpItem` never captures `self.tinctureData`, so it is ungraded output for whatever
    /// consumes this crate next.
    /// Port of `self.armourData` as pre-seeded during header parsing, BEFORE `BuildModListForSlotNum`
    /// computes anything (Item.lua lines 722-742): a normal in-game item copy of an armour piece
    /// includes its own rolled `Armour:`/`Evasion:`/`Energy Shield:`/`Ward:` line(s) (and, for an "advanced copy" export,
    /// an explicit `XBasePercentile:` line too), which is how the
    /// original knows the REAL roll instead of always assuming max (percentile 1). Keys are
    /// "Armour"/"Evasion"/"EnergyShield"/"Ward" and their "...BasePercentile" counterparts, values
    /// straight off `specToNumber`. `parse.rs` populates this; `buildmod.rs` reads it to back-
    /// calculate the real percentile (see its module doc) instead of defaulting to 1.
    pub armour_data_seed: HashMap<String, f64>,
    pub armour_data: Option<serde_json::Value>,
    pub weapon_data: Option<Vec<serde_json::Value>>,
    pub flask_data: Option<serde_json::Value>,
    pub tincture_data: Option<serde_json::Value>,
}

pub const INFLUENCE_KEYS: &[&str] = &[
    "shaper", "elder", "adjudicator", "basilisk", "crusader", "eyrie", "cleansing", "tangle",
];

/// Port of `influenceItemMap`: raw-text line -> influence key.
pub fn influence_key_for_line(line: &str) -> Option<&'static str> {
    Some(match line {
        "Shaper Item" => "shaper",
        "Elder Item" => "elder",
        "Warlord Item" => "adjudicator",
        "Hunter Item" => "basilisk",
        "Crusader Item" => "crusader",
        "Redeemer Item" => "eyrie",
        "Searing Exarch Item" => "cleansing",
        "Eater of Worlds Item" => "tangle",
        _ => return None,
    })
}
