import type { Config } from './config'

export const apiVersion = '2026-08-28'
export const scopes = {
  clustersRead: 'clusters:read',
  clustersWrite: 'clusters:write',
  kubernetesRead: 'kubernetes:read',
  kubernetesWrite: 'kubernetes:write',
  auditRead: 'audit-events:read',
} as const

export const catalogScopes = [
  scopes.clustersRead,
  scopes.clustersWrite,
  scopes.auditRead,
] as const

export const agentScopes = [
  scopes.clustersRead,
  scopes.kubernetesRead,
  scopes.kubernetesWrite,
  scopes.auditRead,
] as const

export function kubernetesScope(method: string, uri: string): string {
  const pathname = uri.split('?', 1)[0] || '/'
  const mutatingSubresource = /\/(exec|attach|portforward)$/.test(pathname)
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) && !mutatingSubresource
    ? scopes.kubernetesRead
    : scopes.kubernetesWrite
}

const problem = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail'],
  properties: {
    type: { type: 'string', format: 'uri-reference' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    requestId: { type: 'string' },
  },
}

const cluster = {
  type: 'object',
  required: [
    'id',
    'displayName',
    'apiServerUrl',
    'enabled',
    'default',
    'resourceVersion',
  ],
  properties: {
    id: { type: 'string' },
    displayName: { type: 'string' },
    description: { type: 'string' },
    apiServerUrl: {
      type: 'string',
      format: 'uri',
      description: 'Kubernetes API endpoint reachable by the Hub runtime',
    },
    prometheusUrl: { type: 'string', format: 'uri' },
    enabled: { type: 'boolean' },
    default: { type: 'boolean' },
    resourceVersion: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const clusterInput = {
  type: 'object',
  additionalProperties: false,
  required: ['displayName', 'apiServerUrl', 'enabled', 'default'],
  properties: {
    displayName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    apiServerUrl: { type: 'string', format: 'uri' },
    prometheusUrl: { type: 'string', format: 'uri' },
    enabled: { type: 'boolean' },
    default: { type: 'boolean' },
  },
}

const auditEvent = {
  type: 'object',
  required: [
    'id',
    'createdAt',
    'requestId',
    'principalType',
    'clusterId',
    'method',
    'path',
    'status',
    'durationMillis',
  ],
  properties: {
    id: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    requestId: { type: 'string' },
    tokenId: { type: 'string' },
    principalType: { type: 'string', enum: ['user', 'agent'] },
    controllerSubject: { type: 'string' },
    agentIssuer: { type: 'string' },
    agentSubject: { type: 'string' },
    userSubject: { type: 'string' },
    clientId: { type: 'string' },
    scopes: { type: 'string' },
    clusterId: { type: 'string' },
    method: { type: 'string' },
    path: { type: 'string' },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    durationMillis: { type: 'integer', minimum: 0 },
  },
}

export function catalogOpenApi(config: Config): object {
  return {
    openapi: '3.1.0',
    info: { title: 'Kube Cluster Hub Catalog API', version: apiVersion },
    servers: [{ url: config.catalogUrl }],
    security: [{ oidc: [] }],
    components: {
      securitySchemes: {
        oidc: {
          type: 'openIdConnect',
          openIdConnectUrl: `${config.oidcIssuer}/.well-known/openid-configuration`,
        },
      },
      parameters: {
        apiVersion: {
          name: 'API-Version',
          in: 'header',
          required: true,
          schema: { type: 'string', enum: [apiVersion] },
        },
        requestId: {
          name: 'Request-Id',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        },
        pageSize: {
          name: 'pageSize',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        pageToken: {
          name: 'pageToken',
          in: 'query',
          schema: { type: 'string' },
        },
      },
      schemas: {
        Cluster: cluster,
        ClusterInput: clusterInput,
        AuditEvent: auditEvent,
        Problem: problem,
      },
    },
    paths: {
      '/clusters': {
        get: operation(
          'listClusters',
          'List clusters',
          [
            parameter('apiVersion'),
            parameter('pageSize'),
            parameter('pageToken'),
          ],
          false,
          scopes.clustersRead,
        ),
      },
      '/clusters/{clusterId}': {
        parameters: [
          {
            name: 'clusterId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: operation(
          'getCluster',
          'Get a cluster',
          [parameter('apiVersion')],
          false,
          scopes.clustersRead,
        ),
        put: operation(
          'replaceCluster',
          'Create or replace a cluster',
          [parameter('apiVersion')],
          true,
          scopes.clustersWrite,
        ),
        delete: operation(
          'deleteCluster',
          'Delete a cluster',
          [parameter('apiVersion')],
          false,
          scopes.clustersWrite,
        ),
      },
      '/audit-events': {
        get: operation(
          'listAuditEvents',
          'List immutable access audit events',
          [
            parameter('apiVersion'),
            parameter('pageSize'),
            parameter('pageToken'),
          ],
          false,
          scopes.auditRead,
        ),
      },
    },
  }
}

export function agentOpenApi(config: Config): object {
  const oauth = (scope: string) => [{ oauth: [scope] }]
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kube Cluster Hub Agent API',
      version: apiVersion,
      description:
        'Discover clusters and invoke the canonical Kubernetes HTTP API with a DPoP-bound Realmroot Resource Server token. The original token is forwarded and Kubernetes independently validates its accepted audience and RBAC.',
    },
    servers: [{ url: config.resourceUrl }],
    components: {
      securitySchemes: {
        oauth: {
          type: 'openIdConnect',
          openIdConnectUrl: `${config.resourceIssuer}/.well-known/openid-configuration`,
          'x-dpop-required': true,
        },
      },
      schemas: {
        Cluster: cluster,
        AuditEvent: auditEvent,
        Problem: problem,
      },
    },
    paths: {
      '/clusters': {
        get: {
          ...operation('listClusters', 'List clusters'),
          security: oauth(scopes.clustersRead),
        },
      },
      '/audit-events': {
        get: {
          ...operation(
            'listAuditEvents',
            'List Agent-attributed access audit events',
          ),
          security: oauth(scopes.auditRead),
        },
      },
      '/clusters/{clusterId}/kubernetes/{kubernetesPath}': {
        parameters: [
          {
            name: 'clusterId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'kubernetesPath',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: kubernetesOperation(
          'getKubernetesResource',
          scopes.kubernetesRead,
        ),
        post: kubernetesOperation(
          'createKubernetesResource',
          scopes.kubernetesWrite,
          true,
        ),
        put: kubernetesOperation(
          'replaceKubernetesResource',
          scopes.kubernetesWrite,
          true,
        ),
        patch: kubernetesOperation(
          'updateKubernetesResource',
          scopes.kubernetesWrite,
          true,
        ),
        delete: kubernetesOperation(
          'deleteKubernetesResource',
          scopes.kubernetesWrite,
        ),
      },
    },
  }
}

function parameter(name: string): object {
  return { $ref: `#/components/parameters/${name}` }
}

function operation(
  operationId: string,
  summary: string,
  parameters: object[] = [],
  body = false,
  scope?: string,
): object {
  return {
    operationId,
    summary,
    ...(scope ? { security: [{ oidc: [scope] }] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ClusterInput' },
              },
            },
          },
        }
      : {}),
    responses: {
      '200': { description: 'Success' },
      '400': { description: 'Invalid request' },
      '401': { description: 'Authentication required' },
      '403': { description: 'Forbidden' },
      '412': { description: 'Precondition failed' },
    },
  }
}

function kubernetesOperation(
  operationId: string,
  scope: string,
  body = false,
): object {
  return {
    operationId,
    summary: 'Invoke the Kubernetes API',
    security: [{ oauth: [scope] }],
    parameters: kubernetesQueryParameters(),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: {} },
              'application/yaml': { schema: { type: 'string' } },
              'application/merge-patch+json': { schema: {} },
              'application/json-patch+json': { schema: {} },
            },
          },
        }
      : {}),
    responses: {
      '200': { description: 'Kubernetes response' },
      default: { description: 'Kubernetes response or gateway problem' },
    },
  }
}

function kubernetesQueryParameters(): object[] {
  const query = (name: string, schema: object) => ({
    name,
    in: 'query',
    required: false,
    schema,
  })
  return [
    query('labelSelector', { type: 'string' }),
    query('fieldSelector', { type: 'string' }),
    query('limit', { type: 'integer', minimum: 1 }),
    query('continue', { type: 'string' }),
    query('resourceVersion', { type: 'string' }),
    query('resourceVersionMatch', {
      type: 'string',
      enum: ['Exact', 'NotOlderThan'],
    }),
    query('watch', { type: 'boolean' }),
    query('allowWatchBookmarks', { type: 'boolean' }),
    query('sendInitialEvents', { type: 'boolean' }),
    query('timeoutSeconds', { type: 'integer', minimum: 1 }),
    query('container', { type: 'string' }),
    query('follow', { type: 'boolean' }),
    query('previous', { type: 'boolean' }),
    query('sinceSeconds', { type: 'integer', minimum: 1 }),
    query('tailLines', { type: 'integer', minimum: 0 }),
    query('timestamps', { type: 'boolean' }),
    query('pretty', { type: 'string' }),
    query('dryRun', { type: 'string' }),
    query('fieldManager', { type: 'string' }),
    query('fieldValidation', {
      type: 'string',
      enum: ['Ignore', 'Warn', 'Strict'],
    }),
    query('force', { type: 'boolean' }),
    query('gracePeriodSeconds', { type: 'integer', minimum: 0 }),
    query('propagationPolicy', {
      type: 'string',
      enum: ['Orphan', 'Background', 'Foreground'],
    }),
  ]
}
