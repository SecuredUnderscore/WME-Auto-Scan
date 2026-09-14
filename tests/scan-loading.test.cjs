const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

function fixture({ busyUntil = 0, eventsAt = [], stopAt = Infinity, busyAt = null, issuesUntil = 0 } = {}) {
  let now = 0;
  const listeners = new Map();
  const state = { running: true };
  const context = vm.createContext({
    performance: { now: () => now }, scanState: state,
    SCAN_ZOOM: 15, SCAN_SETTLE_MS: 50, SCAN_MIN_DWELL_MS: 300,
    SCAN_POLL_MS: 25, MAP_DATA_TIMEOUT_MS: 9000,
    PAGE: { W: { app: { get: (key) => {
      if (key === 'loadingFeatures') return busyAt ? busyAt(now) : now < busyUntil;
      if (key === 'loadingIssueTrackerMapData') return now < issuesUntil;
      throw Error('Unexpected internal read: ' + key);
    } } } },
    sdk: {
      Map: { setMapCenter() {} }, State: { isMapLoading: () => busyAt ? busyAt(now) : now < busyUntil },
      Events: {
        on: ({ eventName, eventHandler }) => listeners.set(eventName, eventHandler),
        off: ({ eventName }) => listeners.delete(eventName),
      },
    },
    sleep: async (ms) => {
      now += ms;
      if (now >= stopAt) state.running = false;
      if (eventsAt.includes(now)) listeners.get('wme-map-data-loaded')?.();
    },
  });
  vm.runInContext(extract('  function scanMapIsLoading(', '  function currentViewSize('), context);
  return { context, listeners, now: () => now };
}

test('does not leave a slow tile at the old 500 ms deadline', async () => {
  const f = fixture({ busyUntil: 2500 });
  await f.context.moveForScan([0, 0]);
  assert.equal(f.now(), 2550);
  assert.equal(f.listeners.size, 0);
});

test('late issue merge extends the wait after roads and is collected', async () => {
  // The SDK flag turns false at 100 ms when roads finish, but issues are pending.
  const f = fixture({ busyUntil: 100, issuesUntil: 1300, eventsAt: [100, 1300] });
  let collectedLate = false;
  await f.context.moveForScan([0, 0], () => { if (f.now() >= 1300) collectedLate = true; });
  assert.equal(f.now(), 1350);
  assert.equal(collectedLate, true);
});

test('waits for roads when Issue Tracker finishes first', async () => {
  const f = fixture({ busyUntil: 1000, issuesUntil: 100, eventsAt: [100, 1000] });
  f.context.sdk.State.isMapLoading = () => false;
  await f.context.moveForScan([0, 0]);
  assert.equal(f.now(), 1050);
});

test('unavailable internal flags fail instead of trusting the SDK flag', async () => {
  for (const app of [null, { get: () => undefined }]) {
    const f = fixture();
    f.context.PAGE.W.app = app;
    let moved = false;
    f.context.sdk.Map.setMapCenter = () => { moved = true; };
    await assert.rejects(f.context.moveForScan([0, 0]), /baseline was not updated/);
    assert.equal(moved, false);
    assert.equal(f.listeners.size, 0);
  }
});

test('Issue Tracker timeout fails even after roads finished', async () => {
  const f = fixture({ busyUntil: 100, issuesUntil: Infinity });
  await assert.rejects(f.context.moveForScan([0, 0]), /baseline was not updated/);
  assert.equal(f.listeners.size, 0);
});

test('cached tiles complete without requiring a load event', async () => {
  const f = fixture();
  assert.equal(await f.context.moveForScan([0, 0]), true);
  assert.equal(f.now(), 300);
});

test('fast loaded tiles advance at 300 ms without a fixed issue delay', async () => {
  const f = fixture({ busyUntil: 200, eventsAt: [200] });
  await f.context.moveForScan([0, 0]);
  assert.equal(f.now(), 300);
});

test('a second load during idle confirmation postpones movement', async () => {
  const f = fixture({ busyAt: (now) => now < 275 || (now >= 300 && now < 700) });
  await f.context.moveForScan([0, 0]);
  assert.equal(f.now(), 750);
});

test('a late merge resets idle confirmation', async () => {
  const f = fixture({ eventsAt: [275, 300, 325] });
  await f.context.moveForScan([0, 0]);
  assert.equal(f.now(), 375);
});

test('timeout fails the scan and removes listeners', async () => {
  const f = fixture({ busyUntil: Infinity });
  await assert.rejects(f.context.moveForScan([0, 0]), /baseline was not updated/);
  assert.equal(f.listeners.size, 0);
});

test('stop interrupts loading and removes listeners', async () => {
  const f = fixture({ busyUntil: Infinity, stopAt: 200 });
  assert.equal(await f.context.moveForScan([0, 0]), false);
  assert.equal(f.listeners.size, 0);
});

test('every optimized run reuses saved boxes regardless of viewport changes', () => {
  let mask = { complete: true, productive: [1], grid: {} };
  let viewportReads = 0;
  const context = vm.createContext({
    settings: { detectors: { edit: { enabled: false } } },
    currentViewSize: () => { viewportReads++; return { w: 0, h: 0 }; }, loadMask: () => mask,
    gridCellCenter: (_, i) => i,
    computeGrid: () => ({}), relevantCells: () => [0, 1, 2],
  });
  vm.runInContext(extract('  function scanCenters(', '  // --- Optimize pass'), context);
  for (let run = 0; run < 3; run++) {
    assert.deepEqual(Array.from(context.scanCenters({}, [])), [1]);
  }
  assert.equal(viewportReads, 0, 'optimized runs must not depend on live viewport dimensions');
  mask.productive = [];
  assert.deepEqual(Array.from(context.scanCenters({}, [])), [], 'an empty completed mask must not trigger a full scan');
  mask.complete = false;
  assert.deepEqual(Array.from(context.scanCenters({}, [])), [0, 1, 2]);
  mask = null;
  assert.deepEqual(Array.from(context.scanCenters({}, [])), [0, 1, 2]);
});

test('interrupted and failed scans never finalize the baseline', async () => {
  for (const mode of ['stop', 'timeout', 'success']) {
    let finalized = 0;
    let moves = 0;
    const context = vm.createContext({
      scanState: {}, optimizeState: {}, settings: { region: { coordinates: [[[0, 0]]] }, detectors: { edit: { enabled: false }, report: {}, suggestion: {} } },
      Date, console: { error() {} }, SCAN_ZOOM: 15,
      sdk: { Map: { getMapCenter() {}, getZoomLevel() {}, setMapCenter() {} }, Editing: { clearSelection() {} }, Events: { on() {}, off() {} } },
      activeDetectors: () => [{ key: 'report', collect() {}, finalize: async () => { finalized++; } }],
      updateRequestsFilterWarning() {}, mapSuggestionsFilterWarning() {},
      centroidOfBbox() {}, bboxOfCoords() {}, scanCenters: () => [[0, 0], [1, 1]],
      moveForScan: async () => { if (++moves === 2) { if (mode === 'stop') return false; if (mode === 'timeout') throw Error('timeout'); } return true; },
      saveTiming() {}, setStatus() {}, refreshUI() {},
    });
    vm.runInContext(extract('  async function runScan()', '  // Interval scheduling:'), context);
    await context.runScan();
    assert.equal(finalized, mode === 'success' ? 1 : 0, mode);
  }
});
