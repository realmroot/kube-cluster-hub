# Architecture

## Outcome

One cluster directory and access boundary serves multiple Kubernetes clients
without defining a dashboard-specific cluster protocol.

```text
Realmroot user ID token
  -> Kite or Headlamp
  -> /clusters/{cluster}/kubernetes/...
  -> unchanged Bearer token
  -> kube-apiserver OIDC authentication and RBAC

Realmroot Agent DPoP access token
  -> /api/agent/clusters/{cluster}/kubernetes/...
  -> Resource Server validation and scope check
  -> cluster-local execution credential + Kubernetes impersonation
  -> kube-apiserver RBAC and audit
```

The two token paths are intentionally not interchangeable. An Agent access
token has the Gateway Resource Server as its audience and must never be sent to
kube-apiserver as if it were a Kubernetes ID token.

## Protocol boundaries

### Inventory

The durable service-owned resource is a `Cluster`. Its stable ID survives
display-name changes. It owns connection metadata, enablement, presentation
metadata, and publication state. It never contains a user, ServiceAccount,
client-certificate, or kubeconfig credential.

The dashboard discovery representation is the SIG Multicluster Cluster
Inventory API `ClusterProfile`. Each enabled Cluster is published as one
ClusterProfile with an `oidc-passthrough` access provider whose server is the
Gateway's Kubernetes proxy URI for that Cluster.

### Kubernetes data plane

The data-plane contract is the Kubernetes HTTP API. The Gateway only selects a
configured upstream, applies TLS metadata, preserves streaming semantics, and
sets the correct execution identity. It does not create a second CRUD model for
Pods, Deployments, CRDs, Helm objects, logs, exec, or watch.

### Agent Resource Server

The protected resource publishes RFC 9728 metadata and an OpenAPI service
description. Realmroot is used through standard OAuth/OIDC, RFC 9068 access
tokens, RFC 9449 DPoP, and RFC 8693 `act`; no issuer-specific endpoints or
claims are hard-coded.

Agent scopes are an admission ceiling, not Kubernetes permission. A request
must pass both the OAuth scope check and Kubernetes RBAC. The Kubernetes audit
username is derived from the verified Agent actor, while the controlling
subject is retained as an impersonation extra and in Gateway audit storage.

## Resource proof

| Resource | Identity | Owner | Lifecycle | Canonical URI |
| --- | --- | --- | --- | --- |
| Cluster | stable DNS-compatible ID | catalog administrator | create, replace, patch, delete | `/api/catalog/clusters/{clusterId}` |
| Audit event | server-generated immutable ID | Gateway | append and retain | `/api/catalog/audit-events` collection representations |
| ClusterProfile | Kubernetes UID/name | Cluster Inventory API | reconciled from Cluster | Kubernetes ClusterProfile API |
| Kubernetes resource | Kubernetes API identity | target cluster | Kubernetes-native | gateway base + canonical Kubernetes URI |

The catalog uses the cursor pagination profile. Collection responses contain
`items` and `pagination`, and navigation is also advertised with RFC 8288
`Link` headers.

## Deployment boundary

Human passthrough works for any reachable OIDC-enabled Kubernetes API without
a Gateway-held Kubernetes credential. Agent execution additionally requires a
cluster-local execution identity authorized only to impersonate the configured
Agent usernames/groups. For remote clusters this identity belongs in the
cluster-local tunnel component or a standards-based token-exchange adapter; it
must not become a centrally stored cluster-admin token.
