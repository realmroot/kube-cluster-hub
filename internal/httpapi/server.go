package httpapi

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/realmroot/cluster-access-gateway/internal/auth"
	"github.com/realmroot/cluster-access-gateway/internal/config"
	"github.com/realmroot/cluster-access-gateway/internal/proxy"
	"github.com/realmroot/cluster-access-gateway/internal/store"
	"k8s.io/apimachinery/pkg/util/validation"
)

const (
	APIVersion           = "2026-08-27"
	ScopeClustersRead    = "clusters:read"
	ScopeKubernetesRead  = "kubernetes:read"
	ScopeKubernetesWrite = "kubernetes:write"
	ScopeAuditEventsRead = "audit-events:read"
)

type InventoryPublisher interface {
	Upsert(context.Context, *store.Cluster) error
	Delete(context.Context, string) error
}

type Server struct {
	cfg       config.Config
	store     *store.Store
	users     *auth.UserVerifier
	agents    *auth.AgentVerifier
	proxies   *proxy.Factory
	inventory InventoryPublisher
	router    chi.Router
}

type contextKey string

const (
	userKey  contextKey = "user"
	agentKey contextKey = "agent"
	auditKey contextKey = "audit-event"
)

func New(cfg config.Config, database *store.Store, users *auth.UserVerifier, agents *auth.AgentVerifier, proxies *proxy.Factory, inventory InventoryPublisher) *Server {
	s := &Server{cfg: cfg, store: database, users: users, agents: agents, proxies: proxies, inventory: inventory}
	s.router = s.routes()
	return s
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.router.ServeHTTP(writer, request)
}

func (s *Server) routes() chi.Router {
	router := chi.NewRouter()
	router.Use(requestID)
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	router.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.Ready(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	router.Get("/openapi/catalog.json", s.catalogOpenAPI)
	router.Get("/openapi/agent.json", s.agentOpenAPI)
	router.Get("/.well-known/oauth-protected-resource"+resourcePath(s.cfg.ResourceURL), s.resourceMetadata)
	router.Get(resourcePath(s.cfg.ResourceURL), s.resourceDescription)

	router.Route("/api/catalog", func(catalog chi.Router) {
		catalog.Use(apiVersion)
		catalog.Use(s.authenticateUser)
		catalog.Get("/", s.catalogDescription)
		catalog.Get("/clusters", s.listClusters)
		catalog.Get("/clusters/{clusterId}", s.getCluster)
		catalog.With(s.requireAdmin).Put("/clusters/{clusterId}", s.putCluster)
		catalog.With(s.requireAdmin).Delete("/clusters/{clusterId}", s.deleteCluster)
		catalog.With(s.requireAdmin).Get("/audit-events", s.listAuditEvents)
	})

	router.Route("/clusters/{clusterId}/kubernetes", func(kubernetes chi.Router) {
		kubernetes.Use(s.authenticateUser)
		kubernetes.Handle("/*", http.HandlerFunc(s.userKubernetesProxy))
		kubernetes.Handle("/", http.HandlerFunc(s.userKubernetesProxy))
	})

	resourceBase := resourcePath(s.cfg.ResourceURL)
	router.With(s.authenticateAgent, s.auditAgent).Get(resourceBase+"/clusters", s.requireAgentScope(ScopeClustersRead, s.agentListClusters))
	router.With(s.authenticateAgent, s.auditAgent).Get(resourceBase+"/audit-events", s.requireAgentScope(ScopeAuditEventsRead, s.agentListAuditEvents))
	router.With(s.authenticateAgent, s.auditAgent).Handle(resourceBase+"/clusters/{clusterId}/kubernetes/*", s.requireAgentKubernetes(http.HandlerFunc(s.agentKubernetesProxy)))
	router.With(s.authenticateAgent, s.auditAgent).Handle(resourceBase+"/clusters/{clusterId}/kubernetes", s.requireAgentKubernetes(http.HandlerFunc(s.agentKubernetesProxy)))
	return router
}

func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.Header.Get("Request-Id"))
		if id == "" {
			id = fmt.Sprintf("req_%d", time.Now().UnixNano())
		}
		w.Header().Set("Request-Id", id)
		next.ServeHTTP(w, r)
	})
}

func apiVersion(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("API-Version", APIVersion)
		if r.Header.Get("API-Version") != APIVersion {
			problem(w, r, http.StatusBadRequest, "unsupported-api-version", "Unsupported API version", "API-Version must be "+APIVersion)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authenticateUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.users.Verify(r.Context(), r.Header.Get("Authorization"))
		if err != nil {
			protocolError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	})
}

func (s *Server) authenticateAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := s.cfg.ResourceURL + strings.TrimPrefix(r.URL.EscapedPath(), resourcePath(s.cfg.ResourceURL))
		agent, err := s.agents.Verify(r.Context(), r.Header.Get("Authorization"), r.Header.Get("DPoP"), r.Method, target)
		if err != nil {
			protocolError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), agentKey, agent)))
	})
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := r.Context().Value(userKey).(*auth.User)
		if !auth.HasAnyGroup(user.Groups, s.cfg.CatalogAdminGroups) {
			problem(w, r, http.StatusForbidden, "catalog-admin-required", "Forbidden", "Catalog administrator group membership is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireAgentScope(scope string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !r.Context().Value(agentKey).(*auth.Agent).HasScope(scope) {
			protocolError(w, auth.Forbidden("insufficient_scope", "Required scope: "+scope))
			return
		}
		next(w, r)
	}
}

func (s *Server) requireAgentKubernetes(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		required := ScopeKubernetesWrite
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			required = ScopeKubernetesRead
		}
		if !r.Context().Value(agentKey).(*auth.Agent).HasScope(required) {
			protocolError(w, auth.Forbidden("insufficient_scope", "Required scope: "+required))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) auditAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agent := r.Context().Value(agentKey).(*auth.Agent)
		event := &store.AuditEvent{
			RequestID: w.Header().Get("Request-Id"), TokenID: agent.TokenID, PrincipalType: "agent",
			ControllerSubject: agent.ControllerSubject, AgentIssuer: agent.Actor.Issuer,
			AgentSubject: agent.Actor.Subject, ClientID: agent.ClientID, Scopes: agent.ScopeString,
			ClusterID: chi.URLParam(r, "clusterId"), Method: r.Method, Path: r.URL.EscapedPath(),
		}
		start := time.Now()
		if err := s.store.AppendAudit(r.Context(), event); err != nil {
			problem(w, r, http.StatusServiceUnavailable, "audit-unavailable", "Audit unavailable", err.Error())
			return
		}
		recorder := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(recorder, r.WithContext(context.WithValue(r.Context(), auditKey, event.ID)))
		status := finalAuditStatus(recorder.status, r.Context())
		_ = s.store.FinishAudit(context.WithoutCancel(r.Context()), event.ID, status, time.Since(start))
	})
}

type clusterInput struct {
	DisplayName   string `json:"displayName"`
	Description   string `json:"description"`
	APIServerURL  string `json:"apiServerUrl"`
	CABundle      string `json:"caBundle"`
	TLSServerName string `json:"tlsServerName"`
	PrometheusURL string `json:"prometheusUrl"`
	Enabled       bool   `json:"enabled"`
	Default       bool   `json:"default"`
}

func (s *Server) putCluster(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "clusterId")
	if problems := validation.IsDNS1123Label(id); len(problems) != 0 {
		problem(w, r, http.StatusBadRequest, "invalid-cluster-id", "Invalid cluster ID", strings.Join(problems, "; "))
		return
	}
	var input clusterInput
	if err := decodeJSON(r.Body, &input); err != nil {
		problem(w, r, http.StatusBadRequest, "invalid-body", "Invalid request body", err.Error())
		return
	}
	if err := validateClusterInput(input); err != nil {
		problem(w, r, http.StatusBadRequest, "invalid-cluster", "Invalid cluster", err.Error())
		return
	}
	cluster := &store.Cluster{ID: id, DisplayName: input.DisplayName, Description: input.Description,
		APIServerURL: input.APIServerURL, CABundle: input.CABundle, TLSServerName: input.TLSServerName,
		PrometheusURL: input.PrometheusURL, Enabled: input.Enabled, Default: input.Default}
	existing, err := s.store.Cluster(r.Context(), id)
	created := errors.Is(err, store.ErrNotFound)
	if err != nil && !created {
		problem(w, r, http.StatusInternalServerError, "catalog-unavailable", "Catalog unavailable", err.Error())
		return
	}
	if created {
		if r.Header.Get("If-None-Match") != "*" {
			problem(w, r, http.StatusPreconditionRequired, "precondition-required", "Precondition required", "Create requires If-None-Match: *")
			return
		}
		if err := s.store.CreateCluster(r.Context(), cluster); err != nil {
			writeStoreError(w, r, err)
			return
		}
	} else {
		expected, err := parseETag(r.Header.Get("If-Match"))
		if err != nil {
			problem(w, r, http.StatusPreconditionRequired, "precondition-required", "Precondition required", "Replace requires the current If-Match ETag")
			return
		}
		if err := s.store.ReplaceCluster(r.Context(), cluster, expected); err != nil {
			writeStoreError(w, r, err)
			return
		}
	}
	if err := s.inventory.Upsert(r.Context(), cluster); err != nil {
		_ = s.store.SetInventoryPublication(context.WithoutCancel(r.Context()), cluster.ID, "error", err.Error())
		problem(w, r, http.StatusServiceUnavailable, "inventory-publication-failed", "Cluster Inventory unavailable", err.Error())
		return
	}
	if err := s.store.SetInventoryPublication(r.Context(), cluster.ID, "ready", ""); err != nil {
		writeStoreError(w, r, err)
		return
	}
	stored, err := s.store.Cluster(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(stored.ResourceVersion))
	w.Header().Set("Location", s.cfg.CatalogBaseURL+"/clusters/"+url.PathEscape(id))
	if created {
		writeJSON(w, http.StatusCreated, stored)
		return
	}
	writeJSON(w, http.StatusOK, stored)
	_ = existing
}

func (s *Server) deleteCluster(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "clusterId")
	expected, err := parseETag(r.Header.Get("If-Match"))
	if err != nil {
		problem(w, r, http.StatusPreconditionRequired, "precondition-required", "Precondition required", "Delete requires the current If-Match ETag")
		return
	}
	if err := s.inventory.Delete(r.Context(), id); err != nil {
		problem(w, r, http.StatusServiceUnavailable, "inventory-publication-failed", "Cluster Inventory unavailable", err.Error())
		return
	}
	if err := s.store.DeleteCluster(r.Context(), id, expected); err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getCluster(w http.ResponseWriter, r *http.Request) {
	cluster, err := s.store.Cluster(r.Context(), chi.URLParam(r, "clusterId"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(cluster.ResourceVersion))
	writeJSON(w, http.StatusOK, cluster)
}

func (s *Server) listClusters(w http.ResponseWriter, r *http.Request) {
	items, next, err := s.clusterPage(r)
	if err != nil {
		problem(w, r, http.StatusBadRequest, "invalid-pagination", "Invalid pagination", err.Error())
		return
	}
	response := map[string]any{"items": items, "pagination": map[string]any{"pageSize": pageSize(r)}}
	if next != "" {
		response["pagination"].(map[string]any)["nextPageToken"] = next
		nextURL := *r.URL
		query := nextURL.Query()
		query.Set("pageToken", next)
		nextURL.RawQuery = query.Encode()
		w.Header().Set("Link", "<"+nextURL.String()+">; rel=\"next\"")
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) clusterPage(r *http.Request) ([]store.Cluster, string, error) {
	after, err := decodeCursor(r.URL.Query().Get("pageToken"))
	if err != nil {
		return nil, "", err
	}
	limit := pageSize(r)
	items, err := s.store.Clusters(r.Context(), after, limit+1)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(items) > limit {
		next = encodeCursor(items[limit-1].ID)
		items = items[:limit]
	}
	return items, next, nil
}

func (s *Server) listAuditEvents(w http.ResponseWriter, r *http.Request) {
	s.writeAuditEvents(w, r)
}

func (s *Server) agentListClusters(w http.ResponseWriter, r *http.Request) {
	items, next, err := s.clusterPage(r)
	if err != nil {
		protocolError(w, &auth.ProtocolError{Code: "invalid_request", Description: err.Error(), Status: 400})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "pagination": map[string]any{"pageSize": pageSize(r), "nextPageToken": next}})
}

func (s *Server) agentListAuditEvents(w http.ResponseWriter, r *http.Request) {
	s.writeAuditEvents(w, r)
}

func (s *Server) writeAuditEvents(w http.ResponseWriter, r *http.Request) {
	after := uint64(0)
	if token := r.URL.Query().Get("pageToken"); token != "" {
		var err error
		after, err = strconv.ParseUint(token, 10, 64)
		if err != nil || after == 0 {
			problem(w, r, http.StatusBadRequest, "invalid-pagination", "Invalid pagination", "pageToken is invalid")
			return
		}
	}
	limit := pageSize(r)
	queryLimit := limit + 1
	if _, ok := r.Context().Value(auditKey).(uint64); ok {
		queryLimit++
	}
	items, err := s.store.AuditEvents(r.Context(), after, queryLimit)
	if err != nil {
		problem(w, r, http.StatusInternalServerError, "audit-unavailable", "Audit unavailable", err.Error())
		return
	}
	if currentID, ok := r.Context().Value(auditKey).(uint64); ok {
		items = slices.DeleteFunc(items, func(event store.AuditEvent) bool { return event.ID == currentID })
	}
	next := ""
	if len(items) > limit {
		next = strconv.FormatUint(items[limit-1].ID, 10)
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "pagination": map[string]any{"pageSize": limit, "nextPageToken": next}})
}

func (s *Server) userKubernetesProxy(w http.ResponseWriter, r *http.Request) {
	cluster, err := s.enabledCluster(r)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	user := r.Context().Value(userKey).(*auth.User)
	event := &store.AuditEvent{RequestID: w.Header().Get("Request-Id"), PrincipalType: "user", UserSubject: user.Subject,
		ClusterID: cluster.ID, Method: r.Method, Path: r.URL.EscapedPath()}
	s.proxyWithAudit(w, r, event, cluster, proxy.UserMode, nil, "/clusters/"+cluster.ID+"/kubernetes")
}

func (s *Server) agentKubernetesProxy(w http.ResponseWriter, r *http.Request) {
	cluster, err := s.enabledCluster(r)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	agent := r.Context().Value(agentKey).(*auth.Agent)
	handler, err := s.proxies.Handler(cluster, resourcePath(s.cfg.ResourceURL)+"/clusters/"+cluster.ID+"/kubernetes", proxy.AgentMode, agent)
	if err != nil {
		problem(w, r, http.StatusBadGateway, "cluster-unavailable", "Cluster unavailable", err.Error())
		return
	}
	handler.ServeHTTP(w, r)
}

func (s *Server) proxyWithAudit(w http.ResponseWriter, r *http.Request, event *store.AuditEvent, cluster *store.Cluster, mode proxy.Mode, agent *auth.Agent, prefix string) {
	start := time.Now()
	if err := s.store.AppendAudit(r.Context(), event); err != nil {
		problem(w, r, http.StatusServiceUnavailable, "audit-unavailable", "Audit unavailable", err.Error())
		return
	}
	handler, err := s.proxies.Handler(cluster, prefix, mode, agent)
	if err != nil {
		_ = s.store.FinishAudit(context.WithoutCancel(r.Context()), event.ID, http.StatusBadGateway, time.Since(start))
		problem(w, r, http.StatusBadGateway, "cluster-unavailable", "Cluster unavailable", err.Error())
		return
	}
	recorder := &statusWriter{ResponseWriter: w}
	handler.ServeHTTP(recorder, r)
	status := finalAuditStatus(recorder.status, r.Context())
	_ = s.store.FinishAudit(context.WithoutCancel(r.Context()), event.ID, status, time.Since(start))
}

func finalAuditStatus(status int, ctx context.Context) int {
	if status != 0 {
		return status
	}
	if ctx.Err() != nil {
		return 499 // Client Closed Request; useful for cancelled watches/log streams.
	}
	return http.StatusBadGateway
}

func (s *Server) enabledCluster(r *http.Request) (*store.Cluster, error) {
	cluster, err := s.store.Cluster(r.Context(), chi.URLParam(r, "clusterId"))
	if err != nil {
		return nil, err
	}
	if !cluster.Enabled {
		return nil, store.ErrNotFound
	}
	return cluster, nil
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	return h.Hijack()
}
func (w *statusWriter) Push(target string, options *http.PushOptions) error {
	if p, ok := w.ResponseWriter.(http.Pusher); ok {
		return p.Push(target, options)
	}
	return http.ErrNotSupported
}

func validateClusterInput(input clusterInput) error {
	if strings.TrimSpace(input.DisplayName) == "" {
		return errors.New("displayName is required")
	}
	parsed, err := url.Parse(strings.TrimSpace(input.APIServerURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("apiServerUrl must be an absolute HTTPS URL without credentials, query, or fragment")
	}
	if input.PrometheusURL != "" {
		prometheus, err := url.Parse(input.PrometheusURL)
		if err != nil || (prometheus.Scheme != "http" && prometheus.Scheme != "https") || prometheus.Host == "" || prometheus.User != nil {
			return errors.New("prometheusUrl must be an absolute HTTP(S) URL without credentials")
		}
	}
	return nil
}

func decodeJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(reader, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain exactly one JSON object")
	}
	return nil
}

func parseETag(value string) (uint64, error) {
	value = strings.Trim(value, "\"")
	return strconv.ParseUint(value, 10, 64)
}

func etag(version uint64) string { return fmt.Sprintf("\"%d\"", version) }
func pageSize(r *http.Request) int {
	value, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if value <= 0 {
		return 50
	}
	if value > 200 {
		return 200
	}
	return value
}
func encodeCursor(value string) string { return base64.RawURLEncoding.EncodeToString([]byte(value)) }
func decodeCursor(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", errors.New("pageToken is invalid")
	}
	return string(decoded), nil
}

func resourcePath(resource string) string {
	parsed, _ := url.Parse(resource)
	return parsed.EscapedPath()
}

func protocolError(w http.ResponseWriter, err error) {
	protocol := auth.AsProtocolError(err)
	if protocol.Status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`DPoP error="%s"`, protocol.Code))
	}
	writeJSON(w, protocol.Status, map[string]string{"error": protocol.Code, "error_description": protocol.Description})
}

func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		problem(w, r, http.StatusNotFound, "resource-not-found", "Resource not found", "The requested resource does not exist")
	case errors.Is(err, store.ErrConflict):
		problem(w, r, http.StatusPreconditionFailed, "resource-conflict", "Resource conflict", "The resource changed; read it and retry with its current ETag")
	default:
		problem(w, r, http.StatusInternalServerError, "database-error", "Database error", err.Error())
	}
}

func problem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	writeJSON(w, status, map[string]any{
		"type": "https://cluster-access.dev/problems/" + code, "title": title, "status": status,
		"detail": detail, "instance": r.URL.Path, "requestId": w.Header().Get("Request-Id"),
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
