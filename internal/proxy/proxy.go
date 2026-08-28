package proxy

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/realmroot/cluster-access-gateway/internal/auth"
	"github.com/realmroot/cluster-access-gateway/internal/store"
	"k8s.io/client-go/rest"
)

type Mode int

const (
	UserMode Mode = iota
	AgentMode
)

type Factory struct {
	tokenFile  string
	readGroup  string
	writeGroup string
	mu         sync.Mutex
	transports map[string]http.RoundTripper
}

func NewFactory(tokenFile, readGroup, writeGroup string) *Factory {
	return &Factory{
		tokenFile: tokenFile, readGroup: readGroup, writeGroup: writeGroup,
		transports: map[string]http.RoundTripper{},
	}
}

func (f *Factory) Handler(cluster *store.Cluster, prefix string, mode Mode, agent *auth.Agent) (http.Handler, error) {
	upstream, err := url.Parse(cluster.APIServerURL)
	if err != nil || upstream.Scheme != "https" || upstream.Host == "" {
		return nil, errors.New("cluster API server URL is invalid")
	}
	transport, err := f.transport(cluster)
	if err != nil {
		return nil, err
	}
	serviceAccountToken := ""
	if mode == AgentMode {
		if agent == nil {
			return nil, errors.New("verified Agent identity is required")
		}
		token, err := os.ReadFile(f.tokenFile)
		if err != nil {
			return nil, fmt.Errorf("read Kubernetes execution token: %w", err)
		}
		serviceAccountToken = strings.TrimSpace(string(token))
		if serviceAccountToken == "" {
			return nil, errors.New("Kubernetes execution token is empty")
		}
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.Transport = transport
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.URL.Path = joinPath(upstream.Path, strings.TrimPrefix(request.URL.Path, prefix))
		request.URL.RawPath = ""
		request.Host = upstream.Host
		request.Header.Del("Cookie")
		request.Header.Del("DPoP")
		request.Header.Del("Impersonate-User")
		request.Header.Del("Impersonate-Group")
		for name := range request.Header {
			if strings.HasPrefix(strings.ToLower(name), "impersonate-extra-") {
				request.Header.Del(name)
			}
		}
		if mode == AgentMode {
			applyAgentIdentity(request, serviceAccountToken, f.readGroup, f.writeGroup, agent)
		}
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, err error) {
		http.Error(writer, "Kubernetes upstream unavailable: "+err.Error(), http.StatusBadGateway)
	}
	return proxy, nil
}

func (f *Factory) transport(cluster *store.Cluster) (http.RoundTripper, error) {
	key := cluster.ID + ":" + fmt.Sprint(cluster.ResourceVersion)
	f.mu.Lock()
	defer f.mu.Unlock()
	if transport := f.transports[key]; transport != nil {
		return transport, nil
	}
	caData, err := decodeCABundle(cluster.CABundle)
	if err != nil {
		return nil, err
	}
	config := &rest.Config{Host: cluster.APIServerURL, TLSClientConfig: rest.TLSClientConfig{
		CAData: caData, ServerName: cluster.TLSServerName,
	}}
	transport, err := rest.TransportFor(config)
	if err != nil {
		return nil, fmt.Errorf("create cluster transport: %w", err)
	}
	for existingKey, existingTransport := range f.transports {
		if strings.HasPrefix(existingKey, cluster.ID+":") {
			if idleCloser, ok := existingTransport.(interface{ CloseIdleConnections() }); ok {
				idleCloser.CloseIdleConnections()
			}
			delete(f.transports, existingKey)
		}
	}
	f.transports[key] = transport
	return transport, nil
}

func applyAgentIdentity(request *http.Request, token, readGroup, writeGroup string, agent *auth.Agent) {
	request.Header.Set("Authorization", "Bearer "+token)
	digest := sha256.Sum256([]byte(agent.Actor.Issuer + "\x00" + agent.Actor.Subject))
	stableActor := base64.RawURLEncoding.EncodeToString(digest[:18])
	request.Header.Set("Impersonate-User", "cluster-access:agent:"+stableActor)
	request.Header.Add("Impersonate-Group", readGroup)
	if agent.HasScope("kubernetes:write") {
		request.Header.Add("Impersonate-Group", writeGroup)
	}
	request.Header.Set("Impersonate-Extra-cluster-access.io%2Fagent-issuer", agent.Actor.Issuer)
	request.Header.Set("Impersonate-Extra-cluster-access.io%2Fagent-subject", agent.Actor.Subject)
	request.Header.Set("Impersonate-Extra-cluster-access.io%2Fcontroller-subject", agent.ControllerSubject)
}

func decodeCABundle(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if strings.Contains(value, "BEGIN CERTIFICATE") {
		return []byte(value), nil
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, errors.New("cluster CA bundle must be PEM or base64-encoded PEM")
	}
	return decoded, nil
}

func joinPath(base, suffix string) string {
	joined := path.Join("/", base, suffix)
	if strings.HasSuffix(suffix, "/") && !strings.HasSuffix(joined, "/") {
		joined += "/"
	}
	return joined
}
