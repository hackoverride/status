# Status Board

```bash
npm install
cp .env.example .env   # then fill it in
node server.js
```

Open http://localhost:8080

## Configuration

Everything configurable lives in `.env`, which is gitignored - the service URLs
and the Service Bus connection string stay out of the repo. `.env.example` is
the committed template; `config.js` reads `.env` and is where every field is
documented.

Plain `KEY=VALUE` lines. List entries are numbered and hold their own
`field=value` pairs separated by semicolons, so field order doesn't matter and
optional fields can be left out. The numbers only set the order entries are
read in - gaps are fine, and values must not contain a semicolon.

```ini
PORT=8080
REFRESH_INTERVAL_SECONDS=60
REQUEST_TIMEOUT_SECONDS=5
HISTORY_POINTS=50
RETENTION_DAYS=10
SERVICE_BUS_CONNECTION_STRING=

COLUMN_1=key=current; label=Current; sublabel=Heroku

ENDPOINT_1=name=Auth Service; url=https://auth.example.com/health; category=Core Services
ENDPOINT_2=name=Alarm Pulse; url=https://alarm.example.com/pulse; category=Core Services; expectedStatus=400

QUEUE_1=name=Orders; queueName=orders
```

Real environment variables win over the file, so a value set in the shell or by
systemd overrides `.env` rather than the other way round. A malformed entry -
a missing `name`/`url`, an unknown `column`, a non-numeric setting - stops the
server at startup with a message naming the key.

Endpoint fields: `name` and `url` are required; `category` (default `Other`),
`service` (default: same as `name`), `column` (default `current`) and
`expectedStatus` (default `200`) are optional.

The browser gets the display half of this from `GET /api/config` - it can't
read `.env` itself. The connection string is never sent to the page.

Logs are written to `./logs`.

## Layout

The page is a matrix sized to fit one 1920x1080 screen without scrolling:

- **one row per service**, grouped by category, ordered alphabetically within a
  category and never reordered - a service going down turns its cell red where
  it already was
- **one column per place it runs** - `Current` (Heroku), `K8s Demo`, `K8s Prod`,
  from the `COLUMN_<n>` entries in `.env`

Two entries share a row when they share a `service` value, so the Heroku and
Kubernetes copies of a service sit side by side and can be compared across.
An empty cell (`—`) means that service doesn't run in that column yet.

Adding a service to Kubernetes therefore means adding a second entry for it:

```ini
# name     unique - keys its uptime history, so renaming orphans that history
# service  the row it joins
# column   one of the COLUMN_<n> keys
# category keep equal across a service's entries
ENDPOINT_21=name=Notification Service (DEMO); service=Notification Service; column=demo; category=Core Services; url=http://.../healthz
```

For Azure Service Bus queue counts, fill in `SERVICE_BUS_CONNECTION_STRING` in
`.env`. Without it, the queues section is skipped.
