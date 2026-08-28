# Deployment guide

## Choose a control-plane runtime

The application has one TypeScript business implementation and two runtime
adapters. Choose one; do not run both against the same public Resource Server.

| Runtime | Persistence | Recommended use |
| --- | --- | --- |
| Cloudflare Worker | D1 | Internet-facing, horizontally distributed control plane |
| Node container | SQLite on a persistent volume | Single-replica VPS or Kubernetes deployment |

Both require a stable HTTPS `HUB_PUBLIC_URL`. The URL is also the OAuth
Resource Server origin and therefore cannot be changed without updating the
registered Realmroot Resource and obtaining new audience-bound Agent tokens.

## Required secrets

Generate one P-256 ES256 JWK pair. Store only the private JWK in the control
plane and a public JWKS in each Connector. The active public/private JWKs must
carry the same non-empty `kid`.

| Secret | Location | Authority |
| --- | --- | --- |
| `DISPATCH_SIGNING_PRIVATE_JWK` | control plane | Signs 30-second request dispatches |
| `DISPATCH_SIGNING_PUBLIC_JWKS` | Connector | Verifies dispatches only; supports overlapping rotation keys |
| `CONNECTOR_STATUS_TOKEN` | both | Writes Connector heartbeat resources only |
| projected ServiceAccount token | Connector Pod | Authenticates to that cluster's API only |

OIDC dashboards are public Authorization Code + PKCE clients and have no client
secret. Never put a kubeconfig, Kubernetes bearer token, client certificate, or
ServiceAccount token in control-plane configuration.

## Worker + D1

1. Copy `wrangler.jsonc` and replace the example D1 database ID.
2. Configure non-secret values as Worker vars and the three sensitive values
   above with `wrangler secret put`.
3. Apply schema before the first deployment:

   ```sh
   pnpm exec wrangler d1 migrations apply kube-cluster-hub --remote
   ```

4. Deploy:

   ```sh
   pnpm exec wrangler deploy
   ```

5. Verify `/healthz`, `/readyz`, RFC 9728 metadata, and OpenAPI discovery from
   the stable public domain.

The scheduled handler reconciles ClusterProfiles and prunes audit retention.
Configure the cron in `wrangler.jsonc`; local `wrangler dev` does not run it
automatically.

## Node/Docker/SQLite

Build `Dockerfile` and run exactly one replica with a persistent writable mount
for `HUB_DATABASE_DSN`. The container itself runs non-root with a read-only
root filesystem. `deploy/control-plane.yaml` provides a Kubernetes template
using `Recreate` strategy and a ReadWriteOnce PVC.

Terminate TLS at a trusted reverse proxy, Ingress, Gateway API implementation,
or named Cloudflare Tunnel. A quick tunnel is suitable only for local
acceptance because its hostname is ephemeral.

## Connector

Deploy `Dockerfile.connector` once in every managed private cluster using
`deploy/connector.yaml`:

1. set the stable `CONNECTOR_CLUSTER_ID` to the catalog cluster ID;
2. set the HTTPS `CONTROL_PLANE_URL` and dispatch issuer/audience;
3. install the public JWK and heartbeat token as Kubernetes Secrets;
4. expose the Connector through trusted HTTPS and store that URL as
   `connectorUrl` in the catalog;
5. bind the impersonated read/write groups only in namespaces the Agent may
   operate.

The Connector listener is HTTP because TLS is expected at its cluster-local
Ingress/Gateway boundary. Plain HTTP Connector URLs are rejected except for
loopback development. `CONTROL_PLANE_URL` is likewise required to use HTTPS
outside loopback.

Keep `replicas: 1`. Dispatch replay state is intentionally in memory and a
request expires after 30 seconds. Kubernetes restarts the Pod on failure.

## Dashboard clients

- The built-in browser UI reads `GET /api/ui-config`, performs public-client
  Authorization Code + PKCE, and requests the catalog resource indicator.
- Kite receives the Hub origin and API version `2026-08-28`. Its add/edit form
  writes metadata only. Kite must use the Access Token for `/api/catalog/*`
  and the ID Token for `/clusters/*/kubernetes/*`.
- Other dashboards can consume the same catalog/OpenAPI contract or the
  credential-free Cluster Inventory `ClusterProfile` projection.
- Browser origins and registered callback URLs must match exactly. Loopback
  hostnames such as `localhost` and `127.0.0.1` are different origins.

## Operations

- Back up D1 or the SQLite PVC before schema/application upgrades.
- Alert when Connector `observedAt` is stale or state is degraded.
- Rotate a dispatch key by adding the new public JWK to every Connector JWKS,
  switching the control-plane private JWK after all Connectors trust its `kid`,
  and removing the retired public JWK after in-flight dispatches have expired.
- Retain Hub audit according to `AUDIT_RETENTION` and collect native
  kube-apiserver audit separately; they answer different boundary questions.
- Test a representative read, forbidden write, allowed write, watch, and exec
  after every Connector or Kubernetes version upgrade.
