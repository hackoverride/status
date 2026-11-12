// Static file server + status checker + logging API for the status board.
// Only external dependency: @azure/service-bus, for reading queue counts.
//
// Where the status comes from:
// - Kubernetes clusters (K8S_CLUSTER_<n>): read straight from the cluster's
//   API by kubernetes.js - which Deployments/StatefulSets exist and whether
//   their pods are ready. Services appear and disappear on their own.
// - Everything else (ENDPOINT_<n>): an HTTP request to a health URL.
//
// Why checking happens here and not in the browser: browser JS can only get a
// real HTTP status code from a cross-origin URL if that server sends CORS
// headers allowing it - otherwise the response is "opaque" and looks reachable
// even when it's actually a Heroku crash/error page. A server-to-server
// request isn't subject to CORS at all. It's also the only place that's safe
// to hold the cluster tokens and Service Bus connection strings. Checking here
// means services get checked and logged continuously, even if no browser tab
// is open.
//
// Everything configurable - the clusters, endpoints, sections, Service Bus
// namespaces and timings - comes from .env, loaded by config.js. Copy
// .env.example to .env first. The browser gets the display half from
// GET /api/config, so there is one source of truth for both sides.
//
// Run with:  node server.js
// Then open: http://localhost:8080 (or whatever PORT says)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { ServiceBusAdministrationClient } = require("@azure/service-bus");
// Requiring config.js is also what loads .env into process.env, so it has to
// happen before anything reads process.env.
const {
  ENDPOINTS,
  CLUSTERS,
  SERVICE_BUSES,
  SECTIONS,
  PORT,
  REFRESH_INTERVAL_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  HISTORY_HOURS,
  HISTORY_BAR_MINUTES,
  RETENTION_DAYS,
  endpointId,
} = require("./config.js");
const { readCluster } = require("./kubernetes.js");

const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, "logs");
const STATE_FILE = path.join(LOGS_DIR, "state.json");
const DOWNTIME_LOG = path.join(LOGS_DIR, "downtime.log");
const RESPONSE_TIMES_FILE = path.join(LOGS_DIR, "response-times.jsonl");

const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = REQUEST_TIMEOUT_SECONDS * 1000;
const BAR_MS = HISTORY_BAR_MINUTES * 60 * 1000;
const BAR_COUNT = (HISTORY_HOURS * 60) / HISTORY_BAR_MINUTES;

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

// --- the configuration the page needs, served at /api/config ---
//
// Deliberately not included: cluster tokens, connection strings, and the
// timeout/retention settings, which only matter server-side. The services
// themselves aren't in here either - cluster workloads come and go, so the
// page builds its lists from /api/status instead.

const PAGE_CONFIG = {
  // `cluster` lets the page give cluster sections - the long lists - the
  // wide columns, and put the short ones beside the queues.
  sections: SECTIONS.map((section) => ({
    ...section,
    cluster: CLUSTERS.some((cluster) => cluster.section === section.key),
  })),
  queueNamespaces: SERVICE_BUSES.map(({ label }) => ({ label })),
  refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
  historyHours: HISTORY_HOURS,
};

// --- check one endpoint for real, reading its actual HTTP status code ---

async function checkEndpoint(url, expectedStatus) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(url, { signal: controller.signal });
    return { up: response.status === expectedStatus, statusCode: response.status, ms: Date.now() - start };
  } catch (err) {
    return { up: false, statusCode: err.name === "AbortError" ? "timeout" : "error", ms: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Every result, endpoint or cluster workload, has the same shape so the page
// and the logging below treat them alike:
//   id, name  - stable identity; `name` is also the history and state key
//   label     - what the page shows as the service's name
//   section   - which SECTION_<n> it's listed under
//   target    - what was checked, for the logs
//   level     up | down | idle (scaled to 0) | unknown (cluster unreachable)
//   note      short detail shown under the name, e.g. "1/2 pods ready"
//   tooltip   hover text
//   ms        response time, endpoints only
// checkAll() then adds `since`: when the current level started.

async function checkEndpointResult(endpoint) {
  const { up, statusCode, ms } = await checkEndpoint(endpoint.url, endpoint.expectedStatus);

  return {
    id: endpointId(endpoint.name),
    name: endpoint.name,
    label: endpoint.name,
    section: endpoint.section,
    target: endpoint.url,
    level: up ? "up" : "down",
    // A bare "HTTP 200" under a red dot reads as a bug, so say what was wanted.
    note: up
      ? `${ms} ms`
      : typeof statusCode === "number"
        ? `HTTP ${statusCode}, expected ${endpoint.expectedStatus}`
        : `no response (${statusCode})`,
    tooltip: `${endpoint.name}\n${endpoint.url}`,
    ms,
  };
}

// --- read every cluster ---
//
// If a cluster can't be read (network, expired token), its workloads must not
// silently vanish from the board. So the last successful read is kept, and
// re-shown greyed out as "no data" with the error, until the cluster answers
// again. That also keeps them out of the downtime log and the history bars -
// we don't know they're down, only that we can't see them.

const lastClusterResults = new Map();

async function checkCluster(cluster) {
  try {
    const workloads = await readCluster(cluster, TIMEOUT_MS);

    // The same workload name in two namespaces would read as one service
    // listed twice, so only those get their namespace added.
    const nameCounts = new Map();
    workloads.forEach(({ name }) => nameCounts.set(name, (nameCounts.get(name) || 0) + 1));

    const results = workloads.map((workload) => {
      const name = `${cluster.section}: ${workload.namespace}/${workload.name}`;
      return {
        id: endpointId(name),
        name,
        label: nameCounts.get(workload.name) > 1 ? `${workload.name} (${workload.namespace})` : workload.name,
        section: cluster.section,
        target: `${cluster.section} cluster ${workload.kind} ${workload.namespace}/${workload.name}`,
        level: workload.level,
        note: workload.note,
        tooltip: workload.tooltip,
        ms: null,
      };
    });

    lastClusterResults.set(cluster.envKey, results);
    return { results, error: null };
  } catch (err) {
    const stale = (lastClusterResults.get(cluster.envKey) || []).map((result) => ({
      ...result,
      level: "unknown",
      note: "no data",
      tooltip: `${result.tooltip}\n\nCluster unreachable: ${err.message}`,
    }));
    return { results: stale, error: err.message };
  }
}

// --- check everything, keep the latest results in memory, log them ---
//
// Each result carries its own id and section, so the page can match results
// to rows without relying on the order of this array.

let latestStatus = { checkedAt: null, results: [], sectionErrors: {} };

async function checkAll() {
  const [endpointResults, clusterChecks] = await Promise.all([
    Promise.all(ENDPOINTS.map(checkEndpointResult)),
    Promise.all(CLUSTERS.map(checkCluster)),
  ]);

  const sectionErrors = {};
  CLUSTERS.forEach((cluster, index) => {
    if (clusterChecks[index].error) {
      sectionErrors[cluster.section] = clusterChecks[index].error;
      console.log(`Cluster ${cluster.envKey} (${cluster.section}) unreachable: ${clusterChecks[index].error}`);
    }
  });

  const results = [...endpointResults, ...clusterChecks.flatMap((check) => check.results)];
  recordResults(results);

  latestStatus = {
    checkedAt: new Date().toISOString(),
    results: results.map((result) => ({ ...result, since: state[result.name]?.since || null })),
    sectionErrors,
  };
}

// --- list every queue in each Azure Service Bus namespace ---

const serviceBusNamespaces = SERVICE_BUSES.map(({ label, connectionString }) => {
  try {
    return { label, client: new ServiceBusAdministrationClient(connectionString), setupError: null };
  } catch (err) {
    console.log(`${label}: Service Bus connection string is invalid: ${err.message}`);
    return { label, client: null, setupError: `Invalid connection string: ${err.message}` };
  }
});

// Same idea as lastClusterResults: a failed read keeps showing the last
// counts, flagged with the error, rather than an empty list.
const lastQueues = new Map();

async function readNamespace({ label, client, setupError }) {
  if (!client) return { label, error: setupError, queues: [] };

  try {
    const queues = [];
    for await (const props of client.listQueuesRuntimeProperties()) {
      queues.push({
        name: props.name,
        active: props.activeMessageCount,
        deadLetter: props.deadLetterMessageCount,
        transferDeadLetter: props.transferDeadLetterMessageCount,
        scheduled: props.scheduledMessageCount,
      });
    }

    lastQueues.set(label, queues);
    return { label, error: null, queues };
  } catch (err) {
    console.log(`${label}: could not list queues: ${err.message}`);
    return { label, error: err.message, queues: lastQueues.get(label) || [] };
  }
}

let latestQueues = { checkedAt: null, namespaces: [] };

async function checkQueues() {
  if (!serviceBusNamespaces.length) return;

  const namespaces = await Promise.all(serviceBusNamespaces.map(readNamespace));
  latestQueues = { checkedAt: new Date().toISOString(), namespaces };
}

// --- per-service state (level + since timestamp), persisted across restarts ---

let state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendLine(file, line) {
  fs.appendFileSync(file, line + "\n");
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// --- record one batch of check results ---
//
// Every change of level goes into downtime.log; coming back up also says how
// long it was out. "unknown" results are skipped - see checkCluster().

function recordResults(results) {
  const now = new Date();
  const nowIso = now.toISOString();

  for (const { name, target, level, note, ms } of results) {
    if (level === "unknown") continue;

    const previous = state[name];

    if (!previous) {
      state[name] = { status: level, since: nowIso };
    } else if (previous.status !== level) {
      let line = `${nowIso} ${level.toUpperCase().padEnd(4)} "${name}" (${target})${note ? ` - ${note}` : ""}`;
      if (level === "up") {
        const outageMs = now.getTime() - new Date(previous.since).getTime();
        line += `, ${previous.status} since ${previous.since}, for ${formatDuration(outageMs)}`;
      }
      appendLine(DOWNTIME_LOG, line);
      state[name] = { status: level, since: nowIso };
    }

    const point = { ts: nowIso, name, ms: typeof ms === "number" ? ms : null, level };
    appendLine(RESPONSE_TIMES_FILE, JSON.stringify(point));
    countInBar(point);
  }

  saveState();
}

// --- history bars: up/down check counts per HISTORY_BAR_MINUTES segment ---
//
// name -> Map(segment start ms -> { up, down }). Only the last HISTORY_HOURS
// are kept, in memory, seeded once from response-times.jsonl at startup. A
// segment with any down check is drawn red, and stays red for the whole
// HISTORY_HOURS - the page never infers status from response times.
//
// Segments line up with the clock (10:00, 10:30, ...) so the bars don't shift
// sideways between refreshes. The last one is the segment in progress.

const barsByName = new Map();

function barStart(ms) {
  return Math.floor(ms / BAR_MS) * BAR_MS;
}

function windowStart(now = Date.now()) {
  return barStart(now) - (BAR_COUNT - 1) * BAR_MS;
}

function countInBar({ ts, name, level }) {
  if (level !== "up" && level !== "down") return;

  const start = barStart(Date.parse(ts));
  if (start < windowStart()) return;

  if (!barsByName.has(name)) barsByName.set(name, new Map());
  const bars = barsByName.get(name);
  if (!bars.has(start)) bars.set(start, { up: 0, down: 0 });
  bars.get(start)[level] += 1;
}

function dropOldBars() {
  const cutoff = windowStart();
  for (const bars of barsByName.values()) {
    for (const start of bars.keys()) if (start < cutoff) bars.delete(start);
  }
}

// Lines written before levels were logged only have the HTTP status code, and
// the old page judged them by response time alone - which drew a crashed app's
// fast 503 page as a green bar. Judge them by the endpoint's expectedStatus.
const expectedStatusByName = new Map(ENDPOINTS.map(({ name, expectedStatus }) => [name, expectedStatus]));

function levelOf(entry) {
  if (entry.level) return entry.level;
  if (expectedStatusByName.has(entry.name)) {
    return entry.statusCode === expectedStatusByName.get(entry.name) ? "up" : "down";
  }
  return entry.ms === null ? "down" : "up";
}

function loadBarsFromLog() {
  if (!fs.existsSync(RESPONSE_TIMES_FILE)) return;

  const cutoff = windowStart();
  for (const line of fs.readFileSync(RESPONSE_TIMES_FILE, "utf8").split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (Date.parse(entry.ts) < cutoff) continue;
    countInBar({ ts: entry.ts, name: entry.name, level: levelOf(entry) });
  }
}

// What GET /api/history serves: the window's segment start times, and per
// service an array of [up, down] check counts, one per segment ([0, 0] = no
// checks, e.g. before the service existed).
function historyPayload() {
  dropOldBars();
  const start = windowStart();
  const byName = {};

  for (const [name, bars] of barsByName) {
    byName[name] = Array.from({ length: BAR_COUNT }, (_, i) => {
      const counts = bars.get(start + i * BAR_MS);
      return counts ? [counts.up, counts.down] : [0, 0];
    });
  }

  return {
    start,
    hours: HISTORY_HOURS,
    barMinutes: HISTORY_BAR_MINUTES,
    checkSeconds: REFRESH_INTERVAL_SECONDS,
    byName,
  };
}

// --- keep response-times.jsonl limited to the last RETENTION_DAYS ---

function pruneResponseTimes() {
  if (!fs.existsSync(RESPONSE_TIMES_FILE)) return;

  const cutoff = Date.now() - RETENTION_MS;
  const lines = fs.readFileSync(RESPONSE_TIMES_FILE, "utf8").split("\n").filter(Boolean);

  const kept = lines.filter((line) => {
    try {
      return new Date(JSON.parse(line).ts).getTime() >= cutoff;
    } catch {
      return false;
    }
  });

  if (kept.length !== lines.length) {
    fs.writeFileSync(RESPONSE_TIMES_FILE, kept.length ? kept.join("\n") + "\n" : "");
  }
}

// --- static file serving ---

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(ROOT, urlPath === "/" ? "index.html" : urlPath));

  // .env lives in ROOT, so serving dotfiles would hand out the cluster tokens,
  // connection strings and every internal URL to anyone who can reach the board.
  const isDotFile = path
    .relative(ROOT, filePath)
    .split(path.sep)
    .some((part) => part.startsWith("."));

  if (!filePath.startsWith(ROOT) || isDotFile) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// --- request router ---

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(PAGE_CONFIG));
    return;
  }

  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(latestStatus));
    return;
  }

  if (req.method === "GET" && req.url === "/api/history") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(historyPayload()));
    return;
  }

  if (req.method === "GET" && req.url === "/api/queues") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(latestQueues));
    return;
  }

  serveStatic(req, res);
});

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
pruneResponseTimes();
setInterval(pruneResponseTimes, 24 * 60 * 60 * 1000);
loadBarsFromLog();

if (!CLUSTERS.length) console.log("No K8S_CLUSTER_<n> in .env - cluster sections will only list endpoints.");
if (!SERVICE_BUSES.length) console.log("No SERVICE_BUS_<n> in .env - skipping queue checks.");

checkAll();
setInterval(checkAll, REFRESH_INTERVAL_SECONDS * 1000);

checkQueues();
setInterval(checkQueues, REFRESH_INTERVAL_SECONDS * 1000);

server.listen(PORT, () => {
  console.log(`Status board running at http://localhost:${PORT}`);
});
