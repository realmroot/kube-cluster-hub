# Security policy

Report vulnerabilities privately through GitHub Security Advisories. Do not open a public issue for a suspected vulnerability.

## Security model

- Human access uses standard OIDC tokens issued by the configured issuer. Catalog access tokens and Kubernetes ID tokens are verified against their own audiences.
- Agent access requires a DPoP-bound JWT access token, an authorized OAuth client, required Hub scopes, the Hub resource audience, and the Kubernetes audience.
- The Hub never stores kubeconfigs, CA bundles, client certificates, ServiceAccount tokens, or OIDC client secrets.
- The proxy removes cookies, incoming authorization, DPoP, proxy authorization, Kubernetes impersonation, and legacy forwarding headers before adding the verified token.
- Kubernetes RBAC is the only authority for Kubernetes resources. Hub scopes protect Hub routes and coarse read/write capabilities; they do not grant Kubernetes RBAC.
- Cluster endpoints are administrator-managed and must be reachable through trusted networking. Treat catalog write access as privileged because the Hub performs server-side requests to those endpoints.
- DPoP replay state, catalog state, and audit state must use shared D1 or PostgreSQL storage in multi-replica deployments.

Supported releases receive security fixes. Pin release images by immutable digest in production and keep Realmroot, Kubernetes, and Hub token lifetimes short.
