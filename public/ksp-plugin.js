// Open MCT plugin for Kerbal Space Program telemetry served by the KSP bridge
// (server/index.js). It adds:
//   - an "Active Vessel" tree built from dictionary.json
//   - historical telemetry (GET /history/:id) and realtime telemetry (WS /realtime)
//   - limits from the dictionary (highlighting in tables/readouts, alarm lines on plots)
//   - staleness: values grey out when the bridge stops receiving data from KSP

(function () {
  const NAMESPACE = 'ksp';
  const ROOT_KEY = 'vessel';
  const TELEMETRY_TYPE = 'ksp.telemetry';
  const DEFAULT_FORMAT_STRINGS = { float: '%0.2f', integer: '%d' };
  const LIMIT_LEVELS = [
    { key: 'critical', name: 'Critical', color: 'red' },
    { key: 'warning', name: 'Warning', color: 'yellow' }
  ];

  function KspPlugin() {
    return function install(openmct) {
      const objects = fetch('dictionary.json')
        .then((response) => response.json())
        .then(buildObjects);
      const realtime = new RealtimeClient(`${location.origin.replace(/^http/, 'ws')}/realtime`);
      const link = new LinkMonitor(openmct, realtime);

      openmct.types.addType(TELEMETRY_TYPE, {
        name: 'KSP Telemetry Point',
        description: 'A telemetry point from Kerbal Space Program, via the KSP bridge.',
        cssClass: 'icon-telemetry'
      });

      openmct.objects.addRoot({ namespace: NAMESPACE, key: ROOT_KEY }, openmct.priority.HIGH);
      openmct.objects.addProvider(NAMESPACE, {
        get: (identifier) => objects.then((byKey) => byKey.get(identifier.key))
      });

      openmct.telemetry.addProvider({
        supportsRequest: isKspTelemetry,
        request: requestHistory,

        supportsSubscribe: isKspTelemetry,
        subscribe: (domainObject, callback) => realtime.subscribe(domainObject.identifier.key, callback),

        supportsLimits: (domainObject) => isKspTelemetry(domainObject) && Boolean(domainObject.ksp?.limits),
        getLimitEvaluator: (domainObject) => limitEvaluator(domainObject.ksp.limits),
        getLimits: (domainObject) => ({
          limits: () => Promise.resolve(plotLimits(domainObject.ksp.limits))
        }),

        supportsStaleness: isKspTelemetry,
        isStale: (domainObject) => Promise.resolve(link.staleness(domainObject.identifier.key)),
        subscribeToStaleness: (domainObject, callback) => link.subscribe(domainObject.identifier.key, callback)
      });
    };
  }

  function isKspTelemetry(domainObject) {
    return domainObject.type === TELEMETRY_TYPE;
  }

  // --- Object tree ------------------------------------------------------------

  function buildObjects(dictionary) {
    const byKey = new Map();
    const id = (key) => ({ namespace: NAMESPACE, key });

    byKey.set(ROOT_KEY, {
      identifier: id(ROOT_KEY),
      name: dictionary.name,
      type: 'folder',
      location: 'ROOT',
      composition: dictionary.groups.map((group) => id(`group.${group.key}`))
    });

    for (const group of dictionary.groups) {
      const groupKey = `group.${group.key}`;
      byKey.set(groupKey, {
        identifier: id(groupKey),
        name: group.name,
        type: 'folder',
        location: `${NAMESPACE}:${ROOT_KEY}`,
        composition: group.points.map((point) => id(point.id))
      });

      for (const point of group.points) {
        byKey.set(point.id, telemetryObject(point, `${NAMESPACE}:${groupKey}`));
      }
    }

    return byKey;
  }

  function telemetryObject(point, location) {
    const value = {
      key: 'value',
      name: point.name,
      format: point.format,
      hints: { range: 1 }
    };
    if (point.units) value.units = point.units;
    if (point.min !== undefined) value.min = point.min;
    if (point.max !== undefined) value.max = point.max;
    const formatString = point.formatString ?? DEFAULT_FORMAT_STRINGS[point.format];
    if (formatString) value.formatString = formatString;

    return {
      identifier: { namespace: NAMESPACE, key: point.id },
      name: point.name,
      type: TELEMETRY_TYPE,
      location,
      telemetry: {
        values: [
          value,
          { key: 'utc', source: 'timestamp', name: 'Timestamp', format: 'utc', hints: { domain: 1 } }
        ]
      },
      ksp: point.limits ? { limits: point.limits } : undefined
    };
  }

  // --- Historical telemetry ---------------------------------------------------

  async function requestHistory(domainObject, options = {}) {
    const params = new URLSearchParams();
    if (options.start !== undefined) params.set('start', options.start);
    if (options.end !== undefined) params.set('end', options.end);
    if (options.strategy === 'latest') params.set('latest', '1');

    const url = `history/${encodeURIComponent(domainObject.identifier.key)}?${params}`;
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`History request for ${domainObject.identifier.key} failed: ${response.status}`);
    }
    return response.json();
  }

  // --- Realtime telemetry -----------------------------------------------------

  class RealtimeClient {
    constructor(url) {
      this.url = url;
      this.listeners = new Map(); // telemetry id -> Set of callbacks
      this.connectionListeners = new Set();
      this.connected = false;
      this.connect();
    }

    connect() {
      this.socket = new WebSocket(this.url);

      this.socket.addEventListener('open', () => {
        this.setConnected(true);
        for (const id of this.listeners.keys()) {
          this.send({ op: 'subscribe', id });
        }
      });

      this.socket.addEventListener('message', (event) => {
        for (const point of JSON.parse(event.data)) {
          this.listeners.get(point.id)?.forEach((callback) => callback(point));
        }
      });

      this.socket.addEventListener('close', () => {
        this.setConnected(false);
        setTimeout(() => this.connect(), 2000);
      });
    }

    setConnected(connected) {
      this.connected = connected;
      this.connectionListeners.forEach((callback) => callback(connected));
    }

    onConnectionChange(callback) {
      this.connectionListeners.add(callback);
    }

    send(message) {
      if (this.connected) {
        this.socket.send(JSON.stringify(message));
      }
    }

    subscribe(id, callback) {
      let callbacks = this.listeners.get(id);
      if (!callbacks) {
        callbacks = new Set();
        this.listeners.set(id, callbacks);
        this.send({ op: 'subscribe', id });
      }
      callbacks.add(callback);

      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0 && this.listeners.get(id) === callbacks) {
          this.listeners.delete(id);
          this.send({ op: 'unsubscribe', id });
        }
      };
    }
  }

  // --- Staleness --------------------------------------------------------------

  // In realtime mode, telemetry is stale when the browser has lost the bridge,
  // or the bridge has stopped hearing from KSP (game closed, not in the flight
  // scene, mod not installed...). The bridge's own status points only go stale
  // when the bridge itself is unreachable.
  class LinkMonitor {
    constructor(openmct, realtime) {
      this.openmct = openmct;
      this.realtime = realtime;
      this.receiving = false;
      this.subscribers = new Map(); // callback -> { id, lastStale }

      realtime.onConnectionChange(() => this.update());
      realtime.subscribe('bridge.link', (point) => {
        this.receiving = point.value === 'RECEIVING';
        this.update();
      });
      openmct.time.on('modeChanged', () => this.update());
    }

    isStale(id) {
      if (!this.openmct.time.isRealTime()) return false;
      if (!this.realtime.connected) return true;
      return !id.startsWith('bridge.') && !this.receiving;
    }

    // Open MCT parses the response time through the point's metadata, whose
    // time value is sourced from `timestamp`, so include it alongside `utc`.
    staleness(id) {
      const now = Date.now();
      return { isStale: this.isStale(id), utc: now, timestamp: now };
    }

    update() {
      for (const [callback, subscriber] of this.subscribers) {
        const response = this.staleness(subscriber.id);
        if (response.isStale !== subscriber.lastStale) {
          subscriber.lastStale = response.isStale;
          callback(response);
        }
      }
    }

    // Views fetch the initial state via isStale(); only changes are pushed.
    subscribe(id, callback) {
      this.subscribers.set(callback, { id, lastStale: this.isStale(id) });
      return () => this.subscribers.delete(callback);
    }
  }

  // --- Limits -----------------------------------------------------------------

  function limitEvaluator(limits) {
    return {
      evaluate(datum, valueMetadata) {
        const value = datum[valueMetadata?.key ?? 'value'];
        if (typeof value !== 'number') return undefined;

        for (const level of LIMIT_LEVELS) {
          const limit = limits[level.key];
          if (limit?.high !== undefined && value >= limit.high) {
            return { cssClass: `is-limit--upr is-limit--${level.color}`, name: `${level.name} High` };
          }
          if (limit?.low !== undefined && value <= limit.low) {
            return { cssClass: `is-limit--lwr is-limit--${level.color}`, name: `${level.name} Low` };
          }
        }
        return undefined;
      }
    };
  }

  function plotLimits(limits) {
    const result = {};
    for (const level of LIMIT_LEVELS) {
      const limit = limits[level.key];
      if (!limit) continue;
      result[level.key.toUpperCase()] = {};
      if (limit.high !== undefined) result[level.key.toUpperCase()].high = { color: level.color, value: limit.high };
      if (limit.low !== undefined) result[level.key.toUpperCase()].low = { color: level.color, value: limit.low };
    }
    return result;
  }

  window.KspPlugin = KspPlugin;
})();
