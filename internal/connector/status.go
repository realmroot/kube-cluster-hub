package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

type statusPayload struct {
	ConnectorID       string   `json:"connectorId"`
	ClusterID         string   `json:"clusterId"`
	Version           string   `json:"version"`
	KubernetesVersion string   `json:"kubernetesVersion"`
	Capabilities      []string `json:"capabilities"`
	State             string   `json:"state"`
	LastError         string   `json:"lastError"`
}

func (c *Connector) ReportStatus(ctx context.Context) {
	report := func() {
		if err := c.reportStatus(ctx); err != nil && ctx.Err() == nil {
			log.Printf("Connector status report failed: %v", err)
		}
	}
	report()
	ticker := time.NewTicker(c.cfg.StatusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			report()
		}
	}
}

func (c *Connector) reportStatus(ctx context.Context) error {
	kubernetesVersion, versionErr := c.kubernetesVersion(ctx)
	state := "ready"
	lastError := ""
	if versionErr != nil {
		state = "degraded"
		lastError = versionErr.Error()
	}
	payload, err := json.Marshal(statusPayload{
		ConnectorID: c.cfg.ClusterID, ClusterID: c.cfg.ClusterID, Version: Version,
		KubernetesVersion: kubernetesVersion,
		Capabilities:      []string{"streaming", "websocket", "oidc-passthrough", "agent-impersonation", "cluster-inventory"},
		State:             state, LastError: lastError,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.cfg.ControlPlaneURL+"/api/connector-statuses/"+c.cfg.ClusterID, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.cfg.StatusToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("control plane returned %s", response.Status)
	}
	return nil
}

func (c *Connector) kubernetesVersion(ctx context.Context) (string, error) {
	token, err := c.serviceAccountToken()
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.APIServerURL+"/version", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := (&http.Client{Transport: c.transport, Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Kubernetes version returned %s", response.Status)
	}
	var version struct {
		GitVersion string `json:"gitVersion"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return "", err
	}
	if version.GitVersion == "" {
		return "", fmt.Errorf("Kubernetes version is empty")
	}
	return version.GitVersion, nil
}
