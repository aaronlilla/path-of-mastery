//! LuaJIT `table.sort` (lib_table.c `auxsort`, the Lua 5.1 quicksort). It is not stable, so rows that
//! compare equal end up in the order this partition scheme gives them, which is what upstream
//! records. `lt(a, b)` is the Lua comparator `comp(a, b)`.

pub(crate) fn lua_table_sort<T: Clone>(a: &mut [T], lt: &dyn Fn(&T, &T) -> bool) {
    let n = a.len() as i64;
    if n < 2 {
        return;
    }
    auxsort(a, 1, n, lt);
}

fn auxsort<T: Clone>(a: &mut [T], mut l: i64, mut u: i64, lt: &dyn Fn(&T, &T) -> bool) {
    macro_rules! g {
        ($i:expr) => {
            a[($i - 1) as usize]
        };
    }
    while l < u {
        if lt(&g!(u), &g!(l)) {
            a.swap((l - 1) as usize, (u - 1) as usize);
        }
        if u - l == 1 {
            break;
        }
        let mut i = (l + u) / 2;
        if lt(&g!(i), &g!(l)) {
            a.swap((i - 1) as usize, (l - 1) as usize);
        } else if lt(&g!(u), &g!(i)) {
            a.swap((i - 1) as usize, (u - 1) as usize);
        }
        if u - l == 2 {
            break;
        }
        let p = g!(i).clone();
        a.swap((i - 1) as usize, (u - 2) as usize);
        i = l;
        let mut j = u - 1;
        loop {
            i += 1;
            while lt(&g!(i), &p) {
                if i > u {
                    return;
                }
                i += 1;
            }
            j -= 1;
            while lt(&p, &g!(j)) {
                if j < l {
                    return;
                }
                j -= 1;
            }
            if j < i {
                break;
            }
            a.swap((i - 1) as usize, (j - 1) as usize);
        }
        a.swap((u - 2) as usize, (i - 1) as usize);
        let (jj, ii);
        if i - l < u - i {
            jj = l;
            ii = i - 1;
            l = i + 1;
        } else {
            jj = i + 1;
            ii = u;
            u = i - 1;
        }
        auxsort(a, jj, ii, lt);
    }
}
