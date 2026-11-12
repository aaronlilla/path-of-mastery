//! Read-only JSON kept as one compact byte buffer instead of a tree of `serde_json::Value`s.
//!
//! The exported game data and passive trees are 45 MB of JSON that `serde_json::Value` held in about 10 to 13
//! times that, and parsing them was most of startup. A `J` is a (buffer, offset) handle with the reading half of
//! `Value`'s API; the buffer is built once from the JSON, saved next to it (`<dir>/pjs/<file>.pjs`), and after
//! that loaded with a single file read. Objects keep their keys in file order (as `serde_json` does with
//! `preserve_order`), numbers keep serde_json's split between unsigned, signed and float, and `to_value`
//! rebuilds the exact `Value`.
//!
//! Layout (little endian, offsets are u32 from the buffer start): a value is a tag byte and a payload.
//! 0 null, 1 false, 2 true, 3 u64, 4 i64, 5 f64 (8 bytes each), 6 string (u32 length, bytes),
//! 7 array (u32 count, count child offsets), 8 object (u32 count, count (key offset, value offset) pairs in file
//! order, then for more than 8 keys the entry numbers sorted by key bytes). Equal strings are stored once.
use crate::fxhash::HashMap;
use serde_json::Value;
use std::path::Path;

const MAGIC: &[u8; 4] = b"PJS1";
const SORTED_MIN: u32 = 9;

#[derive(Clone, Copy)]
pub struct J {
    buf: &'static [u8],
    off: u32,
}

#[inline]
fn rd32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
#[inline]
fn rd64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

impl J {
    /// A JSON null, for `unwrap_or(J::NULL)`.
    pub const NULL: J = J { buf: &[0], off: 0 };

    #[inline]
    fn tag(&self) -> u8 {
        self.buf[self.off as usize]
    }
    #[inline]
    fn at(&self, off: u32) -> J {
        J { buf: self.buf, off }
    }
    fn str_at(buf: &'static [u8], off: u32) -> &'static str {
        let o = off as usize;
        let n = rd32(buf, o + 1) as usize;
        // Built from `&str`s only.
        unsafe { std::str::from_utf8_unchecked(&buf[o + 5..o + 5 + n]) }
    }
    pub fn is_null(&self) -> bool {
        self.tag() == 0
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self.tag(), 1 | 2)
    }
    pub fn is_number(&self) -> bool {
        matches!(self.tag(), 3..=5)
    }
    pub fn is_string(&self) -> bool {
        self.tag() == 6
    }
    pub fn is_array(&self) -> bool {
        self.tag() == 7
    }
    pub fn is_object(&self) -> bool {
        self.tag() == 8
    }
    pub fn is_u64(&self) -> bool {
        self.tag() == 3 || (self.tag() == 4 && (rd64(self.buf, self.off as usize + 1) as i64) >= 0)
    }
    pub fn is_i64(&self) -> bool {
        self.tag() == 4 || (self.tag() == 3 && rd64(self.buf, self.off as usize + 1) <= i64::MAX as u64)
    }
    pub fn is_f64(&self) -> bool {
        self.tag() == 5
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self.tag() {
            1 => Some(false),
            2 => Some(true),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&'static str> {
        (self.tag() == 6).then(|| J::str_at(self.buf, self.off))
    }
    /// Same results as `serde_json::Value::as_i64`: `None` for a float, or a u64 above `i64::MAX`.
    pub fn as_i64(&self) -> Option<i64> {
        let raw = rd64(self.buf, self.off as usize + 1);
        match self.tag() {
            3 => (raw <= i64::MAX as u64).then_some(raw as i64),
            4 => Some(raw as i64),
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        let raw = rd64(self.buf, self.off as usize + 1);
        match self.tag() {
            3 => Some(raw),
            4 => ((raw as i64) >= 0).then_some(raw),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if !self.is_number() {
            return None;
        }
        let raw = rd64(self.buf, self.off as usize + 1);
        Some(match self.tag() {
            3 => raw as f64,
            4 => raw as i64 as f64,
            _ => f64::from_bits(raw),
        })
    }
    pub fn as_array(&self) -> Option<JArr> {
        (self.tag() == 7).then_some(JArr(*self))
    }
    pub fn as_object(&self) -> Option<JObj> {
        (self.tag() == 8).then_some(JObj(*self))
    }
    /// `Value::get`: a key for an object, an index for an array.
    pub fn get<I: JIndex>(&self, index: I) -> Option<J> {
        index.index_into(*self)
    }
    pub fn pointer(&self, pointer: &str) -> Option<J> {
        if pointer.is_empty() {
            return Some(*self);
        }
        let mut cur = *self;
        for tok in pointer.strip_prefix('/')?.split('/') {
            let tok = tok.replace("~1", "/").replace("~0", "~");
            cur = match cur.tag() {
                8 => cur.get(tok.as_str())?,
                7 => cur.get(tok.parse::<usize>().ok()?)?,
                _ => return None,
            };
        }
        Some(cur)
    }
    /// The same value as a `serde_json::Value`.
    pub fn to_value(&self) -> Value {
        match self.tag() {
            0 => Value::Null,
            1 => Value::Bool(false),
            2 => Value::Bool(true),
            3 => Value::from(self.as_u64().unwrap()),
            4 => Value::from(rd64(self.buf, self.off as usize + 1) as i64),
            5 => serde_json::Number::from_f64(self.as_f64().unwrap()).map(Value::Number).unwrap_or(Value::Null),
            6 => Value::String(self.as_str().unwrap().to_string()),
            7 => Value::Array(JArr(*self).iter().map(|v| v.to_value()).collect()),
            _ => Value::Object(JObj(*self).iter().map(|(k, v)| (k.to_string(), v.to_value())).collect()),
        }
    }
}

impl std::fmt::Debug for J {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(&self.to_value(), f)
    }
}
impl std::fmt::Display for J {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.to_value(), f)
    }
}
impl PartialEq for J {
    fn eq(&self, o: &J) -> bool {
        (std::ptr::eq(self.buf, o.buf) && self.off == o.off) || self.to_value() == o.to_value()
    }
}
impl PartialEq<&str> for J {
    fn eq(&self, o: &&str) -> bool {
        self.as_str() == Some(*o)
    }
}
impl PartialEq<str> for J {
    fn eq(&self, o: &str) -> bool {
        self.as_str() == Some(o)
    }
}

pub trait JIndex {
    fn index_into(self, v: J) -> Option<J>;
}
impl JIndex for &str {
    fn index_into(self, v: J) -> Option<J> {
        v.as_object()?.get(self)
    }
}
impl JIndex for &String {
    fn index_into(self, v: J) -> Option<J> {
        v.as_object()?.get(self)
    }
}
impl JIndex for String {
    fn index_into(self, v: J) -> Option<J> {
        v.as_object()?.get(&self)
    }
}
impl JIndex for usize {
    fn index_into(self, v: J) -> Option<J> {
        v.as_array()?.get(self)
    }
}

#[derive(Clone, Copy)]
pub struct JArr(J);
impl JArr {
    pub fn len(&self) -> usize {
        rd32(self.0.buf, self.0.off as usize + 1) as usize
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn get(&self, i: usize) -> Option<J> {
        (i < self.len()).then(|| self.0.at(rd32(self.0.buf, self.0.off as usize + 5 + 4 * i)))
    }
    pub fn first(&self) -> Option<J> {
        self.get(0)
    }
    pub fn last(&self) -> Option<J> {
        self.len().checked_sub(1).and_then(|i| self.get(i))
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = J> + ExactSizeIterator + Clone + 'static {
        let a = *self;
        (0..self.len()).map(move |i| a.0.at(rd32(a.0.buf, a.0.off as usize + 5 + 4 * i)))
    }
}
impl IntoIterator for JArr {
    type Item = J;
    type IntoIter = Box<dyn DoubleEndedIterator<Item = J>>;
    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.iter())
    }
}

#[derive(Clone, Copy)]
pub struct JObj(J);
impl JObj {
    pub fn len(&self) -> usize {
        rd32(self.0.buf, self.0.off as usize + 1) as usize
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    #[inline]
    fn entry(&self, i: usize) -> (&'static str, J) {
        let b = self.0.buf;
        let at = self.0.off as usize + 5 + 8 * i;
        (J::str_at(b, rd32(b, at)), self.0.at(rd32(b, at + 4)))
    }
    pub fn get(&self, key: &str) -> Option<J> {
        let n = self.len();
        if (n as u32) < SORTED_MIN {
            return (0..n).map(|i| self.entry(i)).find(|(k, _)| *k == key).map(|(_, v)| v);
        }
        let b = self.0.buf;
        let idx = self.0.off as usize + 5 + 8 * n;
        let (mut lo, mut hi) = (0usize, n);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let e = rd32(b, idx + 4 * mid) as usize;
            let (k, v) = self.entry(e);
            match k.as_bytes().cmp(key.as_bytes()) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(v),
            }
        }
        None
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = (&'static str, J)> + ExactSizeIterator + Clone + 'static {
        let o = *self;
        (0..self.len()).map(move |i| o.entry(i))
    }
    pub fn keys(&self) -> impl DoubleEndedIterator<Item = &'static str> + ExactSizeIterator + Clone + 'static {
        self.iter().map(|(k, _)| k)
    }
    pub fn values(&self) -> impl DoubleEndedIterator<Item = J> + ExactSizeIterator + Clone + 'static {
        self.iter().map(|(_, v)| v)
    }
}

impl IntoIterator for JObj {
    type Item = (&'static str, J);
    type IntoIter = Box<dyn DoubleEndedIterator<Item = (&'static str, J)>>;
    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.iter())
    }
}

/// Builds the buffer for `v`.
pub fn encode(v: &Value) -> Vec<u8> {
    struct W<'a> {
        out: Vec<u8>,
        strs: HashMap<&'a str, u32>,
    }
    impl<'a> W<'a> {
        fn s(&mut self, s: &'a str) -> u32 {
            if let Some(&o) = self.strs.get(s) {
                return o;
            }
            let o = self.out.len() as u32;
            self.out.push(6);
            self.out.extend((s.len() as u32).to_le_bytes());
            self.out.extend(s.as_bytes());
            self.strs.insert(s, o);
            o
        }
        fn v(&mut self, v: &'a Value) -> u32 {
            match v {
                Value::Array(a) => {
                    let kids: Vec<u32> = a.iter().map(|x| self.v(x)).collect();
                    let o = self.out.len() as u32;
                    self.out.push(7);
                    self.out.extend((kids.len() as u32).to_le_bytes());
                    for k in kids {
                        self.out.extend(k.to_le_bytes());
                    }
                    o
                }
                Value::Object(m) => {
                    let kids: Vec<(u32, u32, &str)> = m.iter().map(|(k, x)| (self.s(k), self.v(x), k.as_str())).collect();
                    let o = self.out.len() as u32;
                    self.out.push(8);
                    self.out.extend((kids.len() as u32).to_le_bytes());
                    for (k, x, _) in &kids {
                        self.out.extend(k.to_le_bytes());
                        self.out.extend(x.to_le_bytes());
                    }
                    if kids.len() as u32 >= SORTED_MIN {
                        let mut order: Vec<u32> = (0..kids.len() as u32).collect();
                        order.sort_by(|&a, &b| kids[a as usize].2.as_bytes().cmp(kids[b as usize].2.as_bytes()));
                        for i in order {
                            self.out.extend(i.to_le_bytes());
                        }
                    }
                    o
                }
                Value::String(s) => self.s(s),
                _ => {
                    let o = self.out.len() as u32;
                    match v {
                        Value::Null => self.out.push(0),
                        Value::Bool(false) => self.out.push(1),
                        Value::Bool(true) => self.out.push(2),
                        Value::Number(n) => {
                            if let Some(u) = n.as_u64() {
                                self.out.push(3);
                                self.out.extend(u.to_le_bytes());
                            } else if let Some(i) = n.as_i64() {
                                self.out.push(4);
                                self.out.extend(i.to_le_bytes());
                            } else {
                                self.out.push(5);
                                self.out.extend(n.as_f64().unwrap_or(0.0).to_bits().to_le_bytes());
                            }
                        }
                        _ => unreachable!(),
                    }
                    o
                }
            }
        }
    }
    let mut w = W { out: Vec::with_capacity(1 << 20), strs: HashMap::default() };
    w.out.extend(MAGIC);
    w.out.extend([0u8; 20]); // root offset, source length, source modified time
    let root = w.v(v);
    w.out[4..8].copy_from_slice(&root.to_le_bytes());
    w.out
}

/// The root of a buffer made by `encode`.
pub fn root(buf: &'static [u8]) -> Option<J> {
    (buf.len() >= 24 && &buf[..4] == MAGIC).then(|| J { buf, off: rd32(buf, 4) })
}

fn source_stamp(path: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as u64;
    Some((m.len(), t))
}

/// Where the compact copy of `json_path` lives: `$POM_PJS_DIR/<name>.pjs`, or `pjs/` beside the JSON.
fn cache_path(json_path: &Path) -> std::path::PathBuf {
    // The source directory's hash is part of the name, so copies of two data directories never overwrite each other.
    let dir = json_path.parent().unwrap_or(Path::new("."));
    let abs = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in abs.to_string_lossy().to_lowercase().replace('\\', "/").bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    let name = format!("{}.{:08x}.pjs", json_path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), h as u32);
    cache_dir(dir).join(name)
}

/// The directory for files derived from data in `data_dir`: `$POM_PJS_DIR`, or `<data_dir>/pjs`.
pub fn cache_dir(data_dir: &Path) -> std::path::PathBuf {
    match crate::env::var("POM_PJS_DIR") {
        Ok(d) => std::path::PathBuf::from(d),
        Err(_) => data_dir.join("pjs"),
    }
}

/// Loads `json_path` as a compact document that lives for the rest of the process. Its saved copy is used when it
/// was built from a file of the same size and modification time; otherwise the JSON is parsed, and the copy
/// (re)written when the directory allows it.
pub fn load(json_path: &Path) -> Result<J, String> {
    let stamp = source_stamp(json_path).ok_or_else(|| format!("{}: not found", json_path.display()))?;
    let cache = cache_path(json_path);
    if crate::env::var_os("POM_PJS_OFF").is_none() {
        // Mapped, not read: the OS pages it in and it isn't private memory of this process.
        if let Ok(buf) = crate::mmap::map_static(&cache) {
            if buf.len() >= 24 && &buf[..4] == MAGIC && rd64(buf, 8) == stamp.0 && rd64(buf, 16) == stamp.1 {
                return root(buf).ok_or_else(|| format!("{}: bad compact copy", cache.display()));
            }
        }
    }
    let text = std::fs::read(json_path).map_err(|e| format!("{}: {e}", json_path.display()))?;
    let v: Value = serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", json_path.display()))?;
    drop(text);
    let mut bytes = encode(&v);
    drop(v);
    bytes[8..16].copy_from_slice(&stamp.0.to_le_bytes());
    bytes[16..24].copy_from_slice(&stamp.1.to_le_bytes());
    if crate::env::var_os("POM_PJS_OFF").is_none() {
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write then rename, so a concurrent reader never sees half a file.
        let tmp = cache.with_extension(format!("tmp{}", std::process::id()));
        if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &cache).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    let buf: &'static [u8] = Box::leak(bytes.into_boxed_slice());
    root(buf).ok_or_else(|| "encode failed".to_string())
}

/// A compact copy of an in-memory `Value` (for data built at runtime).
pub fn from_value(v: &Value) -> J {
    let buf: &'static [u8] = Box::leak(encode(v).into_boxed_slice());
    root(buf).unwrap()
}

/// The shared compact copy of a data file: every loader of the same path gets the same buffer.
pub fn doc(json_path: &Path) -> Result<J, String> {
    static DOCS: std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf, J>>> = std::sync::OnceLock::new();
    let docs = DOCS.get_or_init(Default::default);
    if let Some(j) = docs.lock().unwrap_or_else(|e| e.into_inner()).get(json_path) {
        return Ok(*j);
    }
    let j = load(json_path)?;
    docs.lock().unwrap_or_else(|e| e.into_inner()).insert(json_path.to_path_buf(), j);
    Ok(j)
}

// ---- serde: typed structs deserialize straight from a J, as they would from the JSON text ----

#[derive(Debug)]
pub struct DeError(String);
impl std::fmt::Display for DeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DeError {}
impl serde::de::Error for DeError {
    fn custom<T: std::fmt::Display>(msg: T) -> Self {
        DeError(msg.to_string())
    }
}

struct SeqDe {
    arr: JArr,
    i: usize,
}
impl<'de> serde::de::SeqAccess<'de> for SeqDe {
    type Error = DeError;
    fn next_element_seed<T: serde::de::DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, DeError> {
        match self.arr.get(self.i) {
            Some(v) => {
                self.i += 1;
                seed.deserialize(v).map(Some)
            }
            None => Ok(None),
        }
    }
    fn size_hint(&self) -> Option<usize> {
        Some(self.arr.len() - self.i)
    }
}

struct MapDe {
    obj: JObj,
    i: usize,
}
impl<'de> serde::de::MapAccess<'de> for MapDe {
    type Error = DeError;
    fn next_key_seed<K: serde::de::DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, DeError> {
        if self.i >= self.obj.len() {
            return Ok(None);
        }
        let (k, _) = self.obj.entry(self.i);
        seed.deserialize(serde::de::value::BorrowedStrDeserializer::<DeError>::new(k)).map(Some)
    }
    fn next_value_seed<V: serde::de::DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, DeError> {
        let (_, v) = self.obj.entry(self.i);
        self.i += 1;
        seed.deserialize(v)
    }
    fn size_hint(&self) -> Option<usize> {
        Some(self.obj.len() - self.i)
    }
}

struct EnumDe {
    variant: &'static str,
    value: Option<J>,
}
impl<'de> serde::de::EnumAccess<'de> for EnumDe {
    type Error = DeError;
    type Variant = Self;
    fn variant_seed<V: serde::de::DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Self), DeError> {
        let v = seed.deserialize(serde::de::value::BorrowedStrDeserializer::<DeError>::new(self.variant))?;
        Ok((v, self))
    }
}
impl<'de> serde::de::VariantAccess<'de> for EnumDe {
    type Error = DeError;
    fn unit_variant(self) -> Result<(), DeError> {
        match self.value {
            None => Ok(()),
            Some(v) if v.is_null() => Ok(()),
            Some(_) => Err(serde::de::Error::custom("expected a unit variant")),
        }
    }
    fn newtype_variant_seed<T: serde::de::DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, DeError> {
        seed.deserialize(self.value.unwrap_or(J::NULL))
    }
    fn tuple_variant<V: serde::de::Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, DeError> {
        serde::Deserializer::deserialize_any(self.value.unwrap_or(J::NULL), visitor)
    }
    fn struct_variant<V: serde::de::Visitor<'de>>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value, DeError> {
        serde::Deserializer::deserialize_any(self.value.unwrap_or(J::NULL), visitor)
    }
}

impl<'de> serde::Deserializer<'de> for J {
    type Error = DeError;
    fn deserialize_any<V: serde::de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, DeError> {
        match self.tag() {
            0 => visitor.visit_unit(),
            1 => visitor.visit_bool(false),
            2 => visitor.visit_bool(true),
            3 => visitor.visit_u64(self.as_u64().unwrap()),
            4 => visitor.visit_i64(rd64(self.buf, self.off as usize + 1) as i64),
            5 => visitor.visit_f64(self.as_f64().unwrap()),
            6 => visitor.visit_borrowed_str(self.as_str().unwrap()),
            7 => visitor.visit_seq(SeqDe { arr: JArr(self), i: 0 }),
            _ => visitor.visit_map(MapDe { obj: JObj(self), i: 0 }),
        }
    }
    fn deserialize_option<V: serde::de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, DeError> {
        if self.is_null() {
            visitor.visit_none()
        } else {
            visitor.visit_some(self)
        }
    }
    fn deserialize_newtype_struct<V: serde::de::Visitor<'de>>(self, name: &'static str, visitor: V) -> Result<V::Value, DeError> {
        if name == CAPTURE_NAME {
            HANDED.with(|c| c.set(Some(self)));
            return visitor.visit_unit();
        }
        visitor.visit_newtype_struct(self)
    }
    fn deserialize_enum<V: serde::de::Visitor<'de>>(self, _name: &'static str, _variants: &'static [&'static str], visitor: V) -> Result<V::Value, DeError> {
        if let Some(s) = self.as_str() {
            return visitor.visit_enum(EnumDe { variant: s, value: None });
        }
        let obj = self.as_object().filter(|o| o.len() == 1).ok_or_else(|| <DeError as serde::de::Error>::custom("expected an enum"))?;
        let (k, v) = obj.entry(0);
        visitor.visit_enum(EnumDe { variant: k, value: Some(v) })
    }
    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct seq tuple tuple_struct map struct identifier ignored_any
    }
}

impl<'de> serde::de::IntoDeserializer<'de, DeError> for J {
    type Deserializer = J;
    fn into_deserializer(self) -> J {
        self
    }
}

// A `J` field inside a typed struct: read from a `J` it is that same value (no copy). From any other deserializer
// (serde_json, or the buffered content serde uses for `#[serde(flatten)]`) it is built as a `Value` and encoded.
const CAPTURE_NAME: &str = "$pom_engine::cjson::J";
thread_local! {
    static HANDED: std::cell::Cell<Option<J>> = const { std::cell::Cell::new(None) };
}
impl<'de> serde::Deserialize<'de> for J {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<J, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Option<Value>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Option<Value>, E> {
                Ok(None)
            }
            fn visit_newtype_struct<D2: serde::Deserializer<'de>>(self, d: D2) -> Result<Option<Value>, D2::Error> {
                <Value as serde::Deserialize>::deserialize(d).map(Some)
            }
        }
        match d.deserialize_newtype_struct(CAPTURE_NAME, V)? {
            Some(v) => Ok(from_value(&v)),
            None => Ok(HANDED.with(|c| c.take()).unwrap_or(J::NULL)),
        }
    }
}

/// `T` from `v`, like `serde_json::from_value(v.to_value())` without building the `Value`.
pub fn from_j<T: serde::de::DeserializeOwned>(v: J) -> Result<T, String> {
    T::deserialize(v).map_err(|e| e.0)
}

/// `T` from the shared compact copy of a data file.
pub fn read_typed<T: serde::de::DeserializeOwned>(json_path: &Path) -> Result<T, String> {
    from_j(doc(json_path)?).map_err(|e| format!("{}: {e}", json_path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        let src = r#"{"a":1,"b":-2,"c":1.5,"d":"x","e":[1,"x",null,true,false],"f":{"k1":1,"k2":2,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"k8":8,"k9":9,"k0":0},"g":18446744073709551615,"h":1.0}"#;
        let v: Value = serde_json::from_str(src).unwrap();
        let j = from_value(&v);
        assert_eq!(j.to_value(), v);
        assert_eq!(j.get("f").unwrap().get("k9").unwrap().as_i64(), Some(9));
        assert_eq!(j.get("f").unwrap().get("kx").map(|v| v.is_null()), None);
        assert_eq!(j.get("h").unwrap().as_i64(), None);
        assert_eq!(j.get("h").unwrap().as_f64(), Some(1.0));
        assert_eq!(j.get("g").unwrap().as_i64(), None);
        assert_eq!(j.get("e").unwrap().get(1).unwrap().as_str(), Some("x"));
        let back: Value = from_j(j).unwrap();
        assert_eq!(back, v);
        #[derive(serde::Deserialize)]
        struct T {
            f: J,
            #[serde(flatten)]
            rest: HashMap<String, J>,
        }
        let t: T = from_j(j).unwrap();
        assert_eq!(t.f.get("k9").unwrap().as_i64(), Some(9));
        assert!(std::ptr::eq(t.f.buf, j.buf));
        assert_eq!(t.rest["e"].to_value(), v["e"]);
        let t2: T = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(t2.f.to_value(), v["f"]);
        assert_eq!(j.get("f").unwrap().as_object().unwrap().keys().collect::<Vec<_>>(), v["f"].as_object().unwrap().keys().map(|s| s.as_str()).collect::<Vec<_>>());
    }
}
