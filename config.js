// Reads the whole status-board configuration out of .env (or the real
// environment) and hands it to server.js as plain objects.
//
// This module is Node-only. The browser no longer loads it - it gets the same
// configuration from GET /api/config, which server.js builds from here.
//
// Layout model: the status page is a MATRIX.
//   - each ROW is one service, identified by `service`
//   - each COLUMN is one place that service can run (see COLUMN_<n> below)
// So "Notification Service" on Heroku and the same service on the DEMO
// Kubernetes cluster share a row, and you read across to compare them.
//
// --- .env format ---------------------------------------------------------
//
// Plain KEY=VALUE lines. List entries are numbered and hold their own
// `field=value` pairs separated by semicolons, so field order doesn't matter
// and optional fields can just be left out:
//
//   COLUMN_1=key=current; label=Current; sublabel=Heroku
//   ENDPOINT_1=name=Auth Service; url=https://.../health; category=Core Services
//   QUEUE_1=name=Orders; queueName=orders
//
// Numbering only sets the order they're read in; gaps are fine. Values must
// not contain a semicolon (it separates fields) or a newline.
//
// ENDPOINT_<n> fields:
// - name:           REQUIRED. Unique identity for this ONE endpoint. Used as
//                   the key for uptime state and response-time history, so
//                   renaming an existing entry orphans its logged history.
// - url:            REQUIRED. Address to check.
// - service:        the row this endpoint belongs to. Defaults to `name`.
//                   Set it explicitly to put two endpoints on the same row.
// - column:         which column it appears in - must match a COLUMN_<n> key.
//                   Defaults to 'current'.
// - category:       row group heading. Taken from the first endpoint of a
//                   service, so keep it the same across a service's entries.
//                   Defaults to 'Other'.
// - expectedStatus: HTTP status code that counts as "up". Defaults to 200.
//
// Category sections appear in the order the first service of that category
// appears in the list. Rows are then sorted alphabetically within a category
// and never move, so a service going down turns its cell red in place.
//
// COLUMN_<n> fields: key (REQUIRED), label (REQUIRED), sublabel (optional).
// `key` is what an endpoint's `column` field refers to; `label` is the column
// heading on the page.
//
// QUEUE_<n> fields: name (REQUIRED, the label on the card) and queueName
// (REQUIRED, the actual queue name in the Service Bus namespace). Queue counts
// also need SERVICE_BUS_CONNECTION_STRING; without it the section is skipped.

const fs = require("fs");
const path = require("path");

// --- load .env (KEY=VALUE per line) into process.env, if present ----------
//
// Real environment variables win, so a value set in the shell or by systemd
// overrides the file rather than the other way round.

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

// --- generic env readers --------------------------------------------------

function readNumber(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`.env: ${key} must be a number, got "${raw}".`);
  }
  return value;
}

// Every KEY that looks like PREFIX_<number>, in numeric order. Gaps are fine -
// the numbers only decide the order, they aren't an index into anything.
function numberedKeys(prefix) {
  const pattern = new RegExp(`^${prefix}_(\\d+)$`);

  return Object.keys(process.env)
    .map((key) => ({ key, match: key.match(pattern) }))
    .filter(({ match }) => match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map(({ key }) => key);
}

// "name=Auth Service; url=https://...; expectedStatus=200" -> object.
// Split on the FIRST "=" of each field so values may contain "=" themselves.
function parseFields(key, raw) {
  const entry = {};

  for (const part of raw.split(";")) {
    const field = part.trim();
    if (!field) continue;

    const eqIndex = field.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`.env: ${key} has field "${field}" with no "=" - expected name=value.`);
    }

    entry[field.slice(0, eqIndex).trim()] = field.slice(eqIndex + 1).trim();
  }

  return entry;
}

// Read every PREFIX_<n> into an object, checking the fields that must be there.
function readEntries(prefix, requiredFields) {
  return numberedKeys(prefix).map((key) => {
    const entry = parseFields(key, process.env[key]);

    for (const field of requiredFields) {
      if (!entry[field]) throw new Error(`.env: ${key} is missing required field "${field}".`);
    }

    return entry;
  });
}

// --- the configuration itself ---------------------------------------------

// The columns of the matrix, left to right.
const COLUMNS = readEntries("COLUMN", ["key", "label"]).map(({ key, label, sublabel }) => ({
  key,
  label,
  ...(sublabel ? { sublabel } : {}),
}));

const COLUMN_KEYS = new Set(COLUMNS.map((column) => column.key));

const ENDPOINTS = readEntries("ENDPOINT", ["name", "url"]).map((entry) => {
  const column = entry.column || "current";
  if (!COLUMN_KEYS.has(column)) {
    throw new Error(
      `.env: endpoint "${entry.name}" is in column "${column}", which is not one of the ` +
        `configured COLUMN_<n> keys (${[...COLUMN_KEYS].join(", ") || "none"}).`
    );
  }

  const expectedStatus = entry.expectedStatus === undefined ? 200 : Number(entry.expectedStatus);
  if (!Number.isFinite(expectedStatus)) {
    throw new Error(`.env: endpoint "${entry.name}" has a non-numeric expectedStatus "${entry.expectedStatus}".`);
  }

  return {
    name: entry.name,
    url: entry.url,
    service: entry.service || entry.name,
    column,
    category: entry.category || "Other",
    expectedStatus,
  };
});

// Azure Service Bus queues to show message counts for.
const QUEUES = readEntries("QUEUE", ["name", "queueName"]).map(({ name, queueName }) => ({ name, queueName }));

const PORT = readNumber("PORT", 8080);

// How often to re-check everything, in seconds.
const REFRESH_INTERVAL_SECONDS = readNumber("REFRESH_INTERVAL_SECONDS", 60);

// How long to wait for a single endpoint before marking it unreachable, in seconds.
const REQUEST_TIMEOUT_SECONDS = readNumber("REQUEST_TIMEOUT_SECONDS", 5);

// How many past checks to show in each card's history sparkline.
const HISTORY_POINTS = readNumber("HISTORY_POINTS", 50);

// How long response-times.jsonl is kept before old lines are pruned.
const RETENTION_DAYS = readNumber("RETENTION_DAYS", 10);

// Stable per-endpoint id, derived from `name`. The page matches check results
// back to cells by this id rather than by list position, so reordering or
// re-sorting entries can never make a card show another service's status.
function endpointId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = {
  ENDPOINTS,
  COLUMNS,
  QUEUES,
  endpointId,
  PORT,
  REFRESH_INTERVAL_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  HISTORY_POINTS,
  RETENTION_DAYS,
};
