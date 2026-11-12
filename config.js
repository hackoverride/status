// Reads the whole status-board configuration out of .env (or the real
// environment) and hands it to server.js as plain objects.
//
// This module is Node-only. The browser no longer loads it - it gets the
// display half of the configuration from GET /api/config, which server.js
// builds from here.
//
// Layout model: the status page is a LIST, Uptime Robot style.
//   - SECTION_<n> entries are the blocks on the page, in order: e.g. Prod,
//     Demo, Heroku
//   - each section lists one line per service: status dot, name, how long
//     it's been up or down, a bar of the last HISTORY_HOURS, and uptime %
// Services come from two sources:
//   - K8S_CLUSTER_<n>: every Deployment and StatefulSet in that cluster shows
//     up on its own - nothing to list per service.
//   - ENDPOINT_<n>: plain HTTP checks, for whatever doesn't run in a cluster
//     (the remaining Heroku apps). These can go in any section, including one
//     a cluster fills.
//
// --- .env format ---------------------------------------------------------
//
// Plain KEY=VALUE lines. List entries are numbered and hold their own
// `field=value` pairs separated by semicolons, so field order doesn't matter
// and optional fields can just be left out:
//
//   SECTION_1=key=prod; label=Prod; sublabel=AKS
//   K8S_CLUSTER_1=section=prod; server=https://...azmk8s.io:443
//   ENDPOINT_1=name=Auth Service; url=https://.../health; section=heroku
//   SERVICE_BUS_1=label=my-namespace-dev
//
// Numbering only sets the order they're read in; gaps are fine. Values must
// not contain a semicolon (it separates fields) or a newline. Secrets that do
// contain semicolons - Service Bus connection strings - therefore get a line
// of their own, e.g. SERVICE_BUS_1_CONNECTION_STRING=..., read verbatim.
//
// SECTION_<n> fields: key (REQUIRED), label (REQUIRED), sublabel (optional).
// `key` is what a cluster's or endpoint's `section` field refers to; `label`
// is the section heading on the page.
//
// K8S_CLUSTER_<n> fields:
// - section:           REQUIRED. The SECTION_<n> key this cluster's services
//                      are listed under. One cluster per section.
// - server:            REQUIRED. API server address, https://...:443.
// - namespaces:        comma-separated. Only show workloads in these
//                      namespaces. Default: every namespace except the
//                      system ones in SYSTEM_NAMESPACES below.
// - excludeNamespaces: comma-separated. Hide these as well as the system ones.
//                      Ignored when `namespaces` is set.
// plus two lines of their own, both REQUIRED:
// - K8S_CLUSTER_<n>_TOKEN: the read-only ServiceAccount's token
// - K8S_CLUSTER_<n>_CA:    the cluster's CA certificate, base64 - exactly as
//                          the token secret's `ca.crt` field holds it
// k8s/README.md shows how to create the account and print all three lines.
// A cluster whose _TOKEN or _CA is still empty is skipped, not an error.
//
// Exception, for trying the board before the ServiceAccount exists: a server
// on http://localhost or http://127.0.0.1 is taken to be `kubectl proxy`
// running on this machine, which adds your own login itself. No _TOKEN or _CA
// needed then - see "Trying it first" in k8s/README.md.
//
// ENDPOINT_<n> fields:
// - name:           REQUIRED. Unique identity for this ONE endpoint, and the
//                   name shown on the page. Also the key for its uptime state
//                   and logged history, so renaming an entry orphans its
//                   history.
// - url:            REQUIRED. Address to check.
// - section:        REQUIRED. Which SECTION_<n> key it's listed under.
// - expectedStatus: HTTP status code that counts as "up". Defaults to 200.
//
// Services are listed alphabetically within a section and never move, so a
// service going down turns red in place.
//
// SERVICE_BUS_<n> fields: label (REQUIRED, shown next to each of that
// namespace's queues), plus SERVICE_BUS_<n>_CONNECTION_STRING (REQUIRED) on a
// line of its own. Every queue in the namespace is listed automatically. An
// empty connection string skips that namespace.

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

// Entries whose secret lines are still empty - as copied from .env.example,
// before k8s/README.md has been followed - are skipped with a note instead of
// stopping the server, so the rest of the board works in the meantime.
function hasSecrets(envKey, suffixes) {
  const missing = suffixes.map((suffix) => `${envKey}_${suffix}`).filter((key) => !process.env[key]);
  if (missing.length) console.log(`.env: ${missing.join(" and ")} not filled in yet - skipping ${envKey}.`);
  return missing.length === 0;
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
// `envKey` is the line it came from, e.g. "K8S_CLUSTER_1", so entries with
// secrets on lines of their own can find them.
function readEntries(prefix, requiredFields) {
  return numberedKeys(prefix).map((envKey) => {
    const entry = parseFields(envKey, process.env[envKey]);

    for (const field of requiredFields) {
      if (!entry[field]) throw new Error(`.env: ${envKey} is missing required field "${field}".`);
    }

    return { ...entry, envKey };
  });
}

function readList(raw) {
  return (raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// --- the configuration itself ---------------------------------------------

// The queue settings this replaced. Fail loudly rather than silently showing
// no queues after an upgrade.
if (process.env.SERVICE_BUS_CONNECTION_STRING || numberedKeys("QUEUE").length) {
  throw new Error(
    ".env: SERVICE_BUS_CONNECTION_STRING and QUEUE_<n> are no longer used - queues are now listed " +
      "automatically. Replace them with SERVICE_BUS_1=label=<name> and SERVICE_BUS_1_CONNECTION_STRING=<...> " +
      "(see .env.example).",
  );
}

// The matrix layout's columns became the list layout's sections.
if (numberedKeys("COLUMN").length) {
  throw new Error(
    ".env: COLUMN_<n> is now SECTION_<n>, and the `column=` field of clusters and endpoints is now " +
      "`section=` (see .env.example).",
  );
}

// The sections of the page, top to bottom.
const SECTIONS = readEntries("SECTION", ["key", "label"]).map(({ key, label, sublabel }) => ({
  key,
  label,
  ...(sublabel ? { sublabel } : {}),
}));

const SECTION_KEYS = new Set(SECTIONS.map((section) => section.key));

function checkSection(what, section) {
  if (!SECTION_KEYS.has(section)) {
    throw new Error(
      `.env: ${what} is in section "${section}", which is not one of the ` +
        `configured SECTION_<n> keys (${[...SECTION_KEYS].join(", ") || "none"}).`,
    );
  }
}

function isLocalProxy(server) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(server);
}

// Namespaces AKS and its add-ons put their own workloads in. Hidden unless a
// cluster lists namespaces explicitly - they aren't our services.
const SYSTEM_NAMESPACES = [
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "gatekeeper-system",
  "calico-system",
  "tigera-operator",
  "app-routing-system",
  "aks-command",
  // Istio service mesh (istiod etc.) - the AKS add-on, or installed by hand.
  "aks-istio-system",
  "aks-istio-ingress",
  "aks-istio-egress",
  "istio-system",
  "status-board",
];

const CLUSTERS = readEntries("K8S_CLUSTER", ["section", "server"])
  .filter((entry) => isLocalProxy(entry.server) || hasSecrets(entry.envKey, ["TOKEN", "CA"]))
  .map((entry) => {
    checkSection(`cluster ${entry.envKey}`, entry.section);

    return {
      envKey: entry.envKey,
      section: entry.section,
      server: entry.server,
      token: process.env[`${entry.envKey}_TOKEN`] || null,
      ca: process.env[`${entry.envKey}_CA`]
        ? Buffer.from(process.env[`${entry.envKey}_CA`], "base64").toString("utf8")
        : null,
      namespaces: readList(entry.namespaces),
      excludeNamespaces: [...SYSTEM_NAMESPACES, ...readList(entry.excludeNamespaces)],
    };
  });

const clusterSections = CLUSTERS.map((cluster) => cluster.section);
const sharedSection = clusterSections.find((section, index) => clusterSections.indexOf(section) !== index);
if (sharedSection) {
  throw new Error(`.env: more than one K8S_CLUSTER_<n> is in section "${sharedSection}" - one cluster per section.`);
}

const ENDPOINTS = readEntries("ENDPOINT", ["name", "url", "section"]).map((entry) => {
  checkSection(`endpoint "${entry.name}"`, entry.section);

  const expectedStatus = entry.expectedStatus === undefined ? 200 : Number(entry.expectedStatus);
  if (!Number.isFinite(expectedStatus)) {
    throw new Error(`.env: endpoint "${entry.name}" has a non-numeric expectedStatus "${entry.expectedStatus}".`);
  }

  return {
    name: entry.name,
    url: entry.url,
    section: entry.section,
    expectedStatus,
  };
});

// Azure Service Bus namespaces whose queues to list.
const SERVICE_BUSES = readEntries("SERVICE_BUS", ["label"])
  .filter(({ envKey }) => hasSecrets(envKey, ["CONNECTION_STRING"]))
  .map(({ envKey, label }) => ({
    label,
    connectionString: process.env[`${envKey}_CONNECTION_STRING`],
  }));

const PORT = readNumber("PORT", 8080);

// How often to re-check everything, in seconds.
const REFRESH_INTERVAL_SECONDS = readNumber("REFRESH_INTERVAL_SECONDS", 60);

// How long to wait for a single endpoint or cluster before marking it
// unreachable, in seconds.
const REQUEST_TIMEOUT_SECONDS = readNumber("REQUEST_TIMEOUT_SECONDS", 5);

// How far back each service's history bar reaches, and how many minutes each
// segment of it covers. 24 hours of 30-minute segments = 48 segments.
const HISTORY_HOURS = readNumber("HISTORY_HOURS", 24);
const HISTORY_BAR_MINUTES = readNumber("HISTORY_BAR_MINUTES", 30);

// How long response-times.jsonl is kept before old lines are pruned.
const RETENTION_DAYS = readNumber("RETENTION_DAYS", 10);

if ((HISTORY_HOURS * 60) % HISTORY_BAR_MINUTES !== 0) {
  throw new Error(".env: HISTORY_HOURS must be a whole number of HISTORY_BAR_MINUTES segments.");
}
if (RETENTION_DAYS * 24 < HISTORY_HOURS) {
  throw new Error(".env: RETENTION_DAYS must cover HISTORY_HOURS, or the history bar would run out of data.");
}

// Stable per-service id, derived from a name. The page matches check results
// back to rows by this id rather than by list position, so reordering or
// re-sorting entries can never make a row show another service's status.
function endpointId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = {
  ENDPOINTS,
  CLUSTERS,
  SECTIONS,
  SERVICE_BUSES,
  endpointId,
  PORT,
  REFRESH_INTERVAL_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  HISTORY_HOURS,
  HISTORY_BAR_MINUTES,
  RETENTION_DAYS,
};
