CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  api_server_url TEXT NOT NULL,
  prometheus_url TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX clusters_one_default ON clusters(is_default) WHERE is_default = TRUE;

CREATE TABLE dpop_proofs (
  key_thumbprint TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key_thumbprint, jti)
);

CREATE INDEX dpop_proofs_expiry ON dpop_proofs(expires_at);

CREATE TABLE audit_events (
  id SERIAL PRIMARY KEY,
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

CREATE INDEX audit_events_created ON audit_events(created_at);
CREATE INDEX audit_events_request ON audit_events(request_id);
