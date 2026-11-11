use crate::timeless::*;

#[test]
fn lua_numbers_print_like_tostring() {
    assert_eq!(lua_num_str(71.0), "71");
    assert_eq!(lua_num_str(43.5), "43.5");
    assert_eq!(lua_num_str(6.1000000000000005), "6.1");
    assert_eq!(lua_num_str(0.1 + 0.2), "0.3");
    assert_eq!(lua_num_str(1e20), "1e+20");
}

/// Strings printed by LuaJIT 2.1 (`luajit` 2.1.1720049189) for `formatSearchValue`'s code, which zero-pads `%006.2f`.
#[test]
fn label_columns_match_real_luajit() {
    let cases: [(f64, &str); 15] = [
        (0.0, "     0.0  "),
        (0.5, "     0.5  "),
        (0.7, "     0.7  "),
        (1.0, "     1.0  "),
        (7.0, "     7.0  "),
        (8.0, "     8.0  "),
        (24.0, "   24.0  "),
        (95.5, "   95.5  "),
        (162.0, " 162.0  "),
        (270.0, " 270.0  "),
        (1234.5, " 1234.5  "),
        (7.25, "     7.25"),
        (10.0, "   10.0  "),
        (100.0, " 100.0  "),
        (99.99, "   99.99"),
    ];
    for (v, want) in cases {
        assert_eq!(format_search_value(v), want, "{v}");
    }
}
