// Netlify Edge Function — buoy-proxy.js
// Fetches the Sofar Spotter buoy CSV from UWA S3 bucket and normalises it
// to the same JSON shape the dashboard expects.
//
// Replaces the old AODN GeoServer WFS source (imos:wave_buoy_realtime_nonqc)
// which was removed — buoy is now served from:
//   s3://uwawavebuoys/auswaves/wawaves/MiddletonBeach/text_archive/YYYY/MM/MiddletonBeach_YYYYMMDD.csv
//
// Requires Netlify env vars:
//   AWS_BUOY_KEY_ID      — AWS access key ID
//   AWS_BUOY_SECRET      — AWS secret access key
//
// Buoy ID: SPOT-31708C, lat -35.017, lon 117.930 (inshore, near Midds Reef)
// Data cadence: 30-minute observations

import { AwsClient } from "https://esm.sh/aws4fetch@1.0.17";

const BUCKET  = 'uwawavebuoys';
const PREFIX  = 'auswaves/wawaves/MiddletonBeach/text_archive';
// Signing regions to try in order — UWA bucket is likely ap-southeast-2 (Sydney)
const REGIONS = ['ap-southeast-2', 'us-east-1'];

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// -9999 is the sentinel for missing data in Sofar CSV files
function parseSofarVal(s) {
  const n = parseFloat(s?.trim());
  return (isNaN(n) || n === -9999) ? null : n;
}

// Build virtual-hosted S3 URL for a given region
function s3url(region, key) {
  return `https://${BUCKET}.s3.${region}.amazonaws.com/${key}`;
}

// Fetch one day's CSV trying each region in turn.
// Returns { text } on success, { s3Status, region } on failure.
async function fetchDayCSV(keyId, secret, date) {
  const y  = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const key = `${PREFIX}/${y}/${mm}/MiddletonBeach_${y}${mm}${dd}.csv`;

  let lastStatus = null;
  for (const region of REGIONS) {
    const aws  = new AwsClient({ accessKeyId: keyId, secretAccessKey: secret, region, service: 's3' });
    const resp = await aws.fetch(s3url(region, key));
    if (resp.ok) return { text: await resp.text() };
    lastStatus = resp.status;
    if (resp.status === 404) break; // file doesn't exist — stop trying regions
  }
  return { s3Status: lastStatus };
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const keyId  = Deno.env.get('AWS_BUOY_KEY_ID');
  const secret = Deno.env.get('AWS_BUOY_SECRET');

  if (!keyId || !secret) {
    return new Response(
      JSON.stringify({ error: true, reason: 'AWS credentials not configured on Netlify (AWS_BUOY_KEY_ID / AWS_BUOY_SECRET)' }),
      { status: 500, headers: corsHeaders }
    );
  }

  try {
    const now = new Date();
    // Try today first, fall back to yesterday (today's file may not be posted yet)
    let todayResult  = await fetchDayCSV(keyId, secret, now);
    let csvText = todayResult.text ?? null;
    if (!csvText) {
      const ydayResult = await fetchDayCSV(keyId, secret, new Date(now - 86_400_000));
      csvText = ydayResult.text ?? null;
      if (!csvText) {
        const s3Status = todayResult.s3Status ?? ydayResult.s3Status;
        return new Response(
          JSON.stringify({ error: true, reason: `S3 returned ${s3Status} — check bucket region or credentials` }),
          { status: 404, headers: corsHeaders }
        );
      }
    }

    const lines = csvText.trim().split('\n');
    // Walk backwards for the last non-empty data row
    let lastLine = null;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].trim()) { lastLine = lines[i]; break; }
    }

    if (!lastLine) {
      return new Response(
        JSON.stringify({ error: true, reason: 'No data rows in CSV' }),
        { status: 404, headers: corsHeaders }
      );
    }

    // CSV column indices (0-based):
    //  0  Time (UNIX/UTC)
    //  1  Timestamp (UTC)
    //  2  Site
    //  3  BuoyID
    //  4  Hsig (m)
    //  7  Tp (s)
    // 11  Dp (deg)
    // 20  SST (degC)
    // 28  Latitude (deg)
    // 29  Longitude (deg)
    const c = lastLine.split(',');

    const unixSec = parseInt(c[0]?.trim(), 10);

    const out = {
      time:        isNaN(unixSec) ? null : new Date(unixSec * 1000).toISOString(),
      hs:          parseSofarVal(c[4]),
      tp:          parseSofarVal(c[7]),
      dp:          parseSofarVal(c[11]),
      sst:         parseSofarVal(c[20]),
      lat:         parseSofarVal(c[28]),
      lon:         parseSofarVal(c[29]),
      depth:       null,
      stationName: c[2]?.trim() || 'MiddletonBeach',
      buoyId:      c[3]?.trim() || null,
    };

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=1800', // 30 min — matches data cadence
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
