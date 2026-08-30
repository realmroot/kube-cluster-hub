// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { HubApi } from '../../shared/api'
import { AuditPage } from './audit-page'

describe('AuditPage', () => {
  it('renders attributed Agent exchange evidence without accessibility violations', async () => {
    const api = {
      listAuditEvents: vi.fn().mockResolvedValue({
        items: [
          {
            id: 1,
            createdAt: '2026-08-29T00:00:00.000Z',
            requestId: 'b0dc64ed-9c50-4264-b255-a7fbcbd7d2f8',
            tokenId: 'token-1',
            principalType: 'agent',
            controllerSubject: 'controller-1',
            agentIssuer: 'https://id.example.test',
            agentSubject: 'agent-1',
            userSubject: '',
            clientId: 'realmroot-cli',
            scopes: 'kubernetes:read',
            clusterId: 'local-kind',
            method: 'GET',
            path: '/api/clusters/local-kind/kubernetes/api/v1/namespaces',
            status: 200,
            durationMillis: 12,
            exchangeStatus: 'succeeded',
            targetAudience: 'kubernetes-client',
          },
        ],
        pagination: { pageSize: 50 },
      }),
    } as unknown as HubApi
    const rendered = renderPage(api)
    expect(await screen.findByText('agent-1')).toBeInTheDocument()
    expect(screen.getByText('succeeded')).toBeInTheDocument()
    expect(screen.getByText('kubernetes-client')).toBeInTheDocument()
    expect((await axe(rendered.container)).violations).toEqual([])
  })

  it('renders empty and error states', async () => {
    const empty = {
      listAuditEvents: vi.fn().mockResolvedValue({
        items: [],
        pagination: { pageSize: 50 },
      }),
    } as unknown as HubApi
    const rendered = renderPage(empty)
    expect(await screen.findByText('No access recorded')).toBeInTheDocument()
    rendered.unmount()

    const failed = {
      listAuditEvents: vi
        .fn()
        .mockRejectedValue(new Error('audit unavailable')),
    } as unknown as HubApi
    renderPage(failed)
    expect(
      await screen.findByText('Could not load audit events'),
    ).toBeInTheDocument()
    expect(screen.getByText('audit unavailable')).toBeInTheDocument()
  })
})

function renderPage(api: HubApi) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuditPage api={api} />
    </QueryClientProvider>,
  )
}
