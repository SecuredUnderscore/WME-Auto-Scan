// ==UserScript==
// @name         WME Auto Scan
// @namespace    https://github.com/SecuredUnderscore/WME-Auto-Scan
// @version      0.3.0
// @description  Scans a selected area in Waze Map Editor for road closures and sends notifications to Discord or Pushover. Optional optimization skips areas without roads.
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
  const STORAGE_KEY = "wme-auto-scan:settings:v1";
  const SCAN_ZOOM = 15; // zoom that loads all data onto the map
  const TILE_OVERLAP = 0.85; // fraction of viewport advanced per tile step
  const MAP_DATA_TIMEOUT_MS = 9000; // max wait for a tile's data to load
  const MAP_SETTLE_MS = 650; // extra settle time so canvases finish drawing
  // Scan-loop pacing: rather than always waiting the full settle, the scan moves
  // on as soon as the tile signals loaded (plus a short base dwell). This saves
  // ~200-500 ms/tile, especially on optimized runs where tiles load fast.
  const SCAN_SETTLE_MS = 150; // base dwell after a tile's data loads before collecting
  const SCAN_NO_LOAD_GRACE = 500; // if no load event fires, assume the tile was already loaded
  const SCAN_POLL_MS = 50; // how often the scan loop polls for the load signal
  const ENABLE_SCREENSHOTS = false; // temporarily disabled (black-capture WIP)

  // --- Optimization "tile mask" -------------------------------------------
  // A one-time pass records which grid cells contain a real (non-offroad) road
  // network; recurring scans then visit only those cells, skipping ocean and
  // roadless wilderness. Note: at SCAN_ZOOM the WME data layer may not load
  // Street (1) / Walking-trail (5) segments, so the mask reflects whatever the
  // scan zoom itself loads — it never hides a closure a full scan would find.
  const OFFROAD_ROAD_TYPES = new Set([8]); // roadType ids that don't count as "has roads"
  const MASK_STORAGE_PREFIX = "wme-auto-scan:mask:v1:";
  const MASK_STALE_DAYS = 30; // suggest re-optimizing once a mask is older than this
  // The optimize pass keeps ONE persistent listener for segments entering the
  // data model and credits each road to the grid cell(s) its geometry covers.
  // Because that listener stays active for the whole pass, a tile's roads count
  // whenever they load — even after we've panned past it — which is what lets
  // dense urban tiles (slower to load) still register. Per-tile dwell just paces
  // the movement and adapts to the observed load time; moving on early is safe.
  const OPT_BASE_MS = 350; // base per-tile dwell before any load time is learned
  const OPT_POLL_MS = 60; // how often to re-check the model while dwelling
  const OPT_MIN_DEADLINE_MS = OPT_BASE_MS; // shortest dwell before moving on
  const OPT_WARMUP_DEADLINE_MS = OPT_BASE_MS; // dwell before enough is learned
  const OPT_MAX_DEADLINE_MS = OPT_BASE_MS * 7; // cap on the learned dwell (~2450ms)
  const OPT_SAFETY = 3; // learned-time multiplier (headroom for slow tiles)
  const OPT_SAMPLE_WINDOW = 40; // load-time samples to keep for the learner
  const OPT_DRAIN_QUIET_MS = 2500; // end-of-pass: stop once the map is this quiet
  const OPT_DRAIN_MAX_MS = 15000; // …but never drain longer than this
  const OPTIMIZE_SAVE_EVERY = 25; // persist optimize progress every N cells (resumable)
  const PROFILE_URL = (u) => `https://www.waze.com/user/editor/${encodeURIComponent(u)}`;

  // Map overlay layers used by the "eye" preview buttons (region outline / the
  // per-tile scan boxes). Drawn on demand and cleared as soon as the zoom
  // changes or the user toggles a preview off.
  const REGION_PREVIEW_LAYER = "wme-auto-scan-region-preview";
  const BBOX_PREVIEW_LAYER = "wme-auto-scan-bbox-preview";
  const MAX_PREVIEW_BOXES = 5000; // cap so a huge unoptimized region can't stall the map

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
      },
      whitelist: [], // usernames whose events are suppressed
      region: null, // GeoJSON Polygon coordinates (rings of [lon,lat]) + label
      detectors: {
        closure: { ...detector(), enabled: true },
        edit: detector(),
        report: detector(),
        suggestion: detector(),
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

  function bboxOfCoords(coords) {
    return bboxOfRing(coords);
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

  function centroidOfBbox(bbox) {
    return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
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
  function gmRequest({ url, method = "GET", headers = {}, data = null, binary = false, responseType }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url,
        method,
        headers,
        data,
        binary,
        responseType,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res);
          else reject(new Error(`HTTP ${res.status}: ${res.responseText || res.statusText}`));
        },
        onerror: (res) => reject(new Error(`Network error (status ${res && res.status}): ${(res && res.responseText) || (res && res.statusText) || "blocked or no response"}`)),
        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  // Extract the raw byte string (latin1, one char per byte) from a data URL.
  function dataUrlToBinaryString(dataUrl) {
    const b64 = dataUrl.split(",")[1] || "";
    return atob(b64); // each char code is one byte
  }

  // Convert a JS string to a UTF-8 byte string (one char per byte) so it can be
  // concatenated with raw binary and sent via GM_xmlhttpRequest `binary: true`.
  function utf8Bytes(s) {
    return unescape(encodeURIComponent(String(s)));
  }

  // Build a multipart/form-data body as a raw byte string. Used with
  // GM_xmlhttpRequest `binary: true`, which is the reliable cross-manager path
  // for file uploads (FormData support in GM is inconsistent). Text parts are
  // UTF-8 encoded; file `binary` parts are already byte strings and left as-is.
  // fields: { name: stringValue }. files: [{ field, filename, type, binary }].
  function buildMultipart(fields, files = []) {
    const boundary = "----WMEAutoScan" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    for (const f of files) {
      parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type || "application/octet-stream"}\r\n\r\n`));
      parts.push(f.binary); // raw byte string, already correct
      parts.push("\r\n");
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

  // A notification is { title, color, discordDescription, plainText, screenshots:[dataUrl] }
  async function sendNotification(detectorKey, note) {
    const ch = resolveChannels(detectorKey);
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
    const shots = note.screenshots || [];
    const files = [];
    if (shots.length) {
      // Reference the first image inline; attach the rest as extra files.
      embed.image = { url: "attachment://shot0.png" };
      shots.forEach((dataUrl, i) => {
        files.push({ field: `files[${i}]`, filename: `shot${i}.png`, type: "image/png", binary: dataUrlToBinaryString(dataUrl) });
      });
    }
    const { body, contentType } = buildMultipart(
      { payload_json: JSON.stringify({ embeds: [embed] }) },
      files
    );
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
    const shots = note.screenshots || [];
    const files = shots.length
      ? [{ field: "attachment", filename: "shot.png", type: "image/png", binary: dataUrlToBinaryString(shots[0]) }]
      : [];
    const { body, contentType } = buildMultipart(fields, files);
    await gmRequest({
      url: "https://api.pushover.net/1/messages.json",
      method: "POST",
      headers: { "Content-Type": contentType },
      data: body,
      binary: true,
    });
  }

  // ---------------------------------------------------------------------------
  // SDK-backed map utilities
  // ---------------------------------------------------------------------------
  let sdk = null;
  let roadTypeNames = {}; // id -> localized name

  // Resolve `true` when the map signals data loaded, `false` on timeout. The
  // caller must distinguish the two: a timeout may be a genuinely empty tile OR
  // a network failure, so callers that record results (the optimize pass) retry
  // before trusting an "empty" reading.
  function waitForMapData(settleMs = MAP_SETTLE_MS, timeoutMs = MAP_DATA_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (loaded) => {
        if (done) return;
        done = true;
        resolve(loaded);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      sdk.Events.once({ eventName: "wme-map-data-loaded" }).then(() => {
        clearTimeout(timer);
        if (settleMs > 0) setTimeout(() => finish(true), settleMs);
        else finish(true);
      });
    });
  }

  async function moveTo(lonLat, zoom, settleMs = MAP_SETTLE_MS, timeoutMs = MAP_DATA_TIMEOUT_MS) {
    // Register the data-loaded listener *before* moving so a fast load can't
    // fire before we're listening (which would cost us the full timeout).
    const wait = waitForMapData(settleMs, timeoutMs);
    sdk.Map.setMapCenter({ lonLat, zoomLevel: zoom });
    return wait;
  }

  // Scan-loop move: proactively poll for the load signal and proceed the moment
  // a tile is ready instead of blocking on a fixed settle. Proceeds when either
  // (a) a data-loaded event fires and a short base dwell has elapsed, or (b) no
  // load event arrives within the grace window (the tile was already loaded).
  async function moveForScan(center) {
    let loadedAt = 0;
    const onLoad = () => { if (!loadedAt) loadedAt = performance.now(); };
    try { sdk.Events.on({ eventName: "wme-map-data-loaded", eventHandler: onLoad }); } catch (e) {}
    const t0 = performance.now();
    sdk.Map.setMapCenter({ lonLat: center, zoomLevel: SCAN_ZOOM });
    try {
      for (;;) {
        const now = performance.now();
        if (loadedAt) {
          if (now - loadedAt >= SCAN_SETTLE_MS) break; // loaded, brief settle done
        } else if (now - t0 >= SCAN_NO_LOAD_GRACE) {
          break; // nothing loaded — tile was already present, don't wait longer
        }
        if (now - t0 >= MAP_DATA_TIMEOUT_MS) break; // hard cap
        await sleep(SCAN_POLL_MS);
      }
    } finally {
      try { sdk.Events.off({ eventName: "wme-map-data-loaded", eventHandler: onLoad }); } catch (e) {}
    }
  }

  function currentViewSize() {
    // Viewport extent in degrees at the current zoom.
    const ext = sdk.Map.getMapExtent(); // [left, bottom, right, top]
    return { w: ext[2] - ext[0], h: ext[3] - ext[1] };
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  // Composite WME's map layers into a single cropped PNG data URL. WME draws
  // vector layers (roads/closures) on <canvas> and base imagery as <img> tiles,
  // so we composite both in DOM order. Returns null if the canvas is tainted
  // (cross-origin imagery) so the caller can retry without imagery.
  // includeImages=false yields the clean minimal render (vectors on neutral bg).
  function captureCrop(bbox, includeImages) {
    const vp = sdk.Map.getMapViewportElement();
    if (!vp) return null;
    const vpRect = vp.getBoundingClientRect();
    const full = document.createElement("canvas");
    full.width = Math.max(1, Math.round(vpRect.width));
    full.height = Math.max(1, Math.round(vpRect.height));
    const ctx = full.getContext("2d");
    ctx.fillStyle = "#0b0f14"; // neutral background for the minimal render
    ctx.fillRect(0, 0, full.width, full.height);
    const selector = includeImages ? "canvas, img" : "canvas";
    let drawn = 0;
    for (const node of vp.querySelectorAll(selector)) {
      try {
        if (node.tagName === "IMG" && (!node.complete || !node.naturalWidth)) continue;
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right < vpRect.left || r.left > vpRect.right || r.bottom < vpRect.top || r.top > vpRect.bottom) continue;
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
        ctx.drawImage(node, r.left - vpRect.left, r.top - vpRect.top, r.width, r.height);
        drawn++;
      } catch (e) {
        /* skip a layer we can't draw */
      }
    }
    console.debug(`[WME Auto Scan] screenshot composited ${drawn} layer(s), images=${!!includeImages}`);
    // Compute the pixel crop rectangle from the geographic bbox.
    const p1 = sdk.Map.getMapPixelFromLonLat({ lonLat: { lon: bbox[0], lat: bbox[3] } }); // top-left
    const p2 = sdk.Map.getMapPixelFromLonLat({ lonLat: { lon: bbox[2], lat: bbox[1] } }); // bottom-right
    const pad = 40;
    let x = Math.min(p1.x, p2.x) - pad;
    let y = Math.min(p1.y, p2.y) - pad;
    let w = Math.abs(p2.x - p1.x) + pad * 2;
    let h = Math.abs(p2.y - p1.y) + pad * 2;
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(full.width - x, w); h = Math.min(full.height - y, h);
    if (w < 4 || h < 4) return null;
    const out = document.createElement("canvas");
    out.width = Math.round(w); out.height = Math.round(h);
    out.getContext("2d").drawImage(full, x, y, w, h, 0, 0, out.width, out.height);
    try {
      return out.toDataURL("image/png");
    } catch (e) {
      return null; // tainted canvas -> minimal-render fallback
    }
  }

  // Isolate the closure/road layers, capture, then restore prior visibility.
  async function screenshotFeature(bbox) {
    const layers = [
      "cities", "places", "paths", "junctionBoxes", "permanentHazards",
      "gpsPoints", "houseNumbers", "mapComments", "mapProblems",
      "updateRequests", "editSuggestions",
    ];
    const prior = {};
    for (const name of layers) {
      try {
        prior[name] = sdk.LayerSwitcher.getWMELayerVisibility({ layerName: name });
        sdk.LayerSwitcher.setWMELayerVisibility({ layerName: name, isVisible: false });
      } catch (e) { /* layer may not exist in this build */ }
    }
    try { sdk.LayerSwitcher.setWMELayerVisibility({ layerName: "roads", isVisible: true }); } catch (e) {}
    try { sdk.LayerSwitcher.setWMELayerVisibility({ layerName: "closures", isVisible: true }); } catch (e) {}

    // Frame the feature and let it render (listen before moving; see moveTo).
    const wait = waitForMapData();
    sdk.Map.zoomToExtent({ bbox });
    await wait;
    // zoomToExtent animates and vectors paint after the data-load event, so let
    // the map fully settle before reading pixels (otherwise we grab a blank frame).
    await sleep(1000);
    await nextFrame();

    // Pass 1: try to include base imagery.
    let shot = captureCrop(bbox, true);
    if (!shot) {
      // CORS taint from imagery -> hide it and capture the clean minimal render.
      let priorSat = true;
      try {
        priorSat = sdk.LayerSwitcher.getWMELayerVisibility({ layerName: "satelliteImagery" });
        sdk.LayerSwitcher.setWMELayerVisibility({ layerName: "satelliteImagery", isVisible: false });
      } catch (e) {}
      await sleep(500);
      await nextFrame();
      shot = captureCrop(bbox, false);
      try { sdk.LayerSwitcher.setWMELayerVisibility({ layerName: "satelliteImagery", isVisible: priorSat }); } catch (e) {}
    }

    // Restore layer visibility.
    for (const name of layers) {
      if (name in prior) {
        try { sdk.LayerSwitcher.setWMELayerVisibility({ layerName: name, isVisible: prior[name] }); } catch (e) {}
      }
    }
    return shot;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // Map preview overlays (the "eye" buttons)
  // ---------------------------------------------------------------------------
  // activePreview is "region", "boxes", or null. Previews are transient: any
  // zoom change (or toggling another preview) clears them.
  let previewLayersReady = false;
  let activePreview = null;
  let previewZoomHandler = null;

  function ensurePreviewLayers() {
    if (previewLayersReady) return;
    try {
      sdk.Map.addLayer({
        layerName: REGION_PREVIEW_LAYER,
        styleRules: [{ style: { strokeColor: "#0b7fd4", strokeWidth: 3, strokeOpacity: 0.95, fillColor: "#0b7fd4", fillOpacity: 0.08 } }],
      });
      sdk.Map.addLayer({
        layerName: BBOX_PREVIEW_LAYER,
        styleRules: [{ style: { strokeColor: "#16a34a", strokeWidth: 1.5, strokeOpacity: 0.9, fillColor: "#16a34a", fillOpacity: 0.06 } }],
      });
      previewLayersReady = true;
    } catch (e) {
      console.error("[WME Auto Scan] failed to add preview layers", e);
    }
  }

  function clearPreview() {
    if (previewLayersReady) {
      try { sdk.Map.removeAllFeaturesFromLayer({ layerName: REGION_PREVIEW_LAYER }); } catch (e) {}
      try { sdk.Map.removeAllFeaturesFromLayer({ layerName: BBOX_PREVIEW_LAYER }); } catch (e) {}
    }
    activePreview = null;
    disarmPreviewAutoClear();
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
  function previewRegion() {
    const region = settings.region;
    if (!region || !region.coordinates) return;
    ensurePreviewLayers();
    clearPreview();
    try {
      sdk.Map.addFeaturesToLayer({ features: [polygonRingFeature("region", region.coordinates)], layerName: REGION_PREVIEW_LAYER });
      sdk.Map.zoomToExtent({ bbox: bboxOfCoords(region.coordinates[0]) });
      activePreview = "region";
      armPreviewAutoClear();
    } catch (e) {
      console.error("[WME Auto Scan] region preview failed", e);
    }
  }

  // Zoom out and draw every tile box the scanner will actually visit: the
  // optimized productive cells if a complete mask exists, else the full
  // polygon-culled grid (which needs the viewport size at scan zoom, so we
  // briefly move there to measure it).
  async function previewScanBoxes() {
    const region = settings.region;
    if (!region || !region.coordinates) return;
    ensurePreviewLayers();
    clearPreview();
    const polygon = region.coordinates;
    try {
      let grid, cells;
      const mask = loadMask(region);
      if (mask && mask.complete && mask.grid && Array.isArray(mask.productive) && mask.productive.length) {
        grid = mask.grid;
        cells = mask.productive;
      } else {
        setStatus("Measuring scan grid…");
        await moveTo(centroidOfBbox(bboxOfCoords(polygon[0])), SCAN_ZOOM);
        grid = computeGrid(polygon, currentViewSize());
        cells = relevantCells(grid, polygon);
      }
      let capped = false;
      if (cells.length > MAX_PREVIEW_BOXES) { cells = cells.slice(0, MAX_PREVIEW_BOXES); capped = true; }
      const features = cells.map((idx) => boxFeature("box" + idx, gridCellBox(grid, idx)));
      sdk.Map.addFeaturesToLayer({ features, layerName: BBOX_PREVIEW_LAYER });
      sdk.Map.zoomToExtent({ bbox: bboxOfCoords(polygon[0]) });
      activePreview = "boxes";
      armPreviewAutoClear();
      setStatus(capped
        ? `Showing first ${MAX_PREVIEW_BOXES} of ${features.length}+ scan areas. Zoom to clear.`
        : `Showing ${features.length} scan areas. Zoom to clear.`);
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
  function buildLinks(centroid, segmentIds) {
    const links = {};
    // WME permalink: select the segments, then read the permalink so WME
    // encodes the selection for us; fall back to manual &segments=.
    try {
      if (segmentIds && segmentIds.length) {
        sdk.Editing.setSelection({ selection: { objectType: "segment", ids: segmentIds } });
      }
    } catch (e) { /* selection may fail if not loaded */ }
    let wme = "";
    try {
      wme = sdk.Map.getPermalink();
    } catch (e) { wme = `https://www.waze.com/editor`; }
    if (segmentIds && segmentIds.length && !/[?&]segments=/.test(wme)) {
      wme += (wme.includes("?") ? "&" : "?") + "segments=" + segmentIds.join(",");
    }
    links.wme = wme;
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
  let selfUserName = null;

  function noteUsername(name) {
    if (name) seenUsernames.add(name);
  }

  function isWhitelisted(name) {
    if (!name) return false;
    if (selfUserName && name.toLowerCase() === selfUserName.toLowerCase()) return true;
    return settings.whitelist.some((w) => w.toLowerCase() === name.toLowerCase());
  }

  // ---------------------------------------------------------------------------
  // Closure detector
  // ---------------------------------------------------------------------------
  function roadTypeName(id) {
    return roadTypeNames[id] || ROAD_TYPE_FALLBACK[id] || `road type ${id}`;
  }

  function streetName(streetId) {
    if (!streetId) return null;
    try {
      const s = sdk.DataModel.Streets.getById({ streetId });
      return s && s.name ? s.name : null;
    } catch (e) { return null; }
  }

  function toUnixSeconds(dateStr) {
    if (!dateStr) return null;
    const t = Date.parse(dateStr);
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

  // Build a per-scan closure detector state.
  function makeClosureDetector() {
    const closuresById = new Map(); // dedupe across tiles

    return {
      key: "closure",
      collect() {
        let list = [];
        try {
          list = sdk.DataModel.RoadClosures.getAll();
        } catch (e) { return; }
        for (const c of list) {
          if (closuresById.has(c.id)) continue;
          if (isEndedClosure(c)) continue; // skip closures that have already ended
          const seg = safeSegment(c.segmentId);
          if (!seg || !seg.geometry) continue;
          const coords = seg.geometry.coordinates || [];
          if (!lineInPolygon(coords, scanState.polygon)) continue;
          noteUsername(c.modificationData && c.modificationData.createdBy);
          closuresById.set(c.id, { closure: c, seg });
        }
      },
      async finalize() {
        const items = [...closuresById.values()];
        const store = seenFor(settings.region, "closure");

        // Which closures are newly seen this scan? Then mark everything seen.
        const fresh = items.filter(({ closure }) => !store.ids.has(String(closure.id)));
        for (const { closure } of items) store.ids.add(String(closure.id));

        if (!store.baseline) {
          // First scan of this region: record a silent baseline, no alerts.
          store.baseline = true;
          return 0;
        }
        if (!fresh.length) return 0;

        // Group only the newly-appeared closures whose segments are connected.
        const groups = groupByConnectivity(fresh);
        let sent = 0;
        for (const group of groups) {
          const note = await buildClosureNotification(group);
          if (!note) continue; // fully whitelisted
          const results = await sendNotification("closure", note);
          if (results.some((r) => r.endsWith(":ok"))) sent++;
        }
        return sent;
      },
    };
  }

  function safeSegment(segmentId) {
    try {
      return sdk.DataModel.Segments.getById({ segmentId });
    } catch (e) { return null; }
  }

  // Union-find over segments by shared node ids.
  function groupByConnectivity(items) {
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const union = (a, b) => { parent.set(find(a), find(b)); };

    for (const { seg } of items) {
      const key = "s" + seg.id;
      if (!parent.has(key)) parent.set(key, key);
      for (const node of [seg.fromNodeId, seg.toNodeId]) {
        if (node == null) continue;
        const nk = "n" + node;
        if (!parent.has(nk)) parent.set(nk, nk);
        union(key, nk);
      }
    }
    const buckets = new Map();
    for (const item of items) {
      const root = find("s" + item.seg.id);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(item);
    }
    return [...buckets.values()];
  }

  async function buildClosureNotification(group) {
    // Suppress whole group only if every closure's reporter is whitelisted.
    const visible = group.filter(
      ({ closure }) => !isWhitelisted(closure.modificationData && closure.modificationData.createdBy)
    );
    if (!visible.length) return null;

    // Collapse closures onto their segment: a two-way closure produces one
    // record per direction on the same segment, so we group by segment id and
    // present a single line per segment (direction merged).
    const bySeg = new Map(); // segId -> { seg, closures: [] }
    for (const { seg, closure } of visible) {
      if (!bySeg.has(seg.id)) bySeg.set(seg.id, { seg, closures: [] });
      bySeg.get(seg.id).closures.push(closure);
    }

    const lines = [];
    const plainLines = [];
    let allCoords = [];
    const segIds = [];

    for (const { seg, closures } of bySeg.values()) {
      segIds.push(seg.id);
      allCoords = allCoords.concat(seg.geometry.coordinates || []);
      const rt = roadTypeName(seg.roadType);
      const name = streetName(seg.primaryStreetId) || "Unnamed road";
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

    const bbox = padBbox(bboxOfCoords(allCoords), 0.15);
    const centroid = centroidOfBbox(bbox);
    const links = buildLinks(centroid, segIds);

    // Screenshot the whole group's extent (temporarily disabled).
    let shot = null;
    if (ENABLE_SCREENSHOTS) {
      try {
        shot = await screenshotFeature(bbox);
      } catch (e) {
        console.error("[WME Auto Scan] screenshot failed", e);
      }
    }

    const title = bySeg.size === 1
      ? "Road closure"
      : `Road closures (${bySeg.size} connected segments)`;

    return {
      title,
      color: COLORS.closure,
      discordDescription: `${lines.join("\n")}\n\n${linksMarkdown(links)}`,
      plainText: `${plainLines.join("\n")}\n\n${linksPlain(links)}`,
      screenshots: shot ? [shot] : [],
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
  // Scan engine
  // ---------------------------------------------------------------------------
  const scanState = {
    running: false,
    scheduled: false, // interval loop active
    polygon: null, // GeoJSON Polygon coordinates
    intervalTimer: null,
    tilesDone: 0,
    tilesTotal: 0,
    startTime: 0, // ms timestamp the current scan began
    nextScanAt: 0, // ms timestamp the next scheduled scan will start
  };

  function activeDetectors() {
    const out = [];
    if (settings.detectors.closure.enabled) out.push(makeClosureDetector());
    // Phase 2 detectors (edit/report/suggestion) are wired here later.
    return out;
  }

  // --- Deterministic tile grid --------------------------------------------
  // A fixed grid anchored to the region's bbox origin, so a cell index means the
  // same lon/lat across sessions and window sizes. This lets the optimize mask
  // (a set of productive cell indices) stay valid for later scans. The grid is
  // stored *with* the mask; recurring scans reuse the stored grid rather than
  // recomputing from the live viewport.
  function computeGrid(polygon, viewSize) {
    const bbox = bboxOfCoords(polygon[0]);
    const stepX = viewSize.w * TILE_OVERLAP;
    const stepY = viewSize.h * TILE_OVERLAP;
    const cols = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / stepX) + 1);
    const rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / stepY) + 1);
    return { minLon: bbox[0], minLat: bbox[1], stepX, stepY, cols, rows, w: viewSize.w, h: viewSize.h };
  }

  function gridCellCenter(grid, index) {
    const col = index % grid.cols;
    const row = Math.floor(index / grid.cols);
    return { lon: grid.minLon + col * grid.stepX, lat: grid.minLat + row * grid.stepY };
  }

  function gridCellBox(grid, index) {
    const c = gridCellCenter(grid, index);
    return [c.lon - grid.w / 2, c.lat - grid.h / 2, c.lon + grid.w / 2, c.lat + grid.h / 2];
  }

  // Indices of every grid cell that overlaps the polygon — fast and
  // inclusion-safe. A cell overlaps the region iff its center is inside the
  // polygon (interior) OR the region boundary passes through it (coastline). We
  // find interior cells with one point-in-polygon test each, then rasterize the
  // boundary edges to add the coastal cells. This is O(cells × vertices) for ONE
  // point test per cell — not the corners-plus-edges test per cell — so it stays
  // snappy even on a large island bbox, and never drops a cell that holds land.
  function relevantCells(grid, polygon) {
    const total = grid.cols * grid.rows;
    const inside = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const c = gridCellCenter(grid, i);
      if (pointInPolygon([c.lon, c.lat], polygon)) inside[i] = 1;
    }
    for (const ring of polygon) markRingCells(ring, grid, inside);
    const out = [];
    for (let i = 0; i < total; i++) if (inside[i]) out.push(i);
    return out;
  }

  // Mark every grid cell that a ring's edges pass through (coastal cells whose
  // center may sit just outside the polygon but which still contain land).
  function markRingCells(ring, grid, inside) {
    const step = Math.min(grid.stepX, grid.stepY) * 0.5 || 1e-6;
    for (let k = 0; k < ring.length - 1; k++) {
      const a = ring[k], b = ring[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let t = 0; t <= n; t++) {
        const lon = a[0] + ((b[0] - a[0]) * t) / n;
        const lat = a[1] + ((b[1] - a[1]) * t) / n;
        const col = Math.round((lon - grid.minLon) / grid.stepX);
        const row = Math.round((lat - grid.minLat) / grid.stepY);
        if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) {
          inside[row * grid.cols + col] = 1;
        }
      }
    }
  }

  function sameGrid(a, b) {
    const near = (x, y) => Math.abs(x - y) < 1e-9;
    return !!a && !!b && a.cols === b.cols && a.rows === b.rows &&
      near(a.stepX, b.stepX) && near(a.stepY, b.stepY) &&
      near(a.minLon, b.minLon) && near(a.minLat, b.minLat);
  }

  // True if the current viewport (at scan time) is large enough to cover a cell
  // built from `grid`; if the window shrank since optimizing, one center per cell
  // would leave gaps, so we fall back to a full scan instead of missing area.
  function viewportCoversGrid(grid, viewSize) {
    return viewSize.w >= grid.stepX * 0.999 && viewSize.h >= grid.stepY * 0.999;
  }

  // Does the tile currently on the map hold any non-offroad segment inside `box`?
  function tileHasRoad(box) {
    let segs = [];
    try { segs = sdk.DataModel.Segments.getAll(); } catch (e) { return false; }
    for (const s of segs) {
      if (OFFROAD_ROAD_TYPES.has(s.roadType)) continue;
      const coords = s.geometry && s.geometry.coordinates;
      if (!coords) continue;
      for (const c of coords) if (pointInBox(c, box)) return true;
    }
    return false;
  }

  // Rolling learner: how long a *productive* tile takes to reveal its roads,
  // measured from the map move. Drives the adaptive give-up deadline below.
  const optTiming = {
    samples: [],
    push(ms) {
      this.samples.push(ms);
      if (this.samples.length > OPT_SAMPLE_WINDOW) this.samples.shift();
    },
    // How long to dwell on a tile waiting for its roads to load before moving on:
    // a generous multiple of the observed 95th-percentile load time, clamped.
    // (Moving on early is safe — the persistent listener still credits a cell
    // when its roads load later — but a longer dwell reduces re-panning churn.)
    dwellDeadline() {
      if (this.samples.length < 5) return OPT_WARMUP_DEADLINE_MS;
      const sorted = [...this.samples].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      return Math.max(OPT_MIN_DEADLINE_MS, Math.min(OPT_MAX_DEADLINE_MS, Math.round(p95 * OPT_SAFETY)));
    },
    avgMs() {
      if (!this.samples.length) return null;
      return Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length);
    },
  };

  // Track the segments data model so we get `wme-data-model-objects-added` events
  // when roads enter the model — the real "roads just loaded" signal.
  let segmentsTracked = false;
  function ensureSegmentTracking() {
    if (segmentsTracked) return;
    try { sdk.Events.trackDataModelEvents({ dataModelName: "segments" }); segmentsTracked = true; } catch (e) {}
  }
  function stopSegmentTracking() {
    if (!segmentsTracked) return;
    try { sdk.Events.stopDataModelEventsTracking({ dataModelName: "segments" }); } catch (e) {}
    segmentsTracked = false;
  }

  // Which grid cell contains a given lon/lat (-1 if off-grid). Matches the cell
  // whose center is nearest, i.e. the same indexing as gridCellCenter.
  function cellIndexOf(grid, lon, lat) {
    const col = Math.round((lon - grid.minLon) / grid.stepX);
    const row = Math.round((lat - grid.minLat) / grid.stepY);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return -1;
    return row * grid.cols + col;
  }

  // Record every cell a segment passes through into `found` (a Set of indices),
  // if the segment is a real (non-offroad) road. Used by the optimize pass's
  // persistent listener so a road credits its cell whenever it loads — even after
  // the pass has already panned past that tile.
  function recordSegmentCells(seg, grid, found) {
    if (!seg || OFFROAD_ROAD_TYPES.has(seg.roadType)) return;
    const coords = seg.geometry && seg.geometry.coordinates;
    if (!coords) return;
    for (const c of coords) {
      const idx = cellIndexOf(grid, c[0], c[1]);
      if (idx >= 0) found.add(idx);
    }
  }

  // --- Optimization mask storage (one GM key per region) -------------------
  function regionKey(region) {
    const s = JSON.stringify((region && region.coordinates) || []);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return "r" + (h >>> 0).toString(36) + "_" + s.length;
  }

  function loadMask(region) {
    try {
      const raw = GM_getValue(MASK_STORAGE_PREFIX + regionKey(region), null);
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) { return null; }
  }

  function saveMask(region, mask) {
    try {
      GM_setValue(MASK_STORAGE_PREFIX + regionKey(region), JSON.stringify(mask));
    } catch (e) { console.error("[WME Auto Scan] failed to save mask", e); }
  }

  function clearMask(region) {
    try { GM_setValue(MASK_STORAGE_PREFIX + regionKey(region), null); } catch (e) {}
  }

  function maskIsStale(mask) {
    if (!mask || !mask.builtAt) return false;
    return Date.now() - Date.parse(mask.builtAt) > MASK_STALE_DAYS * 86400000;
  }

  // --- Run-duration timing (one GM key per region) -------------------------
  // Persists how long the last scan / optimize of a region took, so we can show
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

  // Remaining time for the current run: prefer the previous run's duration for
  // this region; fall back to extrapolating from progress so far.
  function estimateRemaining(kind, elapsedMs, done, total) {
    const t = settings.region ? loadTiming(settings.region) : null;
    const prev = t && (kind === "scan" ? t.lastScanMs : t.lastOptimizeMs);
    if (prev != null && prev > 0) return Math.max(0, prev - elapsedMs);
    if (done > 0 && total > 0) return Math.max(0, (elapsedMs / done) * total - elapsedMs);
    return null;
  }

  // Centers the recurring scan should visit: the productive subset if a complete,
  // window-compatible mask exists; otherwise the full polygon-culled grid.
  function scanCenters(region, polygon) {
    const liveView = currentViewSize();
    const mask = loadMask(region);
    if (mask && mask.complete && Array.isArray(mask.productive) && mask.productive.length &&
        viewportCoversGrid(mask.grid, liveView)) {
      return mask.productive.map((idx) => gridCellCenter(mask.grid, idx));
    }
    const grid = computeGrid(polygon, liveView);
    return relevantCells(grid, polygon).map((idx) => gridCellCenter(grid, idx));
  }

  // --- Optimize pass -------------------------------------------------------
  const optimizeState = { running: false, cancel: false, done: 0, total: 0, productive: 0, startTime: 0 };

  async function runOptimize() {
    if (optimizeState.running || scanState.running) return;
    if (!settings.region || !settings.region.coordinates) {
      setStatus("Choose a scan area before optimizing.");
      return;
    }
    optimizeState.running = true;
    optimizeState.cancel = false;
    optimizeState.startTime = Date.now();
    const region = settings.region;
    const polygon = region.coordinates;
    const originalCenter = sdk.Map.getMapCenter();
    const originalZoom = sdk.Map.getZoomLevel();
    refreshUI();

    // A persistent record of which cells have roads. Roads are credited by a
    // single listener that stays active for the whole pass, so a tile's roads
    // count whenever they load — even after we've panned past it (the fix for
    // dense urban tiles that load slower than any per-tile wait).
    const found = new Set();
    ensureSegmentTracking();
    let gridRef = null;
    const onSegAdded = (payload) => {
      if (!gridRef || !payload || payload.dataModelName !== "segments") return;
      for (const id of payload.objectIds || []) {
        try { recordSegmentCells(sdk.DataModel.Segments.getById({ segmentId: id }), gridRef, found); } catch (e) {}
      }
    };
    sdk.Events.on({ eventName: "wme-data-model-objects-added", eventHandler: onSegAdded });

    try {
      // Establish the viewport size at scan zoom before laying out the grid.
      await moveTo(centroidOfBbox(bboxOfCoords(polygon[0])), SCAN_ZOOM);
      const grid = computeGrid(polygon, currentViewSize());
      gridRef = grid;

      // Resume a matching in-progress mask, else start fresh.
      let mask = loadMask(region);
      let cells, startAt;
      if (mask && !mask.complete && sameGrid(mask.grid, grid) && Array.isArray(mask.cells)) {
        cells = mask.cells;
        (mask.productive || []).forEach((i) => found.add(i));
        startAt = mask.nextIndex || 0;
      } else {
        cells = relevantCells(grid, polygon);
        startAt = 0;
        mask = { version: 1, grid, cells, productive: [], total: cells.length, nextIndex: 0, complete: false, builtAt: null };
        saveMask(region, mask);
      }
      const cellSet = new Set(cells);
      optimizeState.total = cells.length;
      const productiveCount = () => { let n = 0; for (const i of found) if (cellSet.has(i)) n++; return n; };
      const persist = () => { mask.productive = cells.filter((i) => found.has(i)); saveMask(region, mask); };

      // Seed with whatever is already loaded on the map right now.
      try { for (const s of sdk.DataModel.Segments.getAll()) recordSegmentCells(s, grid, found); } catch (e) {}

      for (let i = startAt; i < cells.length; i++) {
        if (optimizeState.cancel) break;
        const idx = cells[i];
        await dwellCell(idx, gridCellCenter(grid, idx), gridCellBox(grid, idx), found);
        mask.nextIndex = i + 1;
        optimizeState.done = i + 1;
        if (i % OPTIMIZE_SAVE_EVERY === 0 || i === cells.length - 1) {
          optimizeState.productive = productiveCount();
          persist();
        }
      }

      // Drain: let the last tiles' roads finish loading and be credited before we
      // finalize (the listener is still active).
      if (!optimizeState.cancel) {
        setStatus(`Optimizing… finishing up.`);
        await drainLoads();
      }

      persist();
      if (!optimizeState.cancel) {
        mask.complete = true;
        mask.builtAt = new Date().toISOString();
        saveMask(region, mask);
        saveTiming(region, { lastOptimizeMs: Date.now() - optimizeState.startTime });
        setStatus(`Optimization complete: ${productiveCount()}/${cells.length} areas have roads. Future scans will skip the others.`);
      } else {
        setStatus(`Optimization paused at ${mask.nextIndex}/${cells.length}. You can resume it later.`);
      }
    } catch (e) {
      console.error("[WME Auto Scan] optimize failed", e);
      setStatus("Optimization failed: " + e.message);
    } finally {
      try { sdk.Events.off({ eventName: "wme-data-model-objects-added", eventHandler: onSegAdded }); } catch (e) {}
      stopSegmentTracking();
      try { sdk.Map.setMapCenter({ lonLat: originalCenter, zoomLevel: originalZoom }); } catch (e) {}
      optimizeState.running = false;
      refreshUI();
    }
  }

  // Dwell on a tile: move there and wait until its roads have been credited (fast
  // for a tile with roads) or the learned dwell deadline passes (empty-looking
  // tiles move on — the persistent listener still credits them if roads load
  // later). `found` is updated out-of-band by that listener; we also read the
  // model directly here as a backstop in case an add event was missed.
  async function dwellCell(idx, center, box, found) {
    const t0 = performance.now();
    sdk.Map.setMapCenter({ lonLat: center, zoomLevel: SCAN_ZOOM });
    const deadline = optTiming.dwellDeadline();
    for (;;) {
      if (found.has(idx)) { optTiming.push(performance.now() - t0); return; }
      if (tileHasRoad(box)) { found.add(idx); optTiming.push(performance.now() - t0); return; }
      if (performance.now() - t0 >= deadline) return;
      await sleep(OPT_POLL_MS);
    }
  }

  // Wait for in-flight tile loads to settle at the end of the pass so the last
  // tiles' roads are credited. Resolves early once the map has been quiet a
  // while, capped so it can't hang.
  async function drainLoads() {
    let lastLoad = performance.now();
    const onLoad = () => { lastLoad = performance.now(); };
    sdk.Events.on({ eventName: "wme-map-data-loaded", eventHandler: onLoad });
    const start = performance.now();
    try {
      while (performance.now() - start < OPT_DRAIN_MAX_MS) {
        if (performance.now() - lastLoad >= OPT_DRAIN_QUIET_MS) break;
        await sleep(OPT_POLL_MS);
      }
    } finally {
      try { sdk.Events.off({ eventName: "wme-map-data-loaded", eventHandler: onLoad }); } catch (e) {}
    }
  }

  function stopOptimize() {
    optimizeState.cancel = true;
  }

  async function runScan() {
    if (scanState.running || optimizeState.running) return;
    if (!settings.region || !settings.region.coordinates) {
      setStatus("Choose a scan area first.");
      return;
    }
    scanState.running = true;
    scanState.polygon = settings.region.coordinates;
    scanState.startTime = Date.now();

    // Remember the editor's view so we can restore it afterwards.
    const originalCenter = sdk.Map.getMapCenter();
    const originalZoom = sdk.Map.getZoomLevel();

    const detectors = activeDetectors();
    if (!detectors.length) {
      scanState.running = false;
      setStatus("Turn on at least one detector.");
      return;
    }

    try {
      // Establish viewport size at scan zoom from the region centroid.
      const startCenter = centroidOfBbox(bboxOfCoords(scanState.polygon[0]));
      await moveTo(startCenter, SCAN_ZOOM);

      const centers = scanCenters(settings.region, scanState.polygon);
      scanState.tilesTotal = centers.length;
      scanState.tilesDone = 0;

      let finishedAllTiles = true;
      for (const center of centers) {
        if (!scanState.running) { finishedAllTiles = false; break; } // stopped mid-scan
        await moveForScan(center);
        for (const det of detectors) {
          try { det.collect(); } catch (e) { console.error("[WME Auto Scan] collect error", e); }
        }
        scanState.tilesDone++;
      }

      // Finalize (build + send notifications, incl. screenshots which move map).
      for (const det of detectors) {
        try { await det.finalize(); } catch (e) {
          console.error("[WME Auto Scan] finalize error", e);
        }
      }

      // Record this run's duration (used for "Last scan …" and remaining-time
      // estimates) only when the whole region was scanned.
      if (finishedAllTiles && settings.region) {
        saveTiming(settings.region, { lastScanMs: Date.now() - scanState.startTime, lastScanAt: Date.now() });
      }
    } catch (e) {
      console.error("[WME Auto Scan] scan failed", e);
      setStatus("Scan failed: " + e.message);
    } finally {
      // Restore the editor's original view.
      try {
        sdk.Map.setMapCenter({ lonLat: originalCenter, zoomLevel: originalZoom });
        sdk.Editing.clearSelection();
      } catch (e) {}
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
    setStatus("Stopped.");
    refreshUI();
  }

  function startBlockReason() {
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
  // stays fast, then stores it. Changing the region invalidates nothing else —
  // the mask is keyed to the (simplified) coordinates, so a new region simply has
  // no mask yet.
  function setRegion(label, coordinates) {
    const before = (coordinates && coordinates[0] && coordinates[0].length) || 0;
    const simplified = simplifyPolygonCoords(coordinates);
    const after = (simplified && simplified[0] && simplified[0].length) || 0;
    if (before !== after) {
      console.debug(`[WME Auto Scan] region "${label}" simplified ${before} → ${after} points`);
    }
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
  function managedAreaNames() {
    const byId = new Map();
    try {
      const info = sdk.State.getUserInfo();
      for (const m of (info && info.managedAreas) || []) {
        if (m && m.id != null && m.name) byId.set(String(m.id), m.name);
      }
    } catch (e) {}
    return byId;
  }

  function managedAreaPresets() {
    const presets = [];
    const names = managedAreaNames();
    try {
      const areas = sdk.DataModel.ManagedAreas.getAll();
      areas.forEach((a) => {
        if (a.geometry && a.geometry.coordinates) {
          const name = names.get(String(a.id));
          presets.push({ label: name || a.userName || `Area ${a.id}`, coordinates: a.geometry.coordinates });
        }
      });
    } catch (e) {}
    try {
      const info = sdk.State.getUserInfo();
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
  function scrapeAreaUsernames() {
    const names = new Set();
    const add = (n) => { if (n) names.add(n); };
    const sweep = (getter) => {
      try {
        for (const o of getter() || []) {
          const m = o && o.modificationData;
          if (m) { add(m.createdBy); add(m.updatedBy); }
        }
      } catch (e) {}
    };
    sweep(() => sdk.DataModel.Segments.getAll());
    sweep(() => sdk.DataModel.Venues.getAll());
    sweep(() => sdk.DataModel.MapComments.getAll());
    sweep(() => sdk.DataModel.RoadClosures.getAll());
    try {
      for (const u of sdk.DataModel.MapUpdateRequests.getAll() || []) {
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
      headers: { "Accept-Language": "en", "User-Agent": `${SCRIPT_NAME}/0.2.0` },
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
    .was-hook .chev { position: absolute; right: 8px; top: 7px; color: var(--was-muted); pointer-events: none;
      transition: transform .15s; }
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
      const remaining = estimateRemaining("optimize", elapsed, optimizeState.done, optimizeState.total);
      const rem = remaining != null ? ` (${fmtDuration(remaining)} left)` : "";
      const roads = optimizeState.total ? ` · ${optimizeState.productive} with roads` : "";
      return `Optimizing… ${fmtDuration(elapsed)}${rem}${roads}`;
    }
    if (scanState.running) {
      const elapsed = Date.now() - (scanState.startTime || Date.now());
      const remaining = estimateRemaining("scan", elapsed, scanState.tilesDone, scanState.tilesTotal);
      const rem = remaining != null ? ` (${fmtDuration(remaining)} left)` : "";
      return `Scanning… ${fmtDuration(elapsed)}${rem}`;
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
      cb.addEventListener("change", () => { d.enabled = cb.checked; saveSettings(); });
      row.appendChild(cb);
      row.appendChild(el("span", { text: meta.name + (meta.phase1 ? "" : " (soon)") }));
      sec.appendChild(row);
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
      const drawBtn = el("button", { class: "was-btn secondary", text: regionDraft ? "Redraw area" : "Draw area on map", onclick: drawRegionDraft });
      sec.appendChild(el("div", { class: "was-btns", style: "margin-bottom:6px" }, [drawBtn]));
    }

    // Staged pick + Save (sits right below the pick methods).
    if (regionDraft) {
      sec.appendChild(el("div", { class: "was-muted", text: `Selected: ${regionDraft.label}`, style: "margin:2px 0 6px" }));
    }
    const saveBtn = el("button", {
      class: "was-btn go",
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

    sec.appendChild(buildOptimizeRow());
    return sec;
  }

  function buildManagedAreaPicker() {
    const row = el("div", { class: "was-row" });
    const presets = managedAreaPresets();
    const select = el("select");
    select.appendChild(el("option", { value: "", text: "Choose a managed area…" }));
    presets.forEach((p, i) => select.appendChild(el("option", { value: String(i), text: p.label })));
    select.addEventListener("change", () => {
      if (select.value === "") { regionDraft = null; return; }
      const p = presets[Number(select.value)];
      if (p) { regionDraft = { label: p.label, coordinates: p.coordinates }; refreshUI(); }
    });
    row.appendChild(select);
    if (!presets.length) row.appendChild(el("div", { class: "was-muted", text: "No managed areas found on your account.", style: "margin-top:4px" }));
    return row;
  }

  function buildPlaceSearch() {
    const wrap = el("div");
    const searchInput = el("input", { type: "text", placeholder: "Search for a place…" });
    const searchBtn = el("button", { class: "was-btn secondary", text: "Search" });
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

  // Optimize control + plain-language status, shown inside the region section.
  function buildOptimizeRow() {
    const wrap = el("div", { style: "margin-top:10px; padding-top:8px; border-top:1px solid var(--was-border)" });
    const hasRegion = !!(settings.region && settings.region.coordinates);
    const mask = hasRegion ? loadMask(settings.region) : null;
    const optimized = !!(mask && mask.complete);

    const btns = el("div", { class: "was-btns" });
    if (optimizeState.running) {
      btns.appendChild(el("button", { class: "was-btn danger", text: "Stop", onclick: stopOptimize }));
      btns.appendChild(el("span", { class: "was-muted", text: `Optimizing… ${optimizeState.done}/${optimizeState.total} areas` }));
    } else {
      const resuming = mask && !mask.complete;
      const btnLabel = optimized ? "Re-optimize" : (resuming ? "Resume optimizing" : "Optimize");
      const optBtn = el("button", {
        class: "was-btn " + (optimized ? "secondary" : "go"),
        text: btnLabel,
        onclick: () => {
          // Re-optimizing a region that's already done throws away a good mask,
          // so confirm first when nothing about the region has changed.
          if (optimized && !confirm("This area is already optimized. Run optimization again?")) return;
          runOptimize();
        },
      });
      if (!hasRegion || scanState.running) optBtn.disabled = true;
      btns.appendChild(optBtn);

      // Eye: draw every tile box the scan will visit.
      const boxesEye = el("button", { class: "was-eye", title: "Show the scan areas on the map", text: "👁", onclick: toggleBoxesPreview });
      if (!hasRegion || scanState.running) boxesEye.disabled = true;
      btns.appendChild(boxesEye);

      const pill = optimized
        ? el("span", { class: "was-pill on", text: "Optimized" })
        : el("span", { class: "was-pill off", text: "Not optimized" });
      btns.appendChild(pill);

      if (mask) {
        const clearBtn = el("button", { class: "was-btn secondary", text: "Clear", onclick: () => { clearMask(settings.region); refreshUI(); } });
        if (scanState.running) clearBtn.disabled = true;
        btns.appendChild(clearBtn);
      }
    }
    wrap.appendChild(btns);

    if (optimized && maskIsStale(mask)) {
      wrap.appendChild(el("div", { class: "was-muted", text: `Optimized over ${MASK_STALE_DAYS} days ago. Run it again if roads have changed.`, style: "margin-top:6px; color:#b45309" }));
    } else if (mask && !mask.complete && !optimizeState.running) {
      wrap.appendChild(el("div", { class: "was-muted", text: `Paused after ${mask.nextIndex || 0} of ${mask.total} areas.`, style: "margin-top:6px" }));
    }
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
    sec.appendChild(el("div", { class: "was-muted", text: "Activity from these editors won't send notifications. You're always whitelisted.", style: "margin-bottom:6px" }));

    const chips = el("div");
    const renderChips = () => {
      chips.innerHTML = "";
      for (const name of settings.whitelist) {
        const chip = el("span", { class: "was-chip", text: name });
        chip.appendChild(el("button", { text: "×", onclick: () => { settings.whitelist = settings.whitelist.filter((n) => n !== name); saveSettings(); renderChips(); } }));
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
    const scanBtn = el("button", { class: "was-btn secondary", text: "Find editors in view" });
    scanBtn.addEventListener("click", () => {
      const names = scrapeAreaUsernames().sort((a, b) => a.localeCompare(b));
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
    edit: { name: "User edits", phase1: false },
    report: { name: "Map issues", phase1: false },
    suggestion: { name: "Map suggestions", phase1: false },
  };

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  let settings = defaultSettings();

  function bootstrap() {
    sdk = PAGE.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
    settings = loadSettings();

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
        console.debug(`[WME Auto Scan] migrated stored region → ${settings.region.points} points`);
      }
    }

    // Cache localized road-type names.
    try {
      for (const rt of sdk.DataModel.Segments.getRoadTypes()) roadTypeNames[rt.id] = rt.localizedName || rt.name;
    } catch (e) {}

    // Identify the current user (always whitelisted).
    try {
      const info = sdk.State.getUserInfo();
      if (info && info.userName) { selfUserName = info.userName; noteUsername(info.userName); }
    } catch (e) {}

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
