# HTTP protocol

The Hub exposes two standard OAuth resources and one transparent Kubernetes path family. Successful API responses include `Request-Id`; failures use `application/problem+json`.

## Catalog resource

Resource: `{HUB_PUBLIC_URL}/api/catalog`. Discovery is at `/.well-known/oauth-protected-resource/api/catalog`; OpenAPI is at `/openapi/catalog.json`. Requests require the current `API-Version` header.

| Method and path | Scope | Additional rule |
| --- | --- | --- |
| `GET /api/catalog/clusters` | `clusters:read` | any authenticated user |
| `GET /api/catalog/clusters/{id}` | `clusters:read` | any authenticated user |
| `PUT /api/catalog/clusters/{id}` | `clusters:write` | configured admin group and `If-Match`/`If-None-Match` |
| `DELETE /api/catalog/clusters/{id}` | `clusters:write` | configured admin group and `If-Match` |
| `GET /api/catalog/audit-events` | `audit-events:read` | configured admin group |

Lists use cursor pagination. Cluster representations use an `ETag` derived from `resourceVersion`. Unknown input fields that represent removed credentials or connection modes are rejected instead of silently ignored.

## Human Kubernetes proxy

Path: `/clusters/{clusterId}/kubernetes/{kubernetesPath}`.

The bearer credential must be a Kubernetes-audience Realmroot ID token. The suffix and query are forwarded unchanged to the selected `apiServerUrl`. The Hub verifies authentication and cluster availability; Kubernetes performs all resource authorization.

## Agent resource

Resource: `{HUB_PUBLIC_URL}/api/agent`. Discovery is at `/.well-known/oauth-protected-resource/api/agent`; OpenAPI is at `/openapi/agent.json`.

Catalog and audit reads are available under `/api/agent/...`. Kubernetes access uses `/api/agent/clusters/{clusterId}/kubernetes/{kubernetesPath}` and requires:

- `Authorization: DPoP <access-token>`;
- a valid `DPoP` proof bound to method, canonical URI, token hash, and key;
- the Hub Resource Server audience in the access token;
- an authorized OAuth client and non-replayed proof;
- `kubernetes:read` for safe reads or `kubernetes:write` for mutations and streaming write subresources.

`exec`, `attach`, and `portforward` require `kubernetes:write` even when the HTTP handshake is `GET`. The verified access token is then forwarded as a Kubernetes bearer token. The DPoP proof itself is never forwarded. The target kube-apiserver performs its own audience validation and RBAC; clusters intended for Agent access must explicitly accept the Hub resource audience or another audience present in the token.

## Header boundary

Before forwarding, the Hub removes `Host`, cookies, incoming authorization, DPoP, proxy authorization, legacy cluster authorization, and every Kubernetes impersonation header. It then sets the verified bearer token, `Request-Id`, and `Accept-Encoding: identity`.

The Hub returns Kubernetes status codes and response bodies as received, including Kubernetes-native 404 `Status` objects. Network failures become a Hub 502 problem response; a disabled cluster returns 503.
