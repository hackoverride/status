// The page is a list, Uptime Robot style: one block per section (Prod, Demo,
// ...), one line per service with a status dot, how long it's been up or down,
// a bar of the last HISTORY_HOURS, and its uptime % over that time.
//
// 0. init()         - fetch /api/config, because the configuration lives in
//                     .env and only server.js can read that
// 1. pollStatus()   - ask server.js for the latest results. The services come
//                     from those results, not from config: cluster workloads
//                     appear and disappear on their own. So the sections are
//                     (re)built by buildSections() whenever the set of
//                     services changes, and otherwise just filled in, by id
// 2. loadHistory()  - fetch the up/down counts per bar segment and draw the
//                     history bars and uptime %
// 3. pollQueues()   - ask server.js for every queue's counts, and list the
//                     ones with dead letters
// 4. renderBanner() - the one line at the top, from all of the above
// 5. run the polls now, then again every refreshIntervalSeconds
//
// Services are listed alphabetically and never move, so a service going down
// turns red where it already was, instead of jumping to the top.
//
// The actual checks and queue reads happen in server.js, not here - see the
// comment at the top of that file for why.

const sectionsElement = document.getElementById("sections");
const sideSections = document.getElementById("side-sections");
const page = document.querySelector(".page");
const board = document.querySelector(".board");
const banner = document.getElementById("banner");
const lastUpdated = document.getElementById("last-updated");
const refreshInfo = document.getElementById("refresh-info");
const queuesElement = document.getElementById("queues");
const queueList = document.getElementById("queue-list");
const queueSummary = document.getElementById("queue-summary");

const LEVELS = ["up", "down", "idle", "unknown"];

// Filled in by init() from GET /api/config before anything is drawn:
// { sections, queueNamespaces, refreshIntervalSeconds, historyHours }.
let config = null;

// The latest payloads, kept so renderBanner() can combine them.
let latestStatus = null;
let latestQueues = null;

// id -> { element, name } for each service line, so updates never rely on the
// order the server returns results in. `name` is what history is keyed by.
const rowsById = new Map();
// The ids the sections were last built for. A different set means rebuild.
let layoutSignature = "";
// section key -> its "4 of 5 up" element.
const summariesByKey = new Map();

// --- small helpers --------------------------------------------------------

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// 45 s -> "less than a minute", 12 min, 3 h 10 min, 6 days 4 h.
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;

  const days = Math.floor(hours / 24);
  return `${plural(days, "day")}${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- draw the sections ------------------------------------------------------

// Cluster sections go in the wide columns, the rest in the side column. With
// no cluster connected yet, everything goes in the wide columns.
function buildSections(results) {
  sectionsElement.innerHTML = "";
  sideSections.innerHTML = "";
  rowsById.clear();
  summariesByKey.clear();

  const anyCluster = config.sections.some((section) => section.cluster);

  config.sections.forEach((section) => {
    const block = element("section", "section");

    const head = element("div", "section-head");
    const title = element("h2", "", section.label);
    if (section.sublabel) title.appendChild(element("span", "sublabel", section.sublabel));
    const summary = element("span", "section-summary");
    summariesByKey.set(section.key, summary);
    head.append(title, summary);
    block.appendChild(head);

    const inSection = results
      .filter((result) => result.section === section.key)
      .sort((a, b) => a.label.localeCompare(b.label));

    if (!inSection.length) {
      block.appendChild(element("p", "empty", "No services to show yet."));
    }
    inSection.forEach((result) => block.appendChild(buildRow(result)));
    if (inSection.length) block.appendChild(buildAxis());

    (section.cluster || !anyCluster ? sectionsElement : sideSections).appendChild(block);
  });

  updateSideColumn();
}

// Without anything for the side column, the wide columns take the full width.
function updateSideColumn() {
  board.classList.toggle("no-side", !sideSections.children.length && queuesElement.hidden);
}

function buildRow(result) {
  const row = element("div", "row status-unknown");

  const nameBlock = element("div", "row-name");
  const nameLine = element("div", "name-line");
  nameLine.append(element("span", "dot"), element("span", "name", result.label));
  nameBlock.append(nameLine, element("div", "status-line"));

  row.append(nameBlock, element("div", "bars"), element("div", "uptime", "–"));

  rowsById.set(result.id, { element: row, name: result.name });
  return row;
}

// "24 h ago ... now" under the bars, lined up with them by the same grid.
function buildAxis() {
  const axis = element("div", "row axis");
  const labels = element("div", "axis-labels");
  labels.append(element("span", "", `${config.historyHours} h ago`), element("span", "", "now"));
  axis.append(element("div"), labels, element("div"));
  return axis;
}

// --- fill in live status ----------------------------------------------------

function statusText(result, now) {
  const forHowLong = result.since ? formatDuration(now - Date.parse(result.since)) : "";
  const withNote = (text) => (result.note ? `${text} · ${result.note}` : text);

  if (result.level === "up") return withNote(forHowLong ? `Up ${forHowLong}` : "Up");
  if (result.level === "down") return withNote(forHowLong ? `Down for ${forHowLong}` : "Down");
  if (result.level === "idle") return withNote("Paused");
  return "No data · cluster unreachable";
}

function updateRow(result, now) {
  const row = rowsById.get(result.id);
  if (!row) return;

  LEVELS.forEach((level) => row.element.classList.remove(`status-${level}`));
  row.element.classList.add(`status-${result.level}`);
  row.element.querySelector(".status-line").textContent = statusText(result, now);
  row.element.querySelector(".row-name").title = result.tooltip;
}

// "4 of 5 up" next to each section heading, or why it can't say.
function updateSectionSummaries(results, sectionErrors) {
  config.sections.forEach((section) => {
    const summary = summariesByKey.get(section.key);
    const error = sectionErrors[section.key];
    const counted = results.filter(
      (result) => result.section === section.key && (result.level === "up" || result.level === "down"),
    );
    const upCount = counted.filter((result) => result.level === "up").length;

    summary.title = error || "";
    summary.classList.toggle("summary-down", upCount < counted.length);
    summary.classList.toggle("summary-warning", Boolean(error) && upCount === counted.length);

    if (error) summary.textContent = "cluster unreachable";
    else if (counted.length) summary.textContent = `${upCount} of ${counted.length} up`;
    else summary.textContent = "";
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
  if (!payload.checkedAt) return;

  const results = payload.results || [];
  const signature = results
    .map((result) => `${result.id}:${result.label}`)
    .sort()
    .join("\n");
  if (signature !== layoutSignature) {
    buildSections(results);
    layoutSignature = signature;
  }

  const now = Date.now();
  results.forEach((result) => updateRow(result, now));
  updateSectionSummaries(results, payload.sectionErrors || {});

  latestStatus = payload;
  lastUpdated.textContent = `Last checked ${new Date(payload.checkedAt).toLocaleTimeString()}`;
  renderBanner();
  fitToScreen();
  loadHistory();
}

// --- history bars and uptime % ---------------------------------------------

// Best-effort, same as pollStatus(): if it fails, the bars keep what they had.
async function loadHistory() {
  let history;
  try {
    const response = await fetch("/api/history");
    history = await response.json();
  } catch {
    return;
  }

  rowsById.forEach(({ element: row, name }) => {
    renderBars(row.querySelector(".bars"), history, history.byName[name]);
    row.querySelector(".uptime").textContent = formatUptime(history.byName[name]);
  });
}

// One segment per HISTORY_BAR_MINUTES. Red if the service was down for any
// check in it, green if every check was up, grey if there were no checks.
function renderBars(container, history, segments) {
  const barMs = history.barMinutes * 60 * 1000;
  const segmentCount = (history.hours * 60) / history.barMinutes;
  container.innerHTML = "";

  for (let index = 0; index < segmentCount; index++) {
    const [up, down] = segments ? segments[index] : [0, 0];
    const start = history.start + index * barMs;
    const bar = element("span", down ? "bar bar-down" : up ? "bar bar-up" : "bar");

    const range = `${formatTime(start)}–${formatTime(start + barMs)}`;
    if (down) {
      const minutes = Math.max(1, Math.round((down * history.checkSeconds) / 60));
      bar.title = `${range} · down about ${minutes} min`;
    } else {
      bar.title = up ? `${range} · no downtime` : `${range} · no data`;
    }

    container.appendChild(bar);
  }
}

// Share of up checks over the whole bar. Rounded down, so any downtime at all
// shows as less than 100%.
function formatUptime(segments) {
  let up = 0;
  let total = 0;
  (segments || []).forEach(([upCount, downCount]) => {
    up += upCount;
    total += upCount + downCount;
  });

  if (!total) return "–";
  if (up === total) return "100%";
  return `${Math.floor((up / total) * 1000) / 10}%`;
}

// --- Azure Service Bus queues ----------------------------------------------
//
// Every queue, one block per namespace, alphabetical so rows never move. A
// queue with dead letters is highlighted; a namespace that can't be read says
// so instead of looking clean.

function renderQueues(namespaces) {
  queueList.innerHTML = "";

  let totalQueues = 0;
  let queuesWithDeadLetters = 0;

  namespaces.forEach((namespace) => {
    const block = element("section", "section");
    const namespaceDeadLetters = namespace.queues.reduce(
      (sum, queue) => sum + queue.deadLetter + queue.transferDeadLetter,
      0,
    );

    const head = element("div", "section-head");
    const summary = element(
      "span",
      namespaceDeadLetters ? "section-summary summary-warning" : "section-summary",
      `${plural(namespace.queues.length, "queue")} · ${plural(namespaceDeadLetters, "dead letter")}`,
    );
    head.append(element("h2", "", namespace.label), summary);
    block.appendChild(head);

    if (namespace.error) {
      block.appendChild(element("p", "queue-error", `Couldn't refresh: ${namespace.error}`));
    }

    if (namespace.queues.length) {
      const labels = element("div", "queue-row queue-labels");
      labels.append(element("span", "", "Queue"), element("span", "", "Waiting"), element("span", "", "Dead letters"));
      block.appendChild(labels);
    }

    [...namespace.queues]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((queue) => {
        const deadLetters = queue.deadLetter + queue.transferDeadLetter;
        totalQueues += 1;
        if (deadLetters) queuesWithDeadLetters += 1;

        const row = element("div", deadLetters ? "queue-row has-dead-letters" : "queue-row");
        row.append(
          element("span", "queue-name", queue.name),
          element("span", "queue-active", String(queue.active)),
          element("span", "queue-deadletter", String(deadLetters)),
        );
        row.title = [
          queue.name,
          `Waiting: ${queue.active}`,
          `Dead letters: ${queue.deadLetter}`,
          ...(queue.transferDeadLetter ? [`Transfer dead letters: ${queue.transferDeadLetter}`] : []),
          `Scheduled: ${queue.scheduled}`,
        ].join("\n");
        block.appendChild(row);
      });

    queueList.appendChild(block);
  });

  queueSummary.textContent = queuesWithDeadLetters
    ? `${queuesWithDeadLetters} of ${plural(totalQueues, "queue")} with dead letters`
    : `No dead letters in ${plural(totalQueues, "queue")}`;
  queueSummary.classList.toggle("summary-warning", queuesWithDeadLetters > 0);
}

// Best-effort, same as pollStatus().
async function pollQueues() {
  let payload;
  try {
    const response = await fetch("/api/queues");
    payload = await response.json();
  } catch {
    return;
  }
  if (!payload.checkedAt) return;

  latestQueues = payload;
  renderQueues(payload.namespaces);
  renderBanner();
  fitToScreen();
}

// --- keep it on one screen ------------------------------------------------
//
// On a wide screen - the wall display - the page never scrolls: if it's taller
// than the window, the whole page is zoomed out just enough to fit, and made
// correspondingly wider so it still fills the width. Narrow screens (phones)
// scroll as normal. Re-run after anything that can change the page's height.

const WALL_MIN_WIDTH = 1200;
const MIN_ZOOM = 0.5;

function fitToScreen() {
  const root = document.documentElement;
  page.style.zoom = "";
  page.style.width = "";
  page.style.maxWidth = "";

  // No scrollbar while fitting, so it can't eat into the width being measured.
  const isWall = window.innerWidth >= WALL_MIN_WIDTH;
  root.classList.toggle("fit-screen", isWall);
  if (!isWall) return;

  const screenWidth = root.clientWidth;
  const screenHeight = window.innerHeight - 2; // margin for sub-pixel rounding

  // Widening the page re-wraps it, which can change its height again, so
  // settle in a few steps rather than one. Rounded down so it never overshoots.
  let zoom = 1;
  for (let attempt = 0; attempt < 3 && page.scrollHeight * zoom > screenHeight; attempt++) {
    zoom = Math.max(MIN_ZOOM, Math.floor(zoom * (screenHeight / (page.scrollHeight * zoom)) * 1000) / 1000);
    page.style.zoom = zoom;
    page.style.width = `${screenWidth / zoom}px`;
    page.style.maxWidth = "none";
  }

  // Too much to fit even at MIN_ZOOM: better to scroll than to cut it off.
  if (page.scrollHeight * zoom > window.innerHeight) root.classList.remove("fit-screen");
}

window.addEventListener("resize", fitToScreen);

// --- the banner ---------------------------------------------------------------
//
// red   - a service is down (named, when there are only a few)
// amber - nothing down, but dead letters or something that can't be read
// green - all clear

function renderBanner() {
  if (!latestStatus) return;

  const sectionLabels = Object.fromEntries(config.sections.map((section) => [section.key, section.label]));
  const down = latestStatus.results.filter((result) => result.level === "down");
  const unreachable = Object.keys(latestStatus.sectionErrors || {}).map((key) => sectionLabels[key]);

  const namespaces = latestQueues ? latestQueues.namespaces : [];
  const deadLetters = namespaces
    .flatMap((namespace) => namespace.queues)
    .reduce((sum, queue) => sum + queue.deadLetter + queue.transferDeadLetter, 0);
  const unreadableQueues = namespaces.filter((namespace) => namespace.error).map((namespace) => namespace.label);

  const parts = [];
  if (down.length) {
    const names = down.map((result) => `${result.label} (${sectionLabels[result.section]})`);
    parts.push(`${plural(down.length, "service")} down${down.length <= 3 ? `: ${names.join(", ")}` : ""}`);
  }
  if (unreachable.length) parts.push(`Can't reach the ${unreachable.join(" and ")} cluster`);
  if (deadLetters) parts.push(plural(deadLetters, "dead-lettered message"));
  if (unreadableQueues.length) parts.push(`Can't read queues in ${unreadableQueues.join(" and ")}`);

  banner.className = `banner ${down.length ? "banner-down" : parts.length ? "banner-warning" : "banner-up"}`;
  banner.textContent = parts.length ? parts.join(" · ") : "All systems operational";
}

// Unlike the polls, this one isn't best-effort: without the configuration
// there is nothing to draw at all, so say so on the page instead of leaving
// it stuck on "Loading…".
async function init() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
  } catch (err) {
    console.error("Could not load /api/config:", err);
    banner.className = "banner banner-down";
    banner.textContent = "Configuration unavailable - is server.js running?";
    return;
  }

  queuesElement.hidden = !config.queueNamespaces.length;
  updateSideColumn();

  pollStatus();
  setInterval(pollStatus, config.refreshIntervalSeconds * 1000);
  if (config.queueNamespaces.length) {
    pollQueues();
    setInterval(pollQueues, config.refreshIntervalSeconds * 1000);
  }
  refreshInfo.textContent = `Refreshing every ${config.refreshIntervalSeconds}s`;
}

init();
