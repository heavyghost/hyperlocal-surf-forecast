# Building a Local Wave Forecast Correction Model

> A step-by-step process for improving the Midds Reef dashboard accuracy using Sofar Spotter buoy observations and Open-Meteo historical forecast data.

**Prerequisites:** Sofar API access (token + spotterId for Great Southern buoys), a spare laptop, and approximately 12 months of historical buoy data.

---

## What You're Building

A correction layer that learns the systematic errors between what Open-Meteo's global wave model predicts and what the local buoys actually measure. You feed in the forecast, the model applies a learned correction, and you get a more accurate prediction for your break.

The global models (GFS-Wave at ~16–28 km resolution, MFWAM at ~8 km) can't see King George Sound, the reefs, or any of the coastal geometry that shapes how swell arrives at Midds. A correction model trained on local buoy data effectively learns that transformation without needing to run expensive physics simulations.

---

## Before You Start — Homework

### Confirm Buoy Locations

Ask your UWA MERA contact which Sofar Spotters are in the Great Southern network and get their exact lat/lon coordinates. You need this because:

- If the buoy is 50 km offshore and your dashboard forecast is at the coastline, you're comparing different things.
- You'll want to pull Open-Meteo historical data **at the buoy's lat/lon** so you're comparing like with like.
- Understanding the buoy-to-break distance tells you whether your correction is learning model bias alone (buoy near the grid point) or model bias plus nearshore transformation (buoy closer to shore). The latter is arguably more useful for surf forecasting.

### Confirm Data Availability

Check with your contact:

- How far back does the Sofar historical data go? (You want 12 months minimum for seasonal coverage.)
- What's the reporting interval? (Hourly? Every 30 minutes? Every 3 hours?)
- Which variables are available? (At minimum you need: `significantWaveHeight`, `peakPeriod`, `peakDirection`. Wind and SST are bonuses.)
- Are there significant gaps in the data? (Buoys go offline for maintenance, storms, battery issues.)

---

## Step 1 — Set Up Your Environment

**Time estimate:** 30 minutes

Install Python and the required libraries on your spare laptop. Any operating system works, but Linux or macOS will give you fewer headaches.

### Install Python

If you don't have Python 3.10+ installed:

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install python3 python3-pip python3-venv

# macOS (with Homebrew)
brew install python

# Windows
# Download from https://www.python.org/downloads/
# Tick "Add to PATH" during installation
```

### Create a Project Directory and Virtual Environment

```bash
mkdir wave-correction && cd wave-correction
python3 -m venv venv
source venv/bin/activate   # Linux/macOS
# or: venv\Scripts\activate   # Windows
```

### Install Libraries

```bash
pip install pandas scikit-learn matplotlib requests jupyter
```

| Library | What It Does |
|---------|-------------|
| `pandas` | Load, merge, and wrangle tabular data (CSVs, DataFrames) |
| `scikit-learn` | Train machine learning models (random forest, gradient boosting) |
| `matplotlib` | Plot charts to visualise errors and validate results |
| `requests` | Make HTTP calls to the Sofar and Open-Meteo APIs |
| `jupyter` | Interactive notebook environment — easier than writing scripts when exploring data |

### Hardware Requirements

This is a small-data problem. 12 months of 3-hourly observations is roughly 2,920 rows with a dozen columns — a tiny CSV. scikit-learn will train a random forest on that in under a second. You don't need a GPU, you don't need much RAM. A 10-year-old ThinkPad running Ubuntu would handle it comfortably.

---

## Step 2 — Download the Sofar Buoy Historical Data

**Time estimate:** 1–2 hours (mostly waiting for API responses)

Once you have your Sofar API token and the `spotterId` values for the relevant buoys, pull the historical wave data.

### Sofar API Endpoint

The historical data endpoint is separate from the `latest-data` endpoint you've seen in the docs. Check the Sofar docs for the exact URL, but it follows this pattern:

```
GET https://api.sofarocean.com/api/wave-data?spotterId=SPOT-XXXX&startDate=2025-05-22&endDate=2026-05-22&includeWindData=true&includeSurfaceTempData=true
```

### Example Download Script

```python
import requests
import pandas as pd
import json
from datetime import datetime

SOFAR_TOKEN = "YOUR_API_TOKEN"
SPOTTER_ID  = "SPOT-XXXX"  # Get this from your UWA contact

headers = {"token": SOFAR_TOKEN}

# Adjust dates to match your available data window
params = {
    "spotterId": SPOTTER_ID,
    "startDate": "2025-05-22",
    "endDate": "2026-05-22",
    "includeWindData": "true",
    "includeSurfaceTempData": "true",
}

# NOTE: Check Sofar docs for the correct historical endpoint URL
# It may be /api/wave-data, /api/history, or similar
resp = requests.get(
    "https://api.sofarocean.com/api/wave-data",
    headers=headers,
    params=params,
)
resp.raise_for_status()
data = resp.json()

# Save raw response for safekeeping
with open("sofar_raw.json", "w") as f:
    json.dump(data, f)

# Extract wave observations into a DataFrame
waves = data.get("data", {}).get("waves", [])
df_buoy = pd.DataFrame(waves)
df_buoy["timestamp"] = pd.to_datetime(df_buoy["timestamp"])
df_buoy = df_buoy.sort_values("timestamp").reset_index(drop=True)

# Rename columns to short names for convenience
df_buoy = df_buoy.rename(columns={
    "significantWaveHeight": "buoy_hs",
    "peakPeriod":           "buoy_tp",
    "meanPeriod":           "buoy_tm",
    "peakDirection":        "buoy_dp",
    "peakDirectionalSpread":"buoy_spread",
    "meanDirection":        "buoy_dm",
})

df_buoy.to_csv("buoy_observations.csv", index=False)
print(f"Saved {len(df_buoy)} buoy observations")
print(df_buoy.head())
```

### What You Should See

A CSV with columns like:

| timestamp | buoy_hs | buoy_tp | buoy_dp | buoy_dm | latitude | longitude |
|-----------|---------|---------|---------|---------|----------|-----------|
| 2025-06-01T06:00:00Z | 1.85 | 12.3 | 215 | 198 | -35.12 | 117.95 |
| 2025-06-01T06:30:00Z | 1.91 | 12.1 | 218 | 201 | -35.12 | 117.95 |

**Note the lat/lon** — you'll need these for Step 3.

---

## Step 3 — Download the Matching Open-Meteo Historical Data

**Time estimate:** 30 minutes

Pull the Open-Meteo hindcast/archive data for the **same time window** at the **buoy's lat/lon** (not the Midds Reef coastline coordinates).

### Open-Meteo Historical Marine API

```python
import requests
import pandas as pd

# Use the BUOY's lat/lon, not the break's coastline coordinates
# This ensures you're comparing like with like
BUOY_LAT = -35.12    # <-- Replace with actual buoy latitude
BUOY_LON = 117.95    # <-- Replace with actual buoy longitude

# Open-Meteo historical archive endpoint
url = "https://marine-api.open-meteo.com/v1/marine"
params = {
    "latitude":  BUOY_LAT,
    "longitude": BUOY_LON,
    "hourly": ",".join([
        "wave_height", "wave_direction", "wave_period",
        "swell_wave_height", "swell_wave_direction", "swell_wave_period",
        "wind_wave_height", "wind_wave_period",
    ]),
    "timezone": "auto",
    "start_date": "2025-05-22",
    "end_date":   "2026-05-22",
}

resp = requests.get(url, params=params)
resp.raise_for_status()
data = resp.json()

# Build DataFrame from hourly arrays
df_forecast = pd.DataFrame({
    "timestamp":    pd.to_datetime(data["hourly"]["time"]),
    "fc_wave_ht":   data["hourly"]["wave_height"],
    "fc_wave_dir":  data["hourly"]["wave_direction"],
    "fc_wave_per":  data["hourly"]["wave_period"],
    "fc_swell_ht":  data["hourly"]["swell_wave_height"],
    "fc_swell_dir": data["hourly"]["swell_wave_direction"],
    "fc_swell_per": data["hourly"]["swell_wave_period"],
    "fc_ww_ht":     data["hourly"]["wind_wave_height"],
    "fc_ww_per":    data["hourly"]["wind_wave_period"],
})

# Also fetch wind data from the weather API
wx_url = "https://api.open-meteo.com/v1/forecast"
wx_params = {
    "latitude":  BUOY_LAT,
    "longitude": BUOY_LON,
    "hourly": "windspeed_10m,winddirection_10m,windgusts_10m",
    "timezone": "auto",
    "start_date": "2025-05-22",
    "end_date":   "2026-05-22",
}

wx_resp = requests.get(wx_url, params=wx_params)
wx_resp.raise_for_status()
wx_data = wx_resp.json()

df_wind = pd.DataFrame({
    "timestamp":   pd.to_datetime(wx_data["hourly"]["time"]),
    "fc_wind_spd": wx_data["hourly"]["windspeed_10m"],
    "fc_wind_dir": wx_data["hourly"]["winddirection_10m"],
    "fc_wind_gst": wx_data["hourly"]["windgusts_10m"],
})

# Merge marine + wind forecasts
df_forecast = df_forecast.merge(df_wind, on="timestamp", how="left")
df_forecast.to_csv("forecast_historical.csv", index=False)
print(f"Saved {len(df_forecast)} forecast rows")
print(df_forecast.head())
```

### Important: Historical vs. Forecast Archive

Open-Meteo's standard historical endpoint returns **reanalysis** data (ERA5), which is a best-estimate reconstruction, not what the model would have predicted at the time. For a forecast correction model, you ideally want the **archived forecast** — what the model actually said before the event. Check Open-Meteo's "Previous Model Runs" API (`/v1/marine?past_days=...`) or their "Historical Forecast" endpoint if available. If you can only get reanalysis, it still works — the biases will be similar — but keep this distinction in mind.

---

## Step 4 — Merge the Two Datasets

**Time estimate:** 1 hour

Align buoy observations with forecast data by matching timestamps. The buoy might report every 30 minutes while the forecast is hourly, so you'll need to resample or use nearest-timestamp matching.

```python
import pandas as pd

df_buoy = pd.read_csv("buoy_observations.csv", parse_dates=["timestamp"])
df_fc   = pd.read_csv("forecast_historical.csv", parse_dates=["timestamp"])

# Round buoy timestamps to nearest hour to match forecast resolution
df_buoy["timestamp_hour"] = df_buoy["timestamp"].dt.round("h")

# Average any sub-hourly buoy readings into hourly values
df_buoy_hourly = df_buoy.groupby("timestamp_hour").agg({
    "buoy_hs": "mean",
    "buoy_tp": "mean",
    "buoy_dp": "mean",  # Note: averaging circular data is tricky — see below
}).reset_index().rename(columns={"timestamp_hour": "timestamp"})

# Merge on timestamp
df = df_fc.merge(df_buoy_hourly, on="timestamp", how="inner")

# Drop rows where either side has missing data
df = df.dropna(subset=["buoy_hs", "fc_swell_ht"])

# Calculate error columns
df["error_hs"] = df["fc_swell_ht"] - df["buoy_hs"]
df["error_tp"] = df["fc_swell_per"] - df["buoy_tp"]

df.to_csv("merged_dataset.csv", index=False)
print(f"Merged dataset: {len(df)} matched rows")
print(f"Mean wave height error: {df['error_hs'].mean():.3f} m")
print(f"Mean period error: {df['error_tp'].mean():.2f} s")
```

### Direction Averaging Warning

Averaging compass directions naively (e.g., averaging 350° and 10°) gives you 180° — completely wrong. For the direction columns, use circular mean:

```python
import numpy as np

def circular_mean(angles_deg):
    """Average compass bearings correctly."""
    rads = np.deg2rad(angles_deg)
    return np.rad2deg(np.arctan2(np.sin(rads).mean(), np.cos(rads).mean())) % 360
```

---

## Step 5 — Explore the Errors (Start Here Before Any ML)

**Time estimate:** 2–3 hours

Before training any model, look at the data. This step alone might give you a usable correction without machine learning.

```python
import matplotlib.pyplot as plt
import numpy as np

df = pd.read_csv("merged_dataset.csv", parse_dates=["timestamp"])

# ── Overall error distribution ──
fig, axes = plt.subplots(1, 2, figsize=(12, 5))

axes[0].hist(df["error_hs"], bins=50, edgecolor="black", alpha=0.7)
axes[0].axvline(0, color="red", linestyle="--")
axes[0].set_xlabel("Forecast Error — Wave Height (m)")
axes[0].set_ylabel("Count")
axes[0].set_title(f"Mean bias: {df['error_hs'].mean():.3f} m")

axes[1].hist(df["error_tp"], bins=50, edgecolor="black", alpha=0.7)
axes[1].axvline(0, color="red", linestyle="--")
axes[1].set_xlabel("Forecast Error — Period (s)")
axes[1].set_title(f"Mean bias: {df['error_tp'].mean():.2f} s")

plt.tight_layout()
plt.savefig("error_distribution.png", dpi=150)
plt.show()

# ── Error by swell direction (30° bins) ──
df["dir_bin"] = (df["fc_swell_dir"] // 30) * 30

dir_summary = df.groupby("dir_bin").agg(
    mean_error=("error_hs", "mean"),
    std_error=("error_hs", "std"),
    count=("error_hs", "count"),
).reset_index()

print("\n── Wave Height Error by Swell Direction ──")
print(dir_summary.to_string(index=False))

# ── Error by month ──
df["month"] = df["timestamp"].dt.month

month_summary = df.groupby("month").agg(
    mean_error=("error_hs", "mean"),
    std_error=("error_hs", "std"),
    count=("error_hs", "count"),
).reset_index()

print("\n── Wave Height Error by Month ──")
print(month_summary.to_string(index=False))
```

### What to Look For

- **Consistent positive bias** (e.g., +0.3 m across all directions) = the model over-predicts. Simple subtraction would fix this.
- **Direction-dependent bias** (e.g., over-predicts from SW but under-predicts from S) = you need a direction-aware correction. A lookup table keyed by direction bin would work.
- **Seasonal bias** (e.g., larger errors in winter when swell is bigger) = the model's error scales with swell size. A percentage correction (multiply by 0.85) would work better than a fixed offset.
- **No clear pattern** = the errors are more complex, and this is where machine learning earns its keep.

### If the Lookup Table Is Enough — Stop Here

If the errors show clean, consistent patterns by direction and season, you can build a correction table and apply it directly in your dashboard JavaScript. No ML needed. Create a JSON object keyed by direction bin and month, and apply the correction during rendering.

---

## Step 6 — Train a Correction Model (If Needed)

**Time estimate:** 2–4 hours

If the error patterns are complex (they depend on combinations of direction, height, period, wind, etc.), train a machine learning model.

```python
import pandas as pd
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error
import matplotlib.pyplot as plt
import joblib

df = pd.read_csv("merged_dataset.csv", parse_dates=["timestamp"])

# ── Feature engineering ──
# Convert circular direction to sin/cos components
# (ML models can't handle circular data directly)
df["fc_swell_dir_sin"] = np.sin(np.deg2rad(df["fc_swell_dir"]))
df["fc_swell_dir_cos"] = np.cos(np.deg2rad(df["fc_swell_dir"]))
df["fc_wind_dir_sin"]  = np.sin(np.deg2rad(df["fc_wind_dir"]))
df["fc_wind_dir_cos"]  = np.cos(np.deg2rad(df["fc_wind_dir"]))

# Add time features
df["month"]    = df["timestamp"].dt.month
df["hour"]     = df["timestamp"].dt.hour

# ── Define features and target ──
feature_cols = [
    "fc_swell_ht", "fc_swell_per",
    "fc_swell_dir_sin", "fc_swell_dir_cos",
    "fc_wave_ht", "fc_ww_ht",
    "fc_wind_spd", "fc_wind_dir_sin", "fc_wind_dir_cos",
    "month", "hour",
]

X = df[feature_cols].dropna()
y = df.loc[X.index, "buoy_hs"]  # Target: actual buoy wave height

# ── Time-series cross-validation ──
# (Don't shuffle — respect temporal order so you're not
#  training on future data to predict the past)
tscv = TimeSeriesSplit(n_splits=5)

mae_scores = []
for train_idx, test_idx in tscv.split(X):
    X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
    y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]

    model = GradientBoostingRegressor(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.1,
        random_state=42,
    )
    model.fit(X_train, y_train)
    preds = model.predict(X_test)
    mae = mean_absolute_error(y_test, preds)
    mae_scores.append(mae)

print(f"Cross-validated MAE: {np.mean(mae_scores):.3f} m "
      f"(± {np.std(mae_scores):.3f})")

# ── Compare: corrected vs uncorrected ──
# Train final model on all data
final_model = GradientBoostingRegressor(
    n_estimators=200, max_depth=4, learning_rate=0.1, random_state=42,
)
final_model.fit(X, y)

df.loc[X.index, "corrected_hs"] = final_model.predict(X)

uncorrected_mae = mean_absolute_error(y, df.loc[X.index, "fc_swell_ht"])
corrected_mae   = mean_absolute_error(y, df.loc[X.index, "corrected_hs"])

print(f"\nUncorrected MAE: {uncorrected_mae:.3f} m")
print(f"Corrected MAE:   {corrected_mae:.3f} m")
print(f"Improvement:     {(1 - corrected_mae/uncorrected_mae)*100:.1f}%")

# ── Feature importance ──
importances = pd.Series(
    final_model.feature_importances_, index=feature_cols
).sort_values(ascending=False)
print("\n── Feature Importance ──")
print(importances.to_string())

# ── Save the trained model ──
joblib.dump(final_model, "wave_correction_model.pkl")
print("\nModel saved to wave_correction_model.pkl")
```

### Interpreting the Results

- **MAE (Mean Absolute Error):** The average size of the prediction error in metres. If the uncorrected forecast has an MAE of 0.45 m and the corrected version has 0.16 m, you've cut the error by two thirds.
- **Feature importance:** Shows which forecast variables matter most for predicting the actual buoy value. If `fc_swell_dir_cos` is high, it means the directional bias is significant — the model is learning that swell from certain directions is consistently mispredicted.

---

## Step 7 — Deploy the Correction

**Time estimate:** 2–4 hours

You have several options for getting the correction into your live dashboard.

### Option A: Static Lookup Table (Simplest)

If Step 5 showed clean, simple patterns, export a correction table as JSON and embed it directly in `index.html`:

```javascript
// Paste this into your dashboard code
const CORRECTION = {
  // Key: "dirBin-month", Value: offset in metres
  "180-6": -0.25,  // SW swell in June: subtract 0.25m
  "210-6": -0.30,
  "180-7": -0.20,
  // ... etc
};

function correctSwellHeight(forecastHs, swellDir, month) {
  const dirBin = Math.floor(swellDir / 30) * 30;
  const key = `${dirBin}-${month}`;
  const offset = CORRECTION[key] || 0;
  return forecastHs + offset;
}
```

### Option B: Python API on the Laptop (More Flexible)

Run a minimal Flask API on the laptop (or a cheap VPS) that loads the trained model and returns corrected values:

```python
from flask import Flask, request, jsonify
import joblib
import numpy as np

app = Flask(__name__)
model = joblib.load("wave_correction_model.pkl")

@app.route("/correct", methods=["GET"])
def correct():
    # Accept forecast values as query params
    swell_ht  = float(request.args["swell_ht"])
    swell_per = float(request.args["swell_per"])
    swell_dir = float(request.args["swell_dir"])
    wind_spd  = float(request.args["wind_spd"])
    wind_dir  = float(request.args["wind_dir"])
    wave_ht   = float(request.args.get("wave_ht", swell_ht))
    ww_ht     = float(request.args.get("ww_ht", 0))
    month     = int(request.args.get("month", 1))
    hour      = int(request.args.get("hour", 12))

    features = np.array([[
        swell_ht, swell_per,
        np.sin(np.radians(swell_dir)),
        np.cos(np.radians(swell_dir)),
        wave_ht, ww_ht,
        wind_spd,
        np.sin(np.radians(wind_dir)),
        np.cos(np.radians(wind_dir)),
        month, hour,
    ]])

    corrected = model.predict(features)[0]
    return jsonify({"corrected_hs": round(corrected, 2)})

if __name__ == "__main__":
    app.run(port=5050)
```

### Option C: Netlify Serverless Function (Best for Production)

Convert the trained model to a lightweight format (e.g., export the tree structure as JSON) and apply the correction in a Netlify edge function, similar to your existing buoy proxy. This avoids needing to run a separate server.

---

## Step 8 — Validate and Iterate

**Time estimate:** Ongoing

Once deployed, keep logging both the corrected forecast and the buoy observations. Periodically (monthly or quarterly):

1. Compare corrected predictions against new buoy data.
2. Check whether the correction is still accurate or has drifted.
3. Retrain the model with the expanded dataset.

The model should improve over time as it sees more data across different seasons and swell regimes.

---

## Quick Reference — What You Need at Each Stage

| Stage | What You Need | Time |
|-------|--------------|------|
| Setup | Spare laptop, Python 3.10+, pip | 30 min |
| Buoy data | Sofar API token + spotterId | 1–2 hrs |
| Forecast data | Open-Meteo API (free, no key) | 30 min |
| Merge + explore | pandas, matplotlib | 2–3 hrs |
| Simple correction | Spreadsheet analysis, JSON lookup table | 2 hrs |
| ML correction | scikit-learn, time-series cross-validation | 2–4 hrs |
| Deploy | Embed in dashboard JS or Netlify function | 2–4 hrs |

**Total estimated time to first usable correction: 1–2 weekends.**

---

## Gotchas and Things to Watch

### Buoy Location vs. Dashboard Location

If the buoy is far offshore and your dashboard forecasts for the coastline, your correction model learns two things at once: the global model's bias *and* the offshore-to-nearshore transformation. This is actually useful for surf forecasting, but it means the correction is specific to that buoy-to-break relationship and won't transfer to a different spot without retraining.

### Circular Data

Compass directions wrap around 360°. Don't average them naively (350° + 10° ≠ 180°). Always convert to sin/cos components before doing maths. The `circular_mean()` function in Step 4 handles this, and the sin/cos feature engineering in Step 6 handles it for the ML model.

### Time-Series Splitting

Never shuffle time-series data when training. If you randomly split the dataset, the model will see tomorrow's weather while training to predict today's — that's data leakage and it makes your accuracy metrics look unrealistically good. Always use `TimeSeriesSplit` or manually split by date (e.g., train on months 1–10, test on months 11–12).

### Open-Meteo API Limits

Open-Meteo is free for non-commercial use but has rate limits. When pulling a full year of historical data, you might need to break the request into monthly chunks. Add a small delay (`time.sleep(1)`) between requests to be polite.

### Reanalysis vs. Archived Forecast

Open-Meteo's standard historical endpoint returns ERA5 reanalysis (a retrospective best-estimate), not what the model actually predicted at the time. For a forecast correction model, archived forecasts are better. Check their "Previous Model Runs" API. If only reanalysis is available, it still works — the systematic biases are similar — but note this caveat.

---

## Further Reading

- [Open-Meteo Marine API docs](https://open-meteo.com/en/docs/marine-weather-api) — check for variable name changes
- [Sofar Ocean API docs](https://docs.sofarocean.com/) — full endpoint reference
- [AusWaves](https://auswaves.org/) — WA buoy network info and contacts
- [scikit-learn docs](https://scikit-learn.org/stable/) — model reference
- "Predicting coastal wave conditions: A simple machine learning approach" — the research paper describing the Gaussian process regression method that inspired this approach