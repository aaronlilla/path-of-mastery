// Entry point. Scripted runs (POM_AUTOMATION=1) are test apps parked off-screen; when one crashes, Electron's
// modal "A JavaScript error occurred in the main process" box would still land on the developer's screen. In those runs the
// error is written to stderr and the app exits instead. The handler goes in before the app's modules load, because a
// module that fails to load throws while it is being imported.
if (process.env.POM_AUTOMATION === '1') {
  process.on('uncaughtException', (e) => {
    console.error('[main] uncaught exception:', e);
    process.exit(1);
  });
}

await import('./index.js');
