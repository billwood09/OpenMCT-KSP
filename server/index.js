// Bridge between KSP telemetry sources and Open MCT.
//
//   GET  /                        Open MCT app (public/)
//   GET  /dictionary.json         telemetry dictionary
//   GET  /history/:id?start&end   samples in [start, end] (ms since epoch); &latest=1 for the newest only
//   WS   /realtime                client sends {"op": "subscribe" | "unsubscribe", "id": "..."},
//                                 server pushes arrays of {id, timestamp, value}
//   POST /ingest                  {"values": {id: value, ...}, "timestamp"?: ms, "source"?: name}
//                                 for external sources such as krpc/bridge.py

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { HistoryStore } from './history.js';
import { createFakeSource } from './sources/fake.js';
import { createTelemachusSource } from './sources/telemachus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINK_TIMEOUT_MS = 2000;

const USAGE = `Usage: node server/index.js [options]

  --source <fake|telemachus|ingest>  where telemetry comes from (default: fake)
  --host <addr>                      interface to listen on (default: 127.0.0.1; use 0.0.0.0 for LAN)
  --port <n>                         HTTP/WebSocket port (default: 8090)
  --telemachus-url <url>             Telemachus datalink (default: ws://127.0.0.1:8085/datalink)
  --rate-ms <n>                      sample interval for fake/telemachus (default: 100)
  --sim-speed <n>                    fake source time multiplier (default: 2)
  --history-limit <n>                samples kept per telemetry point (default: 18000)`;

const { values: args } = parseArgs({
  options: {
    source: { type: 'string', default: 'fake' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8090' },
    'telemachus-url': { type: 'string', default: 'ws://127.0.0.1:8085/datalink' },
    'rate-ms': { type: 'string', default: '100' },
    'sim-speed': { type: 'string', default: '2' },
    'history-limit': { type: 'string', default: '18000' },
    help: { type: 'boolean', short: 'h' }
  }
});

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

const dictionary = JSON.parse(readFileSync(path.join(ROOT, 'dictionary.json'), 'utf8'));
const points = new Map(dictionary.groups.flatMap((group) => group.points).map((p) => [p.id, p]));
const history = new HistoryStore(Number(args['history-limit']));

// --- Telemetry fan-out --------------------------------------------------------

const clients = new Set();
let lastDataAt = 0;
let sourceName = 'none';

function normalize(id, raw) {
  const point = points.get(id);
  if (!point) return undefined;
  if (point.format === 'string') return raw == null ? undefined : String(raw);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return point.format === 'integer' ? Math.round(raw) : raw;
}

function record(values, timestamp) {
  const batch = [];
  const rejected = [];
  for (const [id, raw] of Object.entries(values)) {
    const value = normalize(id, raw);
    if (value === undefined) {
      rejected.push(id);
    } else {
      batch.push({ id, timestamp, value });
    }
  }

  for (const point of batch) history.add(point);

  for (const client of clients) {
    const subscribed = batch.filter((point) => client.subscriptions.has(point.id));
    if (subscribed.length > 0 && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(subscribed));
    }
  }

  return { accepted: batch.length, rejected };
}

// Entry point for every telemetry source.
function publish(values, timestamp = Date.now()) {
  const result = record(values, timestamp);
  if (result.accepted > 0) lastDataAt = Date.now();
  return result;
}

// Bridge health, so a dashboard can show whether KSP is actually talking to us.
setInterval(() => {
  const receiving = Date.now() - lastDataAt < LINK_TIMEOUT_MS;
  record({ 'bridge.source': sourceName, 'bridge.link': receiving ? 'RECEIVING' : 'NO DATA' }, Date.now());
}, 1000);

// --- HTTP ---------------------------------------------------------------------

const app = express();

app.get('/dictionary.json', (req, res) => res.sendFile(path.join(ROOT, 'dictionary.json')));

app.get('/history/:id', (req, res) => {
  const { id } = req.params;
  if (!points.has(id)) {
    return res.status(404).json({ error: `unknown telemetry point "${id}"` });
  }
  const start = Number(req.query.start ?? 0);
  const end = Number(req.query.end ?? Date.now());
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return res.status(400).json({ error: 'start and end must be numbers (ms since epoch)' });
  }
  res.json(history.query(id, start, end, { latest: req.query.latest === '1' }));
});

app.post('/ingest', express.json({ limit: '256kb' }), (req, res) => {
  const { values, timestamp, source } = req.body ?? {};
  if (!values || typeof values !== 'object') {
    return res.status(400).json({ error: 'expected a JSON body like {"values": {"flight.altitude": 1234}}' });
  }
  if (typeof source === 'string') sourceName = source;
  res.json(publish(values, Number.isFinite(timestamp) ? timestamp : Date.now()));
});

app.use('/openmct', express.static(path.join(ROOT, 'node_modules/openmct/dist')));
app.use(express.static(path.join(ROOT, 'public')));

// --- WebSocket ----------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (socket) => {
  const client = { socket, subscriptions: new Set() };
  clients.add(client);

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.op === 'subscribe' && points.has(message.id)) {
      client.subscriptions.add(message.id);
    } else if (message.op === 'unsubscribe') {
      client.subscriptions.delete(message.id);
    }
  });

  socket.on('close', () => clients.delete(client));
});

// --- Source -------------------------------------------------------------------

const rateMs = Number(args['rate-ms']);
let source;

switch (args.source) {
  case 'fake':
    source = createFakeSource({ publish, rateMs, simSpeed: Number(args['sim-speed']), log });
    break;
  case 'telemachus':
    source = createTelemachusSource({ url: args['telemachus-url'], rateMs, publish, log });
    break;
  case 'ingest':
    source = { name: 'External', stop() {} };
    log('waiting for telemetry on POST /ingest (e.g. python krpc/bridge.py)');
    break;
  default:
    console.error(`Unknown --source "${args.source}"\n\n${USAGE}`);
    process.exit(1);
}
sourceName = source.name;

server.listen(Number(args.port), args.host, () => {
  log(`Open MCT ready at http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}`);
});

process.on('SIGINT', () => {
  source.stop();
  server.close();
  process.exit(0);
});
