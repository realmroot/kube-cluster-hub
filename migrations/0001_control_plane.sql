CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  api_server_url TEXT NOT NULL,
  ca_bundle TEXT NOT NULL DEFAULT '',
  tls_server_name TEXT NOT NULL DEFAULT '',
  prometheus_url TEXT NOT NULL DEFAULT '',
  access_mode TEXT NOT NULL DEFAULT 'connector' CHECK (access_mode IN ('direct', 'connector')),
  connector_id TEXT NOT NULL DEFAULT '',
  connector_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  inventory_status TEXT NOT NULL DEFAULT 'pending',
  inventory_error TEXT NOT NULL DEFAULT '',
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS clusters_one_default
  ON clusters(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS d_po_p_proofs (
  key_thumbprint TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key_thumbprint, jti)
);

CREATE INDEX IF NOT EXISTS d_po_p_proofs_expiry ON d_po_p_proofs(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  token_id TEXT NOT NULL DEFAULT '',
  principal_type TEXT NOT NULL,
  controller_subject TEXT NOT NULL DEFAULT '',
  agent_issuer TEXT NOT NULL DEFAULT '',
  agent_subject TEXT NOT NULL DEFAULT '',
  user_subject TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  cluster_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_millis INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS audit_events_request ON audit_events(request_id);

CREATE TABLE IF NOT EXISTS connector_statuses (
  connector_id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  version TEXT NOT NULL,
  kubernetes_version TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL
);
