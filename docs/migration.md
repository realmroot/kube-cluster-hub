# Migration from the Go monolith

## What changes

The old process combined catalog, OIDC/Agent validation, SQLite, Kubernetes
proxying, impersonation, and ClusterProfile publication. It also required a
centrally reachable Kubernetes execution identity.

The replacement separates:

- TypeScript control-plane state and authorization admission;
- Go cluster-local Connector execution;
- dashboard clients which continue to speak the native Kubernetes API.

The external catalog API advances to `2026-08-28`. Kubernetes proxy paths and
the Agent Resource Server URL remain stable.

## SQLite migration behavior

Node startup runs `migrations/0001_control_plane.sql` idempotently and then
adapts legacy tables:

- adds `access_mode`, `connector_id`, and `connector_url` when absent;
- a legacy cluster with no CA bundle becomes `direct` and stays enabled;
- a legacy custom-CA cluster defaults to `connector`, is disabled, and receives
  `inventoryStatus=migration-required` until its Connector is configured;
- unfinished audit records with status `0` become `499`;
- catalog IDs, metadata, resource versions, timestamps, DPoP rows, and audit
  attribution are preserved.

The migration is covered by `control-plane/migrate-node.test.ts`. Always copy
the old SQLite file or snapshot its PVC before first startup.

## Recommended cutover

1. Stop catalog mutations on the old service.
2. Back up the old SQLite database.
3. Deploy and verify the Connector in every private/custom-CA cluster.
4. Start the Node control plane against a copy of the old database, or import
   equivalent rows into D1 through a controlled migration job.
5. For every `migration-required` row, set:
   - `accessMode=connector`;
   - `connectorId` equal to the stable cluster ID;
   - the trusted HTTPS `connectorUrl`;
   - `enabled=true` after heartbeat is ready.
6. Verify user OIDC read, native RBAC denial, Agent read/write, watch, exec,
   audit, and ClusterProfile discovery.
7. Point Kite, Headlamp ClusterProfiles, Realmroot Resource metadata, and public
   DNS at the new control plane.
8. Stop and remove the old Deployment, Service, ServiceAccount, and RBAC.
9. Retain the old PVC for the agreed recovery window, then delete it under the
   organization's data-retention procedure.

Do not run old and new publishers concurrently. They will reconcile the same
ClusterProfile names and can alternate access URLs, as the local acceptance run
demonstrated before the old Deployment was removed.

## D1 migration

D1 cannot mount the old SQLite file. Export catalog and audit rows from the
backup, apply the D1 migration, transform legacy cluster rows using the same
rules above, and import them through a one-time reviewed script or D1 SQL job.
Do not expose that import as a permanent HTTP endpoint.

DPoP replay rows are short-lived and need not normally be migrated during a
stopped cutover. Audit rows and cluster resource versions are durable product
data and must be migrated when history continuity is required.

## Rollback

Rollback is safe only before dashboards and Realmroot metadata begin writing to
the new catalog. Stop the new control plane, restore the old database snapshot,
and restore the old public route as one operation. Do not merge two independently
written audit/catalog databases after a split-brain period.

Connectors may remain installed during rollback because they hold no catalog
state and reject requests not signed by the configured dispatch key.
