# End-to-end acceptance report

Date: 2026-08-28 (America/Toronto)

## Environment

- kind cluster: `kite-realmroot-demo` (the only running kind cluster)
- Kubernetes: v1.33.1
- metrics-server: installed and returning Pod/Node metrics
- sample workload: `realmroot-demo/hello-realmroot`
- Cluster Inventory API: v0.1.3
- Gateway namespace: `cluster-access-system`
- Headlamp namespace: `headlamp`
- public OIDC audience: shared public PKCE client `Kubernetes Dashboards`
- Agent Resource Server: Realmroot resource `cluster-access`, ID
  `01a046a6-bf88-763d-9e6e-6e5500a75a18`

The Resource Server used an ephemeral Cloudflare quick-tunnel URL for live
Realmroot discovery. No tunnel credential or launcher was created. Production
must replace it with a stable HTTPS route.

## User journeys

### Kite

- Logged in through live Realmroot using Authorization Code + PKCE with no
  client secret.
- The Gateway-backed cluster appeared in the cluster selector and Settings.
- Add/edit persisted the target API server and PEM CA in the Gateway while the
  Kite runtime projection remained credential-free.
- Pods in `realmroot-demo` displayed `hello-realmroot` as Running together with
  CPU and memory from metrics-server.
- Settings > Audit displayed both human and Agent requests, actor identity,
  cluster, operation, and final status.

### Headlamp

- Cluster Inventory automatically discovered the published `kind-realmroot`
  ClusterProfile without a kubeconfig or exec credential.
- Live Realmroot PKCE login succeeded with the same public client used by Kite
  and kube-apiserver.
- The UI displayed Kubernetes v1.33.1, one ready node, Pods, events, and live
  CPU/memory totals through the Gateway.
- The Create/Apply UI created ConfigMap
  `realmroot-demo/headlamp-ui-e2e`; `kubectl` verified its data. The temporary
  ConfigMap was then deleted and a NotFound response verified cleanup.

## Agent journeys

Using the stable Agent identity and controller-approved `cluster-access`
authority:

- listed the cluster catalog;
- read Pods from `realmroot-demo`;
- created, fetched, and deleted `realmroot-demo/agent-e2e` ConfigMap;
- received native Kubernetes 403 when attempting the same write in `default`;
- watched Pods with `watch=true` and a three-second server timeout, receiving a
  streamed `ADDED` event;
- read audit events containing Agent issuer, stable subject, controller
  subject, authorized client, scopes, token ID, request ID, status, and duration.

Agent access used the Gateway ServiceAccount only to authenticate and
impersonate the verified Agent. Namespace RoleBindings granted the impersonated
read/write groups `view`/`edit`; no cluster-admin execution token was stored.

## Failure and security paths

- Missing/invalid user token: 401.
- Missing catalog API version: 400 RFC 9457 problem.
- Non-admin catalog mutation: 403.
- Invalid/expired/replayed DPoP proof: 401; replay is persisted and tested.
- Read-only Agent write: 403 and audited.
- Agent write outside the allowed namespace: kube-apiserver 403.
- Invalid cluster or disabled cluster: 404.
- Unreachable upstream: 502 without leaking credentials.
- Cancelled stream: audit final status 499 rather than an unfinished zero.
- Caller-provided impersonation headers are removed on both paths.

The kube-apiserver AuthenticationConfiguration contains only the shared public
Dashboard/kubelogin client audience. The obsolete embedded Kite Agent resource
audience was removed.

## Automated verification

- Gateway: `go test ./...`, `go test -race ./...`, `go vet ./...`, and build.
- Kite: backend suite, UI suite/typecheck/format, architecture/deployment/
  Kubernetes compatibility verifiers, and production build.
- Headlamp: `go test ./...` (1351 tests before the final URL-rejection case),
  then `go test ./pkg/clusterinventory ./cmd` (396 tests including that case),
  and a complete local container build.

All temporary E2E ConfigMaps were removed. The long-lived demo workload,
metrics-server, Gateway, Kite development process, and Headlamp remain running
for interactive review.
