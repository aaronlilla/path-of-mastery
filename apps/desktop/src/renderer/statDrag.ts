// Drag a stat section by its header to reorder the list, the way the design's Build Tree Frame does it: the others slide
// out of the way, a dashed slot shows where it will land, the list scrolls near its edges, Escape cancels.
export function dragSection(e: PointerEvent | React.PointerEvent, id: string, list: HTMLElement, commit: (ids: string[]) => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const items = [...list.querySelectorAll<HTMLElement>(':scope > [data-gid]')].map((el) => ({ el, id: el.getAttribute('data-gid') ?? '', top: el.offsetTop, h: el.offsetHeight }));
  const me = items.find((x) => x.id === id);
  if (!me || items.length < 2) return;
  const GAP = parseFloat(getComputedStyle(list).rowGap) || 6;
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  const base = items[0]!.top;
  const others = items.filter((x) => x !== me);
  const lr = list.getBoundingClientRect();
  const off = e.clientY - lr.top + list.scrollTop - me.top;
  const sx = e.clientX;
  const sy = e.clientY;
  const T = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
  let started = false;
  let idx = items.indexOf(me);
  let slot: HTMLElement | null = null;
  let cy = e.clientY;
  let scr = 0;
  const layout = (i: number) => {
    const seq = others.slice();
    seq.splice(i, 0, me);
    let y = base;
    const top = new Map<(typeof items)[number], number>();
    for (const it of seq) {
      top.set(it, y);
      y += it.h + GAP;
    }
    return top;
  };
  const place = (i: number) => {
    const top = layout(i);
    for (const it of others) it.el.style.transform = 'translateY(' + (top.get(it)! - it.top) + 'px)';
    if (slot) slot.style.top = top.get(me)! + 'px';
  };
  const pick = (y: number) => {
    const mid = y + me.h / 2;
    let y0 = base;
    let n = 0;
    for (const it of others) {
      if (mid > y0 + it.h / 2) n++;
      y0 += it.h + GAP;
    }
    return n;
  };
  const follow = () => {
    const y = cy - lr.top + list.scrollTop - off;
    const lo = base - 8;
    const hi = list.scrollHeight - me.h;
    const yc = Math.max(lo, Math.min(hi, y));
    me.el.style.transform = 'translateY(' + (yc - me.top) + 'px) scale(1.02)';
    const n = pick(yc);
    if (n !== idx) {
      idx = n;
      place(idx);
    }
  };
  const auto = () => {
    const r = list.getBoundingClientRect();
    const z = 36;
    let v = 0;
    if (cy < r.top + z) v = -Math.ceil((r.top + z - cy) / 3);
    else if (cy > r.bottom - z) v = Math.ceil((cy - r.bottom + z) / 3);
    if (v) {
      list.scrollTop += v;
      follow();
    }
    scr = v ? requestAnimationFrame(auto) : 0;
  };
  const begin = () => {
    started = true;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    for (const it of others) {
      it.el.style.transition = 'transform ' + T + 'ms ' + EASE;
      it.el.style.willChange = 'transform';
    }
    Object.assign(me.el.style, {
      position: 'relative', zIndex: '8', transition: 'box-shadow 160ms ' + EASE + ', background-color 160ms', willChange: 'transform', cursor: 'grabbing',
      boxShadow: '0 18px 40px rgba(var(--shadow-rgb),calc(.55*var(--shadow-k))),0 0 0 1px rgba(var(--accent-rgb),.5),0 0 24px -6px rgba(var(--accent-rgb),.45)',
      backgroundColor: 'rgba(var(--glass-rgb),.96)',
    });
    slot = document.createElement('div');
    slot.setAttribute('aria-hidden', 'true');
    slot.style.cssText = 'position:absolute;left:4px;right:4px;top:' + me.top + 'px;height:' + me.h + 'px;box-sizing:border-box;border-radius:8px;border:1.5px dashed rgba(var(--accent-rgb),.5);background:rgba(var(--accent-rgb),.06);pointer-events:none;z-index:0;transition:top ' + T + 'ms ' + EASE;
    list.appendChild(slot);
  };
  const mv = (ev: PointerEvent) => {
    cy = ev.clientY;
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      begin();
    }
    follow();
    if (!scr) auto();
  };
  const end = (doCommit: boolean) => {
    removeEventListener('pointermove', mv);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', cancel);
    removeEventListener('keydown', esc, true);
    cancelAnimationFrame(scr);
    scr = 0;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (!started) return;
    const from = items.indexOf(me);
    if (!doCommit) {
      idx = from;
      place(idx);
    }
    const top = layout(idx);
    me.el.style.transition = 'transform ' + T + 'ms ' + EASE + ', box-shadow ' + T + 'ms ' + EASE + ', background-color ' + T + 'ms';
    me.el.style.transform = 'translateY(' + (top.get(me)! - me.top) + 'px)';
    me.el.style.boxShadow = '';
    me.el.style.backgroundColor = '';
    const clear = () => {
      slot?.remove();
      for (const it of items) {
        const st = it.el.style;
        st.transform = st.transition = st.willChange = st.position = st.zIndex = st.cursor = st.boxShadow = st.backgroundColor = '';
      }
    };
    setTimeout(() => {
      const ids = others.map((x) => x.id);
      ids.splice(idx, 0, id);
      if (doCommit && idx !== from) {
        commit(ids);
        requestAnimationFrame(clear);
      } else clear();
    }, T + 10);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      end(false);
    }
  };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', cancel);
  addEventListener('keydown', esc, true);
}
