//! Byte-exact port of the Lua 5.1 / LuaJIT pattern-matching engine (lstrlib.c), via the
//! reference implementation (function doMatch and friends). Lua
//! strings are byte strings (0..255 per element); we operate on `&[u8]` throughout and never
//! assume UTF-8. This is a direct translation of the recursive-descent matcher. The earlier JS port
//! also had a regex-compiler fast path; it is not ported here, since only correctness matters, not
//! throughput.

pub type LStr = Vec<u8>;

#[derive(Clone, Debug, PartialEq)]
pub enum Cap {
    S(Vec<u8>),
    /// 1-based byte position (Lua position capture `()`)
    P(i64),
}

impl Cap {
    pub fn as_str(&self) -> Option<&[u8]> {
        match self {
            Cap::S(s) => Some(s),
            Cap::P(_) => None,
        }
    }
}

#[derive(Debug)]
pub struct PatError(pub String);
impl std::fmt::Display for PatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for PatError {}

type R<T> = Result<T, PatError>;
fn err<T>(msg: &str) -> R<T> {
    Err(PatError(msg.to_string()))
}

const L_ESC: u8 = b'%';
const CAP_UNFINISHED: i64 = -1;
const CAP_POSITION: i64 = -2;
const MAXCCALLS: i32 = 200;
const SPECIALS: &[u8] = b"^$*+?.([%-";

fn has_specials(p: &[u8]) -> bool {
    p.iter().any(|&c| SPECIALS.contains(&c))
}

fn is_digit_c(c: u8) -> bool {
    c.is_ascii_digit()
}
fn is_upper_c(c: u8) -> bool {
    c.is_ascii_uppercase()
}
fn is_lower_c(c: u8) -> bool {
    c.is_ascii_lowercase()
}
fn is_alpha_c(c: u8) -> bool {
    is_upper_c(c) || is_lower_c(c)
}
fn is_alnum_c(c: u8) -> bool {
    is_alpha_c(c) || is_digit_c(c)
}
fn is_space_c(c: u8) -> bool {
    c == 0x20 || (0x09..=0x0d).contains(&c)
}
fn is_cntrl_c(c: u8) -> bool {
    c <= 0x1f || c == 0x7f
}
fn is_punct_c(c: u8) -> bool {
    (0x21..=0x2f).contains(&c)
        || (0x3a..=0x40).contains(&c)
        || (0x5b..=0x60).contains(&c)
        || (0x7b..=0x7e).contains(&c)
}
fn is_xdigit_c(c: u8) -> bool {
    is_digit_c(c) || (0x41..=0x46).contains(&c) || (0x61..=0x66).contains(&c)
}
fn to_lower_c(c: u8) -> u8 {
    if is_upper_c(c) {
        c + 32
    } else {
        c
    }
}

struct MatchState<'a> {
    subj: &'a [u8],
    pat: &'a [u8],
    src_init: usize,
    src_end: usize,
    p_end: usize,
    level: usize,
    cap_start: [usize; 32],
    cap_len: [i64; 32],
    matchdepth: i32,
}

fn new_match_state<'a>(subj: &'a [u8], pat: &'a [u8]) -> MatchState<'a> {
    MatchState {
        subj,
        pat,
        src_init: 0,
        src_end: subj.len(),
        p_end: pat.len(),
        level: 0,
        cap_start: [0; 32],
        cap_len: [0; 32],
        matchdepth: MAXCCALLS,
    }
}

/// Returns index just past the single pattern item starting at `p` (i.e. `classEnd`).
fn class_end(pat: &[u8], p_end: usize, mut p: usize) -> R<usize> {
    let c = pat[p];
    p += 1;
    if c == L_ESC {
        if p == p_end {
            return err("malformed pattern (ends with '%')");
        }
        return Ok(p + 1);
    }
    if c == b'[' {
        if p < pat.len() && pat[p] == b'^' {
            p += 1;
        }
        loop {
            if p == p_end {
                return err("malformed pattern (missing ']')");
            }
            let cc = pat[p];
            p += 1;
            if cc == L_ESC && p < p_end {
                p += 1;
            }
            if p >= pat.len() {
                return err("malformed pattern (missing ']')");
            }
            if pat[p] == b']' {
                break;
            }
        }
        return Ok(p + 1);
    }
    Ok(p)
}

fn match_class_single(c: u8, cl: u8) -> bool {
    let lcl = to_lower_c(cl);
    let res = match lcl {
        b'a' => is_alpha_c(c),
        b'c' => is_cntrl_c(c),
        b'd' => is_digit_c(c),
        b'l' => is_lower_c(c),
        b'p' => is_punct_c(c),
        b's' => is_space_c(c),
        b'u' => is_upper_c(c),
        b'w' => is_alnum_c(c),
        b'x' => is_xdigit_c(c),
        b'g' => c > 0x20 && c < 0x7f,
        b'z' => c == 0,
        _ => return cl == c,
    };
    if is_upper_c(cl) {
        !res
    } else {
        res
    }
}

/// p points at '[', ec points at the ']' (exclusive end used as loop bound, i.e. ec == index of ']').
fn match_bracket_class(pat: &[u8], c: u8, mut p: usize, ec: usize) -> bool {
    let mut sig = true;
    if pat[p + 1] == b'^' {
        sig = false;
        p += 1;
    }
    p += 1;
    while p < ec {
        if pat[p] == L_ESC {
            p += 1;
            if match_class_single(c, pat[p]) {
                return sig;
            }
            p += 1;
        } else if p + 2 < ec + 1 && p + 1 < pat.len() && pat[p + 1] == b'-' && p + 2 < ec {
            let lo = pat[p];
            let hi = pat[p + 2];
            p += 3;
            if lo <= c && c <= hi {
                return sig;
            }
        } else {
            if pat[p] == c {
                return sig;
            }
            p += 1;
        }
    }
    !sig
}

fn single_match(ms: &MatchState, s: usize, p: usize, ep: usize) -> bool {
    if s >= ms.src_end {
        return false;
    }
    let c = ms.subj[s];
    let pc = ms.pat[p];
    if pc == b'.' {
        return true;
    }
    if pc == L_ESC {
        return match_class_single(c, ms.pat[p + 1]);
    }
    if pc == b'[' {
        return match_bracket_class(ms.pat, c, p, ep - 1);
    }
    pc == c
}

fn match_balance(ms: &MatchState, s: usize, p: usize) -> R<Option<usize>> {
    if p >= ms.p_end.saturating_sub(1) {
        return err("missing arguments to '%b'");
    }
    if s >= ms.src_end || ms.subj[s] != ms.pat[p] {
        return Ok(None);
    }
    let b = ms.pat[p];
    let e = ms.pat[p + 1];
    let mut cont = 1i32;
    let mut ss = s;
    loop {
        ss += 1;
        if ss >= ms.src_end {
            return Ok(None);
        }
        let cc = ms.subj[ss];
        if cc == e {
            cont -= 1;
            if cont == 0 {
                return Ok(Some(ss + 1));
            }
        } else if cc == b {
            cont += 1;
        }
    }
}

fn start_capture(ms: &mut MatchState, s: usize, p: usize, what: i64) -> R<Option<usize>> {
    let level = ms.level;
    if level >= 32 {
        return err("too many captures");
    }
    ms.cap_start[level] = s;
    ms.cap_len[level] = what;
    ms.level = level + 1;
    let res = do_match(ms, s, p)?;
    if res.is_none() {
        ms.level -= 1;
    }
    Ok(res)
}

fn capture_to_close(ms: &MatchState) -> R<usize> {
    let mut level = ms.level as i64 - 1;
    while level >= 0 {
        if ms.cap_len[level as usize] == CAP_UNFINISHED {
            return Ok(level as usize);
        }
        level -= 1;
    }
    err("invalid pattern capture")
}

fn end_capture(ms: &mut MatchState, s: usize, p: usize) -> R<Option<usize>> {
    let l = capture_to_close(ms)?;
    ms.cap_len[l] = (s - ms.cap_start[l]) as i64;
    let res = do_match(ms, s, p)?;
    if res.is_none() {
        ms.cap_len[l] = CAP_UNFINISHED;
    }
    Ok(res)
}

fn check_capture(ms: &MatchState, l: i64) -> R<usize> {
    let l = l - 1;
    if l < 0 || l as usize >= ms.level || ms.cap_len[l as usize] == CAP_UNFINISHED {
        return err("invalid capture index");
    }
    Ok(l as usize)
}

fn match_capture(ms: &MatchState, s: usize, digit_code: u8) -> R<Option<usize>> {
    let l = check_capture(ms, (digit_code - b'0') as i64)?;
    let len_ = ms.cap_len[l] as usize;
    if ms.src_end - s >= len_
        && ms.subj[ms.cap_start[l]..ms.cap_start[l] + len_] == ms.subj[s..s + len_]
    {
        Ok(Some(s + len_))
    } else {
        Ok(None)
    }
}

fn max_expand(ms: &mut MatchState, s: usize, p: usize, ep: usize) -> R<Option<usize>> {
    let mut i: i64 = 0;
    while single_match(ms, s + i as usize, p, ep) {
        i += 1;
    }
    while i >= 0 {
        let res = do_match(ms, s + i as usize, ep + 1)?;
        if res.is_some() {
            return Ok(res);
        }
        i -= 1;
    }
    Ok(None)
}

fn min_expand(ms: &mut MatchState, mut s: usize, p: usize, ep: usize) -> R<Option<usize>> {
    loop {
        let res = do_match(ms, s, ep + 1)?;
        if res.is_some() {
            return Ok(res);
        } else if single_match(ms, s, p, ep) {
            s += 1;
        } else {
            return Ok(None);
        }
    }
}

fn do_match(ms: &mut MatchState, mut s: usize, mut p: usize) -> R<Option<usize>> {
    if ms.matchdepth == 0 {
        return err("pattern too complex");
    }
    ms.matchdepth -= 1;
    let result = do_match_inner(ms, &mut s, &mut p);
    ms.matchdepth += 1;
    result
}

fn do_match_inner(ms: &mut MatchState, s0: &mut usize, p0: &mut usize) -> R<Option<usize>> {
    let mut s = *s0;
    let mut p = *p0;
    loop {
        if p == ms.p_end {
            return Ok(Some(s));
        }
        let pc = ms.pat[p];
        if pc == b'(' {
            if p + 1 < ms.pat.len() && ms.pat[p + 1] == b')' {
                return start_capture(ms, s, p + 2, CAP_POSITION);
            }
            return start_capture(ms, s, p + 1, CAP_UNFINISHED);
        }
        if pc == b')' {
            return end_capture(ms, s, p + 1);
        }
        if pc == b'$' && p + 1 == ms.p_end {
            return Ok(if s == ms.src_end { Some(s) } else { None });
        }
        if pc == L_ESC {
            let nc = ms.pat[p + 1];
            if nc == b'b' {
                match match_balance(ms, s, p + 2)? {
                    Some(s2) => {
                        s = s2;
                        p += 4;
                        continue;
                    }
                    None => return Ok(None),
                }
            }
            if nc == b'f' {
                let pp = p + 2;
                if pp >= ms.pat.len() || ms.pat[pp] != b'[' {
                    return err("missing '[' after '%f' in pattern");
                }
                let ep = class_end(ms.pat, ms.p_end, pp)?;
                let previous = if s == ms.src_init { 0 } else { ms.subj[s - 1] };
                let curr = if s < ms.src_end { ms.subj[s] } else { 0 };
                if !match_bracket_class(ms.pat, previous, pp, ep - 1)
                    && match_bracket_class(ms.pat, curr, pp, ep - 1)
                {
                    p = ep;
                    continue;
                }
                return Ok(None);
            }
            if is_digit_c(nc) {
                match match_capture(ms, s, nc)? {
                    Some(s2) => {
                        s = s2;
                        p += 2;
                        continue;
                    }
                    None => return Ok(None),
                }
            }
            // fall through to default class handling
        }
        {
            let ep = class_end(ms.pat, ms.p_end, p)?;
            if !single_match(ms, s, p, ep) {
                let epc = if ep < ms.pat.len() { ms.pat[ep] } else { 0 };
                if epc == b'*' || epc == b'?' || epc == b'-' {
                    p = ep + 1;
                    continue;
                } else {
                    return Ok(None);
                }
            } else {
                let epc = if ep < ms.pat.len() { ms.pat[ep] } else { 0 };
                if epc == b'?' {
                    *s0 = s;
                    *p0 = p;
                    let res = do_match(ms, s + 1, ep + 1)?;
                    if res.is_some() {
                        return Ok(res);
                    }
                    p = ep + 1;
                    continue;
                } else if epc == b'+' {
                    return max_expand(ms, s + 1, p, ep);
                } else if epc == b'*' {
                    return max_expand(ms, s, p, ep);
                } else if epc == b'-' {
                    return min_expand(ms, s, p, ep);
                } else {
                    s += 1;
                    p = ep;
                    continue;
                }
            }
        }
    }
}

fn push_one_capture(ms: &MatchState, i: usize, s: usize, e: usize) -> R<Cap> {
    if i >= ms.level {
        if i == 0 {
            return Ok(Cap::S(ms.subj[s..e].to_vec()));
        }
        return err("invalid capture index");
    }
    let len_ = ms.cap_len[i];
    if len_ == CAP_UNFINISHED {
        return err("unfinished capture");
    }
    if len_ == CAP_POSITION {
        return Ok(Cap::P(ms.cap_start[i] as i64 + 1));
    }
    let start = ms.cap_start[i];
    Ok(Cap::S(ms.subj[start..start + len_ as usize].to_vec()))
}

fn push_captures(ms: &MatchState, s: Option<usize>, e: Option<usize>) -> R<Vec<Cap>> {
    let nlevels = if ms.level == 0 && s.is_some() { 1 } else { ms.level };
    let mut out = Vec::with_capacity(nlevels);
    for i in 0..nlevels {
        out.push(push_one_capture(ms, i, s.unwrap_or(0), e.unwrap_or(0))?);
    }
    Ok(out)
}

fn posrelat(pos: i64, len: usize) -> i64 {
    if pos >= 0 {
        pos
    } else if -pos > len as i64 {
        0
    } else {
        len as i64 + pos + 1
    }
}

pub struct FindResult {
    pub start: i64, // 1-based
    pub end: i64,   // 1-based inclusive
    pub caps: Vec<Cap>,
}

/// `string.find`. `init` is 1-based (Lua convention), may be negative. `plain` disables pattern
/// interpretation.
pub fn find(s: &[u8], pat: &[u8], init: Option<i64>, plain: bool) -> R<Option<FindResult>> {
    let l1 = s.len();
    let init_pos_raw = posrelat(init.unwrap_or(1), l1);
    let init_pos = if init_pos_raw < 1 {
        1
    } else if init_pos_raw > l1 as i64 + 1 {
        return Ok(None);
    } else {
        init_pos_raw
    };
    let init0 = (init_pos - 1) as usize;

    if plain || !has_specials(pat) {
        if pat.is_empty() {
            if init0 <= s.len() {
                return Ok(Some(FindResult { start: init0 as i64 + 1, end: init0 as i64, caps: vec![] }));
            }
            return Ok(None);
        }
        if let Some(idx) = find_subslice(&s[init0.min(s.len())..], pat) {
            let idx = idx + init0.min(s.len());
            return Ok(Some(FindResult {
                start: idx as i64 + 1,
                end: (idx + pat.len()) as i64,
                caps: vec![],
            }));
        }
        return Ok(None);
    }

    let mut anchor = false;
    let mut p = pat;
    if !p.is_empty() && p[0] == b'^' {
        anchor = true;
        p = &p[1..];
    }

    let mut ms = new_match_state(s, p);
    let mut s1 = init0;
    loop {
        ms.level = 0;
        ms.matchdepth = MAXCCALLS;
        let res = do_match(&mut ms, s1, 0)?;
        if let Some(e) = res {
            let caps = push_captures(&ms, None, None)?;
            return Ok(Some(FindResult { start: s1 as i64 + 1, end: e as i64, caps }));
        }
        s1 += 1;
        if !(s1 <= ms.src_end && !anchor) {
            break;
        }
    }
    Ok(None)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `string.match`. Returns None if no match, else the list of captures (or, if there were no
/// explicit captures, a 1-element vec containing the whole match as Cap::S).
pub fn lmatch(s: &[u8], pat: &[u8], init: Option<i64>) -> R<Option<Vec<Cap>>> {
    let l1 = s.len();
    let init_pos_raw = posrelat(init.unwrap_or(1), l1);
    let init_pos = if init_pos_raw < 1 {
        1
    } else if init_pos_raw > l1 as i64 + 1 {
        return Ok(None);
    } else {
        init_pos_raw
    };
    let init0 = (init_pos - 1) as usize;

    let mut anchor = false;
    let mut p = pat;
    if !p.is_empty() && p[0] == b'^' {
        anchor = true;
        p = &p[1..];
    }

    let mut ms = new_match_state(s, p);
    let mut s1 = init0;
    loop {
        ms.level = 0;
        ms.matchdepth = MAXCCALLS;
        let res = do_match(&mut ms, s1, 0)?;
        if let Some(e) = res {
            let caps = push_captures(&ms, Some(s1), Some(e))?;
            return Ok(Some(caps));
        }
        s1 += 1;
        if !(s1 <= ms.src_end && !anchor) {
            break;
        }
    }
    Ok(None)
}

pub struct GMatch<'a> {
    subj: &'a [u8],
    pat: &'a [u8],
    next_start: usize,
}

pub fn gmatch<'a>(s: &'a [u8], pat: &'a [u8]) -> GMatch<'a> {
    GMatch { subj: s, pat, next_start: 0 }
}

impl<'a> GMatch<'a> {
    pub fn next(&mut self) -> R<Option<Vec<Cap>>> {
        let mut ms = new_match_state(self.subj, self.pat);
        let mut src = self.next_start;
        while src <= ms.src_end {
            ms.level = 0;
            ms.matchdepth = MAXCCALLS;
            let e = do_match(&mut ms, src, 0)?;
            if let Some(e) = e {
                self.next_start = if e == src { e + 1 } else { e };
                let caps = push_captures(&ms, Some(src), Some(e))?;
                return Ok(Some(caps));
            }
            src += 1;
        }
        Ok(None)
    }
}

pub enum Repl<'a> {
    Str(&'a [u8]),
    /// Called with the captures of each match; returning None means "keep the whole match
    /// unchanged" (Lua: false/nil/nothing returned from the function).
    Func(&'a mut dyn FnMut(&[Cap]) -> Option<Vec<u8>>),
}

fn add_s(ms: &MatchState, s: usize, e: usize, news: &[u8]) -> R<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0;
    let l = news.len();
    while i < l {
        let c = news[i];
        if c != L_ESC {
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        if i >= l {
            out.push(0);
            continue;
        }
        let nc = news[i];
        if !is_digit_c(nc) {
            out.push(nc);
            i += 1;
            continue;
        }
        if nc == b'0' {
            out.extend_from_slice(&ms.subj[s..e]);
            i += 1;
            continue;
        }
        let cap = push_one_capture(ms, (nc - b'1') as usize, s, e)?;
        match cap {
            Cap::S(v) => out.extend_from_slice(&v),
            Cap::P(p) => out.extend_from_slice(p.to_string().as_bytes()),
        }
        i += 1;
    }
    Ok(out)
}

/// `string.gsub`. Returns (result, count).
pub fn gsub(s: &[u8], pat: &[u8], mut repl: Repl, max_n: Option<i64>) -> R<(Vec<u8>, i64)> {
    let srcl = s.len();
    let max_s = max_n.unwrap_or(srcl as i64 + 1);
    let mut anchor = false;
    let mut p = pat;
    if !p.is_empty() && p[0] == b'^' {
        anchor = true;
        p = &p[1..];
    }

    let mut ms = new_match_state(s, p);
    let mut src = 0usize;
    let mut n: i64 = 0;
    let mut out: Vec<u8> = Vec::new();
    while n < max_s && src <= ms.src_end {
        ms.level = 0;
        ms.matchdepth = MAXCCALLS;
        let e = do_match(&mut ms, src, 0)?;
        if let Some(e) = e {
            n += 1;
            let piece = match &mut repl {
                Repl::Str(news) => add_s(&ms, src, e, news)?,
                Repl::Func(f) => {
                    let caps = push_captures(&ms, Some(src), Some(e))?;
                    match f(&caps) {
                        Some(v) => v,
                        None => ms.subj[src..e].to_vec(),
                    }
                }
            };
            out.extend_from_slice(&piece);
            if e == src {
                if src < ms.src_end {
                    out.push(s[src]);
                }
                src = e + 1;
            } else {
                src = e;
            }
        } else if src < ms.src_end {
            out.push(s[src]);
            src += 1;
        } else {
            break;
        }
        if anchor {
            break;
        }
    }
    out.extend_from_slice(&s[src.min(s.len())..]);
    Ok((out, n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(s: &str, p: &str) -> Option<(i64, i64)> {
        find(s.as_bytes(), p.as_bytes(), None, false).unwrap().map(|r| (r.start, r.end))
    }
    fn m(s: &str, p: &str) -> Option<Vec<String>> {
        lmatch(s.as_bytes(), p.as_bytes(), None).unwrap().map(|caps| {
            caps.into_iter()
                .map(|c| match c {
                    Cap::S(v) => String::from_utf8(v).unwrap(),
                    Cap::P(p) => p.to_string(),
                })
                .collect()
        })
    }

    #[test]
    fn literal_find() {
        assert_eq!(f("hello world", "world"), Some((7, 11)));
        assert_eq!(f("hello world", "xyz"), None);
    }

    #[test]
    fn anchors() {
        assert_eq!(f("hello", "^hello$"), Some((1, 5)));
        assert_eq!(f("hello!", "^hello$"), None);
        assert_eq!(f("hello", "^ello"), None);
    }

    #[test]
    fn char_classes() {
        assert_eq!(m("abc123", "%a+"), Some(vec!["abc".to_string()]));
        assert_eq!(m("abc123", "%d+"), Some(vec!["123".to_string()]));
        assert_eq!(m("  hi", "%s+"), Some(vec!["  ".to_string()]));
        assert_eq!(m("HELLO", "%u+"), Some(vec!["HELLO".to_string()]));
        assert_eq!(m("hello", "%l+"), Some(vec!["hello".to_string()]));
        assert_eq!(m("a b", "%w+"), Some(vec!["a".to_string()]));
    }

    #[test]
    fn quantifiers() {
        assert_eq!(m("aaa", "a*"), Some(vec!["aaa".to_string()]));
        assert_eq!(m("", "a*"), Some(vec!["".to_string()]));
        assert_eq!(m("aaa", "a-"), Some(vec!["".to_string()])); // lazy: shortest
        assert_eq!(m("aaa", "a-$"), Some(vec!["aaa".to_string()]));
        assert_eq!(m("color", "colou?r"), Some(vec!["color".to_string()]));
        assert_eq!(m("colour", "colou?r"), Some(vec!["colour".to_string()]));
    }

    #[test]
    fn captures() {
        assert_eq!(m("key=value", "(%a+)=(%a+)"), Some(vec!["key".to_string(), "value".to_string()]));
    }

    #[test]
    fn position_capture() {
        assert_eq!(m("hello", "()ll"), Some(vec!["3".to_string()]));
    }

    #[test]
    fn balanced_match() {
        assert_eq!(m("(foo(bar))baz", "%b()"), Some(vec!["(foo(bar))".to_string()]));
    }

    #[test]
    fn frontier_pattern() {
        // %f[set] matches the empty string at a transition into `set`
        assert_eq!(
            m("THE (quick) fox", "%f[%a]%u+%f[%A]"),
            Some(vec!["THE".to_string()])
        );
    }

    #[test]
    fn backreference() {
        assert_eq!(m("abcabc", "(abc)%1"), Some(vec!["abc".to_string()]));
        assert_eq!(m("abcabd", "(abc)%1"), None);
    }

    #[test]
    fn bracket_set() {
        assert_eq!(m("hello world", "[%a ]+"), Some(vec!["hello world".to_string()]));
        assert_eq!(m("abc123", "[^%d]+"), Some(vec!["abc".to_string()]));
        assert_eq!(m("a-z", "[a%-z]+"), Some(vec!["a-z".to_string()]));
    }

    #[test]
    fn gmatch_iter() {
        let s = b"one two three";
        let mut it = gmatch(s, b"%a+");
        let mut out = Vec::new();
        while let Some(caps) = it.next().unwrap() {
            if let Cap::S(v) = &caps[0] {
                out.push(String::from_utf8(v.clone()).unwrap());
            }
        }
        assert_eq!(out, vec!["one", "two", "three"]);
    }

    #[test]
    fn gsub_str_repl() {
        let (out, n) = gsub(b"hello world", b"o", Repl::Str(b"0"), None).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "hell0 w0rld");
        assert_eq!(n, 2);
    }

    #[test]
    fn gsub_capture_repl() {
        let (out, n) = gsub(b"hello world", b"(%a+)", Repl::Str(b"<%1>"), None).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "<hello> <world>");
        assert_eq!(n, 2);
    }

    #[test]
    fn gsub_func_repl() {
        let (out, n) = gsub(
            b"abc",
            b"%a",
            Repl::Func(&mut |caps| {
                if let Cap::S(v) = &caps[0] {
                    Some(v.to_ascii_uppercase())
                } else {
                    None
                }
            }),
            None,
        )
        .unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "ABC");
        assert_eq!(n, 3);
    }

    #[test]
    fn gsub_max_n() {
        let (out, n) = gsub(b"aaaa", b"a", Repl::Str(b"b"), Some(2)).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "bbaa");
        assert_eq!(n, 2);
    }

    #[test]
    fn firsttoupper_like() {
        // Lua's firstToUpper: gsub of "^%l" with string.upper.
        let (out, _) = gsub(b"hello", b"^%l", Repl::Func(&mut |caps| {
            if let Cap::S(v) = &caps[0] {
                Some(v.to_ascii_uppercase())
            } else {
                None
            }
        }), None).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "Hello");
    }

    #[test]
    fn find_with_init() {
        assert_eq!(f("hello hello", "hello"), Some((1, 5)));
        assert_eq!(
            find(b"hello hello", b"hello", Some(2), false).unwrap().map(|r| (r.start, r.end)),
            Some((7, 11))
        );
    }

    #[test]
    fn plain_find_with_specials() {
        assert_eq!(
            find(b"1+1=2", b"1+1", None, true).unwrap().map(|r| (r.start, r.end)),
            Some((1, 3))
        );
    }
}
