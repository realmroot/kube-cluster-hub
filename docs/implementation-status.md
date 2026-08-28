# Goal and implementation status

Updated: 2026-08-28

## Goal

Provide one protocol-oriented cluster directory and Kubernetes access boundary
that can serve Kite, Headlamp, other dashboards, kubectl-compatible OIDC users,
and Realmroot Agents without inventing a second Kubernetes authorization model.
Cluster connection records contain only names, API endpoints, CA/TLS metadata,
optional presentation/metrics metadata, enablement, and publication status.

## Stages

| Stage | Target | Actual status |
| --- | --- | --- |
| 1 | Architecture and contracts | Complete. Human and Agent identity paths, resource ownership, catalog API, Kubernetes pass-through, ClusterProfile publication, and deployment boundary are documented. |
| 2 | Gateway service | Complete. SQLite persistence, ETag preconditions, cursor pagination, RFC 9457 errors, OIDC user validation, admin policy, streaming reverse proxy, immutable audit, retention, readiness, and safe transport reuse are implemented. |
| 3 | Agent Resource Server | Complete. RFC 9728 metadata, OpenAPI discovery, RFC 9068 claim checks, exact audience/client/scope validation, RFC 9449 DPoP and replay protection, RFC 8693 actor attribution, Kubernetes impersonation, namespace RBAC, and audit are implemented. |
| 4 | Cluster Inventory | Complete. Enabled catalog clusters reconcile to v0.1.3 ClusterProfiles with status/health and the `oidc-passthrough` access provider. Disabled/deleted clusters are removed. |
| 5 | Kite integration | Complete. Kite's cluster CRUD is a Gateway catalog projection, resource calls use the current user's ID token through the Gateway, local credential-bearing state is not introduced, Agent endpoints moved out of Kite, and Gateway audit is visible in Settings. |
| 6 | Headlamp integration | Implemented and locally accepted. A provider without `execConfig` inherits Headlamp's current-user OIDC configuration. The patch is issuer-neutral and covered by tests; upstream merge is still an external community action. |
| 7 | Shared public PKCE client | Complete locally. Kite and Headlamp use one public Authorization Code + PKCE client and kube-apiserver trusts that single audience. Neither dashboard needs a client secret. |
| 8 | kind and live Realmroot acceptance | Complete. One Kubernetes v1.33.1 kind cluster was used for human UI reads/writes, metrics, Agent discovery/read/create/get/delete, RBAC denial, watch streaming, audit, and failure paths. Temporary write resources were deleted. |
| 9 | Release verification | Complete. All three repositories pass their release checks, the final images/processes are running, and Agent-attributed local commits preserve the implementation. Test and runtime evidence is recorded in `e2e-acceptance.md`. |

## Deliberate boundaries

- Gateway does not model Kubernetes resources, Helm releases, metrics, search,
  logs, exec, or watch as proprietary business resources. Those remain native
  Kubernetes or dashboard functions.
- Human OIDC tokens are never exchanged for a Gateway-owned Kubernetes
  identity and are never rewritten.
- Agent access tokens are never forwarded to kube-apiserver. They admit a
  request to the Resource Server; Kubernetes impersonation plus RBAC makes the
  final authorization decision.
- A remote-cluster Agent execution credential must be cluster-local (for
  example in a tunnel component) or obtained through a standards-based adapter.
  The catalog must not become a store for central cluster-admin credentials.

## External follow-up, not an implementation defect

The Headlamp change must be proposed and reviewed upstream. Until it is merged,
the tested Headlamp image is built from the small local patch described in
`headlamp-upstream.md`. Production exposure also needs a stable HTTPS route;
the acceptance quick tunnel is not a production endpoint.
