// ==UserScript==
// @name         WME Auto Scan
// @namespace    https://github.com/SecuredUnderscore/WME-Auto-Scan
// @version      0.2.0
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
  const SCRIPT_VERSION = "0.2.0"; // keep in sync with @version above
  const STORAGE_KEY = "wme-auto-scan:settings:v1";
  const ROADS_ZOOM = 15; // closures + user edits: segments, closures and places load here
  const ISSUES_ZOOM = 12; // Update Requests + Map Suggestions: WME's Issue Tracker minimum
  const MAX_SPLIT_ZOOM = 17; // deepest zoom a busy Issue Tracker tile is split to
  // A capped Issue Tracker response holds exactly the cap, so if any tile in a
  // pass was capped, the cap is the largest count in that pass. Verifying just
  // the busiest tile therefore settles the whole pass (see probeForCap) — a busy
  // tile alone means nothing: Vancouver Island returns 91-378 suggestions per
  // zoom-12 tile, capped at none of them. ISSUE_SPLIT_AT only splits on sight a
  // response so large it is almost certainly truncated.
  const ISSUE_SPLIT_AT = 1000;
  const ISSUE_PROBE_MIN = 50; // smallest count worth verifying as a possible cap
  const TILE_MARGIN = 0.97; // grid step as a fraction of the box WME loads per visit
  const MAX_SPLIT_DEPTH = 4; // quarterings of one cell when WME's box doesn't cover it
  const REQUEST_TIMEOUT_MS = 30000; // a WME request stuck this long is abandoned and retried
  const MAX_TILE_RETRIES = 5; // failed loads of one tile before the scan stops
  const RETRY_BASE_MS = 250; // backoff after a failed load: 1 s, 2 s, 4 s…

  // --- Optimization "tile mask" -------------------------------------------
  // A one-time pass records which grid cells contain a real (non-offroad) road
  // network; recurring scans then visit only those cells, skipping ocean and
  // roadless wilderness. Every visit is loaded exactly (see createLoadTracker),
  // and a cell a neighbouring response already showed a road in is not visited.
  const OFFROAD_ROAD_TYPES = new Set([8]); // roadType ids that don't count as "has roads"
  const MASK_STORAGE_PREFIX = "wme-auto-scan:mask:v2:"; // v1 masks used a lat/lon grid and timed loads
  const MASK_STALE_DAYS = 30; // suggest re-optimizing once a mask is older than this
  const OPTIMIZE_SAVE_EVERY = 25; // persist optimize progress every N cells (resumable)
  const BOX_RATIO_KEY = "wme-auto-scan:box-ratio:v1"; // measured request box ÷ viewport, for previews
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
        skipPlaces: false, // don't load places while scanning (User edits then covers segments only)
      },
      whitelist: [], // usernames whose events are suppressed
      whitelistSeeded: false, // set once we've added the current user by default
      region: null, // GeoJSON Polygon coordinates (rings of [lon,lat]) + label
      detectors: {
        closure: { ...detector(), enabled: true },
        edit: { ...detector(), cooldownMin: 60 },
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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
  // SDK-backed map utilities
  // ---------------------------------------------------------------------------
  let sdk = null;
  let roadTypeNames = {}; // id -> localized name

  // --- Web Mercator helpers ------------------------------------------------
  // At a fixed zoom the viewport (and every box WME requests) has the same size
  // in Mercator units anywhere on the map, so tile grids are laid out in
  // lon × Mercator-Y. A plain lat/lon grid would leave gaps toward the poles.
  const RAD = Math.PI / 180;
  function mercY(lat) {
    return Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / RAD;
  }
  function latOfMercY(y) {
    return (2 * Math.atan(Math.exp(y * RAD)) - Math.PI / 2) / RAD;
  }
  // Width/height of a [minLon, minLat, maxLon, maxLat] box in Mercator units.
  function mercSpan(box) {
    return { w: box[2] - box[0], h: mercY(box[3]) - mercY(box[1]) };
  }
  function boxContains(outer, inner) {
    return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
  }

  // --- Exact map-load tracking ---------------------------------------------
  // EXPLICIT SDK-ONLY EXCEPTION — authorized by the user on 2026-09-06 (WME's
  // loading flags) and widened on 2026-09-13 to read-only load tracking, ONLY
  // for detecting map-load completion. The SDK can't tell a finished tile from
  // a failed or superseded request, so we observe the performance marks WME
  // itself writes around each map-data request:
  //   wme_mark_request_features_and_render_{start,end}$<uuid>  roads, closures,
  //     places — the end mark is written after the response is merged
  //   wme_mark_request_issues_map_{start,end}$<uuid>  Issue Tracker bbox search
  //     (Update Requests, Map Suggestions) — merged before observers run
  // End marks carry the request's status, bbox and zoom. This is a standard
  // PerformanceObserver: we never patch WME, call its endpoints, or initiate
  // requests, and all scan data still comes from the SDK data model. WME starts
  // both requests synchronously inside the map move, so there is nothing to time.
  // If WME stops writing these marks the scan fails instead of guessing.
  const REQUEST_MARK = /^wme_mark_(request_features_and_render|request_issues_map)_(start|end)\$(.+)$/;
  const MARK_KIND = { request_features_and_render: "features", request_issues_map: "issues" };
  const NUDGE_DEG = 1e-6; // re-centering offset that makes WME request a tile again
  const NO_LOAD_MESSAGES = {
    features: "WME didn't load road data for part of the area. Scan stopped; baseline was not updated.",
    issues: "WME didn't search the Issue Tracker for part of the area. Make sure the Issue Tracker layer is on.",
  };

  // --- Rate-limit watch ----------------------------------------------------
  // Waze's edge (Google Frontend) answers bursts with "429 Too Many Requests",
  // with no Retry-After and an HTML body, and typically refuses everything for a
  // ban window once tripped — so pacing during one is pointless and the whole
  // scan has to wait. WME discards the status code, so we read it from resource
  // timing: the browser's own record of requests the page already made. Passive,
  // like the marks above: no patching, no requests of our own.
  // Only map-data endpoints matter: WME's telemetry exporter (otlp-traces) is
  // throttled far sooner than the data paths and refusing it costs the scan
  // nothing, so pausing for those refusals would stall a healthy scan.
  const DATA_REQUESTS = /Descartes\/app\/Features|Descartes\/app\/v1\/Issues|MapEditorWebServer\/search/;
  // A lone 429 is a burst the retry rides out (WME serves the retried request
  // and caches it), so it costs nothing to ignore. Only back-to-back refusals
  // with no successful data response between them mean the door is actually shut.
  const RATE_COOLDOWN_MS = 1000; // pause once two refusals come in a row; doubles from there
  const RATE_COOLDOWN_MAX_MS = 30000;
  // Sustained partial refusals (WME kept refusing ~40% of requests while serving
  // the rest) mean the limiter wants a lower rate, not a pause: the gap between
  // map moves rises with the recent refusal rate and falls back to nothing as
  // soon as requests are being served again.
  const RATE_SAMPLE = 20; // requests per endpoint the refusal rate is measured over
  const RATE_MAX_GAP_MS = 5000;
  const RATE_GIVE_UP_MS = 300000; // give up on a tile after this long spent waiting out refusals

  function createRateWatcher(perf, Observer) {
    let cooldownUntil = 0, streak = 0;
    const recent = new Map(); // endpoint -> last RATE_SAMPLE outcomes (true when refused)
    let lastRefusalAt = -Infinity, observer = null;

    function record(entry) {
      const status = Number(entry.responseStatus || 0);
      if (!status || !DATA_REQUESTS.test(entry.name)) return;
      let path = entry.name;
      try {
        const url = new URL(entry.name);
        path = url.host + url.pathname.split("/").slice(0, 5).join("/");
      } catch (e) {}
      // Tracked per endpoint: the searches are almost never refused and would
      // otherwise hide how hard Features and Issues are being throttled.
      const outcomes = recent.get(path) || [];
      outcomes.push(status === 429);
      if (outcomes.length > RATE_SAMPLE) outcomes.shift();
      recent.set(path, outcomes);
      if (status !== 429) {
        if (status < 400) streak = 0; // the door is open again
        return;
      }
      streak++;
      lastRefusalAt = perf.now();
      // The first refusal is left to the tile's own retry; only a run of them pauses.
      const pause = streak < 2 ? 0 : Math.min(RATE_COOLDOWN_MAX_MS, RATE_COOLDOWN_MS * 2 ** (streak - 2));
      if (!pause) return;
      cooldownUntil = Math.max(cooldownUntil, lastRefusalAt + pause);
      console.warn(`[WME Auto Scan] WME refused ${streak} map-data requests in a row on ${path}. Pausing ${(pause / 1000).toFixed(1)}s.`);
    }

    try {
      observer = new Observer((list) => { const entries = list.getEntries(); for (let i = 0; i < entries.length; i++) record(entries[i]); });
      observer.observe({ type: "resource", buffered: false });
    } catch (e) { observer = null; }

    return {
      // Sit out a rate-limit pause; resolves the milliseconds waited, or null if
      // the run was stopped.
      async clearance(isStopped) {
        const from = perf.now();
        for (let left = cooldownUntil - perf.now(); left > 0; left = cooldownUntil - perf.now()) {
          if (isStopped()) return null;
          await sleep(Math.min(left, 500));
        }
        return isStopped() ? null : perf.now() - from;
      },
      refusedSince: (t) => lastRefusalAt >= t,
      // Minimum spacing between map moves for the refusal rate we're seeing.
      gap() {
        let worst = 0;
        for (const outcomes of recent.values()) {
          if (outcomes.length < 8) continue;
          worst = Math.max(worst, outcomes.filter(Boolean).length / outcomes.length);
        }
        return worst <= 0.05 ? 0 : Math.min(RATE_MAX_GAP_MS, Math.round(worst * 10) * 500);
      },
      disconnect() {
        if (observer) observer.disconnect();
      },
    };
  }

  function markBox(b) {
    if (!b) return null;
    const box = (b.left != null ? [b.left, b.bottom, b.right, b.top] : [b[0], b[1], b[2], b[3]]).map(Number);
    return box.every(Number.isFinite) ? box : null;
  }

  function createLoadTracker(isStopped) {
    const perf = window.performance;
    const Observer = window.PerformanceObserver;
    if (!perf || typeof perf.getEntriesByType !== "function" || typeof Observer !== "function") {
      throw new Error("WME load tracking is unavailable in this browser. Scan stopped; baseline was not updated.");
    }
    const rate = createRateWatcher(perf, Observer);
    let lastMoveAt = -Infinity;
    const requests = new Map(); // uuid -> request record
    let sawRequestMark = false;
    let wake = null;
    const lateMergeAt = { features: -Infinity, issues: -Infinity };

    function record(entry) {
      const m = REQUEST_MARK.exec(entry.name);
      if (!m) return;
      sawRequestMark = true;
      let req = requests.get(m[3]);
      if (!req) {
        req = { kind: MARK_KIND[m[1]], startedAt: entry.startTime, endedAt: null, status: null };
        requests.set(m[3], req);
      }
      if (m[2] === "start") {
        req.startedAt = entry.startTime;
        return;
      }
      const detail = entry.detail || {};
      if (req.endedAt != null) {
        // A request we abandoned finished after all; if it succeeded, WME merged
        // its stale response over whatever the scan has loaded since.
        if (req.status === "timeout" && detail.status === "success") lateMergeAt[req.kind] = entry.startTime;
        return;
      }
      const params = detail.requestParams || {};
      req.endedAt = entry.startTime;
      req.status = detail.status;
      req.box = markBox(req.kind === "features" ? params.bounds : params.bbox);
      req.zoom = Number(detail.zoomLevel != null ? detail.zoomLevel : params.zoomLevel);
      req.counts = detail.itemsCount || null;
      req.hasUpdateRequests = !!params.mapUpdateRequestsFilter;
      req.hasSuggestions = !!params.mapSuggestionsFilter;
      // Groups WME searches for that no detector reads — each costs a request per tile.
      req.spareGroups = [
        params.mapProblemsFilter && "Map Problems",
        params.venueUpdateRequestsFilter && "Place Update Requests",
      ].filter(Boolean);
      if (wake) { const w = wake; wake = null; w(); }
    }

    const recordAll = (entries) => { for (let i = 0; i < entries.length; i++) record(entries[i]); };
    const observer = new Observer((list) => recordAll(list.getEntries()));
    try { observer.observe({ type: "mark" }); } catch (e) { observer.observe({ entryTypes: ["mark"] }); }
    // WME clears both marks as soon as a request ends, so the buffer only ever
    // holds start marks of requests still in flight — read them synchronously.
    const syncMarks = () => recordAll(perf.getEntriesByType("mark"));
    syncMarks();

    // Requests of `kind` still in flight. One stuck past the timeout is
    // abandoned (treated as failed) so its tile is retried instead of hanging.
    function inFlight(kind) {
      let n = 0;
      for (const req of requests.values()) {
        if (req.kind !== kind || req.endedAt != null) continue;
        if (perf.now() - req.startedAt > REQUEST_TIMEOUT_MS) {
          req.endedAt = perf.now();
          req.status = "timeout";
          continue;
        }
        n++;
      }
      return n;
    }

    // Resolve on the next end mark, or after `ms` so stops and timeouts are seen.
    function nextEnd(ms) {
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { if (wake === done) wake = null; resolve(); }, ms);
        wake = done;
      });
    }

    // One macrotask. WME merges an Issue Tracker response in microtasks right
    // after its end mark, so this guarantees the merge has run.
    function nextTask() {
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
        channel.port2.postMessage(null);
      });
    }

    async function settle(kind) {
      for (;;) {
        syncMarks();
        while (inFlight(kind)) {
          if (isStopped()) return false;
          await nextEnd(250);
        }
        await nextTask();
        syncMarks();
        if (!inFlight(kind)) return !isStopped();
      }
    }

    // The response currently in the data model: the most recently merged success.
    function latestSuccess(kind) {
      let best = null;
      for (const req of requests.values()) {
        if (req.kind === kind && req.status === "success" && (!best || req.endedAt > best.endedAt)) best = req;
      }
      return best;
    }

    function prune() {
      const keep = new Set([latestSuccess("features"), latestSuccess("issues")]);
      for (const [uuid, req] of requests) if (req.endedAt != null && !keep.has(req)) requests.delete(uuid);
    }

    function noLoadError(kind) {
      const error = new Error(sawRequestMark ? NO_LOAD_MESSAGES[kind]
        : "WME load tracking is unavailable (WME wrote no request marks). Scan stopped; baseline was not updated.");
      error.noLoad = kind;
      return error;
    }

    // Center the map on `tile` ({ center, zoom, rect }) and wait until WME has
    // loaded it: every request of `kind` has ended and the latest merged
    // response is at this zoom and covers tile.rect. Failed, aborted or stuck
    // requests are retried with backoff. Resolves to { box, counts, request },
    // to { uncovered: true } if a fresh response is smaller than the tile, or
    // to null if the run was stopped. `rect: null` accepts any fresh response.
    async function visit(tile, kind) {
      let failures = 0, stale = 0, nudge = 0, pacedMs = 0;
      for (;;) {
        const waited = await rate.clearance(isStopped);
        if (waited == null) return null;
        pacedMs += waited;
        // Hold the self-tuned spacing (zero unless requests are being refused).
        for (let left = lastMoveAt + rate.gap() - perf.now(); left > 0; left = lastMoveAt + rate.gap() - perf.now()) {
          if (isStopped()) return null;
          pacedMs += left;
          await sleep(Math.min(left, 500));
        }
        if (!await settle(kind)) return null;
        prune();
        const zoomChanged = sdk.Map.getZoomLevel() !== tile.zoom;
        const t0 = perf.now();
        lastMoveAt = t0;
        sdk.Map.setMapCenter({ lonLat: { lon: tile.center.lon + nudge * NUDGE_DEG, lat: tile.center.lat }, zoomLevel: tile.zoom });
        if (!await settle(kind)) return null;

        let last = null; // the request this move started that ended last
        for (const req of requests.values()) {
          if (req.kind === kind && req.startedAt >= t0 && (!last || req.endedAt > last.endedAt)) last = req;
        }
        const failed = lateMergeAt[kind] >= t0 ? "late response" : last && last.status !== "success" ? last.status : null;
        if (failed) {
          // A tile refused by the rate limiter isn't a broken tile: wait out the
          // pause and try again rather than spending its retries inside the ban.
          const limited = rate.refusedSince(t0);
          if (limited ? pacedMs > RATE_GIVE_UP_MS : ++failures > MAX_TILE_RETRIES) {
            throw new Error(limited
              ? "WME is rate limiting this session (429 Too Many Requests). Scan stopped; baseline was not updated."
              : `WME kept failing to load map data (${failed}). Scan stopped; baseline was not updated.`);
          }
          if (!limited && (failed === "error" || failed === "timeout")) await sleep(RETRY_BASE_MS * 2 ** (failures - 1));
          nudge = nudge === 1 ? -1 : 1;
          continue;
        }
        if (last && (!last.box || !Number.isFinite(last.zoom))) {
          throw new Error("WME load tracking has changed. Scan stopped; baseline was not updated.");
        }
        if (last && last.zoom !== tile.zoom) {
          throw new Error(`WME didn't switch the map to zoom ${tile.zoom}. Scan stopped; baseline was not updated.`);
        }

        const loaded = latestSuccess(kind);
        const usable = loaded && loaded.box && loaded.zoom === tile.zoom && (!zoomChanged || loaded.startedAt >= t0);
        if (usable && (tile.rect ? boxContains(loaded.box, tile.rect) : loaded === last)) {
          return { box: loaded.box, counts: loaded.counts, request: loaded };
        }
        if (last && tile.rect) return { uncovered: true, box: last.box };
        // Nothing loaded for this spot (no request, or only an older response):
        // re-center a hair away so WME requests it fresh.
        if (++stale > 2) throw noLoadError(kind);
        nudge = nudge === 1 ? -1 : 1;
      }
    }

    return { visit, disconnect: () => { rate.disconnect(); observer.disconnect(); } };
  }

  // --- Scan layers ---------------------------------------------------------
  // WME only requests data for visible layers, so each pass shows just what its
  // detectors read: smaller, faster responses, and hidden imagery stops loading
  // tiles. The editor's own layer choices are saved first (in GM storage, so a
  // tab closed mid-scan is repaired on the next load) and restored afterwards.
  const LAYER_RESTORE_KEY = "wme-auto-scan:layer-restore:v1";
  const SCAN_LAYER_NAMES = [
    "roads", "paths", "closures", "places", "junctionBoxes", "permanentHazards", "gpsPoints",
    "houseNumbers", "mapComments", "cities", "satelliteImagery", "mapProblems", "updateRequests", "editSuggestions",
  ];
  let layerSnapshot = null;

  function layerVisible(name) {
    try { return sdk.LayerSwitcher.getWMELayerVisibility({ layerName: name }); } catch (e) { return null; }
  }

  function setLayerVisible(name, visible) {
    const current = layerVisible(name);
    if (typeof current !== "boolean" || current === visible) return;
    try { sdk.LayerSwitcher.setWMELayerVisibility({ layerName: name, isVisible: visible }); } catch (e) {}
  }

  function savedLayerSnapshot() {
    if (layerSnapshot) return layerSnapshot;
    try {
      const raw = GM_getValue(LAYER_RESTORE_KEY, null);
      return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    } catch (e) { return null; }
  }

  function showOnlyLayers(visible) {
    if (!savedLayerSnapshot()) {
      const prior = {};
      for (const name of SCAN_LAYER_NAMES) {
        const v = layerVisible(name);
        if (typeof v === "boolean") prior[name] = v;
      }
      layerSnapshot = prior;
      try { GM_setValue(LAYER_RESTORE_KEY, JSON.stringify(prior)); } catch (e) {}
    }
    for (const name of SCAN_LAYER_NAMES) setLayerVisible(name, visible.includes(name));
  }

  function restoreLayers() {
    const saved = savedLayerSnapshot();
    if (!saved) return;
    for (const name of Object.keys(saved)) setLayerVisible(name, saved[name]);
    layerSnapshot = null;
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
      sdk.Map.zoomToExtent({ bbox: bboxOfRing(region.coordinates[0]) });
      activePreview = "region";
      armPreviewAutoClear();
    } catch (e) {
      console.error("[WME Auto Scan] region preview failed", e);
    }
  }

  // Zoom out and draw every tile box the first scan pass will visit: the
  // optimized productive cells if a complete mask exists, else the full
  // polygon-culled grid, estimated from the current view without moving the map.
  async function previewScanBoxes() {
    const region = settings.region;
    if (!region || !region.coordinates) return;
    ensurePreviewLayers();
    clearPreview();
    const polygon = region.coordinates;
    const d = settings.detectors;
    const roads = d.closure.enabled || d.edit.enabled || !(d.report.enabled || d.suggestion.enabled);
    try {
      let grid, cells;
      const mask = loadMask(region);
      if (roads && mask && mask.complete && Array.isArray(mask.productive)) {
        grid = mask.grid;
        cells = mask.productive;
      } else {
        const kind = roads ? "features" : "issues";
        const zoom = roads ? ROADS_ZOOM : ISSUES_ZOOM;
        grid = computeGrid(polygon, estimatedSpan(kind, zoom), zoom);
        cells = relevantCells(grid, polygon);
      }
      let capped = false;
      if (cells.length > MAX_PREVIEW_BOXES) { cells = cells.slice(0, MAX_PREVIEW_BOXES); capped = true; }
      const features = cells.map((idx) => boxFeature("box" + idx, gridCellBox(grid, idx)));
      sdk.Map.addFeaturesToLayer({ features, layerName: BBOX_PREVIEW_LAYER });
      sdk.Map.zoomToExtent({ bbox: bboxOfRing(polygon[0]) });
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
  const MIN_FIT_ZOOM = 12, MAX_FIT_ZOOM = 20, DEFAULT_POINT_ZOOM = 17;

  // Zoom level whose viewport contains bbox ([minLon,minLat,maxLon,maxLat]),
  // mirroring sdk.Map.zoomToExtent without moving the live map (which the scan
  // is still driving). Degenerate/absent boxes fall back to a close point zoom.
  function zoomForBbox(bbox) {
    if (!bbox) return DEFAULT_POINT_ZOOM;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lonSpan = maxLon - minLon, latSpan = maxLat - minLat;
    if (!(lonSpan > 0) && !(latSpan > 0)) return DEFAULT_POINT_ZOOM;
    let view = { w: 1200, h: 800 };
    try {
      const el = sdk.Map.getMapViewportElement();
      if (el && el.clientWidth && el.clientHeight) view = { w: el.clientWidth, h: el.clientHeight };
    } catch (e) { /* not mounted; use defaults */ }
    const worldPx = 256, pad = 0.8; // tile size at zoom 0; leave a margin around the feature
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
    const zoomLon = lonSpan > 0 ? Math.log2((view.w * pad) * 360 / (worldPx * lonSpan)) : Infinity;
    const latFrac = Math.abs(merc(maxLat) - merc(minLat)) / (2 * Math.PI);
    const zoomLat = latFrac > 0 ? Math.log2((view.h * pad) / (worldPx * latFrac)) : Infinity;
    const z = Math.floor(Math.min(zoomLon, zoomLat));
    return Math.max(MIN_FIT_ZOOM, Math.min(MAX_FIT_ZOOM, z));
  }

  // getPermalink() encodes the *current* map view — during a scan that is the
  // last tile visited, not the feature. Rewrite lon/lat (and zoom) so the link
  // lands on and fits the feature rather than wherever the scan finished.
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

  function buildLinks(centroid, segmentIds, bbox) {
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
          const note = buildClosureNotification(group);
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

  function buildClosureNotification(group) {
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
  // Update request detector ("Update Requests")
  // ---------------------------------------------------------------------------
  // Scans WME's user-reported update requests (sdk.DataModel.MapUpdateRequests) —
  // the map problem reports drivers file from the app. WME only loads these when
  // the Update Requests group is enabled in the Issue Tracker filter panel, and
  // the panel's status filter (Open/Closed) gates which ones are fetched; see
  // updateRequestsFilterWarning(). URs carry no editor username, so the whitelist
  // doesn't apply.
  function makeReportDetector() {
    const requestsById = new Map(); // dedupe across tiles
    return {
      key: "report",
      collect() {
        const list = sdk.DataModel.MapUpdateRequests.getAll();
        for (const r of list) {
          if (requestsById.has(r.id)) continue;         // cross-tile dedupe
          if (!r.isOpen || r.resolvedOn != null) continue; // only open/unresolved
          const pt = r.geometry && r.geometry.coordinates;
          if (!pt) continue;
          if (!pointInPolygon(pt, scanState.polygon)) continue; // region filter
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
    const type = updateRequestTypeName(r.updateRequestType);
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

  // Read the WME Issue Tracker's active Update Requests filter and return a
  // warning string if that filter would keep the scan from seeing open URs, else
  // null. Note: getActiveFilters() reports `updateRequests: null` both when the
  // group is toggled OFF (nothing is fetched) and when the status filter is the
  // neutral "Both" (everything is fetched) — the SDK can't distinguish them, so
  // null is treated as "fine" here and the empty-group case is covered by the
  // persistent UI hint under the detector toggle instead.
  function updateRequestsFilterWarning() {
    let ur;
    try { ur = sdk.IssueTracker.getActiveFilters().updateRequests; } catch (e) { return null; }
    if (ur && ur.status === "CLOSED") {
      return "WME's Issue Tracker is filtered to CLOSED update requests — the scan won't see open ones. Set the Update Requests status filter to Both (or Open).";
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Map suggestion detector ("Map Suggestions")
  // ---------------------------------------------------------------------------
  // Scans WME's edit suggestions (sdk.DataModel.EditSuggestions) — Google/system
  // suggested edits awaiting review. Same load-gating as update requests: WME
  // only loads them when the Map Suggestions group is on in the Issue Tracker
  // filter panel (see mapSuggestionsFilterWarning). These have no Point geometry,
  // only a bbox, so region filtering tests the bbox against the scan polygon.
  const SUGGESTION_OPEN_STATUSES = new Set(["OPEN", "OPEN_AND_CLOSED"]);
  function makeSuggestionDetector() {
    const suggestionsById = new Map(); // dedupe across tiles
    return {
      key: "suggestion",
      collect() {
        const list = sdk.DataModel.EditSuggestions.getAll();
        for (const s of list) {
          if (suggestionsById.has(s.id)) continue;             // cross-tile dedupe
          if (!SUGGESTION_OPEN_STATUSES.has(s.status)) continue; // only open ones
          const box = normBbox(s.bbox);
          if (!box || box.length < 4) continue;
          if (!bboxInPolygon(box, scanState.polygon)) continue;  // region filter
          suggestionsById.set(s.id, s);
        }
      },
      async finalize() {
        const items = [...suggestionsById.values()];
        const store = seenFor(settings.region, "suggestion");
        const fresh = items.filter((s) => !store.ids.has(String(s.id)));
        for (const s of items) store.ids.add(String(s.id));
        if (!store.baseline) { store.baseline = true; return 0; } // silent first scan
        if (!fresh.length) return 0;
        let sent = 0;
        for (const s of fresh) {
          const note = buildSuggestionNotification(s);
          const results = await sendNotification("suggestion", note);
          if (results.some((x) => x.endsWith(":ok"))) sent++;
        }
        return sent;
      },
    };
  }

  function buildSuggestionNotification(s) {
    const [lon, lat] = bboxCenter(normBbox(s.bbox));
    const links = buildLinks({ lat, lon }, []);
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

  // Warn if the Issue Tracker's Map Suggestions filter would hide open ones.
  // Status "OPEN" (only open) and null (neutral/off) are fine; any other single
  // status (CLOSED_ALL, REJECTED_ALL, APPROVED_BY_GOOGLE, …) excludes open ones.
  function mapSuggestionsFilterWarning() {
    let ms;
    try { ms = sdk.IssueTracker.getActiveFilters().mapSuggestions; } catch (e) { return null; }
    if (ms && ms.status && ms.status !== "OPEN") {
      return `WME's Issue Tracker is filtered to "${ms.status}" map suggestions — the scan won't see open ones. Set the Map Suggestions status filter to Open (or neutral).`;
    }
    return null;
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
  let editStatus = "Not scanned yet.";

  function editTime(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Missing edit timestamp");
    return n < 1e12 ? n * 1000 : n;
  }

  function editEndpoint() {
    const region = sdk.Settings.getRegionCode();
    const bases = { usa: "/Descartes/app", row: "/row-Descartes/app", il: "/il-Descartes/app" };
    if (!bases[region]) throw new Error("Unknown WME server region");
    return new URL(bases[region] + "/ElementHistory", PAGE.location.origin);
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

  function editGeometryInRegion(geometry, polygon) {
    if (!geometry) return false;
    if (geometry.type === "Point") return pointInPolygon(geometry.coordinates, polygon);
    if (geometry.type === "LineString") return lineInPolygon(geometry.coordinates, polygon);
    if (geometry.type === "Polygon") {
      return geometry.coordinates.some((ring) => lineInPolygon(ring, polygon)) ||
        polygon[0].some((pt) => pointInPolygon(pt, geometry.coordinates));
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
    let base;
    try { base = sdk.Map.getPermalink(); } catch (e) { return "https://www.waze.com/editor"; }
    return base
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
      collect() {
        if (sdk.Editing.getUnsavedChangesCount() > 0) throw new Error("Save or undo local edits before scanning User edits");
        const modules = [["segment", sdk.DataModel.Segments]];
        if (!settings.global.skipPlaces) modules.push(["venue", sdk.DataModel.Venues]);
        for (const [type, module] of modules) {
          for (const object of module.getAll()) {
            const id = String(object.id);
            if (!id || id.startsWith("-")) continue;
            const md = object.modificationData;
            if (!md || !(md.updatedOn || md.createdOn)) { missingMetadata++; continue; }
            const item = { type, id, time: editTime(md.updatedOn || md.createdOn) };
            const objectKey = type + ":" + id;
            // SDK merge events repeatedly expose the same loaded objects. Do
            // the potentially expensive polygon intersection only for new versions.
            if (collected.has(objectKey) && collected.get(objectKey).time >= item.time) continue;
            if (!editGeometryInRegion(object.geometry, scanState.polygon)) continue;
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
        const total = Object.keys(store.retry).length;
        for (const [id, item] of Object.entries(store.retry)) {
          if (!scanState.running || budget.remaining <= 0) break;
          setEditStatus(`Reading history: ${++processed}/${total} objects…`);
          try {
            const checkpoint = store.checkpoints[id] || { time: store.baselineAt, ids: [], baseline: true };
            // An old object discovered later is silently baselined.
            const result = item.time <= checkpoint.time ? { events: [], checkpoint } :
              // Commit progress once per object (including paused/failed work),
              // rather than stringifying the entire area store after every page.
              await readNewEditEvents(endpoint, item, checkpoint, budget);
            for (const event of result.events) {
              noteUsername(event.name);
              if (isWhitelisted(event.name)) continue;
              const events = store.pending[event.userID] || (store.pending[event.userID] = []);
              if (!events.some((e) => e.id === event.id && e.type === event.type && e.objectId === event.objectId)) events.push(event);
            }
            store.checkpoints[id] = result.checkpoint;
            delete store.retry[id];
            persist();
          } catch (e) {
            if (e.editStorageFailure) throw e;
            failures++; lastError = e.message;
            console.warn(`[WME Auto Scan] ${id}: ${e.message}`);
            // Move a failing object to the end so it cannot starve the queue.
            delete store.retry[id]; store.retry[id] = item;
            persist();
            if (/HTTP (401|403|429)|Unrecognized history/.test(e.message)) break;
          }
        }
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
    tilesDone: 0,
    tilesTotal: 0,
    startTime: 0, // ms timestamp the current scan began
    nextScanAt: 0, // ms timestamp the next scheduled scan will start
    passLabel: "", // which scan pass is running ("roads" / "issues")
  };

  function activeDetectors() {
    const out = [];
    if (settings.detectors.closure.enabled) out.push(makeClosureDetector());
    if (settings.detectors.report.enabled) out.push(makeReportDetector());
    if (settings.detectors.suggestion.enabled) out.push(makeSuggestionDetector());
    if (settings.detectors.edit.enabled) out.push(makeEditDetector());
    return out;
  }

  // --- Deterministic tile grid --------------------------------------------
  // A fixed grid over the region's bbox in lon × Mercator-Y, so a cell index
  // means the same place across sessions and the optimize mask (a set of
  // productive cell indices) stays valid. Cells tile the area with no overlap.
  // Each is visited from its center, where the box WME loads is slightly larger
  // than the cell (TILE_MARGIN) — and every visit verifies that it covers it.
  function computeGrid(polygon, span, zoom) {
    const b = bboxOfRing(polygon[0]);
    const x0 = b[0], y0 = mercY(b[1]);
    const stepX = span.w * TILE_MARGIN, stepY = span.h * TILE_MARGIN;
    const cols = Math.max(1, Math.ceil((b[2] - x0) / stepX));
    const rows = Math.max(1, Math.ceil((mercY(b[3]) - y0) / stepY));
    return { version: 2, x0, y0, stepX, stepY, cols, rows, zoom };
  }

  function gridCellCenter(grid, index) {
    const col = index % grid.cols, row = Math.floor(index / grid.cols);
    return { lon: grid.x0 + (col + 0.5) * grid.stepX, lat: latOfMercY(grid.y0 + (row + 0.5) * grid.stepY) };
  }

  function gridCellBox(grid, index) {
    const col = index % grid.cols, row = Math.floor(index / grid.cols);
    return [
      grid.x0 + col * grid.stepX, latOfMercY(grid.y0 + row * grid.stepY),
      grid.x0 + (col + 1) * grid.stepX, latOfMercY(grid.y0 + (row + 1) * grid.stepY),
    ];
  }

  // Which grid cell contains a given lon/lat (-1 if off-grid).
  function cellIndexOf(grid, lon, lat) {
    const col = Math.floor((lon - grid.x0) / grid.stepX);
    const row = Math.floor((mercY(lat) - grid.y0) / grid.stepY);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return -1;
    return row * grid.cols + col;
  }

  // Indices of every grid cell that overlaps the polygon — exact and fast. A
  // cell overlaps the region iff its center is inside the polygon (interior) or
  // the boundary passes through it (coast); the second set is found by walking
  // each boundary edge through the grid rather than sampling points along it.
  function relevantCells(grid, polygon) {
    const total = grid.cols * grid.rows;
    const inside = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const c = gridCellCenter(grid, i);
      if (pointInPolygon([c.lon, c.lat], polygon)) inside[i] = 1;
    }
    const mark = (i) => { inside[i] = 1; };
    for (const ring of polygon) markLineCells(grid, ring, mark);
    const out = [];
    for (let i = 0; i < total; i++) if (inside[i]) out.push(i);
    return out;
  }

  // Call mark(index) for every grid cell a [lon, lat] polyline passes through.
  // Long edges are split first: the grid walk follows a straight line in
  // Mercator, which drifts from the straight lon/lat edge over many cells.
  function markLineCells(grid, coords, mark) {
    for (let k = 0; k < coords.length - 1; k++) {
      const a = coords[k], b = coords[k + 1];
      const n = Math.max(1, Math.ceil(Math.max(
        Math.abs(b[0] - a[0]) / grid.stepX, Math.abs(mercY(b[1]) - mercY(a[1])) / grid.stepY) * 4));
      let prev = a;
      for (let t = 1; t <= n; t++) {
        const next = t === n ? b : [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n];
        markEdgeCells(grid, prev, next, mark);
        prev = next;
      }
    }
  }

  // Call mark(index) for every grid cell the straight edge a→b ([lon, lat])
  // passes through (a grid walk; both neighbours are marked at exact corners).
  function markEdgeCells(grid, a, b, mark) {
    const ax = (a[0] - grid.x0) / grid.stepX, ay = (mercY(a[1]) - grid.y0) / grid.stepY;
    const bx = (b[0] - grid.x0) / grid.stepX, by = (mercY(b[1]) - grid.y0) / grid.stepY;
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

  // Split a tile into quarters at `zoom` (same zoom when WME's box didn't cover
  // it; one zoom closer when an Issue Tracker response looked capped).
  function quarters(tile, zoom, coverDepth) {
    const [x1, y1, x2, y2] = [tile.rect[0], mercY(tile.rect[1]), tile.rect[2], mercY(tile.rect[3])];
    const xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
    return [[x1, y1, xm, ym], [xm, y1, x2, ym], [x1, ym, xm, y2], [xm, ym, x2, y2]].map(([l, b, r, t]) => ({
      rect: [l, latOfMercY(b), r, latOfMercY(t)],
      center: { lon: (l + r) / 2, lat: latOfMercY((b + t) / 2) },
      zoom,
      coverDepth,
    }));
  }

  function tileFor(grid, index) {
    return { center: gridCellCenter(grid, index), rect: gridCellBox(grid, index), zoom: grid.zoom, coverDepth: 0 };
  }

  // Load one tile exactly, then onLoaded(tile, result) while its data is in the
  // model. Splits the tile when WME's box doesn't cover it (the window shrank
  // since the grid was laid out), or when its result count reaches the level its
  // parent hit — the sign that a capped response is hiding the rest.
  // Resolves false if the run was stopped.
  async function visitTile(tracker, pass, tile, onLoaded) {
    const res = await tracker.visit(tile, pass.kind);
    if (!res) return false;
    let children = null;
    const where = () => `zoom ${tile.zoom} near ${tile.center.lat.toFixed(5)},${tile.center.lon.toFixed(5)}`;
    if (res.uncovered) {
      if (tile.coverDepth >= MAX_SPLIT_DEPTH) {
        throw new Error("The map window is too small for this scan grid. Enlarge the window or re-optimize. Scan stopped; baseline was not updated.");
      }
      children = quarters(tile, tile.zoom, tile.coverDepth + 1);
      children.forEach((child) => { child.splitFloor = tile.splitFloor; });
    } else {
      onLoaded(tile, res);
      const counts = res.counts || {};
      const floors = tile.splitFloor || [];
      const sums = (pass.splitGroups || []).map((group) => group.keys.reduce((n, k) => n + (Number(counts[k]) || 0), 0));
      if (sums.length && pass.recordTile) pass.recordTile(tile, sums);
      // A quarter that returns as much as the parent it came from is hiding the
      // same cap, so it splits again; anything smaller is complete.
      const suspect = sums.map((n, g) => n >= (floors[g] ?? ISSUE_SPLIT_AT));
      if (suspect.some(Boolean)) {
        if (tile.zoom < MAX_SPLIT_ZOOM) {
          children = quarters(tile, tile.zoom + 1, 0);
          const childFloors = sums.map((n, g) => (suspect[g] ? n : Infinity));
          children.forEach((child) => { child.splitFloor = childFloors; });
        } else {
          console.warn(`[WME Auto Scan] ${sums.join(" / ")} Issue Tracker results at ${where()}; some may be missing.`);
        }
      }
    }
    if (!children) return true;
    for (const child of children) {
      if (!await visitTile(tracker, pass, child, onLoaded)) return false;
    }
    return true;
  }

  // Credit every region cell a real (non-offroad) road passes through, from the
  // segments now in the data model. Crossings count, not just vertices, so a
  // long straight road marks every cell it runs through.
  function creditRoadCells(grid, cellSet, found) {
    let segs = [];
    try { segs = sdk.DataModel.Segments.getAll(); } catch (e) { return; }
    const mark = (i) => { if (cellSet.has(i)) found.add(i); };
    for (const s of segs) {
      if (OFFROAD_ROAD_TYPES.has(s.roadType)) continue;
      const coords = s.geometry && s.geometry.coordinates;
      if (!coords || !coords.length) continue;
      if (coords.length === 1) {
        const i = cellIndexOf(grid, coords[0][0], coords[0][1]);
        if (i >= 0) mark(i);
        continue;
      }
      markLineCells(grid, coords, mark);
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
      const mask = typeof raw === "string" ? JSON.parse(raw) : raw;
      return mask && mask.grid && mask.grid.version === 2 ? mask : null;
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

  // --- Request box size ----------------------------------------------------
  // WME's roads request covers more than the viewport (a server-configured
  // buffer, 1.7× per side by default). A pass measures the real box once; the
  // ratio to the viewport is remembered so previews can estimate the grid
  // without moving the map.
  function loadBoxRatios() {
    try {
      const raw = GM_getValue(BOX_RATIO_KEY, null);
      return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
    } catch (e) { return {}; }
  }

  function rememberBoxRatio(kind, box) {
    try {
      const view = mercSpan(sdk.Map.getMapExtent());
      const req = mercSpan(box);
      const ratio = Math.min(req.w / view.w, req.h / view.h);
      if (!(ratio > 0)) return;
      GM_setValue(BOX_RATIO_KEY, JSON.stringify({ ...loadBoxRatios(), [kind]: ratio }));
    } catch (e) {}
  }

  // Box WME loads per visit at `zoom`, estimated from the current view.
  function estimatedSpan(kind, zoom) {
    const view = mercSpan(sdk.Map.getMapExtent());
    const scale = Math.pow(2, sdk.Map.getZoomLevel() - zoom) * (loadBoxRatios()[kind] || 1);
    return { w: view.w * scale, h: view.h * scale };
  }

  // Lay out a pass's grid from one visit at the region's center at `zoom`.
  async function measureGrid(tracker, kind, zoom, polygon) {
    const res = await tracker.visit({ center: centroidOfBbox(bboxOfRing(polygon[0])), zoom, rect: null }, kind);
    if (!res) return null;
    rememberBoxRatio(kind, res.box);
    return computeGrid(polygon, mercSpan(res.box), zoom);
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

    let tracker = null;
    try {
      tracker = createLoadTracker(() => optimizeState.cancel);
      showOnlyLayers(["roads", "paths"]);

      // Resume an in-progress mask on its own grid (visits verify coverage, so a
      // different window size is fine), else measure a fresh grid.
      let mask = loadMask(region);
      const found = new Set();
      let grid, cells, startAt;
      if (mask && !mask.complete && Array.isArray(mask.cells) && mask.grid.zoom === ROADS_ZOOM) {
        grid = mask.grid;
        cells = mask.cells;
        startAt = mask.nextIndex || 0;
        (mask.productive || []).forEach((i) => found.add(i));
      } else {
        grid = await measureGrid(tracker, "features", ROADS_ZOOM, polygon);
        if (!grid) { setStatus("Optimization stopped."); return; }
        cells = relevantCells(grid, polygon);
        startAt = 0;
        mask = { version: 2, grid, cells, productive: [], total: cells.length, nextIndex: 0, complete: false, builtAt: null };
        saveMask(region, mask);
      }
      const cellSet = new Set(cells);
      optimizeState.total = cells.length;
      optimizeState.done = startAt;
      const productiveCount = () => { let n = 0; for (const i of found) if (cellSet.has(i)) n++; return n; };
      const persist = () => { mask.productive = cells.filter((i) => found.has(i)); saveMask(region, mask); };
      const pass = { kind: "features" };
      const credit = () => creditRoadCells(grid, cellSet, found);

      let finished = true;
      for (let i = startAt; i < cells.length; i++) {
        const idx = cells[i];
        // A cell a neighbour's response already showed a road in needs no visit;
        // only a cell that might be empty has to be loaded to prove it.
        if (!found.has(idx) && !await visitTile(tracker, pass, tileFor(grid, idx), credit)) { finished = false; break; }
        mask.nextIndex = i + 1;
        optimizeState.done = i + 1;
        if (i % OPTIMIZE_SAVE_EVERY === 0 || i === cells.length - 1) {
          optimizeState.productive = productiveCount();
          persist();
        }
      }

      persist();
      if (finished && !optimizeState.cancel) {
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
      if (tracker) tracker.disconnect();
      restoreLayers();
      try { sdk.Map.setMapCenter({ lonLat: originalCenter, zoomLevel: originalZoom }); } catch (e) {}
      optimizeState.running = false;
      refreshUI();
    }
  }

  function stopOptimize() {
    optimizeState.cancel = true;
  }

  // --- Scan passes ---------------------------------------------------------
  // Detector groups read different WME requests, so each group gets its own
  // pass at the zoom where its data loads, with only its layers shown:
  //   roads  — closures + user edits, from the roads request at ROADS_ZOOM,
  //            over the optimized cells when a mask exists.
  //   issues — Update Requests + Map Suggestions, from the Issue Tracker search
  //            WME makes from ISSUES_ZOOM up (64× the area per tile of zoom 15).
  //            Never masked: "missing road" reports sit where there is no road.
  function scanPasses(detectors) {
    const has = (key) => detectors.some((d) => d.key === key);
    const passes = [];
    const roads = detectors.filter((d) => d.key === "closure" || d.key === "edit");
    if (roads.length) {
      const layers = ["roads", "paths"];
      if (has("closure")) layers.push("closures");
      if (has("edit") && !settings.global.skipPlaces) layers.push("places");
      passes.push({ label: "roads", kind: "features", zoom: ROADS_ZOOM, detectors: roads, layers, useMask: true, splitGroups: null });
    }
    const issues = detectors.filter((d) => d.key === "report" || d.key === "suggestion");
    if (issues.length) {
      const layers = [], splitGroups = [];
      if (has("report")) {
        layers.push("updateRequests");
        splitGroups.push({ label: "Update Request", keys: ["mapUpdateRequestsCount"], ids: () => sdk.DataModel.MapUpdateRequests.getAll().map((r) => String(r.id)) });
      }
      if (has("suggestion")) {
        layers.push("editSuggestions");
        splitGroups.push({ label: "Map Suggestion", keys: ["editProposalsCount", "segmentSuggestionsCount"], ids: () => sdk.DataModel.EditSuggestions.getAll().map((x) => String(x.id)) });
      }
      passes.push({ label: "issues", kind: "issues", zoom: ISSUES_ZOOM, detectors: issues, layers, useMask: false, splitGroups });
    }
    return passes;
  }

  // Groups WME searches on every tile but nothing here reads: the SDK can't turn
  // them off (only their marker layers, which doesn't stop the search), so say so.
  function noteSpareIssueGroups(request) {
    if (!request.spareGroups || !request.spareGroups.length) return;
    const msg = `${request.spareGroups.join(" and ")} are on in WME's Issue Tracker filters. Turning them off there makes scans noticeably faster — nothing here reads them.`;
    console.warn("[WME Auto Scan] " + msg);
    setStatus(msg);
  }

  // Issue Tracker groups the editor's filters exclude are never requested, so
  // those detectors are skipped for this run instead of recording an empty
  // baseline (which would later report every existing item as new).
  function hiddenIssueDetectors(pass, request) {
    const hidden = [];
    for (const [key, present, label] of [
      ["report", request.hasUpdateRequests, "Update Requests"],
      ["suggestion", request.hasSuggestions, "Map Suggestions"],
    ]) {
      if (present || !pass.detectors.some((d) => d.key === key)) continue;
      hidden.push(key);
      const msg = `${label} are turned off in WME's Issue Tracker filters, so this scan skipped them.`;
      console.warn("[WME Auto Scan] " + msg);
      setStatus(msg);
    }
    return hidden;
  }

  // Run one pass over its cells. Resolves false if the scan was stopped.
  async function scanPass(pass, tracker, skipped) {
    const polygon = scanState.polygon;
    scanState.passLabel = pass.label;
    showOnlyLayers(pass.layers);
    const active = () => pass.detectors.filter((d) => !skipped.has(d.key));
    const skipPass = (message) => {
      pass.detectors.forEach((d) => skipped.add(d.key));
      console.warn("[WME Auto Scan] " + message);
      setStatus(message);
      return true;
    };

    let grid, cells;
    const mask = pass.useMask ? loadMask(settings.region) : null;
    try {
      if (mask && mask.complete && Array.isArray(mask.productive) && mask.grid.zoom === pass.zoom) {
        grid = mask.grid;
        cells = mask.productive;
      } else {
        grid = await measureGrid(tracker, pass.kind, pass.zoom, polygon);
        if (!grid) return false;
        cells = relevantCells(grid, polygon);
      }
    } catch (e) {
      // No Issue Tracker search at all means its layer is off: skip, don't fail.
      if (e.noLoad === "issues") return skipPass(e.message);
      throw e;
    }
    scanState.tilesTotal += cells.length;

    let checkedGroups = pass.kind !== "issues";
    const onLoaded = (tile, res) => {
      if (!checkedGroups) {
        checkedGroups = true;
        hiddenIssueDetectors(pass, res.request).forEach((key) => skipped.add(key));
        noteSpareIssueGroups(res.request);
      }
      for (const det of active()) det.collect();
    };
    // Every visited tile's result counts and the ids it returned, so a capped
    // response can be recognised afterwards.
    const seenTiles = [];
    pass.recordTile = (tile, sums) => {
      const ids = (pass.splitGroups || []).map((group) => {
        try { return new Set(group.ids()); } catch (e) { return new Set(); }
      });
      seenTiles.push({ tile, sums, ids });
    };

    const splitTile = async (entry, g) => {
      for (const child of quarters(entry.tile, entry.tile.zoom + 1, 0)) {
        child.splitFloor = entry.sums.map((n, i) => (i === g ? n : Infinity));
        if (!await visitTile(tracker, pass, child, onLoaded)) return false;
      }
      return true;
    };

    // If the server capped any response in this pass, the cap is the largest
    // count in it — so splitting the busiest tile settles the question for every
    // tile. If its quarters return something the tile itself didn't, that count
    // is the cap and every tile that reached it is re-checked; if they return
    // nothing new, nothing in the pass was truncated.
    const probeForCap = async () => {
      const groups = pass.splitGroups || [];
      for (let g = 0; g < groups.length; g++) {
        let busiest = null;
        for (const t of seenTiles) {
          if (t.sums[g] < ISSUE_PROBE_MIN || t.tile.zoom >= MAX_SPLIT_ZOOM) continue;
          if (!busiest || t.sums[g] > busiest.sums[g]) busiest = t;
        }
        if (!busiest) continue;
        const cap = busiest.sums[g];
        const from = seenTiles.length;
        if (!await splitTile(busiest, g)) return false;
        const hidden = seenTiles.slice(from).some((t) => [...t.ids[g]].some((id) => !busiest.ids[g].has(id)));
        if (!hidden) continue;
        const capped = seenTiles.slice(0, from).filter((t) => t !== busiest && t.sums[g] >= cap && t.tile.zoom < MAX_SPLIT_ZOOM);
        console.warn(`[WME Auto Scan] WME capped ${groups[g].label} responses at ${cap} per area; re-checking ${capped.length} more area(s).`);
        for (const t of capped) if (!await splitTile(t, g)) return false;
      }
      return true;
    };

    for (const idx of cells) {
      if (!active().length) break;
      if (!await visitTile(tracker, pass, tileFor(grid, idx), onLoaded)) return false;
      scanState.tilesDone++;
    }
    return await probeForCap();
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
    scanState.tilesDone = 0;
    scanState.tilesTotal = 0;

    // Remember the editor's view so we can restore it afterwards.
    const originalCenter = sdk.Map.getMapCenter();
    const originalZoom = sdk.Map.getZoomLevel();

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

    // Warn if the editor's Issue Tracker filters would starve a detector.
    for (const [key, fn] of [["report", updateRequestsFilterWarning], ["suggestion", mapSuggestionsFilterWarning]]) {
      if (!settings.detectors[key].enabled) continue;
      const warn = fn();
      if (warn) { console.warn("[WME Auto Scan] " + warn); setStatus(warn); }
    }

    let tracker = null;
    try {
      tracker = createLoadTracker(() => !scanState.running);
      const skipped = new Set(); // detectors this run couldn't scan
      for (const pass of scanPasses(detectors)) {
        // A partial scan must not turn later discoveries into new alerts.
        if (!await scanPass(pass, tracker, skipped)) return;
      }
      if (!scanState.running) return;
      tracker.disconnect();
      tracker = null;
      scanState.passLabel = "";
      restoreLayers();

      // Finalize: build and send this run's notifications.
      for (const det of detectors) {
        if (skipped.has(det.key)) continue;
        try { await det.finalize(); } catch (e) {
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
      console.error("[WME Auto Scan] scan failed", e);
      setStatus("Scan failed: " + e.message);
    } finally {
      if (tracker) tracker.disconnect();
      restoreLayers();
      scanState.passLabel = "";
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
      const remaining = estimateRemaining("optimize", elapsed, optimizeState.done, optimizeState.total);
      const rem = remaining != null ? ` (${fmtDuration(remaining)} left)` : "";
      const roads = optimizeState.total ? ` · ${optimizeState.productive} with roads` : "";
      return `Optimizing… ${fmtDuration(elapsed)}${rem}${roads}`;
    }
    if (scanState.running) {
      const elapsed = Date.now() - (scanState.startTime || Date.now());
      const remaining = estimateRemaining("scan", elapsed, scanState.tilesDone, scanState.tilesTotal);
      const rem = remaining != null ? ` (${fmtDuration(remaining)} left)` : "";
      return `Scanning${scanState.passLabel ? " " + scanState.passLabel : ""}… ${fmtDuration(elapsed)}${rem}`;
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

      // Issue-Tracker-gated detectors (Update Requests, Map Suggestions) only see
      // whatever WME's filter/group state currently exposes, which the script can
      // read but not change — warn so a limited scan isn't a silent surprise.
      if (FILTER_GATED_DETECTORS.has(key) && d.enabled) {
        sec.appendChild(el("div", { class: "was-muted", text: "⚠ Scan can only see your current filters, it's recommended to remove all filters.", style: "margin:2px 0 6px 24px; color:#e67e22" }));
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
        title: "Map which tiles contain roads so scans skip empty areas and finish faster",
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
        const clearBtn = el("button", { class: "was-btn secondary", title: "Discard the saved optimization for this region", text: "Clear", onclick: () => { clearMask(settings.region); refreshUI(); } });
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
    edit: { name: "User edits", phase1: true },
    report: { name: "Update Requests", phase1: true },
    suggestion: { name: "Map Suggestions", phase1: true },
  };

  // Detectors whose data WME only loads through the Issue Tracker, so a scan
  // sees only what the editor's current filters expose.
  const FILTER_GATED_DETECTORS = new Set(["report", "suggestion"]);

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  let settings = defaultSettings();

  function bootstrap() {
    sdk = PAGE.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
    settings = loadSettings();

    // A tab closed mid-scan leaves the scan's layer choices behind; put the
    // editor's own layers back.
    restoreLayers();

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
      for (const rt of sdk.DataModel.Segments.getRoadTypes()) roadTypeNames[rt.id] = rt.localizedName || rt.name;
    } catch (e) {}

    // Identify the current user and, on first load, whitelist them by default
    // (removable — we only seed once, tracked by whitelistSeeded).
    let selfUserName = null;
    try {
      const info = sdk.State.getUserInfo();
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
