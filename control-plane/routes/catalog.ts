import type { AppDependencies, HubApp } from '../app-dependencies'
import { scopes } from '../contracts'
import { normalizeClusterInput, validateClusterId } from '../domain'
import {
  boundedJson,
  catalogVersion,
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
    const ifNoneMatch = context.req.header('If-None-Match')
    const cluster =
      ifNoneMatch === '*'
        ? await dependencies.store.createCluster(id, input)
        : await dependencies.store.replaceCluster(
            id,
            input,
            parseEtag(context.req.header('If-Match')),
          )
    context.header('ETag', etag(cluster.resourceVersion))
    return context.json(cluster, ifNoneMatch === '*' ? 201 : 200)
  })

  app.delete('/api/catalog/clusters/:clusterId', async (context) => {
    const user = await dependencies.catalogUsers.verify(
      context.req.header('Authorization'),
    )
    requireUserScope(user, scopes.clustersWrite)
    requireAdmin(user, dependencies.config)
    const id = context.req.param('clusterId')
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
}
