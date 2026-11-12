//! tostring/%.14g and tonumber, matching LuaJIT's str2number / lj_strfmt_wg014 for the value
//! ranges ModParser actually sees (stat magnitudes, not denormals or numbers near f64 limits).
//! Uses Rust's own correctly-rounded float formatting instead of re-deriving a bignum decimal
//! converter, since such a path would exist only to match glibc/LuaJIT
//! rounding at extreme magnitudes that never occur in game data.

/// Lua's `tonumber(s)` (no base argument): decimal or 0x-hex, optional sign, surrounding
/// whitespace allowed. Returns None if `s` is not a clean number token.
pub fn tonumber(s: &str) -> Option<f64> {
    let t = s.trim_matches(|c: char| c == ' ' || c == '\t' || c == '\n' || c == '\x0b' || c == '\x0c' || c == '\r');
    if t.is_empty() {
        return None;
    }
    let (neg, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    if body.is_empty() {
        return None;
    }
    let lb = body.to_ascii_lowercase();
    if lb == "inf" || lb == "infinity" || lb == "nan" {
        return None; // LuaJIT's tonumber rejects these tokens
    }
    let v = if lb.starts_with("0x") {
        parse_hex_float(&body[2..])?
    } else {
        if !body.chars().all(|c| c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
            return None;
        }
        // Reject forms Rust's parser accepts but Lua doesn't (e.g. "inf", already handled) and
        // things like a bare "." or "e5" with no digits.
        if !body.chars().any(|c| c.is_ascii_digit()) {
            return None;
        }
        body.parse::<f64>().ok()?
    };
    Some(if neg { -v } else { v })
}

fn parse_hex_float(body: &str) -> Option<f64> {
    // "<hexdigits>[.<hexdigits>][p[+-]<decdigits>]"
    let (mantissa_part, exp_part) = match body.to_ascii_lowercase().find('p') {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (ip, fp) = match mantissa_part.find('.') {
        Some(i) => (&mantissa_part[..i], &mantissa_part[i + 1..]),
        None => (mantissa_part, ""),
    };
    if ip.is_empty() && fp.is_empty() {
        return None;
    }
    let mut v: f64 = 0.0;
    if !ip.is_empty() {
        v = i64::from_str_radix(ip, 16).ok()? as f64;
    }
    for (i, c) in fp.chars().enumerate() {
        let d = c.to_digit(16)? as f64;
        v += d / 16f64.powi(i as i32 + 1);
    }
    let exp: i32 = match exp_part {
        Some(e) => e.parse().ok()?,
        None => 0,
    };
    Some(v * 2f64.powi(exp))
}

fn fmt_exp(exp10: i32) -> String {
    let sign = if exp10 < 0 { '-' } else { '+' };
    let a = exp10.unsigned_abs();
    if a < 10 {
        format!("e{}0{}", sign, a)
    } else {
        format!("e{}{}", sign, a)
    }
}

/// Digits (as `sig` decimal characters, no point) and base-10 exponent of `ax` (ax > 0, finite)
/// rounded to `sig` significant figures, i.e. what `%.{sig-1}e` would print.
fn sci_digits(ax: f64, sig: usize) -> (String, i32) {
    if ax == 0.0 {
        return ("0".repeat(sig), 0);
    }
    let s = format!("{:.*e}", sig - 1, ax);
    let (mant, exp_str) = s.split_once('e').expect("Rust exponential format always has 'e'");
    let exp: i32 = exp_str.parse().expect("exponent is always a plain integer");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    (digits, exp)
}

pub fn num_text_g(ax: f64, prec: usize, alt: bool, upper: bool) -> String {
    let prec = if prec == 0 { 1 } else { prec };
    let (digits, exp10) = sci_digits(ax, prec);
    let out = if exp10 < -4 || exp10 >= prec as i32 {
        let mut rest = digits[1..].to_string();
        if !alt {
            rest = rest.trim_end_matches('0').to_string();
        }
        let mantissa = if !rest.is_empty() {
            format!("{}.{}", &digits[0..1], rest)
        } else if alt {
            format!("{}.", &digits[0..1])
        } else {
            digits[0..1].to_string()
        };
        format!("{}{}", mantissa, fmt_exp(exp10))
    } else {
        let (int_part, mut frac_part) = if exp10 >= 0 {
            let cut = (exp10 as usize + 1).min(digits.len());
            (digits[0..cut].to_string(), digits[cut..].to_string())
        } else {
            ("0".to_string(), format!("{}{}", "0".repeat((-exp10 - 1) as usize), digits))
        };
        if !alt {
            frac_part = frac_part.trim_end_matches('0').to_string();
        }
        if !frac_part.is_empty() {
            format!("{}.{}", int_part, frac_part)
        } else if alt {
            format!("{}.", int_part)
        } else {
            int_part
        }
    };
    if upper {
        out.to_uppercase()
    } else {
        out
    }
}

/// `tostring(number)` / string concatenation of a number, i.e. `%.14g`.
pub fn fmtnum14g(x: f64) -> String {
    if x.is_nan() {
        return "nan".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".to_string() } else { "-inf".to_string() };
    }
    let neg = x.is_sign_negative();
    let s = num_text_g(x.abs(), 14, false, false);
    if neg {
        format!("-{}", s)
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers() {
        assert_eq!(fmtnum14g(5.0), "5");
        assert_eq!(fmtnum14g(-5.0), "-5");
        assert_eq!(fmtnum14g(0.0), "0");
    }

    #[test]
    fn decimals() {
        assert_eq!(fmtnum14g(1.5), "1.5");
        assert_eq!(fmtnum14g(0.1), "0.1");
        assert_eq!(fmtnum14g(100.0), "100");
        assert_eq!(fmtnum14g(20.5), "20.5");
    }

    #[test]
    fn tonumber_basic() {
        assert_eq!(tonumber("5"), Some(5.0));
        assert_eq!(tonumber("  5  "), Some(5.0));
        assert_eq!(tonumber("-3.5"), Some(-3.5));
        assert_eq!(tonumber("+3.5"), Some(3.5));
        assert_eq!(tonumber("abc"), None);
        assert_eq!(tonumber(""), None);
        assert_eq!(tonumber("0x1A"), Some(26.0));
    }
}
