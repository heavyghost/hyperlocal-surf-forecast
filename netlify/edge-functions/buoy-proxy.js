// Netlify Edge Function — buoy-proxy.js
// Tries multiple known AODN layer name variants for the wave buoy realtime data.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const BASE = 'https://geoserver-123.aodn.org.au/geoserver/ows';

// Try these layer names in order until one works
const LAYER_CANDIDATES = [
  'imos:anmn_wave_data',
  'imos:anmn_mhlwave_data',
  'imos:anmn_nrs_rt_wave_timeseries_data',
];

async function tryLayer(layerName) {
  // Try with station filter first, then without if it fails
  const filters = [
    "station_name LIKE '%Albany%'",
    "site_name LIKE '%Albany%'",
    "platform_code LIKE '%56011%'",
    null, // no filter — just get latest record
  ];

  for (const filter of filters) {
    const params = new URLSearchParams({
      service: 'WFS',
      version: '1.0.0',
      request: 'GetFeature',
      typeName: layerName,
      outputFormat: 'application/json',
      maxFeatures: '1',
    });
    if (filter) params.set('CQL_FILTER', filter);

    const resp = await fetch(`${BASE}?${params.toString()}`, {
      headers: { 'Accept': 'application/json, */*', 'User-Agent': 'hyperlocalsurf/1.0' },
    });

    const text = await resp.text();
    if (text.trimStart().startsWith('<')) continue; // XML error, try next filter

    let json;
    try { json = JSON.parse(text); } catch(e) { continue; }
    if (!json.features?.length) continue;

    return { json, filterUsed: filter };
  }
  return null;
}

async function getCapabilities() {
  // Fetch the layer list to find the correct name
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetCapabilities',
  });
  const resp = await fetch(`${BASE}?${params.toString()}`);
  const text = await resp.text();
  // Extract layer names containing 'wave' and 'buoy' from the XML
  const matches = [...text.matchAll(/<Name>(imos:[^<]*(?:wave|buoy)[^<]*)<\/Name>/gi)]
    .map(m => m[1]);
  return matches;
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Try all candidate layer names
    for (const layerName of LAYER_CANDIDATES) {
      const result = await tryLayer(layerName);
      if (!result) continue;

      const { json, filterUsed } = result;
      const feat = json.features[0].properties;

      return new Response(JSON.stringify({
        source: `AODN WFS — ${layerName}`,
        layerUsed: layerName,
        filterUsed,
        time: feat.time ?? feat.TIME ?? feat.observation_date ?? null,
        hs:   feat.hs ?? feat.HSIG ?? feat.sea_surface_wave_significant_height
                ?? feat.significant_wave_height ?? null,
        tp:   feat.tp ?? feat.TP ?? feat.TPEAK
                ?? feat.sea_surface_wave_period_at_variance_spectral_density_maximum
                ?? feat.peak_wave_period ?? null,
        dp:   feat.dp ?? feat.DP ?? feat.DPEAK
                ?? feat.sea_surface_wave_from_direction_at_variance_spectral_density_maximum
                ?? feat.peak_wave_direction ?? null,
        sst:  feat.sst ?? feat.SST ?? feat.sea_surface_temperature ?? null,
        stationName: feat.station_name ?? feat.site_name ?? feat.platform_code ?? 'Albany',
        _debug_fields: Object.keys(feat),
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=600' },
      });
    }

    // All candidates failed — do a GetCapabilities to find the real layer name
    const waveLayers = await getCapabilities();
    return new Response(JSON.stringify({
      error: true,
      reason: 'All layer name candidates failed',
      triedLayers: LAYER_CANDIDATES,
      discoveredWaveLayers: waveLayers,
    }), { status: 404, headers: corsHeaders });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: true, reason: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};

export const config = { path: '/api/buoy' };
