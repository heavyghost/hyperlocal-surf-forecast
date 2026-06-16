// Netlify Scheduled Function — runs every 3 hours
// Fetches Albany Waverider data from AODN and stores in Netlify Blobs
// so the dashboard never makes a live API call on page load.

import { getStore } from "@netlify/blobs";

const UPSTREAM_URL =
  'https://geoserver-123.aodn.org.au/geoserver/ows?' +
  'service=WFS&version=1.0.0&request=GetFeature' +
  '&typeName=imos:wave_buoy_realtime_nonqc' +
  '&outputFormat=application/json' +
  '&CQL_FILTER=station_name+LIKE+%27%25Albany%25%27' +
  '&maxFeatures=1&sortBy=time+D';

export default async () => {
  try {
    const resp = await fetch(UPSTREAM_URL, {
      headers: { 'Accept': 'application/json' }
    });

    if (!resp.ok) throw new Error(`AODN returned ${resp.status}`);

    const data = await resp.json();
    const features = data?.features;

    if (!features || features.length === 0) {
      throw new Error('No buoy features returned');
    }

    const feat = features[0].properties;

    const out = {
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

    const store = getStore('buoy-cache');
    await store.setJSON('albany-latest', out);

    console.log(`Buoy data cached successfully at ${out.fetchedAt}`);
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Failed to fetch/cache buoy data:', err.message);
    return new Response(err.message, { status: 500 });
  }
};

export const config = {
  schedule: "0 */3 * * *"   // top of every 3rd hour: 12am, 3am, 6am...
};