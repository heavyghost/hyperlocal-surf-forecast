# Midds Reef — Surf Forecast Dashboard

Hyperlocal surf forecast for Middleton Beach Reef, Albany WA.

A single self-contained HTML file that fetches live marine data, displays synoptic pressure charts, and scores surf conditions against configurable break parameters.

## Quick start

1. Open `index.html` in a browser — that's it
2. Forecast data loads automatically from Open-Meteo (free, no API key)
3. Synoptic charts load from WeatherZone (auto-updating daily)
4. Tweak break parameters via the ⚙ settings panel

## Deploy to Netlify

```bash
npm install -g netlify-cli
netlify deploy --prod
```

This enables the buoy proxy edge function at `/api/buoy` for live Albany Waverider data.

## Customise

Edit the `BREAK_CONFIG` object at the top of `index.html`, or use the in-page settings panel.

## Data sources

- [Open-Meteo](https://open-meteo.com) — Marine forecast + weather (free, open source)
- [WeatherZone](https://eldersweather.com.au/synoptic) — Synoptic pressure charts
- [AODN](https://portal.aodn.org.au/) — Albany Waverider buoy (via Netlify edge proxy)
