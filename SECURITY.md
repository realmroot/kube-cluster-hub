# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email `security@realmroot.com` with the affected version, reproduction, impact, and any suggested mitigation. We aim to acknowledge reports within three business days and will coordinate disclosure after a fix is available.

## Security model

- The catalog stores connection metadata, never kubeconfigs or Kubernetes bearer credentials.
- Browser requests present an OIDC ID token to the Kubernetes proxy; the token is forwarded unchanged and Kubernetes RBAC remains authoritative.
- Catalog management uses a resource-audience OAuth access token, scopes, and administrator-group membership.
- Agent access requires a resource-audience, DPoP-bound access token. The Connector receives only a short-lived, request-bound dispatch token and uses Kubernetes impersonation.
- The optional Connector should be exposed only over trusted HTTPS and should use a narrowly scoped ServiceAccount.

See [docs/protocol.md](docs/protocol.md) for trust boundaries and protocol details.
