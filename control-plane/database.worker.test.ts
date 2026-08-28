/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { D1DatabaseAdapter } from './database-d1'
import { normalizeClusterInput } from './domain'
import { Store } from './store'

beforeEach(async () => {
  await env.DB.batch(
    [
      'DROP TABLE IF EXISTS audit_events',
      'DROP TABLE IF EXISTS dpop_proofs',
      'DROP TABLE IF EXISTS d_po_p_proofs',
      'DROP TABLE IF EXISTS clusters',
      `CREATE TABLE clusters (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      api_server_url TEXT NOT NULL, prometheus_url TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      resource_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
      'CREATE TABLE dpop_proofs (key_thumbprint TEXT NOT NULL, jti TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (key_thumbprint, jti))',
      "CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, request_id TEXT NOT NULL, token_id TEXT NOT NULL DEFAULT '', principal_type TEXT NOT NULL, controller_subject TEXT NOT NULL DEFAULT '', agent_issuer TEXT NOT NULL DEFAULT '', agent_subject TEXT NOT NULL DEFAULT '', user_subject TEXT NOT NULL DEFAULT '', client_id TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '', cluster_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, duration_millis INTEGER NOT NULL)",
    ].map((query) => env.DB.prepare(query)),
  )
})

describe('D1 persistence adapter', () => {
  it('uses the same Drizzle store contract as the Node runtime', async () => {
    const store = new Store(new D1DatabaseAdapter(env.DB).orm)
    const created = await store.createCluster(
      'local-kind',
      normalizeClusterInput({
        displayName: 'Local kind',
        apiServerUrl: 'https://kubernetes.example.test',
        default: true,
      }),
    )
    expect(created.id).toBe('local-kind')
    expect(created.default).toBe(true)
    expect(created.apiServerUrl).toBe('https://kubernetes.example.test')
  })
})
