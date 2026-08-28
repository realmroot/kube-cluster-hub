# Migration from 0.2 Connector deployments

Migration `0003_embedded_data_plane.sql` removes connection-mode, Connector, and inventory-publication columns and drops Connector status state.

- Existing direct rows retain `apiServerUrl` and enabled state.
- Existing Connector rows are disabled because a Connector URL is not necessarily a Kubernetes API URL. When present, the old URL is retained only as a review hint in `apiServerUrl`; an administrator must replace it with the reachable API server endpoint before re-enabling the cluster.
- Legacy custom-CA rows remain disabled and retain their original API endpoint. Expose that endpoint with trust available to the Hub runtime; CA bundles are not restored as catalog data.
- Catalog metadata, audit events, resource versions, and DPoP replay records are retained.

Before upgrade, back up D1 or SQLite and export the cluster catalog. After upgrade:

1. apply all D1 migrations, or start one Node instance to apply SQLite migrations;
2. configure a reachable, trusted `apiServerUrl` for every disabled cluster;
3. configure Realmroot OIDC directly on every kube-apiserver and bind Realmroot groups with Kubernetes RBAC;
4. configure each kube-apiserver to accept the Hub resource audience for Agent access and map the token's Kubernetes identity/group claims;
5. test reads and mutations as a real user and Agent;
6. remove Connector Deployments, ServiceAccounts, status secrets, dispatch keys, and Connector-specific RBAC from managed clusters.

For replicated Node/Docker production, provision PostgreSQL and set `HUB_DATABASE_URL`. SQLite-to-PostgreSQL data transfer is not automatic: export catalog records through the API and import them with conditional PUT requests. Audit-history transfer requires an explicit database migration because audit IDs are append-only operational records.

Rollback after applying migration 0003 requires a database restore; the removed trust protocol cannot be reconstructed from the new catalog.
