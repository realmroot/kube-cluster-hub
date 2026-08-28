import { afterEach, describe, expect, it } from 'vitest'
import { NodeDatabaseAdapter } from './database-node'
import { migrateNodeDatabase } from './migrate-node'

let database: NodeDatabaseAdapter | undefined

afterEach(() => database?.raw.close())

describe('Node database migration', () => {
  it('preserves safe legacy clusters and disables custom-CA clusters until a Connector is configured', () => {
    database = new NodeDatabaseAdapter(':memory:')
    database.raw.exec(`
      CREATE TABLE clusters (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL,
        api_server_url TEXT NOT NULL, ca_bundle TEXT NOT NULL, tls_server_name TEXT NOT NULL,
        prometheus_url TEXT NOT NULL, enabled INTEGER NOT NULL, is_default INTEGER NOT NULL,
        inventory_status TEXT NOT NULL, inventory_error TEXT NOT NULL,
        resource_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, request_id TEXT NOT NULL,
        token_id TEXT NOT NULL, principal_type TEXT NOT NULL, controller_subject TEXT NOT NULL,
        agent_issuer TEXT NOT NULL, agent_subject TEXT NOT NULL, user_subject TEXT NOT NULL,
        client_id TEXT NOT NULL, scopes TEXT NOT NULL, cluster_id TEXT NOT NULL, method TEXT NOT NULL,
        path TEXT NOT NULL, status INTEGER NOT NULL, duration_millis INTEGER NOT NULL
      );
      INSERT INTO clusters VALUES
        ('public', 'Public', '', 'https://api.example.test', '', '', '', 1, 0, 'published', '', 1, 'now', 'now'),
        ('private', 'Private', '', 'https://kubernetes.default.svc', 'PEM', '', '', 1, 0, 'published', '', 1, 'now', 'now');
      INSERT INTO audit_events VALUES
        (1, 'now', 'request', '', 'user', '', '', '', 'user', '', '', 'public', 'GET', '/', 0, 0);
    `)

    migrateNodeDatabase(database)

    const rows = database.raw
      .prepare(
        'SELECT id, access_mode, enabled, inventory_status FROM clusters ORDER BY id',
      )
      .all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      {
        id: 'private',
        access_mode: 'connector',
        enabled: 0,
        inventory_status: 'migration-required',
      },
      {
        id: 'public',
        access_mode: 'direct',
        enabled: 1,
        inventory_status: 'published',
      },
    ])
    expect(
      database.raw
        .prepare('SELECT status FROM audit_events WHERE id = 1')
        .get(),
    ).toEqual({ status: 499 })
  })
})
