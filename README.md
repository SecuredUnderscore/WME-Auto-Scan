# WME Auto Scan (Beta)

Have you ever entered the map editor without a plan? Blindly panning around the map to find issues to solve. Sometimes realizing your 10 hours late to a road closure. No more! Get a notification when something actionable happens. Road Closure report, new Update Request, and more.

This 
**[Install on Greasy Fork](https://greasyfork.org/en/scripts/595728-wme-auto-scan)** · **[Source & issues on GitHub](https://github.com/SecuredUnderscore/WME-Auto-Scan)**

---

## Features

- **Independent Detectors** — Toggle and configure each scan type:
  - **Road closures**
  - **User edits** — Edits by other editors.
  - **Update Requests (URs)**
  - **Place Update Requests (PURs)**
  - **Map Suggestions**
- **Region Selection** — Choose an area from your **managed areas**, **search for a place** (city, county, country via OpenStreetMap), or **draw a polygon**.
- **Editor Whitelist** — Ignore events from specific editors.

---

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from **[Greasy Fork](https://greasyfork.org/en/scripts/595728-wme-auto-scan)**.

Notification options:
- **Discord:** Webhook URL (*Channel Settings → Integrations → Webhooks*).
- **Pushover:** Application **API Token** and **User/Group Key** from [pushover.net](https://pushover.net/).

---

## User Guide

Open the **Auto Scan** tab in the sidebar

### 1. Configuration (Settings Tab)

#### Region
1. Under **Choose New Region**, select an option:
   - **Managed area** — Select one of your editable areas.
   - **Search for a place** — Search a location and select a result.
   - **Draw on map** — Click **Draw area on map** and outline a polygon.
2. Click **Save**. Click 👁 to view the region outline on the map.
3. Below the region, **Requests per scan** shows how many requests each scan makes. Click its 👁 to draw them on the map.

#### General Settings
- **Show status bar on map** — While running, a bar at the top of the map shows the current step (Scanning, Sending notifications, Cooldown), a timer, progress, and a Stop button. On by default.
- **Scan interval** — Set the delay between scans in minutes.
- **Discord** — Enter your webhook URL. Click ▾ to set per-detector configuration.
- **Pushover** — Enter your User Key, API Token, and alert sound.
- **Whitelist** — Add usernames to ignore. Click **Find editors in view** to populate names from the current map view.

### 2. Scanning (Run Tab)

1. Enable your desired detectors (**Road closures**, **User edits**, **Update Requests**, **Map Suggestions**, **Place Update Requests**). User edits includes edits to places unless you untick **Include places** (faster scans). Map Suggestions includes new-road suggestions unless you untick **Include new-road suggestions**.
2. Click **Run** to start scanning.
3. Click **Stop** at any time to stop.

## License

[MIT](https://github.com/SecuredUnderscore/WME-Auto-Scan/blob/main/LICENSE)
