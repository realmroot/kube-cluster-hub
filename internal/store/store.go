package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrNotFound = errors.New("resource not found")
var ErrConflict = errors.New("resource conflict")

type Store struct{ db *gorm.DB }

func Open(dsn string) (*Store, error) {
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := db.AutoMigrate(&Cluster{}, &DPoPProof{}, &AuditEvent{}); err != nil {
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) CreateCluster(ctx context.Context, cluster *Cluster) error {
	cluster.ResourceVersion = 1
	cluster.InventoryStatus = "pending"
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if cluster.Default {
			if err := clearDefaultClusters(tx, cluster.ID); err != nil {
				return err
			}
		}
		return classify(tx.Create(cluster).Error)
	})
}

func (s *Store) Cluster(ctx context.Context, id string) (*Cluster, error) {
	var cluster Cluster
	if err := s.db.WithContext(ctx).First(&cluster, "id = ?", id).Error; err != nil {
		return nil, classify(err)
	}
	return &cluster, nil
}

func (s *Store) Clusters(ctx context.Context, after string, limit int) ([]Cluster, error) {
	query := s.db.WithContext(ctx).Order("id ASC").Limit(limit)
	if after != "" {
		query = query.Where("id > ?", after)
	}
	var clusters []Cluster
	if err := query.Find(&clusters).Error; err != nil {
		return nil, err
	}
	return clusters, nil
}

func (s *Store) ReplaceCluster(ctx context.Context, replacement *Cluster, expected uint64) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current Cluster
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current, "id = ?", replacement.ID).Error; err != nil {
			return classify(err)
		}
		if current.ResourceVersion != expected {
			return ErrConflict
		}
		replacement.CreatedAt = current.CreatedAt
		replacement.ResourceVersion = current.ResourceVersion + 1
		replacement.InventoryStatus = "pending"
		replacement.InventoryError = ""
		if replacement.Default {
			if err := clearDefaultClusters(tx, replacement.ID); err != nil {
				return err
			}
		}
		return tx.Save(replacement).Error
	})
}

func (s *Store) SetInventoryPublication(ctx context.Context, id, status, message string) error {
	return s.db.WithContext(ctx).Model(&Cluster{}).Where("id = ?", id).Updates(map[string]any{
		"inventory_status": status, "inventory_error": message,
	}).Error
}

func (s *Store) DeleteCluster(ctx context.Context, id string, expected uint64) error {
	result := s.db.WithContext(ctx).Where("id = ? AND resource_version = ?", id, expected).Delete(&Cluster{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		if _, err := s.Cluster(ctx, id); errors.Is(err, ErrNotFound) {
			return ErrNotFound
		}
		return ErrConflict
	}
	return nil
}

func (s *Store) AppendAudit(ctx context.Context, event *AuditEvent) error {
	return s.db.WithContext(ctx).Create(event).Error
}

func (s *Store) FinishAudit(ctx context.Context, id uint64, status int, duration time.Duration) error {
	return s.db.WithContext(ctx).Model(&AuditEvent{}).Where("id = ?", id).Updates(map[string]any{
		"status": status, "duration_millis": duration.Milliseconds(),
	}).Error
}

func (s *Store) FinalizeAbandonedAudit(ctx context.Context) (int64, error) {
	result := s.db.WithContext(ctx).Model(&AuditEvent{}).Where("status = 0").Update("status", 499)
	return result.RowsAffected, result.Error
}

func (s *Store) AuditEvents(ctx context.Context, after uint64, limit int) ([]AuditEvent, error) {
	query := s.db.WithContext(ctx).Order("id DESC").Limit(limit)
	if after != 0 {
		query = query.Where("id < ?", after)
	}
	var events []AuditEvent
	if err := query.Find(&events).Error; err != nil {
		return nil, err
	}
	return events, nil
}

func (s *Store) PruneAuditBefore(ctx context.Context, cutoff time.Time) (int64, error) {
	result := s.db.WithContext(ctx).Where("created_at < ?", cutoff.UTC()).Delete(&AuditEvent{})
	return result.RowsAffected, result.Error
}

func (s *Store) Ready(ctx context.Context) error {
	database, err := s.db.DB()
	if err != nil {
		return err
	}
	return database.PingContext(ctx)
}

func (s *Store) ConsumeProof(ctx context.Context, thumbprint, jti string, expiresAt time.Time) error {
	now := time.Now().UTC()
	if err := s.db.WithContext(ctx).Where("expires_at <= ?", now).Delete(&DPoPProof{}).Error; err != nil {
		return err
	}
	proof := DPoPProof{KeyThumbprint: thumbprint, JTI: jti, ExpiresAt: expiresAt.UTC(), CreatedAt: now}
	if err := s.db.WithContext(ctx).Create(&proof).Error; err == nil {
		return nil
	}
	var count int64
	if err := s.db.WithContext(ctx).Model(&DPoPProof{}).Where("key_thumbprint = ? AND jti = ?", thumbprint, jti).Count(&count).Error; err != nil {
		return err
	}
	if count != 0 {
		return ErrConflict
	}
	return errors.New("store DPoP proof")
}

func classify(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	if err != nil && (errors.Is(err, gorm.ErrDuplicatedKey) || errors.Is(err, gorm.ErrForeignKeyViolated)) {
		return ErrConflict
	}
	return err
}

func clearDefaultClusters(tx *gorm.DB, exceptID string) error {
	return tx.Model(&Cluster{}).Where("id <> ? AND is_default = ?", exceptID, true).Updates(map[string]any{
		"is_default": false, "resource_version": gorm.Expr("resource_version + 1"), "inventory_status": "pending",
	}).Error
}
