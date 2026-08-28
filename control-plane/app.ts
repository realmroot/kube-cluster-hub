import { Hono } from 'hono'
import type { AppDependencies, Variables } from './app-dependencies'
import {
  agentOpenApi,
  agentScopes,
  apiVersion,
  catalogOpenApi,
  catalogScopes,
  scopes,
} from './contracts'
import { installHttpBoundary, openApi } from './http'
import { registerAccessRoutes } from './routes/access'
import { registerCatalogRoutes } from './routes/catalog'

export type { AppDependencies } from './app-dependencies'

export function createApp(
  dependencies: AppDependencies,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>()
  installHttpBoundary(app)

  app.get('/healthz', (context) => context.body(null, 204))
  app.get('/readyz', async (context) => {
    await dependencies.store.listClusters('', 1)
    return context.body(null, 204)
  })
  app.get('/api/ui-config', (context) =>
    context.json({
      issuer: dependencies.config.oidcIssuer,
      clientId: dependencies.config.uiClientId,
      resource: dependencies.config.catalogUrl,
      scopes: [
        'openid',
        'profile',
        'email',
        scopes.clustersRead,
        scopes.clustersWrite,
        scopes.auditRead,
      ],
      apiVersion,
    }),
  )

  app.get('/openapi/catalog.json', (context) =>
    openApi(context, catalogOpenApi(dependencies.config)),
  )
  app.get('/openapi/agent.json', (context) =>
    openApi(context, agentOpenApi(dependencies.config)),
  )
  app.get('/.well-known/oauth-protected-resource/api/catalog', (context) =>
    context.json({
      resource: dependencies.config.catalogUrl,
      authorization_servers: [dependencies.config.oidcIssuer],
      scopes_supported: catalogScopes,
      bearer_methods_supported: ['header'],
    }),
  )
  app.get('/.well-known/oauth-protected-resource/api/agent', (context) =>
    context.json({
      resource: dependencies.config.resourceUrl,
      authorization_servers: [dependencies.config.resourceIssuer],
      scopes_supported: agentScopes,
      dpop_bound_access_tokens_required: true,
      dpop_signing_alg_values_supported: ['ES256'],
    }),
  )

  serviceDescription(
    app,
    '/api/catalog',
    dependencies.config.catalogUrl,
    `${dependencies.config.publicUrl}/openapi/catalog.json`,
  )
  serviceDescription(
    app,
    '/api/catalog/',
    dependencies.config.catalogUrl,
    `${dependencies.config.publicUrl}/openapi/catalog.json`,
  )
  serviceDescription(
    app,
    '/api/agent',
    dependencies.config.resourceUrl,
    `${dependencies.config.publicUrl}/openapi/agent.json`,
  )

  registerCatalogRoutes(app, dependencies)
  registerAccessRoutes(app, dependencies)
  return app
}

function serviceDescription(
  app: Hono<{ Variables: Variables }>,
  path: string,
  resource: string,
  document: string,
): void {
  app.get(path, (context) => {
    context.header(
      'Link',
      `<${document}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
    )
    return context.json({ resource, serviceDescription: document })
  })
}
