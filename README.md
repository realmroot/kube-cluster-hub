# Kube Cluster Hub

Kube Cluster Hub is a small cluster catalog and authenticated Kubernetes API gateway. It lets dashboards such as Kite and authorized Realmroot Agents discover clusters and access their APIs without storing kubeconfigs, ServiceAccount tokens, or a second authorization model.

The control-plane routes and Kubernetes data-plane proxy are separate TypeScript modules, but they run in the same Worker or Node process and scale together. Network reachability is infrastructure: expose each API server to the Hub with a private network or a standard tunnel.

## What it provides

- Realmroot OAuth 2.1/OIDC login with Authorization Code + PKCE
- versioned cluster catalog CRUD and optimistic concurrency
- user token passthrough to Kubernetes; Kubernetes RBAC remains authoritative
- DPoP-protected Agent resource server with OpenAPI and RFC 9728 discovery
- Agent-attributed audit events
- HTTP streaming and Node WebSocket upgrades for Kubernetes subresources
- one React/Vite administration UI
- horizontally scalable Cloudflare Worker/D1 and Node/PostgreSQL deployments

It deliberately does not provide a Connector, dispatch-token protocol, Kubernetes credentials, an informer layer, or an additional RBAC database.

## Architecture

```text
Kite / browser ─┐
Realmroot Agent ├─> Kube Cluster Hub ─> reachable kube-apiserver
catalog client ─┘       │
                       D1 or PostgreSQL
```

Humans send a Realmroot ID token whose audience is the Kubernetes OIDC client. Agents send a DPoP-bound access token for the Hub Resource Server. The Hub verifies its own token boundary, strips untrusted forwarding and impersonation headers, and sends that same signed token as `Authorization: Bearer` to Kubernetes. The target kube-apiserver independently decides whether it accepts that token audience and applies RBAC. See [docs/architecture.md](docs/architecture.md).

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

See [docs/deployment.md](docs/deployment.md), [docs/protocol.md](docs/protocol.md), and [docs/implementation-status.md](docs/implementation-status.md).

## Toolchain

The project uses TypeScript 7.0.2, Node.js 26, pnpm 11.24, Vite 8, React 19, Hono 4, Vitest 4, Biome 2, Knip, Drizzle ORM, Wrangler 4, D1, SQLite, and PostgreSQL. Dependency versions are locked by `pnpm-lock.yaml` and monitored by Dependabot.

## License

Apache-2.0
