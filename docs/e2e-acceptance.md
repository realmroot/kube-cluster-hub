# End-to-end acceptance report

Date: 2026-08-28 (America/Toronto)

## Accepted topology

- Public control plane: `https://kube-cluster-hub.saltbo.workers.dev`
- Runtime: Cloudflare Worker, static React/Vite assets, and D1
- Local cluster: kind `kite-realmroot-demo`, Kubernetes v1.33.1
- Data plane: `kube-cluster-hub-system/kube-cluster-connector` 0.2.0
- Local-to-public route: ephemeral Cloudflare quick tunnel
- Dashboard: Kite production build at `http://localhost:8080`
- Identity and Agent authority: Realmroot `https://id.realmroot.dev/api/auth`
- Cluster Inventory API: v0.1.3

The quick-tunnel hostname is acceptance infrastructure only. Production requires a stable trusted HTTPS route.

## Control plane and UI

- D1 migrations applied successfully and the final Worker deployed as version `9fe3607c-a6e7-481c-aba8-24ea245fdcef`.
- `/healthz`, `/readyz`, the React UI, security headers, RFC 9728 metadata, and both OpenAPI documents returned successfully.
- The built-in UI rendered its Realmroot sign-in, cluster catalog, create/edit dialog, Connector/direct modes, and audit page.
- The Worker cron reconciled `local-kind` to `inventoryStatus=ready` and published `cluster-inventory/local-kind` with `ControlPlaneHealthy=True` and the public Hub access URL.
- Connector heartbeat reported `ready`, Kubernetes v1.33.1, and its declared capabilities into D1.

## Identity boundary

One public Authorization Code + PKCE client was used without a client secret.

- The resource-indicator authorization produced an RFC 9068 Access Token with catalog audience, `clusters:read`, `clusters:write`, and `audit-events:read`; Kite used it only for catalog APIs.
- The same authorization produced an ID Token with the shared Kubernetes client audience and `groups=[platform-admins]`; Kite used it only for Kubernetes requests.
- The kind API server trusted the Realmroot issuer/client ID and mapped `sub` plus `groups`; `platform-admins` was bound through ordinary Kubernetes RBAC.
- Neither token was exposed to Kite browser JavaScript. Kite retained both in its encrypted server-side session.

## Kite user journey

- Live Realmroot login completed and the Hub catalog returned `Local kind`.
- Kite Overview loaded through Worker → quick tunnel → Connector → kube-apiserver.
- The rendered page showed one Node, 14 Pods, 10 Namespaces, six Services, recent Events, and CPU/memory capacity data.
- D1 audit contained the human Realmroot subject, cluster, method, canonical Kubernetes path, status 200, request ID, and duration for those calls.
- Native Kubernetes discovery and unavailable API groups retained Kubernetes status behavior; the Hub did not synthesize dashboard-specific resource APIs.

## Realmroot Agent Toolbox

The stable Agent identity obtained controller-approved authority for `clusters:read`, `kubernetes:read`, `kubernetes:write`, and `audit-events:read`.

- RFC 9728 and OpenAPI discovery generated seven Toolbox operations.
- Cluster listing returned `local-kind` in Connector mode.
- A Pod list in `realmroot-demo` succeeded as impersonated user `kube-cluster-hub:agent` with the read group.
- ConfigMap `realmroot-demo/hub-agent-e2e` was created, read, and deleted through Toolbox; Kubernetes returned 201/200/200 and the object was removed immediately.
- The initial read before installing the new RBAC example returned native Kubernetes 403 and was audited, proving that OAuth scope alone does not bypass Kubernetes RBAC.
- Agent audit rows contain actor issuer/subject, controller subject, client ID, scopes, token ID, request ID, cluster, path, status, and duration.

## Automated regression

- `make verify` passed: Biome, TypeScript strict check, all tests, Go vet/race, and all production builds.
- Six Vitest files with 15 tests passed.
- Worker/D1 runtime test passed under workerd.
- React, Worker, Node/SQLite, and Go production builds passed.
- Both Dockerfiles built successfully as `kube-cluster-hub:acceptance` and `kube-cluster-connector:acceptance`.
- Focused Kite auth, middleware, cluster, scheduler, and resources packages passed after separating catalog Access Token and Kubernetes ID Token handling.
- Connector image built, loaded into kind, rolled out, and stayed ready.

## Runtime state left for review

One requested kind cluster remains running with the new Connector. Kite remains at `http://localhost:8080`. The port-forward and ephemeral tunnel processes must remain alive for interactive review and are not production dependencies. No temporary Agent CRUD object remains.
