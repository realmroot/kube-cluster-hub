package connector

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

func TestConnectorForwardsVerifiedIdentities(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	captured := make(chan http.Header, 3)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()
	connector := connectorFixture(t, key, upstream)

	userToken := "user-id-token"
	digest := sha256.Sum256([]byte(userToken))
	userClaims := DispatchClaims{
		Claims:         standardClaims("user-request"),
		ClusterID:      "development",
		Method:         http.MethodGet,
		URI:            "/api/v1/pods?limit=10",
		RequestID:      "request-user",
		PrincipalType:  "user",
		UserSubject:    "user-1",
		CredentialHash: base64.RawURLEncoding.EncodeToString(digest[:]),
	}
	response := connectorRequest(t, connector, key, userClaims, userToken)
	if response.Code != http.StatusOK {
		t.Fatalf("user response = %d %s", response.Code, response.Body.String())
	}
	userHeaders := <-captured
	if userHeaders.Get("Authorization") != "Bearer "+userToken || userHeaders.Get("Impersonate-User") != "" {
		t.Fatalf("user identity headers = %#v", userHeaders)
	}

	agentClaims := DispatchClaims{
		Claims:            standardClaims("agent-request"),
		ClusterID:         "development",
		Method:            http.MethodGet,
		URI:               "/api/v1/pods?limit=10",
		RequestID:         "request-agent",
		PrincipalType:     "agent",
		ControllerSubject: "controller-1",
		AgentIssuer:       "https://identity.example.com",
		AgentSubject:      "agent-1",
		Scopes:            "kubernetes:read kubernetes:write",
	}
	response = connectorRequest(t, connector, key, agentClaims, "")
	if response.Code != http.StatusOK {
		t.Fatalf("agent response = %d %s", response.Code, response.Body.String())
	}
	agentHeaders := <-captured
	if agentHeaders.Get("Authorization") != "Bearer service-account-token" ||
		agentHeaders.Get("Impersonate-User") != "kube-cluster-hub:agent" ||
		!contains(agentHeaders.Values("Impersonate-Group"), "kube-cluster-hub:agents:read") ||
		!contains(agentHeaders.Values("Impersonate-Group"), "kube-cluster-hub:agents:write") ||
		agentHeaders.Get("Impersonate-Extra-kube-cluster-hub.dev%2Fagent-subject") != "agent-1" {
		t.Fatalf("Agent identity headers = %#v", agentHeaders)
	}

	systemClaims := DispatchClaims{
		Claims:        standardClaims("system-request"),
		ClusterID:     "development",
		Method:        http.MethodGet,
		URI:           "/apis/multicluster.x-k8s.io/v1alpha1/namespaces/cluster-inventory/clusterprofiles",
		RequestID:     "request-system",
		PrincipalType: "system",
		SystemScope:   "cluster-inventory:write",
	}
	response = connectorRequestAt(t, connector, key, systemClaims, "", systemClaims.URI)
	if response.Code != http.StatusOK {
		t.Fatalf("system response = %d %s", response.Code, response.Body.String())
	}
	systemHeaders := <-captured
	if systemHeaders.Get("Authorization") != "Bearer service-account-token" || systemHeaders.Get("Impersonate-User") != "" {
		t.Fatalf("system identity headers = %#v", systemHeaders)
	}
}

func TestConnectorRejectsReplayAndSystemScopeEscape(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer upstream.Close()
	connector := connectorFixture(t, key, upstream)
	claims := DispatchClaims{
		Claims:         standardClaims("once"),
		ClusterID:      "development",
		Method:         http.MethodGet,
		URI:            "/api/v1/pods",
		RequestID:      "request-once",
		PrincipalType:  "user",
		UserSubject:    "user-1",
		CredentialHash: tokenHash("token"),
	}
	if response := connectorRequestAt(t, connector, key, claims, "token", claims.URI); response.Code != http.StatusNoContent {
		t.Fatalf("first request = %d %s", response.Code, response.Body.String())
	}
	if response := connectorRequestAt(t, connector, key, claims, "token", claims.URI); response.Code != http.StatusUnauthorized {
		t.Fatalf("replay = %d %s", response.Code, response.Body.String())
	}

	system := DispatchClaims{
		Claims:        standardClaims("scope-escape"),
		ClusterID:     "development",
		Method:        http.MethodGet,
		URI:           "/api/v1/secrets",
		RequestID:     "request-system",
		PrincipalType: "system",
		SystemScope:   "cluster-inventory:write",
	}
	if response := connectorRequestAt(t, connector, key, system, "", system.URI); response.Code != http.StatusForbidden {
		t.Fatalf("system scope escape = %d %s", response.Code, response.Body.String())
	}
}

func connectorFixture(t *testing.T, key *ecdsa.PrivateKey, upstream *httptest.Server) *Connector {
	t.Helper()
	directory := t.TempDir()
	certificate := upstream.Certificate()
	caPath := filepath.Join(directory, "ca.crt")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	tokenPath := filepath.Join(directory, "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	connector, err := New(Config{
		Address: ":0", ClusterID: "development", APIServerURL: upstream.URL, CABundleFile: caPath,
		ServiceAccountTokenFile: tokenPath, DispatchIssuer: "https://control.example.com",
		DispatchAudience: "kube-cluster-connector", DispatchPublicKeys: map[string]*ecdsa.PublicKey{"dispatch-key": &key.PublicKey},
		AgentReadGroup: "kube-cluster-hub:agents:read", AgentWriteGroup: "kube-cluster-hub:agents:write",
		ControlPlaneURL: "https://control.example.com", StatusToken: "status-token", StatusInterval: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return connector
}

func connectorRequest(t *testing.T, connector *Connector, key *ecdsa.PrivateKey, claims DispatchClaims, userToken string) *httptest.ResponseRecorder {
	t.Helper()
	return connectorRequestAt(t, connector, key, claims, userToken, "/api/v1/pods?limit=10")
}

func connectorRequestAt(t *testing.T, connector *Connector, key *ecdsa.PrivateKey, claims DispatchClaims, userToken, uri string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(claims.Method, "https://connector.example.com/clusters/development/kubernetes"+uri, nil)
	request.Header.Set("Authorization", "Bearer "+signDispatch(t, key, claims))
	if userToken != "" {
		request.Header.Set("X-Cluster-Authorization", "Bearer "+userToken)
	}
	request.Header.Set("Impersonate-User", "attacker")
	response := httptest.NewRecorder()
	connector.ServeHTTP(response, request)
	return response
}

func standardClaims(id string) jwt.Claims {
	now := time.Now().UTC()
	return jwt.Claims{
		Issuer: "https://control.example.com", Audience: jwt.Audience{"kube-cluster-connector"}, ID: id,
		IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(now.Add(30 * time.Second)),
	}
}

func signDispatch(t *testing.T, key *ecdsa.PrivateKey, claims DispatchClaims) string {
	t.Helper()
	options := (&jose.SignerOptions{}).WithType("cag-dispatch+jwt").WithHeader("kid", "dispatch-key")
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, options)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
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

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func TestParseSinglePublicJWKAndDNSLabel(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(jose.JSONWebKey{Key: &key.PublicKey, KeyID: "key-1", Algorithm: "ES256", Use: "sig"})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parsePublicKeys("", string(encoded))
	if err != nil || parsed["key-1"] == nil || len(parsed) != 1 {
		t.Fatalf("parse public JWK = %#v %v", parsed, err)
	}
	for _, value := range []string{"development", "cluster-1", "1-cluster"} {
		if !dnsLabel(value) {
			t.Fatalf("valid DNS label rejected: %q", value)
		}
	}
	for _, value := range []string{"", "UPPER", "-start", "end-", strings.Repeat("a", 64)} {
		if dnsLabel(value) {
			t.Fatalf("invalid DNS label accepted: %q", value)
		}
	}
}
