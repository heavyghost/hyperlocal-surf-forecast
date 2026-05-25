# Midds Reef — Technical Design Document

> A hyperlocal surf forecast dashboard for Middleton Beach Reef, Albany WA.  
> Single-page web app — no framework, no build step, no server-side rendering.

---

## What This Document Covers

This document explains how the Midds Reef surf forecast dashboard works under the hood. It's written for someone comfortable with IT concepts but not necessarily experienced in frontend web development. You'll learn what languages the site uses, how it fetches data, how it scores surf conditions, and how the whole thing gets deployed — without needing prior knowledge of JavaScript frameworks or API design.

---

## Architecture at a Glance

The entire dashboard is a **single HTML file** (`index.html`) that runs in the browser. There is no backend application server — the browser fetches data directly from public APIs, processes it with JavaScript, and renders everything on screen. The only server-side component is a small proxy function that runs on Netlify's edge network to work around a cross-origin restriction on buoy data.

```
┌──────────────────────────────────────────────────┐
│                  User's Browser                  │
│                                                  │
│  index.html                                      │
│  ├── <style> block ............... all CSS       │
│  ├── <script> block #1 .......... break config   │
│  └── <script> block #2 .......... app logic      │
│       ├── fetch() → Open-Meteo Marine API        │
│       ├── fetch() → Open-Meteo Weather API       │
│       ├── fetch() → Netlify Edge Proxy → AODN    │
│       └── <img> tags → WeatherZone chart images  │
└──────────────────────────────────────────────────┘
```

There is no React, no Vue, no Angular, no Next.js, no npm, no Webpack, no TypeScript. It's vanilla HTML, CSS, and JavaScript — the same technologies that powered the web in 1999, just written with modern syntax.

---

## Languages and Technologies

### HTML5

The structural markup of the page. Everything — the header, the forecast tables, the settings panel, the synoptic chart viewer — is defined in a single `index.html` file. Some of the HTML is static (written directly in the file), and some is generated dynamically by JavaScript and injected into the page using `innerHTML`.

### CSS3

All styling lives inside a single `<style>` block in the `<head>` of `index.html`. There's no external stylesheet and no CSS preprocessor (like SASS or LESS). Key techniques used include CSS custom properties (variables) for theming, CSS Grid and Flexbox for layout, media queries for mobile responsiveness, and CSS transitions for hover and interaction effects.

**CSS custom properties** are defined in the `:root` selector at the top of the style block. These act as a centralised colour palette — for example, `--firing: #00e5ff` defines the cyan colour used whenever conditions are rated "FIRING". Changing a variable in one place updates every element that references it.

**Design system:** The dashboard uses a dark navy/teal aesthetic with neon accent colours for ratings. Two Google Fonts are loaded from a CDN — JetBrains Mono (a monospace font used for data values) and Barlow Condensed (a condensed sans-serif used for headings and rating labels).

### JavaScript (ES2017+)

All application logic lives in a second `<script>` block at the bottom of `index.html`. It uses modern JavaScript features including `async`/`await` for API calls, arrow functions, template literals for HTML generation, destructuring, and `Promise.all` for parallel data fetching. No JavaScript framework or library is used — every function is hand-written.

### Deno (server-side, edge function only)

The buoy data proxy (`buoy-proxy.js`) runs as a Netlify Edge Function, which executes in Deno — a JavaScript/TypeScript runtime similar to Node.js but with a different security model. You don't need to install or manage Deno yourself; Netlify handles this automatically when you deploy. The proxy is a single file, about 80 lines, with no external dependencies.

---

## Data Sources and API Calls

The dashboard makes four separate network requests on page load. Three are to public APIs, and one loads images directly. Here's exactly what each one does.

### 1. Open-Meteo Marine API — Swell, Waves, and Sea Temperature

**What it is:** Open-Meteo is a free, open-source weather API. No API key or account is required. The marine endpoint provides ocean-specific forecast data.

**Endpoint:**
```
https://marine-api.open-meteo.com/v1/marine
  ?latitude=-35.0275
  &longitude=117.8814
  &hourly=wave_height,wave_direction,wave_period,
          swell_wave_height,swell_wave_direction,swell_wave_period,
          wind_wave_height,wind_wave_period,sea_surface_temperature
  &timezone=auto
  &forecast_days=7
```

**What comes back:** A JSON object containing hourly arrays for each requested variable. Each array has 168 entries (7 days × 24 hours). For example, `swell_wave_height` might return `[1.2, 1.3, 1.4, ...]` — one value per hour for the next week.

**Underlying model:** Open-Meteo aggregates data from several numerical weather prediction (NWP) models. For marine data at this location, the primary models are NOAA's GFS Wave model and Météo-France's MFWAM (Météo-France Wave Model). These are physics-based simulations that model how wind energy transfers into ocean waves across the globe. The API selects the best-available model for the requested location automatically.

**Key variables explained:**

| Variable | What It Means |
|----------|---------------|
| `swell_wave_height` | Height of the swell component (in metres). Swell is long-period wave energy generated by distant storms — this is what surfers care about most. |
| `swell_wave_period` | Time between swell wave crests (in seconds). Longer period = more powerful, better-organised waves. Anything above 10 seconds is typically groundswell. |
| `swell_wave_direction` | Compass bearing the swell is coming FROM (0°=N, 90°=E, 180°=S, 270°=W). |
| `wave_height` | Total wave height including both swell and locally wind-generated chop. |
| `wind_wave_height` | The wind-sea component only — short-period chop generated by local wind. |
| `sea_surface_temperature` | Water temperature at the surface (°C). Displayed for wetsuit planning. |

### 2. Open-Meteo Weather API — Wind, Rain, Sun Times

**What it is:** The same Open-Meteo service, but the standard weather endpoint rather than the marine one.

**Endpoint:**
```
https://api.open-meteo.com/v1/forecast
  ?latitude=-35.0275
  &longitude=117.8814
  &hourly=windspeed_10m,winddirection_10m,windgusts_10m,
          precipitation,cloudcover,temperature_2m
  &daily=sunrise,sunset
  &timezone=auto
  &forecast_days=7
```

**What comes back:** Hourly wind speed (in metres per second — the code converts to knots by multiplying by 1.94384), wind direction, gust speed, rain, cloud cover, and air temperature. The `daily` section includes sunrise and sunset times for each of the seven days.

**Why it's a separate call:** Wind data comes from atmospheric models (GFS, ECMWF), not ocean wave models. Open-Meteo serves them from different endpoints. The dashboard merges the two datasets by matching timestamps.

### 3. Open-Meteo Marine API — Tide Data (Separate, Failure-Tolerant)

**What it is:** A third call to the marine API, but requesting a different variable and explicitly selecting a specific model.

**Endpoint:**
```
https://marine-api.open-meteo.com/v1/marine
  ?latitude=-35.0275
  &longitude=117.8814
  &hourly=sea_level_height_msl
  &models=meteofrance_currents
  &timezone=auto
  &forecast_days=7
```

**Why it's separate:** Tide data requires the Météo-France currents model specifically (set via `&models=meteofrance_currents`). If this model is unavailable or the variable name changes (which has happened — see Known Issues below), the failure is caught gracefully and the rest of the forecast still renders. The tide column simply shows "—" instead of crashing the entire page.

**Accuracy caveat:** This is a global ocean model, not a local tide gauge. The heights are indicative — useful for knowing whether the tide is rising or falling, but not precise enough for navigation.

### 4. AODN Buoy Data — Live Albany Waverider (via Netlify Edge Proxy)

**What it is:** Real-time wave observations from a physical buoy (WMO station 56011) moored approximately 50 km offshore of Albany in about 50 metres of water. The buoy is operated by the Western Australian Department of Transport and the data is served by Australia's Ocean Data Network (AODN).

**Why a proxy is needed:** The AODN server doesn't set CORS headers (Cross-Origin Resource Sharing). CORS is a browser security feature that prevents a web page from making requests to a different domain unless that domain explicitly allows it. Since AODN doesn't allow it, the browser blocks the request. The solution is a server-side proxy — the Netlify Edge Function fetches from AODN (server-to-server, no CORS restriction), then returns the data to the browser from the same domain as the dashboard.

**How the proxy works:**

1. The browser calls `/api/buoy` (same domain as the dashboard).
2. Netlify routes this to the `buoy-proxy.js` edge function.
3. The edge function calls AODN's GeoServer WFS endpoint:
   ```
   https://geoserver-123.aodn.org.au/geoserver/ows
     ?service=WFS&version=1.0.0&request=GetFeature
     &typeName=imos:wave_buoy_realtime_nonqc
     &outputFormat=application/json
     &CQL_FILTER=station_name+LIKE+'%Albany%'
     &maxFeatures=1&sortBy=time+D
   ```
4. AODN returns a GeoJSON feature collection. The edge function extracts the most recent observation, normalises the field names (AODN uses long CF-convention names like `sea_surface_wave_significant_height`), and returns clean JSON:
   ```json
   {
     "time": "2026-05-22T06:00:00Z",
     "hs": 2.14,
     "tp": 12.3,
     "dp": 215,
     "sst": 18.4,
     "lat": -35.12,
     "lon": 117.95,
     "depth": 50,
     "stationName": "Albany"
   }
   ```
5. The response is cached for 10 minutes (the buoy only updates every ~3 hours).

**Graceful degradation:** If the proxy fails, the buoy panel shows "Unavailable" and the rest of the dashboard works normally. This design pattern — letting non-critical features fail without breaking the whole page — is used throughout the codebase.

### 5. Synoptic Pressure Charts — WeatherZone Images

**What it is:** Synoptic (pressure) charts showing high/low pressure systems, fronts, and isobars across Australia. These are standard meteorological analysis and forecast charts.

**How they load:** These are plain `<img>` tags pointing to WeatherZone's image server. No API call or JavaScript fetch is involved — the browser loads them the same way it loads any image on any website.

**URL pattern:**
```
https://data.weatherzone.com.au/data/hourly/images/synoptic/wz_syn_aus_d{N}_640x480.jpg
```
Where `N` ranges from 0 (latest analysis) to 6 (6-day forecast).

**Why WeatherZone and not BOM:** Australia's Bureau of Meteorology (BOM) blocks requests that don't come from their own website (they check the `Referer` header and return 403 Forbidden). WeatherZone serves similar synoptic charts and allows direct image loading from any origin.

---

## The Scoring Algorithm

The dashboard scores each 3-hour time slot on a 0–100 point scale across four categories. This is the core logic that turns raw numbers into human-readable surf ratings.

### Point Breakdown

| Category | Condition | Points |
|----------|-----------|--------|
| **Swell Direction** | Swell coming from within the break's exposure window (default: 160°–260°, roughly SSE to WSW) | +30 |
| **Swell Height** | Within the configured ideal range (default: 0.8–3.0 m) | +25 |
| **Swell Period** | At or above the minimum threshold (default: 10 seconds) | +25 |
| **Wind Quality** | Light wind + offshore direction | +20 |
| | Light wind + glassy (no clear onshore/offshore) | +15 |
| | Moderate offshore (< 20 knots) | +15 |
| | Light onshore (below threshold) | +8 |
| | Cross-shore | +8 |
| | Strong offshore (20+ knots) | +8 |
| | Onshore wind | +0 |

### Rating Labels

| Label | Score Required | Colour |
|-------|---------------|--------|
| FIRING | 85+ | Cyan (`#00e5ff`) |
| GOOD | 65–84 | Green (`#39ff14`) |
| OK | 40–64 | Yellow (`#ffd600`) |
| POOR | Below 40 | Red (`#ff1744`) |

### The Onshore Override Rule

Regardless of the total score, if the wind is blowing onshore (from the configured onshore direction range) at more than 10 knots, the rating is forced to **POOR**. This override exists because onshore wind destroys wave quality no matter how good the swell is — validated by the developer's direct observations at the break.

### How Direction Ranges Work

Compass bearings wrap around 360°. The `inRange()` function handles this: if the "from" value is less than the "to" value, it's a simple range check. If "from" is greater than "to" (e.g., 340° to 40° for a north-centred range), it checks whether the bearing is greater than "from" OR less than "to". This is a common pattern when working with circular data.

---

## Data Flow — From API to Screen

Here's what happens when you load the page:

1. **Load saved settings** — The app checks `localStorage` for a saved `middsBreakConfig` key. If found, it merges those values into the `BREAK_CONFIG` object. This is how settings persist between browser sessions.

2. **Build synoptic chart tabs** — The seven chart tabs (Latest through Day +6) are created and the first chart image is loaded.

3. **Fire off buoy fetch** — `fetchBuoyData()` is called but not awaited (fire-and-forget). The buoy panel updates independently of the main forecast.

4. **Fetch forecast data** — `fetchForecast()` runs three parallel API calls using `Promise.all` for the marine and weather data, then a separate try/catch for tides.

5. **Merge datasets** — `mergeData()` aligns the marine, weather, and tide data by timestamp into a single array of objects. Each object represents one hour and contains swell height, swell direction, wind speed, wind direction, tide height, SST, etc.

6. **Group by day** — `groupByDay()` splits the merged array into per-day groups keyed by date string (e.g., `"2026-05-22"`).

7. **Render hero card** — The top-of-page summary card shows today's peak rating, the best time window, current conditions, and sunrise/sunset. The card's border colour and glow effect change based on the rating.

8. **Render daily strip** — Horizontal scrollable cards showing each day's best rating and headline swell/wind.

9. **Render day sections** — For each day, the top 3 time slots (by rating) are shown as "slot pills", followed by a collapsible full forecast table showing every 3-hour slot.

10. **Cache data** — The raw API responses are stored in module-level variables (`_cachedMarine`, `_cachedWx`, `_cachedTideMap`). If you change settings and hit "Apply", the dashboard re-renders from cached data without making new API calls.

---

## Configuration and Settings

### The `BREAK_CONFIG` Object

This object near the top of `index.html` defines all the parameters that make the dashboard specific to Middleton Beach Reef. It controls which swell directions score points, what swell heights are considered ideal, which wind directions count as offshore vs. onshore, and the threshold for "light" wind.

### The Settings Panel

Clicking the ⚙ button opens a form that lets you adjust all configurable parameters without editing code. When you hit "Apply & Re-render":

1. The form values are validated (all must be valid numbers).
2. The `BREAK_CONFIG` object is updated in memory.
3. The config is serialised to JSON and saved to `localStorage`.
4. The dashboard re-renders from cached API data — no new fetch required.

### `localStorage` Persistence

`localStorage` is a browser API that stores key-value pairs that survive page refreshes and browser restarts. The dashboard uses the key `middsBreakConfig`. If you clear your browser data, these settings reset to defaults.

---

## File Structure

```
midds-reef/
├── index.html              ← The entire dashboard (HTML + CSS + JS in one file)
├── netlify.toml             ← Netlify deployment configuration
├── netlify/
│   └── edge-functions/
│       └── buoy-proxy.js   ← Server-side AODN proxy (runs on Deno at the edge)
├── manifest.json            ← Netlify edge function manifest (auto-generated)
├── claude.md                ← Project context file for AI-assisted development
└── readme.md                ← Project README
```

The single-file architecture is deliberate. It means you can open `index.html` in any browser and it works — no build step, no compilation, no package installation. The only feature that requires deployment is the live buoy panel (because it needs the server-side proxy).

---

## Deployment

The site is hosted on **Netlify**, a platform that serves static files and runs edge functions (serverless code that executes close to the user geographically).

### How to Deploy

```bash
# Install the Netlify CLI (one-time)
npm install -g netlify-cli

# Deploy everything including the edge function
netlify deploy --prod
```

The `netlify.toml` file tells Netlify two things: where the static files are (the project root), and that requests to `/api/buoy` should be routed to the `buoy-proxy` edge function.

### Why Not GitHub Auto-Deploy?

Netlify's free tier has limited build minutes. Automatic deploys from GitHub were consuming those minutes, so the project uses manual CLI deploys instead. You can also drag-and-drop the project folder into Netlify's web UI for static-only updates, but the edge function won't work that way — it requires the CLI deploy.

---

## Known Issues and Gotchas

### Open-Meteo Variable Names Can Change Without Notice

This has happened twice during the project's life:

1. The tide variable changed from `sea_level_height_above_mean` to `sea_level_height_msl`.
2. The tide model parameter changed from `meteofrance_ocean` to `meteofrance_currents`.

Both times, the tide column went blank without any error message — the API just returned empty data. The debugging approach that works is to visit the Open-Meteo API docs page, configure the same location and variables using the interactive UI, and compare the generated URL to what's in the code.

### BOM Blocks External Requests

Don't try to load chart images directly from the Bureau of Meteorology. Their servers check the `Referer` header and return 403 for anything that isn't their own website. WeatherZone serves equivalent synoptic charts without this restriction.

### Buoy Data Latency

The Albany Waverider buoy updates approximately every 3 hours. The "X minutes ago" timestamp in the buoy panel reflects this — it's normal to see "2h 45m ago". The edge function caches responses for 10 minutes to avoid hammering AODN's server.

---

## Mobile Considerations

The dashboard is designed mobile-first — it's primarily checked on a phone before heading to the beach. Key responsive behaviours include the daily strip scrolling horizontally, some table columns (swell direction, wind direction, SST, notes) being hidden on screens under 640px wide, the hero card stacking vertically on narrow screens, and touch targets being sized for finger tapping (minimum 44px).

The CSS uses two `@media` breakpoints: `max-width: 640px` for phones, and a refinement at `min-width: 390px` for larger phones. There's no tablet-specific breakpoint — the desktop layout works fine on tablets.

---

## Glossary

| Term | Meaning |
|------|---------|
| **Swell** | Long-period ocean waves generated by distant storms. Travels thousands of kilometres. |
| **Wind chop / wind sea** | Short-period waves generated by local wind. Messy and disorganised. |
| **Period** | Time in seconds between wave crests. Longer = more powerful. Above 10s is typically groundswell. |
| **Offshore wind** | Wind blowing from land out to sea. Cleans up wave faces — ideal for surfing. |
| **Onshore wind** | Wind blowing from sea onto land. Chops up wave faces — bad for surfing. |
| **Cross-shore wind** | Wind blowing parallel to the beach. Less damaging than onshore, but not ideal. |
| **Fetch** | The distance of open ocean over which wind blows consistently. Longer fetch = bigger swell. |
| **Isobars** | Lines of equal atmospheric pressure on a synoptic chart. Closer together = stronger wind. |
| **CORS** | Cross-Origin Resource Sharing. A browser security policy that controls which domains a web page can fetch data from. |
| **Edge function** | Server-side code that runs on Netlify's CDN nodes, geographically close to users. |
| **`localStorage`** | A browser API for storing small amounts of data (key-value pairs) that persists across sessions. |
| **GeoJSON** | A JSON format for encoding geographic data structures, used by AODN for buoy observations. |
| **WFS** | Web Feature Service. An OGC standard for requesting geographic features from a server. Used by AODN. |
| **NWP** | Numerical Weather Prediction. Physics-based computer simulations of the atmosphere and ocean. |