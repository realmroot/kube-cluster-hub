# End-to-end acceptance report

Date: 2026-08-28 (America/Toronto)

## Environment

- one kind cluster: `kite-realmroot-demo`
- Kubernetes v1.33.1 with AuthenticationConfiguration OIDC
- metrics-server returning Pod and Node metrics
- sample workload: `realmroot-demo/hello-realmroot`
- Cluster Inventory API v0.1.3
- TypeScript control plane: Node/SQLite on `localhost:18081`
- Go Connector: `cluster-access-system/cluster-access-connector`, forwarded to
  `localhost:18082` for the local control plane
- Kite production build: `http://localhost:8080`
- Headlamp 0.45.0 local build: `http://localhost:4466`
- online OIDC/Agent issuer: `https://id.realmroot.dev/api/auth`
- public Resource Server exposed through an ephemeral Cloudflare quick tunnel

The tunnel is acceptance infrastructure only. Production requires a stable
trusted HTTPS route.

## Control Plane and Connector

- SQLite schema bootstrapped and retained catalog/audit data across restarts.
- D1 migration `0001_control_plane.sql` applied to local Wrangler D1; Worker
  health, readiness, RFC 9728 metadata, and OpenAPI discovery returned expected
  responses.
- Worker deployment dry run and Node/Connector container builds passed.
- The Node image was started with a clean mounted SQLite database and returned
  204 from health/readiness.
- Connector heartbeat reported ready with Kubernetes v1.33.1.
- ClusterProfile reconciliation changed from the old service to the public
  control-plane URL, then remained at the same resourceVersion and
  `lastTransitionTime` across subsequent reconciliation intervals.
- The old monolithic Deployment, Service, ServiceAccount, and RBAC were removed.
  Its PVC remains only as an explicit recovery copy.

## Kite user journey

- Live Realmroot Authorization Code + PKCE login succeeded without a client
  secret.
- Overview through the Connector showed one node, 14 Pods, nine namespaces,
  six Services, events, and live CPU/memory metrics.
- Settings showed `kind-realmroot` as Connector type.
- Add Cluster exposed Direct and Connector modes. Connector mode generated a
  stable read-only Connector ID and accepted only its HTTPS URL and optional
  Prometheus metadata, without any token, kubeconfig, or Kubernetes CA field.
- Settings > Audit displayed both human and Agent records with final status.

## Headlamp user journey

- The official Cluster Inventory integration discovers the generated
  `kind-realmroot` ClusterProfile alongside Headlamp's in-cluster context.
- The generic local patch creates a credentialless context which inherits the
  deployment OIDC configuration; no exec plugin, kubeconfig, or stored token is
  placed in the ClusterProfile.
- The online authorization request now includes PKCE, shared public client
  audience, groups, `offline_access`, and standards-compliant
  `prompt=consent`.
- Realmroot consent completed for all five scopes. Headlamp then loaded the
  v1.33.1 overview, live CPU/memory metrics, the node, 13 healthy Pods, and all
  workload types through the Gateway-backed ClusterProfile.
- Headlamp's Create/Apply UI passed server-side dry run and created
  `realmroot-demo/headlamp-ui-final-e2e`; Gateway audit recorded both POSTs as
  the human Realmroot subject with status 201. The ConfigMap was verified and
  removed immediately.
- The local acceptance origin must be `http://localhost:4466`, matching the
  registered OIDC callback. Using `127.0.0.1` creates a different localStorage
  origin and leaves Headlamp's popup completion signal isolated.

## Realmroot Agent Toolbox

Using the stable Agent identity and controller-approved `cluster-access`
authority:

- Resource Server overview discovered exactly seven OpenAPI operations and the
  four admission scopes, with no proprietary Agent Skills warning.
- cluster listing returned `kind-realmroot` in Connector mode;
- Kubernetes `/version` returned v1.33.1;
- Pod reads and a two-second watch returned a streamed `ADDED` event;
- ConfigMap `realmroot-demo/connector-final-e2e` was created, read, and deleted;
  `kubectl` then verified NotFound;
- the same create in `default` returned native Kubernetes 403 for
  `cluster-access:agent`;
- audit reads contained Agent issuer/subject, controller subject, authorized
  client, scopes, token ID, request ID, operation, status, and duration;
- a real Kubernetes exec WebSocket returned `connector-websocket-ok` through
  the Connector.
- Connector rollout with `DISPATCH_SIGNING_PUBLIC_JWKS` repeated the exec and
  CRUD/RBAC checks successfully; legacy single-JWK fallback remains migration
  compatibility only.
- multi-page audit traversal followed canonical HTTPS links through the public
  Resource Server without trusting the reverse proxy's internal request URL.

## Security and failure paths

- missing/invalid user token: 401;
- missing catalog API version: 400 RFC 9457 problem;
- non-admin catalog mutation: 403;
- invalid/expired/replayed DPoP proof: 401, with durable replay storage;
- read-only Agent write: 403 and audited;
- Agent write outside bound namespace: native Kubernetes 403;
- disabled cluster: 503; unknown cluster: 404;
- unreachable upstream: 502 without credential leakage;
- cancelled stream: audit status 499;
- caller authorization, cookie, DPoP, and impersonation headers are stripped;
- encoded OpenAPI Kubernetes paths are decoded once and traversal is rejected;
- the external Agent access token never crosses the Connector boundary.

## Automated regression

- Gateway: Biome, TypeScript strict check, 13 Vitest tests, Go vet, race-enabled
  Connector tests, Node build, Worker dry run, two container builds, D1 local
  migration/runtime smoke, real watch, CRUD/RBAC, and WebSocket exec.
- Kite: 475 Go tests, 67 UI tests in 21 files, full UI typecheck/lint/format,
  architecture/deployment/Kubernetes/AI-removal verifiers, and production build.
- Headlamp: 1,353 Go tests in 17 packages, targeted OIDC handler regression,
  and complete local image build.

No temporary E2E Kubernetes resource remains. The one kind cluster, Connector,
control plane, Kite, Headlamp, metrics-server, and sample workload remain
running for interactive review.
