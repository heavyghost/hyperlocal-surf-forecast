# Midds Reef — Surf Forecast Dashboard

## Project overview

Single-page hyperlocal surf forecast for **Middleton Beach Reef (Midds)**, Albany WA (Kinjarling).
A self-contained HTML file with client-side API calls — no build step, no framework, no bundler.
Deployed on Netlify with an edge function proxying live buoy data from UWA S3.

The dashboard combines:
- **Synoptic pressure charts** from WeatherZone (auto-updating `<img>` tags)
- **7-day marine forecast** from Open-Meteo (swell, wind, tide, SST)
- **Live buoy observations** from the Midds Sofar Spotter (SPOT-31708C) via Netlify edge proxy
- **Configurable break parameters** with localStorage persistence
- **Scoring explainer** teaching users how ratings are calculated

## Tech stack

- Single `index.html` (vanilla JS, no framework, no build)
- Fonts: JetBrains Mono + Barlow Condensed (Google Fonts CDN)
- Open-Meteo Marine API + Weather API (free, no key)
- WeatherZone synoptic chart images (loaded as `<img>` tags, auto-update daily)
- Netlify Edge Functions (Deno-based) for S3 buoy proxy (AWS SigV4 via aws4fetch)
- `localStorage` for user settings persistence

## File structure

```
midds-reef/
├── index.html                    ← the entire dashboard (single file)
├── netlify.toml                  ← Netlify config + edge function routing
├── netlify/
│   └── edge-functions/
│       └── buoy-proxy.js        ← UWA S3 Sofar Spotter proxy (SigV4 via aws4fetch)
├── CLAUDE.md                     ← this file
└── README.md
```

## Break configuration

The `BREAK_CONFIG` object lives near the top of `index.html` inside its own `<script>` block.
It's the single source of truth for the spot's parameters. Current defaults:

```javascript
{
  name: "Midds Reef",
  location: "Albany, WA — Kinjarling",
  lat: -35.0275,
  lon: 117.8814,
  swellWindow:      { from: 160, to: 260 },  // SSE to W
  idealSwellHeight: { min: 0.8, max: 3 },     // metres
  idealSwellPeriod: { min: 10, max: 20 },      // seconds
  offshoreWind:     { from: 220, to: 340 },   // SW to NNW
  onshoreWind:      { from: 40,  to: 140 },   // NE to SE
  lightWindThreshold: 10,                      // knots
}
```

Users can override these via the ⚙ settings panel without editing code.
Changes persist in `localStorage` under key `middsBreakConfig`.

## Scoring algorithm

Each 3-hour slot scores 0–100 across four categories:

| Category        | Condition                              | Points |
|-----------------|----------------------------------------|--------|
| Swell Direction | Within exposure window                 | +30    |
| Swell Height    | Within ideal range                     | +25    |
| Swell Period    | At or above minimum                    | +25    |
| Wind Quality    | Light offshore                         | +20    |
|                 | Light glassy (no clear direction)      | +15    |
|                 | Moderate offshore (< 20kn)             | +15    |
|                 | Light onshore (below threshold)        | +8     |
|                 | Cross-shore                            | +8     |

Rating thresholds: **FIRING** ≥ 85 · **GOOD** ≥ 65 · **OK** ≥ 40 · **POOR** < 40

**Override rule:** Onshore wind exceeding 10 knots = automatic POOR regardless of score.
This was validated by Jack's observations driving past the beach.

## API details

### Open-Meteo Marine API
- Base: `https://marine-api.open-meteo.com/v1/marine`
- Hourly vars: `wave_height`, `wave_direction`, `wave_period`, `swell_wave_height`,
  `swell_wave_direction`, `swell_wave_period`, `wind_wave_height`, `wind_wave_period`,
  `sea_surface_temperature`
- Params: `timezone=auto&forecast_days=7`

### Open-Meteo Weather API
- Base: `https://api.open-meteo.com/v1/forecast`
- Hourly vars: `windspeed_10m`, `winddirection_10m`, `windgusts_10m`,
  `precipitation`, `cloudcover`, `temperature_2m`
- Daily vars: `sunrise`, `sunset`
- Wind speed returned in **m/s** — converted to knots (× 1.94384) for display

### Tides (separate fetch, failure-tolerant)
- Same marine API base, but with `&hourly=sea_level_height_msl&models=meteofrance_currents`
- Fetched separately so any failure doesn't crash the main forecast
- Displayed as a mini bar + trend arrow (↑ rising, ↓ falling, ▲ high, ▼ low)
- **Accuracy caveat:** indicative only, not for navigation

### Synoptic charts
- Source: WeatherZone via Elders Weather
- URL pattern: `https://data.weatherzone.com.au/data/hourly/images/synoptic/wz_syn_aus_d{N}_640x480.jpg`
  where N = 0 (latest analysis) to 6 (day +6 forecast)
- Loaded as `<img>` tags — browser fetches directly, no CORS issues
- Images update daily on WeatherZone's end
- Fallback: if images fail to load, a link to Elders Weather is shown

### Buoy data (UWA S3 Sofar Spotter via Netlify edge function)
- Edge function at `/api/buoy` fetches the daily CSV from S3 and returns the latest row
- S3 bucket: `uwawavebuoys`, prefix `auswaves/wawaves/MiddletonBeach/text_archive/YYYY/MM/`
- Filename pattern: `MiddletonBeach_YYYYMMDD.csv` (UTC date)
- Buoy: SPOT-31708C (Sofar Spotter), ~35.017°S 117.930°E, inshore near Midds
- Returns normalised JSON: `{ time, hs, tp, dp, sst, lat, lon, depth, stationName, buoyId }`
- Data cadence: 30-minute observations
- **Requires Netlify env vars**: `AWS_BUOY_KEY_ID` and `AWS_BUOY_SECRET`
- Dashboard degrades gracefully if unavailable (panel shows "Unavailable")
- Cache-Control: 30 minutes (matches data cadence)

**Previous source:** AODN GeoServer WFS `imos:wave_buoy_realtime_nonqc` — removed by AODN, no longer available.

## Known issues and gotchas

### Open-Meteo API variable names can change without notice
This has happened twice already:
1. `sea_level_height_above_mean` → `sea_level_height_msl`
2. `meteofrance_ocean` model → `meteofrance_currents`

**When data goes blank or returns errors**, the debugging approach is:
1. Go to https://open-meteo.com/en/docs/marine-weather-api
2. Set lat/lon to Albany (-35.0275, 117.8814)
3. Tick the relevant variable checkbox
4. Copy the generated API URL from the bottom of the page
5. Compare with what's in the code — the variable name or model string has probably changed

### BOM blocks all external requests
BOM's servers return 403 for any request without a browser-like referer from their own domain.
Don't try to fetch BOM chart images directly — use WeatherZone instead (which sources
similar synoptic data). WeatherZone images load fine as `<img>` tags in the browser.

### Netlify free tier
Jack previously turned off GitHub sync because it was consuming too many build minutes.
Current deployment method: `netlify deploy --prod` via Netlify CLI, or drag-and-drop
for quick static-only updates (edge functions won't work with drag-and-drop).

## Code conventions

- **Single file architecture** — everything lives in `index.html`. CSS in `<style>`,
  config in its own `<script>` block, app logic in a second `<script>` block.
- **Edits over rewrites** — Jack prefers specific line-level edits to apply manually
  rather than regenerated files. When making changes, show the exact old → new strings.
- **Dark theme** — deep navy/teal aesthetic. Neon accent colours for ratings
  (cyan=FIRING, green=GOOD, yellow=OK, red=POOR). JetBrains Mono for data,
  Barlow Condensed for headings.
- **Mobile-first** — dashboard is primarily checked on phone before heading to the beach.
  SST and Notes columns hide on mobile. Tables scroll horizontally.
- **Dawn patrol highlighting** — rows near sunrise get a subtle blue background tint.
- **Notes column** — green for offshore (✓ offshore), red for onshore, grey italic
  for other reasons. Keep reason strings short to avoid column bloat.
  If notes get too wide, apply `max-width` with `text-overflow: ellipsis`.

## Deployment

```powershell
# From the project directory
cd C:\Scripts\personal\hyperlocalsurf   # or wherever the project lives

# Deploy with edge functions
netlify deploy --prod

# Or for testing first
netlify deploy              # creates a preview URL
netlify deploy --prod       # promotes to production
```

Production URL: `https://hyperlocalsurf.netlify.app` (or custom domain if configured)

## Future ideas (not yet implemented)
- Swell height sparkline chart (Canvas API)
- Secondary swell tracking from Open-Meteo
- Sofar Ocean API integration (when access is arranged) as alternative/supplement to AODN buoy
- Multiple break support (tabs or dropdown for different Albany spots)
- PWA offline caching for the last-fetched forecast
