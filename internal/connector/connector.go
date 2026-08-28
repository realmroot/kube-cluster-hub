package connector

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strings"

	"k8s.io/client-go/rest"
)

const Version = "0.2.0"

type Connector struct {
	cfg       Config
	verifier  *DispatchVerifier
	upstream  *url.URL
	transport http.RoundTripper
	proxy     *httputil.ReverseProxy
}

func New(cfg Config) (*Connector, error) {
	upstream, err := url.Parse(cfg.APIServerURL)
	if err != nil || upstream.Scheme != "https" || upstream.Host == "" {
		return nil, errors.New("Kubernetes API server URL must be absolute HTTPS")
	}
	caData, err := os.ReadFile(cfg.CABundleFile)
	if err != nil {
		return nil, fmt.Errorf("read Kubernetes CA bundle: %w", err)
	}
	transport, err := rest.TransportFor(&rest.Config{Host: cfg.APIServerURL, TLSClientConfig: rest.TLSClientConfig{
		CAData: caData, ServerName: cfg.TLSServerName,
	}})
	if err != nil {
		return nil, fmt.Errorf("create Kubernetes transport: %w", err)
	}
	connector := &Connector{cfg: cfg, verifier: newDispatchVerifier(cfg), upstream: upstream, transport: transport}
	connector.proxy = connector.newProxy()
	return connector, nil
}

func (c *Connector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		w.WriteHeader(http.StatusNoContent)
		return
	case "/readyz":
		if _, err := c.serviceAccountToken(); err != nil {
			http.Error(w, "Kubernetes execution credential unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	prefix := "/clusters/" + c.cfg.ClusterID + "/kubernetes"
	if r.URL.Path != prefix && !strings.HasPrefix(r.URL.Path, prefix+"/") {
		writeProblem(w, http.StatusNotFound, "not-found", "Connector route was not found")
		return
	}
	uri := strings.TrimPrefix(r.URL.Path, prefix)
	if uri == "" {
		uri = "/"
	}
	if r.URL.RawQuery != "" {
		uri += "?" + r.URL.RawQuery
	}
	claims, err := c.verifier.Verify(r, uri)
	if err != nil {
		writeProblem(w, http.StatusUnauthorized, "invalid-dispatch", err.Error())
		return
	}
	if claims.PrincipalType == "system" && !inventoryRequestAllowed(r.Method, strings.Split(uri, "?")[0]) {
		writeProblem(w, http.StatusForbidden, "system-scope-denied", "system dispatch is limited to ClusterProfile resources")
		return
	}
	if err := c.prepareUpstreamRequest(r, claims); err != nil {
		writeProblem(w, http.StatusServiceUnavailable, "execution-credential-unavailable", err.Error())
		return
	}
	r.Header.Set("X-Cluster-Access-URI", uri)
	w.Header().Set("Request-Id", claims.RequestID)
	c.proxy.ServeHTTP(w, r)
}

func (c *Connector) newProxy() *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(c.upstream)
	proxy.Transport = c.transport
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.URL.Path = joinPath(c.upstream.Path, request.Header.Get("X-Cluster-Access-URI"))
		request.URL.RawPath = ""
		request.Host = c.upstream.Host
		request.Header.Del("X-Cluster-Access-URI")
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, err error) {
		writeProblem(writer, http.StatusBadGateway, "kubernetes-unavailable", err.Error())
	}
	return proxy
}

func (c *Connector) prepareUpstreamRequest(request *http.Request, claims *DispatchClaims) error {
	request.Header.Del("Cookie")
	request.Header.Del("DPoP")
	request.Header.Del("Impersonate-User")
	request.Header.Del("Impersonate-Group")
	for name := range request.Header {
		if strings.HasPrefix(strings.ToLower(name), "impersonate-extra-") {
			request.Header.Del(name)
		}
	}
	switch claims.PrincipalType {
	case "user":
		request.Header.Set("Authorization", request.Header.Get("X-Cluster-Authorization"))
		request.Header.Del("X-Cluster-Authorization")
	case "agent":
		token, err := c.serviceAccountToken()
		if err != nil {
			return err
		}
		request.Header.Del("X-Cluster-Authorization")
		applyAgentIdentity(request, token, c.cfg.AgentReadGroup, c.cfg.AgentWriteGroup, claims)
	case "system":
		token, err := c.serviceAccountToken()
		if err != nil {
			return err
		}
		request.Header.Del("X-Cluster-Authorization")
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return nil
}

func (c *Connector) serviceAccountToken() (string, error) {
	value, err := os.ReadFile(c.cfg.ServiceAccountTokenFile)
	if err != nil {
		return "", fmt.Errorf("read Kubernetes execution token: %w", err)
	}
	token := strings.TrimSpace(string(value))
	if token == "" {
		return "", errors.New("Kubernetes execution token is empty")
	}
	return token, nil
}

func applyAgentIdentity(request *http.Request, token, readGroup, writeGroup string, claims *DispatchClaims) {
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Impersonate-User", "cluster-access:agent")
	request.Header.Add("Impersonate-Group", readGroup)
	if strings.Fields(claims.Scopes) != nil && contains(strings.Fields(claims.Scopes), "kubernetes:write") {
		request.Header.Add("Impersonate-Group", writeGroup)
	}
	request.Header.Set("Impersonate-Extra-cluster-access.io%2Fagent-issuer", claims.AgentIssuer)
	request.Header.Set("Impersonate-Extra-cluster-access.io%2Fagent-subject", claims.AgentSubject)
	request.Header.Set("Impersonate-Extra-cluster-access.io%2Fcontroller-subject", claims.ControllerSubject)
}

func inventoryRequestAllowed(method, requestPath string) bool {
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodPut && method != http.MethodDelete {
		return false
	}
	prefix := "/apis/multicluster.x-k8s.io/v1alpha1/namespaces/cluster-inventory/clusterprofiles"
	return requestPath == prefix || strings.HasPrefix(requestPath, prefix+"/")
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func joinPath(base, suffix string) string {
	suffix = strings.SplitN(suffix, "?", 2)[0]
	joined := path.Join("/", base, suffix)
	if strings.HasSuffix(suffix, "/") && !strings.HasSuffix(joined, "/") {
		joined += "/"
	}
	return joined
}

func writeProblem(w http.ResponseWriter, status int, problemType, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "https://cluster-access.io/problems/" + problemType, "title": http.StatusText(status),
		"status": status, "detail": detail,
	})
}
