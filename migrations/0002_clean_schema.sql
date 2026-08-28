DROP INDEX IF EXISTS d_po_p_proofs_expiry;
ALTER TABLE d_po_p_proofs RENAME TO dpop_proofs;
CREATE INDEX IF NOT EXISTS dpop_proofs_expiry ON dpop_proofs(expires_at);
ALTER TABLE clusters DROP COLUMN ca_bundle;
ALTER TABLE clusters DROP COLUMN tls_server_name;
