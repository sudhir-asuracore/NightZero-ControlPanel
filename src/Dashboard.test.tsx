import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const approvedIncident = {
  ...incident,
  incident_id: 'inc-older',
  title: 'Older resolved payment issue',
  status: 'APPROVED',
}

const detail = {
  context: incident,
  rca: {
    root_cause: 'A regression rounds cents down.',
    confidence: 0.96,
    culprit_commit: '8f3c2a1',
    proposed_patch: 'Restore decimal formatting.',
    evidence: [{ kind: 'test', source: 'demo_target.test_pricing', detail: 'The regression reproduces.' }],
    timeline_trail: [
      { timestamp: 'T-120s', phase: 'PRECURSOR', event: 'User added promo item', source: 'cart-service', details: 'Item ID 123' },
      { timestamp: 'T-30s', phase: 'TRIGGER', event: 'Invoked format_total(1234)', source: 'demo_target', details: 'Truncated cents' },
      { timestamp: 'T-0s', phase: 'FAILURE', event: 'Total mismatch raised', source: 'demo_target', details: 'AssertionError' },
    ],
    attribution: {
      author: 'alex.dev@asuracore.com',
      commit_sha: '8f3c2a1',
      commit_message: 'Use integer division for display totals',
      pr_number: 142,
      pr_title: 'feat(pricing): Simplify display totals',
      pr_url: 'https://github.com/example/repo/pull/142',
      changed_file: 'demo_target/pricing.py',
      merged_at: '2 hours ago',
    },
    test_gap_analysis: {
      why_tests_missed: 'Existing test suites only asserted round dollar amounts ($10.00).',
      blindspot_summary: 'Missing boundary assertions for decimal cents.',
      recommended_test_name: 'test_preserves_cents',
      recommended_test_code: 'def test_preserves_cents(self):\n    self.assertEqual("$12.34", format_total(1234))',
    },
    blast_radius: {
      impacted_endpoints: ['/api/v1/checkout/total'],
      failure_rate: '100% of fractional orders',
      affected_services: ['demo_target'],
    },
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
    localStorage.setItem(
      'nightzero_auth_user',
      JSON.stringify({ email: 'on-call', name: 'on-call', token: 'nightzero-demo', mode: 'judge' })
    )
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'IDLE' })))
      if (url.includes('/approve')) {
        expect(options?.method).toBe('POST')
        return Promise.resolve(new Response(JSON.stringify({
          ...detail,
          context: { ...incident, status: 'APPROVED' },
          approval: { actor: 'on-call', pr_number: 17, pr_url: 'https://github.com/example/repo/pull/17' },
        })))
      }
      if (url.includes('/api/v1/incidents/')) return Promise.resolve(new Response(JSON.stringify(detail)))
      if (url.includes('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([incident, approvedIncident])))
      return Promise.resolve(new Response(JSON.stringify(detail)))
    }))
  })

  afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

  it('shows incident verification detail and lets an authenticated reviewer approve it', async () => {
    render(<Dashboard />)
    await screen.findAllByRole('button', { name: /checkout totals/i })
    expect(screen.getByText('1', { selector: '.metric strong' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /checkout totals/i })[0])

    await screen.findByText(/regression rounds cents down/i)
    expect(screen.getByText('FAIL', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /authorize & create draft pr/i }))

    await waitFor(() => expect(screen.getByText(/approved \(pr created\) by on-call/i)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('0', { selector: '.metric strong' })).toBeInTheDocument())
  })

  it('shows an unavailable API error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<Dashboard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  })

  it('shows live issue and draft PR links and a recoverable PR failure', async () => {
    const failedDetail = {
      ...detail,
      context: { ...incident, issue_url: 'https://github.com/example/repo/issues/142', status: 'PR_CREATION_FAILED' },
      approval: { actor: 'on-call', pr_number: 17, pr_url: 'https://github.com/example/repo/pull/17', failure: 'comment unavailable' },
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'IDLE' })))
      if (url.includes('/api/v1/incidents/')) return Promise.resolve(new Response(JSON.stringify(failedDetail)))
      if (url.includes('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([failedDetail.context])))
      return Promise.resolve(new Response(JSON.stringify(failedDetail)))
    }))
    render(<Dashboard />)
    fireEvent.click(await screen.findByRole('button', { name: /checkout totals/i }))
    expect(await screen.findByRole('link', { name: /view issue/i })).toHaveAttribute('href', failedDetail.context.issue_url)
    expect(screen.getByRole('link', { name: /view draft pr #17/i })).toHaveAttribute('href', failedDetail.approval.pr_url)
    expect(screen.getByText(/pr creation failed: comment unavailable/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry draft pr creation/i })).toBeInTheDocument()
  })

  it('renders login security checkpoint when unauthenticated', async () => {
    localStorage.clear()
    render(<Dashboard />)
    expect(screen.getByText(/security checkpoint/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in as judge/i })).toBeInTheDocument()
  })

  it('renders resolved status and merged PR link when PR is merged', async () => {
    const resolvedDetail = {
      ...detail,
      context: { ...incident, status: 'RESOLVED' },
      approval: { actor: 'sidigrid', pr_number: 18, pr_url: 'https://github.com/example/repo/pull/18' },
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'IDLE' })))
      if (url.includes('/api/v1/incidents/')) return Promise.resolve(new Response(JSON.stringify(resolvedDetail)))
      if (url.includes('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([resolvedDetail.context])))
      return Promise.resolve(new Response(JSON.stringify(resolvedDetail)))
    }))
    render(<Dashboard />)
    expect(screen.getByText('0', { selector: '.metric strong' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /checkout totals/i }))
    expect(await screen.findByText(/resolved \(pull request merged on github\)/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view merged pr #18/i })).toHaveAttribute('href', resolvedDetail.approval.pr_url)
  })

  it('renders a clean minimalistic progress bar on collapsed in-progress incidents', async () => {
    const inProgressIncident = {
      ...incident,
      incident_id: 'inc-live-rca',
      title: 'Real-time triage in progress',
      status: 'RCA',
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'ACTIVE' })))
      if (url.includes('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([inProgressIncident])))
      return Promise.resolve(new Response(JSON.stringify({ context: inProgressIncident })))
    }))
    render(<Dashboard />)
    expect(await screen.findByText(/real-time triage in progress/i)).toBeInTheDocument()
    const progressTrack = document.querySelector('.collapsed-progress-track')
    expect(progressTrack).toBeInTheDocument()
    expect(progressTrack).toHaveAttribute('title', 'Autonomous Agent executing: RCA')
    const progressFill = document.querySelector('.collapsed-progress-fill') as HTMLElement
    expect(progressFill).toBeInTheDocument()
    expect(progressFill?.style.width).toBe('50%')
  })

  it('renders settings subtabs and switches between Engine and Notifications', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'IDLE' })))
      if (url.includes('/api/v1/settings/notifications')) return Promise.resolve(new Response(JSON.stringify({
        email: { enabled: true, smtp_host: 'smtp.test.com', smtp_port: 587, username: 'test', from_address: 'a@b.com', to_addresses: ['c@d.com'], use_tls: true },
        telegram: { enabled: false, bot_token: '', chat_id: '' },
        slack: { enabled: false, webhook_url: '', channel: '' },
        triggers: { on_incident_detected: true, on_awaiting_approval: true, on_pr_approved: true },
      })))
      if (url.includes('/api/v1/settings')) return Promise.resolve(new Response(JSON.stringify({
        gemini_model: 'gemini-3.7-flash',
        available_models: [],
      })))
      if (url.includes('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([])))
      return Promise.resolve(new Response(JSON.stringify({})))
    }))

    render(<Dashboard />)
    
    // Switch to Settings tab
    fireEvent.click(screen.getByTitle('Settings'))
    expect(await screen.findByRole('button', { name: /engine & ai/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /notifications & webhooks/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /danger zone/i })).toBeInTheDocument()

    // Switch to Notifications subtab
    fireEvent.click(screen.getByRole('button', { name: /notifications & webhooks/i }))
    expect(await screen.findByText(/incident alert triggers/i)).toBeInTheDocument()
    expect(screen.getByText(/email \(smtp\)/i)).toBeInTheDocument()
    expect(screen.getByText(/telegram bot/i)).toBeInTheDocument()
    expect(screen.getByText(/slack webhook/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send test email/i })).toBeInTheDocument()
  })

  it('renders and switches between all 5 forensic tabs in the expanded incident view', async () => {
    render(<Dashboard />)
    fireEvent.click(await screen.findByRole('button', { name: /checkout totals/i }))

    // Tab 1: Root Cause & Diff (active by default)
    expect(await screen.findByRole('button', { name: /root cause & diff/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /precursor log trail/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /git & pr attribution/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ci\/cd gap & prevention/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /agent execution logs/i })).toBeInTheDocument()
    expect(screen.getByText(/regression rounds cents down/i)).toBeInTheDocument()

    // Tab 2: Precursor Log Trail
    fireEvent.click(screen.getByRole('button', { name: /precursor log trail/i }))
    expect(await screen.findByText(/chronological precursor action & event trail/i)).toBeInTheDocument()
    expect(screen.getByText(/user added promo item/i)).toBeInTheDocument()
    expect(screen.getByText(/invoked format_total\(1234\)/i)).toBeInTheDocument()
    expect(screen.getByText(/total mismatch raised/i)).toBeInTheDocument()

    // Tab 3: Git & PR Attribution
    fireEvent.click(screen.getByRole('button', { name: /git & pr attribution/i }))
    expect(await screen.findByText(/root cause change attribution & blast radius/i)).toBeInTheDocument()
    expect(screen.getByText(/alex\.dev@asuracore\.com/i)).toBeInTheDocument()
    expect(screen.getByText(/use integer division for display totals/i)).toBeInTheDocument()
    expect(screen.getByText(/estimated blast radius/i)).toBeInTheDocument()

    // Tab 4: CI/CD Gap & Prevention
    fireEvent.click(screen.getByRole('button', { name: /ci\/cd gap & prevention/i }))
    expect(await screen.findByText(/ci\/cd test blindspot analysis & permanent prevention/i)).toBeInTheDocument()
    expect(screen.getByText(/why existing ci\/cd tests missed this defect/i)).toBeInTheDocument()
    expect(screen.getByText(/recommended preventative test suite/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy test code/i })).toBeInTheDocument()

    // Tab 5: Agent Execution Logs
    fireEvent.click(screen.getByRole('button', { name: /agent execution logs/i }))
    expect(await screen.findByText(/autonomous agent execution & thought trace/i)).toBeInTheDocument()
    expect(screen.getByText(/tests passed\./i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy log trace/i })).toBeInTheDocument()
  })

  it('supports multi-incident selection and batch PR consolidation', async () => {
    const incA = { ...incident, incident_id: 'inc-batch-1', title: 'Issue 1' }
    const incB = { ...incident, incident_id: 'inc-batch-2', title: 'Issue 2' }
    vi.stubGlobal('fetch', vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ status: 'IDLE' })))
      if (url.includes('/batch-approve')) {
        return Promise.resolve(new Response(JSON.stringify({
          pr_number: 42,
          pr_url: 'https://github.com/example/repo/pull/42',
          branch: 'nightzero/release-bundle-1234',
          batch_id: 'bundle-1234',
        })))
      }
      if (url.includes('/api/v1/incidents')) return Promise.resolve(new Response(JSON.stringify([incA, incB])))
      return Promise.resolve(new Response(JSON.stringify(detail)))
    }))

    render(<Dashboard />)
    expect(await screen.findByRole('button', { name: /select all/i })).toBeInTheDocument()
    
    // Select all pending
    fireEvent.click(screen.getByRole('button', { name: /select all/i }))
    expect(screen.getByText(/2 incidents selected/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /bundle & create consolidated pr/i })).toBeInTheDocument()

    // Open modal
    fireEvent.click(screen.getByRole('button', { name: /bundle & create consolidated pr/i }))
    expect(await screen.findByText(/batch incident remediation & consolidated pr/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /authorize & open consolidated pr/i })).toBeInTheDocument()

    // Execute batch approval
    fireEvent.click(screen.getByRole('button', { name: /authorize & open consolidated pr/i }))
    expect(await screen.findByText(/consolidated draft pr #42 created!/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view draft pr #42/i })).toHaveAttribute('href', 'https://github.com/example/repo/pull/42')
  })
})