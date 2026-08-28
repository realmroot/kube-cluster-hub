# Headlamp upstream proposal

## Problem

Cluster Inventory API v0.1.3 resolves every configured AccessProvider through
an exec credential plugin. That is correct for providers which produce a
credential, but it prevents a dashboard from using a ClusterProfile only as
connection metadata while authenticating each request with the dashboard's
already configured current-user OIDC session.

Using a fake executable is unsafe and operationally brittle. Storing a token or
kubeconfig in the ClusterProfile would violate the inventory boundary.

## Proposed generic Headlamp behavior

Allow a provider entry with a `name` and no `execConfig` when deployment-level
OIDC is configured:

```yaml
config:
  oidc:
    clientID: kubernetes-dashboard-client
    issuerURL: https://identity.example.com
    scopes: email,profile,groups,offline_access
    usePKCE: true
  clusterInventory:
    enabled: true
    accessProvidersConfig:
      providers:
        - name: oidc-passthrough
```

For the first matching credentialless provider, Headlamp copies only the
ClusterProfile server, CA, insecure-TLS, and proxy metadata into a context and
inherits its deployment OIDC configuration. A provider with `execConfig`
continues through the upstream Cluster Inventory SDK unchanged. A
credentialless provider without OIDC fails closed.

The implementation changes only:

- `backend/pkg/clusterinventory/clusterinventory.go`;
- its unit tests;
- `backend/cmd/headlamp.go` to pass the deployment OIDC config into the runner.

Long-running sessions also exposed an independent upstream OIDC issue: adding
`offline_access` to scopes is insufficient when the authorization request omits
`prompt=consent`. OIDC Core requires that consent signal for offline access
unless the provider has another durable consent mechanism. The local patch now
adds `prompt=consent` generically whenever the configured scopes contain
`offline_access`, with handler-level regression coverage. This is not tied to
the credentialless Cluster Inventory provider and should be proposed as a
separate, small upstream change.

It contains no Realmroot URL, claim, client ID, Gateway API, or product name.
Local tests prove OIDC inheritance, absence of an exec credential, standard
exec-provider compatibility, invalid configuration rejection, and existing
Cluster Inventory behavior.

## Upstream work

1. Open a Headlamp issue describing current-user authentication as a distinct
   credentialless AccessProvider mode.
2. Submit the minimal generic patch and tests; do not include the local Helm
   values or Gateway-specific provider name in the PR.
3. Submit the offline-access consent fix separately so it can be reviewed and
   released independently of Cluster Inventory.
4. Ask SIG Multicluster whether a standard AccessProvider name/capability should
   be documented in the Cluster Inventory API so dashboards can converge on
   one well-known semantic instead of local names.
5. After merge, pin the first released Headlamp version containing the change
   and remove the local Headlamp patch.

No upstream change is required for the Hub catalog or Realmroot Agent
Resource Server; those are independent services and remain outside Headlamp.
