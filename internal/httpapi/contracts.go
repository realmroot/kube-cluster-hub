package httpapi

import (
	"fmt"
	"net/http"
)

func (s *Server) catalogDescription(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Link", fmt.Sprintf(`<%s/openapi/catalog.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`, s.cfg.GatewayBaseURL))
	writeJSON(w, http.StatusOK, map[string]string{"resource": s.cfg.CatalogBaseURL, "serviceDescription": s.cfg.GatewayBaseURL + "/openapi/catalog.json"})
}

func (s *Server) resourceMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                          s.cfg.ResourceURL,
		"authorization_servers":             []string{s.cfg.ResourceIssuer},
		"scopes_supported":                  []string{ScopeClustersRead, ScopeKubernetesRead, ScopeKubernetesWrite, ScopeAuditEventsRead},
		"dpop_bound_access_tokens_required": true,
		"dpop_signing_alg_values_supported": []string{"ES256"},
	})
}

func (s *Server) resourceDescription(w http.ResponseWriter, _ *http.Request) {
	openAPIURL := s.cfg.GatewayBaseURL + "/openapi/agent.json"
	w.Header().Set("Link", fmt.Sprintf(`<%s>; rel="service-desc"; type="application/vnd.oai.openapi+json"`, openAPIURL))
	writeJSON(w, http.StatusOK, map[string]string{"resource": s.cfg.ResourceURL, "serviceDescription": openAPIURL})
}

func (s *Server) catalogOpenAPI(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/vnd.oai.openapi+json")
	writeJSON(w, http.StatusOK, map[string]any{
		"openapi": "3.1.0",
		"info":    map[string]string{"title": "Cluster Access Gateway Catalog API", "version": APIVersion},
		"servers": []map[string]string{{"url": s.cfg.CatalogBaseURL}},
		"components": map[string]any{
			"securitySchemes": map[string]any{"oidc": map[string]any{"type": "openIdConnect", "openIdConnectUrl": s.cfg.OIDCIssuer + "/.well-known/openid-configuration"}},
			"schemas":         commonSchemas(),
		},
		"security": []map[string][]string{{"oidc": {}}},
		"paths": map[string]any{
			"/clusters": map[string]any{"get": paginated(catalogOperation("listClusters", "List clusters", false))},
			"/clusters/{clusterId}": map[string]any{
				"parameters": []any{pathParameter("clusterId")},
				"get":        catalogOperation("getCluster", "Get a cluster", false),
				"put":        catalogOperation("replaceCluster", "Create or replace a cluster", true),
				"delete":     catalogOperation("deleteCluster", "Delete a cluster", false),
			},
			"/audit-events": map[string]any{"get": paginated(catalogOperation("listAuditEvents", "List immutable access audit events", false))},
		},
	})
}

func (s *Server) agentOpenAPI(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/vnd.oai.openapi+json")
	writeJSON(w, http.StatusOK, map[string]any{
		"openapi": "3.1.0",
		"info": map[string]string{
			"title": "Cluster Access Gateway Agent API", "version": APIVersion,
			"description": "Discover clusters and invoke the canonical Kubernetes HTTP API under controller-approved Agent authority.",
		},
		"servers": []map[string]string{{"url": s.cfg.ResourceURL}},
		"components": map[string]any{
			"securitySchemes": map[string]any{"oauth": map[string]any{
				"type": "openIdConnect", "openIdConnectUrl": s.cfg.ResourceIssuer + "/.well-known/openid-configuration", "x-dpop-required": true,
			}},
			"schemas": commonSchemas(),
		},
		"paths": map[string]any{
			"/clusters":     map[string]any{"get": paginated(operation("listClusters", "List clusters", ScopeClustersRead, false))},
			"/audit-events": map[string]any{"get": paginated(operation("listAuditEvents", "List Agent-attributed access audit events", ScopeAuditEventsRead, false))},
			"/clusters/{clusterId}/kubernetes/{kubernetesPath}": map[string]any{
				"parameters": []any{pathParameter("clusterId"), map[string]any{
					"name": "kubernetesPath", "in": "path", "required": true, "schema": map[string]string{"type": "string"},
					"description": "Canonical Kubernetes API path, such as api/v1/namespaces/default/pods",
				}},
				"get":    kubernetesOperation("getKubernetesResource", ScopeKubernetesRead, false),
				"post":   kubernetesOperation("createKubernetesResource", ScopeKubernetesWrite, true),
				"put":    kubernetesOperation("replaceKubernetesResource", ScopeKubernetesWrite, true),
				"patch":  kubernetesOperation("updateKubernetesResource", ScopeKubernetesWrite, true),
				"delete": kubernetesOperation("deleteKubernetesResource", ScopeKubernetesWrite, false),
			},
		},
	})
}

func commonSchemas() map[string]any {
	return map[string]any{
		"Cluster": map[string]any{
			"type": "object", "required": []string{"id", "displayName", "apiServerUrl", "enabled", "default", "resourceVersion"},
			"properties": map[string]any{
				"id": map[string]string{"type": "string"}, "displayName": map[string]string{"type": "string"},
				"description": map[string]string{"type": "string"}, "apiServerUrl": map[string]string{"type": "string", "format": "uri"},
				"caBundle": map[string]string{"type": "string"}, "tlsServerName": map[string]string{"type": "string"},
				"prometheusUrl": map[string]string{"type": "string", "format": "uri"}, "enabled": map[string]string{"type": "boolean"},
				"default": map[string]string{"type": "boolean"}, "resourceVersion": map[string]string{"type": "integer", "format": "uint64"},
			},
		},
		"AuditEvent": map[string]any{"type": "object"},
		"Problem":    map[string]any{"type": "object", "required": []string{"type", "title", "status", "detail"}},
	}
}

func operation(id, summary, scope string, body bool) map[string]any {
	result := map[string]any{
		"operationId": id, "summary": summary,
		"security": []map[string][]string{{"oauth": {scope}}},
		"responses": map[string]any{
			"200": map[string]string{"description": "Success"}, "400": map[string]string{"description": "Invalid request"},
			"401": map[string]string{"description": "Authentication required"}, "403": map[string]string{"description": "Forbidden"},
		},
	}
	if body {
		result["requestBody"] = map[string]any{"required": true, "content": map[string]any{"application/json": map[string]any{"schema": map[string]string{"$ref": "#/components/schemas/Cluster"}}}}
	}
	return result
}

func catalogOperation(id, summary string, body bool) map[string]any {
	result := operation(id, summary, "", body)
	result["security"] = []map[string][]string{{"oidc": {}}}
	return result
}

func paginated(result map[string]any) map[string]any {
	result["parameters"] = []any{
		map[string]any{"name": "pageToken", "in": "query", "schema": map[string]string{"type": "string"}},
		map[string]any{"name": "pageSize", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 200, "default": 50}},
	}
	return result
}

func kubernetesOperation(id, scope string, body bool) map[string]any {
	result := operation(id, "Invoke the Kubernetes API", scope, false)
	result["parameters"] = kubernetesQueryParameters()
	result["responses"] = map[string]any{
		"200":     map[string]string{"description": "Kubernetes response"},
		"default": map[string]string{"description": "Kubernetes Status or gateway error"},
	}
	if body {
		result["requestBody"] = map[string]any{
			"required": true,
			"content": map[string]any{
				"application/json":             map[string]any{"schema": map[string]any{}},
				"application/yaml":             map[string]any{"schema": map[string]string{"type": "string"}},
				"application/merge-patch+json": map[string]any{"schema": map[string]any{}},
				"application/json-patch+json":  map[string]any{"schema": map[string]any{}},
			},
		}
	}
	return result
}

func kubernetesQueryParameters() []any {
	return []any{
		queryParameter("watch", "boolean", "Stream Kubernetes watch events"),
		queryParameter("timeoutSeconds", "integer", "Server-side request or watch timeout"),
		queryParameter("resourceVersion", "string", "Kubernetes resource version"),
		queryParameter("labelSelector", "string", "Kubernetes label selector"),
		queryParameter("fieldSelector", "string", "Kubernetes field selector"),
		queryParameter("follow", "boolean", "Stream pod logs"),
		queryParameter("container", "string", "Pod container name"),
		queryParameter("tailLines", "integer", "Number of pod log lines"),
	}
}

func queryParameter(name, parameterType, description string) map[string]any {
	return map[string]any{
		"name": name, "in": "query", "description": description,
		"schema": map[string]string{"type": parameterType},
	}
}

func pathParameter(name string) map[string]any {
	return map[string]any{"name": name, "in": "path", "required": true, "schema": map[string]string{"type": "string"}}
}
