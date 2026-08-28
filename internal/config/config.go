package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	Address                 string
	DatabaseDSN             string
	CatalogBaseURL          string
	GatewayBaseURL          string
	InventoryAccessURL      string
	InventoryNamespace      string
	InventoryKubeconfig     string
	OIDCIssuer              string
	OIDCAudience            string
	OIDCGroupsClaim         string
	CatalogAdminGroups      []string
	ResourceURL             string
	ResourceIssuer          string
	ResourceAuthorizedApps  []string
	ResourceSigningAlgs     []string
	AgentReadGroup          string
	AgentWriteGroup         string
	ServiceAccountTokenFile string
	AuditRetention          time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		Address:                 env("GATEWAY_ADDRESS", ":8080"),
		DatabaseDSN:             env("GATEWAY_DATABASE_DSN", "gateway.db"),
		CatalogBaseURL:          strings.TrimRight(os.Getenv("GATEWAY_CATALOG_BASE_URL"), "/"),
		GatewayBaseURL:          strings.TrimRight(os.Getenv("GATEWAY_PUBLIC_URL"), "/"),
		InventoryAccessURL:      strings.TrimRight(os.Getenv("GATEWAY_INVENTORY_ACCESS_URL"), "/"),
		InventoryNamespace:      env("GATEWAY_INVENTORY_NAMESPACE", "cluster-inventory"),
		InventoryKubeconfig:     strings.TrimSpace(os.Getenv("GATEWAY_INVENTORY_KUBECONFIG")),
		OIDCIssuer:              strings.TrimRight(os.Getenv("OIDC_ISSUER"), "/"),
		OIDCAudience:            strings.TrimSpace(os.Getenv("OIDC_AUDIENCE")),
		OIDCGroupsClaim:         env("OIDC_GROUPS_CLAIM", "groups"),
		CatalogAdminGroups:      split(os.Getenv("CATALOG_ADMIN_GROUPS")),
		ResourceURL:             strings.TrimRight(os.Getenv("RESOURCE_SERVER_URL"), "/"),
		ResourceIssuer:          strings.TrimRight(os.Getenv("RESOURCE_SERVER_ISSUER"), "/"),
		ResourceAuthorizedApps:  split(os.Getenv("RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS")),
		ResourceSigningAlgs:     splitDefault(os.Getenv("RESOURCE_SERVER_JWT_ALGORITHMS"), []string{"RS256"}),
		AgentReadGroup:          env("KUBERNETES_AGENT_READ_GROUP", "cluster-access:agents:read"),
		AgentWriteGroup:         env("KUBERNETES_AGENT_WRITE_GROUP", "cluster-access:agents:write"),
		ServiceAccountTokenFile: env("KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
		AuditRetention:          90 * 24 * time.Hour,
	}
	if cfg.CatalogBaseURL == "" {
		cfg.CatalogBaseURL = cfg.GatewayBaseURL + "/api/catalog"
	}
	if cfg.InventoryAccessURL == "" {
		cfg.InventoryAccessURL = cfg.GatewayBaseURL
	}
	if raw := strings.TrimSpace(os.Getenv("AUDIT_RETENTION")); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("AUDIT_RETENTION: %w", err)
		}
		cfg.AuditRetention = value
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.GatewayBaseURL == "" {
		return errors.New("GATEWAY_PUBLIC_URL is required")
	}
	if err := absoluteHTTPURL(c.GatewayBaseURL); err != nil {
		return fmt.Errorf("GATEWAY_PUBLIC_URL: %w", err)
	}
	if err := absoluteHTTPURL(c.InventoryAccessURL); err != nil {
		return fmt.Errorf("GATEWAY_INVENTORY_ACCESS_URL: %w", err)
	}
	if err := absoluteHTTPURL(c.CatalogBaseURL); err != nil {
		return fmt.Errorf("GATEWAY_CATALOG_BASE_URL: %w", err)
	}
	if c.OIDCIssuer == "" || c.OIDCAudience == "" {
		return errors.New("OIDC_ISSUER and OIDC_AUDIENCE are required")
	}
	if len(c.CatalogAdminGroups) == 0 {
		return errors.New("CATALOG_ADMIN_GROUPS is required")
	}
	if c.ResourceURL == "" || c.ResourceIssuer == "" || len(c.ResourceAuthorizedApps) == 0 {
		return errors.New("RESOURCE_SERVER_URL, RESOURCE_SERVER_ISSUER, and RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS are required")
	}
	if err := absoluteHTTPURL(c.ResourceURL); err != nil {
		return fmt.Errorf("RESOURCE_SERVER_URL: %w", err)
	}
	if c.AuditRetention <= 0 {
		return errors.New("AUDIT_RETENTION must be greater than zero")
	}
	return nil
}

func absoluteHTTPURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return errors.New("must be an absolute HTTP(S) URL")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("must not contain query or fragment")
	}
	return nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func split(value string) []string {
	result := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func splitDefault(value string, fallback []string) []string {
	if result := split(value); len(result) != 0 {
		return result
	}
	return append([]string(nil), fallback...)
}
