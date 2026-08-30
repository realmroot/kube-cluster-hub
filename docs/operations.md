# Operations

## Service indicators

Every request emits one structured `request.completed` record with its request ID, method, path, status, and duration. Token exchange, upstream networking, Inventory projection, WebSocket, audit, and shutdown failures use separate structured event names with the same request ID when available.

Start with these service objectives and adjust them to the cluster estate:

| Indicator | Initial objective |
| --- | --- |
| Hub API availability, excluding client and Kubernetes responses | 99.9% monthly |
| Hub-added latency for non-streaming Kubernetes requests | p95 below 100 ms |
| Token-exchange success for otherwise valid requests | 99.9% |
| Audit persistence | 99.99% |
| Inventory reconciliation delay after a transient failure | below 10 minutes |

Alert separately on Hub 5xx responses, token-exchange failures, Kubernetes upstream failures/latency, database failures, audit persistence failures, and repeated `inventory.projection.pending` events. Kubernetes-native 4xx/5xx responses are target-cluster results and should not be counted as Hub availability failures.

Apply rate limits and request-size limits at the public edge or ingress. Limits must use shared infrastructure, not per-process counters, so horizontally scaled replicas enforce one policy. Keep watch/log streams and WebSocket upgrades out of short ordinary-request timeouts while still limiting concurrent streams per authenticated subject at the edge.

## Backup and recovery

- Back up D1 or PostgreSQL on a schedule appropriate to catalog and audit recovery requirements.
- Test restoring into an isolated Hub before relying on a backup policy.
- D1 and PostgreSQL migrations are forward-only. Back up before upgrading and restore the database plus the previous image together when rollback requires an older schema.
- The Hub stores no target-cluster credential, so cluster access recovery is Realmroot registration, network reachability, and Kubernetes OIDC/RBAC recovery—not secret extraction from the Hub database.

## Secret rotation

Rotate the Hub machine Application secret in Realmroot, update it in the deployment secret store, roll/redeploy all instances, verify Agent access, then revoke the old secret. A browser Application secret must never exist. Changing the public Hub origin, Resource Server URL, or Kubernetes audience is a coordinated identity migration rather than an ordinary secret rotation.

## Upgrades

1. Back up shared state and read release notes/migrations.
2. Apply database migrations once; they are safe to re-run from each replica.
3. Roll Worker or Node instances without changing the public URL.
4. Verify health/readiness, login, catalog access, Agent discovery/exchange, Kubernetes list/watch/log, exec/attach/port-forward, audit persistence, and optional Inventory reconciliation.
5. Keep the old image available until the verification window closes.

PostgreSQL-backed Node replicas and D1-backed Workers require no sticky session for ordinary traffic. Existing WebSockets remain attached to the accepting instance until completion or the shutdown deadline.
