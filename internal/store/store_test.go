package store

import (
	"context"
	"testing"
	"time"
)

func TestPruneAuditBefore(t *testing.T) {
	database, err := Open("file:store-retention-test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	old := AuditEvent{PrincipalType: "user", CreatedAt: time.Now().UTC().Add(-48 * time.Hour)}
	recent := AuditEvent{PrincipalType: "agent", CreatedAt: time.Now().UTC()}
	if err := database.AppendAudit(context.Background(), &old); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendAudit(context.Background(), &recent); err != nil {
		t.Fatal(err)
	}
	count, err := database.PruneAuditBefore(context.Background(), time.Now().UTC().Add(-24*time.Hour))
	if err != nil || count != 1 {
		t.Fatalf("prune = count %d, error %v", count, err)
	}
	items, err := database.AuditEvents(context.Background(), 0, 10)
	if err != nil || len(items) != 1 || items[0].PrincipalType != "agent" {
		t.Fatalf("remaining audit events = %#v, error %v", items, err)
	}
	finalized, err := database.FinalizeAbandonedAudit(context.Background())
	if err != nil || finalized != 1 {
		t.Fatalf("finalize abandoned = count %d, error %v", finalized, err)
	}
	items, err = database.AuditEvents(context.Background(), 0, 10)
	if err != nil || items[0].Status != 499 {
		t.Fatalf("finalized audit events = %#v, error %v", items, err)
	}
}
