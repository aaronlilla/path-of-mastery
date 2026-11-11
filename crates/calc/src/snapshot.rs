//! The recorded engine state the calc stage reads from the pipeline: skill snapshots, allocated tree nodes and
//! the JSON decoding of a mod.
use pom_engine::modifier::{Mod, ModType, Tag};
pub use pom_engine::modstore::json::{jnum, parse_value};
use pom_engine::modstore::Cfg;
use pom_engine::sym::Sym;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;

fn jobj(v: &J) -> &serde_json::Map<String, J> {
    v.as_object().unwrap_or_else(|| panic!("expected a JSON object, got {v}"))
}
fn jstr(v: &J) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

pub fn parse_tag(v: &J) -> Tag {
    let o = jobj(v);
    let kind = Sym::new(o.get("kind").and_then(|k| k.as_str()).unwrap_or(""));
    let mut fields = Vec::new();
    if let Some(J::Object(f)) = o.get("fields") {
        for (k, v) in f {
            fields.push((Sym::new(k), parse_value(v)));
        }
    }
    Tag { kind, fields }
}

pub fn parse_mod(v: &J) -> Mod {
    let o = jobj(v);
    let name = Sym::new(o.get("name").and_then(|x| x.as_str()).unwrap_or(""));
    let ty = ModType::parse(o.get("type").and_then(|x| x.as_str()).unwrap_or("")).unwrap_or(ModType::Base);
    let value = o.get("value").map(parse_value).unwrap_or(pom_engine::value::Value::Nil);
    let flags = o.get("flags").and_then(jnum).unwrap_or(0.0) as u64;
    let keyword_flags = o.get("keywordFlags").and_then(jnum).unwrap_or(0.0) as u64;
    let source = o.get("source").and_then(jstr).map(|s| s.into());
    let tags = o.get("tags").and_then(|t| t.as_array()).map(|a| a.iter().map(parse_tag).collect()).unwrap_or_default();
    Mod { name, ty, value, flags, keyword_flags, source, tags }
}

/// A skill's `gem` identity block (the recorder's `serSkill`).
pub struct GemRef {
    pub granted_effect_id: Option<String>,
    pub gem_id: Option<String>,
    pub level: f64,
    pub quality: f64,
}

/// One `env.player.activeSkillList` entry.
pub struct SkillSnapshot {
    pub name: Option<String>,
    pub skill_flags: HashMap<String, bool>,
    pub skill_types: Vec<i64>,
    pub skill_mod_list: Vec<Mod>,
    pub gem: Option<GemRef>,
    /// `skill.skillCfg`, fully parsed into the engine's own `Cfg` (`ModCfg`, Modules/
    /// CalcActiveSkill.lua): needed to evaluate a `SkillName`/`SkillType`/`SkillId`/... tagged
    /// conditional mod correctly (e.g. a unique item's "X% increased Effect of Malevolence while
    /// affected by it" or a mastery's "increased Effect of Non-Curse Auras from your Skills") -
    /// without a real `Cfg`, `ModStore::sum`/`more`/`flag` silently treat every such mod as not
    /// matching (`eval_mod`'s tag cases all short-circuit to "no match" on a `None` cfg).
    pub cfg: Option<Cfg>,
}

/// One entry of the recorded `allocNodeMods` map: `env.allocNodes[id]`'s own fully-resolved
/// `node.finalModList` (or `node.modList` if the node was never merged in MAIN mode), plus its
/// `type` ("Notable"/"Keystone"/"Mastery"/"Normal"/"ClassStart"/"AscendClassStart"/"Socket") and
/// display name. This is read straight from `env.allocNodes` after `initEnv` finishes, so it
/// also covers cluster-jewel and granted-passive subgraph nodes: CalcSetup.lua lines 1387-1422's
/// re-expansion has already run by that point.
pub struct AllocNode {
    pub node_type: String,
    pub dn: String,
    /// `env.grantedPassives[id]`: this node was added by an anoint or an "Allocates X" grant,
    /// not a real point the spec itself allocated. Its mods still belong in the tree-mod sum,
    /// but `PassiveSpec.lua`'s own `allocatedNotableCount`/`allocatedKeystoneCount`/
    /// `allocatedMasteryCount` never count it, so neither should `allocated_count_mods`'s inputs.
    pub granted: bool,
    pub mods: Vec<Mod>,
}

