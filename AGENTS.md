# Repository instructions

Cluster Access Gateway is a Go service that publishes a credential-free
multi-cluster catalog, proxies current-user Kubernetes credentials, and exposes
a Realmroot-native Agent Resource Server. It is not an identity provider and
must not implement a parallel Kubernetes authorization model.

- Use `make` as the command surface.
- Keep browser-user and Agent execution paths separate.
- Browser requests forward the current user's Kubernetes OIDC token unchanged.
- Agent requests require a Realmroot audience-bound DPoP token and execute as an
  attributable Kubernetes impersonated identity; never forward the Agent access
  token to kube-apiserver.
- Cluster records contain connection metadata, never kubeconfig credentials.
- The Cluster Inventory API is the dashboard discovery contract.
- Generic resource operations remain the canonical Kubernetes HTTP API.
- Use resource-oriented HTTP APIs and RFC 9457 errors for service-owned resources.
- Add tests for authentication, authorization, proxy identity, persistence, and
  every public contract change.

