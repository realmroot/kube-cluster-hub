import type { AppDependencies, HubApp } from '../app-dependencies'
import { AuthenticationError } from '../auth'
import { scopes } from '../contracts'
import {
  type ConnectorStatus,
  normalizeClusterInput,
  ValidationError,
  validateClusterId,
} from '../domain'
import {
  boundedJson,
  catalogVersion,
  constantTimeBearer,
  etag,
  parseEtag,
  requireAdmin,
  requireUserScope,
} from '../http'
import { auditPage, clusterPage } from './pages'

export function registerCatalogRoutes(
  app: HubApp,
  dependencies: AppDependencies,
): void {
  app.use('/api/catalog/clusters', catalogVersion)
  app.use('/api/catalog/clusters/*', catalogVersion)
  app.use('/api/catalog/audit-events', catalogVersion)
  app.use('/api/catalog/connector-statuses/*', catalogVersion)

  app.get('/api/catalog/clusters', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.clustersRead)
    return clusterPage(
      context,
      dependencies.store,
      `${dependencies.config.catalogUrl}/clusters`,
    )
  })

  app.get('/api/catalog/clusters/:clusterId', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.clustersRead)
    const cluster = await dependencies.store.getCluster(
      context.req.param('clusterId'),
    )
    context.header('ETag', etag(cluster.resourceVersion))
    return context.json(cluster)
  })

  app.put('/api/catalog/clusters/:clusterId', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.clustersWrite)
    requireAdmin(user, dependencies.config)
    const id = context.req.param('clusterId')
    validateClusterId(id)
    const input = normalizeClusterInput(await boundedJson(context.req.raw))
    if (input.accessMode === 'connector' && input.connectorId !== id)
      throw new ValidationError(
        'connectorId must equal the cluster id in one-Connector-per-cluster mode',
      )
    const ifNoneMatch = context.req.header('If-None-Match')
    const cluster =
      ifNoneMatch === '*'
        ? await dependencies.store.createCluster(id, input)
        : await dependencies.store.replaceCluster(
            id,
            input,
            parseEtag(context.req.header('If-Match')),
          )
    await dependencies.inventory.publishWithStatus(cluster)
    const published = await dependencies.store.getCluster(id)
    context.header('ETag', etag(published.resourceVersion))
    return context.json(published, ifNoneMatch === '*' ? 201 : 200)
  })

  app.delete('/api/catalog/clusters/:clusterId', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.clustersWrite)
    requireAdmin(user, dependencies.config)
    const id = context.req.param('clusterId')
    await dependencies.inventory.delete(id)
    await dependencies.store.deleteCluster(
      id,
      parseEtag(context.req.header('If-Match')),
    )
    return context.body(null, 204)
  })

  app.get('/api/catalog/audit-events', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.auditRead)
    requireAdmin(user, dependencies.config)
    return auditPage(
      context,
      dependencies.store,
      `${dependencies.config.catalogUrl}/audit-events`,
    )
  })

  app.get('/api/catalog/connector-statuses/:connectorId', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.clustersRead)
    requireAdmin(user, dependencies.config)
    return context.json(
      await dependencies.store.getConnectorStatus(
        context.req.param('connectorId'),
      ),
    )
  })

  app.put('/api/connector-statuses/:connectorId', async (context) => {
    if (
      !(await constantTimeBearer(
        context.req.header('Authorization'),
        dependencies.config.connectorStatusToken,
      ))
    )
      throw new AuthenticationError(
        'invalid_token',
        'Connector status credential is invalid',
      )
    const connectorId = context.req.param('connectorId')
    validateClusterId(connectorId)
    const status = connectorStatus(
      connectorId,
      await boundedJson(context.req.raw),
    )
    await dependencies.store.putConnectorStatus(status)
    return context.json(status)
  })
}

function connectorStatus(connectorId: string, raw: unknown): ConnectorStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ValidationError('status body must be an object')
  const value = raw as Record<string, unknown>
  if (
    value.connectorId !== connectorId ||
    typeof value.clusterId !== 'string' ||
    typeof value.version !== 'string'
  )
    throw new ValidationError('connector status identity is invalid')
  validateClusterId(value.clusterId)
  if (value.clusterId !== connectorId)
    throw new ValidationError('connectorId and clusterId must match')
  if (value.state !== 'ready' && value.state !== 'degraded')
    throw new ValidationError('connector state is invalid')
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((item) => typeof item !== 'string')
  )
    throw new ValidationError('connector capabilities are invalid')
  return {
    connectorId,
    clusterId: value.clusterId,
    version: value.version,
    kubernetesVersion:
      typeof value.kubernetesVersion === 'string'
        ? value.kubernetesVersion
        : '',
    capabilities: value.capabilities as string[],
    state: value.state,
    lastError: typeof value.lastError === 'string' ? value.lastError : '',
    observedAt: new Date().toISOString(),
  }
}
