import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const pgClusters = pgTable(
  'clusters',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull().default(''),
    apiServerUrl: text('api_server_url').notNull(),
    prometheusUrl: text('prometheus_url').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    default: boolean('is_default').notNull().default(false),
    resourceVersion: integer('resource_version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('clusters_one_default')
      .on(table.default)
      .where(sql`${table.default} = true`),
  ],
)

export const pgDpopProofs = pgTable(
  'dpop_proofs',
  {
    keyThumbprint: text('key_thumbprint').notNull(),
    jti: text('jti').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyThumbprint, table.jti] }),
    index('dpop_proofs_expiry').on(table.expiresAt),
  ],
)

export const pgAuditEvents = pgTable(
  'audit_events',
  {
    id: serial('id').primaryKey(),
    createdAt: text('created_at').notNull(),
    requestId: text('request_id').notNull(),
    tokenId: text('token_id').notNull().default(''),
    principalType: text('principal_type').notNull(),
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
