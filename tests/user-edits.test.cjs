const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const T = 1800000000000;
const clone = value => JSON.parse(JSON.stringify(value));
const region = { label: 'Test area', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
function tx(id, date, userID = 1, type = 'segment', objectID = 10) {
  return { transactionID: id, date, userID, actionType: 'UPDATE', objects: [{ objectType: type, objectID, actionType: 'UPDATE' }] };
}
function page(objects, nextTransaction = null) {
  return { transactions: { objects, nextTransaction }, users: { objects: [{ id: 1, userName: 'Alice' }, { id: 2, userName: 'Bob' }] } };
}
function object(time, id = 10, type = 'segment') {
  return { id, modificationData: { updatedOn: time }, geometry: type === 'segment' ? { type: 'LineString', coordinates: [[1, 1], [2, 2]] } : { type: 'Point', coordinates: [2, 2] } };
}
function fixture(storage = new Map()) {
  const sends = [], requests = [];
  let now = T + 100000;
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    PAGE: { location: { origin: 'https://www.waze.com' } },
    tabPane: null, console: { warn() {} },
    settings: { region: clone(region), detectors: { edit: { enabled: true, cooldownMin: 60 } } },
    scanState: { running: true, startTime: T, polygon: clone(region.coordinates) },
    sdk: { Settings: { getRegionCode: () => 'usa' }, Editing: { getUnsavedChangesCount: () => 0 }, DataModel: {
      Segments: { getAll: () => [] }, Venues: { getAll: () => [] },
    } },
    GM_getValue: key => storage.get(key), GM_setValue: (key, value) => storage.set(key, value),
    sleep: async () => {}, noteUsername() {}, isWhitelisted: () => false,
    COLORS: { edit: 123 }, PROFILE_URL: n => 'https://www.waze.com/user/editor/' + n,
    resolveChannels: () => ({ discordWebhook: 'test', pushoverToken: 'token', pushoverUser: 'user' }),
    sendNotification: async (key, note, ch) => { const channel = ch.discordWebhook ? 'discord' : 'pushover'; sends.push({ channel, note }); return [channel + ':ok']; },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => page([]) }; },
  });
  vm.runInContext(extract('  function pointInPolygon(', '  // --- Polygon simplification'), context);
  vm.runInContext(extract('  const MIN_FIT_ZOOM', '  function buildLinks('), context);
  vm.runInContext(extract('  function regionKey(', '  function loadMask('), context);
  vm.runInContext(extract('  const EDIT_STORAGE_PREFIX', '  // ---------------------------------------------------------------------------\n  // Scan engine'), context);
  return { context, storage, sends, requests, advance: ms => { now += ms; }, stored: () => JSON.parse([...storage.values()][0]) };
}

test('silent baseline persists and a reload recovers both intermediate editors', async () => {
  const f = fixture();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T - 1000)];
  let d = f.context.makeEditDetector(); d.collect(); d.collect(); await d.finalize();
  assert.equal(f.requests.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(Object.keys(f.stored().checkpoints).length, 1);
  const reloaded = fixture(f.storage);
  reloaded.context.sdk.DataModel.Segments.getAll = () => [object(T + 2000)];
  reloaded.context.fetchEditHistory = async () => page([tx('b', T + 2000, 2), tx('a', T + 1000), tx('old', T - 1000)]);
  d = reloaded.context.makeEditDetector(); d.collect(); d.collect(); await d.finalize();
  assert.equal(reloaded.sends.length, 4);
  assert.match(reloaded.sends[0].note.plainText, /1 Segment edit across 1 unique segment/);
  assert.deepEqual(reloaded.stored().pending, {});
  d = reloaded.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.equal(reloaded.sends.length, 4, 'no repeated alerts for unchanged metadata');
});

test('paginated history deduplicates transactions and excludes related nodes', async () => {
  const f = fixture(); let calls = 0;
  const recent = tx('recent', T + 2000);
  recent.objects.push({ objectType: 'node', objectID: 20, actionType: 'UPDATE' });
  f.context.fetchEditHistory = async (_, item, cursor) => {
    calls++;
    if (cursor == null) return page([recent], 'next');
    assert.equal(cursor, 'next');
    return page([recent, tx('earlier', T + 1000), tx('old', T - 1000)]);
  };
  const result = await f.context.readNewEditEvents('url', { type: 'segment', id: '10', time: T + 2000 }, { time: T, ids: [] }, { remaining: 100 });
  assert.equal(calls, 2);
  assert.equal(result.events.length, 2);
  assert.deepEqual(clone(result.checkpoint.ids), ['recent']);
});

test('same-timestamp checkpoint IDs allow unseen transactions at the boundary', async () => {
  const f = fixture();
  f.context.fetchEditHistory = async () => page([tx('latest', T + 1000), tx('new-at-boundary', T), tx('already-seen', T)]);
  const result = await f.context.readNewEditEvents('url', { type: 'segment', id: '10', time: T + 1000 }, { time: T, ids: ['already-seen'] }, { remaining: 10 });
  assert.deepEqual(clone(result.events.map(e => e.id)), ['latest', 'new-at-boundary']);
});

test('history failure keeps checkpoint and retries even if object unloads', async () => {
  const f = fixture();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T - 1000)];
  let d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T + 1000)];
  f.context.fetchEditHistory = async () => { throw Error('History HTTP 429'); };
  d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.equal(f.stored().checkpoints['segment:10'].time, T - 1000);
  assert.equal(Object.keys(f.stored().retry).length, 1);
  f.context.sdk.DataModel.Segments.getAll = () => [];
  f.context.fetchEditHistory = async () => page([tx('new', T + 1000)]);
  d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.equal(Object.keys(f.stored().retry).length, 0);
  assert.equal(f.sends.length, 2);
});

test('new place after baseline is counted; old object newly loaded is not', async () => {
  const f = fixture(); let d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T - 1000)];
  f.context.sdk.DataModel.Venues.getAll = () => [object(T + 1000, 99, 'venue')];
  f.context.fetchEditHistory = async (_, item) => { assert.equal(item.type, 'venue'); return page([tx('new-place', T + 1000, 1, 'venue', 99)]); };
  d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.equal(f.sends.length, 2);
  assert.match(f.sends[0].note.plainText, /1 Place edit/);
  assert.doesNotMatch(f.sends[0].note.plainText, /Segment edits/);
});

test('partial pagination failure, unknown actors and repeated cursors fail closed', async () => {
  for (const mode of ['page failure', 'actor', 'cursor']) {
    const f = fixture();
    f.context.fetchEditHistory = async (_, item, cursor) => {
      if (mode === 'actor') return page([tx('new', T + 1000, 999)]);
      if (mode === 'page failure' && cursor) throw Error('network');
      return page([tx('new', T + 1000)], 'repeat');
    };
    await assert.rejects(f.context.readNewEditEvents('url', { type: 'segment', id: '10', time: T + 1000 }, { time: T, ids: [] }, { remaining: 10 }));
  }
});

test('stale history retries while fresh but is accepted once the edit ages out', async () => {
  const f = fixture(); // fixture clock is T + 100000
  f.context.fetchEditHistory = async () => page([tx('old', T - 1000)]);
  // A recent updatedOn whose history is still behind it may be replication lag: retry.
  await assert.rejects(
    f.context.readNewEditEvents('url', { type: 'segment', id: '10', time: T + 100000 }, { time: T, ids: [] }, { remaining: 10 }),
    /caught up/);
  // An older updatedOn that history never reaches (a related-object edit bumped it
  // without an own-transaction) is accepted so the object leaves the retry queue:
  // no events reported, and the checkpoint advances to updatedOn.
  const result = await f.context.readNewEditEvents('url', { type: 'segment', id: '10', time: T + 1000 }, { time: T, ids: [] }, { remaining: 10 });
  assert.equal(result.events.length, 0);
  assert.equal(result.checkpoint.time, T + 1000);
});

test('cooldown accumulates edits; partial delivery retries only failed channel', async () => {
  const f = fixture();
  const event = { id: '1', date: T, name: 'Alice', type: 'segment', objectId: '10', delivered: [] };
  const store = { pending: { 1: [clone(event)] }, lastSent: { 1: T + 99000 } };
  await f.context.deliverEditEvents(store, () => {}, 'Area');
  assert.equal(f.sends.length, 0);
  f.advance(3600000);
  let calls = [];
  f.context.sendNotification = async (_, note, ch) => { const channel = ch.discordWebhook ? 'discord' : 'pushover'; calls.push(channel); return [channel + (channel === 'discord' ? ':ok' : ':err')]; };
  await f.context.deliverEditEvents(store, () => {}, 'Area');
  assert.deepEqual(calls, ['discord', 'pushover']);
  assert.deepEqual(store.pending[1][0].delivered, ['discord']);
  calls = [];
  f.context.sendNotification = async (_, note, ch) => { assert.equal(ch.discordWebhook, ''); calls.push('pushover'); return ['pushover:ok']; };
  await f.context.deliverEditEvents(store, () => {}, 'Area');
  assert.deepEqual(calls, ['pushover']);
  assert.deepEqual(store.pending, {});
});

test('whitelist drops buffered notifications and unsaved local edits block collection', async () => {
  const f = fixture();
  f.context.isWhitelisted = () => true;
  const store = { pending: { 1: [{ name: 'Alice' }] }, lastSent: {} };
  await f.context.deliverEditEvents(store, () => {}, 'Area');
  assert.deepEqual(store.pending, {});
  assert.equal(f.sends.length, 0);
  f.context.sdk.Editing.getUnsavedChangesCount = () => 1;
  assert.throws(() => f.context.makeEditDetector().collect(), /Save or undo/);
});

test('endpoint selects the active WME server and rejects malformed HTTP responses', async () => {
  const f = fixture();
  for (const [region, path] of [['usa', '/Descartes/app/'], ['row', '/row-Descartes/app/'], ['il', '/il-Descartes/app/']]) {
    f.context.sdk.Settings.getRegionCode = () => region;
    assert.equal(f.context.editEndpoint().pathname, path + 'ElementHistory');
  }
  await f.context.fetchEditHistory(f.context.editEndpoint(), { type: 'venue', id: '1.2' }, 'cursor');
  assert.match(f.requests[0], /objectType=venue&objectID=1.2&till=cursor/);
  f.context.fetch = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(f.context.fetchEditHistory(f.context.editEndpoint(), { type: 'segment', id: '10' }, null), /Unrecognized/);
});

test('stop and request budget prevent history requests', async () => {
  const f = fixture(); let calls = 0;
  f.context.fetchEditHistory = async () => { calls++; return page([]); };
  const args = ['url', { type: 'segment', id: '10', time: T }, { time: T - 1000, ids: [] }];
  await assert.rejects(f.context.readNewEditEvents(...args, { remaining: 0 }), /budget/);
  f.context.scanState.running = false;
  await assert.rejects(f.context.readNewEditEvents(...args, { remaining: 10 }), /paused/);
  assert.equal(calls, 0);
});

test('area place containing the scan area is included; outside point and hole are excluded', () => {
  const f = fixture();
  assert.equal(f.context.editGeometryInRegion({ type: 'Polygon', coordinates: [[[-1, -1], [11, -1], [11, 11], [-1, 11], [-1, -1]]] }, region.coordinates), true);
  assert.equal(f.context.editGeometryInRegion({ type: 'Point', coordinates: [20, 20] }, region.coordinates), false);
  const withHole = [...region.coordinates, [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];
  assert.equal(f.context.editGeometryInRegion({ type: 'Point', coordinates: [5, 5] }, withHole), false);
});

test('User edits reuses saved road masks, including an empty mask', () => {
  for (const productive of [[], [1]]) {
    const context = vm.createContext({ settings: { detectors: { edit: { enabled: true } } },
      loadMask: () => ({ complete: true, productive }), gridCellCenter: (_, i) => i,
      computeGrid: () => { throw Error('must reuse saved optimization'); },
      currentViewSize: () => { throw Error('must not measure a new grid'); },
    });
    vm.runInContext(extract('  function scanCenters(', '  // --- Optimize pass'), context);
    assert.deepEqual(Array.from(context.scanCenters({}, [])), productive);
  }
});

test('long histories persist pagination progress and resume after reload without recounting pages', async () => {
  const f = fixture();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T - 1000)];
  let d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T + 21000)];
  const cursors = [];
  const fetchPages = async (_, item, cursor) => {
    const index = cursor == null ? 0 : Number(cursor);
    cursors.push(index);
    return page([tx('tx' + index, T + 21000 - index * 1000)], index === 20 ? null : String(index + 1));
  };
  f.context.fetchEditHistory = fetchPages;
  d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.equal(cursors.length, 20);
  assert.equal(f.stored().retry['segment:10'].progress.cursor, '20');
  assert.equal(f.stored().checkpoints['segment:10'].time, T - 1000);
  assert.equal(f.sends.length, 0, 'incomplete object history is not reported');
  const reload = fixture(f.storage);
  reload.context.sdk.DataModel.Segments.getAll = () => [object(T + 21000)];
  reload.context.fetchEditHistory = fetchPages;
  d = reload.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.deepEqual(cursors, Array.from({ length: 21 }, (_, i) => i));
  assert.match(reload.sends[0].note.plainText, /21 Segment edits across 1 unique segment/);
  assert.deepEqual(reload.stored().retry, {});
});

test('storage failure stops finalization before sending notifications', async () => {
  const f = fixture();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T - 1000)];
  let d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T + 1000)];
  f.context.fetchEditHistory = async () => page([tx('new', T + 1000)]);
  let saves = 0;
  const save = f.context.GM_setValue;
  f.context.GM_setValue = (key, value) => { if (++saves === 2) throw Error('quota'); save(key, value); };
  d = f.context.makeEditDetector(); d.collect();
  await assert.rejects(d.finalize(), /Could not persist/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.stored().checkpoints['segment:10'].time, T - 1000);
  assert.equal(Object.keys(f.stored().retry).length, 1);
});

test('one transaction affecting two segments counts two object edits, not related fields', async () => {
  const f = fixture();
  const events = [
    { id: 'save1', objectId: '10', type: 'segment', date: T },
    { id: 'save1', objectId: '11', type: 'segment', date: T },
    { id: 'save2', objectId: '10', type: 'segment', date: T + 1000 },
    { id: 'save3', objectId: '90', type: 'venue', date: T + 2000 },
  ];
  const note = f.context.buildEditNotification('Alice', events, 'Area');
  assert.match(note.plainText, /3 Segment edits across 2 unique segments/);
  assert.match(note.plainText, /1 Place edit across 1 unique place/);
});

test('permalinkAt rewrites lon/lat to the feature centroid', () => {
  const at = fixture().context.permalinkAt;
  assert.equal(at('https://x/editor?env=usa&lon=0&lat=0&zoomLevel=15', { lon: -73.5, lat: 40.5 }),
    'https://x/editor?env=usa&lon=-73.5&lat=40.5&zoomLevel=15'); // no zoom arg: zoomLevel untouched
  assert.equal(at('https://x/editor?lon=0&lat=0&zoomLevel=15', { lon: 1, lat: 2 }, 18),
    'https://x/editor?lon=1&lat=2&zoomLevel=18'); // zoom arg overrides
  assert.equal(at('https://x/editor', { lon: 1, lat: 2 }), 'https://x/editor?lon=1&lat=2');
  assert.equal(at('https://x/editor?segments=5', null), 'https://x/editor?segments=5'); // missing coords: unchanged
});

test('zoomForBbox fits the extent and clamps sensibly', () => {
  const z = fixture().context.zoomForBbox;
  assert.equal(z(null), 17); // no extent: close point zoom
  assert.equal(z([1, 1, 1, 1]), 17); // degenerate box: close point zoom
  const tiny = z([0, 0, 0.0005, 0.0005]); // small feature -> close
  const wide = z([0, 0, 5, 5]); // huge feature -> far
  assert.ok(tiny > wide, 'smaller extent zooms in further');
  assert.ok(z([0, 0, 5, 5]) >= 12 && z([0, 0, 0.0005, 0.0005]) <= 20, 'clamped to 12..20');
});

test('edit permalinks land on and fit the object, overriding the scan-view coordinates', () => {
  const f = fixture();
  // getPermalink reflects the last scanned tile (lon=0,lat=0) with a stale selection.
  f.context.sdk.Map = { getPermalink: () => 'https://www.waze.com/editor?env=usa&lon=0&lat=0&zoomLevel=15&segments=999' };
  const events = [
    { id: 's1', objectId: '10', type: 'segment', date: T, bbox: [-74, 40, -73, 41] }, // centroid -73.5,40.5
    { id: 'v1', objectId: '90', type: 'venue', date: T + 1000, bbox: [-72, 42, -70, 44] }, // centroid -71,43
  ];
  const note = f.context.buildEditNotification('Alice', events);
  assert.match(note.discordDescription, /lon=-73\.5&lat=40\.5&zoomLevel=\d+&segments=10/);
  assert.match(note.discordDescription, /lon=-71&lat=43&zoomLevel=\d+&venues=90/);
  assert.doesNotMatch(note.discordDescription, /lon=0&lat=0/); // not the scan view
  assert.doesNotMatch(note.discordDescription, /zoomLevel=15/); // scan zoom replaced by fit zoom
  assert.doesNotMatch(note.discordDescription, /segments=999/); // stale base selection stripped
  assert.match(note.discordDescription, /\[User Profile\]\(https:\/\/www\.waze\.com\/user\/editor\/Alice\)/);
});

test('collect captures the object extent for permalinks', async () => {
  const f = fixture();
  f.context.sdk.DataModel.Segments.getAll = () => [
    { id: 10, modificationData: { updatedOn: T }, geometry: { type: 'LineString', coordinates: [[2, 4], [4, 8]] } },
  ];
  const d = f.context.makeEditDetector();
  d.collect();
  await d.finalize(); // baseline
  f.context.sdk.DataModel.Segments.getAll = () => [
    { id: 10, modificationData: { updatedOn: T + 1000 }, geometry: { type: 'LineString', coordinates: [[2, 4], [4, 8]] } },
  ];
  f.context.fetchEditHistory = async () => page([tx('new', T + 1000)]);
  const d2 = f.context.makeEditDetector();
  d2.collect();
  await d2.finalize();
  const discord = f.sends.find((s) => s.channel === 'discord');
  assert.ok(discord, 'a notification was delivered');
  // Segment bbox [[2,4],[4,8]] centroid = lon 3, lat 6, with a fit zoom + selection.
  assert.match(discord.note.discordDescription, /lon=3&lat=6&zoomLevel=\d+&segments=10/);
});

test('repeated collection skips polygon work for unchanged objects but checks newer versions', () => {
  const f = fixture();
  let time = T;
  let intersections = 0;
  f.context.sdk.DataModel.Segments.getAll = () => [object(time)];
  f.context.editGeometryInRegion = () => { intersections++; return true; };
  const d = f.context.makeEditDetector();
  for (let i = 0; i < 100; i++) d.collect();
  assert.equal(intersections, 1);
  time += 1000;
  d.collect();
  assert.equal(intersections, 2);
});

test('history pages yield for a second and storage writes are batched per object', async () => {
  const f = fixture();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T - 1000)];
  let d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  f.context.sdk.DataModel.Segments.getAll = () => [object(T + 3000)];
  f.context.isWhitelisted = () => true;
  const delays = [];
  f.context.sleep = async ms => delays.push(ms);
  f.context.fetchEditHistory = async (_, item, cursor) => {
    const index = cursor == null ? 0 : Number(cursor);
    return page([tx('page' + index, T + 3000 - index * 1000)], index === 2 ? null : String(index + 1));
  };
  let writes = 0;
  const save = f.context.GM_setValue;
  f.context.GM_setValue = (key, value) => { writes++; save(key, value); };
  d = f.context.makeEditDetector(); d.collect(); await d.finalize();
  assert.deepEqual(delays, [1000, 1000, 1000]);
  assert.equal(writes, 2, 'persist discovery and completed object, not every page');
  assert.equal(f.stored().checkpoints['segment:10'].time, T + 3000);
});
