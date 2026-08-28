import { and, asc, desc, eq, gt, lt, ne, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditEvent, Cluster, ClusterInput } from './domain'
import { ConflictError, NotFoundError } from './domain'
import { pgAuditEvents, pgClusters, pgDpopProofs } from './schema-postgres'
import type { HubStore } from './store'

type PostgresDatabase = PostgresJsDatabase<{
  pgClusters: typeof pgClusters
  pgDpopProofs: typeof pgDpopProofs
  pgAuditEvents: typeof pgAuditEvents
}>

export class PostgresStore implements HubStore {
  constructor(private readonly database: PostgresDatabase) {}

  async listClusters(after: string, limit: number): Promise<Cluster[]> {
    return this.database
      .select()
      .from(pgClusters)
      .where(gt(pgClusters.id, after))
      .orderBy(asc(pgClusters.id))
      .limit(limit)
  }

  async getCluster(id: string): Promise<Cluster> {
    const [row] = await this.database
      .select()
      .from(pgClusters)
      .where(eq(pgClusters.id, id))
      .limit(1)
    if (!row) throw new NotFoundError('cluster not found')
    return row
  }

  async createCluster(id: string, input: ClusterInput): Promise<Cluster> {
    const now = new Date().toISOString()
    const record = {
      id,
      ...input,
      resourceVersion: 1,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.database.transaction(async (transaction) => {
        if (input.default)
          await transaction
            .update(pgClusters)
            .set({ default: false })
            .where(eq(pgClusters.default, true))
        await transaction.insert(pgClusters).values(record)
      })
    } catch (error) {
      if (await this.exists(id))
        throw new ConflictError('cluster already exists')
      throw error
    }
    return this.getCluster(id)
  }

  async replaceCluster(
    id: string,
    input: ClusterInput,
    expectedVersion: number,
  ): Promise<Cluster> {
    let rows: Array<{ id: string }> = []
    await this.database.transaction(async (transaction) => {
      if (input.default)
        await transaction
          .update(pgClusters)
          .set({ default: false })
          .where(and(ne(pgClusters.id, id), eq(pgClusters.default, true)))
      rows = await transaction
        .update(pgClusters)
        .set({
          ...input,
          resourceVersion: sql`${pgClusters.resourceVersion} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(pgClusters.id, id),
            eq(pgClusters.resourceVersion, expectedVersion),
          ),
        )
        .returning({ id: pgClusters.id })
    })
    if (rows.length !== 1) await this.throwMissingOrConflict(id)
    return this.getCluster(id)
  }

  async deleteCluster(id: string, expectedVersion: number): Promise<void> {
    const rows = await this.database
      .delete(pgClusters)
      .where(
        and(
          eq(pgClusters.id, id),
          eq(pgClusters.resourceVersion, expectedVersion),
        ),
      )
      .returning({ id: pgClusters.id })
    if (rows.length !== 1) await this.throwMissingOrConflict(id)
  }

  async consumeDpopProof(
    thumbprint: string,
    jti: string,
    expiresAt: Date,
  ): Promise<void> {
    const now = new Date().toISOString()
    try {
      await this.database.transaction(async (transaction) => {
        await transaction
          .delete(pgDpopProofs)
          .where(lt(pgDpopProofs.expiresAt, now))
        await transaction.insert(pgDpopProofs).values({
          keyThumbprint: thumbprint,
          jti,
          expiresAt: expiresAt.toISOString(),
          createdAt: now,
        })
      })
    } catch (error) {
      const [existing] = await this.database
        .select({ jti: pgDpopProofs.jti })
        .from(pgDpopProofs)
        .where(
          and(
            eq(pgDpopProofs.keyThumbprint, thumbprint),
            eq(pgDpopProofs.jti, jti),
          ),
        )
        .limit(1)
      if (existing) throw new ConflictError('DPoP proof was already used')
      throw error
    }
  }

  async appendAudit(
    event: Omit<AuditEvent, 'id' | 'createdAt'>,
  ): Promise<void> {
    await this.database.insert(pgAuditEvents).values({
      ...event,
      createdAt: new Date().toISOString(),
    })
  }

  async listAuditEvents(
    beforeId: number | undefined,
    limit: number,
  ): Promise<AuditEvent[]> {
    const rows = await this.database
      .select()
      .from(pgAuditEvents)
      .where(
        beforeId === undefined ? undefined : lt(pgAuditEvents.id, beforeId),
      )
      .orderBy(desc(pgAuditEvents.id))
      .limit(limit)
    return rows.map((row) => ({
      ...row,
      principalType: row.principalType as AuditEvent['principalType'],
    }))
  }

  async pruneAudit(before: Date): Promise<number> {
    const rows = await this.database
      .delete(pgAuditEvents)
      .where(lt(pgAuditEvents.createdAt, before.toISOString()))
      .returning({ id: pgAuditEvents.id })
    return rows.length
  }

  private async exists(id: string): Promise<boolean> {
    const [row] = await this.database
      .select({ id: pgClusters.id })
      .from(pgClusters)
      .where(eq(pgClusters.id, id))
      .limit(1)
    return Boolean(row)
  }

  private async throwMissingOrConflict(id: string): Promise<never> {
    if (!(await this.exists(id))) throw new NotFoundError('cluster not found')
    throw new ConflictError('cluster resource version does not match')
  }
}
