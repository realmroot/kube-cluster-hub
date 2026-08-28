# Implementation status

## Target

Kube Cluster Hub is a stable, horizontally scalable cluster catalog and Kubernetes resource-server gateway. Its logical control plane and data plane ship together. It forwards Realmroot identities to Kubernetes, leaves resource authorization to Kubernetes RBAC, stores no cluster credential, and exposes the same catalog/proxy contract to Kite, other dashboards, and Realmroot Toolbox Agents.

## Implemented in this refactor

| Area | Result |
| --- | --- |
| Deployment shape | `control-plane/` and `data-plane/` are logical modules in the same Worker/Node artifact and scale together. |
| Human access | Separate catalog access-token and Kubernetes ID-token verification; verified Kubernetes token is forwarded directly. |
| Agent access | RFC 9728/OpenAPI discovery, authorized-client and scope enforcement, DPoP verification/replay persistence, Hub audience validation, direct token forwarding, Kubernetes-owned audience/RBAC validation, attributed audit. |
| Catalog | Credential-free cluster resources with one required reachable API origin and optimistic concurrency. |
| Proxy | Streaming HTTP for Worker/Node and native Node WebSocket upgrades; dangerous forwarding/impersonation headers stripped. |
| Persistence | D1 on Worker, PostgreSQL for replicated Node/Docker, SQLite for local single-process development. |
| UI | PKCE login with reload-safe tab session storage, cluster CRUD dialog, API endpoint/default/enabled metadata, audit list, loading/error/empty states. |
| Migration | D1/SQLite migration removes Connector/status/inventory fields, preserves direct endpoints, and disables legacy Connector rows for review. |
| Toolchain | TypeScript 7.0.2, Node 26 images/CI, Vite 8, Vitest 4, Biome 2, Wrangler 4, current React/Hono/Drizzle dependencies. |
| Removed | Go Connector, dispatch JWT/key generator, ServiceAccount impersonation, status heartbeat, ClusterProfile publisher, system inventory credential, Go CI/release artifacts. |

## Deliberately not supported

- storing kubeconfig, bearer token, client certificate, CA bundle, or client secret;
- a Hub-owned Kubernetes role model or per-user permission database;
- automatic tunnel lifecycle or a Hub-specific cluster agent;
- per-user/per-cluster informers or resource caches;
- Agent loops, AI features, or product-specific toolbox behavior;
- Cluster Inventory `ClusterProfile` publication from a privileged system credential.

Prometheus URL discovery remains catalog metadata for dashboard metrics. Helm, metrics, search, and Kubernetes resource UX remain dashboard responsibilities rather than Hub business features.

## Remaining external prerequisites

These are deployment/integration configuration, not missing Hub modules:

1. Realmroot must issue a Hub Resource Server token with Kubernetes-compatible identity/group claims.
2. Every kube-apiserver exposed to Agents must trust the Realmroot issuer, accept the Hub resource audience (or another audience present in the token), and map claims consistently.
3. Operators must supply network reachability from the Hub runtime to each API server that preserves streaming HTTP and WebSocket upgrades.
4. Kite must use the catalog for cluster selection and the human proxy with its Realmroot Kubernetes ID token.
5. Production Node deployments must provide shared PostgreSQL; Worker deployments must use migrated D1.

The acceptance record in [e2e-acceptance.md](e2e-acceptance.md) distinguishes automated repository verification from live Realmroot/kind/Kite verification and is updated only after each command is actually rerun.
