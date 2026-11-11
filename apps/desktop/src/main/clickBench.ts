import { readFileSync, writeFileSync } from 'node:fs';
import { app, type BrowserWindow } from 'electron';

/**
 * Dev measurement of a tree click in the running app, driven from the renderer through `window.pom` exactly like
 * the UI will be: POM_BENCH_BUILD=<build.xml> [POM_BENCH_CLICKS=n] [POM_BENCH_OUT=<file.json>].
 * Each click toggles one allocated node off, then on again. Per click it records:
 *  - reply: sendCommand('toggleNode') to its result arriving in the renderer
 *  - frame: to the first animation frame after the changed stats were written into the page
 *  - fullDps: to the FullDPS `statDiff` event (null when the build has no FullDPS skills)
 * then writes the results and quits.
 */
export function runClickBench(window: BrowserWindow): void {
  const xmlPath = process.env.POM_BENCH_BUILD;
  if (!xmlPath) return;
  const clicks = Number(process.env.POM_BENCH_CLICKS ?? '10');
  const outPath = process.env.POM_BENCH_OUT ?? 'click-bench.json';
  // POM_BENCH_HOVER=1: hover each node first (previewNode, what the tree tooltip asks for), then click it.
  const hover = process.env.POM_BENCH_HOVER === '1';
  const xml = readFileSync(xmlPath, 'utf8');
  const nodeList = /<Spec [^>]*nodes="([\d,]+)"/.exec(xml)?.[1] ?? '';
  const all = nodeList.split(',').filter(Boolean).map(Number);
  const step = Math.max(1, Math.floor(all.length / clicks));
  const nodes = all.filter((_, i) => i % step === 0).slice(0, clicks);

  const script = `(async () => {
    const api = window.pom;
    let loaded;
    for (let i = 0; i < 200; i++) {
      loaded = await api.sendCommand('loadBuild', { buildXml: ${JSON.stringify(xml)} });
      if (!loaded.ok && i % 10 === 0) console.log('loadBuild not ready: ' + JSON.stringify(loaded.error));
      if (loaded.ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log('loadBuild ' + JSON.stringify(loaded.ok ? loaded.result : loaded.error));
    if (!loaded.ok) return { error: loaded.error };
    const buildId = loaded.result.buildId;
    const view = document.createElement('pre');
    document.body.appendChild(view);
    let fullDpsAt = null;
    api.onEngineEvent((e) => { if (e.type === 'statDiff') { fullDpsAt = performance.now(); view.textContent += '\\n' + e.statDiff.changed.map((c) => c.statId + ' ' + c.after).join('\\n'); } });
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
    const results = [];
    for (const nodeId of ${JSON.stringify(nodes)}) {
      for (let rep = 0; rep < 2; rep++) {
        await nextFrame();
        await new Promise((r) => setTimeout(r, 50));
        let preview = null;
        if (${hover}) {
          const tp = performance.now();
          await api.sendCommand('previewNode', { buildId, nodeId });
          preview = performance.now() - tp;
        }
        fullDpsAt = null;
        const t0 = performance.now();
        const resp = await api.sendCommand('toggleNode', { buildId, nodeId });
        const t1 = performance.now();
        view.textContent = resp.ok ? resp.result.statDiff.changed.map((c) => c.statId + ' ' + c.after).join('\\n') : JSON.stringify(resp.error);
        const t2 = await nextFrame();
        const waitStart = performance.now();
        while (fullDpsAt === null && performance.now() - waitStart < 300) await new Promise((r) => setTimeout(r, 1));
        results.push({ nodeId, ok: resp.ok, changed: resp.ok ? resp.result.statDiff.changed.length : 0, preview, reply: t1 - t0, engine: resp.ok ? resp.result.engineMs : null, frame: t2 - t0, fullDps: fullDpsAt === null ? null : fullDpsAt - t0 });
      }
    }
    return results;
  })()`;

  window.webContents.on('console-message', (_e, _level, message) => console.log(`[renderer] ${message}`));
  window.webContents.once('did-finish-load', () => {
    window.webContents
      .executeJavaScript(script)
      .then((results) => writeFileSync(outPath, JSON.stringify(results, null, 1)))
      .catch((err) => writeFileSync(outPath, JSON.stringify({ error: String(err) })))
      .finally(() => app.quit());
  });
}
