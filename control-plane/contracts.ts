import type { Config } from './config'

export const apiVersion = '2026-08-29'
export const scopes = {
  clustersRead: 'clusters:read',
  clustersWrite: 'clusters:write',
  kubernetesRead: 'kubernetes:read',
  kubernetesWrite: 'kubernetes:write',
  auditRead: 'audit-events:read',
} as const

export const hubScopes = [
  scopes.clustersRead,
  scopes.clustersWrite,
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

export function hubOpenApi(config: Config): object {
  const userSecurity = (scope: string) => [{ userOAuth: [scope] }]
  const agentSecurity = (scope: string) => [{ agentOAuth: [scope] }]
  const userOrAgentSecurity = (scope: string) => [
    ...userSecurity(scope),
    ...agentSecurity(scope),
  ]
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kube Cluster Hub API',
      version: apiVersion,
      description:
        'A self-hosted cluster catalog and Kubernetes access Resource Server. Kubernetes remains the resource authorization authority.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: config.apiUrl }],
    tags: [
      {
        name: 'Cluster catalog',
        description: 'Credential-free Kubernetes cluster directory resources.',
      },
      {
        name: 'Access audit',
        description: 'Immutable user and Agent access events.',
      },
      {
        name: 'Kubernetes access',
        description: 'Kubernetes API operations authorized by Kubernetes RBAC.',
      },
    ],
    components: {
      securitySchemes: {
        userOAuth: {
          type: 'openIdConnect',
          openIdConnectUrl: `${config.oidcIssuer}/.well-known/openid-configuration`,
          description: 'Bearer access token for a human controller.',
        },
        agentOAuth: {
          type: 'openIdConnect',
          openIdConnectUrl: `${config.oidcIssuer}/.well-known/openid-configuration`,
          description: 'DPoP-bound access token for a Realmroot Agent.',
          'x-dpop-required': true,
        },
      },
      parameters: {
        apiVersion: {
          name: 'API-Version',
          in: 'header',
          required: true,
          schema: { type: 'string', enum: [apiVersion] },
        },
        clusterId: {
          name: 'clusterId',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            pattern: '^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$',
          },
        },
        ifMatch: {
          name: 'If-Match',
          in: 'header',
          required: true,
          description: 'Current cluster ETag for replacement or deletion.',
          schema: { type: 'string', pattern: '^"[1-9][0-9]*"$' },
        },
        pageSize: {
          name: 'pageSize',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        pageToken: {
          name: 'pageToken',
          in: 'query',
          required: false,
          schema: { type: 'string', minLength: 1 },
        },
      },
      headers: {
        apiVersion: {
          description: 'Selected contract version.',
          schema: { type: 'string', enum: [apiVersion] },
        },
        requestId: {
          description: 'Opaque identifier for this request attempt.',
          schema: { type: 'string', format: 'uuid' },
        },
        etag: {
          description: 'Current cluster representation validator.',
          schema: { type: 'string', pattern: '^"[1-9][0-9]*"$' },
        },
        location: {
          description: 'Canonical URL of the created cluster.',
          schema: { type: 'string', format: 'uri' },
        },
        link: {
          description: 'RFC 8288 pagination link.',
          schema: { type: 'string' },
        },
        inventoryStatus: {
          description:
            'State of the optional ClusterProfile projection. `pending` is repaired by reconciliation and does not roll back the catalog write.',
          schema: {
            type: 'string',
            enum: ['disabled', 'synchronized', 'pending'],
          },
        },
      },
      schemas: {
        Cluster: clusterSchema(),
        ClusterInput: clusterInputSchema(),
        AuditEvent: auditEventSchema(),
        CursorPagination: {
          type: 'object',
          additionalProperties: false,
          required: ['pageSize'],
          properties: {
            pageSize: { type: 'integer', minimum: 1, maximum: 200 },
            nextPageToken: { type: 'string', minLength: 1 },
          },
        },
        ClusterPage: pageSchema('Cluster'),
        AuditEventPage: pageSchema('AuditEvent'),
        Problem: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'title', 'status', 'detail', 'instance'],
          properties: {
            type: { type: 'string', format: 'uri-reference' },
            title: { type: 'string' },
            status: { type: 'integer', minimum: 400, maximum: 599 },
            detail: { type: 'string' },
            instance: { type: 'string', format: 'uri-reference' },
          },
        },
      },
      responses: {
        invalidRequest: problemResponse('Invalid request'),
        unauthorized: problemResponse('Authentication required', true),
        forbidden: problemResponse('The principal is not authorized'),
        notFound: problemResponse('Resource not found'),
        preconditionFailed: problemResponse('Conditional request failed'),
      },
    },
    paths: {
      '/clusters': {
        get: {
          operationId: 'listClusters',
          summary: 'List clusters',
          tags: ['Cluster catalog'],
          security: userOrAgentSecurity(scopes.clustersRead),
          parameters: [refParameter('apiVersion'), ...paginationParameters()],
          responses: {
            '200': jsonResponse('Cluster page', 'ClusterPage', true),
            '400': refResponse('invalidRequest'),
            '401': refResponse('unauthorized'),
            '403': refResponse('forbidden'),
          },
        },
      },
      '/clusters/{clusterId}': {
        parameters: [refParameter('clusterId')],
        get: {
          operationId: 'getCluster',
          summary: 'Get a cluster',
          tags: ['Cluster catalog'],
          security: userOrAgentSecurity(scopes.clustersRead),
          parameters: [refParameter('apiVersion')],
          responses: {
            '200': jsonResponse('Cluster', 'Cluster', false, true),
            '400': refResponse('invalidRequest'),
            '401': refResponse('unauthorized'),
            '403': refResponse('forbidden'),
            '404': refResponse('notFound'),
          },
        },
        put: {
          operationId: 'replaceCluster',
          summary: 'Create or replace a cluster',
          description:
            'Create with `If-None-Match: *`, or replace with the current `If-Match` ETag.',
          tags: ['Cluster catalog'],
          security: userSecurity(scopes.clustersWrite),
          parameters: [
            refParameter('apiVersion'),
            {
              name: 'If-Match',
              in: 'header',
              required: false,
              description:
                'Current ETag for replacement. Omit when using `If-None-Match: *`.',
              schema: { type: 'string', pattern: '^"[1-9][0-9]*"$' },
            },
            {
              name: 'If-None-Match',
              in: 'header',
              required: false,
              description:
                'Use `*` for create-only semantics. Omit when replacing.',
              schema: { type: 'string', enum: ['*'] },
            },
          ],
          requestBody: jsonRequest('ClusterInput'),
          responses: {
            '200': clusterWriteResponse('Cluster replaced'),
            '201': clusterWriteResponse('Cluster created', true),
            '400': refResponse('invalidRequest'),
            '401': refResponse('unauthorized'),
            '403': refResponse('forbidden'),
            '404': refResponse('notFound'),
            '412': refResponse('preconditionFailed'),
          },
        },
        delete: {
          operationId: 'deleteCluster',
          summary: 'Delete a cluster',
          tags: ['Cluster catalog'],
          security: userSecurity(scopes.clustersWrite),
          parameters: [refParameter('apiVersion'), refParameter('ifMatch')],
          responses: {
            '204': emptyResponse('Cluster deleted', true),
            '400': refResponse('invalidRequest'),
            '401': refResponse('unauthorized'),
            '403': refResponse('forbidden'),
            '404': refResponse('notFound'),
            '412': refResponse('preconditionFailed'),
          },
        },
      },
      '/audit-events': {
        get: {
          operationId: 'listAuditEvents',
          summary: 'List immutable audit events',
          tags: ['Access audit'],
          security: userOrAgentSecurity(scopes.auditRead),
          parameters: [refParameter('apiVersion'), ...paginationParameters()],
          responses: {
            '200': jsonResponse('Audit event page', 'AuditEventPage', true),
            '400': refResponse('invalidRequest'),
            '401': refResponse('unauthorized'),
            '403': refResponse('forbidden'),
          },
        },
      },
      '/clusters/{clusterId}/kubernetes': {
        parameters: [refParameter('clusterId')],
        get: kubernetesOperation(
          'getKubernetesApiRoot',
          agentSecurity(scopes.kubernetesRead),
        ),
      },
      '/clusters/{clusterId}/kubernetes/{kubernetesPath}': {
        parameters: [
          refParameter('clusterId'),
          {
            name: 'kubernetesPath',
            in: 'path',
            required: true,
            description:
              'Kubernetes API path suffix. The runtime accepts nested path segments.',
            schema: { type: 'string', minLength: 1 },
            'x-path-catch-all': true,
          },
        ],
        get: kubernetesOperation(
          'getKubernetesResource',
          agentSecurity(scopes.kubernetesRead),
        ),
        post: kubernetesOperation(
          'createKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
          true,
        ),
        put: kubernetesOperation(
          'replaceKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
          true,
        ),
        patch: kubernetesOperation(
          'updateKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
          true,
        ),
        delete: kubernetesOperation(
          'deleteKubernetesResource',
          agentSecurity(scopes.kubernetesWrite),
        ),
      },
    },
  }
}

function clusterSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'displayName',
      'description',
      'apiServerUrl',
      'prometheusUrl',
      'enabled',
      'default',
      'resourceVersion',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      apiServerUrl: { type: 'string', format: 'uri' },
      prometheusUrl: { type: 'string' },
      enabled: { type: 'boolean' },
      default: { type: 'boolean' },
      resourceVersion: { type: 'integer', minimum: 1 },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  }
}

function clusterInputSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['displayName', 'apiServerUrl'],
    properties: {
      displayName: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 10_000 },
      apiServerUrl: { type: 'string', format: 'uri' },
      prometheusUrl: { type: 'string' },
      enabled: { type: 'boolean', default: true },
      default: { type: 'boolean', default: false },
    },
  }
}

function auditEventSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'createdAt',
      'requestId',
      'tokenId',
      'principalType',
      'controllerSubject',
      'agentIssuer',
      'agentSubject',
      'userSubject',
      'clientId',
      'scopes',
      'clusterId',
      'method',
      'path',
      'status',
      'durationMillis',
      'exchangeStatus',
      'targetAudience',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      createdAt: { type: 'string', format: 'date-time' },
      requestId: { type: 'string', format: 'uuid' },
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
      exchangeStatus: {
        type: 'string',
        enum: ['not_applicable', 'not_attempted', 'succeeded', 'failed'],
      },
      targetAudience: { type: 'string' },
    },
  }
}

function pageSchema(item: string): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'pagination'],
    properties: {
      items: { type: 'array', items: { $ref: `#/components/schemas/${item}` } },
      pagination: { $ref: '#/components/schemas/CursorPagination' },
    },
  }
}

function kubernetesOperation(
  operationId: string,
  security: object[],
  body = false,
): object {
  return {
    operationId,
    summary: 'Invoke the Kubernetes API',
    description:
      'Transparently proxies Kubernetes request and response semantics after Agent token exchange. Kubernetes RBAC remains authoritative.',
    tags: ['Kubernetes access'],
    security,
    parameters: [refParameter('apiVersion'), ...kubernetesQueryParameters()],
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
      '101': emptyResponse('WebSocket upgrade accepted'),
      '400': refResponse('invalidRequest'),
      '401': refResponse('unauthorized'),
      '403': refResponse('forbidden'),
      '404': refResponse('notFound'),
      default: {
        description: 'Kubernetes response or Hub gateway problem',
        headers: standardHeaders(),
        content: {
          'application/json': { schema: {} },
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
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

function refParameter(name: string): object {
  return { $ref: `#/components/parameters/${name}` }
}

function refResponse(name: string): object {
  return { $ref: `#/components/responses/${name}` }
}

function paginationParameters(): object[] {
  return [refParameter('pageSize'), refParameter('pageToken')]
}

function jsonRequest(schema: string): object {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  }
}

function jsonResponse(
  description: string,
  schema: string,
  paginated = false,
  includeEtag = false,
): object {
  return {
    description,
    headers: {
      ...standardHeaders(),
      ...(paginated ? { Link: headerRef('link') } : {}),
      ...(includeEtag ? { ETag: headerRef('etag') } : {}),
    },
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  }
}

function clusterWriteResponse(description: string, created = false): object {
  return {
    ...jsonResponse(description, 'Cluster', false, true),
    headers: {
      ...standardHeaders(),
      ETag: headerRef('etag'),
      'Inventory-Status': headerRef('inventoryStatus'),
      ...(created ? { Location: headerRef('location') } : {}),
    },
  }
}

function emptyResponse(description: string, inventory = false): object {
  return {
    description,
    headers: {
      ...standardHeaders(),
      ...(inventory
        ? { 'Inventory-Status': headerRef('inventoryStatus') }
        : {}),
    },
  }
}

function problemResponse(description: string, challenge = false): object {
  return {
    description,
    headers: {
      ...standardHeaders(),
      ...(challenge
        ? {
            'WWW-Authenticate': {
              description: 'OAuth authentication challenge.',
              schema: { type: 'string' },
            },
          }
        : {}),
    },
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/Problem' },
      },
    },
  }
}

function standardHeaders(): object {
  return {
    'API-Version': headerRef('apiVersion'),
    'Request-Id': headerRef('requestId'),
  }
}

function headerRef(name: string): object {
  return { $ref: `#/components/headers/${name}` }
}
