# Kube Cluster Hub

Kube Cluster Hub is a self-hosted cluster catalog and authenticated Kubernetes API gateway for Realmroot users and teams. It gives dashboards and authorized Agents one credential-free directory of clusters while Kubernetes RBAC remains the final authority for every resource operation.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/realmroot/kube-cluster-hub)

You deploy one Hub for your own organization and connect it to your own Realmroot tenant and Kubernetes clusters. It is not a shared hosted service.

## What it does

- signs humans in with standard OAuth 2.1/OIDC Authorization Code + PKCE;
- stores cluster names, API server addresses, and dashboard metadata—but no cluster credentials;
- proxies Kubernetes HTTP streams and WebSocket subresources;
- exchanges Agent access tokens for Kubernetes-audience ID tokens through RFC 8693;
- publishes RFC 9728 metadata and OpenAPI for Realmroot Toolbox discovery;
- records Agent-attributed and catalog-administration audit events;
- optionally publishes the catalog as Cluster Inventory `ClusterProfile` resources;
- runs as a combined control plane/data plane on Cloudflare Workers or Node/Docker and scales horizontally.

The Hub does not add another Kubernetes permission database, run informers, manage tunnels, or install a proprietary Connector. The deployment must be able to reach each configured kube-apiserver; Cloudflare Tunnel, a private network, or another standard networking product can provide that path.

## Identity and authorization

Humans use a public Realmroot SPA Application. Realmroot controls catalog and audit access by granting Hub Resource Server scopes; Kubernetes access is authorized independently by the target cluster's RBAC using the user's OIDC identity and groups.

Agents receive a DPoP-bound access token for the Hub Resource Server. The Hub validates it, exchanges it for an ID token whose audience is the shared SPA/Kubernetes public client ID, and forwards only the exchanged token. The target kube-apiserver validates the identity again and applies RBAC.

## Deploy

Cloudflare Workers is the shortest production path. The Deploy Button provisions the Worker and D1 database from [`wrangler.toml`](wrangler.toml); no account ID or D1 database ID is committed to this repository.

Node/Docker uses SQLite for single-process development or PostgreSQL for horizontally scaled production replicas.

Read [Deployment](docs/deployment.md) for the Realmroot registrations, Kubernetes OIDC/RBAC setup, Worker deployment, and Node/Docker deployment. The annotated example files are the configuration reference.

## Dashboard integrations

- [LightKite](https://github.com/realmroot/lightkite) is the fully validated dashboard integration. It can consume the Hub catalog and proxy without storing kubeconfigs.
- [Headlamp](https://github.com/kubernetes-sigs/headlamp) is the community-maintained dashboard we have validated against the Cluster Inventory direction. Stock Headlamp can still load clusters through its existing kubeconfig/dynamic-cluster mechanisms; automatic Hub Inventory discovery depends on the corresponding upstream integration being available.

The interoperability boundary is standard OIDC, Kubernetes API behavior, Cluster Inventory resources, RFC 9728, and OpenAPI—not a private dashboard protocol. See [Protocol](docs/protocol.md), [Architecture](docs/architecture.md), and [Operations](docs/operations.md).

## Develop

Requirements: Node.js 26, pnpm 11, and Docker when testing the container or PostgreSQL path.

```bash
cp .env.example .env
pnpm install
make run
```

`make run` starts the Worker/Vite development runtime. `make run-node` starts the Node runtime with a local SQLite database.

```bash
make verify
make image
```

## Project status

The implementation and external deployment prerequisites are tracked in [Implementation status](docs/implementation-status.md). Kubernetes compatibility is intentionally centered on standard API proxy behavior, OIDC, RBAC, and Cluster Inventory rather than Kubernetes-version-specific product logic.

## License

Apache-2.0
