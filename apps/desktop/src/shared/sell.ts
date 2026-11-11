/**
 * Trade windows for the Sell dialog. A trade window holds 60 slots. Stacks are split by the item's real maximum stack
 * size, the most valuable items go in first, and every unit is priced at the multiplier the player chose.
 */
export interface SellItem {
  name: string;
  qty: number;
  /** Chaos per unit at market. */
  unit: number;
  /** Largest stack the game allows for this item (1 for everything that does not stack). */
  maxStack: number;
}

export interface TradeWindow {
  n: number;
  slots: number;
  items: { name: string; qty: number }[];
  value: number;
}

export const WINDOW_SLOTS = 60;

export function planWindows(items: SellItem[], mult: number): TradeWindow[] {
  const out: TradeWindow[] = [];
  let cur: TradeWindow | null = null;
  const sorted = [...items].filter((i) => i.qty > 0).sort((a, b) => b.unit * b.qty - a.unit * a.qty);
  for (const it of sorted) {
    let left = it.qty;
    const stack = Math.max(1, it.maxStack);
    while (left > 0) {
      if (!cur || cur.slots >= WINDOW_SLOTS) {
        cur = { n: out.length + 1, slots: 0, items: [], value: 0 };
        out.push(cur);
      }
      const room = (WINDOW_SLOTS - cur.slots) * stack;
      const take = Math.min(left, room);
      cur.slots += Math.ceil(take / stack);
      const ex = cur.items.find((x) => x.name === it.name);
      if (ex) ex.qty += take;
      else cur.items.push({ name: it.name, qty: take });
      cur.value += take * it.unit * mult;
      left -= take;
    }
  }
  return out;
}
