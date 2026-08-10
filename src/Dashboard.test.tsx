import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Dashboard from './Dashboard'

const incident = {
  incident_id: 'inc-123',
  title: 'Checkout totals are rounded down',
  service: 'demo_target',
  severity: 'HIGH',
  status: 'AWAITING_APPROVAL',
  created_at: '2026-08-10T13:00:00Z',
}

const detail = {
  context: incident,
  rca: {
    root_cause: 'A regression rounds cents down.',
    confidence: 0.96,
    culprit_commit: '8f3c2a1',
    proposed_patch: 'Restore decimal formatting.',
    evidence: [{ kind: 'test', source: 'demo_target.test_pricing', detail: 'The regression reproduces.' }],
  },
  verification: {
    sandbox_id: 'sandbox-1',
    branch_name: 'nightzero/inc-123',
    file_path: 'demo_target/pricing.py',
    diff: '- return "$12.00"\n+ return "$12.34"',
    before: { command: ['python', '-m', 'unittest'], exit_code: 1, output: 'FAIL' },
    after: { command: ['python', '-m', 'unittest'], exit_code: 0, output: 'OK' },
    staging_status: 'VERIFIED',
  },
  audit_events: [{ action: 'sandbox_verified', timestamp: '2026-08-10T13:01:00Z', detail: 'Tests passed.' }],
  approval: null,
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (url.endsWith('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'IDLE' })))
      if (url.endsWith('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([incident])))
      if (url.endsWith('/approve')) {
        expect(options?.method).toBe('POST')
        return Promise.resolve(new Response(JSON.stringify({ ...detail, approval: { actor: 'on-call' } })))
      }
      return Promise.resolve(new Response(JSON.stringify(detail)))
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('shows incident verification detail and lets a reviewer approve it', async () => {
    render(<Dashboard />)
    await screen.findByRole('button', { name: /checkout totals/i })
    fireEvent.click(screen.getByRole('button', { name: /checkout totals/i }))

    await screen.findByText(/regression rounds cents down/i)
    expect(screen.getByText('FAIL', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/reviewer/i), { target: { value: 'on-call' } })
    fireEvent.change(screen.getByLabelText(/approval token/i), { target: { value: 'nightzero-demo' } })
    fireEvent.click(screen.getByRole('button', { name: /approve proposal/i }))

    await waitFor(() => expect(screen.getByText(/approved by on-call/i)).toBeInTheDocument())
  })

  it('shows an unavailable API error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<Dashboard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  })
})