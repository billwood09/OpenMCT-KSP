// Live data from KSP via the Telemachus mod's WebSocket datalink.
// Protocol: https://github.com/richardbunt/Telemachus/wiki/Web-Socket-API
//   -> {"+": ["v.altitude", ...], "rate": 100}
//   <- {"v.altitude": 1234.5, ...}   (or {} when not in the flight scene)

import WebSocket from 'ws';

// Telemachus API string -> dictionary id, with an optional unit scale.
// Telemachus has no API strings for vessel situation or current stage, so those
// points stay empty with this source (use the kRPC bridge if you need them).
const API_STRINGS = {
  'v.name': { id: 'vessel.name' },
  'v.body': { id: 'vessel.body' },
  'f.throttle': { id: 'control.throttle', scale: 100 },
  'v.altitude': { id: 'flight.altitude' },
  'v.surfaceSpeed': { id: 'flight.surfaceSpeed' },
  'v.verticalSpeed': { id: 'flight.verticalSpeed' },
  'v.orbitalVelocity': { id: 'flight.orbitalSpeed' },
  'v.geeForce': { id: 'flight.gForce' },
  // Telemachus doesn't document this unit. Assumed Pa (converted to kPa); if
  // the dashboard shows values ~1000x too small, change scale to 1.
  'v.dynamicPressure': { id: 'flight.dynamicPressure', scale: 0.001 },
  'v.lat': { id: 'flight.latitude' },
  'v.long': { id: 'flight.longitude' },
  'n.pitch2': { id: 'attitude.pitch' },
  'n.heading2': { id: 'attitude.heading' },
  'n.roll2': { id: 'attitude.roll' },
  'o.ApA': { id: 'orbit.apoapsis' },
  'o.PeA': { id: 'orbit.periapsis' },
  'o.timeToAp': { id: 'orbit.timeToApoapsis' },
  'o.timeToPe': { id: 'orbit.timeToPeriapsis' },
  'o.inclination': { id: 'orbit.inclination' },
  'o.eccentricity': { id: 'orbit.eccentricity' },
  'o.period': { id: 'orbit.period' },
  'r.resource[LiquidFuel]': { id: 'resources.liquidFuel' },
  'r.resource[Oxidizer]': { id: 'resources.oxidizer' },
  'r.resource[ElectricCharge]': { id: 'resources.electricCharge' },
  't.universalTime': { id: 'time.ut' },
  'v.missionTime': { id: 'time.met' }
};

export function createTelemachusSource({ url, rateMs, publish, log }) {
  let socket;
  let retryMs = 1000;
  let retryTimer;
  let stopped = false;

  function connect() {
    log(`connecting to Telemachus at ${url}`);
    socket = new WebSocket(url);

    socket.on('open', () => {
      retryMs = 1000;
      log('connected to Telemachus');
      socket.send(JSON.stringify({ '+': Object.keys(API_STRINGS), rate: rateMs }));
    });

    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      const values = {};
      for (const [apiString, raw] of Object.entries(message)) {
        const mapping = API_STRINGS[apiString];
        if (!mapping) continue;
        values[mapping.id] = mapping.scale && typeof raw === 'number' ? raw * mapping.scale : raw;
      }
      // An empty message means KSP isn't in the flight scene.
      if (Object.keys(values).length > 0) {
        publish(values);
      }
    });

    socket.on('error', (err) => log(`Telemachus connection error: ${err.message}`));

    socket.on('close', () => {
      if (stopped) return;
      log(`Telemachus disconnected, retrying in ${retryMs / 1000}s`);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    });
  }

  connect();

  return {
    name: 'Telemachus',
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    }
  };
}
