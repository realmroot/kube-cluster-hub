package auth

import (
	"context"
	"crypto"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/realmroot/cluster-access-gateway/internal/store"
)

const proofLifetime = 5 * time.Minute

type Actor struct {
	Issuer  string `json:"iss"`
	Subject string `json:"sub"`
}

type Agent struct {
	ControllerSubject string
	Actor             Actor
	ClientID          string
	Scopes            map[string]struct{}
	ScopeString       string
	TokenID           string
}

type agentClaims struct {
	Issuer   string          `json:"iss"`
	Subject  string          `json:"sub"`
	Audience json.RawMessage `json:"aud"`
	TokenID  string          `json:"jti"`
	ClientID string          `json:"client_id"`
	Scope    string          `json:"scope"`
	Confirm  struct {
		Thumbprint string `json:"jkt"`
	} `json:"cnf"`
	Actor Actor `json:"act"`
}

type proofClaims struct {
	HTTPMethod string `json:"htm"`
	HTTPURI    string `json:"htu"`
	IssuedAt   int64  `json:"iat"`
	TokenHash  string `json:"ath"`
	TokenID    string `json:"jti"`
}

type ReplayStore interface {
	ConsumeProof(context.Context, string, string, time.Time) error
}

type AgentVerifier struct {
	issuer            string
	resource          string
	authorizedClients map[string]struct{}
	algorithms        []string
	verifier          *oidc.IDTokenVerifier
	now               func() time.Time
	replays           ReplayStore
}

func NewAgentVerifier(ctx context.Context, issuer, resource string, clients, algorithms []string, replays ReplayStore) (*AgentVerifier, error) {
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("discover Resource authorization server: %w", err)
	}
	allowed := make(map[string]struct{}, len(clients))
	for _, client := range clients {
		allowed[client] = struct{}{}
	}
	return &AgentVerifier{
		issuer: issuer, resource: resource, authorizedClients: allowed,
		algorithms: append([]string(nil), algorithms...),
		verifier:   provider.Verifier(&oidc.Config{SkipClientIDCheck: true, SupportedSigningAlgs: append([]string(nil), algorithms...)}),
		now:        time.Now, replays: replays,
	}, nil
}

func (v *AgentVerifier) Verify(ctx context.Context, authorization, proof, method, target string) (*Agent, error) {
	token, err := dpopToken(authorization)
	if err != nil {
		return nil, err
	}
	if err := validateJWTHeader(token, "at+jwt", v.algorithms); err != nil {
		return nil, Unauthorized("invalid_token", err.Error())
	}
	verified, err := v.verifier.Verify(ctx, token)
	if err != nil {
		return nil, Unauthorized("invalid_token", "access token verification failed")
	}
	var claims agentClaims
	if err := verified.Claims(&claims); err != nil {
		return nil, Unauthorized("invalid_token", "access token claims are invalid")
	}
	if claims.Issuer != v.issuer || claims.Subject == "" || claims.TokenID == "" || claims.ClientID == "" {
		return nil, Unauthorized("invalid_token", "access token identity claims are invalid")
	}
	if !audienceContains(claims.Audience, v.resource) {
		return nil, Unauthorized("invalid_token", "access token audience is invalid")
	}
	if _, ok := v.authorizedClients[claims.ClientID]; !ok {
		return nil, Unauthorized("invalid_token", "access token client is not authorized")
	}
	if claims.Actor.Subject == "" || claims.Actor.Issuer != v.issuer {
		return nil, Unauthorized("invalid_token", "access token Agent actor is invalid")
	}
	if claims.Confirm.Thumbprint == "" {
		return nil, Unauthorized("invalid_token", "access token is not proof-of-possession bound")
	}

	proofClaims, thumbprint, err := verifyProof(proof, method, target, v.now())
	if err != nil {
		return nil, err
	}
	if thumbprint != claims.Confirm.Thumbprint {
		return nil, Unauthorized("invalid_token", "DPoP key does not match the access token")
	}
	digest := sha256.Sum256([]byte(token))
	if proofClaims.TokenHash != base64.RawURLEncoding.EncodeToString(digest[:]) {
		return nil, Unauthorized("invalid_dpop_proof", "DPoP access token hash is invalid")
	}
	if err := v.replays.ConsumeProof(ctx, thumbprint, proofClaims.TokenID, v.now().Add(proofLifetime)); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, Unauthorized("invalid_dpop_proof", "DPoP proof was already used")
		}
		return nil, &ProtocolError{Code: "server_error", Description: "DPoP replay state is unavailable", Status: 500}
	}

	scopes := map[string]struct{}{}
	for _, scope := range strings.Fields(claims.Scope) {
		scopes[scope] = struct{}{}
	}
	return &Agent{
		ControllerSubject: claims.Subject, Actor: claims.Actor, ClientID: claims.ClientID,
		Scopes: scopes, ScopeString: claims.Scope, TokenID: claims.TokenID,
	}, nil
}

func (a *Agent) HasScope(scope string) bool {
	_, ok := a.Scopes[scope]
	return ok
}

func dpopToken(value string) (string, error) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "DPoP") || parts[1] == "" {
		return "", Unauthorized("invalid_token", "DPoP access token is required")
	}
	return parts[1], nil
}

func validateJWTHeader(compact, expectedType string, algorithms []string) error {
	parts := strings.Split(compact, ".")
	if len(parts) != 3 {
		return errors.New("access token is malformed")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return errors.New("access token header is malformed")
	}
	var header struct {
		Type      string `json:"typ"`
		Algorithm string `json:"alg"`
	}
	if json.Unmarshal(headerBytes, &header) != nil || !strings.EqualFold(header.Type, expectedType) {
		return errors.New("access token type is invalid")
	}
	for _, algorithm := range algorithms {
		if header.Algorithm == algorithm {
			return nil
		}
	}
	return errors.New("access token signing algorithm is invalid")
}

func audienceContains(raw json.RawMessage, expected string) bool {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == expected
	}
	var multiple []string
	if json.Unmarshal(raw, &multiple) != nil {
		return false
	}
	for _, audience := range multiple {
		if audience == expected {
			return true
		}
	}
	return false
}

func verifyProof(compact, method, target string, now time.Time) (*proofClaims, string, error) {
	if compact == "" {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof is required")
	}
	signed, err := jose.ParseSignedCompact(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(signed.Signatures) != 1 {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof is malformed")
	}
	header := signed.Signatures[0].Header
	typeValue, ok := header.ExtraHeaders[jose.HeaderKey("typ")].(string)
	if !ok || !strings.EqualFold(typeValue, "dpop+jwt") || header.Algorithm != string(jose.ES256) || header.JSONWebKey == nil || !header.JSONWebKey.IsPublic() {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof header is invalid")
	}
	payload, err := signed.Verify(header.JSONWebKey.Key)
	if err != nil {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof signature is invalid")
	}
	var claims proofClaims
	if json.Unmarshal(payload, &claims) != nil || claims.TokenID == "" || claims.IssuedAt == 0 {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof claims are invalid")
	}
	if claims.HTTPURI != target || claims.HTTPMethod != strings.ToUpper(method) {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof target is invalid")
	}
	issuedAt := time.Unix(claims.IssuedAt, 0)
	if issuedAt.Before(now.Add(-proofLifetime)) || issuedAt.After(now.Add(time.Minute)) {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP proof is stale")
	}
	thumbprint, err := header.JSONWebKey.Thumbprint(crypto.SHA256)
	if err != nil {
		return nil, "", Unauthorized("invalid_dpop_proof", "DPoP key is invalid")
	}
	return &claims, base64.RawURLEncoding.EncodeToString(thumbprint), nil
}
