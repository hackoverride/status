# Status Board

```bash
npm install
cp .env.example .env   # then fill it in
node server.js
```

Open http://localhost:8080

## What it shows

An uptime-monitor style page:

- **A banner at the top** that answers "is anything wrong?": red when a
  service is down (naming it, when only a few are), amber for dead-lettered
  messages or a cluster that can't be read, green with *All systems
  operational* otherwise.
- **One section per environment** (Prod, Demo), side by side. The Heroku
  apps are listed in Demo alongside the cluster's services. Each service gets
  one line with:
  - a green or red dot, its name, and how long it's been up or down
  - a short note when something's off but it's still up, e.g. `1/2 pods ready`
    or `CrashLoopBackOff`
  - a bar of the last 24 hours in 30-minute segments: red if it was down at
    any point in that half hour, green if not, grey for no data. Hover a
    segment for the time and roughly how long it was down.
  - its uptime % over those 24 hours
- **Queues** in a column on the right: every queue in each Service Bus
  namespace, with waiting and dead-lettered counts. Queues with dead letters
  are highlighted.

Services are listed alphabetically and never move, so a service going down
turns red where it already was.

On a wide screen (1200px and up) the page never scrolls: if there are more
services than fit, the whole page zooms out just enough to fit the screen.
Phones scroll as normal.

"Up 3 h" counts from when the board first saw the service in that state, so
right after the board starts, everything says "Up less than a minute".

## Where the status comes from

- **Kubernetes sections** are read straight from each AKS cluster's API.
  Every Deployment and StatefulSet is listed by itself, so a new service
  appears when it's deployed and there's nothing to add per service. A service
  counts as up when at least one of its pods is ready. The board logs in with
  a read-only ServiceAccount; [k8s/README.md](k8s/README.md) walks through
  creating it, once per cluster.
- **Heroku** apps are checked with a plain HTTP request per `ENDPOINT_<n>`,
  since there's no cluster to ask. Up means the expected status code.
- **Queues** come from Azure Service Bus: every queue in each configured
  namespace.

If a cluster can't be read, its services stay listed in grey as *No data*,
and the section heading says *cluster unreachable* (hover it for the reason).
They don't count as down, and the history bar doesn't record anything for
that time.

## Configuration

Everything configurable lives in `.env`, which is gitignored, so cluster
tokens, connection strings and service URLs stay out of the repo.
`.env.example` is the committed template; `config.js` reads `.env` and is where
every field is documented.

Plain `KEY=VALUE` lines. List entries are numbered and hold their own
`field=value` pairs separated by semicolons, so field order doesn't matter and
optional fields can be left out. The numbers only set the order entries are
read in; gaps are fine. Values must not contain a semicolon, which is why
secrets get a line of their own.

```ini
PORT=8080
REFRESH_INTERVAL_SECONDS=60
REQUEST_TIMEOUT_SECONDS=5
HISTORY_HOURS=24
HISTORY_BAR_MINUTES=30
RETENTION_DAYS=10

SECTION_1=key=prod; label=Prod; sublabel=AKS
SECTION_2=key=demo; label=Demo

# printed for you by the commands in k8s/README.md
K8S_CLUSTER_1=section=prod; server=https://...azmk8s.io:443
K8S_CLUSTER_1_TOKEN=...
K8S_CLUSTER_1_CA=...

ENDPOINT_1=name=Auth Service; url=https://auth.example.com/health; section=demo

SERVICE_BUS_1=label=my-namespace-dev
SERVICE_BUS_1_CONNECTION_STRING=Endpoint=sb://...
```

Clusters can be narrowed with `namespaces=a,b` (only these) or
`excludeNamespaces=a,b` (hide these too). AKS's own system namespaces are
always hidden unless listed in `namespaces`. If the same service name exists
in two namespaces, the namespace is added after the name.

An entry whose secret line is still empty (`_TOKEN`, `_CA`,
`_CONNECTION_STRING`) is skipped with a note in the log, so the rest of the
board works while the cluster setup is pending. A malformed entry, such as a
missing `name`/`url` or an unknown `section`, stops the server at startup
with a message naming the key. So does an `.env` still written for the older
layout (`COLUMN_<n>`, `QUEUE_<n>`, `SERVICE_BUS_CONNECTION_STRING`); the
message says what to change.

Real environment variables win over the file, so a value set in the shell or by
systemd overrides `.env` rather than the other way round.

The browser gets the display half of this from `GET /api/config`; it can't
read `.env` itself. Tokens and connection strings are never sent to the page.

## Logs

Written to `./logs`:

- `downtime.log`: every change between up, down and paused, and how long an
  outage lasted
- `response-times.jsonl`: one line per check, kept for `RETENTION_DAYS`. The
  history bars are read from it once at startup and then kept in memory.
- `state.json`: each service's current status and since when, so "Up 3 days"
  survives a restart
