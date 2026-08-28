# Cluster Access Gateway

Cluster Access Gateway is a small, dashboard-neutral cluster directory and
Kubernetes access service. Kite, Headlamp, `kubectl`, and Agents keep using the
native Kubernetes API and Kubernetes RBAC; the Gateway does not invent another
resource or permission model and never stores a cluster-admin kubeconfig.

The repository contains two deployable components:

- **Control Plane** — TypeScript/Hono with one business implementation for
  Cloudflare Workers + D1 and Node/Docker + SQLite. It owns the cluster catalog,
  OIDC and Agent verification, short-lived request dispatch, audit records, and
  ClusterProfile publication.
- **Connector** — a small Go service deployed once in each private cluster. It
  receives signed requests over HTTPS, forwards user ID tokens unchanged, and
  executes Agent requests through a narrowly authorized ServiceAccount with
  Kubernetes impersonation.

The Kubernetes HTTP API remains the data-plane protocol, including watch,
logs, exec, attach, and port-forward. Connector communication is ordinary HTTPS
plus a 30-second, request-bound ES256 JWT; there is no queue, custom tunnel
protocol, or persistent bidirectional control channel.

## Local development

Requirements: Node.js 24+, pnpm, Go 1.26, and optionally Docker/kind.

```sh
cp .env.example .env
# Configure public URLs, OIDC/Resource Server values, and a dispatch key pair.
make run
```

`make run` starts the Node/SQLite control plane. In another terminal:

```sh
go run ./cmd/cluster-access-connector
```

The Connector is normally deployed using `deploy/connector.yaml`; its public
endpoint must terminate trusted HTTPS in production. The in-process HTTP
listener is intended to sit behind that TLS boundary.

## Deployment targets

```sh
make image-control-plane      # Node/SQLite control-plane image
make image-connector          # Go Connector image
pnpm wrangler deploy          # Worker/D1 control plane
```

Apply `migrations/` to D1 before the first Worker deployment. For Docker/K8s,
the control plane applies the same schema to SQLite at startup. Templates are
in `deploy/control-plane.yaml` and `deploy/connector.yaml`.

## Verification

```sh
make verify
```

This runs formatting, TypeScript checks and tests, race-enabled Go tests, the
Node build, and a Worker deployment dry run. The full kind, UI, streaming, and
Realmroot Toolbox acceptance matrix is recorded in
[docs/e2e-acceptance.md](docs/e2e-acceptance.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Protocols and security boundaries](docs/protocol.md)
- [Deployment guide](docs/deployment.md)
- [Migration guide](docs/migration.md)
- [Goal, migration, and implementation status](docs/implementation-status.md)
- [Headlamp integration and upstream work](docs/headlamp-upstream.md)
- [End-to-end acceptance](docs/e2e-acceptance.md)
