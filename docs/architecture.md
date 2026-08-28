# Architecture

## Design outcome

The system has a durable control plane and a deliberately small per-cluster
data plane:

```text
                         +-------------------------------+
Browser UI / Kite ------->| TypeScript Control Plane      |
Realmroot Toolbox ------>| catalog, auth, audit, dispatch|
                         | Worker+D1 or Node+SQLite       |
                         +---------------+---------------+
                                         | HTTPS + 30 s signed request
                                         v
                         +-------------------------------+
                         | Go Connector (one per cluster)|
                         | token passthrough / Agent SA  |
                         +---------------+---------------+
                                         | Kubernetes HTTP API
                                         v
                                  kube-apiserver + RBAC
```

There is no control-plane kubeconfig and no long-lived cluster token in the
catalog. Each cluster keeps its own ServiceAccount token inside Kubernetes.

## Identity paths

### Human user

1. The Hub UI or Kite signs the user in with a standard public OIDC client and
   PKCE. The catalog request includes an RFC 8707 resource indicator.
2. The dashboard uses the Access Token for catalog APIs and the ID Token for
   Kubernetes APIs. Kite keeps both in its encrypted server-side session.
3. The control plane validates the Kubernetes ID Token's issuer, audience,
   lifetime, and signature, then
   binds the token hash to a short-lived dispatch JWT.
4. The Connector verifies the dispatch JWT and forwards the original ID token
   unchanged to kube-apiserver.
5. kube-apiserver derives username/groups and performs native RBAC.

The control plane neither maps groups nor grants Kubernetes permissions.

### Agent

1. Realmroot Toolbox calls the Resource Server with an RFC 9068 access token,
   RFC 9449 DPoP proof, and RFC 8693 `act` actor identity.
2. The control plane verifies the token, proof, authorized OAuth client, and
   route scope (`kubernetes:read` or `kubernetes:write`).
3. It sends only verified actor/controller fields in a signed dispatch JWT; the
   external Agent token is never forwarded to the cluster.
4. The Connector uses its ServiceAccount and Kubernetes impersonation. The
   username is fixed (`kube-cluster-hub:agent`); verified identities are recorded
   as impersonation extras and in Hub audit records.
5. Kubernetes RBAC remains the final authorization decision.

OAuth scopes are an admission ceiling. They do not replace Kubernetes RBAC.

## Cluster catalog

A cluster record contains only connection and presentation metadata:

| Field | Purpose |
| --- | --- |
| `id` | Stable DNS-label identifier; also the Connector ID |
| `displayName`, `description` | UI presentation |
| `accessMode` | `connector` or `direct` |
| `connectorUrl` | Trusted HTTPS Connector endpoint; loopback HTTP is development-only |
| `apiServerUrl` | Direct-mode Kubernetes API URL; empty in Connector mode |
| `prometheusUrl` | Optional metrics endpoint metadata |
| `enabled`, `default` | Availability and UI selection |

Connector mode is the production default and the only Agent execution mode.
Direct mode exists for a publicly reachable kube-apiserver and human token
passthrough; Workers cannot use private CA bundles or custom TLS server names.
The catalog never stores those TLS trust values. In Connector mode, the
Connector obtains API-server trust from its local Kubernetes configuration.

## Deployment profiles

| Capability | Worker + D1 | Node/Docker + SQLite |
| --- | --- | --- |
| Catalog, auth, audit, dispatch | Yes | Yes |
| Human and Agent HTTP proxy | Yes | Yes |
| watch/log streaming | Yes | Yes |
| WebSocket exec/attach/port-forward | Worker WebSocket response | Native HTTP Upgrade bridge |
| Direct-mode custom CA/TLS name | No | No |
| ClusterProfile publication | Via configured inventory cluster | Via configured inventory cluster |

The two runtimes share the Hono route modules, domain validation, auth,
dispatch, inventory, and Drizzle schema/store. Only runtime startup and the
D1/SQLite database adapters differ.

## Scale and failure boundaries

- No informer is created per user or per cluster. Requests are streamed on
  demand; idle clusters consume catalog rows, not resident watches.
- A Connector has one replica by design so its in-memory dispatch replay cache
  has a single authority. It is restarted by Kubernetes on failure.
- A cluster failure is isolated to that Connector. Catalog, audit, and other
  clusters continue operating.
- Connector status authentication can update health only; it cannot authorize
  proxy calls. Proxy authority requires a valid request-bound dispatch JWT.
- The control plane can rotate dispatch keys by changing the JWK `kid` and
  rolling Connectors before retiring the previous key.

## Dashboard integrations

Kite consumes the catalog API directly for add/edit/delete and uses the native
Kubernetes proxy paths for all operations. Other dashboards can discover
enabled clusters from SIG Multicluster Cluster Inventory `ClusterProfile`
resources. No dashboard-specific credential is placed in a catalog row or
ClusterProfile.
