# Deployment

Deploy one Kube Cluster Hub for your own Realmroot tenant or team. The Hub stores only a cluster catalog; it never stores credentials for target clusters.

## Required settings

| Variable | Purpose | Secret |
| --- | --- | --- |
| `HUB_PUBLIC_URL` | Final public HTTPS origin of this Hub | no |
| `HUB_UI_CLIENT_ID` | Realmroot public SPA client ID; also the default Kubernetes OIDC audience | no |
| `OIDC_ISSUER` | Realmroot/OIDC issuer | no |
| `CATALOG_ADMIN_GROUPS` | Comma-separated groups allowed to change the catalog and read audit events | no |
| `RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS` | Comma-separated Toolbox/controller OAuth client IDs allowed to call Agent routes | no |
| `TOKEN_EXCHANGE_CLIENT_ID` | Realmroot machine Application client ID used for RFC 8693 exchange | no |
| `TOKEN_EXCHANGE_CLIENT_SECRET` | Machine Application secret | **yes** |

These seven settings enable the full human and Agent product. Only the machine Application secret is confidential.

## Optional settings

| Variable | Default | When to set it |
| --- | --- | --- |
| `KUBERNETES_OIDC_AUDIENCE` | `HUB_UI_CLIENT_ID` | Kubernetes deliberately uses a separate client/audience |
| `OIDC_GROUPS_CLAIM` | `groups` | The provider uses another standards-compatible groups claim |
| `RESOURCE_SERVER_JWT_ALGORITHMS` | `RS256` | The authorization server uses another explicitly approved JWT algorithm |
| `CLUSTER_ENDPOINT_ALLOWLIST` | unrestricted | Restrict catalog endpoints to comma-separated exact HTTPS origins |
| `AUDIT_RETENTION` | `2160h` | Change the 90-day audit retention |
| `INVENTORY_ENABLED` | `false` | Publish catalog entries as Cluster Inventory resources |
| `INVENTORY_NAMESPACE` | `cluster-inventory` | Publish into another inventory namespace |
| `INVENTORY_KUBECONFIG` | none | Inline Inventory API kubeconfig |
| `INVENTORY_KUBECONFIG_FILE` | none | Node-only path to an Inventory API kubeconfig |

Node also accepts `PORT` (default `8080`), `HUB_DATABASE_DSN` for local SQLite, and `HUB_DATABASE_URL` for production PostgreSQL. `HUB_POSTGRES_TEST_URL` is test-only. There are no legacy `HUB_PORT`, Hub signing-key, Connector-token, or target-cluster credential settings.

## Realmroot setup

Create these registrations in the tenant that owns the Hub:

1. A public SPA Application using Authorization Code + PKCE. Add `${HUB_PUBLIC_URL}/auth/callback` as an exact redirect URI. Use its client ID as `HUB_UI_CLIENT_ID`.
2. One Resource Server at the exact resource URL `${HUB_PUBLIC_URL}/api`. Configure the catalog, audit, and Kubernetes scopes exposed by the Hub OpenAPI document.
3. One confidential machine Application for the Hub's token-exchange call. Store its client ID and secret in the Hub deployment.
4. Authorize exchange from the Hub Resource Server to the Kubernetes Application/audience. The exchanged ID token must retain the subject, Agent/controller attribution, and groups required by Kubernetes RBAC.

The SPA has no secret. The Hub derives its sole protected-resource URL from `HUB_PUBLIC_URL`; it does not require another Resource Server URL setting.

## Cloudflare Workers

The Worker contains the UI, control plane, and Kubernetes proxy. D1 provides shared catalog, replay, and audit state.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/realmroot/kube-cluster-hub)

The button uses the same committed [`wrangler.toml`](../wrangler.toml) as command-line deployment. It provisions or reuses a D1 database named `kube-cluster-hub` through binding `DB`; `database_id` and account-specific values are intentionally absent. `.dev.vars.example` lets Cloudflare request the seven product settings.

There is one bootstrap dependency: the final Worker origin is needed when creating the Realmroot registrations. If the origin is not known before the first deploy, let the button provision the Worker, create the Realmroot registrations with that origin, set the variables/secrets in Cloudflare, and redeploy. The first unconfigured deployment is not ready for login or API traffic.

Command-line deployment uses the same file and applies D1 migrations by binding name:

```bash
pnpm install --frozen-lockfile
pnpm deploy
```

`keep_vars = true` preserves values managed in the Cloudflare dashboard or secret store. Do not add tenant settings or secrets to `wrangler.toml`. Store `TOKEN_EXCHANGE_CLIENT_SECRET` and, when used, `INVENTORY_KUBECONFIG` as Worker secrets.

Workers must be able to reach every catalog `apiServerUrl`. The network path must preserve streaming responses and WebSocket upgrades; validate Kubernetes watch, following logs, exec, attach, and port-forward rather than only ordinary HTTP requests.

Worker Inventory publication supports a bearer-token kubeconfig targeting a publicly trusted HTTPS endpoint. It cannot use client certificates, custom CA data, insecure TLS, exec plugins, or auth-provider plugins.

## Node and Docker

Copy `.env.example` to `.env`. SQLite is intended only for a single local process. Set `HUB_DATABASE_URL` to PostgreSQL for production replicas; migrations run before the process starts listening.

```bash
docker build -t kube-cluster-hub .
docker run --rm -p 8080:8080 --env-file .env kube-cluster-hub
```

Every PostgreSQL-backed replica is stateless and can serve ordinary requests or WebSocket upgrades. Place replicas behind an HTTP load balancer; sticky sessions are not required beyond the lifetime of an accepted WebSocket. The reference Kubernetes manifest starts two replicas and expects `HUB_DATABASE_URL` plus `TOKEN_EXCHANGE_CLIENT_SECRET` in `kube-cluster-hub-secrets`.

For Inventory publication, Node loads `INVENTORY_KUBECONFIG`, then `INVENTORY_KUBECONFIG_FILE`, then in-cluster ServiceAccount credentials. The reference Role is limited to `ClusterProfile` resources in the configured namespace.

## Kubernetes OIDC and RBAC

Configure each kube-apiserver or managed Kubernetes OIDC integration to trust the Realmroot issuer, accept the Kubernetes audience, and map the username and groups claims. Bind Realmroot groups to Kubernetes `Role`/`ClusterRole` objects. The example in [`deploy/agent-rbac-example.yaml`](../deploy/agent-rbac-example.yaml) is illustrative; replace its groups and namespaces.

The Hub never impersonates a user or decides Kubernetes resource permissions. Kubernetes validates the forwarded human or exchanged Agent ID token and applies RBAC.

## Operations

- Probe `/healthz` for process health and `/readyz` for database readiness.
- Back up D1/PostgreSQL and test restoration.
- Alert on 5xx responses, upstream latency, database failures, token-exchange failures, and audit-write failures.
- Keep `HUB_PUBLIC_URL` stable; OAuth callbacks, the Resource Server audience, DPoP canonical URIs, and dashboard configuration depend on it.
- Roll Node replicas gradually. Shutdown stops readiness, refuses new upgrades, drains open WebSockets to a deadline, and closes the database.

See [Operations](operations.md) for initial SLOs, alerts, edge rate limiting, backup/restore, secret rotation, and upgrades.
