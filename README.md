# WME Auto Scan (Beta)

Have you ever entered the map editor without a plan? Blindly panning around the map to find issues to solve. Sometimes realizing your 10 hours late to a road closure. No more! Get a notification when something actionable happens. Road Closure report, new Update Request, and more.

WME Auto Scan reads map data straight from WME's own map service, using your logged-in session. It only ever reads (nothing is written to the map), and it never moves your map, so you can keep editing while it scans.

**[Install on Greasy Fork](https://greasyfork.org/en/scripts/595728-wme-auto-scan)** · **[Source & issues on GitHub](https://github.com/SecuredUnderscore/WME-Auto-Scan)**

---

## Features

- **Independent Detectors** — Toggle and configure each scan type:
  - **Road closures**
  - **User edits** — Edits by other editors.
  - **Update Requests (URs)**
  - **Map Suggestions**
- **Flexible Region Selection** — Choose an area from your **managed areas**, **search for a place** (city, county, country via OpenStreetMap), or **draw a polygon** directly on the map.
- **Fast, hands-off scanning** — Several areas are requested at once, sized to what the map service returns completely. Your map, layers and selection are left alone.
- **Editor Whitelist** — Ignore events from specific editors.

---

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from **[Greasy Fork](https://greasyfork.org/en/scripts/595728-wme-auto-scan)**.
3. Open the [Waze Map Editor](https://www.waze.com/editor). The **Auto Scan** tab will appear in the left sidebar.

Notification options:
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
3. Below the region, **Requests per scan** shows how many requests each scan makes. Click its 👁 to draw them on the map.

#### General Settings
- **Scan interval** — Set the delay between scans in minutes (also displays the duration of the last scan).
- **Don't scan places** — Skip loading places for much faster scans. Edits to places won't be reported.
- **Discord** — Enter your webhook URL. Click ▾ to expand per-detector overrides.
- **Pushover** — Enter your User Key, API Token, and alert sound (supports per-detector overrides).
- **Whitelist** — Add usernames to ignore. Click **Find editors in view** to quickly populate names from the current map view.

### 2. Scanning (Run Tab)

1. Enable your desired detectors (**Road closures**, **User edits**, **Update Requests**, **Map Suggestions**) and set cooldowns if needed. Map Suggestions includes new-road suggestions unless you untick **Include new-road suggestions**.
2. Click **Run** to start scanning. The status bar shows live progress and a countdown to the next cycle.
3. Click **Stop** at any time to halt the loop.

The first scan of a region records what already exists and sends nothing; later scans notify you about anything new. Update Requests and Map Suggestions cover everything open in the region, whatever your Issue Tracker filters are set to.

## License

[MIT](https://github.com/SecuredUnderscore/WME-Auto-Scan/blob/main/LICENSE)
