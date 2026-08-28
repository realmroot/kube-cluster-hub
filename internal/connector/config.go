package connector

import (
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
)

type Config struct {
	Address                 string
	ClusterID               string
	APIServerURL            string
	CABundleFile            string
	TLSServerName           string
	ServiceAccountTokenFile string
	DispatchIssuer          string
	DispatchAudience        string
	DispatchPublicKeys      map[string]*ecdsa.PublicKey
	AgentReadGroup          string
	AgentWriteGroup         string
	ControlPlaneURL         string
	StatusToken             string
	StatusInterval          time.Duration
}

func LoadConfig() (Config, error) {
	cfg := Config{
		Address:                 env("CONNECTOR_ADDRESS", ":8081"),
		ClusterID:               strings.TrimSpace(os.Getenv("CONNECTOR_CLUSTER_ID")),
		APIServerURL:            strings.TrimRight(env("KUBERNETES_API_SERVER_URL", "https://kubernetes.default.svc"), "/"),
		CABundleFile:            env("KUBERNETES_CA_BUNDLE_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
		TLSServerName:           strings.TrimSpace(os.Getenv("KUBERNETES_TLS_SERVER_NAME")),
		ServiceAccountTokenFile: env("KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
		DispatchIssuer:          strings.TrimRight(os.Getenv("DISPATCH_ISSUER"), "/"),
		DispatchAudience:        env("DISPATCH_AUDIENCE", "cluster-access-connector"),
		AgentReadGroup:          env("KUBERNETES_AGENT_READ_GROUP", "cluster-access:agents:read"),
		AgentWriteGroup:         env("KUBERNETES_AGENT_WRITE_GROUP", "cluster-access:agents:write"),
		ControlPlaneURL:         strings.TrimRight(os.Getenv("CONTROL_PLANE_URL"), "/"),
		StatusToken:             strings.TrimSpace(os.Getenv("CONNECTOR_STATUS_TOKEN")),
		StatusInterval:          30 * time.Second,
	}
	if raw := strings.TrimSpace(os.Getenv("CONNECTOR_STATUS_INTERVAL")); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("CONNECTOR_STATUS_INTERVAL: %w", err)
		}
		cfg.StatusInterval = value
	}
	keys, err := parsePublicKeys(
		os.Getenv("DISPATCH_SIGNING_PUBLIC_JWKS"),
		os.Getenv("DISPATCH_SIGNING_PUBLIC_JWK"),
	)
	if err != nil {
		return Config{}, err
	}
	cfg.DispatchPublicKeys = keys
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if !dnsLabel(c.ClusterID) {
		return errors.New("CONNECTOR_CLUSTER_ID must be a DNS label")
	}
	for name, value := range map[string]string{
		"KUBERNETES_API_SERVER_URL": c.APIServerURL,
		"DISPATCH_ISSUER":           c.DispatchIssuer,
		"CONTROL_PLANE_URL":         c.ControlPlaneURL,
	} {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("%s must be an absolute HTTP(S) URL", name)
		}
		if name == "CONTROL_PLANE_URL" && parsed.Scheme != "https" && !loopbackHost(parsed.Hostname()) {
			return errors.New("CONTROL_PLANE_URL must use HTTPS outside loopback development")
		}
	}
	if c.DispatchAudience == "" || len(c.DispatchPublicKeys) == 0 {
		return errors.New("dispatch issuer, audience, and public key are required")
	}
	if c.StatusToken == "" {
		return errors.New("CONNECTOR_STATUS_TOKEN is required")
	}
	if c.StatusInterval <= 0 {
		return errors.New("CONNECTOR_STATUS_INTERVAL must be greater than zero")
	}
	return nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func parsePublicKeys(rawSet, rawSingle string) (map[string]*ecdsa.PublicKey, error) {
	var keys []jose.JSONWebKey
	if strings.TrimSpace(rawSet) != "" {
		var set jose.JSONWebKeySet
		if err := json.Unmarshal([]byte(rawSet), &set); err != nil {
			return nil, errors.New("DISPATCH_SIGNING_PUBLIC_JWKS must be a JSON JWKS")
		}
		keys = set.Keys
	} else if strings.TrimSpace(rawSingle) != "" {
		var key jose.JSONWebKey
		if err := key.UnmarshalJSON([]byte(rawSingle)); err != nil {
			return nil, errors.New("DISPATCH_SIGNING_PUBLIC_JWK must be a JSON JWK")
		}
		keys = []jose.JSONWebKey{key}
	} else {
		return nil, errors.New("DISPATCH_SIGNING_PUBLIC_JWKS or DISPATCH_SIGNING_PUBLIC_JWK is required")
	}

	result := make(map[string]*ecdsa.PublicKey, len(keys))
	for _, key := range keys {
		public, ok := key.Key.(*ecdsa.PublicKey)
		if !ok || !key.IsPublic() || key.Algorithm != "ES256" || key.KeyID == "" {
			return nil, errors.New("each dispatch key must be a public ES256 JWK with kid")
		}
		if _, exists := result[key.KeyID]; exists {
			return nil, fmt.Errorf("dispatch JWKS contains duplicate kid %q", key.KeyID)
		}
		result[key.KeyID] = public
	}
	if len(result) == 0 {
		return nil, errors.New("dispatch JWKS must contain at least one key")
	}
	return result, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func dnsLabel(value string) bool {
	if len(value) == 0 || len(value) > 63 || !lowerAlphaNumeric(value[0]) {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	last := value[len(value)-1]
	return last != '-'
}

func lowerAlphaNumeric(character byte) bool {
	return character >= 'a' && character <= 'z' || character >= '0' && character <= '9'
}
