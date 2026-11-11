// Port of Modules/CalcOffence.lua:156-178 (calcAreaMod, calcRadius) - pure integer-rounding math,
// no ModStore access. calcRadiusBreakpoints/calcMoltenStrikeTertiaryRadius/
// setMoltenStrikeTertiaryRadiusBreakdown (lines 180-294) are breakdown-only (UI tooltip text, next
// mod-percent-to-next-breakpoint) and are not ported: they never feed a gradable `output` field.

/// `calcAreaMod(incArea, moreArea)` (CalcOffence.lua:160-166). The client rounds increased-area
/// and more-area to whole percent *separately* before multiplying, then floors (or ceils, for a
/// negative combined percent) the product - reproduced exactly, including the two intermediate
/// `roundSymmetric` calls.
pub fn calc_area_mod(inc_area: f64, more_area: f64) -> f64 {
    let base_area_percent = round_symmetric(inc_area * 100.0);
    let final_area_percent = round_symmetric(more_area.max(0.0) * 100.0);
    let mut area_percent = base_area_percent * final_area_percent / 100.0;
    area_percent = if area_percent >= 0.0 { area_percent.floor() } else { area_percent.ceil() };
    area_percent.max(0.0) / 100.0
}

/// `calcRadius(baseRadius, areaMod, radiusMod)` (CalcOffence.lua:173-178).
pub fn calc_radius(base_radius: f64, area_mod: f64, radius_mod: Option<f64>) -> f64 {
    let mut radius_percent = (100.0 * area_mod.sqrt()).floor();
    radius_percent = (radius_percent * radius_mod.unwrap_or(1.0)).floor();
    (base_radius * radius_percent / 100.0).floor()
}

/// Lua `round(v)`: round-half-away-from-zero to the nearest integer (Modules/Common.lua). Used by
/// `roundSymmetric` for area-percent rounding; kept as its own function since other ports in this
/// workspace already name it the same way (see crates/calc's use of `round`/`roundSymmetric`).
pub fn round_symmetric(v: f64) -> f64 {
    if v >= 0.0 { (v + 0.5).floor() } else { (v - 0.5).ceil() }
}

/// Lua `round(v)` with no `dec` argument (Modules/Common.lua:709-715): `math.floor(v + 0.5)`,
/// always - not symmetric around zero. Used throughout calcDamage for the final min/max damage
/// rounding.
pub fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `calcRadiusBreakpoints(baseRadius, incArea, moreArea, radiusMod)` (CalcOffence.lua:198-224), breakdown only: the
/// next increased/more and previous reduced/less area breakpoints `(inc, more, red, less)`, or None (all nil) when the
/// radius is 0.
pub fn calc_radius_breakpoints(base_radius: f64, inc_area: f64, more_area: f64, radius_mod: Option<f64>) -> Option<(f64, f64, f64, f64)> {
    let radius = calc_radius(base_radius, calc_area_mod(inc_area, more_area), radius_mod);
    if !(radius > 0.0) {
        return None;
    }
    let search = |f: &dyn Fn(f64) -> f64, up: bool| -> f64 {
        let mut n = 0.0;
        loop {
            n += 1.0;
            let r = f(n);
            if (up && r > radius) || (!up && r < radius) || n > 1e6 {
                return n;
            }
        }
    };
    let inc = search(&|n| calc_radius(base_radius, calc_area_mod(inc_area + n / 100.0, more_area), radius_mod), true);
    let red = search(&|n| calc_radius(base_radius, calc_area_mod(inc_area - n / 100.0, more_area), radius_mod), false);
    let more = search(&|n| calc_radius(base_radius, calc_area_mod(inc_area, more_area * (1.0 + n / 100.0)), radius_mod), true);
    let less = search(&|n| calc_radius(base_radius, calc_area_mod(inc_area, more_area * (1.0 - n / 100.0)), radius_mod), false);
    Some((inc, more, red, less))
}
