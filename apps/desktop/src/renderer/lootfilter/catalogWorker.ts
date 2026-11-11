/// <reference lib="webworker" />
// Reads a NeverSink base filter and builds its item catalog off the page's thread: done on the page, entering the Loot
// Filter froze it for about 280 ms. The result is plain data (arrays and maps), sent back in one message so the blocks the
// catalog points at stay the same objects as the parsed ones.
import { parseBlocks } from '../../shared/lootfilter/blocks.js';
import { buildCatalog } from '../../shared/lootfilter/catalog.js';

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
  try {
    const parsed = parseBlocks(e.data.text);
    const cat = buildCatalog(parsed.blocks);
    self.postMessage({ id: e.data.id, parsed, cat });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: err instanceof Error ? err.message : String(err) });
  }
};
