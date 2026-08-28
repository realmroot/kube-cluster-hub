# Protocol and security boundaries

## Public APIs

Every catalog request carries `API-Version: 2026-08-28` and a resource-audience
OAuth Bearer Access Token. Reads require their published catalog scope.
Mutations, audit reads, and Connector-status reads additionally require a group
in `CATALOG_ADMIN_GROUPS`. The catalog token is never sent to Kubernetes.

| Method and URI | Meaning |
| --- | --- |
| `GET /api/catalog/clusters` | Cursor-paginated cluster collection |
| `GET /api/catalog/clusters/{id}` | One cluster and current Connector/publication state |
| `PUT /api/catalog/clusters/{id}` | Create with `If-None-Match: *`, replace with `If-Match` |
| `DELETE /api/catalog/clusters/{id}` | Delete with `If-Match` |
| `GET /api/catalog/audit-events` | Immutable, cursor-paginated access audit |
| `GET /api/catalog/connector-statuses/{id}` | Current Connector heartbeat |
| `PUT /api/connector-statuses/{id}` | Connector-only heartbeat update |
| `ANY /clusters/{id}/kubernetes/*` | Current-user Kubernetes API passthrough |

Collections use opaque cursor pagination and RFC 8288 `Link` headers. Errors
use `application/problem+json`. Cluster writes reject credential-shaped fields,
unknown fields, URL userinfo, unstable Connector IDs, and invalid mode-specific
configuration.

## Agent Resource Server

The exact `RESOURCE_SERVER_URL` publishes:

- RFC 9728 metadata at
  `/.well-known/oauth-protected-resource/{resource-path}`;
- an OpenAPI service description at `/openapi/agent.json`;
- `GET /api/agent/clusters` and `GET /api/agent/audit-events`;
- `ANY /api/agent/clusters/{id}/kubernetes/*`.

The control plane validates the access-token issuer, exact resource audience,
authorized OAuth client, lifetime, signature, scopes, and RFC 8693 `act`
identity. Each request also requires a fresh ES256 RFC 9449 DPoP proof. The DPoP
`htu` comparison follows RFC 9449 and excludes query and fragment; the internal
dispatch JWT separately binds the complete Kubernetes path and query.

| Scope | Admission ceiling |
| --- | --- |
| `clusters:read` | List enabled clusters |
| `audit-events:read` | Read immutable audit records |
| `kubernetes:read` | Kubernetes reads, watch, and logs |
| `kubernetes:write` | Mutations, exec, attach, and port-forward |

Kubernetes RBAC is still authoritative. A valid write scope can still receive
a native Kubernetes 403.

## Control Plane to Connector

The transport is normal HTTP semantics over trusted HTTPS. The control plane
forwards method, path, query, headers, body, response status, trailers, and
streaming behavior. It adds:

- `Authorization: Bearer <dispatch JWT>`;
- `X-Cluster-Authorization: Bearer <ID token>` for the human path only.

The ES256 dispatch JWT expires after 30 seconds and binds:

- issuer, audience, `kid`, `iat`, `exp`, and unique `jti`;
- Connector/cluster ID;
- HTTP method and full path/query;
- either the human token hash or the verified Agent attribution and requested
  Kubernetes scope.

The Connector verifies every binding, rejects a replayed `jti`, strips cookies,
DPoP, and caller impersonation headers, and never accepts an external Agent
token. Its status token can only write the matching heartbeat resource; it is
not valid for dispatch or Kubernetes access.

## Kubernetes execution

For humans, the Connector sends the original ID token as `Bearer` and
kube-apiserver performs OIDC authentication and group-to-RBAC authorization.

For Agents, the Connector authenticates with its projected cluster-local
ServiceAccount token and sends controlled impersonation headers:

- username: `kube-cluster-hub:agent`;
- group: `kube-cluster-hub:agents:read` or `kube-cluster-hub:agents:write`;
- extras: verified actor issuer/subject and controller subject.

The ServiceAccount is granted only the `impersonate` verbs in
`deploy/connector.yaml`; namespace RoleBindings decide what those impersonated
groups can actually do. It is not bound to cluster-admin.

## Streaming

- HTTP response bodies are streamed without buffering, including watch and
  follow-log responses.
- Node/Docker bridges native HTTP Upgrade for Kubernetes WebSocket operations.
- Workers return the upstream WebSocket response directly.
- Client cancellation is recorded as audit status 499.

## Configuration and secrets

`.env.example` is the complete development schema. Runtime secrets are supplied
as environment variables or platform secrets:

- `DISPATCH_SIGNING_PRIVATE_JWK` exists only in the control plane;
- `DISPATCH_SIGNING_PUBLIC_JWKS` exists in Connectors and may contain the
  current and next public keys during rotation;
- the Connector ServiceAccount token is Kubernetes-projected and never copied
  to the control plane;
- `CONNECTOR_STATUS_TOKEN` authorizes only heartbeat writes.

No generated secret file, launcher, kubeconfig, or dashboard client secret is
required. Dashboards use one public Authorization Code + PKCE OIDC client and
RFC 8707 resource indicators for the catalog Access Token. `offline_access` is
required so long-running dashboard sessions can refresh.

Audit retention defaults to 90 days. SQLite and each Connector are intentionally
single-replica. Worker replay protection and audit storage use D1 transactions.
