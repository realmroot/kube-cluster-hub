# Architecture

## Decision

The Hub has a logical control plane and data plane but one deployment unit. Every Worker isolate or Node replica can serve catalog requests and proxy Kubernetes traffic. This keeps the protocol and operations small while allowing ordinary horizontal scaling behind one hostname.

```text
                         one stateless deployment unit
                      ┌─────────────────────────────────┐
Realmroot OIDC ───────┤ authentication / authorization  │
Kite / browser ───────┤ cluster catalog                 ├── reachable kube-apiserver
Realmroot Toolbox ────┤ Agent resource server + audit   │
Cluster Inventory API <┤ optional ClusterProfile publisher│
                      ┤ streaming Kubernetes proxy      │
                      └──────────────┬──────────────────┘
                                     │
                              D1 or PostgreSQL
```

`control-plane/` owns identity verification, RFC 8693 token exchange, catalog resources, OpenAPI/discovery, audit, and persistence. `data-plane/` owns target construction, request sanitization, Kubernetes ID-token forwarding, and HTTP error translation. Node's native Upgrade handler follows the same rules for exec, attach, and port-forward WebSockets.

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

It contains no credentials, per-user permissions, TLS material, connection mode, or deployment-specific networking configuration.

## Human request flow

1. The browser performs Authorization Code + PKCE against Realmroot.
2. Catalog calls use a Hub-audience access token. Realmroot grants the route scopes that control catalog access.
3. Kubernetes calls use the Kubernetes-audience ID token.
4. The Hub verifies issuer, audience, signature, expiry, and token type; resolves an enabled catalog cluster; sanitizes headers; and forwards that ID token.
5. kube-apiserver derives the username/groups from the token and applies Kubernetes RBAC.

The Hub does not maintain a second Kubernetes authorization decision.

## Agent request flow

1. Realmroot Toolbox discovers RFC 9728 metadata and the Hub OpenAPI document at the same `/api` Resource Server used by the administration UI.
2. Realmroot issues a DPoP-bound access token for the Agent/controller/client and approved scopes.
3. The token is audience-bound to the Hub Resource Server. The Hub validates that audience, DPoP binding, replay, actor/controller identity, and the route scope. Realmroot controls which clients may obtain that token.
4. The Hub exchanges the verified access token through Realmroot RFC 8693 for a Kubernetes-audience ID token and verifies the exchange result. Only that ID token is forwarded to kube-apiserver.
5. The Hub records controller, Agent actor, client, token ID, scope, cluster, route, status, and duration.

Hub scopes are a resource-server boundary, not a replacement for Kubernetes RBAC. Human Bearer and Agent DPoP tokens share the same exact Hub audience, while route-level authentication still rejects an Agent Bearer fallback. A Kubernetes request must pass both the Hub and Kubernetes layers.

## Scaling and state

- Worker: Cloudflare scales isolates; D1 stores shared catalog, replay, and audit state.
- Node/Docker: replicas are stateless when `HUB_DATABASE_URL` points to PostgreSQL. Any replica can handle any request or WebSocket.
- The fixed local SQLite database is deliberately a development mode and must not be used by multiple replicas.
- No in-memory informer or per-user/per-cluster cache is required. Memory therefore does not grow with the user × cluster product.

API-server networking and load balancing are external concerns. Any deployment-managed network path works without a Hub-specific component.

## Cluster Inventory projection

When enabled, the control plane publishes each enabled catalog entry as a
`multicluster.x-k8s.io/v1alpha1` `ClusterProfile`. Its access provider points to
the Hub's Kubernetes-compatible proxy URL. Kite and other consumers watch the
Inventory API rather than depending on the Hub's private catalog REST API.

Catalog writes publish synchronously, while a five-minute reconciliation repairs
transient failures, disabled entries, and orphaned managed profiles. The
publisher credential is restricted to `ClusterProfile` resources in one
namespace. It never authorizes access to a target cluster and is never forwarded
through the data plane.

## Removed architecture

The retired Connector, ServiceAccount impersonation, dispatch JWT, and Connector heartbeat are removed. They created another trust protocol and availability boundary without being necessary when the Hub can reach the API server and exchange the Realmroot Agent credential for a Kubernetes-audience ID token. The Inventory publisher is only a standards-based catalog projection and is not a target-cluster connector or execution credential.
