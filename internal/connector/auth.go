package connector

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

type DispatchClaims struct {
	jwt.Claims
	ClusterID         string `json:"cluster_id"`
	Method            string `json:"method"`
	URI               string `json:"uri"`
	RequestID         string `json:"request_id"`
	PrincipalType     string `json:"principal_type"`
	UserSubject       string `json:"user_subject,omitempty"`
	CredentialHash    string `json:"credential_hash,omitempty"`
	ControllerSubject string `json:"controller_subject,omitempty"`
	AgentIssuer       string `json:"agent_issuer,omitempty"`
	AgentSubject      string `json:"agent_subject,omitempty"`
	Scopes            string `json:"scopes,omitempty"`
	SystemScope       string `json:"system_scope,omitempty"`
}

type DispatchVerifier struct {
	issuer   string
	audience string
	cluster  string
	keys     map[string]*ecdsa.PublicKey
	now      func() time.Time
	replays  *replayCache
}

func newDispatchVerifier(cfg Config) *DispatchVerifier {
	return &DispatchVerifier{
		issuer: cfg.DispatchIssuer, audience: cfg.DispatchAudience, cluster: cfg.ClusterID,
		keys: cfg.DispatchPublicKeys, now: time.Now, replays: newReplayCache(),
	}
}

func (v *DispatchVerifier) Verify(r *http.Request, uri string) (*DispatchClaims, error) {
	token, err := bearerToken(r.Header.Get("Authorization"))
	if err != nil {
		return nil, err
	}
	key, err := dispatchKey(token, v.keys)
	if err != nil {
		return nil, err
	}
	parsed, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		return nil, errors.New("dispatch token is malformed")
	}
	var claims DispatchClaims
	if err := parsed.Claims(key, &claims); err != nil {
		return nil, errors.New("dispatch token signature is invalid")
	}
	now := v.now().UTC()
	if err := claims.ValidateWithLeeway(jwt.Expected{Issuer: v.issuer, AnyAudience: jwt.Audience{v.audience}, Time: now}, 5*time.Second); err != nil {
		return nil, errors.New("dispatch token claims are invalid")
	}
	if claims.IssuedAt == nil || claims.Expiry == nil || claims.Expiry.Time().Sub(claims.IssuedAt.Time()) > time.Minute {
		return nil, errors.New("dispatch token lifetime is invalid")
	}
	if claims.ID == "" || claims.ClusterID != v.cluster || claims.Method != r.Method || claims.URI != uri || claims.RequestID == "" {
		return nil, errors.New("dispatch token request binding is invalid")
	}
	if !v.replays.consume(claims.ID, claims.Expiry.Time()) {
		return nil, errors.New("dispatch token was already used")
	}
	if err := validatePrincipal(&claims, r.Header.Get("X-Cluster-Authorization")); err != nil {
		return nil, err
	}
	return &claims, nil
}

func dispatchKey(compact string, keys map[string]*ecdsa.PublicKey) (*ecdsa.PublicKey, error) {
	parts := strings.Split(compact, ".")
	if len(parts) != 3 {
		return nil, errors.New("dispatch token is malformed")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("dispatch token header is malformed")
	}
	var header struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
		KeyID     string `json:"kid"`
	}
	if json.Unmarshal(payload, &header) != nil || header.Algorithm != "ES256" || !strings.EqualFold(header.Type, "cag-dispatch+jwt") || header.KeyID == "" {
		return nil, errors.New("dispatch token header is invalid")
	}
	key := keys[header.KeyID]
	if key == nil {
		return nil, errors.New("dispatch token key is not trusted")
	}
	return key, nil
}

func validatePrincipal(claims *DispatchClaims, userAuthorization string) error {
	switch claims.PrincipalType {
	case "user":
		if claims.UserSubject == "" || claims.CredentialHash == "" {
			return errors.New("user dispatch identity is invalid")
		}
		token, err := bearerToken(userAuthorization)
		if err != nil {
			return errors.New("forwarded user credential is missing")
		}
		digest := sha256.Sum256([]byte(token))
		if base64.RawURLEncoding.EncodeToString(digest[:]) != claims.CredentialHash {
			return errors.New("forwarded user credential does not match dispatch token")
		}
	case "agent":
		if claims.ControllerSubject == "" || claims.AgentIssuer == "" || claims.AgentSubject == "" {
			return errors.New("Agent dispatch identity is invalid")
		}
	case "system":
		if claims.SystemScope != "cluster-inventory:write" {
			return errors.New("system dispatch scope is invalid")
		}
	default:
		return errors.New("dispatch principal type is invalid")
	}
	return nil
}

func bearerToken(value string) (string, error) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", errors.New("Bearer dispatch token is required")
	}
	return parts[1], nil
}

type replayCache struct {
	mu      sync.Mutex
	expires map[string]time.Time
}

func newReplayCache() *replayCache { return &replayCache{expires: map[string]time.Time{}} }

func (c *replayCache) consume(jti string, expiresAt time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for existing, expiry := range c.expires {
		if !expiry.After(now) {
			delete(c.expires, existing)
		}
	}
	if _, exists := c.expires[jti]; exists {
		return false
	}
	c.expires[jti] = expiresAt
	return true
}
