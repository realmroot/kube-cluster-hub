import { Hono } from 'hono'
import type { AppDependencies, Variables } from './app-dependencies'
import { apiVersion, hubOpenApi, hubScopes, scopes } from './contracts'
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
      resource: dependencies.config.apiUrl,
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

  app.get('/openapi.json', (context) =>
    openApi(context, hubOpenApi(dependencies.config)),
  )
  app.get('/.well-known/oauth-protected-resource/api', (context) =>
    context.json({
      resource: dependencies.config.apiUrl,
      authorization_servers: [dependencies.config.oidcIssuer],
      scopes_supported: hubScopes,
      bearer_methods_supported: ['header'],
      dpop_signing_alg_values_supported: ['ES256'],
    }),
  )

  serviceDescription(
    app,
    '/api',
    dependencies.config.apiUrl,
    `${dependencies.config.publicUrl}/openapi.json`,
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
