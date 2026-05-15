// Netlify Edge Function — buoy-proxy.js
// Proxies the AODN GeoServer WFS request for the Albany Waverider buoy (WMO 56011)
// server-side, so CORS is never an issue for the browser.
// Runs on Deno at the edge — no npm deps needed.
//
// Accessible at: /api/buoy
// To swap to Sofar Ocean API later, just change UPSTREAM_URL and the
// field mapping in the response transform below.

const UPSTREAM_URL =
  'https://geoserver-123.aodn.org.au/geoserver/ows?' +
  'service=WFS&version=1.0.0&request=GetFeature' +
  '&typeName=imos:wave_buoy_realtime_nonqc' +
  '&outputFormat=application/json' +
  '&CQL_FILTER=station_name+LIKE+%27%25Albany%25%27' +
  '&maxFeatures=1&sortBy=time+D';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default async (request) => {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const resp = await fetch(UPSTREAM_URL, {
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`AODN returned ${resp.status}`);
    }

    const data = await resp.json();

    // Extract the most recent feature
    const features = data?.features;
    if (!features || features.length === 0) {
      return new Response(
        JSON.stringify({ error: true, reason: 'No buoy features returned' }),
        { status: 404, headers: corsHeaders }
      );
    }

    const feat = features[0].properties;

    // Normalise field names — AODN uses long CF-convention names
    // Map to short, stable keys the dashboard expects
    const out = {
      time: feat.time ?? null,
      hs:   feat.hs
              ?? feat.sea_surface_wave_significant_height
              ?? null,
      tp:   feat.tp
              ?? feat.sea_surface_wave_period_at_variance_spectral_density_maximum
              ?? null,
      dp:   feat.dp
              ?? feat.sea_surface_wave_from_direction_at_variance_spectral_density_maximum
              ?? null,
      sst:  feat.sea_surface_temperature ?? null,
      lat:  feat.latitude  ?? null,
      lon:  feat.longitude ?? null,
      depth: feat.sea_floor_depth_below_sea_surface ?? null,
      stationName: feat.station_name ?? 'Albany',
    };

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        ...corsHeaders,
        // Cache for 10 min — buoy only updates every 3 hours anyway
        'Cache-Control': 'public, max-age=600',
      },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: true, reason: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};

export const config = { path: '/api/buoy' };
