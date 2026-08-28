# Headlamp upstream direction

The Hub does not patch or fork Headlamp. Official Headlamp can connect to a cluster configured with its Realmroot OIDC client and use the current user's token, but it does not currently consume the Hub catalog contract.

The desired upstream capability is a generic external cluster-catalog provider:

1. discover a versioned catalog endpoint through a URL configured by the operator;
2. read only cluster identity, display metadata, API endpoint, and optional metrics hint;
3. authenticate catalog reads with the current OIDC session;
4. authenticate Kubernetes requests with Headlamp's current Kubernetes OIDC token;
5. never import a token, kubeconfig, exec command, or Hub-specific credential;
6. preserve existing static and Cluster Inventory providers unchanged.

An upstream proposal should define a small provider interface first and use the Hub as one interoperable implementation. Names, interfaces, tests, and documentation must remain issuer- and product-neutral. Until accepted upstream, Headlamp clusters must be configured through official static/Helm configuration; the Hub and Kite integration do not depend on a local Headlamp patch.
