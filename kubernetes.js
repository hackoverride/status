// Reads workload health straight from a cluster's Kubernetes API, so the
// cluster sections don't need a health URL per service: every Deployment and
// StatefulSet the read-only ServiceAccount can see is listed on its own.
//
// Plain https rather than @kubernetes/client-node: three list calls with a
// bearer token and the cluster's own CA certificate are all this needs, and it
// keeps @azure/service-bus the only dependency. See k8s/ for the account.
//
// Each workload is boiled down to one level, like an uptime monitor:
//   up    at least one pod ready, so the service is answering
//   down  not a single pod ready
//   idle  scaled to 0 on purpose - neither up nor down
// Anything short of fully healthy while up - fewer pods ready than desired, a
// pod crash-looping or failing to pull its image, a rollout in progress or
// stuck, a restart in the last RECENT_RESTART_MINUTES - doesn't change the
// colour. It goes in `note`, shown as small text under the name.

const http = require("http");
const https = require("https");

const RECENT_RESTART_MINUTES = 15;

// Container waiting reasons that mean "this will not fix itself".
const BROKEN_WAITING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

// --- talk to the API server ------------------------------------------------

function apiGet(cluster, apiPath, timeoutMs) {
  const url = new URL(apiPath, cluster.server);
  const client = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        ...(cluster.ca ? { ca: cluster.ca } : {}),
        // No token when going through `kubectl proxy`: it adds its own login,
        // but only if the request doesn't already carry one.
        headers: { ...(cluster.token ? { Authorization: `Bearer ${cluster.token}` } : {}), Accept: "application/json" },
        timeout: timeoutMs,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(describeApiError(response.statusCode, body)));
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Unreadable response from ${apiPath}: ${err.message}`));
          }
        });
      },
    );

    request.on("timeout", () => request.destroy(new Error(`Timed out after ${timeoutMs / 1000}s`)));
    request.on("error", reject);
    request.end();
  });
}

// The two failures people will actually hit get a hint about the fix.
function describeApiError(statusCode, body) {
  let message = "";
  try {
    message = JSON.parse(body).message || "";
  } catch {}

  if (statusCode === 401) return "HTTP 401 - token rejected. Re-copy K8S_CLUSTER_<n>_TOKEN (see k8s/README.md).";
  if (statusCode === 403)
    return `HTTP 403 - the ServiceAccount isn't allowed to read this. Was k8s/status-board-reader.yaml applied? ${message}`;
  return `HTTP ${statusCode} ${message}`.trim();
}

// List one resource type, cluster-wide or per configured namespace.
async function listItems(cluster, apiBase, plural, timeoutMs) {
  if (!cluster.namespaces.length) {
    return (await apiGet(cluster, `/${apiBase}/${plural}`, timeoutMs)).items;
  }

  const lists = await Promise.all(
    cluster.namespaces.map((namespace) => apiGet(cluster, `/${apiBase}/namespaces/${namespace}/${plural}`, timeoutMs)),
  );
  return lists.flatMap((list) => list.items);
}

function isShown(cluster, namespace) {
  if (cluster.namespaces.length) return cluster.namespaces.includes(namespace);
  return !cluster.excludeNamespaces.includes(namespace);
}

// --- read a whole cluster --------------------------------------------------

// Resolves to one entry per workload: { namespace, name, kind, level, note,
// tooltip }. Rejects if the cluster can't be read at all.
async function readCluster(cluster, timeoutMs) {
  const [deployments, statefulSets, pods] = await Promise.all([
    listItems(cluster, "apis/apps/v1", "deployments", timeoutMs),
    listItems(cluster, "apis/apps/v1", "statefulsets", timeoutMs),
    listItems(cluster, "api/v1", "pods", timeoutMs),
  ]);

  const podsByNamespace = new Map();
  for (const pod of pods) {
    const namespace = pod.metadata.namespace;
    if (!podsByNamespace.has(namespace)) podsByNamespace.set(namespace, []);
    podsByNamespace.get(namespace).push(pod);
  }

  const now = Date.now();
  const workloads = [
    ...deployments.map((item) => ({ kind: "Deployment", item })),
    ...statefulSets.map((item) => ({ kind: "StatefulSet", item })),
  ];

  return workloads
    .filter(({ item }) => isShown(cluster, item.metadata.namespace))
    .map(({ kind, item }) => {
      const ownPods = (podsByNamespace.get(item.metadata.namespace) || []).filter(
        (pod) => !pod.metadata.deletionTimestamp && selectorMatches(item.spec.selector, pod.metadata.labels),
      );
      return evaluateWorkload(kind, item, ownPods, now);
    });
}

// A workload's pods are the ones its label selector matches.
function selectorMatches(selector, labels = {}) {
  if (!selector) return false;

  for (const [key, value] of Object.entries(selector.matchLabels || {})) {
    if (labels[key] !== value) return false;
  }

  for (const { key, operator, values = [] } of selector.matchExpressions || []) {
    const has = key in labels;
    if (operator === "In" && !(has && values.includes(labels[key]))) return false;
    if (operator === "NotIn" && has && values.includes(labels[key])) return false;
    if (operator === "Exists" && !has) return false;
    if (operator === "DoesNotExist" && has) return false;
  }

  return true;
}

// --- one workload -> one level ----------------------------------------------

function evaluateWorkload(kind, item, pods, now) {
  const { namespace, name } = item.metadata;
  const desired = item.spec.replicas ?? 1;
  const ready = item.status?.readyReplicas ?? 0;
  const updated = item.status?.updatedReplicas ?? 0;
  const podState = inspectPods(pods, now);
  const image = item.spec.template?.spec?.containers?.[0]?.image || "";

  const progressing = (item.status?.conditions || []).find((condition) => condition.type === "Progressing");
  const rolloutStuck = progressing?.reason === "ProgressDeadlineExceeded";
  const rollingOut = (item.status?.observedGeneration ?? 0) < item.metadata.generation || updated < desired;

  let level = "up";
  if (desired === 0) level = "idle";
  else if (ready === 0) level = "down";

  let note = "";
  if (desired === 0) note = "scaled to 0";
  else if (podState.problem) note = podState.problem;
  else if (ready < desired) note = `${ready}/${desired} pods ready`;
  else if (rolloutStuck) note = "rollout stuck";
  else if (rollingOut) note = "rolling out";
  else if (podState.recentRestart) note = podState.recentRestart;

  const tooltip = [
    `${namespace}/${name} (${kind})`,
    `Ready: ${ready}/${desired}`,
    `Restarts: ${podState.restarts}`,
    ...(podState.recentRestart
      ? [`Last restart: ${podState.recentRestart}, within ${RECENT_RESTART_MINUTES} min`]
      : []),
    ...(image ? [`Image: ${image}`] : []),
  ].join("\n");

  return { namespace, name, kind, level, note, tooltip };
}

// Worst current container problem, total restarts, and the reason for any
// restart within RECENT_RESTART_MINUTES ("OOMKilled", "Error", ...).
function inspectPods(pods, now) {
  let problem = null;
  let restarts = 0;
  let recentRestart = null;

  for (const pod of pods) {
    const unschedulable = (pod.status?.conditions || []).find(
      (condition) => condition.type === "PodScheduled" && condition.reason === "Unschedulable",
    );
    if (unschedulable) problem = problem || "Unschedulable";

    const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])];
    for (const status of statuses) {
      restarts += status.restartCount || 0;

      const waiting = status.state?.waiting?.reason;
      if (BROKEN_WAITING_REASONS.has(waiting)) problem = problem || waiting;

      const lastExit = status.lastState?.terminated;
      if (lastExit && now - Date.parse(lastExit.finishedAt) < RECENT_RESTART_MINUTES * 60 * 1000) {
        recentRestart = lastExit.reason ? `restarted (${lastExit.reason})` : "restarted";
      }
    }
  }

  return { problem, restarts, recentRestart };
}

module.exports = { readCluster };
