# KSP Mission Control (Kerbal Space Program → NASA Open MCT)

Live and historical Kerbal Space Program telemetry in [Open MCT](https://github.com/nasa/openmct),
NASA's mission control framework.

```
KSP + Telemachus mod ──WebSocket──┐
KSP + kRPC mod ── krpc/bridge.py ─┼─► bridge server ──► Open MCT (browser)
built-in flight simulator ────────┘   history + realtime   plots, layouts, limits
```

The bridge (`server/`) collects telemetry from one source, keeps recent history in memory,
and serves Open MCT. The Open MCT plugin (`public/ksp-plugin.js`) adds an **Active Vessel**
tree of about 30 telemetry points, plus limit alarms and stale-data indication. On first load
it also creates a ready-made **KSP Flight Dashboard** in My Items.

## Quick start (no KSP needed)

```bash
npm install
npm start
```

Open http://localhost:8090 and then **My Items → KSP Flight Dashboard**. A simulated two-stage rocket
launches from KSC, flies a gravity turn into an ~80 km orbit, coasts, then reverts to launch
and repeats. One cycle takes about 5 minutes at the default 2× speed.

## Connecting to KSP

### Option A: Telemachus (simplest)

1. Install a Telemachus build for your KSP version and load into the flight scene.
2. Run:

   ```bash
   npm run telemachus
   ```

   If KSP runs on another machine or port, add
   `-- --telemachus-url ws://<ksp-machine>:8085/datalink`.

Telemachus has no API strings for vessel situation or current stage, so those two points stay empty.

### Option B: kRPC (richer API)

1. Install the kRPC mod, open its window in game, and start the server (ports 50000 and 50001).
2. Install the Python client. Pin it to the version that matches the mod, e.g. `pip install krpc==0.5.4`:

   ```bash
   pip install -r krpc/requirements.txt
   ```

3. In two terminals:

   ```bash
   npm run krpc                # bridge, waiting for data
   python3 krpc/bridge.py      # streams the active vessel into the bridge
   ```

`bridge.py` follows the active vessel. Switching vessels, changing SOI, or leaving and re-entering
the flight scene rebuilds its streams automatically. Options: `--krpc-host`, `--rpc-port`,
`--stream-port`, `--bridge-url`, `--rate`.

## Bridge options

```
node server/index.js [options]
  --source <fake|telemachus|ingest>  where telemetry comes from (default: fake)
  --host <addr>                      interface to listen on (default: 127.0.0.1; use 0.0.0.0 for LAN)
  --port <n>                         HTTP/WebSocket port (default: 8090)
  --telemachus-url <url>             Telemachus datalink (default: ws://127.0.0.1:8085/datalink)
  --rate-ms <n>                      sample interval for fake/telemachus (default: 100)
  --sim-speed <n>                    fake source time multiplier (default: 2)
  --history-limit <n>                samples kept per telemetry point (default: 18000)
```

To view the dashboard on a tablet or second PC, start with `--host 0.0.0.0`. There is no
authentication, so only do this on a network you trust.

## What you get in Open MCT

- **Active Vessel tree:** Vessel, Flight, Attitude, Orbit, Resources, Time, Bridge. Drag points into plots,
  tables, LAD tables, gauges, or your own display layouts.
- **History and realtime:** plots back-fill from the bridge's history, then update live at 10 Hz.
- **Limits:** G-force, dynamic pressure and electric charge turn yellow or red past their limits.
  Plots draw the limit lines.
- **Staleness:** if the bridge goes down, or KSP stops sending (paused feed, space center, game closed),
  values grey out. **Bridge → Link Status** shows `RECEIVING` or `NO DATA`.
- **Time:** the time axis is wall-clock UTC. Game time is recorded as the **Universal Time** and
  **Mission Elapsed Time** points. Time warp, quickloads and reverts therefore can't scramble the plots.

## Customizing

Telemetry points are defined once, in `dictionary.json`. Each point has an `id`, `name`, `format`
(`float`, `integer` or `string`), and optional `units`, `min`/`max`, `formatString` (printf-style,
e.g. `%0.1f`) and `limits` (`{"warning": {"high": 4}, "critical": {"low": 10}}`).

To add a point:
1. Add it to `dictionary.json`.
2. Map it in the source:
   - Telemachus: `API_STRINGS` in `server/sources/telemachus.js`
   - kRPC: `stream_specs` in `krpc/bridge.py`
   - simulator: `snapshot()` in `server/sources/fake.js`

Any other program can feed the bridge too:

```bash
curl -X POST localhost:8090/ingest -H 'content-type: application/json' \
  -d '{"values": {"flight.altitude": 1234.5, "vessel.name": "Test"}, "source": "curl"}'
```

## Known limitations

- History is in memory only; restarting the bridge clears it. Layouts you build are saved in the
  browser's local storage.
- Only the active vessel is tracked.
- Monitoring only, with no commanding (staging, throttle, etc.) from Open MCT yet.
- How each path has been tested:
  - The simulator, server and Open MCT plugin were tested end to end.
  - The Telemachus source was tested against a mock that follows the documented datalink protocol.
  - `krpc/bridge.py` was checked against the kRPC client's API definitions and exercised with a
    stand-in client.
  - Neither mod path has run against a live game yet.
- Telemachus doesn't document the unit of `v.dynamicPressure`. It is assumed to be Pa (converted to kPa).
  If Dynamic Pressure reads about 1000× too small, set its `scale` to `1` in `server/sources/telemachus.js`.
