# Cluster Access Gateway

Cluster Access Gateway is a shared, credential-free cluster directory and
Kubernetes access boundary for dashboards and Agents. Kite and Headlamp consume
the same inventory and the canonical Kubernetes HTTP API; neither receives a
stored cluster-admin kubeconfig.

The service has three deliberately separate surfaces:

- `/api/catalog`: versioned cluster metadata administration for dashboard and
  platform clients;
- `/clusters/{clusterId}/kubernetes/*`: current-user OIDC token passthrough to
  Kubernetes, with authorization left to native RBAC;
- `/api/agent`: an RFC 9728/OpenAPI Resource Server for DPoP-bound Agent access,
  executed through an attributable Kubernetes impersonated identity.

Enabled clusters are also published as SIG Multicluster Cluster Inventory API
`ClusterProfile` resources. Headlamp discovers them through that upstream API;
Kite uses the catalog API for its add/edit/delete UI and the same Kubernetes
gateway for resource operations.

## Run locally

Requirements are Go 1.26, a reachable Kubernetes cluster, and the Cluster
Inventory API v0.1.3 CRD.

```sh
cp .env.example .env
# edit .env for your issuer, public URLs, client IDs, and admin groups
make install-crd
make run
```

`make run` loads `.env`; the file is ignored by Git. No launcher, generated
secret file, privileged kubeconfig, or dashboard-specific credential is used.

For a container deployment, build with `make image` and adapt
`deploy/gateway.yaml`. Replace every example issuer, audience, public URL, and
authorized Agent client before deployment. Production must use a stable HTTPS
Ingress, Gateway API route, or named tunnel; the local quick-tunnel acceptance
setup is intentionally ephemeral.

## Verify

```sh
make verify
```

This runs the race-enabled Go tests and builds the service. The complete local
kind and Realmroot acceptance evidence is in
[docs/e2e-acceptance.md](docs/e2e-acceptance.md).

## Documentation

- [Architecture](docs/architecture.md)
- [HTTP and inventory contracts](docs/protocol.md)
- [Goal and actual implementation stages](docs/implementation-status.md)
- [Headlamp upstream proposal](docs/headlamp-upstream.md)
- [End-to-end acceptance](docs/e2e-acceptance.md)
