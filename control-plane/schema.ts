import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const clusters = sqliteTable(
  'clusters',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull().default(''),
    apiServerUrl: text('api_server_url').notNull(),
    prometheusUrl: text('prometheus_url').notNull().default(''),
    accessMode: text('access_mode', { enum: ['direct', 'connector'] })
      .notNull()
      .default('connector'),
    connectorId: text('connector_id').notNull().default(''),
    connectorUrl: text('connector_url').notNull().default(''),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    default: integer('is_default', { mode: 'boolean' })
      .notNull()
      .default(false),
    inventoryStatus: text('inventory_status').notNull().default('pending'),
    inventoryError: text('inventory_error').notNull().default(''),
    resourceVersion: integer('resource_version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('clusters_one_default')
      .on(table.default)
      .where(sql`${table.default} = 1`),
  ],
)

export const dpopProofs = sqliteTable(
  'dpop_proofs',
  {
    keyThumbprint: text('key_thumbprint').notNull(),
    jti: text('jti').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('dpop_proofs_identity').on(table.keyThumbprint, table.jti),
    index('dpop_proofs_expiry').on(table.expiresAt),
  ],
)

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: text('created_at').notNull(),
    requestId: text('request_id').notNull(),
    tokenId: text('token_id').notNull().default(''),
    principalType: text('principal_type', {
      enum: ['user', 'agent'],
    }).notNull(),
    controllerSubject: text('controller_subject').notNull().default(''),
    agentIssuer: text('agent_issuer').notNull().default(''),
    agentSubject: text('agent_subject').notNull().default(''),
    userSubject: text('user_subject').notNull().default(''),
    clientId: text('client_id').notNull().default(''),
    scopes: text('scopes').notNull().default(''),
    clusterId: text('cluster_id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    durationMillis: integer('duration_millis').notNull(),
  },
  (table) => [
    index('audit_events_created').on(table.createdAt),
    index('audit_events_request').on(table.requestId),
  ],
)

export const connectorStatuses = sqliteTable('connector_statuses', {
  connectorId: text('connector_id').primaryKey(),
  clusterId: text('cluster_id').notNull(),
  version: text('version').notNull(),
  kubernetesVersion: text('kubernetes_version').notNull().default(''),
  capabilities: text('capabilities', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  state: text('state', { enum: ['ready', 'degraded'] }).notNull(),
  lastError: text('last_error').notNull().default(''),
  observedAt: text('observed_at').notNull(),
})

export const schema = {
  clusters,
  dpopProofs,
  auditEvents,
  connectorStatuses,
}
