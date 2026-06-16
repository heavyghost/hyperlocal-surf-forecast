// Netlify Function — serves cached buoy data from Netlify Blobs
// Replaces buoy-proxy.js edge function.
// Falls back to a live AODN fetch if the cache is empty
// (first deploy, before the scheduled function has run).

import { getStore } from "@netlify/blobs";

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const UPSTREAM_URL =
  'https://geoserver-123.aodn.org.au/geoserver/ows?' +
  'service=WFS&version=1.0.0&request=GetFeature' +
  '&typeName=imos:wave_buoy_realtime_nonqc' +
  '&outputFormat=application/json' +
  '&CQL_FILTER=station_name+LIKE+%27%25Albany%25%27' +
  '&maxFeatures=1&sortBy=time+D';

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // ── Try Blobs cache first ────────────────────────────────
  try {
    const store  = getStore('buoy-cache');
    const cached = await store.get('albany-latest', { type: 'json' });

    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=600' },
      });
    }
  } catch (e) {
    console.warn('Blobs read failed, falling back to live fetch:', e.message);
  }

  // ── Fallback: live fetch from AODN ───────────────────────
  // Only hits this path on first deploy before scheduled function has run
  try {
    const resp = await fetch(UPSTREAM_URL, {
      headers: { 'Accept': 'application/json' }
    });

    if (!resp.ok) throw new Error(`AODN returned ${resp.status}`);

    const data     = await resp.json();
    const features = data?.features;

    if (!features || features.length === 0) {
      throw new Error('No buoy features returned');
    }

    const feat = features[0].properties;
    const out  = {
      time:        feat.time ?? null,
      hs:          feat.hs ?? feat.sea_surface_wave_significant_height ?? null,
      tp:          feat.tp ?? feat.sea_surface_wave_period_at_variance_spectral_density_maximum ?? null,
      dp:          feat.dp ?? feat.sea_surface_wave_from_direction_at_variance_spectral_density_maximum ?? null,
      sst:         feat.sea_surface_temperature ?? null,
      lat:         feat.latitude  ?? null,
      lon:         feat.longitude ?? null,
      depth:       feat.sea_floor_depth_below_sea_surface ?? null,
      stationName: feat.station_name ?? 'Albany',
      fetchedAt:   new Date().toISOString(),
    };

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=600' },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: true, reason: err.message }),
      { status: 500, headers: CORS }
    );
  }
};

export const config = {
  path: "/api/buoy"
};