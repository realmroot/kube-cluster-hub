package store

import "time"

type Cluster struct {
	ID              string    `json:"id" gorm:"primaryKey;type:varchar(63)"`
	DisplayName     string    `json:"displayName" gorm:"type:varchar(200);not null"`
	Description     string    `json:"description,omitempty" gorm:"type:text"`
	APIServerURL    string    `json:"apiServerUrl" gorm:"type:text;not null"`
	CABundle        string    `json:"caBundle,omitempty" gorm:"type:text"`
	TLSServerName   string    `json:"tlsServerName,omitempty" gorm:"type:varchar(255)"`
	PrometheusURL   string    `json:"prometheusUrl,omitempty" gorm:"type:text"`
	Enabled         bool      `json:"enabled" gorm:"not null;default:true"`
	Default         bool      `json:"default" gorm:"column:is_default;not null;default:false"`
	InventoryStatus string    `json:"inventoryStatus" gorm:"type:varchar(16);not null;default:pending"`
	InventoryError  string    `json:"inventoryError,omitempty" gorm:"type:text"`
	ResourceVersion uint64    `json:"resourceVersion" gorm:"not null;default:1"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type DPoPProof struct {
	ID            uint      `gorm:"primaryKey"`
	KeyThumbprint string    `gorm:"type:varchar(64);not null;uniqueIndex:idx_dpop_key_jti,priority:1"`
	JTI           string    `gorm:"type:varchar(255);not null;uniqueIndex:idx_dpop_key_jti,priority:2"`
	ExpiresAt     time.Time `gorm:"not null;index"`
	CreatedAt     time.Time `gorm:"not null"`
}

type AuditEvent struct {
	ID                uint64    `json:"id" gorm:"primaryKey;autoIncrement"`
	CreatedAt         time.Time `json:"createdAt" gorm:"not null;index"`
	RequestID         string    `json:"requestId" gorm:"type:varchar(255);not null;index"`
	TokenID           string    `json:"tokenId,omitempty" gorm:"type:varchar(255);index"`
	PrincipalType     string    `json:"principalType" gorm:"type:varchar(16);not null;index"`
	ControllerSubject string    `json:"controllerSubject,omitempty" gorm:"type:varchar(255);index"`
	AgentIssuer       string    `json:"agentIssuer,omitempty" gorm:"type:text"`
	AgentSubject      string    `json:"agentSubject,omitempty" gorm:"type:varchar(255);index"`
	UserSubject       string    `json:"userSubject,omitempty" gorm:"type:varchar(255);index"`
	ClientID          string    `json:"clientId,omitempty" gorm:"type:varchar(255)"`
	Scopes            string    `json:"scopes,omitempty" gorm:"type:text"`
	ClusterID         string    `json:"clusterId" gorm:"type:varchar(63);index"`
	Method            string    `json:"method" gorm:"type:varchar(10);not null"`
	Path              string    `json:"path" gorm:"type:text;not null"`
	Status            int       `json:"status" gorm:"not null"`
	DurationMillis    int64     `json:"durationMillis" gorm:"not null"`
}
