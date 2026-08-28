import type { Config } from './config'

export const apiVersion = '2026-08-28'
export const scopes = {
  clustersRead: 'clusters:read',
  kubernetesRead: 'kubernetes:read',
  kubernetesWrite: 'kubernetes:write',
  auditRead: 'audit-events:read',
} as const

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
    'accessMode',
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
      description: 'Required only in direct access mode',
    },
    prometheusUrl: { type: 'string', format: 'uri' },
    accessMode: { type: 'string', enum: ['direct', 'connector'] },
    connectorId: { type: 'string' },
    connectorUrl: { type: 'string', format: 'uri' },
    enabled: { type: 'boolean' },
    default: { type: 'boolean' },
    inventoryStatus: { type: 'string' },
    inventoryError: { type: 'string' },
    resourceVersion: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

export function catalogOpenApi(config: Config): object {
  return {
    openapi: '3.1.0',
    info: { title: 'Cluster Access Gateway Catalog API', version: apiVersion },
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
        AuditEvent: { type: 'object' },
        Problem: problem,
      },
    },
    paths: {
      '/clusters': {
        get: operation('listClusters', 'List clusters', [
          parameter('apiVersion'),
          parameter('pageSize'),
          parameter('pageToken'),
        ]),
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
        get: operation('getCluster', 'Get a cluster', [
          parameter('apiVersion'),
        ]),
        put: operation(
          'replaceCluster',
          'Create or replace a cluster',
          [parameter('apiVersion')],
          true,
        ),
        delete: operation('deleteCluster', 'Delete a cluster', [
          parameter('apiVersion'),
        ]),
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
        ),
      },
      '/connector-statuses/{connectorId}': {
        parameters: [
          {
            name: 'connectorId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: operation(
          'getConnectorStatus',
          'Get the latest Connector status',
          [parameter('apiVersion')],
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
      title: 'Cluster Access Gateway Agent API',
      version: apiVersion,
      description:
        'Discover clusters and invoke the canonical Kubernetes HTTP API with OAuth Agent authority.',
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
        AuditEvent: { type: 'object' },
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
): object {
  return {
    operationId,
    summary,
    ...(parameters.length ? { parameters } : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Cluster' },
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
