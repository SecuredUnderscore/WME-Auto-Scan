// ==UserScript==
// @name         WME Auto Scan
// @namespace    https://github.com/SecuredUnderscore/WME-Auto-Scan
// @version      0.4.2
// @description  Scans a selected area in Waze Map Editor for road closures, user edits, update requests, and map suggestions, and sends notifications to Discord or Pushover.
// @author       SecuredUnderscore
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      discord.com
// @connect      discordapp.com
// @connect      api.pushover.net
// @connect      nominatim.openstreetmap.org
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* global unsafeWindow, GM_xmlhttpRequest, GM_setValue, GM_getValue */

(function () {
  "use strict";

  // Under a userscript manager the SDK globals live on the page window, which
  // the GM sandbox exposes as `unsafeWindow`. Fall back to `window` for the
  // no-sandbox (@grant none) case.
  const PAGE = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const SCRIPT_ID = "wme-auto-scan";
  const SCRIPT_NAME = "WME Auto Scan";
  const SCRIPT_VERSION = "0.4.2"; // keep in sync with @version above
  const STORAGE_KEY = "wme-auto-scan:settings:v1";

  // --- Map API scanning ----------------------------------------------------
  // Scans read WME's own map-data endpoint (Descartes "Features") directly, one
  // bounding box per request, instead of panning the map. Tile sizes come from
  // live tests (2026-10-01, Victoria BC). Both limits are silent — the server
  // still answers 200 — so every pass stays below its limit:
  //  - past ~0.09° per side the server drops minor road types (streets, parking
  //    lots, private roads) from the reply;
  //  - closures-only replies are complete at 1° but come back empty at 2°.
  const CLOSURE_TILE_DEG = 1;
  const CLOSURE_MIN_TILE_DEG = 0.25; // never split below this, whatever a reply looks like
  const ROAD_TILE_DEG = 0.07; // margin under 0.09° whether the limit is degrees, km or area
  const MAX_PARALLEL = 3; // 6 requests: 1.7 s one at a time, 0.57 s three at a time, no refusals
  const REQUEST_TIMEOUT_MS = 30000; // a request stuck this long is abandoned and retried
  const MAX_RETRIES = 5; // failed attempts at one request before the scan stops
  const RETRY_BASE_MS = 1000; // backoff after a failed request: 1 s, 2 s, 4 s…
  const RATE_PAUSE_MS = 1000; // pause after a 429; doubles while refusals continue
  const RATE_PAUSE_MAX_MS = 30000;
  const RATE_GIVE_UP_MS = 300000; // stop the scan after this long spent waiting out refusals
  const API_BASES = { usa: "/Descartes/app", row: "/row-Descartes/app", il: "/il-Descartes/app" };
  const PROFILE_URL = (u) => `https://www.waze.com/user/editor/${encodeURIComponent(u)}`;

  // Map overlay layers used by the "eye" preview buttons (region outline / the
  // scan's request boxes). Drawn on demand and cleared as soon as the zoom
  // changes or the user toggles a preview off.
  const REGION_PREVIEW_LAYER = "wme-auto-scan-region-preview";
  const BBOX_PREVIEW_LAYER = "wme-auto-scan-bbox-preview";
  const MAX_PREVIEW_BOXES = 5000; // cap so a huge region can't stall the map

  // Discord embed colours, one per detector type.
  const COLORS = {
    closure: 0xe74c3c, // red
    edit: 0x3498db, // blue
    report: 0xf1c40f, // yellow
    suggestion: 0x9b59b6, // purple
  };

  // WME road-type ids we can't get a localized name for fall back to this map.
  const ROAD_TYPE_FALLBACK = {
    1: "Street", 2: "Primary Street", 3: "Freeway", 4: "Ramp", 5: "Walking Trail",
    6: "Major Highway", 7: "Minor Highway", 8: "Off-road", 9: "Walkway",
    10: "Pedestrian Boardwalk", 15: "Ferry", 16: "Stairway", 17: "Private Road",
    18: "Railroad", 19: "Runway/Taxiway", 20: "Parking Lot Road", 22: "Alley",
  };
  const ALL_ROAD_TYPES = Object.keys(ROAD_TYPE_FALLBACK).map(Number);

  // ---------------------------------------------------------------------------
  // Settings model + persistence (GM storage)
  // ---------------------------------------------------------------------------
  function defaultSettings() {
    const detector = () => ({
      enabled: false,
      discordWebhook: "",
      pushoverToken: "",
      pushoverUser: "",
      pushoverSound: "",
    });
    return {
      version: 1,
      global: {
        scanIntervalMin: 10,
        discordWebhook: "",
        pushoverToken: "",
        pushoverUser: "",
        pushoverSound: "pushover",
        skipPlaces: false, // don't load places while scanning (User edits then covers segments only)
      },
      whitelist: [], // usernames whose events are suppressed
      whitelistSeeded: false, // set once we've added the current user by default
      region: null, // GeoJSON Polygon coordinates (rings of [lon,lat]) + label
      detectors: {
        closure: { ...detector(), enabled: true },
        edit: { ...detector(), cooldownMin: 60 },
        report: detector(),
        suggestion: { ...detector(), includeSegments: true }, // also alert on new-road suggestions
      },
    };
  }

  function loadSettings() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return defaultSettings();
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return deepMerge(defaultSettings(), parsed);
    } catch (e) {
      console.error("[WME Auto Scan] failed to load settings, using defaults", e);
      return defaultSettings();
    }
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        GM_setValue(STORAGE_KEY, JSON.stringify(settings));
      } catch (e) {
        console.error("[WME Auto Scan] failed to save settings", e);
      }
    }, 250);
  }

  function deepMerge(base, override) {
    if (Array.isArray(base)) return Array.isArray(override) ? override.slice() : base;
    if (base && typeof base === "object") {
      const out = { ...base };
      if (override && typeof override === "object") {
        for (const k of Object.keys(override)) {
          out[k] = k in base ? deepMerge(base[k], override[k]) : override[k];
        }
      }
      return out;
    }
    return override === undefined ? base : override;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // One macrotask, via MessageChannel: unlike setTimeout it isn't throttled to
  // once a second when the WME tab is in the background.
  function yieldToPage() {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
      channel.port2.postMessage(null);
    });
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers (self-contained; no external turf dependency)
  // ---------------------------------------------------------------------------
  // Ray-casting point-in-polygon. `poly` is a GeoJSON Polygon coordinate array
  // (array of linear rings; ring[0] is the outer boundary). pt is [lon,lat].
  function pointInPolygon(pt, poly) {
    let inside = false;
    const outer = poly[0] || [];
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const xi = outer[i][0], yi = outer[i][1];
      const xj = outer[j][0], yj = outer[j][1];
      const intersect =
        yi > pt[1] !== yj > pt[1] &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    // subtract holes
    for (let h = 1; h < poly.length; h++) {
      if (pointInPolygon(pt, [poly[h]])) return false;
    }
    return inside;
  }

  function bboxOfRing(ring) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    return [minLon, minLat, maxLon, maxLat];
  }

  // Do segments p1p2 and p3p4 (each [lon,lat]) intersect? Standard orientation test.
  function segsIntersect(p1, p2, p3, p4) {
    const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const onSeg = (a, b, c) =>
      Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
      Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
    const o1 = o(p1, p2, p3), o2 = o(p1, p2, p4), o3 = o(p3, p4, p1), o4 = o(p3, p4, p2);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSeg(p1, p2, p3)) return true;
    if (o2 === 0 && onSeg(p1, p2, p4)) return true;
    if (o3 === 0 && onSeg(p3, p4, p1)) return true;
    if (o4 === 0 && onSeg(p3, p4, p2)) return true;
    return false;
  }

  function pointInBox(pt, box) {
    return pt[0] >= box[0] && pt[0] <= box[2] && pt[1] >= box[1] && pt[1] <= box[3];
  }

  function lineInPolygon(lineCoords, poly) {
    // A closure "belongs" to the region if any vertex of its segment is inside…
    for (const c of lineCoords) if (pointInPolygon(c, poly)) return true;
    // …or if the segment crosses the region boundary with both ends outside.
    const outer = poly[0] || [];
    for (let k = 0; k < lineCoords.length - 1; k++) {
      const a = lineCoords[k], b = lineCoords[k + 1];
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        if (segsIntersect(a, b, outer[j], outer[i])) return true;
      }
    }
    return false;
  }

  // --- Region index ---------------------------------------------------------
  // A scan tests thousands of objects per request against the region outline,
  // and plain ray casting walks every outline edge for every point — enough to
  // freeze the page on a detailed coastline. Bucketing the edges into
  // horizontal bands means a point only meets the few edges in its band; the
  // answers are exactly those of pointInPolygon / lineInPolygon (same ray, same
  // edges crossed), just found without the full walk.
  const INDEX_BANDS = 2048;
  function indexPolygon(poly) {
    const edges = []; // [xj, yj, xi, yi, ring] — the (j, i) vertex pairs pointInPolygon visits
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r] || [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) edges.push([ring[j][0], ring[j][1], ring[i][0], ring[i][1], r]);
    }
    let minY = Infinity, maxY = -Infinity;
    for (const e of edges) {
      minY = Math.min(minY, e[1], e[3]);
      maxY = Math.max(maxY, e[1], e[3]);
    }
    const n = Math.max(1, Math.min(INDEX_BANDS, edges.length));
    const h = (maxY - minY) / n || 1;
    const bandOf = (y) => Math.min(n - 1, Math.max(0, Math.floor((y - minY) / h)));
    const bands = Array.from({ length: n }, () => []);
    edges.forEach((e, k) => {
      for (let b = bandOf(Math.min(e[1], e[3])), last = bandOf(Math.max(e[1], e[3])); b <= last; b++) bands[b].push(k);
    });
    const parity = new Uint8Array(poly.length);
    const stamp = new Int32Array(edges.length);
    let tick = 0;
    const firstPoint = (poly[0] && poly[0][0]) || [NaN, NaN];

    function pointIn(pt) {
      if (!(pt[1] >= minY && pt[1] <= maxY)) return false;
      parity.fill(0);
      for (const k of bands[bandOf(pt[1])]) {
        const e = edges[k];
        const xj = e[0], yj = e[1], xi = e[2], yi = e[3];
        if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) parity[e[4]] ^= 1;
      }
      if (!parity[0]) return false;
      for (let r = 1; r < parity.length; r++) if (parity[r]) return false; // inside a hole
      return true;
    }

    // Any vertex inside, or any segment crossing the outer boundary.
    function lineIn(coords) {
      for (const c of coords) if (pointIn(c)) return true;
      for (let k = 0; k < coords.length - 1; k++) {
        const a = coords[k], b = coords[k + 1];
        const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
        if (hi < minY || lo > maxY) continue;
        tick++;
        for (let band = bandOf(lo), last = bandOf(hi); band <= last; band++) {
          for (const i of bands[band]) {
            if (stamp[i] === tick) continue;
            stamp[i] = tick;
            const e = edges[i];
            if (e[4] === 0 && segsIntersect(a, b, [e[0], e[1]], [e[2], e[3]])) return true;
          }
        }
      }
      return false;
    }

    // Does a [w, s, e, n] box overlap the region? (bboxInPolygon, indexed)
    function boxIn(box) {
      const [w, s, e, nn] = box;
      return lineIn([[w, s], [e, s], [e, nn], [w, nn], [w, s]]) || pointInBox(firstPoint, box);
    }

    return { pointIn, lineIn, boxIn, firstPoint };
  }

  function centroidOfBbox(bbox) {
    return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
  }

  // Bounding box [minLon, minLat, maxLon, maxLat] of any GeoJSON geometry.
  function geometryBbox(geometry) {
    if (!geometry) return null;
    let ring;
    if (geometry.type === "Point") ring = [geometry.coordinates];
    else if (geometry.type === "LineString") ring = geometry.coordinates;
    else if (geometry.type === "Polygon") ring = geometry.coordinates[0] || [];
    else return null;
    if (!ring.length) return null;
    return bboxOfRing(ring);
  }

  // --- Polygon simplification (Douglas–Peucker) ---------------------------
  // Region outlines from OSM can carry thousands of coastline vertices, which
  // makes point-in-polygon culling (O(cells × vertices)) freeze the tab. Tile
  // culling only needs coastline accuracy to within a tile (~1 km), so we thin
  // the rings hard on import: fast culling that still hugs the real shape, so
  // the ocean around an island is dropped instead of scanned.
  function segDistSq(p, v, w) {
    let x = v[0], y = v[1];
    let dx = w[0] - x, dy = w[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = w[0]; y = w[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }

  function simplifyRing(ring, tol) {
    const n = ring.length;
    if (n <= 4) return ring.slice();
    const sqTol = tol * tol;
    const markers = new Uint8Array(n);
    markers[0] = markers[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxSq = 0, index = -1;
      for (let i = first + 1; i < last; i++) {
        const sq = segDistSq(ring[i], ring[first], ring[last]);
        if (sq > maxSq) { maxSq = sq; index = i; }
      }
      if (maxSq > sqTol && index !== -1) {
        markers[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (markers[i]) out.push(ring[i]);
    return out;
  }

  // Simplify every ring of a Polygon coordinate array, raising the tolerance
  // until the outer ring is under a sane vertex budget (keeps culling snappy).
  function simplifyPolygonCoords(coords, maxPts = 600) {
    if (!coords || !coords.length) return coords;
    let tol = 0.002; // ~200 m
    let rings = coords.map((r) => simplifyRing(r, tol));
    let guard = 0;
    while (rings[0].length > maxPts && guard++ < 10) {
      tol *= 1.7;
      rings = coords.map((r) => simplifyRing(r, tol));
    }
    return rings;
  }

  function padBbox(bbox, frac) {
    const dx = (bbox[2] - bbox[0]) * frac || 0.0005;
    const dy = (bbox[3] - bbox[1]) * frac || 0.0005;
    return [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy];
  }

  // ---------------------------------------------------------------------------
  // Networking (all cross-origin traffic goes through GM_xmlhttpRequest so it
  // works for both Discord and Pushover, which lacks CORS headers).
  // ---------------------------------------------------------------------------
  function gmRequest({ url, method = "GET", headers = {}, data = null, binary = false }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url,
        method,
        headers,
        data,
        binary,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res);
          else reject(new Error(`HTTP ${res.status}: ${res.responseText || res.statusText}`));
        },
        onerror: (res) => reject(new Error(`Network error (status ${res && res.status}): ${(res && res.responseText) || (res && res.statusText) || "blocked or no response"}`)),
        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  // Convert a JS string to a UTF-8 byte string (one char per byte) so it can be
  // concatenated with raw binary and sent via GM_xmlhttpRequest `binary: true`.
  function utf8Bytes(s) {
    return unescape(encodeURIComponent(String(s)));
  }

  // Build a multipart/form-data body as a raw byte string, sent with
  // GM_xmlhttpRequest `binary: true` — the reliable cross-manager path, since
  // FormData support in GM is inconsistent. fields: { name: stringValue }.
  function buildMultipart(fields) {
    const boundary = "----WMEAutoScan" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(utf8Bytes(`--${boundary}--\r\n`));
    return { body: parts.join(""), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  // ---------------------------------------------------------------------------
  // Notification layer
  // ---------------------------------------------------------------------------
  // Resolve the effective channel config for a detector, applying per-detector
  // overrides on top of the global defaults.
  function resolveChannels(detectorKey) {
    const g = settings.global;
    const d = settings.detectors[detectorKey];
    return {
      discordWebhook: d.discordWebhook || g.discordWebhook,
      pushoverToken: d.pushoverToken || g.pushoverToken,
      pushoverUser: d.pushoverUser || g.pushoverUser,
      pushoverSound: d.pushoverSound || g.pushoverSound,
    };
  }

  function channelConfigured(ch) {
    return Boolean(ch.discordWebhook || (ch.pushoverToken && ch.pushoverUser));
  }

  // A notification is { title, color, discordDescription, plainText }
  async function sendNotification(detectorKey, note, channels = null) {
    const ch = channels || resolveChannels(detectorKey);
    const results = [];
    if (ch.discordWebhook) {
      try {
        await sendDiscord(ch.discordWebhook, note);
        results.push("discord:ok");
      } catch (e) {
        console.error("[WME Auto Scan] Discord send failed", e);
        results.push("discord:err");
      }
    }
    if (ch.pushoverToken && ch.pushoverUser) {
      try {
        await sendPushover(ch, note);
        results.push("pushover:ok");
      } catch (e) {
        console.error("[WME Auto Scan] Pushover send failed", e);
        results.push("pushover:err");
      }
    }
    return results;
  }

  function clamp(str, max) {
    const s = String(str == null ? "" : str);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  async function sendDiscord(webhook, note) {
    // Discord embed limits: title <= 256, description <= 4096.
    const embed = {
      title: clamp(note.title, 256),
      description: clamp(note.discordDescription || "​", 4096),
      color: note.color,
    };
    const { body, contentType } = buildMultipart({ payload_json: JSON.stringify({ embeds: [embed] }) });
    await gmRequest({
      url: webhook,
      method: "POST",
      headers: { "Content-Type": contentType },
      data: body,
      binary: true,
    });
  }

  async function sendPushover(ch, note) {
    const fields = {
      token: ch.pushoverToken,
      user: ch.pushoverUser,
      title: note.title,
      message: note.plainText,
      html: "0",
    };
    if (ch.pushoverSound) fields.sound = ch.pushoverSound;
    const { body, contentType } = buildMultipart(fields);
    await gmRequest({
      url: "https://api.pushover.net/1/messages.json",
      method: "POST",
      headers: { "Content-Type": contentType },
      data: body,
      binary: true,
    });
  }

  // ---------------------------------------------------------------------------
  // WME map API client
  // ---------------------------------------------------------------------------
  // Scan data comes from read-only GETs to WME's own same-origin endpoints, sent
  // with the editor's session cookie — the same requests WME makes to draw the
  // map. Nothing is written, and the map itself is never moved, so the editor can
  // keep working while a scan runs.
  let sdk = null;
  let roadTypeNames = {}; // id -> localized name

  // The WME SDK runs in async mode (opt-in now, the only mode from 2027-01-01):
  // every module method returns a Promise. Each call is awaited, which works in
  // the old sync mode too. The few facts that synchronous code (request URLs,
  // link building) needs are cached here and refreshed before every scan.
  const wme = {
    regionCode: null,
    permalink: "https://www.waze.com/editor",
    viewport: { w: 1200, h: 800 },
  };
  async function refreshWmeInfo() {
    try { wme.regionCode = await sdk.Settings.getRegionCode(); } catch (e) {}
    try { wme.permalink = (await sdk.Map.getPermalink()) || wme.permalink; } catch (e) {}
    try {
      const el = await sdk.Map.getMapViewportElement();
      if (el && el.clientWidth && el.clientHeight) wme.viewport = { w: el.clientWidth, h: el.clientHeight };
    } catch (e) {}
  }

  function apiBase() {
    const base = API_BASES[wme.regionCode];
    if (!base) throw new Error("Unknown WME server region");
    return PAGE.location.origin + base;
  }

  function stoppedError() {
    const e = new Error("Scan stopped.");
    e.stopped = true;
    return e;
  }

  // Failed requests retry with backoff. A 429 (Waze's edge refusing a burst)
  // pauses every request of the scan, doubling while refusals continue, since
  // the limiter typically shuts the door for a while once tripped.
  function createApiClient(isStopped) {
    const controllers = new Set();
    let pauseUntil = 0, refusals = 0;

    async function waitOutPause() {
      for (let left = pauseUntil - Date.now(); left > 0; left = pauseUntil - Date.now()) {
        if (isStopped()) throw stoppedError();
        await sleep(Math.min(left, 500));
      }
    }

    async function get(path, params) {
      const url = new URL(apiBase() + "/" + path);
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
      }
      let failures = 0, limitedSince = null;
      for (;;) {
        if (isStopped()) throw stoppedError();
        await waitOutPause();
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let status = 0, body = null, problem = null;
        try {
          const res = await fetch(url.href, { credentials: "same-origin", signal: controller.signal });
          status = res.status;
          if (res.ok) {
            try { body = await res.json(); } catch (e) { problem = "unreadable response"; }
          }
        } catch (e) {
          problem = controller.signal.aborted ? "timeout" : "network error";
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
        if (isStopped()) throw stoppedError();
        if (body && typeof body === "object") { refusals = 0; return body; }
        if (status === 429) {
          limitedSince = limitedSince || Date.now();
          if (Date.now() - limitedSince > RATE_GIVE_UP_MS) {
            throw new Error("WME is rate limiting this session (429 Too Many Requests). Scan stopped; baseline was not updated.");
          }
          refusals++;
          const pause = Math.min(RATE_PAUSE_MAX_MS, RATE_PAUSE_MS * 2 ** Math.min(refusals - 1, 10));
          if (refusals > 1) console.warn(`[WME Auto Scan] WME refused ${refusals} requests in a row. Pausing ${(pause / 1000).toFixed(1)}s.`);
          pauseUntil = Math.max(pauseUntil, Date.now() + pause);
          continue;
        }
        if (status === 401 || status === 403) {
          throw new Error(`WME refused the map request (HTTP ${status}). Make sure you're logged in. Scan stopped; baseline was not updated.`);
        }
        if (++failures > MAX_RETRIES) {
          throw new Error(`WME kept failing to return map data (${problem || "HTTP " + status}). Scan stopped; baseline was not updated.`);
        }
        await sleep(RETRY_BASE_MS * 2 ** (failures - 1));
      }
    }

    return {
      // One Features request for bbox [minLon, minLat, maxLon, maxLat].
      features(bbox, params) {
        return get("Features", { bbox: bbox.map((v) => +v.toFixed(6)).join(","), language: "en", v: 2, ...params });
      },
      abort() { for (const c of controllers) c.abort(); },
    };
  }

  // id -> userName from a reply's users collection (closure reporters, editors).
  function userNames(reply) {
    const names = new Map();
    for (const u of (reply && reply.users && reply.users.objects) || []) {
      if (u && u.id != null && u.userName) {
        names.set(u.id, u.userName);
        noteUsername(u.userName);
      }
    }
    return names;
  }

  // --- Tile grid -----------------------------------------------------------
  // A plain lon/lat grid over the region's bbox (the server's size limits were
  // measured in degrees). Cells outside the polygon are dropped; a cell the
  // boundary doesn't pass through and whose center is inside lies wholly in the
  // region, so its objects skip the per-object polygon test.
  function computeGrid(polygon, step) {
    const b = bboxOfRing(polygon[0]);
    const cols = Math.max(1, Math.ceil((b[2] - b[0]) / step - 1e-9));
    const rows = Math.max(1, Math.ceil((b[3] - b[1]) / step - 1e-9));
    return { x0: b[0], y0: b[1], step, cols, rows };
  }

  function gridCellBox(grid, index) {
    const col = index % grid.cols, row = Math.floor(index / grid.cols);
    const x = grid.x0 + col * grid.step, y = grid.y0 + row * grid.step;
    return [x, y, x + grid.step, y + grid.step];
  }

  // Call mark(index) for every grid cell the straight edge a→b ([lon, lat])
  // passes through (a grid walk; both neighbours are marked at exact corners).
  function markEdgeCells(grid, a, b, mark) {
    const ax = (a[0] - grid.x0) / grid.step, ay = (a[1] - grid.y0) / grid.step;
    const bx = (b[0] - grid.x0) / grid.step, by = (b[1] - grid.y0) / grid.step;
    let cx = Math.floor(ax), cy = Math.floor(ay);
    const ex = Math.floor(bx), ey = Math.floor(by);
    const dx = bx - ax, dy = by - ay;
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tx = dx !== 0 ? (dx > 0 ? cx + 1 - ax : ax - cx) * tdx : Infinity;
    let ty = dy !== 0 ? (dy > 0 ? cy + 1 - ay : ay - cy) * tdy : Infinity;
    const cell = (c, r) => { if (c >= 0 && c < grid.cols && r >= 0 && r < grid.rows) mark(r * grid.cols + c); };
    cell(cx, cy);
    for (let n = Math.abs(ex - cx) + Math.abs(ey - cy); n > 0; n--) {
      if (tx < ty) { cx += sx; tx += tdx; }
      else if (ty < tx) { cy += sy; ty += tdy; }
      else { cell(cx + sx, cy); cell(cx, cy + sy); cx += sx; cy += sy; tx += tdx; ty += tdy; n--; }
      cell(cx, cy);
    }
    cell(ex, ey);
  }

  // Request boxes covering the region at `step` degrees: [{ box, inside }].
  const tileCache = new Map(); // "<regionKey>:<step>" -> tiles (regions are fixed once saved)
  function regionTiles(polygon, step) {
    const cacheKey = regionKey({ coordinates: polygon }) + ":" + step;
    if (tileCache.has(cacheKey)) return tileCache.get(cacheKey);
    const grid = computeGrid(polygon, step);
    const total = grid.cols * grid.rows;
    const edge = new Uint8Array(total);
    for (const ring of polygon) {
      for (let k = 0; k < ring.length - 1; k++) markEdgeCells(grid, ring[k], ring[k + 1], (i) => { edge[i] = 1; });
    }
    const tiles = [];
    const index = indexPolygon(polygon);
    for (let i = 0; i < total; i++) {
      const box = gridCellBox(grid, i);
      const inside = index.pointIn([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
      if (inside || edge[i]) tiles.push({ box, inside: inside && !edge[i], index: i });
    }
    tileCache.set(cacheKey, tiles);
    return tiles;
  }

  function quarterTiles(tile) {
    const [x1, y1, x2, y2] = tile.box;
    const xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
    return [[x1, y1, xm, ym], [xm, y1, x2, ym], [x1, ym, xm, y2], [xm, ym, x2, y2]]
      .map((box) => ({ box, inside: tile.inside }));
  }

  // --- Legacy layer restore ------------------------------------------------
  // Versions before 0.4 hid WME layers during a scan and restored them after.
  // A tab closed mid-scan by such a version left them hidden; put them back once.
  const LAYER_RESTORE_KEY = "wme-auto-scan:layer-restore:v1";
  async function restoreLegacyLayers() {
    let saved = null;
    try {
      const raw = GM_getValue(LAYER_RESTORE_KEY, null);
      saved = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    } catch (e) { saved = null; }
    if (!saved) return;
    for (const [name, visible] of Object.entries(saved)) {
      try {
        if (await sdk.LayerSwitcher.getWMELayerVisibility({ layerName: name }) !== visible) {
          await sdk.LayerSwitcher.setWMELayerVisibility({ layerName: name, isVisible: visible });
        }
      } catch (e) {}
    }
    try { GM_setValue(LAYER_RESTORE_KEY, null); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Map preview overlays (the "eye" buttons)
  // ---------------------------------------------------------------------------
  // activePreview is "region", "boxes", or null. Previews are transient: any
  // zoom change (or toggling another preview) clears them.
  let previewLayersReady = false;
  let activePreview = null;
  let previewZoomHandler = null;

  async function ensurePreviewLayers() {
    if (previewLayersReady) return;
    try {
      await sdk.Map.addLayer({
        layerName: REGION_PREVIEW_LAYER,
        styleRules: [{ style: { strokeColor: "#0b7fd4", strokeWidth: 3, strokeOpacity: 0.95, fillColor: "#0b7fd4", fillOpacity: 0.08 } }],
      });
      await sdk.Map.addLayer({
        layerName: BBOX_PREVIEW_LAYER,
        styleRules: [{ style: { strokeColor: "#16a34a", strokeWidth: 1.5, strokeOpacity: 0.9, fillColor: "#16a34a", fillOpacity: 0.06 } }],
      });
      previewLayersReady = true;
    } catch (e) {
      console.error("[WME Auto Scan] failed to add preview layers", e);
    }
  }

  async function clearPreview() {
    activePreview = null;
    disarmPreviewAutoClear();
    if (previewLayersReady) {
      try { await sdk.Map.removeAllFeaturesFromLayer({ layerName: REGION_PREVIEW_LAYER }); } catch (e) {}
      try { await sdk.Map.removeAllFeaturesFromLayer({ layerName: BBOX_PREVIEW_LAYER }); } catch (e) {}
    }
  }

  // Arm a one-shot: the next zoom change wipes the preview. Armed on a delay so
  // our own zoomToExtent (which triggers a zoom change) doesn't clear it instantly.
  function armPreviewAutoClear() {
    disarmPreviewAutoClear();
    setTimeout(() => {
      if (!activePreview) return;
      previewZoomHandler = () => clearPreview();
      try { sdk.Events.on({ eventName: "wme-map-zoom-changed", eventHandler: previewZoomHandler }); } catch (e) {}
    }, 900);
  }

  function disarmPreviewAutoClear() {
    if (!previewZoomHandler) return;
    try { sdk.Events.off({ eventName: "wme-map-zoom-changed", eventHandler: previewZoomHandler }); } catch (e) {}
    previewZoomHandler = null;
  }

  function polygonRingFeature(id, coordinates) {
    return { id, type: "Feature", geometry: { type: "Polygon", coordinates }, properties: {} };
  }

  function boxFeature(id, box) {
    const ring = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]];
    return polygonRingFeature(id, [ring]);
  }

  // Zoom to the saved region and outline it.
  async function previewRegion() {
    const region = settings.region;
    if (!region || !region.coordinates) return;
    await ensurePreviewLayers();
    await clearPreview();
    try {
      await sdk.Map.addFeaturesToLayer({ features: [polygonRingFeature("region", region.coordinates)], layerName: REGION_PREVIEW_LAYER });
      await sdk.Map.zoomToExtent({ bbox: bboxOfRing(region.coordinates[0]) });
      activePreview = "region";
      armPreviewAutoClear();
    } catch (e) {
      console.error("[WME Auto Scan] region preview failed", e);
    }
  }

  // Zoom out and draw the request boxes of the finest pass the enabled
  // detectors need (the pass with the most requests).
  async function previewScanBoxes() {
    const region = settings.region;
    if (!region || !region.coordinates) return;
    await ensurePreviewLayers();
    await clearPreview();
    try {
      const passes = plannedPasses();
      if (!passes.length) { setStatus("Turn on a detector to see its scan areas."); return; }
      const finest = passes.reduce((a, b) => (b.tiles.length > a.tiles.length ? b : a));
      let tiles = finest.tiles;
      const capped = tiles.length > MAX_PREVIEW_BOXES;
      if (capped) tiles = tiles.slice(0, MAX_PREVIEW_BOXES);
      await sdk.Map.addFeaturesToLayer({ features: tiles.map((t, i) => boxFeature("box" + i, t.box)), layerName: BBOX_PREVIEW_LAYER });
      await sdk.Map.zoomToExtent({ bbox: bboxOfRing(region.coordinates[0]) });
      activePreview = "boxes";
      armPreviewAutoClear();
      setStatus(capped
        ? `Showing first ${MAX_PREVIEW_BOXES} of ${finest.tiles.length} ${finest.label} requests. Zoom to clear.`
        : `Showing ${tiles.length} ${finest.label} requests. Zoom to clear.`);
    } catch (e) {
      console.error("[WME Auto Scan] scan-box preview failed", e);
      setStatus("Couldn't preview scan areas: " + e.message);
    }
  }

  function toggleRegionPreview() {
    if (activePreview === "region") { clearPreview(); return; }
    previewRegion();
  }

  function toggleBoxesPreview() {
    if (activePreview === "boxes") { clearPreview(); return; }
    previewScanBoxes();
  }

  // ---------------------------------------------------------------------------
  // Link builders
  // ---------------------------------------------------------------------------
  const MIN_FIT_ZOOM = 12, MAX_FIT_ZOOM = 20, DEFAULT_POINT_ZOOM = 17;

  // Zoom level whose viewport contains bbox ([minLon,minLat,maxLon,maxLat]),
  // mirroring sdk.Map.zoomToExtent without moving the editor's map.
  // Degenerate/absent boxes fall back to a close point zoom.
  function zoomForBbox(bbox) {
    if (!bbox) return DEFAULT_POINT_ZOOM;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lonSpan = maxLon - minLon, latSpan = maxLat - minLat;
    if (!(lonSpan > 0) && !(latSpan > 0)) return DEFAULT_POINT_ZOOM;
    const view = wme.viewport; // cached by refreshWmeInfo()
    const worldPx = 256, pad = 0.8; // tile size at zoom 0; leave a margin around the feature
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
    const zoomLon = lonSpan > 0 ? Math.log2((view.w * pad) * 360 / (worldPx * lonSpan)) : Infinity;
    const latFrac = Math.abs(merc(maxLat) - merc(minLat)) / (2 * Math.PI);
    const zoomLat = latFrac > 0 ? Math.log2((view.h * pad) / (worldPx * latFrac)) : Infinity;
    const z = Math.floor(Math.min(zoomLon, zoomLat));
    return Math.max(MIN_FIT_ZOOM, Math.min(MAX_FIT_ZOOM, z));
  }

  // getPermalink() encodes the editor's *current* view. Rewrite lon/lat (and
  // zoom) so the link lands on and fits the feature instead.
  function permalinkAt(permalink, centroid, zoom) {
    const set = (url, key, value) => (value == null ? url :
      new RegExp(`[?&]${key}=`).test(url)
        ? url.replace(new RegExp(`([?&]${key}=)[^&]*`), `$1${value}`)
        : `${url}${url.includes("?") ? "&" : "?"}${key}=${value}`);
    let url = permalink;
    if (centroid && Number.isFinite(centroid.lat) && Number.isFinite(centroid.lon)) {
      url = set(set(url, "lon", centroid.lon), "lat", centroid.lat);
    }
    if (Number.isFinite(zoom)) url = set(url, "zoomLevel", zoom);
    return url;
  }

  // The editor's selection is never touched: the segments go in the link's
  // own segments= parameter.
  function buildLinks(centroid, segmentIds, bbox) {
    const links = {};
    let wme = editPermalinkBase();
    if (segmentIds && segmentIds.length) {
      wme += (wme.includes("?") ? "&" : "?") + "segments=" + segmentIds.join(",");
    }
    links.wme = permalinkAt(wme, centroid, zoomForBbox(bbox));
    const { lat, lon } = centroid;
    links.livemap = `https://www.waze.com/live-map/directions?to=ll.${lat}%2C${lon}`;
    links.wazeApp = `https://waze.com/ul?ll=${lat}%2C${lon}&navigate=yes`;
    links.gmaps = `https://www.google.com/maps?q=${lat},${lon}`;
    return links;
  }

  function linksMarkdown(links) {
    return `[WME](${links.wme}) • [Livemap](${links.livemap}) • [Waze App](${links.wazeApp}) • [Google Maps](${links.gmaps})`;
  }

  function linksPlain(links) {
    return `WME: ${links.wme}\nLivemap: ${links.livemap}\nWaze App: ${links.wazeApp}\nGoogle Maps: ${links.gmaps}`;
  }

  // ---------------------------------------------------------------------------
  // Whitelist
  // ---------------------------------------------------------------------------
  const seenUsernames = new Set(); // passively collected this session

  function noteUsername(name) {
    if (name) seenUsernames.add(name);
  }

  function isWhitelisted(name) {
    if (!name) return false;
    return settings.whitelist.some((w) => w.toLowerCase() === name.toLowerCase());
  }

  // ---------------------------------------------------------------------------
  // Closure detector
  // ---------------------------------------------------------------------------
  function roadTypeName(id) {
    return roadTypeNames[id] || ROAD_TYPE_FALLBACK[id] || `road type ${id}`;
  }

  // Human labels for WME update-request types, sources, and severities.
  const UPDATE_REQUEST_TYPE_NAMES = {
    BLOCKED_ROAD: "Blocked road",
    INCORRECT_ADDRESS: "Incorrect address",
    INCORRECT_GENERAL_ERROR: "General error",
    INCORRECT_JUNCTION: "Incorrect junction",
    INCORRECT_MISSING_ROUNDABOUT: "Missing roundabout",
    INCORRECT_ROUTE: "Incorrect route",
    INCORRECT_TURN: "Incorrect turn",
    MISSING_BRIDGE_OVERPASS: "Missing bridge/overpass",
    MISSING_EXIT: "Missing exit",
    MISSING_ROAD: "Missing road",
    TURN_NOT_ALLOWED: "Turn not allowed",
    WRONG_DRIVING_DIRECTIONS: "Wrong driving directions",
  };
  function updateRequestTypeName(type) {
    return UPDATE_REQUEST_TYPE_NAMES[type] || type || "Update request";
  }

  const UPDATE_REQUEST_SOURCE_NAMES = {
    MOBILE_CLIENT: "Waze app",
    MOBILE_WEB: "Mobile web",
    WEB: "Web",
    REPORTING_AGENT: "Reporting agent",
  };
  function updateRequestSourceName(src) {
    return UPDATE_REQUEST_SOURCE_NAMES[src] || src || null;
  }

  function severityLabel(sev) {
    return sev ? sev.charAt(0).toUpperCase() + sev.slice(1) : "Unknown";
  }

  // WME timestamps come as numbers; normalize ms → seconds for Discord <t:…>.
  function toDiscordUnix(n) {
    if (n == null) return null;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }

  // Human labels for WME edit-suggestion sources and suggested actions.
  const EDIT_SUGGESTION_SOURCE_NAMES = {
    CLIENT: "Client", GEO: "Geo", OTHER: "Other", WME: "WME", SYSTEM: "System",
  };
  function editSuggestionSourceName(src) {
    return EDIT_SUGGESTION_SOURCE_NAMES[src] || src || null;
  }
  function actionTypeName(a) {
    return a ? a.charAt(0).toUpperCase() + a.slice(1).toLowerCase() : a;
  }

  // GeoJSON BBox may be 2D [w,s,e,n] or 3D [w,s,minEle,e,n,maxEle]; normalize to
  // a 2D [minLon,minLat,maxLon,maxLat] box (the format pointInBox expects).
  function normBbox(b) {
    return b && b.length >= 6 ? [b[0], b[1], b[3], b[4]] : b;
  }
  function bboxCenter(box) {
    return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  }
  // Does a bbox overlap the scan polygon? True if the box's ring touches/enters
  // the region, or the region sits entirely inside the box.
  function bboxInPolygon(box, poly) {
    const [w, s, e, n] = box;
    const ring = [[w, s], [e, s], [e, n], [w, n], [w, s]];
    if (lineInPolygon(ring, poly)) return true;
    const outer = poly[0] || [];
    for (const pt of outer) if (pointInBox(pt, box)) return true;
    return false;
  }

  // Closure dates arrive as local wall time, "YYYY-MM-DD HH:mm". The ISO form
  // with a "T" is parsed as local time in every browser; the space form isn't
  // guaranteed to parse at all.
  function toUnixSeconds(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr);
    const t = Date.parse(/^\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(" ", "T") : s);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }

  function isLiveClosure(closure) {
    if (closure.status === "ACTIVE") return true;
    const start = toUnixSeconds(closure.startDate);
    return start != null && start * 1000 <= Date.now();
  }

  const ENDED_STATUSES = new Set([
    "FINISHED",
    "FINISHED_EARLY_DUE_TO_DELETION",
    "FINISHED_EARLY_DUE_TO_OVERLAPPING_CLOSURES",
    "FAILED",
  ]);

  // A closure is "ended" (and should not be reported) if its status marks it
  // finished/failed, or its end time is already in the past.
  function isEndedClosure(closure) {
    if (ENDED_STATUSES.has(closure.status)) return true;
    const end = toUnixSeconds(closure.endDate);
    return end != null && end * 1000 < Date.now();
  }

  // --- Scan memory (session-scoped) ---------------------------------------
  // The first scan of a region records a silent baseline; later scans alert only
  // on detections whose id wasn't seen before. Kept in memory so it lasts for
  // the browser-tab session and resets on reload — a reload re-baselines
  // silently instead of re-alerting every closure that already exists.
  const sessionSeen = new Map(); // "<regionKey>:<detector>" -> { baseline, ids:Set }
  function seenFor(region, detectorKey) {
    const k = regionKey(region) + ":" + detectorKey;
    let s = sessionSeen.get(k);
    if (!s) { s = { baseline: false, ids: new Set() }; sessionSeen.set(k, s); }
    return s;
  }

  // Raw Features closure -> the fields the closure detector reads.
  function normalizeClosure(raw, users) {
    return {
      id: String(raw.id),
      segmentId: raw.segID,
      isForward: !!raw.forward,
      startDate: raw.startDate,
      endDate: raw.endDate,
      status: raw.closureStatus,
      eventId: raw.eventId || null,
      geometry: raw.geometry,
      modificationData: { createdBy: users.get(raw.createdBy) || null },
    };
  }

  // Build a per-scan closure detector state.
  function makeClosureDetector() {
    const closuresById = new Map(); // dedupe across tiles

    return {
      key: "closure",
      collect(reply, tile, users) {
        for (const raw of (reply.roadClosures && reply.roadClosures.objects) || []) {
          if (!raw || raw.id == null || closuresById.has(String(raw.id))) continue;
          const c = normalizeClosure(raw, users);
          if (isEndedClosure(c)) continue; // skip closures that have already ended
          const coords = c.geometry && c.geometry.coordinates;
          if (!coords || !coords.length) continue;
          if (!tile.inside && !scanState.region.lineIn(coords)) continue;
          noteUsername(c.modificationData.createdBy);
          closuresById.set(c.id, c);
        }
      },
      async finalize(api) {
        const items = [...closuresById.values()];
        const store = seenFor(settings.region, "closure");

        // Which closures are newly seen this scan? Then mark everything seen.
        const fresh = items.filter((c) => !store.ids.has(c.id));
        for (const c of items) store.ids.add(c.id);

        if (!store.baseline) {
          // First scan of this region: record a silent baseline, no alerts.
          store.baseline = true;
          return 0;
        }
        if (!fresh.length) return 0;

        // Group only the newly-appeared closures that touch or share an event.
        const groups = groupClosures(fresh);
        let sent = 0;
        for (const group of groups) {
          const context = await closureContext(api, group);
          const note = buildClosureNotification(group, context);
          if (!note) continue; // fully whitelisted
          const results = await sendNotification("closure", note);
          if (results.some((r) => r.endsWith(":ok"))) sent++;
        }
        return sent;
      },
    };
  }

  // Union-find: closures on the same segment or the same closure event, or
  // whose geometries share an endpoint (within ~2 m), form one group.
  const ENDPOINT_TOLERANCE_DEG = 2e-5;
  function groupClosures(closures) {
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
    const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };

    const cellSize = ENDPOINT_TOLERANCE_DEG * 5;
    const cells = new Map(); // "cx:cy" -> [{ pt, key }]
    const cellOf = (pt) => [Math.floor(pt[0] / cellSize), Math.floor(pt[1] / cellSize)];
    for (const c of closures) {
      const key = "c" + c.id;
      add(key);
      if (c.segmentId != null) union(key, "s" + c.segmentId);
      if (c.eventId) union(key, "e" + c.eventId);
      const coords = c.geometry.coordinates;
      for (const pt of [coords[0], coords[coords.length - 1]]) {
        const [cx, cy] = cellOf(pt);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const other of cells.get(`${cx + dx}:${cy + dy}`) || []) {
              if (Math.abs(other.pt[0] - pt[0]) <= ENDPOINT_TOLERANCE_DEG && Math.abs(other.pt[1] - pt[1]) <= ENDPOINT_TOLERANCE_DEG) union(key, other.key);
            }
          }
        }
        const k = `${cx}:${cy}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ pt, key });
      }
    }
    const buckets = new Map();
    for (const c of closures) {
      const root = find("c" + c.id);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(c);
    }
    return [...buckets.values()];
  }

  // Closures-only replies carry no segments or street names, so look up just
  // the segments a new group sits on (one small request, rarely more) for the
  // notification's road names and types. A failed lookup only costs the names.
  async function closureContext(api, group) {
    const segments = new Map(), streets = new Map();
    try {
      const coords = group.flatMap((c) => c.geometry.coordinates);
      const box = padBbox(bboxOfRing(coords), 0.05);
      const nx = Math.max(1, Math.ceil((box[2] - box[0]) / ROAD_TILE_DEG));
      const ny = Math.max(1, Math.ceil((box[3] - box[1]) / ROAD_TILE_DEG));
      if (nx * ny > 16) return { segments, streets }; // a sprawling event: names aren't worth 16+ requests
      const w = (box[2] - box[0]) / nx, h = (box[3] - box[1]) / ny;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const reply = await api.features([box[0] + i * w, box[1] + j * h, box[0] + (i + 1) * w, box[1] + (j + 1) * h], { roadTypes: ALL_ROAD_TYPES });
          for (const s of (reply.segments && reply.segments.objects) || []) segments.set(s.id, s);
          for (const st of (reply.streets && reply.streets.objects) || []) if (st.name) streets.set(st.id, st.name);
        }
      }
    } catch (e) {
      if (e.stopped) throw e;
      console.warn("[WME Auto Scan] couldn't look up closure road names", e);
    }
    return { segments, streets };
  }

  function buildClosureNotification(group, context) {
    // Suppress whole group only if every closure's reporter is whitelisted.
    const visible = group.filter((c) => !isWhitelisted(c.modificationData.createdBy));
    if (!visible.length) return null;

    // Collapse closures onto their segment: a two-way closure produces one
    // record per direction on the same segment, so we group by segment id and
    // present a single line per segment (direction merged).
    const bySeg = new Map(); // segId -> closures
    for (const c of visible) {
      if (!bySeg.has(c.segmentId)) bySeg.set(c.segmentId, []);
      bySeg.get(c.segmentId).push(c);
    }

    const lines = [];
    const plainLines = [];
    let allCoords = [];
    const segIds = [];

    for (const [segmentId, closures] of bySeg) {
      if (segmentId != null) segIds.push(segmentId);
      const seg = context.segments.get(segmentId);
      const coords = (seg && seg.geometry && seg.geometry.coordinates) || closures.flatMap((c) => c.geometry.coordinates);
      allCoords = allCoords.concat(coords);
      const rt = seg ? roadTypeName(seg.roadType) : "road";
      const name = (seg && context.streets.get(seg.primaryStreetID)) || "Unnamed road";
      const dir = directionLabel(closures);
      const reporters = uniqueReporters(closures);
      const reporterMd = reporters.map((r) => (r ? `[${r}](${PROFILE_URL(r)})` : "unknown")).join(", ");
      const reporterPlain = reporters.map((r) => r || "unknown").join(", ");
      // Merge identical timings (forward/reverse usually share one).
      const timings = [...new Set(closures.map(closureTimingMarkdown))];
      const timingsPlain = [...new Set(closures.map(closureTimingPlain))];
      lines.push(`• **${name}** — ${rt} (${dir}) — added by ${reporterMd}\n  ${timings.join("\n  ")}`);
      plainLines.push(`- ${name} — ${rt} (${dir}) — added by ${reporterPlain}\n  ${timingsPlain.join("\n  ")}`);
    }

    const bbox = padBbox(bboxOfRing(allCoords), 0.15);
    const centroid = centroidOfBbox(bbox);
    const links = buildLinks(centroid, segIds, bbox);

    const title = bySeg.size === 1
      ? "Road closure"
      : `Road closures (${bySeg.size} connected segments)`;

    return {
      title,
      color: COLORS.closure,
      discordDescription: `${lines.join("\n")}\n\n${linksMarkdown(links)}`,
      plainText: `${plainLines.join("\n")}\n\n${linksPlain(links)}`,
    };
  }

  // Merge the direction(s) of a segment's closures into one label.
  function directionLabel(closures) {
    const fwd = closures.some((c) => c.isForward);
    const rev = closures.some((c) => !c.isForward);
    if (fwd && rev) return "both directions";
    if (fwd) return "A→B";
    return "B→A";
  }

  function uniqueReporters(closures) {
    const names = [...new Set(closures.map((c) => c.modificationData && c.modificationData.createdBy).filter(Boolean))];
    return names.length ? names : [null];
  }

  function closureTimingMarkdown(c) {
    const start = toUnixSeconds(c.startDate);
    const end = toUnixSeconds(c.endDate);
    if (isLiveClosure(c)) {
      return end ? `Active until <t:${end}:F> (<t:${end}:R>)` : `Active — no end time`;
    }
    if (start && end) return `Scheduled from <t:${start}:F> (<t:${start}:R>) to <t:${end}:F>`;
    if (start) return `Scheduled from <t:${start}:F> (<t:${start}:R>)`;
    return `Time not available`;
  }

  function closureTimingPlain(c) {
    const fmt = (s) => (s ? new Date(s * 1000).toLocaleString() : "?");
    const start = toUnixSeconds(c.startDate);
    const end = toUnixSeconds(c.endDate);
    if (isLiveClosure(c)) return end ? `Active until ${fmt(end)}` : "Active — no end time";
    if (start && end) return `Scheduled from ${fmt(start)} to ${fmt(end)}`;
    if (start) return `Scheduled from ${fmt(start)}`;
    return "Time not available";
  }

  // ---------------------------------------------------------------------------
  // Issue Tracker search (Update Requests, Map Suggestions)
  // ---------------------------------------------------------------------------
  // The Issue Tracker's bbox search goes over gRPC-web (binary protobuf), so it
  // runs through WME's own client — the call WME makes for its Issue Tracker
  // layer — with the script's own filters: every open Update Request and open
  // Map Suggestion, whatever the editor's Issue Tracker filter panel is set to.
  // Results are WME model objects; the normalizers below read them the same way
  // the SDK does, so the detectors see SDK-shaped data.
  const ISSUE_TILE_DEG = 1; // 2° boxes returned 400+ results per group with no sign of a cap
  const ISSUE_SPLIT_AT = 500; // a group this full may be capped (Features caps at 500): split
  const ISSUE_MIN_TILE_DEG = 0.0625;

  function issueClient() {
    const W = PAGE.W;
    const client = W && W.issueTrackerController && W.issueTrackerController.descartesClient;
    if (!client || typeof client.searchIssuesByBbox !== "function" || !W.map) {
      throw new Error("WME's Issue Tracker search isn't available in this WME version. Scan stopped; baseline was not updated.");
    }
    return client;
  }

  async function searchIssues(box, keys, isStopped) {
    const client = issueClient();
    const params = { bbox: box.map((v) => +v.toFixed(6)) };
    if (keys.includes("report")) params.mapUpdateRequestsFilter = { isOpen: true, commentCountRanges: [] };
    if (keys.includes("suggestion")) params.mapSuggestionsFilter = { status: ["OPEN"] };
    let failures = 0;
    for (;;) {
      if (isStopped()) throw stoppedError();
      try {
        // Page-owned copies, so WME's code never handles userscript-sandbox objects.
        const pageParams = PAGE.JSON.parse(JSON.stringify(params));
        const uuid = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
        const result = await client.searchIssuesByBbox(pageParams, PAGE.W.map, uuid);
        if (isStopped()) throw stoppedError();
        return result || {};
      } catch (e) {
        if (e && e.stopped) throw e;
        if (++failures > MAX_RETRIES) {
          throw new Error(`WME's Issue Tracker search kept failing (${(e && e.message) || e}). Scan stopped; baseline was not updated.`);
        }
        await sleep(RETRY_BASE_MS * 2 ** (failures - 1));
      }
    }
  }

  function issuePass(keys, polygon) {
    const count = (reply, k) => ((reply[k] && reply[k].objects) || []).length;
    return {
      label: "issues", keys, tiles: regionTiles(polygon, ISSUE_TILE_DEG),
      fetch: (api, tile) => searchIssues(tile.box, keys, () => !scanState.running),
      // A group that hit a possible cap is re-searched as quarters (items are
      // deduped by id, so overlap with the parent reply is harmless).
      split: (reply, tile) => {
        const full = ["mapUpdateRequests", "editSuggestions", "segmentSuggestions"].some((k) => count(reply, k) >= ISSUE_SPLIT_AT);
        if (!full) return null;
        if (tile.box[2] - tile.box[0] <= ISSUE_MIN_TILE_DEG) {
          console.warn("[WME Auto Scan] An Issue Tracker search returned 500+ results in a small area; some may be missing.");
          return null;
        }
        return quarterTiles(tile);
      },
    };
  }

  // Getter-or-attribute access on a WME model object.
  function modelAttr(m, key) {
    if (!m) return undefined;
    if (typeof m.getAttribute === "function") return m.getAttribute(key);
    return m.attributes ? m.attributes[key] : m[key];
  }
  function modelCall(m, method, fallback) {
    return m && typeof m[method] === "function" ? m[method]() : fallback;
  }

  // WME's numeric Update Request types (mirrors the SDK's table).
  const UPDATE_REQUEST_TYPES = {
    6: "INCORRECT_TURN", 7: "INCORRECT_ADDRESS", 8: "INCORRECT_ROUTE", 9: "INCORRECT_MISSING_ROUNDABOUT",
    10: "INCORRECT_GENERAL_ERROR", 11: "TURN_NOT_ALLOWED", 12: "INCORRECT_JUNCTION", 13: "MISSING_BRIDGE_OVERPASS",
    14: "WRONG_DRIVING_DIRECTIONS", 15: "MISSING_EXIT", 16: "MISSING_ROAD", 19: "BLOCKED_ROAD",
  };

  function normalizeUpdateRequest(m) {
    const type = modelAttr(m, "type");
    return {
      id: modelCall(m, "getID", modelAttr(m, "id")),
      isOpen: modelCall(m, "getOpenState", modelAttr(m, "open")),
      resolvedOn: modelCall(m, "getResolvedOn", modelAttr(m, "resolvedOn")) ?? null,
      geometry: modelAttr(m, "geoJSONGeometry") || modelCall(m, "getLocation", null),
      description: modelCall(m, "getDescription", modelAttr(m, "description")) || null,
      reportedOn: modelCall(m, "getDriveDate", modelAttr(m, "driveDate")),
      severity: modelCall(m, "getSeverity", null),
      source: modelCall(m, "getSource", modelAttr(m, "source")),
      updateRequestType: UPDATE_REQUEST_TYPES[type] || null,
      typeText: modelAttr(m, "typeText") || null,
    };
  }

  function normalizeEditSuggestion(m) {
    const suggestions = modelCall(m, "getSuggestions", modelAttr(m, "suggestions")) || [];
    return {
      id: String(modelCall(m, "getID", modelAttr(m, "id"))),
      bbox: modelCall(m, "getBbox", modelAttr(m, "bbox")),
      source: modelAttr(m, "source"),
      status: modelCall(m, "getStatus", modelAttr(m, "status")),
      modificationData: { createdOn: modelCall(m, "getCreatedOn", modelAttr(m, "createdOn")) ?? null },
      suggestions: [...suggestions].map((x) => ({
        edits: [...(modelCall(x, "getEntityEdits", x && x.edits) || [])].map((e) => ({ actionType: e.actionType, objectType: e.objectType })),
      })),
    };
  }

  function normalizeSegmentSuggestion(m) {
    return {
      id: String(modelCall(m, "getID", modelAttr(m, "id"))),
      status: modelAttr(m, "status"),
      source: modelAttr(m, "source"),
      geometry: modelAttr(m, "geoJSONGeometry"),
      streetName: modelAttr(m, "streetName") || null,
      cityName: modelAttr(m, "cityName") || null,
      roadType: modelAttr(m, "roadType"),
      createdOn: modelAttr(m, "createdOn") ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Update request detector ("Update Requests")
  // ---------------------------------------------------------------------------
  // Open user-reported update requests — the map problem reports drivers file
  // from the app. URs carry no editor username, so the whitelist doesn't apply.
  function makeReportDetector() {
    const requestsById = new Map(); // dedupe across tiles
    return {
      key: "report",
      collect(reply, tile) {
        for (const m of (reply.mapUpdateRequests && reply.mapUpdateRequests.objects) || []) {
          const r = normalizeUpdateRequest(m);
          if (r.id == null || requestsById.has(r.id)) continue; // cross-tile dedupe
          if (!r.isOpen || r.resolvedOn != null) continue; // only open/unresolved
          const pt = r.geometry && r.geometry.coordinates;
          if (!pt) continue;
          if (!tile.inside && !scanState.region.pointIn(pt)) continue; // region filter
          requestsById.set(r.id, r);
        }
      },
      async finalize() {
        const items = [...requestsById.values()];
        const store = seenFor(settings.region, "report");
        // Which requests are newly seen this scan? Then mark everything seen.
        const fresh = items.filter((r) => !store.ids.has(String(r.id)));
        for (const r of items) store.ids.add(String(r.id));
        if (!store.baseline) { store.baseline = true; return 0; } // silent first scan
        if (!fresh.length) return 0;
        let sent = 0;
        for (const r of fresh) {
          const note = buildUpdateRequestNotification(r);
          const results = await sendNotification("report", note);
          if (results.some((x) => x.endsWith(":ok"))) sent++;
        }
        return sent;
      },
    };
  }

  function buildUpdateRequestNotification(r) {
    const [lon, lat] = r.geometry.coordinates;
    const links = buildLinks({ lat, lon }, []);
    const type = r.updateRequestType ? updateRequestTypeName(r.updateRequestType) : (r.typeText || "Update request");
    const sev = severityLabel(r.severity);
    const src = updateRequestSourceName(r.source);
    const reported = toDiscordUnix(r.reportedOn);

    const md = [`**Type:** ${type}`, `**Severity:** ${sev}`];
    const plain = [`Type: ${type}`, `Severity: ${sev}`];
    if (src) { md.push(`**Source:** ${src}`); plain.push(`Source: ${src}`); }
    if (reported) {
      md.push(`**Reported:** <t:${reported}:F> (<t:${reported}:R>)`);
      plain.push(`Reported: ${new Date(reported * 1000).toLocaleString()}`);
    }
    if (r.description) {
      md.push(`**Comment:** ${r.description}`);
      plain.push(`Comment: ${r.description}`);
    }

    return {
      title: `Update request: ${type}`,
      color: COLORS.report,
      discordDescription: `${md.join("\n")}\n\n${linksMarkdown(links)}`,
      plainText: `Update request: ${type}\n${plain.join("\n")}\n\n${linksPlain(links)}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Map suggestion detector ("Map Suggestions")
  // ---------------------------------------------------------------------------
  // Open map suggestions awaiting review: edit suggestions (suggested changes to
  // existing objects, region-tested by their bbox) and, unless turned off,
  // segment suggestions (proposed new roads, region-tested by their line).
  const SUGGESTION_OPEN_STATUSES = new Set(["OPEN", "OPEN_AND_CLOSED"]);
  function makeSuggestionDetector() {
    const suggestionsById = new Map(); // "edit:<id>" / "segment:<id>" -> item
    const withSegments = settings.detectors.suggestion.includeSegments !== false;
    return {
      key: "suggestion",
      collect(reply, tile) {
        for (const m of (reply.editSuggestions && reply.editSuggestions.objects) || []) {
          const s = normalizeEditSuggestion(m);
          const key = "edit:" + s.id;
          if (suggestionsById.has(key)) continue;               // cross-tile dedupe
          if (!SUGGESTION_OPEN_STATUSES.has(s.status)) continue; // only open ones
          const box = normBbox(s.bbox);
          if (!box || box.length < 4) continue;
          if (!tile.inside && !scanState.region.boxIn(box)) continue; // region filter
          suggestionsById.set(key, { kind: "edit", item: s });
        }
        if (!withSegments) return;
        for (const m of (reply.segmentSuggestions && reply.segmentSuggestions.objects) || []) {
          const s = normalizeSegmentSuggestion(m);
          const key = "segment:" + s.id;
          if (suggestionsById.has(key)) continue;
          if (!SUGGESTION_OPEN_STATUSES.has(s.status)) continue;
          const coords = s.geometry && s.geometry.coordinates;
          if (!coords || !coords.length) continue;
          if (!tile.inside && !scanState.region.lineIn(coords)) continue;
          suggestionsById.set(key, { kind: "segment", item: s });
        }
      },
      async finalize() {
        const store = seenFor(settings.region, "suggestion");
        const fresh = [...suggestionsById.entries()].filter(([key]) => !store.ids.has(key));
        for (const key of suggestionsById.keys()) store.ids.add(key);
        if (!store.baseline) { store.baseline = true; return 0; } // silent first scan
        let sent = 0;
        for (const [, { kind, item }] of fresh) {
          const note = kind === "edit" ? buildSuggestionNotification(item) : buildSegmentSuggestionNotification(item);
          const results = await sendNotification("suggestion", note);
          if (results.some((x) => x.endsWith(":ok"))) sent++;
        }
        return sent;
      },
    };
  }

  function buildSuggestionNotification(s) {
    const [lon, lat] = bboxCenter(normBbox(s.bbox));
    const links = buildLinks({ lat, lon }, [], normBbox(s.bbox));
    const src = editSuggestionSourceName(s.source);
    const created = toDiscordUnix(s.modificationData && s.modificationData.createdOn);

    // Summarize the suggested changes (e.g. "Add segment", "Update venue").
    const edits = (s.suggestions || []).flatMap((x) => x.edits || []);
    const changes = [...new Set(edits.map((e) => `${actionTypeName(e.actionType)} ${e.objectType}`.trim()))];
    const changeText = changes.length ? changes.join(", ") : "Suggested edit";

    const md = [`**Changes:** ${changeText}`];
    const plain = [`Changes: ${changeText}`];
    if (src) { md.push(`**Source:** ${src}`); plain.push(`Source: ${src}`); }
    if (created) {
      md.push(`**Created:** <t:${created}:F> (<t:${created}:R>)`);
      plain.push(`Created: ${new Date(created * 1000).toLocaleString()}`);
    }

    return {
      title: `Map suggestion: ${changeText}`.slice(0, 256),
      color: COLORS.suggestion,
      discordDescription: `${md.join("\n")}\n\n${linksMarkdown(links)}`,
      plainText: `Map suggestion\n${plain.join("\n")}\n\n${linksPlain(links)}`,
    };
  }

  function buildSegmentSuggestionNotification(s) {
    const box = bboxOfRing(s.geometry.coordinates);
    const centroid = centroidOfBbox(box);
    const links = buildLinks(centroid, [], padBbox(box, 0.15));
    const src = editSuggestionSourceName(s.source);
    const created = toDiscordUnix(s.createdOn);
    const road = [s.streetName || "Unnamed road", s.roadType != null ? roadTypeName(s.roadType) : null].filter(Boolean).join(" — ");
    const where = s.cityName ? ` in ${s.cityName}` : "";

    const md = [`**New road:** ${road}${where}`];
    const plain = [`New road: ${road}${where}`];
    if (src) { md.push(`**Source:** ${src}`); plain.push(`Source: ${src}`); }
    if (created) {
      md.push(`**Created:** <t:${created}:F> (<t:${created}:R>)`);
      plain.push(`Created: ${new Date(created * 1000).toLocaleString()}`);
    }

    return {
      title: "Map suggestion: New road",
      color: COLORS.suggestion,
      discordDescription: `${md.join("\n")}\n\n${linksMarkdown(links)}`,
      plainText: `Map suggestion\n${plain.join("\n")}\n\n${linksPlain(links)}`,
    };
  }

  // ---------------------------------------------------------------------------
  // User edits: metadata discovery + paginated, read-only ElementHistory.
  // Keep this undocumented endpoint isolated: unexpected data fails closed.
  // ---------------------------------------------------------------------------
  const EDIT_STORAGE_PREFIX = "wme-auto-scan:edits:v1:";
  // An object's data-model updatedOn can sit ahead of its newest ElementHistory
  // own-transaction: related-object edits (moving a node, turn/connection edits,
  // house numbers) bump updatedOn without producing a segment/venue transaction,
  // and timestamps can differ by sub-second rounding. That's a normal steady
  // state, not lag, so the "caught up" check must not retry it forever. We only
  // keep retrying while the edit is still fresh enough to be genuine replication
  // lag; past that window we accept the newest own-transaction as the caught-up
  // point so the retry queue can't wedge. (Any own-transaction within range is
  // still reported regardless — accepting here only forgoes waiting for one that
  // has not appeared in the endpoint yet.)
  const EDIT_CAUGHT_UP_GRACE_MS = 20000;
  const EDIT_SAVE_EVERY_MS = 5000; // checkpoint save throttle while reading histories
  let editStatus = "Not scanned yet.";

  function editTime(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Missing edit timestamp");
    return n < 1e12 ? n * 1000 : n;
  }

  function editEndpoint() {
    return new URL(apiBase() + "/ElementHistory");
  }

  async function fetchEditHistory(endpoint, item, cursor) {
    const url = new URL(endpoint);
    url.searchParams.set("objectType", item.type);
    url.searchParams.set("objectID", item.id);
    if (cursor != null) url.searchParams.set("till", cursor);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error(`History HTTP ${response.status}`);
      const page = await response.json();
      if (!Array.isArray(page.transactions?.objects)) throw new Error("Unrecognized history response");
      return page;
    } finally { clearTimeout(timer); }
  }

  // `region` is an indexPolygon() index of the scan area.
  function editGeometryInRegion(geometry, region) {
    if (!geometry) return false;
    if (geometry.type === "Point") return region.pointIn(geometry.coordinates);
    if (geometry.type === "LineString") return region.lineIn(geometry.coordinates);
    if (geometry.type === "Polygon") {
      if (geometry.coordinates.some((ring) => region.lineIn(ring))) return true;
      // Neither touches the other's boundary: the region can only overlap by
      // lying wholly inside the place, so testing one region vertex is enough.
      const box = geometryBbox(geometry);
      return !!box && pointInBox(region.firstPoint, box) && pointInPolygon(region.firstPoint, geometry.coordinates);
    }
    return false;
  }

  function setEditStatus(message) {
    editStatus = message;
    const node = tabPane && tabPane.querySelector(".was-edit-status");
    if (node) node.textContent = message;
  }

  // A checkpoint retains IDs at its timestamp so equally dated transactions
  // can be fetched again without dropping or double-counting them.
  async function readNewEditEvents(endpoint, item, checkpoint, budget, persistProgress = () => {}) {
    const progress = item.progress;
    let cursor = progress?.cursor ?? null;
    const cursors = new Set(progress?.cursors || []);
    const users = new Map(progress?.users || []);
    const transactions = new Map(progress?.transactions || []);
    let newest = progress?.newest || 0;
    let complete = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      if (!scanState.running) throw new Error("History paused");
      if (budget.remaining-- <= 0) throw new Error("History request budget reached; continuing next scan");
      await sleep(1000);
      if (!scanState.running) throw new Error("History paused");
      const page = await fetchEditHistory(endpoint, item, cursor);
      for (const user of page.users?.objects || []) {
        if (typeof user.userName === "string") users.set(String(user.id), user.userName);
      }
      let older = false;
      for (const tx of page.transactions.objects) {
        const date = editTime(tx.date);
        newest = Math.max(newest, date);
        if (date < checkpoint.time) { older = true; continue; }
        if (date > item.time) continue; // leave concurrent edits for the next observation
        if (tx.transactionID == null || !Array.isArray(tx.objects)) throw new Error("Unrecognized history transaction");
        const id = String(tx.transactionID);
        if (date === checkpoint.time && (checkpoint.baseline || checkpoint.ids.includes(id))) continue;
        // Related objects (nodes, turns, etc.) are not separate segment/place edits.
        const object = tx.objects.find((o) => o.objectType === item.type && String(o.objectID) === item.id);
        if (!object) continue;
        const action = object.actionType || tx.actionType;
        if (!["ADD", "UPDATE", "DELETE"].includes(action)) throw new Error("Unknown history action");
        if (tx.userID == null) throw new Error("History actor missing");
        transactions.set(id, { id, date, userID: String(tx.userID), type: item.type, objectId: item.id, bbox: item.bbox });
      }
      const next = page.transactions.nextTransaction;
      if (older || next == null) { complete = true; break; }
      if (cursors.has(String(next))) throw new Error("History pagination repeated a cursor");
      cursors.add(String(next));
      cursor = next;
      item.progress = { cursor, cursors: [...cursors], users: [...users], transactions: [...transactions], newest };
      persistProgress();
    }
    if (!complete) throw new Error("Long history paused after 20 pages; continuing next scan");
    delete item.progress;
    // Compare at whole-second granularity so sub-second rounding never wedges.
    // Only retry while the edit is fresh enough to plausibly still be replicating;
    // an older gap means updatedOn was bumped without an own-transaction — accept it.
    if (Math.floor(newest / 1000) < Math.floor(item.time / 1000) &&
        Date.now() - item.time < EDIT_CAUGHT_UP_GRACE_MS)
      throw new Error("History has not caught up with map metadata; retry pending");
    const events = [...transactions.values()].map((event) => {
      const name = users.get(event.userID);
      if (!name) throw new Error("History username missing; retry pending");
      return { ...event, name, delivered: [] };
    });
    return {
      events,
      checkpoint: { time: item.time, ids: [...new Set([
        ...(checkpoint.time === item.time ? checkpoint.ids : []),
        ...events.filter((e) => e.date === item.time).map((e) => e.id),
      ])] },
    };
  }

  // Base WME permalink for the current map view, stripped of any object
  // selection so we can append a single segment/place per link below.
  function editPermalinkBase() {
    return wme.permalink // cached by refreshWmeInfo()
      .replace(/([?&])(segments|venues)=[^&]*/g, "$1")
      .replace(/&&+/g, "&").replace(/\?&/, "?").replace(/[?&]$/, "");
  }

  function objectPermalink(base, type, id, bbox) {
    const param = type === "venue" ? "venues" : "segments";
    // Land on and fit the object, and select it via the id param, rather than
    // inheriting the last scanned tile's view.
    const at = permalinkAt(base, bbox && centroidOfBbox(bbox), zoomForBbox(bbox));
    return `${at}${at.includes("?") ? "&" : "?"}${param}=${id}`;
  }

  const EDIT_PERMALINK_LIMIT = 3;

  function buildEditNotification(name, events) {
    const base = editPermalinkBase();
    const bboxById = new Map();
    for (const e of events) if (e.bbox && !bboxById.has(e.objectId)) bboxById.set(e.objectId, e.bbox);
    const lines = [];
    const plainLines = [];
    for (const [type, label] of [["segment", "Segment"], ["venue", "Place"]]) {
      const items = events.filter((e) => e.type === type);
      if (!items.length) continue;
      const ids = [...new Set(items.map((e) => e.objectId))];
      const noun = label.toLowerCase();
      const summary = `${items.length} ${label} edit${items.length === 1 ? "" : "s"} across ${ids.length} unique ${noun}${ids.length === 1 ? "" : "s"}`;
      const shown = ids.slice(0, EDIT_PERMALINK_LIMIT);
      const more = ids.length > shown.length ? ` +${ids.length - shown.length} more` : "";
      const linksMd = shown.map((id) => `[${id}](${objectPermalink(base, type, id, bboxById.get(id))})`).join(" ");
      const linksPlain = shown.map((id) => `${id}: ${objectPermalink(base, type, id, bboxById.get(id))}`).join("\n    ");
      lines.push(`- ${summary} — ${linksMd}${more}`);
      plainLines.push(`- ${summary}${more}\n    ${linksPlain}`);
    }
    const dates = events.map((e) => e.date);
    const period = `${new Date(dates.reduce((a, b) => Math.min(a, b), Infinity)).toLocaleString()} – ${new Date(dates.reduce((a, b) => Math.max(a, b), 0)).toLocaleString()}`;
    return {
      title: `User edits: ${name}`,
      color: COLORS.edit,
      discordDescription: `${period}\n${lines.join("\n")}\n\n[User Profile](${PROFILE_URL(name)})`,
      plainText: `${period}\n${plainLines.join("\n")}\n\nUser Profile: ${PROFILE_URL(name)}`,
    };
  }

  async function deliverEditEvents(store, persist) {
    const ch = resolveChannels("edit");
    const channels = [];
    if (ch.discordWebhook) channels.push("discord");
    if (ch.pushoverToken && ch.pushoverUser) channels.push("pushover");
    if (!channels.length) return 0;
    let sent = 0;
    const cooldown = Math.max(0, Number(settings.detectors.edit.cooldownMin) || 0) * 60000;
    for (const userID of Object.keys(store.pending)) {
      if (!scanState.running) break;
      const events = store.pending[userID];
      if (!events.length) continue;
      if (isWhitelisted(events[0].name)) { delete store.pending[userID]; persist(); continue; }
      const last = store.lastSent[userID];
      // Partially delivered events retry immediately, even during cooldown.
      if (last && Date.now() - last < cooldown && !events.some((e) => e.delivered.length)) continue;
      for (const channel of channels) {
        const unsent = events.filter((e) => !e.delivered.includes(channel));
        if (!unsent.length) continue;
        const config = channel === "discord" ? { discordWebhook: ch.discordWebhook } : { ...ch, discordWebhook: "" };
        const results = await sendNotification("edit", buildEditNotification(events[0].name, unsent), config);
        if (results.includes(channel + ":ok")) {
          unsent.forEach((e) => e.delivered.push(channel));
          persist(); // do not resend a successful channel when the other fails
        }
      }
      store.pending[userID] = events.filter((e) => !channels.every((c) => e.delivered.includes(c)));
      if (store.pending[userID].length < events.length) { store.lastSent[userID] = Date.now(); sent++; }
      if (!store.pending[userID].length) delete store.pending[userID];
      persist();
    }
    return sent;
  }

  function makeEditDetector() {
    const endpoint = editEndpoint();
    const region = JSON.parse(JSON.stringify(settings.region));
    // Full coordinates prevent region-hash collisions from sharing checkpoints.
    const key = EDIT_STORAGE_PREFIX + endpoint.origin + endpoint.pathname + ":" + regionKey(region);
    const coordinates = JSON.stringify(region.coordinates);
    const raw = GM_getValue(key, null);
    const store = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {
      coordinates, baselineAt: null, checkpoints: {}, retry: {}, pending: {}, lastSent: {},
    };
    if (store.coordinates !== coordinates || !store.checkpoints || !store.retry || !store.pending || !store.lastSent) {
      throw new Error("User edits storage is incompatible; checkpoint was not reset");
    }
    const persist = () => {
      try { GM_setValue(key, JSON.stringify(store)); }
      catch (e) {
        const error = new Error("Could not persist User edits; scan stopped: " + e.message);
        error.editStorageFailure = true;
        throw error;
      }
    };
    const collected = new Map();
    let missingMetadata = 0;
    return {
      key: "edit",
      collect(reply, tile) {
        const lists = [["segment", (reply.segments && reply.segments.objects) || []]];
        if (!settings.global.skipPlaces) lists.push(["venue", (reply.venues && reply.venues.objects) || []]);
        for (const [type, objects] of lists) {
          for (const object of objects) {
            const id = String(object.id);
            if (!id || id.startsWith("-")) continue;
            if (!(object.updatedOn || object.createdOn)) { missingMetadata++; continue; }
            const item = { type, id, time: editTime(object.updatedOn || object.createdOn) };
            const objectKey = type + ":" + id;
            // Objects crossing a tile edge come back in each tile. Do the
            // potentially expensive polygon intersection only for new versions.
            if (collected.has(objectKey) && collected.get(objectKey).time >= item.time) continue;
            if (!tile.inside && !editGeometryInRegion(object.geometry, scanState.region)) continue;
            item.bbox = geometryBbox(object.geometry); // for permalinks that land on and fit the object
            if (!collected.has(objectKey) || collected.get(objectKey).time < item.time) collected.set(objectKey, item);
          }
        }
      },
      async finalize() {
        if (store.baselineAt == null) {
          for (const [id, item] of collected) store.checkpoints[id] = { time: item.time, ids: [], baseline: true };
          store.baselineAt = scanState.startTime;
          persist();
          setEditStatus(`Baseline saved: ${collected.size} objects. Future changes will be reported.${missingMetadata ? " Some objects lack metadata." : ""}`);
          return 0;
        }
        // Persist discovered work before fetching so failed/unloaded objects retry.
        for (const [id, item] of collected) {
          const checkpoint = store.checkpoints[id];
          if ((!checkpoint || item.time > checkpoint.time) && (!store.retry[id] || item.time > store.retry[id].time)) store.retry[id] = item;
        }
        persist();
        const budget = { remaining: 25 };
        let failures = 0, processed = 0, lastError = "";
        // The store holds a checkpoint per object in the region, so writing it is
        // slow; checkpoints are saved at most every few seconds and once after
        // the loop. A crash in between only re-reads those histories next scan
        // (pending events are deduped), and delivery still saves immediately.
        let savedAt = Date.now();
        const persistSoon = () => { if (Date.now() - savedAt >= EDIT_SAVE_EVERY_MS) { persist(); savedAt = Date.now(); } };
        const total = Object.keys(store.retry).length;
        for (const [id, item] of Object.entries(store.retry)) {
          if (!scanState.running || budget.remaining <= 0) break;
          setEditStatus(`Reading history: ${++processed}/${total} objects…`);
          try {
            const checkpoint = store.checkpoints[id] || { time: store.baselineAt, ids: [], baseline: true };
            // An old object discovered later is silently baselined.
            const result = item.time <= checkpoint.time ? { events: [], checkpoint } :
              await readNewEditEvents(endpoint, item, checkpoint, budget);
            for (const event of result.events) {
              noteUsername(event.name);
              if (isWhitelisted(event.name)) continue;
              const events = store.pending[event.userID] || (store.pending[event.userID] = []);
              if (!events.some((e) => e.id === event.id && e.type === event.type && e.objectId === event.objectId)) events.push(event);
            }
            store.checkpoints[id] = result.checkpoint;
            delete store.retry[id];
            persistSoon();
          } catch (e) {
            if (e.editStorageFailure) throw e;
            failures++; lastError = e.message;
            console.warn(`[WME Auto Scan] ${id}: ${e.message}`);
            // Move a failing object to the end so it cannot starve the queue.
            delete store.retry[id]; store.retry[id] = item;
            persistSoon();
            if (/HTTP (401|403|429)|Unrecognized history/.test(e.message)) break;
          }
        }
        persist();
        const sent = await deliverEditEvents(store, persist);
        const waiting = Object.values(store.pending).reduce((n, events) => n + events.length, 0);
        setEditStatus(`${sent} user summaries sent; ${waiting} edits awaiting cooldown/delivery; ${Object.keys(store.retry).length} histories pending.${failures ? " " + lastError : ""}${missingMetadata ? " Some objects lack metadata." : ""}`);
        return sent;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Scan engine
  // ---------------------------------------------------------------------------
  const scanState = {
    running: false,
    scheduled: false, // interval loop active
    polygon: null, // GeoJSON Polygon coordinates
    intervalTimer: null,
    api: null, // the running scan's API client (aborted on Stop)
    tilesDone: 0,
    tilesTotal: 0,
    startTime: 0, // ms timestamp the current scan began
    nextScanAt: 0, // ms timestamp the next scheduled scan will start
    passLabel: "", // which scan pass is running
  };

  function activeDetectors() {
    const out = [];
    if (settings.detectors.closure.enabled) out.push(makeClosureDetector());
    if (settings.detectors.report.enabled) out.push(makeReportDetector());
    if (settings.detectors.suggestion.enabled) out.push(makeSuggestionDetector());
    if (settings.detectors.edit.enabled) out.push(makeEditDetector());
    return out;
  }

  // --- Scan passes ---------------------------------------------------------
  // Each pass requests only what its detectors read, in boxes sized to that
  // data's server limit:
  //   closures — closures-only replies (~16× smaller than with roads), 1° boxes
  //   edits    — every road type (+ places), boxes under the street cut-off
  //   issues   — Update Requests + Map Suggestions from the Issue Tracker search
  function plannedPasses(keys = null) {
    const d = settings.detectors;
    const on = keys || Object.keys(d).filter((k) => d[k].enabled);
    const polygon = settings.region && settings.region.coordinates;
    if (!polygon) return [];
    const passes = [];
    if (on.includes("closure")) {
      passes.push({
        label: "closures", keys: ["closure"], tiles: regionTiles(polygon, CLOSURE_TILE_DEG),
        // An over-large box comes back with every list empty and no userAreas
        // key, which every real reply carries (even over open ocean).
        fetch: (api, tile) => api.features(tile.box, { roadClosures: true }),
        refused: (reply, tile) => !("userAreas" in reply) && tile.box[2] - tile.box[0] > CLOSURE_MIN_TILE_DEG,
      });
    }
    if (on.includes("edit")) {
      const places = settings.global.skipPlaces ? {} : { venueLevel: 4, venueFilter: "1,1,1,1" };
      const mask = loadMask(settings.region);
      passes.push({
        label: "edits", keys: ["edit"], tiles: editTiles(polygon, mask), optimized: !!(mask && mask.complete),
        fetch: (api, tile) => api.features(tile.box, { roadTypes: ALL_ROAD_TYPES, ...places }),
      });
    }
    const issueKeys = on.filter((k) => k === "report" || k === "suggestion");
    if (issueKeys.length) passes.push(issuePass(issueKeys, polygon));
    return passes;
  }

  // Fetch every tile of a pass, MAX_PARALLEL at a time, handing each reply to
  // the pass's detectors. A tile the pass refuses (or splits) is replaced by its
  // quarters. Any request that can't be completed fails the whole scan, so a
  // partial scan never turns later discoveries into new alerts.
  async function runPass(pass, detectors, api, state = scanState) {
    const queue = pass.tiles.map((t) => ({ ...t }));
    state.tilesTotal += queue.length;
    let failure = null, inFlight = 0;
    const worker = async () => {
      while (!failure && state.running) {
        if (!queue.length) {
          if (!inFlight) return;
          await sleep(50);
          continue;
        }
        const tile = queue.shift();
        inFlight++;
        try {
          const reply = await pass.fetch(api, tile);
          let children = null;
          if (pass.refused && pass.refused(reply, tile)) {
            children = quarterTiles(tile);
          } else {
            const users = userNames(reply);
            for (const det of detectors) det.collect(reply, tile, users);
            if (pass.split) children = pass.split(reply, tile);
          }
          // Let the page handle input and redraw between replies.
          await yieldToPage();
          if (children && children.length) {
            queue.unshift(...children);
            state.tilesTotal += children.length;
          }
          state.tilesDone++;
        } catch (e) {
          failure = failure || e;
        } finally {
          inFlight--;
        }
      }
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
    if (failure) throw failure;
    return state.running;
  }

  // --- User edits optimization -----------------------------------------------
  // User edits are scanned in small boxes (ROAD_TILE_DEG), so a large region
  // means thousands of requests — most of them over water or wilderness. An
  // optimize run requests every box once and records which hold any segment
  // (places are ignored); later User edits scans request only those. A road
  // created in a skipped box — or an edit to a place with no road nearby — is
  // missed until the next optimize, so a mask older than
  // MASK_STALE_DAYS asks to be refreshed. The other detectors always scan the
  // whole region: closures and Issue Tracker items use large boxes already, and
  // a "missing road" report sits exactly where no road is.
  const MASK_STORAGE_PREFIX = "wme-auto-scan:mask:v3:"; // v1/v2 belonged to the map-panning engine
  const MASK_STALE_DAYS = 30;
  const OPTIMIZE_SAVE_EVERY = 50; // persist optimize progress every N boxes (resumable)
  const OPTIMIZE_HELP = "Optimization only applies to User edits. It checks every User edits box in the region once and remembers which contain road segments, so User edits scans skip the ones without roads (water, wilderness). Places don't count: a place in an area with no roads won't be scanned. Road closures, Update Requests and Map Suggestions always scan the whole region. New roads built in a skipped area aren't seen until you optimize again.";
  const optimizeState = { running: false, api: null, tilesDone: 0, tilesTotal: 0, startTime: 0, productive: 0 };

  // A mask is only usable for the region and box size it was built for.
  function loadMask(region) {
    if (!region || !region.coordinates) return null;
    try {
      const raw = GM_getValue(MASK_STORAGE_PREFIX + regionKey(region), null);
      if (!raw) return null;
      const mask = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!mask || mask.version !== 3 || mask.step !== ROAD_TILE_DEG || !Array.isArray(mask.productive)) return null;
      if (mask.total !== regionTiles(region.coordinates, ROAD_TILE_DEG).length) return null;
      return mask;
    } catch (e) { return null; }
  }

  function saveMask(region, mask) {
    try { GM_setValue(MASK_STORAGE_PREFIX + regionKey(region), JSON.stringify(mask)); }
    catch (e) { console.error("[WME Auto Scan] failed to save optimization", e); }
  }

  function clearMask(region) {
    try { GM_setValue(MASK_STORAGE_PREFIX + regionKey(region), null); } catch (e) {}
  }

  function maskIsStale(mask) {
    return !!(mask && mask.builtAt && Date.now() - Date.parse(mask.builtAt) > MASK_STALE_DAYS * 86400000);
  }

  // The User edits boxes a scan requests: all of them, or just the productive
  // ones once the region is optimized.
  function editTiles(polygon, mask) {
    const tiles = regionTiles(polygon, ROAD_TILE_DEG);
    if (!mask || !mask.complete) return tiles;
    const keep = new Set(mask.productive);
    return tiles.filter((t) => keep.has(t.index));
  }

  async function runOptimize() {
    if (optimizeState.running || scanState.running || scanState.scheduled) return;
    const region = settings.region;
    if (!region || !region.coordinates) { setStatus("Choose a scan area before optimizing."); return; }
    const tiles = regionTiles(region.coordinates, ROAD_TILE_DEG);

    // Resume an unfinished run on this region; anything else starts over.
    let mask = loadMask(region);
    if (!mask || mask.complete) {
      mask = { version: 3, step: ROAD_TILE_DEG, total: tiles.length, productive: [], nextIndex: 0, complete: false, builtAt: null };
    }
    const found = new Set(mask.productive);
    const start = Math.min(mask.nextIndex || 0, tiles.length);
    const todo = tiles.slice(start).map((t, pos) => ({ ...t, pos }));
    const done = new Uint8Array(todo.length);
    let low = 0, sinceSave = 0;
    const persist = () => {
      mask.nextIndex = start + low;
      mask.productive = [...found];
      saveMask(region, mask);
    };

    Object.assign(optimizeState, { running: true, tilesDone: start, tilesTotal: start, resumedAt: start, startTime: Date.now(), productive: found.size });
    const api = createApiClient(() => !optimizeState.running);
    optimizeState.api = api;
    refreshUI();
    try {
      await refreshWmeInfo();
      // Segments only: an area counts when it has any road segment.
      const pass = {
        label: "optimize", tiles: todo,
        fetch: (a, tile) => a.features(tile.box, { roadTypes: ALL_ROAD_TYPES }),
      };
      const recorder = {
        collect(reply, tile) {
          if (((reply.segments && reply.segments.objects) || []).length) found.add(tile.index);
          optimizeState.productive = found.size;
          done[tile.pos] = 1;
          while (low < done.length && done[low]) low++;
          if (++sinceSave >= OPTIMIZE_SAVE_EVERY) { sinceSave = 0; persist(); }
        },
      };
      const finished = await runPass(pass, [recorder], api, optimizeState);
      persist();
      if (finished && low === done.length) {
        mask.complete = true;
        mask.builtAt = new Date().toISOString();
        saveMask(region, mask);
        setStatus(`Optimization complete: ${found.size} of ${tiles.length} User edits areas have roads. User edits scans will skip the other ${tiles.length - found.size}.`);
      } else {
        setStatus(`Optimization paused at ${start + low}/${tiles.length}. You can resume it later.`);
      }
    } catch (e) {
      persist();
      if (!e.stopped) {
        console.error("[WME Auto Scan] optimize failed", e);
        setStatus("Optimization failed: " + e.message + " Progress was saved; you can resume it.");
      } else {
        setStatus(`Optimization paused at ${start + low}/${tiles.length}. You can resume it later.`);
      }
    } finally {
      api.abort();
      optimizeState.api = null;
      optimizeState.running = false;
      refreshUI();
    }
  }

  function stopOptimize() {
    optimizeState.running = false;
    if (optimizeState.api) optimizeState.api.abort();
  }

  function regionKey(region) {
    const s = JSON.stringify((region && region.coordinates) || []);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return "r" + (h >>> 0).toString(36) + "_" + s.length;
  }

  // --- Run-duration timing (one GM key per region) -------------------------
  // Persists how long the last scan of a region took, so we can show
  // "(Last scan …)" and estimate the remaining time of an in-progress run.
  const TIMING_STORAGE_PREFIX = "wme-auto-scan:timing:v1:";
  function loadTiming(region) {
    try {
      const raw = GM_getValue(TIMING_STORAGE_PREFIX + regionKey(region), null);
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) { return null; }
  }
  function saveTiming(region, patch) {
    try {
      const cur = loadTiming(region) || {};
      GM_setValue(TIMING_STORAGE_PREFIX + regionKey(region), JSON.stringify({ ...cur, ...patch }));
    } catch (e) { console.error("[WME Auto Scan] failed to save timing", e); }
  }

  // Format a millisecond duration as a compact "1h02m03s" / "4m03s" / "45s".
  function fmtDuration(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) ms = 0;
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p2 = (n) => String(n).padStart(2, "0");
    if (h > 0) return `${h}h${p2(m)}m${p2(s)}s`;
    if (m > 0) return `${m}m${p2(s)}s`;
    return `${s}s`;
  }

  // Remaining time for the current run: extrapolate from requests done so far,
  // falling back to the previous run's duration before any have finished.
  function estimateRemaining(elapsedMs, done, total) {
    if (done > 0 && total > 0) return Math.max(0, (elapsedMs / done) * total - elapsedMs);
    const t = settings.region ? loadTiming(settings.region) : null;
    if (t && t.lastScanMs > 0) return Math.max(0, t.lastScanMs - elapsedMs);
    return null;
  }

  async function runScan() {
    if (scanState.running) return;
    if (optimizeState.running) { setStatus("Optimization is running; this scan was skipped."); return; }
    if (!settings.region || !settings.region.coordinates) {
      setStatus("Choose a scan area first.");
      return;
    }
    scanState.running = true;
    scanState.polygon = settings.region.coordinates;
    scanState.region = indexPolygon(scanState.polygon);
    scanState.startTime = Date.now();
    scanState.tilesDone = 0;
    scanState.tilesTotal = 0;

    let detectors;
    try { detectors = activeDetectors(); }
    catch (e) {
      scanState.running = false;
      setStatus("Could not start scan: " + e.message);
      return;
    }
    if (!detectors.length) {
      scanState.running = false;
      setStatus("Turn on at least one detector.");
      return;
    }

    const api = createApiClient(() => !scanState.running);
    scanState.api = api;
    try {
      await refreshWmeInfo();
      for (const pass of plannedPasses(detectors.map((d) => d.key))) {
        scanState.passLabel = pass.label;
        const passDetectors = detectors.filter((d) => pass.keys.includes(d.key));
        if (!await runPass(pass, passDetectors, api)) return;
      }
      if (!scanState.running) return;
      scanState.passLabel = "";
      await refreshWmeInfo(); // links are built from the editor's current permalink

      // Finalize: build and send this run's notifications.
      for (const det of detectors) {
        try { await det.finalize(api); } catch (e) {
          if (e.stopped) return;
          console.error("[WME Auto Scan] finalize error", e);
          if (det.key === "edit") setEditStatus("User edits incomplete: " + e.message);
        }
      }

      // Record this run's duration (used for "Last scan …" and remaining-time
      // estimates) only when the whole region was scanned.
      if (settings.region) {
        saveTiming(settings.region, { lastScanMs: Date.now() - scanState.startTime, lastScanAt: Date.now() });
      }
    } catch (e) {
      if (!e.stopped) {
        console.error("[WME Auto Scan] scan failed", e);
        setStatus("Scan failed: " + e.message);
      }
    } finally {
      api.abort();
      scanState.api = null;
      scanState.passLabel = "";
      scanState.running = false;
      refreshUI();
    }
  }

  // Interval scheduling: chain the next run after the current one completes so
  // a slow scan never overlaps the next.
  function startScanning() {
    const problem = startBlockReason();
    if (problem) { setStatus(problem); return; }
    scanState.scheduled = true;
    loopScan();
    refreshUI();
  }

  async function loopScan() {
    if (!scanState.scheduled) return;
    await runScan();
    if (!scanState.scheduled) return;
    const ms = Math.max(1, settings.global.scanIntervalMin) * 60 * 1000;
    scanState.nextScanAt = Date.now() + ms;
    scanState.intervalTimer = setTimeout(loopScan, ms);
    renderStatus(); // the ticker now counts down to nextScanAt
  }

  function stopScanning() {
    scanState.scheduled = false;
    scanState.running = false;
    scanState.nextScanAt = 0;
    clearTimeout(scanState.intervalTimer);
    if (scanState.api) scanState.api.abort();
    setStatus("Stopped.");
    refreshUI();
  }

  function startBlockReason() {
    if (optimizeState.running) return "Wait for optimization to finish (or stop it) before scanning.";
    if (!settings.region || !settings.region.coordinates) return "Choose a scan area first.";
    const enabled = Object.keys(settings.detectors).filter((k) => settings.detectors[k].enabled);
    if (!enabled.length) return "Turn on at least one detector.";
    const configured = enabled.some((k) => channelConfigured(resolveChannels(k)));
    if (!configured) return "Add a Discord webhook or both Pushover keys, either in settings or for a detector.";
    return null;
  }

  // ---------------------------------------------------------------------------
  // Region selection
  // ---------------------------------------------------------------------------
  // Single entry point for setting the scan region: thins the outline so culling
  // stays fast, then stores it. Scan state (baselines, timing, edit
  // checkpoints) is keyed to the simplified coordinates, so a new region simply
  // starts fresh.
  function setRegion(label, coordinates) {
    const before = (coordinates && coordinates[0] && coordinates[0].length) || 0;
    const simplified = simplifyPolygonCoords(coordinates);
    const after = (simplified && simplified[0] && simplified[0].length) || 0;
    settings.region = { label, coordinates: simplified, sourcePoints: before, points: after };
    saveSettings();
    refreshUI();
  }

  // Draw a polygon on the map and stage it as the pending region (applied on Save).
  async function drawRegionDraft() {
    try {
      const poly = await sdk.Map.drawPolygon();
      if (poly && poly.coordinates) {
        regionDraft = { label: "Drawn area", coordinates: poly.coordinates };
        refreshUI();
      }
    } catch (e) {
      setStatus("Drawing cancelled.");
    }
  }

  // Map a managed area's id to its Waze-assigned place name (e.g. "British
  // Columbia"). The named list lives on the user session (id + name, no
  // geometry); the geometry lives on the data-model areas (id + geometry, but
  // only the manager's username). Join them by id to label areas by place.
  async function managedAreaNames() {
    const byId = new Map();
    try {
      const info = await sdk.State.getUserInfo();
      for (const m of (info && info.managedAreas) || []) {
        if (m && m.id != null && m.name) byId.set(String(m.id), m.name);
      }
    } catch (e) {}
    return byId;
  }

  async function managedAreaPresets() {
    const presets = [];
    const names = await managedAreaNames();
    try {
      const areas = await sdk.DataModel.ManagedAreas.getAll();
      areas.forEach((a) => {
        if (a.geometry && a.geometry.coordinates) {
          const name = names.get(String(a.id));
          presets.push({ label: name || a.userName || `Area ${a.id}`, coordinates: a.geometry.coordinates });
        }
      });
    } catch (e) {}
    try {
      const info = await sdk.State.getUserInfo();
      if (info && info.editableAreas) {
        info.editableAreas.forEach((a, i) => {
          if (a.geometry && a.geometry.coordinates) {
            const kind = a.type === "managed" ? "Managed area" : "Recently driven";
            presets.push({ label: `${kind} ${i + 1}`, coordinates: a.geometry.coordinates });
          }
        });
      }
    } catch (e) {}
    return presets;
  }

  // Collect the editor usernames attached to whatever is loaded in the current
  // view — used to auto-fill the whitelist. Most data-model objects carry a
  // resolved createdBy/updatedBy, so we sweep the common ones.
  async function scrapeAreaUsernames() {
    const names = new Set();
    const add = (n) => { if (n) names.add(n); };
    const sweep = async (getter) => {
      try {
        for (const o of (await getter()) || []) {
          const m = o && o.modificationData;
          if (m) { add(m.createdBy); add(m.updatedBy); }
        }
      } catch (e) {}
    };
    await sweep(() => sdk.DataModel.Segments.getAll());
    await sweep(() => sdk.DataModel.Venues.getAll());
    await sweep(() => sdk.DataModel.MapComments.getAll());
    await sweep(() => sdk.DataModel.RoadClosures.getAll());
    try {
      for (const u of (await sdk.DataModel.MapUpdateRequests.getAll()) || []) {
        add(u && u.userName);
        if (u && u.modificationData) { add(u.modificationData.createdBy); add(u.modificationData.updatedBy); }
      }
    } catch (e) {}
    for (const n of seenUsernames) add(n);
    return [...names];
  }

  async function searchNominatim(query) {
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=8&q=" +
      encodeURIComponent(query);
    const res = await gmRequest({
      url,
      headers: { "Accept-Language": "en", "User-Agent": `${SCRIPT_NAME}/${SCRIPT_VERSION}` },
    });
    const data = JSON.parse(res.responseText);
    return data
      .filter((d) => d.geojson && (d.geojson.type === "Polygon" || d.geojson.type === "MultiPolygon"))
      .map((d) => ({
        label: d.display_name,
        coordinates: geojsonToPolygonCoords(d.geojson),
      }));
  }

  // Normalize Polygon / MultiPolygon into a single Polygon coordinate array
  // (largest ring wins for MultiPolygon).
  function geojsonToPolygonCoords(geo) {
    if (geo.type === "Polygon") return geo.coordinates;
    let best = null, bestArea = -1;
    for (const poly of geo.coordinates) {
      const bb = bboxOfRing(poly[0]);
      const area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
      if (area > bestArea) { bestArea = area; best = poly; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  let tabPane = null;

  const STYLE = `
    /* Light theme to sit inside WME's white sidebar. */
    .was-wrap {
      --was-text: #202324; --was-muted: #5c6670; --was-border: #d9dde1;
      --was-input-border: #c2c8ce; --was-surface: #ffffff; --was-subtle: #f5f7f9;
      --was-hover: #eef1f4; --was-accent: #0b7fd4;
      font-size: 12px; line-height: 1.4; padding: 6px 4px 40px; color: var(--was-text);
    }
    .was-wrap h2 { font-size: 15px; margin: 0 0 8px; color: var(--was-text); }

    .was-tabs { display: flex; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid var(--was-border); }
    .was-tab { flex: 1; text-align: center; cursor: pointer; padding: 7px 10px; font-weight: 600;
      color: var(--was-muted); border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; }
    .was-tab:hover { color: var(--was-text); }
    .was-tab.active { color: var(--was-text); background: var(--was-surface);
      border-color: var(--was-border); border-bottom: 1px solid var(--was-surface); margin-bottom: -1px; }

    .was-section { border: 1px solid var(--was-border); border-radius: 6px; padding: 10px; margin-bottom: 10px; background: var(--was-surface); }
    .was-section h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--was-muted); margin: 0 0 8px; }
    .was-row { display: flex; flex-direction: column; margin-bottom: 8px; }
    .was-row label { font-weight: 600; margin-bottom: 3px; color: var(--was-text); }
    .was-wrap input[type=text], .was-wrap input[type=password], .was-wrap input[type=number], .was-wrap select {
      width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 4px;
      border: 1px solid var(--was-input-border); background: var(--was-surface); color: var(--was-text); }
    .was-wrap input:focus, .was-wrap select:focus { outline: none; border-color: var(--was-accent); }
    .was-wrap input::placeholder { color: #9aa4ad; }

    .was-btn { cursor: pointer; border: 1px solid transparent; background: var(--was-accent); color: #fff;
      border-radius: 5px; padding: 6px 12px; font-weight: 600; }
    .was-btn.go { background: #16a34a; border-color: #138a3f; }
    .was-btn.secondary { background: var(--was-hover); border-color: var(--was-input-border); color: var(--was-text); }
    .was-btn.secondary:hover { background: #e3e8ed; }
    .was-btn.danger { background: #d64545; border-color: #bf3a3a; }
    .was-btn:disabled { opacity: .45; cursor: not-allowed; }
    .was-btns { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

    .was-status { padding: 6px 8px; border-radius: 5px; background: var(--was-subtle); border: 1px solid var(--was-border);
      margin-bottom: 10px; min-height: 16px; color: var(--was-text); }
    .was-muted { color: var(--was-muted); font-size: 11px; }
    .was-pill { font-weight: 600; }
    .was-pill.on { color: #15803d; }
    .was-pill.off { color: #b45309; }

    .was-region-current { font-size: 15px; font-weight: 700; color: var(--was-text); margin-bottom: 2px; }

    .was-eye { cursor: pointer; border: 1px solid var(--was-input-border); background: var(--was-surface);
      border-radius: 5px; padding: 2px 8px; font-size: 14px; line-height: 1.2; color: var(--was-text); }
    .was-eye:hover { background: var(--was-hover); }
    .was-eye:disabled { opacity: .45; cursor: not-allowed; }

    .was-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--was-hover);
      border: 1px solid var(--was-border); border-radius: 12px; padding: 2px 8px; margin: 2px; font-size: 11px; color: var(--was-text); }
    .was-chip button { background: none; border: none; color: #c0392b; cursor: pointer; font-weight: 700; padding: 0; }

    .was-check { display: flex; align-items: center; gap: 7px; padding: 5px 4px; cursor: pointer; }
    .was-check.disabled { opacity: .5; cursor: default; }
    .was-check input { width: auto; }

    /* Webhook field that doubles as a disclosure: click the framed margin (or the
       chevron) to expand the per-detector overrides; the inner input stays editable. */
    .was-hook { position: relative; border: 1px solid var(--was-input-border); border-radius: 6px;
      background: var(--was-surface); padding: 6px 26px 6px 7px; cursor: pointer; }
    .was-hook.open { border-color: var(--was-accent); }
    .was-hook > input { border: none !important; background: transparent !important; padding: 2px 0 !important; cursor: text; }
    .was-hook .chev { position: absolute; right: 6px; top: 6px; display: flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 4px; background: var(--was-accent); color: #fff; font-size: 11px; line-height: 1;
      pointer-events: none; transition: transform .15s; }
    .was-hook.open .chev { transform: rotate(180deg); }
    .was-hook-panel { display: none; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--was-border); cursor: default; }
    .was-hook.open .was-hook-panel { display: block; }
    .was-override { border: 1px solid var(--was-border); border-radius: 5px; padding: 8px; margin-bottom: 6px; background: var(--was-subtle); }
    .was-override .name { font-weight: 600; margin-bottom: 6px; color: var(--was-text); }

    .was-search-results { max-height: 140px; overflow: auto; margin-top: 6px; }
    .was-search-results div { padding: 5px 7px; border-radius: 4px; cursor: pointer; }
    .was-search-results div:hover { background: var(--was-hover); }
  `;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  }

  // Pushover's fixed set of built-in notification tones.
  const PUSHOVER_SOUNDS = [
    "pushover", "bike", "bugle", "cashregister", "classical", "cosmic",
    "falling", "gamelan", "incoming", "intermission", "magic", "mechanical",
    "pianobar", "siren", "spacealarm", "tugboat", "alien", "climb",
    "persistent", "echo", "updown", "vibrate", "none",
  ];

  let activeTab = "run"; // which sidebar tab is showing
  let regionMethod = ""; // Choose-New-Region mode: "", "managed", "search", "draw"
  let regionDraft = null; // { label, coordinates } staged region, committed on Save

  // Transient one-off messages (errors, cancellations, completion notices) take
  // over the status bar briefly; otherwise the bar shows the live timer.
  let statusOverride = null;
  let statusOverrideUntil = 0;
  let statusTicker = null;

  function setStatus(msg) {
    statusOverride = msg;
    statusOverrideUntil = Date.now() + 8000;
    renderStatus();
  }

  function renderStatus() {
    const s = tabPane && tabPane.querySelector(".was-status");
    if (!s) return;
    if (statusOverride && Date.now() < statusOverrideUntil) {
      s.textContent = statusOverride;
    } else {
      statusOverride = null;
      s.textContent = statusText();
    }
  }

  // Update the status bar once a second so elapsed / remaining / countdown tick.
  function startStatusTicker() {
    if (statusTicker) return;
    statusTicker = setInterval(renderStatus, 1000);
  }

  function statusText() {
    if (optimizeState.running) {
      const elapsed = Date.now() - (optimizeState.startTime || Date.now());
      const done = optimizeState.tilesDone, total = optimizeState.tilesTotal;
      const fresh = done - (optimizeState.resumedAt || 0);
      const rem = fresh > 0 && total > done ? ` (${fmtDuration((elapsed / fresh) * (total - done))} left)` : "";
      return `Optimizing User edits ${done}/${total}… ${fmtDuration(elapsed)}${rem} · ${optimizeState.productive} with roads`;
    }
    if (scanState.running) {
      const elapsed = Date.now() - (scanState.startTime || Date.now());
      if (!scanState.passLabel) return `Sending notifications… ${fmtDuration(elapsed)}`;
      const remaining = estimateRemaining(elapsed, scanState.tilesDone, scanState.tilesTotal);
      const rem = remaining != null ? ` (${fmtDuration(remaining)} left)` : "";
      return `Scanning ${scanState.passLabel} ${scanState.tilesDone}/${scanState.tilesTotal}… ${fmtDuration(elapsed)}${rem}`;
    }
    if (scanState.scheduled && scanState.nextScanAt) {
      return `Next scan in: ${fmtDuration(scanState.nextScanAt - Date.now())}`;
    }
    return "Ready.";
  }

  function refreshUI() {
    if (!tabPane) return;
    tabPane.innerHTML = "";
    const wrap = el("div", { class: "was-wrap" });

    wrap.appendChild(el("h2", { text: SCRIPT_NAME }));

    // Tab bar.
    const tabs = el("div", { class: "was-tabs" });
    for (const [id, name] of [["run", "Run"], ["settings", "Settings"]]) {
      const t = el("div", { class: "was-tab" + (activeTab === id ? " active" : ""), text: name });
      t.addEventListener("click", () => { activeTab = id; refreshUI(); });
      tabs.appendChild(t);
    }
    wrap.appendChild(tabs);

    const status = el("div", { class: "was-status" });
    wrap.appendChild(status);

    if (activeTab === "run") {
      wrap.appendChild(buildRunControls());
      wrap.appendChild(buildDetectorsSection());
    } else {
      wrap.appendChild(buildRegionSection());
      wrap.appendChild(buildGeneralSection());
      wrap.appendChild(buildWhitelistSection());
    }

    tabPane.appendChild(wrap);
    renderStatus();
  }

  function buildRunControls() {
    const sec = el("div", { class: "was-section" });

    const runBtn = el("button", {
      class: "was-btn go",
      text: scanState.scheduled ? "Running" : "Run",
      onclick: startScanning,
    });
    if (scanState.scheduled || scanState.running || optimizeState.running) runBtn.disabled = true;

    const stopBtn = el("button", { class: "was-btn danger", text: "Stop", onclick: stopScanning });
    if (!scanState.scheduled && !scanState.running) stopBtn.disabled = true;

    sec.appendChild(el("div", { class: "was-btns" }, [runBtn, stopBtn]));
    const block = startBlockReason();
    if (block) sec.appendChild(el("div", { class: "was-muted", text: block, style: "margin-top:8px" }));
    return sec;
  }

  function buildDetectorsSection() {
    const sec = el("div", { class: "was-section" });
    sec.appendChild(el("h3", { text: "Detectors" }));
    for (const key of Object.keys(DETECTOR_META)) {
      const meta = DETECTOR_META[key];
      const d = settings.detectors[key];
      const row = el("label", { class: "was-check" + (meta.phase1 ? "" : " disabled") });
      const cb = el("input", { type: "checkbox" });
      cb.checked = d.enabled;
      if (!meta.phase1) cb.disabled = true;
      cb.addEventListener("change", () => { d.enabled = cb.checked; refreshUI(); saveSettings(); });
      row.appendChild(cb);
      row.appendChild(el("span", { text: meta.name + (meta.phase1 ? "" : " (soon)") }));
      sec.appendChild(row);

      if (key === "edit" && d.enabled) {
        const cooldown = el("input", { type: "number", min: "0", max: "1440", step: "1", value: String(d.cooldownMin) });
        cooldown.addEventListener("change", () => {
          d.cooldownMin = Math.min(1440, Math.max(0, Number(cooldown.value) || 0));
          cooldown.value = String(d.cooldownMin);
          saveSettings();
        });
        sec.appendChild(el("label", { class: "was-row" }, [el("span", { text: "Per-user cooldown (minutes; 0 = every scan)" }), cooldown]));
      }

      // New-road (segment) suggestions can arrive in bulk imports, so they can be
      // left out of Map Suggestions alerts.
      if (key === "suggestion" && d.enabled) {
        const segs = el("input", { type: "checkbox" });
        segs.checked = d.includeSegments !== false;
        segs.addEventListener("change", () => { d.includeSegments = segs.checked; saveSettings(); });
        sec.appendChild(el("label", { class: "was-check", style: "margin-left:24px" }, [segs, el("span", { text: "Include new-road suggestions" })]));
      }
    }
    return sec;
  }

  function buildRegionSection() {
    const sec = el("div", { class: "was-section" });
    sec.appendChild(el("h3", { text: "Region" }));

    // Current region, with an eye button that zooms to it and outlines it.
    const head = el("div", { style: "display:flex; align-items:center; gap:8px; margin-bottom:8px" });
    const label = settings.region ? settings.region.label : "No area selected";
    head.appendChild(el("div", { class: "was-region-current", text: label, style: "flex:1; margin:0" }));
    if (settings.region && settings.region.coordinates) {
      head.appendChild(el("button", { class: "was-eye", title: "Show this region on the map", text: "👁", onclick: toggleRegionPreview }));
    }
    sec.appendChild(head);
    if (settings.region && settings.region.coordinates) sec.appendChild(buildOptimizeRow());

    // --- Choose New Region: one dropdown holding the three pick methods. -----
    const chooser = el("select");
    for (const [value, text] of [["", "Choose New Region"], ["managed", "Managed area"], ["search", "Search for a place"], ["draw", "Draw on map"]]) {
      chooser.appendChild(el("option", { value, text }));
    }
    chooser.value = regionMethod;
    chooser.addEventListener("change", () => { regionMethod = chooser.value; regionDraft = null; refreshUI(); });
    sec.appendChild(el("div", { class: "was-row" }, [chooser]));

    if (regionMethod === "managed") sec.appendChild(buildManagedAreaPicker());
    else if (regionMethod === "search") sec.appendChild(buildPlaceSearch());
    else if (regionMethod === "draw") {
      const drawBtn = el("button", { class: "was-btn secondary", title: "Draw a custom scan area directly on the map", text: regionDraft ? "Redraw area" : "Draw area on map", onclick: drawRegionDraft });
      sec.appendChild(el("div", { class: "was-btns", style: "margin-bottom:6px" }, [drawBtn]));
    }

    // Staged pick + Save (sits right below the pick methods).
    if (regionDraft) {
      sec.appendChild(el("div", { class: "was-muted", text: `Selected: ${regionDraft.label}`, style: "margin:2px 0 6px" }));
    }
    const saveBtn = el("button", {
      class: "was-btn go",
      title: "Save the selected area as your scan region",
      text: "Save",
      onclick: () => {
        if (!regionDraft) return;
        const d = regionDraft;
        regionDraft = null;
        regionMethod = "";
        clearPreview();
        setRegion(d.label, d.coordinates); // calls refreshUI
      },
    });
    if (!regionDraft) saveBtn.disabled = true;
    sec.appendChild(el("div", { class: "was-btns" }, [saveBtn]));

    sec.appendChild(buildScanAreasRow());
    return sec;
  }

  // Presets come from async SDK calls, so the list fills in after render; the
  // last result is kept so the re-render after a pick shows it immediately.
  let managedPresetsCache = null;
  function buildManagedAreaPicker() {
    const row = el("div", { class: "was-row" });
    const select = el("select");
    row.appendChild(select);
    const fill = (presets) => {
      select.innerHTML = "";
      select.appendChild(el("option", { value: "", text: presets.length ? "Choose a managed area…" : "No managed areas found on your account." }));
      presets.forEach((p, i) => select.appendChild(el("option", { value: String(i), text: p.label })));
    };
    select.addEventListener("change", () => {
      if (select.value === "") { regionDraft = null; return; }
      const p = (managedPresetsCache || [])[Number(select.value)];
      if (p) { regionDraft = { label: p.label, coordinates: p.coordinates }; refreshUI(); }
    });
    if (managedPresetsCache) fill(managedPresetsCache);
    else select.appendChild(el("option", { value: "", text: "Loading managed areas…" }));
    managedAreaPresets().then((presets) => { managedPresetsCache = presets; fill(presets); });
    return row;
  }

  function buildPlaceSearch() {
    const wrap = el("div");
    const searchInput = el("input", { type: "text", placeholder: "Search for a place…" });
    const searchBtn = el("button", { class: "was-btn secondary", title: "Search for a place to use as your scan region", text: "Search" });
    const results = el("div", { class: "was-search-results" });
    const doSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) return;
      results.innerHTML = "";
      results.appendChild(el("div", { class: "was-muted", text: "Searching…" }));
      try {
        const found = await searchNominatim(q);
        results.innerHTML = "";
        if (!found.length) { results.appendChild(el("div", { class: "was-muted", text: "No matching areas found." })); return; }
        for (const f of found) {
          results.appendChild(el("div", { text: f.label, onclick: () => { regionDraft = { label: f.label, coordinates: f.coordinates }; refreshUI(); } }));
        }
      } catch (e) {
        results.innerHTML = "";
        results.appendChild(el("div", { class: "was-muted", text: "Search failed: " + e.message }));
      }
    };
    searchBtn.addEventListener("click", doSearch);
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    wrap.appendChild(el("div", { class: "was-row", style: "flex-direction:row; gap:6px" }, [searchInput, searchBtn]));
    wrap.appendChild(results);
    return wrap;
  }

  // Optimization status + control for User edits, shown under the current region.
  function buildOptimizeRow() {
    const wrap = el("div", { style: "margin:-2px 0 10px", title: OPTIMIZE_HELP });
    const mask = loadMask(settings.region);
    const optimized = !!(mask && mask.complete);
    const total = regionTiles(settings.region.coordinates, ROAD_TILE_DEG).length;
    const btns = el("div", { class: "was-btns", style: "align-items:center" });

    if (optimizeState.running) {
      btns.appendChild(el("button", { class: "was-btn danger", text: "Stop", title: "Pause optimization. Progress is saved and can be resumed.", onclick: stopOptimize }));
      btns.appendChild(el("span", { class: "was-muted", text: `Optimizing… ${optimizeState.tilesDone}/${optimizeState.tilesTotal}` }));
    } else {
      const resuming = mask && !mask.complete;
      const label = optimized ? "Re-optimize" : resuming ? "Resume optimizing" : "Optimize";
      const optBtn = el("button", {
        class: "was-btn " + (optimized ? "secondary" : "go"),
        text: label,
        title: OPTIMIZE_HELP,
        onclick: () => {
          if (optimized && !confirm("This region is already optimized for User edits. Optimize it again?")) return;
          runOptimize();
        },
      });
      const busy = scanState.running || scanState.scheduled;
      if (busy) {
        optBtn.disabled = true;
        optBtn.title = "Stop scanning to optimize. " + OPTIMIZE_HELP;
      }
      btns.appendChild(optBtn);

      const pill = optimized
        ? el("span", { class: "was-pill on", text: "Optimized", title: `User edits scans request ${mask.productive.length} of ${total} areas (the rest had no road segments). Built ${new Date(mask.builtAt).toLocaleDateString()}. Only applies to User edits.` })
        : el("span", { class: "was-pill off", text: resuming ? `Paused ${mask.nextIndex}/${total}` : "Not optimized", title: OPTIMIZE_HELP });
      btns.appendChild(pill);

      if (mask) {
        const clearBtn = el("button", { class: "was-btn secondary", text: "Clear", title: "Discard this region's User edits optimization; User edits scans go back to every area.", onclick: () => { clearMask(settings.region); refreshUI(); } });
        if (busy) clearBtn.disabled = true;
        btns.appendChild(clearBtn);
      }
    }
    wrap.appendChild(btns);
    wrap.appendChild(el("div", { class: "was-muted", text: "Applies to User edits only.", style: "margin-top:4px" }));
    if (optimized && maskIsStale(mask)) {
      wrap.appendChild(el("div", { class: "was-muted", text: `Optimized over ${MASK_STALE_DAYS} days ago. Optimize again so new roads are covered.`, style: "margin-top:4px; color:#b45309" }));
    }
    return wrap;
  }

  // How many requests a scan of this region makes, per pass, plus the eye that
  // draws them. Shown inside the region section.
  function buildScanAreasRow() {
    const wrap = el("div", { style: "margin-top:10px; padding-top:8px; border-top:1px solid var(--was-border)" });
    const hasRegion = !!(settings.region && settings.region.coordinates);
    const btns = el("div", { class: "was-btns", style: "align-items:center" });
    const eye = el("button", { class: "was-eye", title: "Show the scan's request boxes on the map", text: "👁", onclick: toggleBoxesPreview });
    if (!hasRegion) eye.disabled = true;
    btns.appendChild(eye);
    let summary = "Choose a region to see its scan size.";
    if (hasRegion) {
      try {
        const passes = plannedPasses();
        summary = passes.length
          ? "Requests per scan: " + passes.map((p) => `${p.tiles.length} ${p.label}${p.optimized ? " (optimized)" : ""}`).join(" · ")
          : "Turn on a detector to see its scan size.";
      } catch (e) { summary = "Couldn't plan the scan: " + e.message; }
    }
    btns.appendChild(el("span", { class: "was-muted", text: summary }));
    wrap.appendChild(btns);
    return wrap;
  }

  function textRow(labelText, value, onInput, type = "text") {
    const row = el("div", { class: "was-row" });
    row.appendChild(el("label", { text: labelText }));
    const input = el("input", { type, value: value == null ? "" : String(value) });
    input.addEventListener("input", () => onInput(input.value));
    row.appendChild(input);
    return row;
  }

  function selectRow(labelText, value, options, onChange) {
    const row = el("div", { class: "was-row" });
    row.appendChild(el("label", { text: labelText }));
    const select = el("select");
    for (const opt of options) {
      const o = el("option", { value: opt, text: opt });
      if (opt === value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => onChange(select.value));
    row.appendChild(select);
    return row;
  }

  function buildGeneralSection() {
    const sec = el("div", { class: "was-section" });
    sec.appendChild(el("h3", { text: "General settings" }));
    const g = settings.global;

    const timing = settings.region ? loadTiming(settings.region) : null;
    const intervalLabel = timing && timing.lastScanMs != null
      ? `Scan interval (minutes) (Last scan ${fmtDuration(timing.lastScanMs)})`
      : "Scan interval (minutes)";
    sec.appendChild(textRow(intervalLabel, g.scanIntervalMin, (v) => { g.scanIntervalMin = Math.max(1, Number(v) || 1); saveSettings(); }, "number"));

    // Loading places can multiply scan time; only User edits reads them.
    const skipPlaces = el("input", { type: "checkbox" });
    skipPlaces.checked = !!g.skipPlaces;
    skipPlaces.addEventListener("change", () => { g.skipPlaces = skipPlaces.checked; saveSettings(); });
    sec.appendChild(el("label", { class: "was-check" }, [skipPlaces, el("span", { text: "Don't scan places" })]));
    sec.appendChild(el("div", { class: "was-muted", text: "Faster scans. Edits to places won't be reported.", style: "margin:2px 0 8px 24px" }));

    // Notifications: the Discord webhook shows by default; the framed box also
    // acts as a disclosure — clicking its margin (or the chevron) opens the
    // per-detector overrides for hooks, Pushover keys and sounds.
    sec.appendChild(el("label", { text: "Notifications" }));
    sec.appendChild(buildWebhookDisclosure());

    sec.appendChild(textRow("Pushover app token", g.pushoverToken, (v) => { g.pushoverToken = v.trim(); saveSettings(); }));
    sec.appendChild(textRow("Pushover user / group key", g.pushoverUser, (v) => { g.pushoverUser = v.trim(); saveSettings(); }));
    sec.appendChild(selectRow("Pushover sound", g.pushoverSound || "pushover", PUSHOVER_SOUNDS, (v) => { g.pushoverSound = v; saveSettings(); }));
    return sec;
  }

  // The Discord webhook field that doubles as a dropdown for per-detector
  // overrides. Clicking the framed margin toggles the override panel; typing in
  // the inner input edits the shared webhook and never toggles the panel.
  function buildWebhookDisclosure() {
    const g = settings.global;
    const box = el("div", { class: "was-hook" });

    const input = el("input", { type: "text", value: g.discordWebhook || "", placeholder: "Discord webhook URL" });
    input.addEventListener("input", () => { g.discordWebhook = input.value.trim(); saveSettings(); });
    input.addEventListener("click", (e) => e.stopPropagation()); // keep typing from toggling
    box.appendChild(input);
    box.appendChild(el("span", { class: "chev", text: "▾" }));

    const panel = el("div", { class: "was-hook-panel" });
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.appendChild(el("div", { class: "was-muted", text: "Leave a field blank to use the main setting.", style: "margin-bottom:6px" }));
    for (const key of Object.keys(DETECTOR_META)) {
      const d = settings.detectors[key];
      const block = el("div", { class: "was-override" });
      block.appendChild(el("div", { class: "name", text: DETECTOR_META[key].name }));
      block.appendChild(textRow("Discord webhook", d.discordWebhook, (v) => { d.discordWebhook = v.trim(); saveSettings(); }));
      block.appendChild(textRow("Pushover app token", d.pushoverToken, (v) => { d.pushoverToken = v.trim(); saveSettings(); }));
      block.appendChild(textRow("Pushover user / group key", d.pushoverUser, (v) => { d.pushoverUser = v.trim(); saveSettings(); }));
      block.appendChild(selectRow("Pushover sound", d.pushoverSound || "", ["", ...PUSHOVER_SOUNDS], (v) => { d.pushoverSound = v; saveSettings(); }));
      panel.appendChild(block);
    }
    box.appendChild(panel);

    box.addEventListener("click", () => box.classList.toggle("open"));
    return box;
  }

  function buildWhitelistSection() {
    const sec = el("div", { class: "was-section" });
    sec.appendChild(el("h3", { text: "Whitelist" }));

    const chips = el("div");
    const renderChips = () => {
      chips.innerHTML = "";
      for (const name of settings.whitelist) {
        const chip = el("span", { class: "was-chip", text: name });
        chip.appendChild(el("button", { title: "Remove from whitelist", text: "×", onclick: () => { settings.whitelist = settings.whitelist.filter((n) => n !== name); saveSettings(); renderChips(); } }));
        chips.appendChild(chip);
      }
    };

    const listId = "was-user-datalist";
    const datalist = el("datalist", { id: listId });
    const fillDatalist = (names) => {
      datalist.innerHTML = "";
      for (const u of names) datalist.appendChild(el("option", { value: u }));
    };
    fillDatalist(seenUsernames);

    const input = el("input", { type: "text", placeholder: "Add a username…", list: listId });
    const addBtn = el("button", { class: "was-btn secondary", text: "Add" });
    const add = (name) => {
      const v = (name != null ? name : input.value).trim();
      if (v && !settings.whitelist.some((n) => n.toLowerCase() === v.toLowerCase())) {
        settings.whitelist.push(v);
        saveSettings();
        renderChips();
      }
      if (name == null) input.value = "";
    };
    addBtn.addEventListener("click", () => add());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });

    // Auto-fill: pull the editors visible in the current map view.
    const found = el("div", { class: "was-search-results" });
    const scanBtn = el("button", { class: "was-btn secondary", title: "List editors currently visible in the map view to whitelist", text: "Find editors in view" });
    scanBtn.addEventListener("click", async () => {
      const names = (await scrapeAreaUsernames()).sort((a, b) => a.localeCompare(b));
      fillDatalist(names);
      found.innerHTML = "";
      const fresh = names.filter((n) => !settings.whitelist.some((w) => w.toLowerCase() === n.toLowerCase()));
      if (!fresh.length) { found.appendChild(el("div", { class: "was-muted", text: "No new editors in the current view." })); return; }
      found.appendChild(el("div", { class: "was-muted", text: `${fresh.length} found — click to whitelist.` }));
      for (const n of fresh) {
        found.appendChild(el("div", { text: n, onclick: () => { add(n); found.innerHTML = ""; } }));
      }
    });

    sec.appendChild(el("div", { class: "was-row", style: "flex-direction:row; gap:6px" }, [input, addBtn]));
    sec.appendChild(datalist);
    renderChips();
    sec.appendChild(chips);
    sec.appendChild(el("div", { class: "was-btns", style: "margin-top:8px" }, [scanBtn]));
    sec.appendChild(found);
    return sec;
  }

  const DETECTOR_META = {
    closure: { name: "Road closures", phase1: true },
    edit: { name: "User edits", phase1: true },
    report: { name: "Update Requests", phase1: true },
    suggestion: { name: "Map Suggestions", phase1: true },
  };

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  let settings = defaultSettings();

  async function bootstrap() {
    sdk = PAGE.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: "async" });
    settings = loadSettings();
    await refreshWmeInfo();

    // A tab closed mid-scan by an older version left the scan's layer choices
    // behind; put the editor's own layers back.
    await restoreLegacyLayers();

    // Migrate a region stored by an earlier version (raw, un-thinned OSM outline)
    // so its coastline no longer freezes tile culling. Re-simplify in place.
    if (settings.region && settings.region.coordinates) {
      const outer = settings.region.coordinates[0] || [];
      if (!settings.region.points || outer.length > 800) {
        const simplified = simplifyPolygonCoords(settings.region.coordinates);
        settings.region.sourcePoints = settings.region.sourcePoints || outer.length;
        settings.region.coordinates = simplified;
        settings.region.points = (simplified[0] || []).length;
        saveSettings();
      }
    }

    // Cache localized road-type names.
    try {
      for (const rt of await sdk.DataModel.Segments.getRoadTypes()) roadTypeNames[rt.id] = rt.localizedName || rt.name;
    } catch (e) {}

    // Identify the current user and, on first load, whitelist them by default
    // (removable — we only seed once, tracked by whitelistSeeded).
    let selfUserName = null;
    try {
      const info = await sdk.State.getUserInfo();
      if (info && info.userName) {
        selfUserName = info.userName;
        noteUsername(info.userName);
      }
    } catch (e) {}
    if (!settings.whitelistSeeded) {
      if (selfUserName && !settings.whitelist.some((w) => w.toLowerCase() === selfUserName.toLowerCase())) {
        settings.whitelist.push(selfUserName);
      }
      settings.whitelistSeeded = true;
      saveSettings();
    }

    // Inject styles + sidebar tab.
    document.head.appendChild(el("style", { text: STYLE }));
    sdk.Sidebar.registerScriptTab().then(({ tabLabel, tabPane: pane }) => {
      tabLabel.textContent = "Auto Scan";
      tabLabel.title = SCRIPT_NAME;
      tabPane = pane;
      refreshUI();
      startStatusTicker();
    });
  }

  // `SDK_INITIALIZED` is a Promise the WME SDK sets on the page window. It may
  // not exist yet when our userscript runs, so poll until it appears.
  function whenSdkReady(cb) {
    const ready = () => PAGE.SDK_INITIALIZED && typeof PAGE.SDK_INITIALIZED.then === "function";
    if (ready()) {
      PAGE.SDK_INITIALIZED.then(cb);
      return;
    }
    const iv = setInterval(() => {
      if (ready()) {
        clearInterval(iv);
        PAGE.SDK_INITIALIZED.then(cb);
      }
    }, 150);
  }

  whenSdkReady(bootstrap);
})();
