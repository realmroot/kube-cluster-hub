# End-to-end acceptance

This record is intentionally evidence-based. A row is marked passed only after the current architecture was exercised.

## Automated repository verification

| Check | Status |
| --- | --- |
| TypeScript 7 strict typecheck | passed 2026-08-29 |
| Node/unit/UI tests | passed 2026-08-29, including bounded external responses, Inventory reconciliation, RFC 8693 token exchange validation, pagination, first-chunk-before-close streaming, PostgreSQL concurrency, UI failure/empty states, API transport, and automated accessibility checks |
| Worker/D1 tests | passed 2026-08-29, including upgraded-response preservation and D1 audit persistence |
| Biome, dead-code scan, Worker/client/Node builds | passed 2026-08-29 |
| PostgreSQL multi-replica integration | passed 2026-08-29 against PostgreSQL 18: shared migrations, catalog, DPoP replay, audit, and two live production-image replicas with readiness/UI checks |
| Kubernetes deployment manifest | passed 2026-08-28 with `kubectl apply --dry-run=client` |
| Docker image startup | passed 2026-08-29: Node 26.8.1, persistent SQLite, health, readiness, UI assets, and non-root uid 65532; CI rebuilds and starts the production image |

## Live integration matrix

| Flow | Status |
| --- | --- |
| Realmroot PKCE login and catalog UI | passed against the deployed Worker; refresh/direct navigation remains signed in within the browser tab |
| Worker Cluster Inventory publication | passed 2026-08-29: live cron reconciliation published `cluster-inventory/local-kind` through the public Inventory API endpoint after the Worker fetch receiver regression was fixed |
| Node Cluster Inventory publication | passed 2026-08-29: official client apply/status/list/delete smoke test against kind |
| catalog edit against shared deployment | passed; `local-kind` remained enabled/default with its external API endpoint |
| Kite ClusterProfile discovery and Kubernetes pages | passed 2026-08-29 against the deployed Worker and kind: `Local kind` selector, overview, pods, deployments, ConfigMaps, nodes, events, and metrics; all observed API responses were 200 |
| human ID-token forwarding | passed: Kubernetes list/resource calls were authorized by Realmroot claims and Kubernetes RBAC |
| list/watch/log HTTP behavior | list and finite watch/log passed through the Worker; Node first-chunk streaming passed. The network-path-specific live follow check remains required for each production deployment. |
| Worker WebSocket exec | passed 2026-08-29 through deployed Worker and Kite Files with Kubernetes WebSocket protocol v5; audit persistence is deferred with `waitUntil` so the upstream 101 is returned before a short-lived command exits |
| Node WebSocket upgrade | passed by automated upstream upgrade test with direct user token forwarding; live exec/attach/port-forward remains an environment smoke test for the selected load balancer |
| Toolbox discovery and Agent read/write | passed: synchronized OpenAPI query flags, listed clusters/resources, created/read/deleted `hub-agent-final-e2e`; passed again 2026-08-29 with RFC 8693 exchange to the Kubernetes audience |
| Agent audit visible through UI/API | passed: Agent identity, controller attribution, exchange result, and target audience persisted and rendered in the paginated Hub audit UI |
| two Node replicas using PostgreSQL | passed: both readiness probes returned 204 and UI returned 200 against one migrated database |

The previous Connector-based acceptance is historical and does not prove this architecture. Its Deployment, Service, ServiceAccount, Secret, ConfigMap, ClusterRoles, and ClusterRoleBindings were removed from the acceptance kind cluster. Hub owns no tunnel or connector lifecycle; network reachability is deployment infrastructure.
