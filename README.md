# Kube Cluster Hub

[![CI](https://github.com/realmroot/kube-cluster-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/realmroot/kube-cluster-hub/actions/workflows/ci.yml)
[![CodeQL](https://github.com/realmroot/kube-cluster-hub/actions/workflows/codeql.yml/badge.svg)](https://github.com/realmroot/kube-cluster-hub/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Kube Cluster Hub is a credential-free Kubernetes cluster catalog and access boundary for dashboards, operators, and authorized Agents. It keeps Kubernetes HTTP, OIDC, and RBAC authoritative instead of creating another resource or permission model.

The project includes a browser UI and two independently deployable components:

- **Control plane** — TypeScript, React, Vite, Hono, and Drizzle. The same domain implementation runs on Cloudflare Workers with D1 or in Node/Docker with SQLite.
- **Connector** — an optional Go data plane deployed once in a private cluster. Publicly reachable API servers can use direct mode without it.

Kube Cluster Hub never stores a kubeconfig, user token, client certificate, or cluster-admin credential.

## What it provides

- Browser UI for cluster catalog, Connector state, and human/Agent audit
- Standard OIDC Authorization Code + PKCE for catalog administration
- Current-user ID Token passthrough to `kube-apiserver`
- RFC 9728 protected-resource discovery and OpenAPI for Realmroot Toolbox
- DPoP-bound Agent access with actor attribution and Kubernetes impersonation
- Native Kubernetes status codes, bodies, watch, logs, exec, attach, and port-forward
- SIG Multicluster Cluster Inventory `ClusterProfile` publication
- Cursor pagination, ETags, RFC 9457 problems, migrations, retention, and health probes

## Architecture

```text
Browser UI / Kite                         Realmroot Toolbox
       | Access Token (catalog)                | DPoP Access Token
       | ID Token (Kubernetes)                 | Agent authority
       +------------------+--------------------+
                          v
              Kube Cluster Hub control plane
                  Worker + D1 / Node + SQLite
                          |
              direct HTTPS or signed dispatch
                          |
                 optional Go Connector
                          |
                          v
                 kube-apiserver + RBAC
```

Human catalog authorization and Kubernetes authorization are deliberately separate. The catalog validates an audience-bound OAuth Access Token and catalog scopes. Kubernetes receives the user's original OIDC ID Token. Agent OAuth scopes are an admission ceiling; Kubernetes RBAC on the impersonated groups remains the final decision.

See [Architecture](docs/architecture.md) and [Protocol and security boundaries](docs/protocol.md).

## Local development

Requirements: Node.js 24+, pnpm 10+, Go 1.26+, and optionally Docker, kubectl, and kind.

```sh
cp .env.example .env
make deps
make run
```

`make run` starts the Vite frontend and Worker-compatible control plane locally. Use `make run-node` for the Node/SQLite runtime. To run the optional Connector:

```sh
make run-connector
```

The Connector endpoint must use trusted HTTPS outside loopback. A Cloudflare quick tunnel is suitable for local acceptance; use a named tunnel, Ingress, or Gateway in production.

## Deployment

Cloudflare Workers and D1:

```sh
pnpm wrangler d1 migrations apply kube-cluster-hub --remote
pnpm wrangler secret put DISPATCH_SIGNING_PRIVATE_JWK
pnpm wrangler secret put CONNECTOR_STATUS_TOKEN
pnpm deploy
```

Node/Docker and the Connector:

```sh
make image-control-plane
make image-connector
```

Review the complete [deployment guide](docs/deployment.md) before exposing a production endpoint.

## Verification

```sh
make verify
```

This runs formatting/lint checks, strict TypeScript, browser/control-plane/Worker tests, Go vet and race tests, and all production builds. The real Worker + kind + Connector + Kite + Realmroot Toolbox acceptance record is in [docs/e2e-acceptance.md](docs/e2e-acceptance.md).

## Project scope

The Hub manages cluster connection metadata and access. It does not reimplement Kubernetes resources, Helm, metrics, search, policy, or an AI/Agent loop. Dashboards such as Kite remain responsible for user experience; Agents call the Resource Server through Realmroot Toolbox.

## Community and security

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Implementation status](docs/implementation-status.md)

Licensed under [Apache-2.0](LICENSE).
