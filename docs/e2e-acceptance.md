# End-to-end acceptance

This record is intentionally evidence-based. A row is marked passed only after the current architecture was exercised.

## Automated repository verification

| Check | Status |
| --- | --- |
| TypeScript 7 strict typecheck | passed 2026-08-29 |
| Node/unit/UI tests | passed 2026-08-29: 7 files, 24 tests, including Inventory reconciliation, publication failure semantics, first-chunk-before-close streaming, and PostgreSQL concurrency |
| Worker/D1 test | passed 2026-08-29: 1 file, 1 test |
| Biome, dead-code scan, Worker/client/Node builds | passed 2026-08-29 |
| PostgreSQL multi-replica integration | passed 2026-08-28 against PostgreSQL 17: shared migrations, catalog, DPoP replay, audit, and two live replicas |
| Kubernetes deployment manifest | passed 2026-08-28 with `kubectl apply --dry-run=client` |
| Docker image build | passed 2026-08-28: Node 26.8.1 runtime, pnpm/build tools and optional SQLite native module absent |

## Live integration matrix

| Flow | Status |
| --- | --- |
| Realmroot PKCE login and catalog UI | passed against the deployed Worker; refresh/direct navigation remains signed in within the browser tab |
| Worker Cluster Inventory publication | passed 2026-08-29: scheduled reconciliation published `cluster-inventory/local-kind` through the public Inventory API endpoint |
| Node Cluster Inventory publication | passed 2026-08-29: official client apply/status/list/delete smoke test against kind |
| catalog edit against shared deployment | passed; `local-kind` remained enabled/default with its external API endpoint |
| Kite ClusterProfile discovery and Kubernetes pages | passed 2026-08-29 against the deployed Worker and kind: `Local kind` selector, overview, pods, deployments, ConfigMaps, nodes, events, and metrics; all observed API responses were 200 |
| human ID-token forwarding | passed: Kubernetes list/resource calls were authorized by Realmroot claims and Kubernetes RBAC |
| list/watch/log HTTP behavior | list and finite watch/log passed through the Worker; Node first-chunk streaming passed. Live follow streaming is blocked by the account-less Quick Tunnel used for this demo, which also buffered a direct API-server log request before the Hub. Production tunnels must preserve streaming. |
| Node WebSocket upgrade | passed by automated upstream upgrade test with direct user token forwarding; live exec/attach/port-forward remains an environment smoke test for the chosen load balancer/tunnel |
| Toolbox discovery and Agent read/write | passed: synchronized OpenAPI query flags, listed clusters/resources, created/read/deleted `hub-agent-final-e2e` |
| Agent audit visible through UI/API | passed: Agent GET/POST/DELETE entries and controller/Agent attribution persisted and rendered in the audit UI |
| two Node replicas using PostgreSQL | passed: both readiness probes returned 204 and UI returned 200 against one migrated database |

The previous Connector-based acceptance is historical and does not prove this architecture. Its Deployment, Service, ServiceAccount, Secret, ConfigMap, ClusterRoles, and ClusterRoleBindings were removed from the acceptance kind cluster.

The streaming isolation check used the same continuously logging Pod and temporary, immediately deleted ServiceAccounts: direct `127.0.0.1:52713` delivery produced chunks within 0.5 seconds, while both Quick Tunnel modes produced no chunk before the test deadline. This is evidence about the temporary demo tunnel, not a Hub credential or RBAC failure.
