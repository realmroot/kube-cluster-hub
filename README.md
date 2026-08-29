# Kube Cluster Hub

Kube Cluster Hub is a small cluster catalog and authenticated Kubernetes API gateway. It lets dashboards such as Kite and authorized Realmroot Agents discover clusters and access their APIs without storing kubeconfigs, ServiceAccount tokens, or a second authorization model.

The control-plane routes and Kubernetes data-plane proxy are separate TypeScript modules, but they run in the same Worker or Node process and scale together. Network reachability is deployment infrastructure: expose a reachable Kubernetes API endpoint to the Hub.

## What it provides

- Realmroot OAuth 2.1/OIDC login with Authorization Code + PKCE
- versioned cluster catalog CRUD and optimistic concurrency
- human Kubernetes ID-token passthrough and Agent RFC 8693 exchange; Kubernetes RBAC remains authoritative
- one Hub Resource Server for human and DPoP-protected Agent access, with OpenAPI and RFC 9728 discovery
- Agent-attributed audit events
- HTTP streaming and Node WebSocket upgrades for Kubernetes subresources
- one React/Vite administration UI
- horizontally scalable Cloudflare Worker/D1 and Node/PostgreSQL deployments
- optional publication of the catalog as standard Cluster Inventory `ClusterProfile` resources

It deliberately does not provide a Connector, dispatch-token protocol, a target-cluster credential, an informer layer, or an additional RBAC database. The optional Inventory publisher uses a deployment-scoped, read/write credential only for `ClusterProfile` resources in one inventory namespace.

## Architecture

```text
Kite / browser ─┐
Realmroot Agent ├─> Kube Cluster Hub ─> reachable kube-apiserver
catalog client ─┘       │
                       D1 or PostgreSQL
                           │
                           └─> Cluster Inventory API ─> Kite / other dashboards
```

Humans use a Hub-audience access token for catalog operations and a Realmroot ID token whose audience is the Kubernetes OIDC client for Kubernetes operations. Agents use a DPoP-bound Hub access token for Hub discovery and operations. The Hub verifies that boundary, exchanges the Agent token at Realmroot for a Kubernetes-audience ID token, strips untrusted forwarding and impersonation headers, and sends only the exchanged credential to Kubernetes. The target kube-apiserver validates it and applies RBAC. See [docs/architecture.md](docs/architecture.md).

## Local development

Requirements: Node.js 26, pnpm 11, and Docker for container or PostgreSQL testing.

```bash
cp .env.example .env
pnpm install
make run
```

`make run` starts the Vite/Worker development runtime. `make run-node` starts the Node runtime with the SQLite development database configured by `HUB_DATABASE_DSN`.

```bash
make verify
make image
```

## Deployment

Cloudflare Workers use D1 and scale as one combined service:

```bash
pnpm wrangler d1 migrations apply kube-cluster-hub --remote
pnpm deploy
```

Node/Docker supports SQLite for one-process development and PostgreSQL for production replicas. Set `HUB_DATABASE_URL` to a PostgreSQL URL; every replica runs the same control-plane and data-plane code. The Kubernetes reference manifest expects that URL in the `kube-cluster-hub-secrets` Secret and starts two replicas.

Set `INVENTORY_ENABLED=true` to project enabled catalog entries into an Inventory Kubernetes API. Node supports in-cluster credentials or a kubeconfig; Workers support a bearer-token kubeconfig to a publicly trusted HTTPS API endpoint. This integration is optional and does not change the Hub catalog or proxy protocol.

See [docs/deployment.md](docs/deployment.md), [docs/protocol.md](docs/protocol.md), and [docs/implementation-status.md](docs/implementation-status.md).

## Toolchain

The project uses TypeScript 7.0.2, Node.js 26, pnpm 11.24, Vite 8, React 19, Hono 4, Vitest 4, Biome 2, Knip, Drizzle ORM, Wrangler 4, D1, SQLite, and PostgreSQL. Dependency versions are locked by `pnpm-lock.yaml` and monitored by Dependabot.

## License

Apache-2.0
