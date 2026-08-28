// The page is a matrix: one ROW per service, one COLUMN per place it can run
// (Current / K8s Demo / K8s Prod - see the columns configured in .env).
//
// 0. init()            - fetch /api/config, because the configuration lives in
//                        .env now and only server.js can read that
// 1. buildMatrix()     - draw the column headings, then a row per service with
//                        one cell per column, from config.endpoints
// 2. pollStatus()      - ask server.js for the latest real check results and
//                        fill in the cells, matching results to cells by id
// 3. loadHistory()     - fetch recent history per endpoint, draw the sparkline
//                        strip along the bottom of each cell
// 4. buildQueueCards() - draw one card per entry in config.queues
// 5. pollQueues()      - ask server.js for the latest Azure Service Bus counts
// 6. run pollStatus()/pollQueues() now, then again every refreshIntervalSeconds
//
// Row order is fixed - categories in the order they first appear in the
// endpoint list, then alphabetical by service - so a service going down turns
// its cell red where it already was, instead of jumping to the top.
//
// The actual endpoint checks and queue reads happen in server.js, not here -
// see the comment at the top of that file for why.

const matrix = document.getElementById("matrix");
const queuesSection = document.getElementById("queues-section");
const summaryText = document.getElementById("summary-text");
const lastUpdated = document.getElementById("last-updated");
const refreshInfo = document.getElementById("refresh-info");

// id -> the cell element for that endpoint, so pollStatus() never has to rely
// on the server returning results in endpoint order.
const cellsById = new Map();
// id -> endpoint name, so loadHistory() can look history up by name (that's
// what server.js keys it by) and render it into the right cell.
const namesById = new Map();

// Filled in by init() from GET /api/config before anything is drawn:
// { columns, endpoints, queues, refreshIntervalSeconds, historyPoints }.
let config = null;

// --- shape the endpoint list into rows ------------------------------------

// One row per distinct `service`, holding at most one endpoint per column.
// A row's category comes from the first endpoint of that service, so entries
// for the same service should agree on it.
function buildRowModel(endpoints) {
  const rowsByService = new Map();
  const categoryOrder = [];

  endpoints.forEach((endpoint) => {
    const service = endpoint.service || endpoint.name;
    const column = endpoint.column || "current";

    if (!rowsByService.has(service)) {
      const category = endpoint.category || "Other";
      if (!categoryOrder.includes(category)) categoryOrder.push(category);
      rowsByService.set(service, { service, category, cells: {} });
    }

    const row = rowsByService.get(service);
    if (row.cells[column]) {
      console.warn(
        `.env: "${endpoint.name}" and "${row.cells[column].name}" both claim ` +
          `service "${service}" in column "${column}" - only the first is shown.`
      );
      return;
    }
    row.cells[column] = endpoint;
  });

  const allRows = [...rowsByService.values()];

  return categoryOrder.map((category) => ({
    category,
    rows: allRows
      .filter((row) => row.category === category)
      .sort((a, b) => a.service.localeCompare(b.service)),
  }));
}

// --- draw the matrix ------------------------------------------------------

function buildMatrix() {
  matrix.appendChild(buildHeadRow());

  buildRowModel(config.endpoints).forEach(({ category, rows }) => {
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = category;
    matrix.appendChild(title);

    rows.forEach((row) => matrix.appendChild(buildRow(row)));
  });
}

function buildHeadRow() {
  const head = document.createElement("div");
  head.className = "matrix-row matrix-head";

  const corner = document.createElement("div");
  corner.className = "row-label head-label";
  corner.textContent = "Service";
  head.appendChild(corner);

  config.columns.forEach((column) => {
    const cell = document.createElement("div");
    cell.className = "col-head";
    cell.innerHTML = `
      <span class="col-label">${column.label}</span>
      <span class="col-rollup" id="rollup-${column.key}">–</span>
    `;
    head.appendChild(cell);
  });

  return head;
}

function buildRow({ service, cells }) {
  const row = document.createElement("div");
  row.className = "matrix-row";

  const label = document.createElement("div");
  label.className = "row-label";
  label.textContent = service;
  label.title = service;
  row.appendChild(label);

  config.columns.forEach((column) => {
    const endpoint = cells[column.key];
    row.appendChild(endpoint ? buildCell(endpoint) : buildEmptyCell());
  });

  return row;
}

function buildCell(endpoint) {
  // The id comes from server.js rather than being recomputed here, so both
  // sides can't drift apart on how a name maps to an id.
  const id = endpoint.id;
  const cell = document.createElement("div");
  cell.className = "cell status-unknown";
  cell.title = `${endpoint.name}\n${endpoint.url}`;

  cell.innerHTML = `
    <div class="cell-line">
      <span class="dot"></span>
      <span class="cell-status">Checking…</span>
      <span class="cell-time"></span>
    </div>
    <div class="cell-spark"></div>
  `;

  cellsById.set(id, cell);
  namesById.set(id, endpoint.name);
  return cell;
}

// A service that doesn't run in this column yet. Reads as "nothing here",
// deliberately not as "down".
function buildEmptyCell() {
  const cell = document.createElement("div");
  cell.className = "cell cell-empty";
  cell.textContent = "—";
  return cell;
}

// --- fill in live status --------------------------------------------------

function updateCell(result) {
  const cell = cellsById.get(result.id);
  if (!cell) return;

  const statusText = cell.querySelector(".cell-status");
  const timeText = cell.querySelector(".cell-time");

  cell.classList.remove("status-unknown", "status-up", "status-down");

  if (result.up) {
    cell.classList.add("status-up");
    statusText.textContent = result.statusCode;
    timeText.textContent = `${result.ms} ms`;
  } else {
    cell.classList.add("status-down");
    statusText.textContent = `DOWN ${result.statusCode}`;
    timeText.textContent = "";
  }
}

// Per-column "17 / 18 up" under each column heading, plus the overall count.
function updateRollups(results) {
  config.columns.forEach((column) => {
    const element = document.getElementById(`rollup-${column.key}`);
    const inColumn = results.filter((result) => result.column === column.key);

    if (!inColumn.length) {
      element.textContent = "not configured";
      element.classList.remove("rollup-alert");
      return;
    }

    const upCount = inColumn.filter((result) => result.up).length;
    element.textContent = `${upCount} / ${inColumn.length} up`;
    element.classList.toggle("rollup-alert", upCount < inColumn.length);
  });
}

// Best-effort: if server.js isn't reachable, the page just keeps showing
// whatever it last knew.
async function pollStatus() {
  let payload;
  try {
    const response = await fetch("/api/status");
    payload = await response.json();
  } catch {
    return;
  }

  const results = payload.results || [];
  if (!results.length) return;

  results.forEach(updateCell);
  updateRollups(results);

  const upCount = results.filter((result) => result.up).length;
  summaryText.textContent = `${upCount} / ${results.length} up`;
  summaryText.classList.toggle("summary-alert", upCount < results.length);
  lastUpdated.textContent = `Last checked: ${new Date(payload.checkedAt).toLocaleTimeString()}`;

  loadHistory();
}

// Best-effort, same as pollStatus(): if server.js isn't running, sparklines
// just stay empty and the rest of the page keeps working.
async function loadHistory() {
  let history;
  try {
    const response = await fetch(`/api/history?limit=${config.historyPoints}`);
    history = await response.json();
  } catch {
    return;
  }

  cellsById.forEach((cell, id) => {
    renderSparkline(cell.querySelector(".cell-spark"), history[namesById.get(id)]);
  });
}

// Bars occupy a fixed slot width rather than stretching to fill, so a service
// with only a few checks logged shows a few thin bars at the right-hand edge
// instead of one wide bar that looks like a progress meter. The strip fills in
// from the right as history accumulates. Computed in init(), once the number
// of history points is known.
let sparkSlotWidth = "";

function renderSparkline(container, points) {
  container.innerHTML = "";
  if (!points || points.length === 0) return;

  const upTimes = points.map((p) => p.ms).filter((ms) => ms !== null);
  const maxMs = upTimes.length ? Math.max(...upTimes) : 0;

  points.forEach((point) => {
    const bar = document.createElement("span");
    bar.className = "spark-bar";
    bar.style.width = sparkSlotWidth;

    if (point.ms === null) {
      bar.classList.add("spark-down");
      bar.style.height = "100%";
      bar.title = `${new Date(point.ts).toLocaleString()} - unreachable`;
    } else {
      const heightPercent = maxMs ? Math.max(15, Math.round((point.ms / maxMs) * 100)) : 15;
      bar.style.height = `${heightPercent}%`;
      bar.title = `${new Date(point.ts).toLocaleString()} - ${point.ms} ms`;
    }

    container.appendChild(bar);
  });
}

// --- Azure Service Bus queues (unchanged for now) ------------------------

function buildQueueCards() {
  if (!config.queues.length) return;

  const section = document.createElement("section");
  section.className = "category";

  const heading = document.createElement("h2");
  heading.className = "category-title";
  heading.textContent = "Queues";
  section.appendChild(heading);

  const sectionGrid = document.createElement("div");
  sectionGrid.className = "status-grid";

  config.queues.forEach((queue, index) => {
    const card = document.createElement("div");
    card.className = "queue-card";
    card.id = `queue-card-${index}`;

    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${queue.name}</span>
      </div>
      <div class="queue-stats">
        <div class="queue-stat">
          <span class="queue-stat-value" data-field="active">–</span>
          <span class="queue-stat-label">Active</span>
        </div>
        <div class="queue-stat">
          <span class="queue-stat-value" data-field="deadletter">–</span>
          <span class="queue-stat-label">Dead-letter</span>
        </div>
        <div class="queue-stat">
          <span class="queue-stat-value" data-field="scheduled">–</span>
          <span class="queue-stat-label">Scheduled</span>
        </div>
      </div>
    `;

    sectionGrid.appendChild(card);
  });

  section.appendChild(sectionGrid);
  queuesSection.appendChild(section);
}

function updateQueueCard(index, result) {
  const card = document.getElementById(`queue-card-${index}`);
  if (!card) return;

  const activeEl = card.querySelector('[data-field="active"]');
  const deadLetterEl = card.querySelector('[data-field="deadletter"]');
  const scheduledEl = card.querySelector('[data-field="scheduled"]');

  if (!result.ok) {
    card.classList.add("queue-error");
    card.title = result.error || "Unable to read queue";
    activeEl.textContent = "–";
    deadLetterEl.textContent = "–";
    scheduledEl.textContent = "–";
    return;
  }

  card.classList.remove("queue-error");
  card.title = "";
  activeEl.textContent = result.activeMessageCount;
  deadLetterEl.textContent = result.deadLetterMessageCount;
  scheduledEl.textContent = result.scheduledMessageCount;
  deadLetterEl.classList.toggle("queue-deadletter-alert", result.deadLetterMessageCount > 0);
}

// Best-effort, same as pollStatus(): if server.js isn't running, or
// SERVICE_BUS_CONNECTION_STRING isn't set, queue cards just show "–".
async function pollQueues() {
  if (!config.queues.length) return;

  let payload;
  try {
    const response = await fetch("/api/queues");
    payload = await response.json();
  } catch {
    return;
  }

  const results = payload.results || [];
  results.forEach((result, index) => updateQueueCard(index, result));
}

// Unlike pollStatus()/pollQueues(), this one isn't best-effort: without the
// configuration there is no matrix to draw at all, so say so on the page
// instead of leaving it stuck on "Loading…".
async function init() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
  } catch (err) {
    console.error("Could not load /api/config:", err);
    summaryText.textContent = "Configuration unavailable - is server.js running?";
    summaryText.classList.add("summary-alert");
    return;
  }

  sparkSlotWidth = `max(1px, calc((100% - ${config.historyPoints - 1}px) / ${config.historyPoints}))`;

  buildMatrix();
  buildQueueCards();
  pollStatus();
  pollQueues();
  setInterval(pollStatus, config.refreshIntervalSeconds * 1000);
  setInterval(pollQueues, config.refreshIntervalSeconds * 1000);
  refreshInfo.textContent = `Refreshing every ${config.refreshIntervalSeconds}s`;
}

init();
