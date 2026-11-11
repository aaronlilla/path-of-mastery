// Port of ModParser.lua's local `scan(line, patternList, plain)`: finds, among every pattern in
// the list, the match starting earliest in the (lowercased) line; ties broken by longest match,
// then by longest pattern text. Returns the matched value, the line with the matched span cut
// out, and up to 5 captures (Lua's scan() only ever reads cap1..cap5).
use crate::luapat::{self, Cap};

pub struct ScanResult<'v, V> {
    pub val: &'v V,
    pub remaining: Vec<u8>,
    pub caps: [Option<Cap>; 5],
}

pub fn scan<'v, P: AsRef<str>, V>(line: &[u8], list: &'v [(P, V)], plain: bool) -> Option<ScanResult<'v, V>> {
    let line_lower = line.to_ascii_lowercase();
    let mut best: Option<(i64, i64, usize, usize)> = None; // (start, end, pattern_len, index)
    for (i, (pat, _)) in list.iter().enumerate() {
        let p = pat.as_ref();
        let r = luapat::find(&line_lower, p.as_bytes(), Some(1), plain)
            .unwrap_or_else(|e| panic!("bad pattern {:?}: {}", p, e));
        if let Some(fr) = r {
            let plen = p.len();
            let better = match best {
                None => true,
                Some((bi, be, bp, _)) => {
                    fr.start < bi || (fr.start == bi && (fr.end > be || (fr.end == be && plen > bp)))
                }
            };
            if better {
                best = Some((fr.start, fr.end, plen, i));
            }
        }
    }
    let (start, end, _, i) = best?;
    let (pat, val) = &list[i];
    let fr = luapat::find(&line_lower, pat.as_ref().as_bytes(), Some(1), plain).unwrap().unwrap();
    let mut caps: [Option<Cap>; 5] = [None, None, None, None, None];
    for (k, c) in fr.caps.into_iter().take(5).enumerate() {
        caps[k] = Some(c);
    }
    let mut remaining = Vec::with_capacity(line.len());
    remaining.extend_from_slice(&line[0..(start as usize - 1)]);
    remaining.extend_from_slice(&line[(end as usize)..]);
    Some(ScanResult { val, remaining, caps })
}

pub fn cap_str(c: &Option<Cap>) -> Option<String> {
    match c {
        Some(Cap::S(v)) => Some(String::from_utf8_lossy(v).into_owned()),
        Some(Cap::P(p)) => Some(p.to_string()),
        None => None,
    }
}
