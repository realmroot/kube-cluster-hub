# Goal and implementation status

Updated: 2026-08-28

## Goal

Provide one simple, protocol-oriented cluster directory and access boundary for
Kite, Headlamp, other dashboards, and Realmroot Agents. The control plane must
run from one TypeScript implementation on Workers/D1 or Node/Docker/SQLite; a
small Go Connector must keep Kubernetes credentials and Agent execution inside
each cluster. Kubernetes HTTP/OIDC/RBAC remain authoritative.

## Delivered stages

| Stage | Actual implementation |
| --- | --- |
| Control-plane split | The previous Go monolith was removed. Hono domain/auth/dispatch/inventory code is shared by Worker and Node entry points; D1 and SQLite are adapters behind one store contract. |
| Cluster data plane | A single-replica Go Connector verifies request-bound ES256 dispatch JWTs, forwards user ID tokens, uses a cluster-local projected ServiceAccount for Agent impersonation, reports status, and supports HTTP streaming and WebSockets. |
| Catalog and migration | API version `2026-08-28` models `connector` and `direct` access. Existing SQLite catalog/audit data migrates in place; legacy public TLS records become direct mode, while legacy custom-CA records are disabled until a Connector is supplied. |
| Resource Server | RFC 9728 discovery, OpenAPI, RFC 9068 claim checks, RFC 9449 DPoP/replay protection, RFC 8693 actor attribution, scopes, immutable audit, and Kubernetes-native status/errors are complete. |
| Inventory | Enabled clusters reconcile to Cluster Inventory API v0.1.3 ClusterProfiles. Connector readiness/version are reflected without copying credentials into the profile. |
| Kite | Cluster CRUD projects the catalog including Connector mode, current-user ID tokens reach the Kubernetes path, audit is visible, and Agent endpoints remain outside Kite. The production UI/backend build and full suites pass. |
| Headlamp | The generic credentialless provider inherits deployment OIDC. Offline sessions request standards-compliant consent. Both changes are issuer/product neutral and covered by Headlamp tests; upstream merge remains external work. |
| Runtime targets | Worker local D1 migration and runtime smoke pass; Worker deployment dry-run passes. Node/SQLite and Connector container images build; the Node image starts and passes readiness. |
| kind/Toolbox | One Kubernetes v1.33.1 kind cluster verifies user UI resources/metrics, Agent discovery/read/write/denial/audit/watch, Connector status, and WebSocket exec. Temporary resources are removed. |

## Deliberate product boundaries

- The service does not model Pods, Deployments, CRDs, Helm releases, metrics,
  search, logs, exec, or watch as proprietary resources. Those remain native
  Kubernetes/dashboard functions.
- Human tokens are never exchanged, rewritten, or mapped to Gateway roles.
- Agent access tokens are never forwarded to kube-apiserver.
- Agent access requires Connector mode. Direct mode is only a compatibility
  path for human access to a publicly reachable Kubernetes API.
- The catalog cannot store tokens, client certificates, kubeconfigs,
  ServiceAccounts, users, group mappings, or Kubernetes roles.
- Connector-mode catalog records also omit kube-apiserver URL, CA bundle, and
  TLS name; the cluster-local Connector owns all three.
- One Connector per cluster and one Node/SQLite replica are intentional. Use
  Workers/D1 for horizontally distributed control-plane HTTP execution.

## Old architecture removal

Deleted code includes the Go OIDC/Agent validators, monolithic HTTP server,
proxy/informer publisher, configuration package, and SQLite store. The old
`deploy/gateway.yaml` was replaced with separate control-plane and Connector
manifests. Searches for the obsolete actor claims and embedded AI/Agent loop
return no product code; Cloudflare generated ambient type declarations are not
checked in.

The local acceptance cluster retains only the old PVC as a recovery copy of
the pre-migration audit database. The old process is stopped and no
ClusterProfile or dashboard route points at it. Deleting that PVC is a separate
data-retention decision, not a runtime dependency.

## External follow-up

- Submit the two generic Headlamp changes upstream and track SIG Multicluster's
  provider capability naming.
- Replace the acceptance quick tunnel with a stable trusted HTTPS domain before
  production deployment.
- Configure production D1/SQLite backup, dispatch-key rotation, observability,
  and retention operations. These are deployment operations, not missing
  architecture paths.
