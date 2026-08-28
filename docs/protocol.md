# Protocol and configuration

## Cluster catalog

Every `/api/catalog` request carries `API-Version: 2026-08-27` and a standard
OIDC Bearer ID token. Reads require a valid token. Writes and audit reads also
require membership in one of `CATALOG_ADMIN_GROUPS`.

| Method and URI | Meaning |
| --- | --- |
| `GET /api/catalog/clusters` | Cursor-paginated cluster collection |
| `GET /api/catalog/clusters/{id}` | One cluster and its publication status |
| `PUT /api/catalog/clusters/{id}` | Create with `If-None-Match: *`, or replace with `If-Match` |
| `DELETE /api/catalog/clusters/{id}` | Delete with `If-Match` |
| `GET /api/catalog/audit-events` | Immutable, cursor-paginated user and Agent access audit |

Cluster IDs are stable DNS labels. A record stores display name, description,
API server URL, CA bundle, optional TLS server name and Prometheus URL,
enabled/default flags, resource version, timestamps, and ClusterProfile
publication status. It cannot store tokens, client certificates, kubeconfigs,
users, or authorization roles.

## Human Kubernetes proxy

`/clusters/{id}/kubernetes/*` preserves method, query, body, upgrade/streaming
behavior, and the signed-in user's Bearer ID token. It removes cookies, DPoP,
and all caller-supplied impersonation headers. kube-apiserver must trust the
same issuer and client ID and maps the token's standard claims to native users
and groups.

## Agent Resource Server

The protected resource is exactly `RESOURCE_SERVER_URL`. It publishes:

- `/.well-known/oauth-protected-resource{resource-path}`;
- a `service-desc` link and `/openapi/agent.json`;
- cluster discovery, immutable audit reads, and the canonical Kubernetes API.

Tokens must be audience-bound to the exact resource, issued by
`RESOURCE_SERVER_ISSUER`, presented by an authorized client, contain an `act`
actor, carry the required scope, and be bound to a fresh ES256 DPoP proof.
`clusters:read`, `audit-events:read`, `kubernetes:read`, and `kubernetes:write`
are admission scopes. Native Kubernetes RBAC is still authoritative.

OpenAPI advertises common Kubernetes query parameters for selectors, watch
streaming, resource versions, timeouts, and pod-log streaming. Unmodeled
Kubernetes paths still pass through unchanged.

## Runtime configuration

The complete example is `.env.example`. Required groups are:

- service/public URLs and database DSN;
- human OIDC issuer, Kubernetes audience, groups claim, and catalog-admin groups;
- Agent Resource Server URL, issuer, authorized clients, and JWT algorithms;
- cluster-local Agent read/write group names.

`AUDIT_RETENTION` defaults to 90 days. Expired records are pruned daily and
unfinished records from a terminated process are finalized as client-closed on
the next start. SQLite is intentionally single-replica; a future HA release
should introduce an external transactional store before replicas are increased.
