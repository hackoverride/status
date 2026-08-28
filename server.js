// Static file server + endpoint checker + logging API for the status board.
// Only external dependency: @azure/service-bus, for reading queue counts.
//
// Why checking happens here and not in the browser: browser JS can only get a
// real HTTP status code from a cross-origin URL if that server sends CORS
// headers allowing it - otherwise the response is "opaque" and looks reachable
// even when it's actually a Heroku crash/error page. A server-to-server
// request isn't subject to CORS at all, so this is also where we can read the
// real status code. It's also the only place that's safe to hold the Service
// Bus connection string. Checking here means services get checked and logged
// continuously, even if no browser tab is open.
//
// Everything configurable - the endpoints, the columns, the queues and the
// timings - comes from .env, loaded by config.js. Copy .env.example to .env
// first. The browser gets the same configuration from GET /api/config, so
// there is one source of truth for both sides.
//
// Run with:  node server.js
// Then open: http://localhost:8080 (or whatever PORT says)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { ServiceBusAdministrationClient } = require("@azure/service-bus");
// Requiring config.js is also what loads .env into process.env, so it has to
// happen before anything reads process.env (the Service Bus connection string).
const {
  ENDPOINTS,
  QUEUES,
  COLUMNS,
  PORT,
  REFRESH_INTERVAL_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  HISTORY_POINTS,
  RETENTION_DAYS,
  endpointId,
} = require("./config.js");

const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, "logs");
const STATE_FILE = path.join(LOGS_DIR, "state.json");
const DOWNTIME_LOG = path.join(LOGS_DIR, "downtime.log");
const RESPONSE_TIMES_FILE = path.join(LOGS_DIR, "response-times.jsonl");

const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

// --- the configuration the page needs, served at /api/config ---
//
// app.js used to get this from a <script src="config.js"> tag. Now that the
// configuration lives in .env, which the browser can't read, the server hands
// over just the display half of it. Deliberately not included: the Service Bus
// connection string, and the timeout/retention settings, which only matter
// server-side.

const PAGE_CONFIG = {
  columns: COLUMNS,
  endpoints: ENDPOINTS.map(({ name, service, column, category, url }) => ({
    id: endpointId(name),
    name,
    service,
    column,
    category,
    url,
  })),
  queues: QUEUES.map(({ name }) => ({ name })),
  refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
  historyPoints: HISTORY_POINTS,
};

// --- check one endpoint for real, reading its actual HTTP status code ---

async function checkEndpoint(url, expectedStatus) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SECONDS * 1000);
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

// --- check every configured endpoint, keep the latest results in memory, log them ---
//
// Each result carries its own id/service/column, so the page can match results
// to matrix cells without relying on this array staying in ENDPOINTS order.

let latestStatus = { checkedAt: null, results: [] };

async function checkAll() {
  const results = await Promise.all(
    ENDPOINTS.map(async (endpoint) => ({
      id: endpointId(endpoint.name),
      name: endpoint.name,
      service: endpoint.service,
      column: endpoint.column,
      category: endpoint.category,
      url: endpoint.url,
      ...(await checkEndpoint(endpoint.url, endpoint.expectedStatus)),
    }))
  );

  latestStatus = { checkedAt: new Date().toISOString(), results };
  recordResults(results);
}

// --- check Azure Service Bus queue depths, if configured ---

const serviceBusAdminClient = createServiceBusAdminClient();

function createServiceBusAdminClient() {
  if (!process.env.SERVICE_BUS_CONNECTION_STRING) {
    console.log("SERVICE_BUS_CONNECTION_STRING not set in .env - skipping queue checks.");
    return null;
  }

  try {
    return new ServiceBusAdministrationClient(process.env.SERVICE_BUS_CONNECTION_STRING);
  } catch (err) {
    console.log(`SERVICE_BUS_CONNECTION_STRING is invalid, skipping queue checks: ${err.message}`);
    return null;
  }
}

let latestQueues = { checkedAt: null, results: [] };

async function checkQueues() {
  if (!serviceBusAdminClient) return;

  const results = await Promise.all(
    QUEUES.map(async ({ name, queueName }) => {
      try {
        const props = await serviceBusAdminClient.getQueueRuntimeProperties(queueName);
        return {
          name,
          queueName,
          ok: true,
          activeMessageCount: props.activeMessageCount,
          deadLetterMessageCount: props.deadLetterMessageCount,
          scheduledMessageCount: props.scheduledMessageCount,
        };
      } catch (err) {
        return { name, queueName, ok: false, error: err.message };
      }
    })
  );

  latestQueues = { checkedAt: new Date().toISOString(), results };
}

// --- per-service state (up/down + since timestamp), persisted across restarts ---

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

function recordResults(results) {
  const now = new Date();
  const nowIso = now.toISOString();

  for (const { name, url, up, ms, statusCode } of results) {
    const previous = state[name];
    const newStatus = up ? "up" : "down";

    if (!previous) {
      state[name] = { status: newStatus, since: nowIso };
    } else if (previous.status !== newStatus) {
      if (newStatus === "up") {
        const downtimeMs = now.getTime() - new Date(previous.since).getTime();
        appendLine(
          DOWNTIME_LOG,
          `${nowIso} UP   "${name}" (${url}) - status ${statusCode}, down since ${previous.since}, downtime ${formatDuration(downtimeMs)}`
        );
      } else {
        appendLine(DOWNTIME_LOG, `${nowIso} DOWN "${name}" (${url}) - status ${statusCode}`);
      }
      state[name] = { status: newStatus, since: nowIso };
    }

    appendLine(RESPONSE_TIMES_FILE, JSON.stringify({ ts: nowIso, name, ms: typeof ms === "number" ? ms : null, statusCode }));
  }

  saveState();
}

// --- read back recent history per service, for the card sparklines ---

function readHistory(limit) {
  if (!fs.existsSync(RESPONSE_TIMES_FILE)) return {};

  const lines = fs.readFileSync(RESPONSE_TIMES_FILE, "utf8").split("\n").filter(Boolean);
  const byService = {};

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!byService[entry.name]) byService[entry.name] = [];
    byService[entry.name].push({ ts: entry.ts, ms: entry.ms, statusCode: entry.statusCode });
  }

  for (const name of Object.keys(byService)) {
    byService[name] = byService[name].slice(-limit);
  }

  return byService;
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

  // .env lives in ROOT, so serving dotfiles would hand out the connection
  // string and every internal URL to anyone who can reach the board.
  const isDotFile = path.relative(ROOT, filePath).split(path.sep).some((part) => part.startsWith("."));

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

  if (req.method === "GET" && req.url.startsWith("/api/history")) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const limit = Number(parsedUrl.searchParams.get("limit")) || 50;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readHistory(limit)));
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

checkAll();
setInterval(checkAll, REFRESH_INTERVAL_SECONDS * 1000);

checkQueues();
setInterval(checkQueues, REFRESH_INTERVAL_SECONDS * 1000);

server.listen(PORT, () => {
  console.log(`Status board running at http://localhost:${PORT}`);
});
