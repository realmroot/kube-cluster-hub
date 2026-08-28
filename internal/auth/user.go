package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

type User struct {
	Subject string
	Groups  []string
	Token   string
}

type UserVerifier struct {
	issuer      string
	audience    string
	groupsClaim string
	verifier    *oidc.IDTokenVerifier
}

func NewUserVerifier(ctx context.Context, issuer, audience, groupsClaim string) (*UserVerifier, error) {
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("discover OIDC issuer: %w", err)
	}
	return &UserVerifier{
		issuer: issuer, audience: audience, groupsClaim: groupsClaim,
		verifier: provider.Verifier(&oidc.Config{ClientID: audience}),
	}, nil
}

func (v *UserVerifier) Verify(ctx context.Context, authorization string) (*User, error) {
	token, err := bearerToken(authorization)
	if err != nil {
		return nil, err
	}
	verified, err := v.verifier.Verify(ctx, token)
	if err != nil {
		return nil, Unauthorized("invalid_token", "OIDC token verification failed")
	}
	var raw map[string]json.RawMessage
	if err := verified.Claims(&raw); err != nil {
		return nil, Unauthorized("invalid_token", "OIDC token claims are invalid")
	}
	var subject string
	if err := json.Unmarshal(raw["sub"], &subject); err != nil || subject == "" {
		return nil, Unauthorized("invalid_token", "OIDC token subject is missing")
	}
	groups := []string{}
	if claim, ok := raw[v.groupsClaim]; ok {
		if err := json.Unmarshal(claim, &groups); err != nil {
			var single string
			if json.Unmarshal(claim, &single) != nil {
				return nil, Unauthorized("invalid_token", "OIDC groups claim is invalid")
			}
			groups = strings.Fields(single)
		}
	}
	return &User{Subject: subject, Groups: groups, Token: token}, nil
}

func bearerToken(value string) (string, error) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", Unauthorized("invalid_token", "Bearer OIDC token is required")
	}
	return parts[1], nil
}

func HasAnyGroup(actual, allowed []string) bool {
	set := make(map[string]struct{}, len(actual))
	for _, group := range actual {
		set[group] = struct{}{}
	}
	for _, group := range allowed {
		if _, ok := set[group]; ok {
			return true
		}
	}
	return false
}

type ProtocolError struct {
	Code        string
	Description string
	Status      int
}

func (e *ProtocolError) Error() string { return e.Description }

func Unauthorized(code, description string) error {
	return &ProtocolError{Code: code, Description: description, Status: 401}
}

func Forbidden(code, description string) error {
	return &ProtocolError{Code: code, Description: description, Status: 403}
}

func AsProtocolError(err error) *ProtocolError {
	var protocol *ProtocolError
	if errors.As(err, &protocol) {
		return protocol
	}
	return &ProtocolError{Code: "server_error", Description: "The protected resource rejected the request", Status: 500}
}
