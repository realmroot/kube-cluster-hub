# Deployment

Deploy one Kube Cluster Hub for your own Realmroot tenant or team. The Hub stores only a cluster catalog; it never stores credentials for target clusters.

## Configuration

Use the annotated [`.env.example`](../.env.example) for Node/Docker or [`.dev.vars.example`](../.dev.vars.example) for Workers. These files are the canonical configuration reference. Inventory resources are always published in `cluster-inventory`, audit events are retained for 90 days, access tokens use RS256, and Realmroot token exchange supplies the standard `groups` claim.

## Realmroot setup

Create these registrations in the tenant that owns the Hub:

1. A public SPA Application using Authorization Code + PKCE. Add the Hub's `/auth/callback` URL as an exact redirect URI. Kubernetes uses the same client ID as its OIDC audience.
2. One Resource Server at the Hub's `/api` URL. Configure the catalog, audit, and Kubernetes scopes exposed by the Hub OpenAPI document. Realmroot decides which users and OAuth clients may receive each scope; the Hub does not maintain duplicate group or client allowlists.
3. One confidential machine Application for the Hub's token-exchange call. Store its client ID and secret in the Hub deployment.
4. Authorize exchange from the Hub Resource Server to the Kubernetes Application/audience. The exchanged ID token must retain the subject, Agent/controller attribution, and groups required by Kubernetes RBAC.

The SPA has no secret. The Hub derives its sole protected-resource URL from its public origin; it does not require another Resource Server URL setting.

## Cloudflare Workers

The Worker contains the UI, control plane, and Kubernetes proxy. D1 provides shared catalog, replay, and audit state.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/realmroot/kube-cluster-hub)

The button uses the same committed [`wrangler.toml`](../wrangler.toml) as command-line deployment. It provisions or reuses a D1 database named `kube-cluster-hub` through binding `DB`; `database_id` and account-specific values are intentionally absent. The repository metadata describes the five product settings Cloudflare requests during deployment.

There is one bootstrap dependency: the final Worker origin is needed when creating the Realmroot registrations. If the origin is not known before the first deploy, let the button provision the Worker, create the Realmroot registrations with that origin, set the variables/secrets in Cloudflare, and redeploy. The first unconfigured deployment is not ready for login or API traffic.

Command-line deployment uses the same file and applies D1 migrations by binding name:

```bash
pnpm install --frozen-lockfile
pnpm deploy
```

Cloudflare preserves values managed in its dashboard or secret store. Do not add tenant settings or secrets to `wrangler.toml`. Store the Hub Application secret and any inline Inventory kubeconfig as Worker secrets.

Workers must be able to reach every catalog `apiServerUrl`. The network path must preserve streaming responses and WebSocket upgrades; validate Kubernetes watch, following logs, exec, attach, and port-forward rather than only ordinary HTTP requests.

Worker Inventory publication supports a bearer-token kubeconfig targeting a publicly trusted HTTPS endpoint. It cannot use client certificates, custom CA data, insecure TLS, exec plugins, or auth-provider plugins.

## Node and Docker

Copy `.env.example` to `.env`. SQLite is intended only for a single local process. Configure PostgreSQL for production replicas; migrations run before the process starts listening.

```bash
docker build -t kube-cluster-hub .
docker run --rm -p 8080:8080 --env-file .env kube-cluster-hub
```

Every PostgreSQL-backed replica is stateless and can serve ordinary requests or WebSocket upgrades. Place replicas behind an HTTP load balancer; sticky sessions are not required beyond the lifetime of an accepted WebSocket. The reference Kubernetes manifest starts two replicas and reads the database URL and Hub Application secret from `kube-cluster-hub-secrets`.

For Inventory publication, Node supports an inline kubeconfig, a kubeconfig file, or in-cluster ServiceAccount credentials. The reference Role is limited to `ClusterProfile` resources in the fixed `cluster-inventory` namespace.

## Kubernetes OIDC and RBAC

Configure each kube-apiserver or managed Kubernetes OIDC integration to trust the Realmroot issuer, accept the Kubernetes audience, and map the username and groups claims. Bind Realmroot groups to Kubernetes `Role`/`ClusterRole` objects. The example in [`deploy/agent-rbac-example.yaml`](../deploy/agent-rbac-example.yaml) is illustrative; replace its groups and namespaces.

The Hub never impersonates a user or decides Kubernetes resource permissions. Kubernetes validates the forwarded human or exchanged Agent ID token and applies RBAC.

## Operations

- Probe `/healthz` for process health and `/readyz` for database readiness.
- Back up D1/PostgreSQL and test restoration.
- Alert on 5xx responses, upstream latency, database failures, token-exchange failures, and audit-write failures.
- Keep the public Hub origin stable; OAuth callbacks, the Resource Server audience, DPoP canonical URIs, and dashboard configuration depend on it.
- Roll Node replicas gradually. Shutdown stops readiness, refuses new upgrades, drains open WebSockets to a deadline, and closes the database.

See [Operations](operations.md) for initial SLOs, alerts, edge rate limiting, backup/restore, secret rotation, and upgrades.
