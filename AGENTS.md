# Repository guidance

Kube Cluster Hub is one TypeScript service with two logical modules:

- `control-plane/`: catalog, OIDC/OAuth verification, OpenAPI, audit, persistence, and runtime entry points;
- `data-plane/`: direct Kubernetes HTTP proxy behavior shared by Worker and Node.

Both modules deploy and scale together. Do not introduce a cluster-local Connector, proprietary dispatch credential, stored Kubernetes credential, informer, or product-specific authorization layer. Kubernetes receives the verified Realmroot token and owns resource authorization through standard OIDC claims and RBAC.

Use D1 for Workers, PostgreSQL for replicated Node/Docker deployments, and SQLite only for local single-process development. Keep Worker and Node behavior equivalent; Node additionally handles native WebSocket upgrades.

Run `make verify` before committing. Update OpenAPI, migrations, UI contracts, deployment examples, and architecture/status documentation whenever a public contract changes.
