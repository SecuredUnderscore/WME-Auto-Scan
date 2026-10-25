# WME Auto Scan (Beta)

A customizable passive scanner for the Waze Map Editor. It scans the regions you choose on a schedule and sends a Discord or Pushover alert for new road closures, user edits, Update Requests, Place Update Requests and Map Suggestions. Built to be ran 24/7.

**[Install on Greasy Fork](https://greasyfork.org/en/scripts/595728-wme-auto-scan)** · **[Source & issues on GitHub](https://github.com/SecuredUnderscore/WME-Auto-Scan)**

---

## Features

- **Independent Detectors** — Toggle and configure each scan type:
  - **Road closures**
  - **User edits** — Edits by other editors.
  - **Update Requests (URs)**
  - **Place Update Requests (PURs)**
  - **Map Suggestions**
- **Region Selection** — Choose an area from your **managed areas**, **search for a place** (city, county, country via OpenStreetMap), **draw a polygon**, or paste a **WKT polygon**.
- **Multiple Regions** — Scan several areas, each with its own settings and notifications.
- **User Filters** — Per region, pick a whitelist (ignore the listed editors) or a blacklist (report only the listed editors), using the global lists, the region's own lists, or both. Applies to road closures, user edits, map suggestions and place update requests.

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

### 1. Regions (Regions Tab)

#### Regions
- Use the **Regions** dropdown at the top to switch between regions, **Add** a new one, **Duplicate** one, or **Delete** one (click **Confirm** to delete).
- Each region has its own name, area, interval, notifications and filtering. The Settings tab holds what every region shares.

#### Region
1. Under **Choose New Region**, select an option:
   - **Managed area** — Select one of your editable areas.
   - **Search for a place** — Search a location and select a result.
   - **Draw on map** — Click **Draw area on map** and outline a polygon.
   - **WKT Format** — Click **Open map.wazedev.com** to draw an area, paste its WKT polygon, then click **Use WKT**.
2. Click **Save**. Click 👁 to view the region outline on the map.
3. Below the region, **Requests per scan** shows how many requests each scan makes. Click its 👁 to draw them on the map.

#### Region Settings
- Shows how long the last scan of this region took.
- **Discord** — Enter your webhook URL. Click ▾ to set per-detector configuration.
- **Pushover** — Enter your User Key, API Token, and alert sound.

#### Filtering
- **User filter** — How this region filters by editor:
  - **Global Whitelist** (default) — Ignore the editors on the Global Whitelist (Settings tab).
  - **Region + Global Whitelist** — Ignore the editors on this region's whitelist and the Global Whitelist.
  - **Region Whitelist** — Ignore only the editors on this region's whitelist.
  - **Global Blacklist** — Report only the editors on the Global Blacklist (Settings tab).
  - **Region + Global Blacklist** — Report only the editors on this region's blacklist or the Global Blacklist.
  - **Region Blacklist** — Report only the editors on this region's blacklist.
- A **Region Whitelist** / **Region Blacklist** list appears below when the filter uses one, and **Edit Global …** jumps to the matching global list.
- The filter applies to road closures, user edits, map suggestions and place update requests. Update Requests and new-road suggestions carry no editor and are always reported. On a blacklist filter, an event whose editor could not be resolved is not reported.

### 2. Settings (Settings Tab)

- **Show status bar on map** — While running, a bar at the top of the map shows the current step (Scanning, Sending notifications, Cooldown), a timer, progress, and a Stop button. On by default.
- **Include Region Name In Alerts** — Start every alert's title with the region's name in brackets, e.g. "[Downtown] Road closure". On by default.
- **Scan interval** — Minutes between scans of a region. Applies to every region.
- **Ignore items older than × (scan time + interval)** — An item created earlier than this many times (scan time + scan interval) before now was already there during the previous scan, so it is skipped instead of alerted as new, even if the server left it out of that scan. Default 2; set 0 to turn off.
- **Global Whitelist** / **Global Blacklist** — The shared editor lists. Click into the box to list the editors in the current map view and click one to add it, or type a username and press Enter.
- **Save / load settings** — Download every setting as a JSON file, or replace them all from one.

### 3. Scanning (Run Tab)

1. Enable your desired detectors (**Road closures**, **User edits**, **Update Requests**, **Map Suggestions**, **Place Update Requests**). User edits includes edits to places unless you untick **Include places** (faster scans). Map Suggestions includes new-road suggestions unless you untick **Include new-road suggestions**.
2. Click **Run** to start scanning. Every region is scanned, one at a time, on the shared scan interval.
3. Click **Stop** at any time to stop.

## License

[MIT](https://github.com/SecuredUnderscore/WME-Auto-Scan/blob/main/LICENSE)
