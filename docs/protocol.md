# HTTP protocol

The Hub exposes one OAuth protected resource and one transparent browser Kubernetes path family. The exact protected-resource URL is the public Hub origin plus `/api`; RFC 9728 discovery is at `/.well-known/oauth-protected-resource/api`, and the single OpenAPI document is at `/openapi.json`. Successful API responses include `Request-Id`; failures use `application/problem+json`.

All `/api` operations require the current `API-Version` header. Human callers use `Authorization: Bearer <access-token>`. Agent callers use `Authorization: DPoP <access-token>` plus a proof bound to the method, canonical URI, token hash, and Agent key. The shared audience does not weaken the authentication boundary: Agent requests have no Bearer fallback.

## Cluster catalog and audit

Cluster and audit resources have one canonical URI regardless of caller type.

| Method and path | Scope | Accepted principal | Additional rule |
| --- | --- | --- | --- |
| `GET /api/clusters` | `clusters:read` | human or Agent | cursor pagination |
| `GET /api/clusters/{id}` | `clusters:read` | human or Agent | returns `ETag` |
| `PUT /api/clusters/{id}` | `clusters:write` | human | `If-Match`/`If-None-Match` |
| `DELETE /api/clusters/{id}` | `clusters:write` | human | `If-Match` |
| `GET /api/audit-events` | `audit-events:read` | human or Agent | cursor pagination |

Lists use cursor pagination. Cluster representations use an `ETag` derived from `resourceVersion`. Unknown input fields that represent removed credentials or connection modes are rejected instead of silently ignored. Agent reads are recorded with their controller and actor identity.

## Human Kubernetes proxy

Path: `/clusters/{clusterId}/kubernetes/{kubernetesPath}`.

The bearer credential must be a Kubernetes-audience Realmroot ID token. The suffix and query are forwarded unchanged to the selected `apiServerUrl`. The Hub verifies authentication and cluster availability; Kubernetes performs all resource authorization.

## Agent Kubernetes proxy

Path: `/api/clusters/{clusterId}/kubernetes/{kubernetesPath}`. It requires:

- a DPoP-bound Hub access token with the exact Hub `/api` resource audience;
- a valid proof for the method and canonical URI and a non-replayed proof;
- `kubernetes:read` for safe reads or `kubernetes:write` for mutations and streaming write subresources.

`exec`, `attach`, and `portforward` require `kubernetes:write` even when the HTTP handshake is `GET`. The verified access token is exchanged through RFC 8693 for a Realmroot ID token whose audience is the public OIDC client shared by the SPA and Kubernetes. Neither the source access token nor DPoP proof is forwarded. The Hub verifies issuer, signature, audience, subject, actor chain, authorized party, groups, and expiry on the exchange result before Kubernetes independently applies RBAC.

## Header boundary

Before forwarding, the Hub removes `Host`, cookies, incoming authorization, DPoP, proxy authorization, legacy cluster authorization, and every Kubernetes impersonation header. It then sets the verified bearer token, `Request-Id`, and `Accept-Encoding: identity`.

The Hub returns Kubernetes status codes and response bodies as received, including Kubernetes-native 404 `Status` objects. Network failures become a Hub 502 problem response; a disabled cluster returns 503.
