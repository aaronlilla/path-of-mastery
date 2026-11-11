//! `string.format`, the subset ModParser.lua actually calls: %d/%i, %s, %g/%G, %f/%F, %x/%X,
//! %o, %u, %c, %q, %e/%E, with flags/width/precision. Integer conversions truncate toward zero
//! at normal (non-overflowing) magnitudes, which is all mod-value formatting ever needs.
use super::numeric::num_text_g;

#[derive(Clone)]
pub enum Arg {
    Num(f64),
    Str(String),
}

pub struct FmtError(pub String);

fn pad(body_no_sign: &str, sign: &str, width: usize, left: bool, zero: bool, numeric: bool, has_precision: bool) -> String {
    let total_len = sign.len() + body_no_sign.len();
    if total_len >= width {
        return format!("{}{}", sign, body_no_sign);
    }
    let fill = width - total_len;
    if left {
        format!("{}{}{}", sign, body_no_sign, " ".repeat(fill))
    } else if zero && numeric && !has_precision {
        format!("{}{}{}", sign, "0".repeat(fill), body_no_sign)
    } else {
        format!("{}{}{}", " ".repeat(fill), sign, body_no_sign)
    }
}

fn sign_for(neg: bool, plus: bool, space: bool) -> String {
    if neg {
        "-".to_string()
    } else if plus {
        "+".to_string()
    } else if space {
        " ".to_string()
    } else {
        String::new()
    }
}

fn trunc_i64(x: f64) -> i64 {
    if !x.is_finite() {
        return i64::MIN;
    }
    let t = x.trunc();
    if t >= 9.223372036854776e18 {
        i64::MAX
    } else if t < -9.223372036854776e18 {
        i64::MIN
    } else {
        t as i64
    }
}

fn trunc_u64(x: f64) -> u64 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    if t < 0.0 {
        trunc_i64(x) as u64
    } else if t >= 1.8446744073709552e19 {
        u64::MAX
    } else {
        t as u64
    }
}

pub fn format(fmt: &str, args: &[Arg]) -> Result<String, FmtError> {
    let fb = fmt.as_bytes();
    let mut out = String::new();
    let mut i = 0usize;
    let mut argi = 0usize;
    let mut next_arg = || -> Option<Arg> {
        let a = args.get(argi).cloned();
        argi += 1;
        a
    };
    let n = fb.len();
    while i < n {
        if fb[i] != b'%' {
            out.push(fb[i] as char);
            i += 1;
            continue;
        }
        i += 1;
        if i >= n {
            return Err(FmtError("invalid conversion '%' to 'format'".into()));
        }
        if fb[i] == b'%' {
            out.push('%');
            i += 1;
            continue;
        }
        let mut left = false;
        let mut plus = false;
        let mut space = false;
        let mut alt = false;
        let mut zero = false;
        while i < n && matches!(fb[i], b'-' | b'+' | b' ' | b'#' | b'0') {
            match fb[i] {
                b'-' => left = true,
                b'+' => plus = true,
                b' ' => space = true,
                b'#' => alt = true,
                b'0' => zero = true,
                _ => unreachable!(),
            }
            i += 1;
        }
        let mut width = 0usize;
        while i < n && fb[i].is_ascii_digit() {
            width = width * 10 + (fb[i] - b'0') as usize;
            i += 1;
        }
        let mut precision: Option<usize> = None;
        if i < n && fb[i] == b'.' {
            i += 1;
            let mut p = 0usize;
            while i < n && fb[i].is_ascii_digit() {
                p = p * 10 + (fb[i] - b'0') as usize;
                i += 1;
            }
            precision = Some(p);
        }
        if i >= n {
            return Err(FmtError("invalid conversion to 'format'".into()));
        }
        let conv = fb[i] as char;
        i += 1;
        let get_num = |a: Option<Arg>| -> Result<f64, FmtError> {
            match a {
                Some(Arg::Num(x)) => Ok(x),
                Some(Arg::Str(s)) => s.parse::<f64>().map_err(|_| FmtError("bad argument to 'format' (number expected)".into())),
                None => Err(FmtError("bad argument to 'format' (no value)".into())),
            }
        };
        match conv {
            'd' | 'i' => {
                let x = get_num(next_arg())?;
                let v = trunc_i64(x);
                let neg = v < 0;
                let mut digits = if neg { (v as i128).unsigned_abs().to_string() } else { v.to_string() };
                let has_prec = precision.is_some();
                if let Some(p) = precision {
                    if p == 0 && v == 0 {
                        digits.clear();
                    } else if digits.len() < p {
                        digits = format!("{}{}", "0".repeat(p - digits.len()), digits);
                    }
                }
                out.push_str(&pad(&digits, &sign_for(neg, plus, space), width, left, zero, true, has_prec));
            }
            'u' => {
                let x = get_num(next_arg())?;
                let v = trunc_u64(x);
                let mut digits = v.to_string();
                let has_prec = precision.is_some();
                if let Some(p) = precision {
                    if p == 0 && v == 0 {
                        digits.clear();
                    } else if digits.len() < p {
                        digits = format!("{}{}", "0".repeat(p - digits.len()), digits);
                    }
                }
                out.push_str(&pad(&digits, "", width, left, zero, true, has_prec));
            }
            'x' | 'X' => {
                let x = get_num(next_arg())?;
                let v = trunc_u64(x);
                let mut digits = if conv == 'X' { format!("{:X}", v) } else { format!("{:x}", v) };
                let has_prec = precision.is_some();
                if let Some(p) = precision {
                    if p == 0 && v == 0 {
                        digits.clear();
                    } else if digits.len() < p {
                        digits = format!("{}{}", "0".repeat(p - digits.len()), digits);
                    }
                }
                let prefix = if alt && v != 0 { if conv == 'X' { "0X" } else { "0x" } } else { "" };
                out.push_str(&pad(&format!("{}{}", prefix, digits), "", width, left, zero, true, has_prec));
            }
            'o' => {
                let x = get_num(next_arg())?;
                let v = trunc_u64(x);
                let mut digits = format!("{:o}", v);
                let has_prec = precision.is_some();
                if let Some(p) = precision {
                    if p == 0 && v == 0 {
                        digits.clear();
                    } else if digits.len() < p {
                        digits = format!("{}{}", "0".repeat(p - digits.len()), digits);
                    }
                }
                if alt && !digits.starts_with('0') {
                    digits = format!("0{}", digits);
                }
                out.push_str(&pad(&digits, "", width, left, zero, true, has_prec));
            }
            'c' => {
                let x = get_num(next_arg())?;
                let v = trunc_i64(x);
                let byte_val = (((v % 256) + 256) % 256) as u8;
                out.push_str(&pad(&(byte_val as char).to_string(), "", width, left, false, false, false));
            }
            'f' | 'F' => {
                let x = get_num(next_arg())?;
                let prec = precision.unwrap_or(6);
                if x.is_nan() || x.is_infinite() {
                    let (neg, body) = special_text(x, conv == 'F');
                    out.push_str(&pad(&body, &sign_for_special(x.is_nan(), neg, plus, space), width, left, false, false, false));
                    continue;
                }
                let neg = x.is_sign_negative();
                let mut text = format!("{:.*}", prec, x.abs());
                if prec == 0 && alt && !text.contains('.') {
                    text.push('.');
                }
                out.push_str(&pad(&text, &sign_for(neg, plus, space), width, left, zero, true, false));
            }
            'e' | 'E' => {
                let x = get_num(next_arg())?;
                let prec = precision.unwrap_or(6);
                if x.is_nan() || x.is_infinite() {
                    let (neg, body) = special_text(x, conv == 'E');
                    out.push_str(&pad(&body, &sign_for_special(x.is_nan(), neg, plus, space), width, left, false, false, false));
                    continue;
                }
                let neg = x.is_sign_negative();
                let text = num_text_e(x.abs(), prec, alt, conv == 'E');
                out.push_str(&pad(&text, &sign_for(neg, plus, space), width, left, zero, true, false));
            }
            'g' | 'G' => {
                let x = get_num(next_arg())?;
                let prec = precision.unwrap_or(6);
                if x.is_nan() || x.is_infinite() {
                    let (neg, body) = special_text(x, conv == 'G');
                    out.push_str(&pad(&body, &sign_for_special(x.is_nan(), neg, plus, space), width, left, false, false, false));
                    continue;
                }
                let neg = x.is_sign_negative();
                let text = num_text_g(x.abs(), prec, alt, conv == 'G');
                out.push_str(&pad(&text, &sign_for(neg, plus, space), width, left, zero, true, false));
            }
            's' => {
                let a = next_arg();
                let mut s = match a {
                    Some(Arg::Str(s)) => s,
                    Some(Arg::Num(x)) => super::numeric::fmtnum14g(x),
                    None => return Err(FmtError("bad argument to 'format' (no value)".into())),
                };
                if let Some(p) = precision {
                    s.truncate(p);
                }
                out.push_str(&pad(&s, "", width, left, false, false, false));
            }
            'q' => {
                let a = next_arg();
                let s = match a {
                    Some(Arg::Str(s)) => s,
                    Some(Arg::Num(x)) => super::numeric::fmtnum14g(x),
                    None => return Err(FmtError("bad argument to 'format' (no value)".into())),
                };
                out.push('"');
                for c in s.chars() {
                    match c {
                        '"' | '\\' => {
                            out.push('\\');
                            out.push(c);
                        }
                        '\n' => out.push_str("\\\n"),
                        c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                            out.push('\\');
                            out.push_str(&(c as u32).to_string());
                        }
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            _ => return Err(FmtError(format!("invalid option '%{}' to 'format'", conv))),
        }
    }
    Ok(out)
}

fn special_text(x: f64, upper: bool) -> (bool, String) {
    let neg = x.is_sign_negative();
    let body = if x.is_nan() { "nan".to_string() } else { "inf".to_string() };
    (neg, if upper { body.to_uppercase() } else { body })
}
fn sign_for_special(is_nan: bool, neg: bool, plus: bool, space: bool) -> String {
    if is_nan {
        if space { " ".to_string() } else { String::new() }
    } else {
        sign_for(neg, plus, space)
    }
}

fn num_text_e(ax: f64, prec: usize, alt: bool, upper: bool) -> String {
    if ax == 0.0 {
        let digits = "0".repeat(prec + 1);
        return finish_e(&digits, 0, prec, alt, upper);
    }
    let s = format!("{:.*e}", prec, ax);
    let (mant, exp_str) = s.split_once('e').unwrap();
    let exp: i32 = exp_str.parse().unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    finish_e(&digits, exp, prec, alt, upper)
}
fn finish_e(digits: &str, exp10: i32, prec: usize, alt: bool, upper: bool) -> String {
    let mut out = digits[0..1].to_string();
    if prec > 0 {
        out.push('.');
        out.push_str(&digits[1..]);
    } else if alt {
        out.push('.');
    }
    let sign = if exp10 < 0 { '-' } else { '+' };
    let a = exp10.unsigned_abs();
    out.push('e');
    out.push(sign);
    if a < 10 {
        out.push('0');
    }
    out.push_str(&a.to_string());
    if upper {
        out.to_uppercase()
    } else {
        out
    }
}
