# Deployment

## Required configuration

| Variable | Purpose |
| --- | --- |
| `HUB_PUBLIC_URL` | canonical public origin |
| `HUB_UI_CLIENT_ID` | public PKCE client used by the UI and Kubernetes ID-token audience when shared |
| `OIDC_ISSUER` | Realmroot/OIDC issuer |
| `KUBERNETES_OIDC_AUDIENCE` | audience accepted by kube-apiserver |
| `OIDC_GROUPS_CLAIM` | group claim, default `groups` |
| `CATALOG_ADMIN_GROUPS` | groups allowed to mutate the catalog/read audit |
| `RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS` | Toolbox/controller OAuth client allow-list |
| `RESOURCE_SERVER_JWT_ALGORITHMS` | accepted access-token algorithms, default `RS256` |
| `TOKEN_EXCHANGE_CLIENT_ID` | confidential Realmroot machine Application permitted to exchange Hub Agent tokens |
| `TOKEN_EXCHANGE_CLIENT_SECRET` | secret for the token-exchange Application; store only in the deployment secret manager |
| `AUDIT_RETENTION` | retention duration, default `2160h` |
| `INVENTORY_ENABLED` | publish catalog entries as Cluster Inventory `ClusterProfile` resources |
| `INVENTORY_NAMESPACE` | Inventory namespace, default `cluster-inventory` |
| `INVENTORY_KUBECONFIG` | optional inline kubeconfig; required by Worker when Inventory is enabled |
| `INVENTORY_KUBECONFIG_FILE` | optional kubeconfig path for Node deployments |

The browser Application has no secret and uses Authorization Code + PKCE. Agent access uses a separate confidential machine Application only at Realmroot's token endpoint; its secret never reaches browsers or Kubernetes. There is no Hub signing key, target-cluster credential, or Connector token. Inventory publication, when enabled, needs only a deployment secret authorized to manage `ClusterProfile` resources in the configured namespace.

The sole Hub protected-resource URL is derived as `${HUB_PUBLIC_URL}/api`; it is the RFC 8707 resource indicator and token audience for both browser catalog access and Agent access. `OIDC_ISSUER` is the only accepted authorization-server issuer. Kubernetes browser requests continue to use `KUBERNETES_OIDC_AUDIENCE` because they are authenticated by kube-apiserver rather than the Hub API.

## Cloudflare Workers

The Worker bundle contains UI, control plane, and data plane. D1 is shared state and supports independently scheduled Worker instances. Configure `wrangler.jsonc`, apply all migrations, then deploy:

```bash
pnpm install --frozen-lockfile
pnpm wrangler d1 migrations apply kube-cluster-hub --remote
pnpm deploy
```

The daily cron prunes audit events. Workers must be able to reach every catalog `apiServerUrl` through deployment-managed network infrastructure. The network path must preserve chunked/streaming responses and WebSocket upgrades. Validate this explicitly with Kubernetes watch, `pods/log?follow=true`, exec, attach, and port-forward; basic request/response reachability is insufficient.

Worker Inventory publication accepts a kubeconfig containing a bearer token and
a publicly trusted HTTPS server. Cloudflare Workers cannot apply kubeconfig
client certificates, custom CA files/data, insecure TLS, exec plugins, or auth
providers. Store the kubeconfig with `wrangler secret put
INVENTORY_KUBECONFIG`; do not place it in `wrangler.jsonc`.

## Node and Docker

For development, `HUB_DATABASE_DSN` selects a local SQLite file. For production, set `HUB_DATABASE_URL` to PostgreSQL. The Node process applies ordered PostgreSQL migrations before it starts listening.

```bash
docker build -t kube-cluster-hub .
docker run --rm -p 8080:8080 --env-file .env kube-cluster-hub
```

All replicas are identical and stateless with PostgreSQL. Route normal HTTP and WebSocket Upgrade traffic to them using any HTTP load balancer. Graceful shutdown stops accepting traffic and closes the database pool.

The reference Kubernetes manifest starts two replicas and expects a Secret named `kube-cluster-hub-secrets` containing `HUB_DATABASE_URL`. Use a managed PostgreSQL database or an independently operated HA PostgreSQL cluster; do not mount one SQLite file into multiple Pods.

Node uses the official Kubernetes JavaScript client for Inventory publication.
It loads `INVENTORY_KUBECONFIG`, then `INVENTORY_KUBECONFIG_FILE`, or finally
the in-cluster ServiceAccount. The reference Role permits only get/list/watch,
create/update/patch/delete of `ClusterProfile` resources and status in the
configured namespace.

## Kubernetes OIDC and RBAC

Configure kube-apiserver's OIDC issuer, client/audience, username claim, and groups claim for Realmroot. Managed Kubernetes products expose equivalent OIDC authenticator or identity-provider configuration with provider-specific limits.

Bind Realmroot groups to Kubernetes `Role`/`ClusterRole` objects. The example in `deploy/agent-rbac-example.yaml` illustrates group bindings only; replace its group names and namespace with claims actually issued by Realmroot. The Hub does not impersonate those groups.

For Agent access, configure a Realmroot token-exchange policy from the Hub Resource Server to the Kubernetes Application. The Hub verifies the incoming DPoP-bound Hub access token, exchanges it at Realmroot for an ID token with `KUBERNETES_OIDC_AUDIENCE`, verifies the returned token and actor chain, and forwards only that ID token. kube-apiserver therefore needs to accept only the shared Kubernetes Application audience used by browser dashboards and kubelogin.

## Operations

- Probe `/healthz` for process health and `/readyz` for shared database readiness.
- Alert on 5xx rate, Kubernetes upstream latency, database errors, and audit write failures.
- Back up D1/PostgreSQL and test restoration.
- Keep the public URL stable because OAuth resources, callbacks, DPoP canonical URIs, and dashboard configuration depend on it.
- Roll replicas gradually. No sticky sessions are required; a WebSocket remains on its accepting replica for that connection.
- Verify HTTP list/watch/log and WebSocket exec/attach/port-forward after Kubernetes, ingress, or runtime upgrades.
- Treat the complete network path as part of the data plane. Reject any intermediary that buffers an open watch/log response even if ordinary Kubernetes requests succeed.
