# Architecture

## Decision

The Hub has a logical control plane and data plane but one deployment unit. Every Worker isolate or Node replica can serve catalog requests and proxy Kubernetes traffic. This keeps the protocol and operations small while allowing ordinary horizontal scaling behind one hostname.

```text
                         one stateless deployment unit
                      ┌─────────────────────────────────┐
Realmroot OIDC ───────┤ authentication / authorization  │
Kite / browser ───────┤ cluster catalog                 ├── reachable kube-apiserver
Realmroot Toolbox ────┤ Agent resource server + audit   │
                      ┤ streaming Kubernetes proxy      │
                      └──────────────┬──────────────────┘
                                     │
                              D1 or PostgreSQL
```

`control-plane/` owns identity verification, catalog resources, OpenAPI/discovery, audit, and persistence. `data-plane/` owns target construction, request sanitization, token forwarding, and HTTP error translation. Node's native Upgrade handler follows the same rules for exec, attach, and port-forward WebSockets.

## Cluster catalog

A cluster contains only:

| Field | Meaning |
| --- | --- |
| `id` | immutable DNS-label path identifier |
| `displayName` | human-facing name |
| `description` | optional catalog metadata |
| `apiServerUrl` | trusted, reachable Kubernetes API origin |
| `prometheusUrl` | optional dashboard discovery hint |
| `enabled` | proxy availability switch |
| `default` | catalog default marker |
| `resourceVersion` | optimistic concurrency version |
| timestamps | creation and last replacement time |

It contains no credentials, per-user permissions, TLS material, connection mode, or deployment-specific tunnel information. A tunnel is just one way to make `apiServerUrl` reachable.

## Human request flow

1. The browser performs Authorization Code + PKCE against Realmroot.
2. Catalog calls use a catalog-audience access token. Admin groups control catalog mutation only.
3. Kubernetes calls use the Kubernetes-audience ID token.
4. The Hub verifies issuer, audience, signature, expiry, and token type; resolves an enabled catalog cluster; sanitizes headers; and forwards that ID token.
5. kube-apiserver derives the username/groups from the token and applies Kubernetes RBAC.

The Hub does not maintain a second Kubernetes authorization decision.

## Agent request flow

1. Realmroot Toolbox discovers RFC 9728 metadata and the Hub OpenAPI document.
2. Realmroot issues a DPoP-bound access token for the Agent/controller/client and approved scopes.
3. The token is audience-bound to the Hub Resource Server. The Hub validates that audience, DPoP binding, replay, actor/controller identity, client allow-list, and the route scope.
4. The same signed access token is forwarded to kube-apiserver. Kubernetes independently validates an audience configured for that cluster and authorizes its standard identity/group claims through RBAC. The Hub never treats its own audience check as proof that Kubernetes will accept the token.
5. The Hub records controller, Agent actor, client, token ID, scope, cluster, route, status, and duration.

Hub scopes are a resource-server boundary, not a replacement for Kubernetes RBAC. A request must pass both layers.

## Scaling and state

- Worker: Cloudflare scales isolates; D1 stores shared catalog, replay, and audit state.
- Node/Docker: replicas are stateless when `HUB_DATABASE_URL` points to PostgreSQL. Any replica can handle any request or WebSocket.
- SQLite (`HUB_DATABASE_DSN`) is deliberately local development mode and must not be used by multiple replicas.
- No in-memory informer or per-user/per-cluster cache is required. Memory therefore does not grow with the user × cluster product.

API-server networking and load balancing are external concerns. Standard private networking, Cloudflare Tunnel, Connect, VPNs, or managed Kubernetes endpoints all work without a Hub-specific component.

## Removed architecture

The retired Connector, ServiceAccount impersonation, dispatch JWT, Connector heartbeat, ClusterProfile publisher, and system inventory credential are removed. They created another trust protocol and another availability boundary without being necessary when the Hub can reach the API server and forward the Realmroot credential directly.
