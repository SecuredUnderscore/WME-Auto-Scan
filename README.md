# WME Auto Scan

A customizable, passive background scanner for the [Waze Map Editor](https://www.waze.com/editor). Select an area, click **Run**, and the script monitors it on a timer—sending **Discord** and/or **Pushover** notifications whenever it detects new road closures, user edits, Update Requests (URs), or Map Suggestions.

WME Auto Scan runs directly in your browser via the official WME SDK: no proprietary APIs, no external server dependencies, and every setting is fully configurable.

**[Install on Greasy Fork](https://greasyfork.org/)** · **[Source & issues on GitHub](https://github.com/SecuredUnderscore/WME-Auto-Scan)**

> _Greasy Fork link is a placeholder until the first published version — update it once the script is live._

---

## Features

- **Independent Detectors** — Toggle and configure each scan type separately:
  - **Road closures** — New segment closures in your area.
  - **User edits** — Edits by other editors, with a configurable per-user cooldown to prevent notification spam.
  - **Update Requests (URs)** — New driver-submitted reports.
  - **Map Suggestions** — Automated map changes suggested by Waze.
- **Flexible Region Selection** — Choose an area from your **managed areas**, **search for a place** (city, county, country via OpenStreetMap), or **draw a polygon** directly on the map.
- **Tile Mask Optimization** — Perform a one-time scan to map road-bearing tiles. Subsequent scans skip water and empty land, speeding up cycles without missing closures.
- **Granular Notifications** — Rich embeds for **Discord** and custom sounds for **Pushover**. Use global channels or configure per-detector overrides.
- **Editor Whitelist** — Ignore events from specific editors (your own account is whitelisted automatically). Add names manually or use **Find editors in view**.
- **Map Overlays & Previews** — Click 👁 to outline your saved region or preview the exact tiles scheduled for scanning.
- **Direct Permalinks** — Every alert includes a permalink centered on the triggering feature.
- **Private & Local** — Configuration is saved in local storage. Network requests are limited to WME, your chosen notification endpoints, and OpenStreetMap (for place search).

---

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from **[Greasy Fork](https://greasyfork.org/)**.
3. Open the [Waze Map Editor](https://www.waze.com/editor). The **Auto Scan** tab will appear in the left sidebar.

*(Optional)* Notification requirements:
- **Discord:** Webhook URL (*Channel Settings → Integrations → Webhooks*).
- **Pushover:** Application **API Token** and **User/Group Key** from [pushover.net](https://pushover.net/).

---

## User Guide

Open the **Auto Scan** tab in the sidebar to access **Settings** and **Run** modes.

### 1. Configuration (Settings Tab)

#### Region
1. Under **Choose New Region**, select an option:
   - **Managed area** — Select one of your assigned Waze areas.
   - **Search for a place** — Search a location and select a result.
   - **Draw on map** — Click **Draw area on map** and outline a polygon.
2. Click **Save**. Click 👁 to view the region outline on the map.

#### Optimization (Recommended)
- Click **Optimize** to map and save active road tiles.
- Optimization is resumable if interrupted and prompts for a refresh after 30 days.
- Click 👁 next to Optimize to preview scanned tiles.

#### General Settings
- **Scan interval** — Set the delay between scans in minutes (also displays the duration of the last scan).
- **Discord** — Enter your webhook URL. Click ▾ to expand per-detector overrides.
- **Pushover** — Enter your User Key, API Token, and alert sound (supports per-detector overrides).
- **Whitelist** — Add usernames to ignore. Click **Find editors in view** to quickly populate names from the current map view.

### 2. Scanning (Run Tab)

1. Enable your desired detectors (**Road closures**, **User edits**, **Update Requests**, **Map Suggestions**) and set cooldowns if needed.
2. Click **Run** to start scanning. The status bar shows live progress and a countdown to the next cycle.
3. Click **Stop** at any time to halt the loop.

> ⚠️ **Update Requests & Map Suggestions:** These are read through WME's Issue Tracker, so a scan only sees what your **current map filters** allow. For complete results, clear all filters before scanning.

---

## Notes & Technical Details

- **Zoom Level:** Scanning runs at zoom level 15. The script checks layers loaded by WME and will not force-load unrendered layers.
- **Place Search:** Location search uses OpenStreetMap Nominatim. Boundary polygons are simplified on import to keep scan times fast.
- **Network:** External requests (Discord, Pushover, Nominatim) are handled via `GM_xmlhttpRequest`.

---

## Contributing & Feedback

Bug reports, feature requests, and pull requests are welcome on **[GitHub](https://github.com/SecuredUnderscore/WME-Auto-Scan/issues)**.

## License

[MIT](https://github.com/SecuredUnderscore/WME-Auto-Scan/blob/main/LICENSE) © SecuredUnderscore
