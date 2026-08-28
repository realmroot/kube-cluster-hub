// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { HubApi } from '../../shared/api'
import { ClustersPage } from './clusters-page'

describe('ClustersPage', () => {
  it('renders catalog data returned by the protected API', async () => {
    const api = {
      listClusters: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'local-kind',
            displayName: 'Local kind',
            description: '',
            apiServerUrl: '',
            prometheusUrl: '',
            accessMode: 'connector',
            connectorId: 'local-kind',
            connectorUrl: 'https://connector.example.test',
            enabled: true,
            default: true,
            inventoryStatus: 'ready',
            inventoryError: '',
            resourceVersion: 1,
            createdAt: '2026-08-28T00:00:00.000Z',
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        ],
        pagination: { pageSize: 50 },
      }),
    } as unknown as HubApi
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ClustersPage api={api} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Local kind')).toBeInTheDocument()
    expect(screen.getAllByText('Connector').length).toBeGreaterThan(0)
    expect(screen.getByText('Enabled')).toBeInTheDocument()
  })
})
