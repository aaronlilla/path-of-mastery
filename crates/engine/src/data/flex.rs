//! The Lua data exporter serializes every table as a JSON array only
//! when its keys are exactly `1..n`; an *empty* Lua table always comes out as `{}` since there is
//! no key to tell an empty sequence from an empty map, and a sequence with gaps in its numeric
//! keys also comes out as an object. `de_flex_vec` accepts a JSON array as usual, treats `{}` and
//! `null` as an empty `Vec`, and recovers order from a non-empty object by sorting its keys as
//! integers.

use serde::{Deserialize, Deserializer};
use crate::cjson::{from_j, J};

pub fn de_flex_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let v = J::deserialize(deserializer)?;
    if let Some(items) = v.as_array() {
        return items.iter().map(|x| from_j(x).map_err(serde::de::Error::custom)).collect();
    }
    if let Some(map) = v.as_object() {
        let mut entries: Vec<(i64, J)> = map.iter().filter_map(|(k, v)| k.parse::<i64>().ok().map(|n| (n, v))).collect();
        entries.sort_by_key(|(n, _)| *n);
        return entries.into_iter().map(|(_, v)| from_j(v).map_err(serde::de::Error::custom)).collect();
    }
    if v.is_null() {
        return Ok(Vec::new());
    }
    Err(serde::de::Error::custom(format!("expected array or object, got {v:?}")))
}

/// `de_flex_vec` as a type, for hand-written visitors.
pub struct Flex<T>(pub Vec<T>);
impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Flex<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        de_flex_vec(d).map(Flex)
    }
}

/// A map key, borrowed when the input allows it.
pub enum Key<'de> {
    Borrowed(&'de str),
    Owned(String),
}
impl Key<'_> {
    pub fn as_str(&self) -> &str {
        match self {
            Key::Borrowed(s) => s,
            Key::Owned(s) => s,
        }
    }
    pub fn into_string(self) -> String {
        match self {
            Key::Borrowed(s) => s.to_string(),
            Key::Owned(s) => s,
        }
    }
}
impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Key<'de>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a string key")
            }
            fn visit_borrowed_str<E: serde::de::Error>(self, s: &'de str) -> Result<Key<'de>, E> {
                Ok(Key::Borrowed(s))
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<Key<'de>, E> {
                Ok(Key::Owned(s.to_string()))
            }
            fn visit_string<E: serde::de::Error>(self, s: String) -> Result<Key<'de>, E> {
                Ok(Key::Owned(s))
            }
        }
        d.deserialize_str(V)
    }
}

/// `Deserialize` for a struct with named fields plus a catch-all `tail: HashMap<String, J>`, the same as
/// `#[derive(Deserialize)]` with `#[serde(flatten)]` on the tail, but reading the tail's values as `J` directly:
/// with `flatten`, serde buffers every field and each tail value was rebuilt, which made loading the gem and skill
/// tables most of startup. Field kinds: `opt` (an `Option`, missing means `None`), `def` (missing means
/// `Default`), `flex` (`de_flex_vec`, missing means empty).
#[macro_export]
macro_rules! de_with_tail {
    ($ty:ident, $tail:ident, { $( $field:ident : $key:literal => $how:ident ),* $(,)? }) => {
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl<'de> serde::de::Visitor<'de> for V {
                    type Value = $ty;
                    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                        f.write_str(stringify!($ty))
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<$ty, A::Error> {
                        $( let mut $field = None; )*
                        let mut $tail = $crate::fxhash::HashMap::default();
                        while let Some(k) = m.next_key::<$crate::data::flex::Key<'de>>()? {
                            match k.as_str() {
                                $( $key => { $field = Some($crate::de_with_tail!(@val $how, m)); } )*
                                _ => { $tail.insert(k.into_string(), m.next_value::<$crate::cjson::J>()?); }
                            }
                        }
                        Ok($ty { $( $field: $crate::de_with_tail!(@fin $how, $field), )* $tail })
                    }
                }
                d.deserialize_map(V)
            }
        }
    };
    (@val opt, $m:ident) => { $m.next_value()? };
    (@val def, $m:ident) => { $m.next_value()? };
    (@val flex, $m:ident) => { $m.next_value::<$crate::data::flex::Flex<_>>()?.0 };
    (@fin opt, $f:ident) => { $f.unwrap_or(None) };
    (@fin def, $f:ident) => { $f.unwrap_or_default() };
    (@fin flex, $f:ident) => { $f.unwrap_or_default() };
}
