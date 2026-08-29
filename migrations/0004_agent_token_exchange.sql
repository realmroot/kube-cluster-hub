ALTER TABLE audit_events ADD COLUMN exchange_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE audit_events ADD COLUMN target_audience TEXT NOT NULL DEFAULT '';
