package httpapi

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/realmroot/cluster-access-gateway/internal/auth"
	"github.com/realmroot/cluster-access-gateway/internal/config"
	"github.com/realmroot/cluster-access-gateway/internal/proxy"
	"github.com/realmroot/cluster-access-gateway/internal/store"
)

type issuerFixture struct {
	origin string
	key    *rsa.PrivateKey
	kid    string
}

type publisherFixture struct {
	mu      sync.Mutex
	upserts []string
	deletes []string
}

func (p *publisherFixture) Upsert(_ context.Context, cluster *store.Cluster) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.upserts = append(p.upserts, cluster.ID)
	return nil
}

func (p *publisherFixture) Delete(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deletes = append(p.deletes, id)
	return nil
}

func TestCatalogUserAndAgentKubernetesJourneys(t *testing.T) {
	issuer := newIssuerFixture(t)
	db, err := store.Open("file:gateway-http-test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}

	tokenFile := t.TempDir() + "/service-account-token"
	if err := os.WriteFile(tokenFile, []byte("cluster-service-account"), 0o600); err != nil {
		t.Fatal(err)
	}

	var captured http.Header
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"kind":"PodList","items":[]}`)
	}))
	t.Cleanup(upstream.Close)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw})

	cfg := config.Config{
		GatewayBaseURL: "https://gateway.test", CatalogBaseURL: "https://gateway.test/api/catalog",
		OIDCIssuer: issuer.origin, OIDCAudience: "kubernetes-client", OIDCGroupsClaim: "groups",
		CatalogAdminGroups: []string{"platform-admins"}, ResourceURL: "https://gateway.test/api/agent",
		ResourceIssuer: issuer.origin, ResourceAuthorizedApps: []string{"agent-client"}, ResourceSigningAlgs: []string{"RS256"},
		AgentReadGroup: "cluster-access:agents:read", AgentWriteGroup: "cluster-access:agents:write",
		ServiceAccountTokenFile: tokenFile,
	}
	users, err := auth.NewUserVerifier(context.Background(), cfg.OIDCIssuer, cfg.OIDCAudience, cfg.OIDCGroupsClaim)
	if err != nil {
		t.Fatal(err)
	}
	agents, err := auth.NewAgentVerifier(context.Background(), cfg.ResourceIssuer, cfg.ResourceURL, cfg.ResourceAuthorizedApps, cfg.ResourceSigningAlgs, db)
	if err != nil {
		t.Fatal(err)
	}
	publisher := &publisherFixture{}
	handler := New(cfg, db, users, agents, proxy.NewFactory(tokenFile, cfg.AgentReadGroup, cfg.AgentWriteGroup), publisher)
	description := request(t, handler, http.MethodGet, "/api/agent", "", nil)
	if description.Code != http.StatusOK || !strings.Contains(description.Header().Get("Link"), "/openapi/agent.json") {
		t.Fatalf("public Agent service description = %d link=%q body=%s", description.Code, description.Header().Get("Link"), description.Body.String())
	}
	openAPI := request(t, handler, http.MethodGet, "/openapi/agent.json", "", nil)
	if openAPI.Code != http.StatusOK || !strings.Contains(openAPI.Body.String(), `"name":"watch"`) || !strings.Contains(openAPI.Body.String(), `"name":"follow"`) {
		t.Fatalf("Agent OpenAPI streaming parameters = %d %s", openAPI.Code, openAPI.Body.String())
	}

	userToken := issuer.sign(t, "JWT", map[string]any{
		"iss": issuer.origin, "sub": "user-1", "aud": "kubernetes-client", "exp": time.Now().Add(5 * time.Minute).Unix(),
		"iat": time.Now().Unix(), "groups": []string{"platform-admins"},
	})
	clusterBody := `{"displayName":"Development","description":"local kind","apiServerUrl":"` + upstream.URL + `","caBundle":` + quote(string(ca)) + `,"tlsServerName":"","prometheusUrl":"","enabled":true,"default":true}`
	created := request(t, handler, http.MethodPut, "/api/catalog/clusters/development", clusterBody, map[string]string{
		"Authorization": "Bearer " + userToken, "API-Version": APIVersion, "If-None-Match": "*",
	})
	if created.Code != http.StatusCreated || created.Header().Get("ETag") != `"1"` {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	if len(publisher.upserts) != 1 || publisher.upserts[0] != "development" {
		t.Fatalf("published clusters = %#v", publisher.upserts)
	}

	listed := request(t, handler, http.MethodGet, "/api/catalog/clusters", "", map[string]string{
		"Authorization": "Bearer " + userToken, "API-Version": APIVersion,
	})
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"id":"development"`) {
		t.Fatalf("list = %d %s", listed.Code, listed.Body.String())
	}
	invalidAuditPage := request(t, handler, http.MethodGet, "/api/catalog/audit-events?pageToken=not-a-number", "", map[string]string{
		"Authorization": "Bearer " + userToken, "API-Version": APIVersion,
	})
	if invalidAuditPage.Code != http.StatusBadRequest || !strings.Contains(invalidAuditPage.Body.String(), "pageToken is invalid") {
		t.Fatalf("invalid audit page token = %d %s", invalidAuditPage.Code, invalidAuditPage.Body.String())
	}

	userProxy := request(t, handler, http.MethodGet, "/clusters/development/kubernetes/api/v1/pods", "", map[string]string{
		"Authorization": "Bearer " + userToken,
	})
	if userProxy.Code != http.StatusOK || captured.Get("Authorization") != "Bearer "+userToken || captured.Get("Impersonate-User") != "" {
		t.Fatalf("user proxy = %d auth=%q impersonate=%q body=%s", userProxy.Code, captured.Get("Authorization"), captured.Get("Impersonate-User"), userProxy.Body.String())
	}

	dpopKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	thumbprint := jwkThumbprint(t, &dpopKey.PublicKey)
	agentToken := issuer.sign(t, "at+jwt", map[string]any{
		"iss": issuer.origin, "sub": "controller-1", "aud": cfg.ResourceURL, "exp": time.Now().Add(5 * time.Minute).Unix(),
		"iat": time.Now().Unix(), "jti": "agent-token-1", "client_id": "agent-client", "scope": "kubernetes:read",
		"cnf": map[string]string{"jkt": thumbprint}, "act": map[string]string{"iss": issuer.origin, "sub": "agent-1"},
	})
	target := cfg.ResourceURL + "/clusters/development/kubernetes/api/v1/pods"
	proof := signProof(t, dpopKey, http.MethodGet, target, agentToken, "proof-1")
	agentProxy := request(t, handler, http.MethodGet, "/api/agent/clusters/development/kubernetes/api/v1/pods", "", map[string]string{
		"Authorization": "DPoP " + agentToken, "DPoP": proof,
	})
	if agentProxy.Code != http.StatusOK {
		t.Fatalf("agent proxy = %d %s", agentProxy.Code, agentProxy.Body.String())
	}
	if captured.Get("Authorization") != "Bearer cluster-service-account" {
		t.Fatalf("agent upstream authorization = %q", captured.Get("Authorization"))
	}
	if captured.Get("Impersonate-User") == "" || !contains(captured.Values("Impersonate-Group"), cfg.AgentReadGroup) {
		t.Fatalf("agent impersonation headers = %#v", captured)
	}
	writeTarget := cfg.ResourceURL + "/clusters/development/kubernetes/api/v1/namespaces/default/configmaps"
	writeProof := signProof(t, dpopKey, http.MethodPost, writeTarget, agentToken, "proof-write-denied")
	writeDenied := request(t, handler, http.MethodPost, "/api/agent/clusters/development/kubernetes/api/v1/namespaces/default/configmaps", `{}`, map[string]string{
		"Authorization": "DPoP " + agentToken, "DPoP": writeProof,
	})
	if writeDenied.Code != http.StatusForbidden || !strings.Contains(writeDenied.Body.String(), "kubernetes:write") {
		t.Fatalf("read-only Agent write = %d %s", writeDenied.Code, writeDenied.Body.String())
	}

	replay := request(t, handler, http.MethodGet, "/api/agent/clusters/development/kubernetes/api/v1/pods", "", map[string]string{
		"Authorization": "DPoP " + agentToken, "DPoP": proof,
	})
	if replay.Code != http.StatusUnauthorized || !strings.Contains(replay.Body.String(), "already used") {
		t.Fatalf("replay = %d %s", replay.Code, replay.Body.String())
	}

	events, err := db.AuditEvents(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Status != http.StatusForbidden || events[0].AgentSubject != "agent-1" || events[0].TokenID != "agent-token-1" || events[2].PrincipalType != "user" {
		t.Fatalf("audit events = %#v", events)
	}
}

func TestCatalogRequiresVersionAndAdminGroup(t *testing.T) {
	issuer := newIssuerFixture(t)
	db, err := store.Open("file:gateway-auth-test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		GatewayBaseURL: "https://gateway.test", CatalogBaseURL: "https://gateway.test/api/catalog",
		OIDCIssuer: issuer.origin, OIDCAudience: "kubernetes-client", OIDCGroupsClaim: "groups", CatalogAdminGroups: []string{"platform-admins"},
		ResourceURL: "https://gateway.test/api/agent", ResourceIssuer: issuer.origin, ResourceAuthorizedApps: []string{"agent-client"}, ResourceSigningAlgs: []string{"RS256"},
	}
	users, _ := auth.NewUserVerifier(context.Background(), cfg.OIDCIssuer, cfg.OIDCAudience, cfg.OIDCGroupsClaim)
	agents, _ := auth.NewAgentVerifier(context.Background(), cfg.ResourceIssuer, cfg.ResourceURL, cfg.ResourceAuthorizedApps, cfg.ResourceSigningAlgs, db)
	handler := New(cfg, db, users, agents, proxy.NewFactory("/missing", "read", "write"), &publisherFixture{})
	token := issuer.sign(t, "JWT", map[string]any{
		"iss": issuer.origin, "sub": "user-2", "aud": "kubernetes-client", "exp": time.Now().Add(time.Minute).Unix(), "groups": []string{"developers"},
	})
	withoutVersion := request(t, handler, http.MethodGet, "/api/catalog/clusters", "", map[string]string{"Authorization": "Bearer " + token})
	if withoutVersion.Code != http.StatusBadRequest {
		t.Fatalf("missing version = %d", withoutVersion.Code)
	}
	denied := request(t, handler, http.MethodPut, "/api/catalog/clusters/dev", `{}`, map[string]string{
		"Authorization": "Bearer " + token, "API-Version": APIVersion, "If-None-Match": "*",
	})
	if denied.Code != http.StatusForbidden {
		t.Fatalf("non-admin create = %d %s", denied.Code, denied.Body.String())
	}
}

func TestFinalAuditStatusClassifiesSilentAndCancelledRequests(t *testing.T) {
	if got := finalAuditStatus(http.StatusNoContent, context.Background()); got != http.StatusNoContent {
		t.Fatalf("explicit status = %d", got)
	}
	if got := finalAuditStatus(0, context.Background()); got != http.StatusBadGateway {
		t.Fatalf("silent handler status = %d", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := finalAuditStatus(0, ctx); got != 499 {
		t.Fatalf("cancelled request status = %d", got)
	}
}

func newIssuerFixture(t *testing.T) *issuerFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &issuerFixture{key: key, kid: "test-key"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issuer": fixture.origin, "authorization_endpoint": fixture.origin + "/authorize",
				"token_endpoint": fixture.origin + "/token", "jwks_uri": fixture.origin + "/jwks",
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: fixture.kid, Algorithm: "RS256", Use: "sig"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	fixture.origin = server.URL
	t.Cleanup(server.Close)
	return fixture
}

func (f *issuerFixture) sign(t *testing.T, typ string, claims map[string]any) string {
	t.Helper()
	options := (&jose.SignerOptions{}).WithType(jose.ContentType(typ)).WithHeader("kid", f.kid)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key}, options)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(claims)
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}

func signProof(t *testing.T, key *ecdsa.PrivateKey, method, target, token, jti string) string {
	t.Helper()
	options := (&jose.SignerOptions{}).WithType("dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: &key.PublicKey, Algorithm: "ES256", Use: "sig"})
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, options)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(token))
	payload, _ := json.Marshal(map[string]any{
		"htm": method, "htu": target, "iat": time.Now().Unix(), "jti": jti, "ath": base64.RawURLEncoding.EncodeToString(digest[:]),
	})
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}

func jwkThumbprint(t *testing.T, key *ecdsa.PublicKey) string {
	t.Helper()
	thumbprint, err := (&jose.JSONWebKey{Key: key}).Thumbprint(crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(thumbprint)
}

func request(t *testing.T, handler http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
