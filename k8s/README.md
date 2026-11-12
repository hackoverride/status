# Giving the status board read access to a cluster

The board reads the Prod and Demo sections straight from each cluster's
API. To do that it needs its own login: a **ServiceAccount** that can only
*look*. This is a one-time setup per cluster, and no service repo changes.

What the account can do:

- list Deployments, StatefulSets and Pods, so it knows what runs and whether it's ready
- nothing else: no Secrets, no ConfigMaps, no creating, changing or deleting

> Worth knowing: a Pod's definition includes any environment variables written
> into it directly. If a service puts a password straight into `env:` instead
> of referencing a Secret, this account can read that value. Values that come
> from Secrets stay hidden.

**Before you start:** if the cluster contents are managed by Terraform, Argo CD
or Flux, ask whoever owns that whether this should go through there instead.
Something applied by hand may otherwise get removed. For Terraform, use
[`status-board-reader.tf`](status-board-reader.tf) instead of steps 1-2 below.

## Trying it first, without changing the cluster

To see your real services on your own machine before the account exists,
let `kubectl proxy` connect the board to the cluster using **your own** Azure
login. Nothing is created in the cluster, and it only works while the proxy is
running, so it's for testing on your laptop, not for the Pi.

Install the tools once (Mac):

```bash
brew install azure-cli
```

```bash
az aks install-cli
```

Log in, find the cluster names and resource groups, and fetch your access to
both clusters:

```bash
az login
```

```bash
az aks list -o table
```

```bash
az aks get-credentials -g <resource-group> -n <prod-cluster-name>
```

```bash
az aks get-credentials -g <resource-group> -n <demo-cluster-name>
```

If that fails with "authorization failed", your Azure account doesn't have
access to the cluster; your tech lead can grant it or run this with you.

Start one proxy per cluster, each in its own terminal tab, and leave them
running:

```bash
kubectl proxy --context <prod-cluster-name> --port 8001
```

```bash
kubectl proxy --context <demo-cluster-name> --port 8002
```

Point the board at them in `.env`, leaving the `_TOKEN` and `_CA` lines empty:

```ini
K8S_CLUSTER_1=section=prod; server=http://127.0.0.1:8001
K8S_CLUSTER_2=section=demo; server=http://127.0.0.1:8002
```

Restart the board (`Ctrl+C`, then `node server.js`). Prod and Demo now list
every service. The board only reads, but it's using your login, which on this
cluster type can do anything, so stop the proxies (`Ctrl+C`) when you're done.

For the real setup, carry on below and swap these two lines for the ones
step 2 prints.

## 1. Create the account (Azure Portal, no tools needed)

1. Open the cluster in the Azure Portal (start with Prod).
2. Left menu: **Kubernetes resources → Workloads**.
3. **+ Create → Apply a YAML**.
4. Paste only the Namespace, the first document in
   [`status-board-reader.yaml`](status-board-reader.yaml), and click **Apply**.
5. **+ Create → Apply a YAML** again. Paste everything after the first `---`
   and click **Apply**.

The Portal sends all the objects at once, so pasting the whole file in one go
fails with `namespaces "status-board" not found`.

## 2. Copy the login into .env

Open **Cloud Shell**: the `>_` icon in the Portal's top bar, then choose **Bash**.
It already has `az` and `kubectl` and is already logged in.

Find the cluster's name and resource group:

```bash
az aks list -o table
```

Connect to it (this only affects the Cloud Shell, nothing on the cluster):

```bash
az aks get-credentials -g <resource-group> -n <cluster-name>
```

Then paste this whole block. Set `N` and `SECTION` first: `N=1 SECTION=prod`
for Prod, `N=2 SECTION=demo` for Demo, matching the `SECTION_<n>` keys in `.env`.

```bash
N=1 SECTION=prod
echo "K8S_CLUSTER_${N}=section=${SECTION}; server=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
echo "K8S_CLUSTER_${N}_TOKEN=$(kubectl -n status-board get secret status-board-reader-token -o jsonpath='{.data.token}' | base64 -d)"
echo "K8S_CLUSTER_${N}_CA=$(kubectl -n status-board get secret status-board-reader-token -o jsonpath='{.data.ca\.crt}')"
```

It prints three lines. Copy them into the `.env` on the machine running the
board (the Pi), then restart the board.

The token is a password for this read-only account: it goes in `.env` only,
which is gitignored, and never into the repo or a chat.

Repeat steps 1-2 for Demo.

## Checking it worked

The section heading on the board shows `x of y up` for that cluster. If it says
**cluster unreachable**, hover over it for the reason:

- **HTTP 401 - token rejected**: the `_TOKEN` line is wrong or incomplete. Re-run step 2.
- **HTTP 403**: the YAML wasn't applied to this cluster, or only partly. Re-do step 1.
- **Timed out / ENOTFOUND**: the board can't reach the API server. Check the
  `server=` address, and whether someone turned on *Authorized IP ranges* under
  the cluster's **Settings → Networking**; if so, the Pi's public IP must be in that list.

## Removing it

Delete the `status-board` namespace, the `status-board-reader` ClusterRole and
the `status-board-reader` ClusterRoleBinding. The token stops working
immediately.
