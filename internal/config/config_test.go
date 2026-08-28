package config

import (
	"strings"
	"testing"
	"time"
)

func TestValidateRejectsInvalidCatalogURLAndRetention(t *testing.T) {
	valid := Config{
		GatewayBaseURL: "https://gateway.example", CatalogBaseURL: "https://gateway.example/api/catalog",
		InventoryAccessURL: "https://gateway.example", OIDCIssuer: "https://issuer.example", OIDCAudience: "client",
		CatalogAdminGroups: []string{"admins"}, ResourceURL: "https://gateway.example/api/agent",
		ResourceIssuer: "https://issuer.example", ResourceAuthorizedApps: []string{"agent-client"}, AuditRetention: 24 * time.Hour,
	}
	invalidCatalog := valid
	invalidCatalog.CatalogBaseURL = "/api/catalog"
	if err := invalidCatalog.Validate(); err == nil || !strings.Contains(err.Error(), "GATEWAY_CATALOG_BASE_URL") {
		t.Fatalf("invalid catalog URL error = %v", err)
	}
	invalidRetention := valid
	invalidRetention.AuditRetention = 0
	if err := invalidRetention.Validate(); err == nil || !strings.Contains(err.Error(), "AUDIT_RETENTION") {
		t.Fatalf("invalid retention error = %v", err)
	}
}
