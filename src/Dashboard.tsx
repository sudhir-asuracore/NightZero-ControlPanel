import { useEffect, useState, useMemo } from 'react'
import { type AuthUser, getStoredUser, logout, subscribeToAuth } from './firebase'
import Login from './Login'

type Incident = {
  incident_id: string
  title: string
  service: string
  severity: string
  status: string
  created_at: string
  issue_url?: string
  pr_url?: string
  occurrence_count?: number
  last_seen_at?: string
}
type CommandResult = { command: string[]; exit_code: number; output: string }
type TimelineEvent = { timestamp: string; phase: string; event: string; source: string; details?: string }
type GitAttribution = { author: string; commit_sha: string; commit_message: string; pr_number?: number; pr_title?: string; pr_url?: string; changed_file?: string; merged_at?: string }
type TestGapAnalysis = { why_tests_missed: string; blindspot_summary: string; recommended_test_name: string; recommended_test_code: string }
type BlastRadius = { impacted_endpoints?: string[]; failure_rate?: string; affected_services?: string[] }
type IncidentDetail = {
  context: Incident & { source_commit: string; issue_number: number; issue_url?: string }
  rca: {
    root_cause: string
    confidence: number
    culprit_commit: string
    proposed_patch: string
    evidence: { kind: string; source: string; detail: string }[]
    timeline_trail?: TimelineEvent[]
    attribution?: GitAttribution
    test_gap_analysis?: TestGapAnalysis
    blast_radius?: BlastRadius
  }
  verification: { branch_name: string; file_path: string; diff: string; before: CommandResult; after: CommandResult; staging_status: string }
  approval: { actor?: string; action?: string; branch?: string; commit_sha?: string; pr_number?: number; pr_url?: string; batch_id?: string; deployed_at?: string; failure?: string } | null
  audit_events?: { action: string; timestamp: string; detail: string; spiffe_id?: string; signature?: string; armor_sanitized?: boolean }[]
}

interface GovernancePolicy {
  action_scope: string
  allowed_personas: string[]
  requires_delegation: boolean
  requires_model_armor: boolean
}

interface GovernanceData {
  model_armor: {
    status: string
    features: string[]
    active_heuristics_count: number
  }
  agent_identity: {
    domain: string
    signing_algorithm: string
    registered_personas: { persona: string; spiffe_id: string; scopes: string[] }[]
  }
  agent_gateway: {
    status: string
    policies: GovernancePolicy[]
  }
}

const api = import.meta.env.VITE_NIGHTZERO_API_URL || (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' ? 'https://nightzero-agent-164161200079.us-central1.run.app' : 'http://localhost:8080')
const stages = ['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'AWAITING_APPROVAL', 'APPROVED', 'RESOLVED', 'DEPLOYED']

function formatStatus(status: string) {
  if (status === 'APPROVED') return 'APPROVED (PR CREATED)'
  if (status === 'RESOLVED') return 'RESOLVED (DEPLOYING)'
  if (status === 'DEPLOYED') return 'DEPLOYED (LIVE IN PROD)'
  return status.replaceAll('_', ' ')
}

function StageRail({ status }: { status: string }) {
  const stageMap: Record<string, number> = {
    IDLE: -1,
    INGESTING: 0,
    RCA: 1,
    PATCHING: 2,
    SANDBOX_TESTING: 3,
    STAGING_VERIFIED: 4,
    AWAITING_APPROVAL: 4,
    PR_CREATION_FAILED: 4,
    APPROVED: 5,
    RESOLVED: 6,
    DEPLOYED: 7,
  }
  const active = stageMap[status] ?? (status === 'IDLE' ? -1 : 0)
  return <ol className="stage-rail" aria-label="Incident lifecycle">
    {stages.map((stage, index) => {
      const isComplete = status === 'DEPLOYED' ? true : index <= active
      const isCurrent = index === active
      return (
        <li 
          className={`${isComplete ? 'complete' : ''} ${isCurrent ? 'current' : ''} ${status === 'RESOLVED' && isCurrent ? 'resolved' : ''}`} 
          key={stage}
        >
          {isCurrent && active < 4 && <span style={{ marginRight: '4px' }}>⚡</span>}
          {stage === 'APPROVED' ? 'APPROVED (PR CREATED)' : stage === 'RESOLVED' ? 'RESOLVED (DEPLOYING)' : stage === 'DEPLOYED' ? 'DEPLOYED (PROD)' : stage.replace('_', ' ')}
        </li>
      )
    })}
  </ol>
}

function getProgressPercent(status: string): number {
  switch (status) {
    case 'INGESTING': return 25
    case 'RCA': return 50
    case 'PATCHING': return 72
    case 'SANDBOX_TESTING': return 88
    default: return 0
  }
}

function TestResult({ label, result }: { label: string; result: CommandResult }) {
  return <article className={`test-result ${result.exit_code === 0 ? 'passed' : 'failed'}`}>
    <div><span>{label}</span><strong>{result.exit_code === 0 ? 'PASS' : 'FAIL'}</strong></div>
    <code>{result.command.join(' ')}</code><pre>{result.output}</pre>
  </article>
}

interface GeminiModelOption {
  id: string
  name: string
  badge: string
  description: string
  latency: string
}

interface EmailNotificationConfig {
  enabled: boolean
  smtp_host: string
  smtp_port: number
  username: string
  password?: string
  from_address: string
  to_addresses: string[] | string
  use_tls: boolean
}

interface TelegramNotificationConfig {
  enabled: boolean
  bot_token: string
  chat_id: string
}

interface SlackNotificationConfig {
  enabled: boolean
  webhook_url: string
  channel: string
}

interface NotificationTriggers {
  on_incident_detected: boolean
  on_awaiting_approval: boolean
  on_pr_approved: boolean
}

interface NotificationSettings {
  email: EmailNotificationConfig
  telegram: TelegramNotificationConfig
  slack: SlackNotificationConfig
  triggers: NotificationTriggers
}

function getLogCategory(action: string) {
  if (action.startsWith('gemini.') || action.startsWith('adk.')) {
    return { label: 'GEMINI 3.7+ AI', className: 'badge-gemini', borderClass: 'log-gemini' }
  }
  if (action.startsWith('mcp.') || action.startsWith('github.')) {
    return { label: 'GITHUB MCP TOOL', className: 'badge-mcp', borderClass: 'log-mcp' }
  }
  if (action.startsWith('sandbox.')) {
    return { label: 'ISOLATED SANDBOX', className: 'badge-sandbox', borderClass: 'log-sandbox' }
  }
  if (action.startsWith('approval.') || action.startsWith('human_gate.')) {
    return { label: 'REVIEWER AUTH', className: 'badge-approval', borderClass: 'log-approval' }
  }
  return { label: 'TELEMETRY / INGEST', className: 'badge-alert', borderClass: 'log-alert' }
}

export default function Dashboard() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(getStoredUser())
  const [currentTab, setCurrentTab] = useState<'dashboard' | 'settings'>('dashboard')
  const [settingsTab, setSettingsTab] = useState<'engine' | 'notifications' | 'governance' | 'danger'>('engine')
  const [governance, setGovernance] = useState<GovernanceData | null>(null)
  const [health, setHealth] = useState('LOADING')
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [totalIncidents, setTotalIncidents] = useState(0)
  const [page, setPage] = useState(0)
  const pageSize = 10
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [forensicTab, setForensicTab] = useState<'rca' | 'timeline' | 'attribution' | 'prevention' | 'logs'>('rca')
  const [copiedTest, setCopiedTest] = useState<boolean>(false)
  const [copiedLogs, setCopiedLogs] = useState<boolean>(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [approving, setApproving] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [simulationBanner, setSimulationBanner] = useState('')
  const [geminiModel, setGeminiModel] = useState<string>('gemini-3.7-flash')
  const [availableModels, setAvailableModels] = useState<GeminiModelOption[]>([
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      badge: 'RECOMMENDED / FAST',
      description: 'Ultra-fast, high-efficiency model for real-time autonomous SRE triage and rapid patch synthesis.',
      latency: '~1.2s',
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      badge: 'DEEP REASONING',
      description: 'Advanced deep reasoning model for complex multi-service architectural analysis and subtle root cause deduction.',
      latency: '~3.5s',
    },
    {
      id: 'gemini-2.5-flash-lite',
      name: 'Gemini 2.5 Flash-Lite',
      badge: 'ULTRA LIGHTWEIGHT',
      description: 'Ultra-lightweight, high-throughput model optimized for ultra-low latency triage.',
      latency: '~0.8s',
    },
  ])
  const [savingModel, setSavingModel] = useState<boolean>(false)

  const [notifications, setNotifications] = useState<NotificationSettings>({
    email: {
      enabled: false,
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      username: '',
      password: '',
      from_address: 'NightZero Alerts <alerts@nightzero.io>',
      to_addresses: [],
      use_tls: true,
    },
    telegram: {
      enabled: false,
      bot_token: '',
      chat_id: '',
    },
    slack: {
      enabled: false,
      webhook_url: '',
      channel: '#sre-incidents',
    },
    triggers: {
      on_incident_detected: true,
      on_awaiting_approval: true,
      on_pr_approved: true,
    },
  })
  const [savingNotifications, setSavingNotifications] = useState(false)
  const [testingChannel, setTestingChannel] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ channel: string; success: boolean; message: string } | null>(null)
  const [refreshIntervalSec, setRefreshIntervalSec] = useState<number>(5)
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([])
  const [showBatchModal, setShowBatchModal] = useState<boolean>(false)
  const [batchApproving, setBatchApproving] = useState<boolean>(false)
  const [batchResult, setBatchResult] = useState<{ pr_number: number; pr_url: string; branch: string; batch_id: string } | null>(null)

  const openCount = incidents.filter(i => i.status !== 'APPROVED' && i.status !== 'RESOLVED' && i.status !== 'DEPLOYED').length
  const totalPages = Math.ceil(totalIncidents / pageSize)

  const collapsedAuditEvents = useMemo(() => {
    const raw = detail?.audit_events || []
    const result: {
      action: string
      timestamp: string
      detail: string
      spiffe_id?: string
      signature?: string
      armor_sanitized?: boolean
      count: number
      instances: { timestamp: string; detail: string }[]
    }[] = []

    for (const evt of raw) {
      if (evt.action === 'telemetry.repeated') {
        const existing = result.find(r => r.action === 'telemetry.repeated')
        if (existing) {
          existing.count += 1
          existing.timestamp = evt.timestamp
          existing.detail = evt.detail
          existing.spiffe_id = evt.spiffe_id || existing.spiffe_id
          existing.signature = evt.signature || existing.signature
          existing.armor_sanitized = evt.armor_sanitized || existing.armor_sanitized
          existing.instances.push({ timestamp: evt.timestamp, detail: evt.detail })
        } else {
          result.push({
            action: 'telemetry.repeated',
            timestamp: evt.timestamp,
            detail: evt.detail,
            spiffe_id: evt.spiffe_id,
            signature: evt.signature,
            armor_sanitized: evt.armor_sanitized,
            count: detail?.context?.occurrence_count && detail.context.occurrence_count > 1 ? detail.context.occurrence_count : 1,
            instances: [{ timestamp: evt.timestamp, detail: evt.detail }],
          })
        }
      } else {
        result.push({
          action: evt.action,
          timestamp: evt.timestamp,
          detail: evt.detail,
          spiffe_id: evt.spiffe_id,
          signature: evt.signature,
          armor_sanitized: evt.armor_sanitized,
          count: 1,
          instances: [{ timestamp: evt.timestamp, detail: evt.detail }],
        })
      }
    }
    return result
  }, [detail?.audit_events, detail?.context?.occurrence_count])

  useEffect(() => {
    if (!currentUser) return
    fetch(`${api}/api/v1/governance`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && typeof data === 'object') {
          setGovernance(data)
        }
      })
      .catch(() => {})
  }, [currentUser, currentTab, settingsTab])

  useEffect(() => {
    return subscribeToAuth(setCurrentUser)
  }, [])

  useEffect(() => {
    if (!currentUser) return
    fetch(`${api}/api/v1/settings/notifications`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && typeof data === 'object') {
          setNotifications(prev => ({
            ...prev,
            ...data,
            email: { ...prev.email, ...(data.email || {}) },
            telegram: { ...prev.telegram, ...(data.telegram || {}) },
            slack: { ...prev.slack, ...(data.slack || {}) },
            triggers: { ...prev.triggers, ...(data.triggers || {}) },
          }))
        }
      })
      .catch(() => {})
  }, [currentUser, currentTab, settingsTab])

  useEffect(() => {
    if (!currentUser) return
    fetch(`${api}/api/v1/settings`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          if (data.gemini_model) {
            setGeminiModel(data.gemini_model)
          }
          if (Array.isArray(data.available_models) && data.available_models.length > 0) {
            setAvailableModels(data.available_models)
          }
        }
      })
      .catch(() => {})
  }, [currentUser, currentTab])

  useEffect(() => {
    if (!currentUser) return
    const load = async () => {
      try {
        const [healthResponse, incidentsResponse] = await Promise.all([
          fetch(`${api}/health`),
          fetch(`${api}/api/v1/incidents?offset=${page * pageSize}&limit=${pageSize}`)
        ])
        if (!healthResponse.ok || !incidentsResponse.ok) throw new Error('Agent API is unavailable')
        setHealth((await healthResponse.json() as { status: string }).status)
        const data = await incidentsResponse.json() as { incidents: Incident[], total: number }
        
        // Handle backwards compatibility if API hasn't updated yet
        if (Array.isArray(data)) {
          setIncidents(data)
          setTotalIncidents(data.length)
        } else {
          setIncidents(data.incidents || [])
          setTotalIncidents(data.total || 0)
        }
        setError('')
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Agent API is unavailable') }
    }
    void load()
    const interval = window.setInterval(() => void load(), refreshIntervalSec * 1000)
    return () => window.clearInterval(interval)
  }, [page, currentUser, refreshIntervalSec])

  // Auto-refresh detail panel if currently inspecting an in-progress incident
  useEffect(() => {
    if (!detail) return
    const inProgress = ['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING'].includes(detail.context.status)
    if (!inProgress) return

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${api}/api/v1/incidents/${detail.context.incident_id}`)
        if (response.ok) {
          const updated = await response.json() as IncidentDetail
          setDetail(updated)
          setIncidents(prev => prev.map(inc => inc.incident_id === updated.context.incident_id ? { ...inc, status: updated.context.status } : inc))
        }
      } catch {}
    }, 1000)
    return () => clearInterval(timer)
  }, [detail])

  const simulateOutage = async () => {
    setSimulating(true)
    setError('')
    try {
      const response = await fetch(`${api}/api/v1/simulate-incident`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to simulate outage')
      const result = await response.json() as { status: string }
      setSimulationBanner(result.status || 'Deploying simulated outage. A real incident will trigger shortly.')
      setTimeout(() => setSimulationBanner(''), 10000)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Simulation failed') } finally { setSimulating(false) }
  }

  const selectIncident = async (incident: Incident) => {
    if (detail?.context.incident_id === incident.incident_id) {
      setDetail(null); setDetailError(''); return;
    }
    setDetail(null); setDetailError('')
    try {
      const response = await fetch(`${api}/api/v1/incidents/${incident.incident_id}`)
      if (!response.ok) throw new Error('Incident detail is unavailable')
      const detailData = await response.json() as IncidentDetail
      setDetail(detailData)
      if (detailData.context.status !== incident.status) {
        setIncidents(prev => prev.map(inc => inc.incident_id === detailData.context.incident_id ? { ...inc, status: detailData.context.status } : inc))
      }
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Incident detail is unavailable') }
  }

  const approve = async () => {
    if (!detail) return
    setApproving(true); setDetailError('')
    try {
      const actor = currentUser?.email || 'reviewer'
      const token = currentUser?.token || 'nightzero-demo'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const response = await fetch(`${api}/api/v1/incidents/${detail.context.incident_id}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ actor, token }),
      })
      const body = await response.json() as IncidentDetail | { error: string }
      if (!response.ok || 'error' in body) throw new Error('error' in body ? body.error : 'Approval failed')
      setDetail(body)
      setIncidents(current => current.map(item => item.incident_id === body.context.incident_id
        ? { ...item, status: body.context.status }
        : item))
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Approval failed') } finally { setApproving(false) }
  }

  const markDeployed = async () => {
    if (!detail) return
    try {
      const res = await fetch(`${api}/api/v1/incidents/${detail.context.incident_id}/deployed`, {
        method: 'POST',
      })
      if (res.ok) {
        const data = await res.json() as IncidentDetail
        setDetail(data)
        setIncidents(prev => prev.map(item => item.incident_id === data.context.incident_id ? { ...item, status: data.context.status } : item))
      }
    } catch (err) {
      console.error('Failed to mark as deployed', err)
    }
  }

  const toggleSelectIncident = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIncidentIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const toggleSelectAll = () => {
    const actionable = incidents.filter(i => !['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'DEPLOYED'].includes(i.status))
    if (actionable.length === 0) return
    const allSelected = actionable.every(i => selectedIncidentIds.includes(i.incident_id))
    if (allSelected) {
      setSelectedIncidentIds([])
    } else {
      setSelectedIncidentIds(actionable.map(i => i.incident_id))
    }
  }

  const executeBatchApproval = async () => {
    if (selectedIncidentIds.length === 0) return
    setBatchApproving(true)
    setDetailError('')
    try {
      const actor = currentUser?.email || 'on-call'
      const token = currentUser?.token || 'nightzero-demo'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${api}/api/v1/incidents/batch-approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          incident_ids: selectedIncidentIds,
          actor,
          token,
        }),
      })
      if (!res.ok) {
        const errData = await res.json() as { error?: string }
        throw new Error(errData.error || 'Failed to create bundled PR')
      }
      const data = await res.json() as { pr_number: number; pr_url: string; branch: string; batch_id: string }
      setBatchResult(data)
      setIncidents(prev => prev.map(inc => selectedIncidentIds.includes(inc.incident_id) ? { ...inc, status: 'APPROVED' } : inc))
      if (detail && selectedIncidentIds.includes(detail.context.incident_id)) {
        setDetail({
          ...detail,
          context: { ...detail.context, status: 'APPROVED' },
          approval: {
            actor: currentUser?.email || 'on-call',
            pr_number: data.pr_number,
            pr_url: data.pr_url,
            branch: data.branch,
            batch_id: data.batch_id,
            action: 'CONSOLIDATED_PULL_REQUEST_CREATED',
          }
        })
      }
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Batch approval failed')
    } finally {
      setBatchApproving(false)
    }
  }

  const [completingIds, setCompletingIds] = useState<string[]>([])
  const [batchCompleting, setBatchCompleting] = useState(false)

  const markIncidentDone = async (incidentId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    setCompletingIds(prev => [...prev, incidentId])
    try {
      const actor = currentUser?.email || 'operator'
      const res = await fetch(`${api}/api/v1/incidents/${incidentId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor }),
      })
      if (res.ok) {
        setIncidents(prev => prev.map(inc => inc.incident_id === incidentId ? { ...inc, status: 'DEPLOYED' } : inc))
        if (detail && detail.context.incident_id === incidentId) {
          setDetail({ ...detail, context: { ...detail.context, status: 'DEPLOYED' } })
        }
      }
    } catch (err) {
      console.error('Failed to mark incident as done:', err)
    } finally {
      setCompletingIds(prev => prev.filter(id => id !== incidentId))
    }
  }

  const batchMarkSelectedDone = async () => {
    if (selectedIncidentIds.length === 0) return
    setBatchCompleting(true)
    try {
      const actor = currentUser?.email || 'operator'
      const res = await fetch(`${api}/api/v1/incidents/batch-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incident_ids: selectedIncidentIds, actor }),
      })
      if (res.ok) {
        setIncidents(prev => prev.map(inc => selectedIncidentIds.includes(inc.incident_id) ? { ...inc, status: 'DEPLOYED' } : inc))
        if (detail && selectedIncidentIds.includes(detail.context.incident_id)) {
          setDetail({ ...detail, context: { ...detail.context, status: 'DEPLOYED' } })
        }
        setSelectedIncidentIds([])
      }
    } catch (err) {
      console.error('Batch complete failed:', err)
    } finally {
      setBatchCompleting(false)
    }
  }

  const handleLogout = async () => {
    await logout()
    setCurrentUser(null)
    setDetail(null)
  }

  const selectGeminiModel = async (modelId: string) => {
    setSavingModel(true)
    try {
      const res = await fetch(`${api}/api/v1/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_model: modelId }),
      })
      if (res.ok) {
        const data = await res.json() as { gemini_model?: string }
        if (data.gemini_model) setGeminiModel(data.gemini_model)
      }
    } catch (err) {
      console.error('Failed to update Gemini model', err)
    } finally {
      setSavingModel(false)
    }
  }

  const saveNotifications = async (updated: NotificationSettings) => {
    setSavingNotifications(true)
    setTestResult(null)
    try {
      const res = await fetch(`${api}/api/v1/settings/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      })
      if (res.ok) {
        const data = await res.json() as NotificationSettings
        setNotifications(data)
      }
    } catch (err) {
      console.error('Failed to save notifications', err)
    } finally {
      setSavingNotifications(false)
    }
  }

  const testNotificationChannel = async (channel: 'email' | 'telegram' | 'slack') => {
    setTestingChannel(channel)
    setTestResult(null)
    try {
      const config = notifications[channel]
      const res = await fetch(`${api}/api/v1/notifications/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, config }),
      })
      const data = await res.json() as { success?: boolean; message?: string }
      setTestResult({
        channel,
        success: Boolean(data.success),
        message: data.message || (data.success ? 'Test alert sent successfully!' : 'Test alert failed.'),
      })
    } catch (err) {
      setTestResult({
        channel,
        success: false,
        message: err instanceof Error ? err.message : 'Network error testing channel.',
      })
    } finally {
      setTestingChannel(null)
    }
  }

  if (!currentUser) {
    return <Login onLoginSuccess={setCurrentUser} />
  }

  return <div className="console-shell"><aside className="sidebar" aria-label="Control panel navigation">
        <span className="mark">NZ</span>
        <span className={currentTab === 'dashboard' ? 'nav-active' : 'nav-inactive'} title="Dashboard" onClick={() => setCurrentTab('dashboard')}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        </span>
        <span className={currentTab === 'settings' ? 'nav-active' : 'nav-inactive'} title="Settings" onClick={() => setCurrentTab('settings')}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </span>
        <b>NIGHTZERO</b>
        <span className="nav-inactive" title="Sign Out / Logout" onClick={() => void handleLogout()} style={{ marginTop: '16px', color: '#ef4444' }} role="button" aria-label="Sign Out">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </span>
      </aside><main className="dashboard">
    {currentTab === 'dashboard' ? (
      <>
    <header><p className="eyebrow">CONSOLE <span>›</span> INCIDENTS</p><div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}><div className="agent-status"><i className={health === 'IDLE' ? 'idle' : 'active'} /> AGENT: <strong>{health}</strong> <span style={{ color: '#38bdf8', marginLeft: '6px', fontSize: '9px', fontWeight: 'bold' }}>[{geminiModel.toUpperCase()}]</span></div><div style={{ display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid #333333', padding: '8px 12px', background: '#111111' }}>{currentUser.photoURL ? <img src={currentUser.photoURL} alt={currentUser.name} style={{ width: '18px', height: '18px', borderRadius: '50%' }} /> : <span style={{ color: '#dc2626', fontWeight: 'bold', fontSize: '12px' }}>●</span>}<span style={{ color: '#cbd5e1', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.05em' }}>{currentUser.email}</span><button onClick={() => void handleLogout()} style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: '10px', letterSpacing: '0.05em', cursor: 'pointer', padding: '0 4px', textTransform: 'uppercase', fontWeight: 'bold' }} title="Sign Out">[LOGOUT]</button></div></div></header>
    <section className="hero"><div><p className="eyebrow">AUTONOMOUS INCIDENT RESPONSE</p><h1>OPERATIONS</h1></div><div className="metric"><span>OPEN INCIDENTS</span><strong>{openCount}</strong></div><div className="metric"><span>DEMO TRIGGER</span><button className="simulate-btn" disabled={simulating} onClick={() => void simulateOutage()}>{simulating ? '⚡ SIMULATING…' : '⚡ SIMULATE OUTAGE'}</button></div></section>
    {simulationBanner && <p className="approved" style={{ padding: '16px 24px', border: '1px solid #00d795', margin: '24px 0 0 0', backgroundColor: '#0b1612' }} role="alert">{simulationBanner}</p>}
    {error && <p className="error" role="alert">{error}</p>}<section className="incident-list"><div className="section-heading"><div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}><h2>DETECTED INCIDENTS</h2>{incidents.some(i => !['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'DEPLOYED'].includes(i.status)) && (<button type="button" onClick={toggleSelectAll} style={{ background: '#0f172a', border: '1px solid #334155', color: '#38bdf8', fontSize: '10px', fontWeight: 'bold', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', letterSpacing: '0.05em' }}>{incidents.filter(i => !['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'DEPLOYED'].includes(i.status)).every(i => selectedIncidentIds.includes(i.incident_id)) ? '✓ DESELECT ALL' : '☑ SELECT ALL'}</button>)}</div><div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ fontSize: '10px', color: '#94a3b8', letterSpacing: '0.05em', fontWeight: 'bold' }}>REFRESH:</span><div style={{ display: 'inline-flex', border: '1px solid #334155', borderRadius: '4px', overflow: 'hidden', background: '#0f172a' }}><button type="button" onClick={() => setRefreshIntervalSec(1)} style={{ background: refreshIntervalSec === 1 ? '#0284c7' : 'transparent', color: refreshIntervalSec === 1 ? '#ffffff' : '#64748b', border: 'none', padding: '2px 8px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.15s ease' }} title="Refresh every 1 second">1S</button><button type="button" onClick={() => setRefreshIntervalSec(5)} style={{ background: refreshIntervalSec === 5 ? '#0284c7' : 'transparent', color: refreshIntervalSec === 5 ? '#ffffff' : '#64748b', border: 'none', padding: '2px 8px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.15s ease' }} title="Refresh every 5 seconds">5S</button></div></div></div>{incidents.length === 0 ? <p className="empty">No incidents detected. The Agent is standing by.</p> : <div className="incident-table">{incidents.map(item => {
      const isExpanded = detail?.context.incident_id === item.incident_id
      const currentStatus = isExpanded && detail ? detail.context.status : item.status
      const isInProgress = ['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING'].includes(currentStatus)
      const isDone = currentStatus === 'DEPLOYED'
      const isSelectable = !isInProgress && !isDone
      const progressPercent = getProgressPercent(currentStatus)

      return (
        <div key={item.incident_id} className={`incident-row-wrapper ${!isExpanded && isInProgress ? 'is-in-progress' : ''}`}>
          <button
            className={`incident-row ${isDone ? 'incident-row-done' : ''}`}
            onClick={() => void selectIncident(item)}
            style={isDone ? { opacity: 0.65, background: 'rgba(10, 16, 29, 0.6)' } : undefined}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isSelectable && (
                <input
                  type="checkbox"
                  aria-label={`Select incident ${item.incident_id}`}
                  checked={selectedIncidentIds.includes(item.incident_id)}
                  onChange={(e) => toggleSelectIncident(item.incident_id, e as unknown as React.MouseEvent)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: 'pointer', accentColor: '#0284c7', width: '15px', height: '15px' }}
                  title="Select incident to bundle into consolidated PR or mark as Done"
                />
              )}
              <span className={`severity severity-${item.severity.toLowerCase()}`}>{item.severity}</span>
            </div>
            <span className="incident-title" style={isDone ? { textDecoration: 'line-through', color: '#64748b' } : undefined}>
              {item.title}
              {item.occurrence_count && item.occurrence_count > 1 ? (
                <span className="repetition-badge" title={`Recurring failure detected ${item.occurrence_count} times in production`}>
                  🔁 ×{item.occurrence_count}
                </span>
              ) : null}
            </span>
            <span style={isDone ? { color: '#475569' } : undefined}>{item.service}</span>
            <span className={`status ${isInProgress ? 'status-active' : ''} ${currentStatus === 'RESOLVED' ? 'status-resolved' : currentStatus === 'APPROVED' ? 'status-approved' : ''}`}>
              {isDone ? (
                <span style={{ color: '#10b981', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  ✓ DONE
                </span>
              ) : isInProgress ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#38bdf8' }}>
                  <span className="live-pulse-dot" />
                  {formatStatus(currentStatus)}
                </span>
              ) : (
                formatStatus(currentStatus)
              )}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {!isDone && !isInProgress && (
                <button
                  type="button"
                  onClick={(e) => void markIncidentDone(item.incident_id, e)}
                  disabled={completingIds.includes(item.incident_id)}
                  style={{
                    background: '#064e3b',
                    border: '1px solid #059669',
                    color: '#34d399',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '10px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  title="Mark incident as completed/done"
                >
                  {completingIds.includes(item.incident_id) ? '…' : '✓ Done'}
                </button>
              )}
              <span>{isExpanded ? '⌄' : '›'}</span>
            </div>
          </button>

          {!isExpanded && isInProgress && (
            <div className="collapsed-progress-track" title={`Autonomous Agent executing: ${formatStatus(currentStatus)}`}>
              <div className="collapsed-progress-fill" style={{ width: `${progressPercent}%` }}>
                <div className="collapsed-progress-glow" />
              </div>
            </div>
          )}

          {isExpanded && (
            <section className="detail-panel" style={{ marginTop: 0, borderTop: 0, paddingBottom: '30px', borderBottom: '1px solid #1d2227' }}>
              {detailError && <p className="error" role="alert" style={{ marginTop: 0, marginBottom: '24px' }}>{detailError}</p>}
              <div className="section-heading">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <p className="eyebrow" style={{ margin: 0 }}>INCIDENT {detail.context.incident_id}</p>
                    {detail.context.occurrence_count && detail.context.occurrence_count > 1 ? (
                      <span className="repetition-badge-expanded" title={`Error occurred ${detail.context.occurrence_count} times in production`}>
                        🔁 REPEATED {detail.context.occurrence_count}× IN PRODUCTION
                      </span>
                    ) : null}
                  </div>
                  <h2 style={{ marginTop: '6px' }}>{detail.context.title}</h2>
                </div>
                <button className="close" onClick={() => setDetail(null)}>CLOSE ×</button>
              </div>

              <StageRail status={detail.context.status} />

              {/* Forensic Intelligence Explorer Navigation */}
              <div className="forensic-nav">
                <button
                  type="button"
                  className={`forensic-nav-btn ${forensicTab === 'rca' ? 'active' : ''}`}
                  onClick={() => setForensicTab('rca')}
                >
                  <span>🧬</span> ROOT CAUSE & DIFF
                </button>
                <button
                  type="button"
                  className={`forensic-nav-btn ${forensicTab === 'timeline' ? 'active' : ''}`}
                  onClick={() => setForensicTab('timeline')}
                >
                  <span>⏱️</span> PRECURSOR LOG TRAIL
                  {detail.rca?.timeline_trail && detail.rca.timeline_trail.length > 0 && (
                    <span className="tab-badge">{detail.rca.timeline_trail.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`forensic-nav-btn ${forensicTab === 'attribution' ? 'active' : ''}`}
                  onClick={() => setForensicTab('attribution')}
                >
                  <span>👤</span> GIT & PR ATTRIBUTION
                </button>
                <button
                  type="button"
                  className={`forensic-nav-btn ${forensicTab === 'prevention' ? 'active' : ''}`}
                  onClick={() => setForensicTab('prevention')}
                >
                  <span>🛡️</span> CI/CD GAP & PREVENTION
                </button>
                <button
                  type="button"
                  className={`forensic-nav-btn ${forensicTab === 'logs' ? 'active' : ''}`}
                  onClick={() => setForensicTab('logs')}
                >
                  <span>🤖</span> AGENT EXECUTION LOGS
                  {collapsedAuditEvents.length > 0 && (
                    <span className="tab-badge">{collapsedAuditEvents.length}</span>
                  )}
                </button>
              </div>

              {/* Tab 1: Root Cause & Diff */}
              {forensicTab === 'rca' && (
                <>
                  {detail.rca && (
                    <div className="detail-grid" style={{ marginBottom: '24px' }}>
                      <article>
                        <h3>ROOT CAUSE ANALYSIS</h3>
                        <p>{detail.rca.root_cause}</p>
                        <dl>
                          <dt>CONFIDENCE</dt>
                          <dd>{Math.round(detail.rca.confidence * 100)}%</dd>
                          <dt>CULPRIT COMMIT</dt>
                          <dd>{detail.rca.culprit_commit}</dd>
                          <dt>PATCH</dt>
                          <dd>{detail.rca.proposed_patch}</dd>
                        </dl>
                      </article>
                      <article>
                        <h3>EVIDENCE</h3>
                        {detail.rca.evidence.map(evidence => (
                          <div className="evidence" key={`${evidence.kind}-${evidence.source}`}>
                            <span>{evidence.kind}</span>
                            <b>{evidence.source}</b>
                            <p>{evidence.detail}</p>
                          </div>
                        ))}
                      </article>
                    </div>
                  )}

                  {detail.verification && (
                    <div style={{ marginBottom: '24px' }}>
                      <h3>ISOLATED SANDBOX VERIFICATION</h3>
                      <p className="muted">{detail.verification.branch_name} · {detail.verification.file_path} · {detail.verification.staging_status}</p>
                      <div className="test-grid">
                        <TestResult label="BEFORE PATCH" result={detail.verification.before} />
                        <TestResult label="AFTER PATCH" result={detail.verification.after} />
                      </div>
                      <pre className="diff">{detail.verification.diff}</pre>
                    </div>
                  )}
                </>
              )}

              {/* Tab 2: Precursor Log Trail */}
              {forensicTab === 'timeline' && (
                <div className="forensic-panel">
                  <div className="forensic-panel-header">
                    <h3>Chronological Precursor Action & Event Trail</h3>
                    <span style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Sequence: User Action ➔ Microservice Trigger ➔ Failure Detection
                    </span>
                  </div>

                  {detail.rca?.timeline_trail && detail.rca.timeline_trail.length > 0 ? (
                    <div className="timeline-trail">
                      {detail.rca.timeline_trail.map((step, idx) => {
                        const phaseClass = step.phase ? `phase-badge-${step.phase.toLowerCase()}` : 'phase-badge-precursor'
                        const dotClass = step.phase ? `dot-${step.phase.toLowerCase()}` : 'dot-precursor'
                        return (
                          <div key={idx} className="timeline-step">
                            <div className={`timeline-dot ${dotClass}`}>{idx + 1}</div>
                            <div className="timeline-card">
                              <div className="timeline-meta">
                                <span className={`phase-badge ${phaseClass}`}>{step.phase}</span>
                                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                  <span className="timeline-source">SRC: {step.source}</span>
                                  <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>{step.timestamp}</span>
                                </div>
                              </div>
                              <div className="timeline-event-text">{step.event}</div>
                              {step.details && <p className="timeline-details">{step.details}</p>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p style={{ color: '#94a3b8', fontSize: '12px' }}>
                      Precursor log timeline unavailable for this incident record.
                    </p>
                  )}
                </div>
              )}

              {/* Tab 3: Git & PR Attribution */}
              {forensicTab === 'attribution' && (
                <div className="forensic-panel">
                  <div className="forensic-panel-header">
                    <h3>Root Cause Change Attribution & Blast Radius</h3>
                    <span style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Git Commit Blame & Pull Request Context
                    </span>
                  </div>

                  <div className="attribution-grid" style={{ marginBottom: '20px' }}>
                    <div className="attribution-box">
                      <h4>Introduced By (Author)</h4>
                      <div className="author-pill" style={{ marginBottom: '12px' }}>
                        <div className="author-avatar">
                          {(detail.rca?.attribution?.author || 'Developer')[0].toUpperCase()}
                        </div>
                        <span>{detail.rca?.attribution?.author || 'developer'}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>
                        Merged: <strong style={{ color: '#fff' }}>{detail.rca?.attribution?.merged_at || 'Recently'}</strong>
                      </div>
                    </div>

                    <div className="attribution-box">
                      <h4>Culprit Git Commit</h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                        <code style={{ background: '#222', padding: '3px 8px', borderRadius: '3px', color: '#38bdf8', fontSize: '11px', fontWeight: 'bold' }}>
                          {detail.rca?.attribution?.commit_sha || detail.rca?.culprit_commit || 'latest'}
                        </code>
                        <span style={{ color: '#64748b', fontSize: '11px' }}>{detail.rca?.attribution?.changed_file || detail.verification?.file_path || 'demo_target/pricing.py'}</span>
                      </div>
                      <p style={{ color: '#cbd5e1', fontSize: '12px', margin: 0, fontStyle: 'italic' }}>
                        "{detail.rca?.attribution?.commit_message || 'Update target module'}"
                      </p>
                    </div>

                    <div className="attribution-box">
                      <h4>Associated Pull Request</h4>
                      {detail.rca?.attribution?.pr_url ? (
                        <a
                          href={detail.rca.attribution.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#38bdf8', textDecoration: 'none', fontWeight: 'bold', fontSize: '12px' }}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1a2.25 2.25 0 00-1.5 3.922v6.156a2.25 2.25 0 101.5 0V7.072a4.502 4.502 0 013.75 1.178V5.84a3.003 3.003 0 00-3.75-1.12V4.922A2.25 2.25 0 005 1zm6 3.5a2.25 2.25 0 100 4.5 2.25 2.25 0 000-4.5z"/></svg>
                          PR #{detail.rca.attribution.pr_number || '—'}: {detail.rca.attribution.pr_title || 'Target Change'} ↗
                        </a>
                      ) : (
                        <span style={{ color: '#94a3b8', fontSize: '12px' }}>
                          PR #{detail.rca?.attribution?.pr_number || '—'}: {detail.rca?.attribution?.pr_title || 'Target Change'}
                        </span>
                      )}
                      <p style={{ color: '#64748b', fontSize: '10px', marginTop: '6px', margin: 0 }}>
                        Code review status: Merged to default branch
                      </p>
                    </div>
                  </div>

                  {/* Blast Radius */}
                  <div style={{ borderTop: '1px solid #222', paddingTop: '18px' }}>
                    <h4 style={{ margin: '0 0 12px 0', fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Estimated Blast Radius</h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
                      <div>
                        <span style={{ fontSize: '10px', color: '#64748b', display: 'block', marginBottom: '4px' }}>FAILURE IMPACT RATE</span>
                        <span style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.4)', padding: '3px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: 'bold' }}>
                          {detail.rca?.blast_radius?.failure_rate || '100% of affected requests'}
                        </span>
                      </div>
                      <div>
                        <span style={{ fontSize: '10px', color: '#64748b', display: 'block', marginBottom: '4px' }}>AFFECTED SERVICES</span>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {(detail.rca?.blast_radius?.affected_services || [detail.context.service]).map(svc => (
                            <span key={svc} style={{ background: '#222', color: '#cbd5e1', padding: '3px 8px', borderRadius: '3px', fontSize: '10px' }}>
                              {svc}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <span style={{ fontSize: '10px', color: '#64748b', display: 'block', marginBottom: '4px' }}>IMPACTED ENDPOINTS</span>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {(detail.rca?.blast_radius?.impacted_endpoints || ['/api/v1/checkout/total', '/api/v1/cart/preview']).map(ep => (
                            <code key={ep} style={{ background: '#1c1c1c', border: '1px solid #333', color: '#38bdf8', padding: '2px 6px', borderRadius: '3px', fontSize: '10px' }}>
                              {ep}
                            </code>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 4: CI/CD Gap & Prevention */}
              {forensicTab === 'prevention' && (
                <div className="forensic-panel">
                  <div className="forensic-panel-header">
                    <h3>CI/CD Test Blindspot Analysis & Permanent Prevention</h3>
                    <span style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Why did this pass CI? · Recommended Regression Test
                    </span>
                  </div>

                  <div className="prevention-box" style={{ marginBottom: '20px' }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      ⚠️ Why Existing CI/CD Tests Missed This Defect
                    </h4>
                    <p style={{ color: '#e2e8f0', fontSize: '12px', lineHeight: '1.6', margin: '0 0 12px 0' }}>
                      {detail.rca?.test_gap_analysis?.why_tests_missed ||
                        'Existing test suites only asserted round dollar amounts ($10.00, $20.00). No parameterized boundary test existed for fractional cent remainders ($12.34, $99.99).'}
                    </p>
                    <div style={{ background: '#1a1412', border: '1px solid #7c2d12', padding: '10px 14px', borderRadius: '4px', fontSize: '11px', color: '#fdba74' }}>
                      <strong>Blindspot Summary: </strong>
                      {detail.rca?.test_gap_analysis?.blindspot_summary ||
                        'Missing boundary assertions for decimal cents during currency formatting in checkout pipeline.'}
                    </div>
                  </div>

                  <div className="prevention-box">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h4 style={{ margin: 0, fontSize: '12px', color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        🛡️ Recommended Preventative Test Suite
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          const code = detail.rca?.test_gap_analysis?.recommended_test_code || "def test_preserves_cents(self):\n    self.assertEqual('$12.34', format_total(1234))"
                          void navigator.clipboard.writeText(code)
                          setCopiedTest(true)
                          setTimeout(() => setCopiedTest(false), 2000)
                        }}
                        style={{ background: '#1c1c1c', border: '1px solid #333', color: '#38bdf8', padding: '4px 10px', fontSize: '10px', borderRadius: '3px', cursor: 'pointer', fontWeight: 'bold' }}
                      >
                        {copiedTest ? '✔ COPIED' : 'COPY TEST CODE'}
                      </button>
                    </div>
                    <pre className="prevention-code">
                      {detail.rca?.test_gap_analysis?.recommended_test_code ||
                        'def test_preserves_cents_and_fractional_totals(self) -> None:\n    self.assertEqual("$12.34", format_total(1234))\n    self.assertEqual("$0.99", format_total(99))\n    self.assertEqual("$100.00", format_total(10000))'}
                    </pre>
                  </div>
                </div>
              )}

              {/* Tab 5: Agent Execution Logs */}
              {forensicTab === 'logs' && (
                <div className="forensic-panel">
                  <div className="forensic-panel-header">
                    <div>
                      <h3>Autonomous Agent Execution & Thought Trace</h3>
                      <span style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Gemini 3.7+ AI Inference · MCP Tool Invocations · Isolated Sandbox Telemetry
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const logText = (detail.audit_events || [])
                          .map(e => `[${e.timestamp}] [${e.action}] ${e.detail}`)
                          .join('\n')
                        void navigator.clipboard.writeText(logText)
                        setCopiedLogs(true)
                        setTimeout(() => setCopiedLogs(false), 2000)
                      }}
                      style={{ background: '#1c1c1c', border: '1px solid #333', color: '#38bdf8', padding: '4px 10px', fontSize: '10px', borderRadius: '3px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                      {copiedLogs ? '✔ LOGS COPIED' : 'COPY LOG TRACE'}
                    </button>
                  </div>

                  {collapsedAuditEvents.length > 0 ? (
                    <div className="agent-logs-feed">
                      {collapsedAuditEvents.map((evt, idx) => {
                        const cat = getLogCategory(evt.action)
                        const isRepeated = evt.action === 'telemetry.repeated'
                        const repeatCount = evt.count > 1 ? evt.count : (detail?.context?.occurrence_count && detail.context.occurrence_count > 1 ? detail.context.occurrence_count : 1)
                        return (
                          <div key={idx} className={`agent-log-item ${cat.borderClass}`} style={{ position: 'relative' }}>
                            <div className="agent-log-header">
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                <span className={`agent-log-category ${cat.className}`}>{cat.label}</span>
                                <span className="agent-log-action-name">{evt.action}</span>
                                {evt.spiffe_id && (
                                  <span style={{
                                    backgroundColor: '#0f172a',
                                    color: '#38bdf8',
                                    border: '1px solid rgba(56, 189, 248, 0.3)',
                                    fontSize: '9px',
                                    fontFamily: 'monospace',
                                    padding: '2px 6px',
                                    borderRadius: '3px',
                                    letterSpacing: '0.02em',
                                  }}>
                                    {evt.spiffe_id}
                                  </span>
                                )}
                                {evt.armor_sanitized && (
                                  <span style={{
                                    backgroundColor: 'rgba(16, 185, 129, 0.15)',
                                    color: '#34d399',
                                    border: '1px solid rgba(16, 185, 129, 0.4)',
                                    fontSize: '9px',
                                    fontWeight: 'bold',
                                    padding: '2px 6px',
                                    borderRadius: '10px',
                                  }}>
                                    🛡️ Model Armor: Redacted
                                  </span>
                                )}
                                {isRepeated && repeatCount > 1 && (
                                  <span style={{
                                    backgroundColor: 'rgba(234, 179, 8, 0.15)',
                                    color: '#facc15',
                                    border: '1px solid rgba(234, 179, 8, 0.4)',
                                    fontSize: '10px',
                                    fontWeight: 'bold',
                                    padding: '2px 8px',
                                    borderRadius: '12px',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    letterSpacing: '0.04em',
                                  }}>
                                    🔁 {repeatCount}x REPEATS DEDUPLICATED
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {evt.signature && (
                                  <span style={{ color: '#10b981', fontSize: '9px', fontFamily: 'monospace', opacity: 0.85 }} title="Cryptographic Zero-Trust Agent Attestation Signature">
                                    ✔ {evt.signature}
                                  </span>
                                )}
                                <span style={{ color: '#64748b', fontSize: '10px' }}>
                                  {evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : `Step ${idx + 1}`}
                                </span>
                              </div>
                            </div>
                            <p className="agent-log-text" style={{ margin: '6px 0 0 0' }}>{evt.detail}</p>
                            {isRepeated && evt.instances.length > 1 && (
                              <details style={{ marginTop: '8px', fontSize: '11px', color: '#94a3b8' }}>
                                <summary style={{ cursor: 'pointer', color: '#38bdf8', fontSize: '10px', fontWeight: 'bold' }}>
                                  View all {evt.instances.length} timestamp occurrences
                                </summary>
                                <div style={{ marginTop: '6px', maxHeight: '120px', overflowY: 'auto', background: '#0a0a0a', padding: '6px 10px', borderRadius: '4px', border: '1px solid #222' }}>
                                  {evt.instances.map((inst, i) => (
                                    <div key={i} style={{ fontSize: '10px', color: '#64748b', padding: '2px 0', borderBottom: i < evt.instances.length - 1 ? '1px solid #1a1a1a' : 'none' }}>
                                      <span style={{ color: '#facc15', marginRight: '8px' }}>#{i + 1}</span>
                                      <span>{inst.timestamp ? new Date(inst.timestamp).toLocaleString() : 'Unknown time'}</span>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p style={{ color: '#94a3b8', fontSize: '12px' }}>
                      No agent execution logs available for this incident.
                    </p>
                  )}
                </div>
              )}

              {/* Human Approval Gate */}
              <section className="approval">
                <h3>HUMAN APPROVAL GATE</h3>
                <p className="muted" style={{ marginBottom: '16px', fontSize: '11px', lineHeight: '1.5' }}>
                  Review the sandbox-verified remediation and forensic intelligence above. Authorizing this proposal will create an isolated GitHub branch, commit the verified fix, and open a Draft Pull Request on GitHub for engineering review.
                </p>

                {['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING'].includes(detail.context.status) ? (
                  <div style={{ padding: '20px', border: '1px solid rgba(56, 189, 248, 0.4)', background: '#081528', marginBottom: '20px', borderRadius: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ color: '#38bdf8', fontSize: '18px', animation: 'pulse 1.2s infinite' }}>⚡</span>
                        <div>
                          <strong style={{ color: '#38bdf8', fontSize: '12px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            Autonomous AI SRE Subagents Collaborating
                          </strong>
                          <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                            Executing active investigation & sandbox verification lifecycle...
                          </span>
                        </div>
                      </div>
                      <span style={{
                        backgroundColor: 'rgba(56, 189, 248, 0.2)',
                        color: '#38bdf8',
                        border: '1px solid rgba(56, 189, 248, 0.4)',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        padding: '3px 10px',
                        borderRadius: '12px',
                        letterSpacing: '0.05em',
                      }}>
                        ACTIVE STAGE: {detail.context.status.replace('_', ' ')}
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginTop: '12px' }}>
                      <div style={{ background: '#0f172a', border: '1px solid rgba(16, 185, 129, 0.4)', padding: '10px 12px', borderRadius: '4px' }}>
                        <span style={{ color: '#34d399', fontSize: '10px', fontWeight: 'bold', display: 'block' }}>✔ 1. TRIAGE SUBAGENT</span>
                        <span style={{ color: '#94a3b8', fontSize: '10px' }}>Telemetry Ingested & Model Armor Sanitized</span>
                      </div>
                      <div style={{ background: '#0f172a', border: `1px solid ${['RCA', 'PATCHING', 'SANDBOX_TESTING'].includes(detail.context.status) ? 'rgba(16, 185, 129, 0.4)' : 'rgba(56, 189, 248, 0.4)'}`, padding: '10px 12px', borderRadius: '4px' }}>
                        <span style={{ color: ['RCA', 'PATCHING', 'SANDBOX_TESTING'].includes(detail.context.status) ? '#34d399' : '#38bdf8', fontSize: '10px', fontWeight: 'bold', display: 'block' }}>
                          {['RCA', 'PATCHING', 'SANDBOX_TESTING'].includes(detail.context.status) ? '✔' : '⚡'} 2. CODE INSPECTOR
                        </span>
                        <span style={{ color: '#94a3b8', fontSize: '10px' }}>GitHub AST Blame & Commit Forensics</span>
                      </div>
                      <div style={{ background: '#0f172a', border: `1px solid ${['SANDBOX_TESTING'].includes(detail.context.status) ? 'rgba(16, 185, 129, 0.4)' : detail.context.status === 'RCA' ? 'rgba(56, 189, 248, 0.7)' : '#1e293b'}`, padding: '10px 12px', borderRadius: '4px' }}>
                        <span style={{ color: ['SANDBOX_TESTING'].includes(detail.context.status) ? '#34d399' : detail.context.status === 'RCA' ? '#38bdf8' : '#64748b', fontSize: '10px', fontWeight: 'bold', display: 'block' }}>
                          {['SANDBOX_TESTING'].includes(detail.context.status) ? '✔' : detail.context.status === 'RCA' ? '🧠' : '○'} 3. GEMINI 3.7+ RCA
                        </span>
                        <span style={{ color: '#94a3b8', fontSize: '10px' }}>Root Cause Deduction & Patch Synthesis</span>
                      </div>
                      <div style={{ background: '#0f172a', border: `1px solid ${detail.context.status === 'SANDBOX_TESTING' ? 'rgba(234, 179, 8, 0.7)' : '#1e293b'}`, padding: '10px 12px', borderRadius: '4px' }}>
                        <span style={{ color: detail.context.status === 'SANDBOX_TESTING' ? '#facc15' : '#64748b', fontSize: '10px', fontWeight: 'bold', display: 'block' }}>
                          {detail.context.status === 'SANDBOX_TESTING' ? '🧪' : '○'} 4. SANDBOX VERIFIER
                        </span>
                        <span style={{ color: '#94a3b8', fontSize: '10px' }}>Isolated Subprocess Test Execution</span>
                      </div>
                    </div>
                  </div>
                ) : detail.context.status === 'DEPLOYED' ? (
                  <div>
                    <p className="approved" style={{ marginBottom: detail.approval?.pr_url ? '16px' : '0', backgroundColor: '#052e16', borderColor: '#10b981', color: '#6ee7b7' }}>
                      ✔ DEPLOYED TO PRODUCTION{detail.approval?.actor ? ` · REMEDIATED BY ${detail.approval.actor}` : ''}
                    </p>
                    {detail.approval?.pr_url && (
                      <div style={{ marginTop: '14px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <a
                          href={detail.approval.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="approve"
                          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#059669', color: '#ffffff', padding: '10px 16px', borderRadius: '4px', fontWeight: 'bold' }}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M5 3.254V3.25v.004a.75.75 0 110-.004v.004zm0 9.492v.004a.75.75 0 110-.004v.004zm6-6.492v.004a.75.75 0 110-.004v.004z"/>
                            <path d="M5 1a2.25 2.25 0 00-1.5 3.922v6.156a2.25 2.25 0 101.5 0V7.072a4.502 4.502 0 013.75 1.178V5.84a3.003 3.003 0 00-3.75-1.12V4.922A2.25 2.25 0 005 1zm6 3.5a2.25 2.25 0 100 4.5 2.25 2.25 0 000-4.5z"/>
                          </svg>
                          VIEW PR #{detail.approval.pr_number ?? ''} ↗
                        </a>
                        {detail.approval.deployed_at && (
                          <span style={{ color: '#6ee7b7', fontSize: '11px', fontFamily: 'monospace' }}>
                            DEPLOYED AT: {new Date(detail.approval.deployed_at).toLocaleTimeString()}
                          </span>
                        )}
                        {detail.approval.branch && (
                          <span style={{ color: '#94a3b8', fontSize: '11px', fontFamily: 'monospace' }}>
                            BRANCH: {detail.approval.branch}
                          </span>
                        )}
                        {detail.context.issue_url && (
                          <a href={detail.context.issue_url} target="_blank" rel="noreferrer" style={{ color: '#64748b', fontSize: '11px', textDecoration: 'underline' }}>
                            VIEW ISSUE #{detail.context.issue_number || ''}
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ) : detail.context.status === 'RESOLVED' ? (
                  <div>
                    <p className="approved" style={{ marginBottom: detail.approval?.pr_url ? '16px' : '0', backgroundColor: '#160b24', borderColor: '#a855f7', color: '#d8b4fe' }}>
                      ✔ RESOLVED (PULL REQUEST MERGED ON GITHUB) · DEPLOYMENT IN-FLIGHT{detail.approval?.actor ? ` · REMEDIATED BY ${detail.approval.actor}` : ''}
                    </p>
                    <div style={{ marginTop: '14px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {detail.approval?.pr_url && (
                        <a
                          href={detail.approval.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="approve"
                          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#8250df', color: '#ffffff', padding: '10px 16px', borderRadius: '4px', fontWeight: 'bold' }}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M5 3.254V3.25v.004a.75.75 0 110-.004v.004zm0 9.492v.004a.75.75 0 110-.004v.004zm6-6.492v.004a.75.75 0 110-.004v.004z"/>
                            <path d="M5 1a2.25 2.25 0 00-1.5 3.922v6.156a2.25 2.25 0 101.5 0V7.072a4.502 4.502 0 013.75 1.178V5.84a3.003 3.003 0 00-3.75-1.12V4.922A2.25 2.25 0 005 1zm6 3.5a2.25 2.25 0 100 4.5 2.25 2.25 0 000-4.5z"/>
                          </svg>
                          VIEW MERGED PR #{detail.approval.pr_number ?? ''} ↗
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => void markDeployed()}
                        style={{ background: '#059669', border: 'none', color: '#ffffff', padding: '10px 16px', borderRadius: '4px', fontWeight: 'bold', fontSize: '11px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                      >
                        🚀 MARK AS DEPLOYED
                      </button>
                      {detail.approval?.branch && (
                        <span style={{ color: '#94a3b8', fontSize: '11px', fontFamily: 'monospace' }}>
                          BRANCH: {detail.approval.branch}
                        </span>
                      )}
                      {detail.context.issue_url && (
                        <a href={detail.context.issue_url} target="_blank" rel="noreferrer" style={{ color: '#64748b', fontSize: '11px', textDecoration: 'underline' }}>
                          VIEW ISSUE #{detail.context.issue_number || ''}
                        </a>
                      )}
                    </div>
                  </div>
                ) : detail.context.status === 'APPROVED' ? (
                  <div>
                    <p className="approved" style={{ marginBottom: detail.approval?.pr_url ? '16px' : '0' }}>
                      APPROVED (PR CREATED) BY {detail.approval?.actor ?? 'REVIEWER'}
                    </p>
                    {detail.approval?.pr_url && (
                      <div style={{ marginTop: '14px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <a
                          href={detail.approval.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="approve"
                          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#238636', color: '#ffffff', padding: '10px 16px', borderRadius: '4px', fontWeight: 'bold' }}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
                          </svg>
                          VIEW DRAFT PR #{detail.approval.pr_number ?? ''} ↗
                        </a>
                        {detail.approval.branch && (
                          <span style={{ color: '#94a3b8', fontSize: '11px', fontFamily: 'monospace' }}>
                            BRANCH: {detail.approval.branch}
                          </span>
                        )}
                        {detail.context.issue_url && (
                          <a href={detail.context.issue_url} target="_blank" rel="noreferrer" style={{ color: '#64748b', fontSize: '11px', textDecoration: 'underline' }}>
                            VIEW ISSUE #{detail.context.issue_number || ''}
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ) : detail.context.status === 'DEPLOYED' ? (
                  <div style={{ padding: '16px', background: '#0b1612', border: '1px solid #059669', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '20px' }}>✅</span>
                    <div>
                      <strong style={{ color: '#34d399', fontSize: '13px', display: 'block' }}>INCIDENT COMPLETED & MARKED AS DONE</strong>
                      <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                        This fix has been verified and marked as completed in production.
                      </span>
                    </div>
                  </div>
                ) : (
                  <>
                    <p style={{ marginBottom: '16px' }}>
                      {detail.context.issue_url && <a href={detail.context.issue_url} target="_blank" rel="noreferrer">VIEW ISSUE</a>}
                      {detail.approval?.pr_url && <> · <a href={detail.approval.pr_url} target="_blank" rel="noreferrer">VIEW DRAFT PR #{detail.approval.pr_number}</a></>}
                    </p>
                    {detail.context.status === 'PR_CREATION_FAILED' && (
                      <p className="error">PR CREATION FAILED: {detail.approval?.failure ?? 'Retry PR creation to resume.'}</p>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                      <button className="approve" disabled={approving} onClick={() => void approve()}>
                        {approving ? 'CREATING DRAFT PR…' : detail.context.status === 'PR_CREATION_FAILED' ? 'RETRY DRAFT PR CREATION' : 'AUTHORIZE & CREATE DRAFT PR'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void markIncidentDone(detail.context.incident_id)}
                        disabled={completingIds.includes(detail.context.incident_id)}
                        style={{
                          background: '#065f46',
                          color: '#a7f3d0',
                          border: '1px solid #059669',
                          padding: '10px 18px',
                          borderRadius: '4px',
                          fontWeight: 'bold',
                          fontSize: '11px',
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        {completingIds.includes(detail.context.incident_id) ? '⏳ MARKING DONE…' : '✓ MARK AS DONE'}
                      </button>
                    </div>
                  </>
                )}
              </section>
            </section>
          )}
        </div>
      )
    })}</div>}
      
      {totalPages > 1 && (
        <div className="pagination" style={{ display: 'flex', gap: '1rem', marginTop: '1rem', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={{ padding: '0.25rem 0.5rem', background: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>PREV</button>
          <span style={{ fontSize: '0.875rem' }}>PAGE {page + 1} OF {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ padding: '0.25rem 0.5rem', background: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>NEXT</button>
        </div>
      )}

      {/* Floating Batch Action Bar */}
      {selectedIncidentIds.length > 0 && (
        <div style={{
          position: 'fixed',
          bottom: '28px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#091322',
          border: '1px solid #0284c7',
          boxShadow: '0 20px 30px -10px rgba(0, 0, 0, 0.8), 0 0 25px rgba(2, 132, 199, 0.4)',
          padding: '12px 24px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          zIndex: 1000,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>📦</span>
            <div>
              <strong style={{ color: '#38bdf8', fontSize: '12px', display: 'block', letterSpacing: '0.05em' }}>
                {selectedIncidentIds.length} {selectedIncidentIds.length === 1 ? 'INCIDENT' : 'INCIDENTS'} SELECTED
              </strong>
              <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                Bundle into consolidated PR or mark as complete
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              onClick={() => { setShowBatchModal(true); setBatchResult(null); }}
              style={{
                background: '#0284c7',
                color: '#ffffff',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '4px',
                fontWeight: 'bold',
                fontSize: '11px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                letterSpacing: '0.05em',
              }}
            >
              🚀 BUNDLE & CREATE CONSOLIDATED PR
            </button>
            <button
              type="button"
              onClick={() => void batchMarkSelectedDone()}
              disabled={batchCompleting}
              style={{
                background: '#065f46',
                color: '#a7f3d0',
                border: '1px solid #059669',
                padding: '8px 16px',
                borderRadius: '4px',
                fontWeight: 'bold',
                fontSize: '11px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                letterSpacing: '0.05em',
              }}
            >
              {batchCompleting ? '⏳ MARKING DONE…' : `✅ MARK AS DONE (${selectedIncidentIds.length})`}
            </button>
            <button
              type="button"
              onClick={() => setSelectedIncidentIds([])}
              style={{
                background: 'transparent',
                border: '1px solid #475569',
                color: '#94a3b8',
                padding: '8px 12px',
                borderRadius: '4px',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              CLEAR
            </button>
          </div>
        </div>
      )}

      {/* Batch Review & Approval Modal */}
      {showBatchModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1100,
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: '#0b0f19',
            border: '1px solid #1e293b',
            borderRadius: '8px',
            width: '90%',
            maxWidth: '650px',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>📦</span> BATCH INCIDENT REMEDIATION & CONSOLIDATED PR
                </h3>
                <span style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px', display: 'block' }}>
                  Consolidating {selectedIncidentIds.length} verified automated fixes into a single release branch and Draft PR.
                </span>
              </div>
              <button onClick={() => setShowBatchModal(false)} style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: '18px', cursor: 'pointer' }}>×</button>
            </div>

            <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
              {batchResult ? (
                <div style={{ background: '#052e16', border: '1px solid #10b981', padding: '20px', borderRadius: '6px', textAlign: 'center' }}>
                  <span style={{ fontSize: '32px', display: 'block', marginBottom: '8px' }}>🎉</span>
                  <strong style={{ color: '#6ee7b7', fontSize: '14px', display: 'block', marginBottom: '6px' }}>
                    CONSOLIDATED DRAFT PR #{batchResult.pr_number} CREATED!
                  </strong>
                  <p style={{ color: '#a7f3d0', fontSize: '12px', marginBottom: '16px' }}>
                    Successfully bundled {selectedIncidentIds.length} incident fixes onto release branch <code>{batchResult.branch}</code>.
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
                    <a
                      href={batchResult.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        background: '#059669',
                        color: '#ffffff',
                        padding: '8px 16px',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                        fontSize: '12px',
                        textDecoration: 'none',
                      }}
                    >
                      VIEW DRAFT PR #{batchResult.pr_number} ↗
                    </a>
                    <button
                      type="button"
                      onClick={() => { setShowBatchModal(false); setSelectedIncidentIds([]); }}
                      style={{ background: '#1e293b', border: 'none', color: '#cbd5e1', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      DONE
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h4 style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px' }}>
                    CONSTITUENT INCIDENTS ({selectedIncidentIds.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
                    {selectedIncidentIds.map(id => {
                      const inc = incidents.find(i => i.incident_id === id)
                      return (
                        <div key={id} style={{ background: '#0f172a', border: '1px solid #1e293b', padding: '12px', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ color: '#f8fafc', fontWeight: 'bold', fontSize: '12px' }}>{inc?.title || id}</span>
                              <span style={{ color: '#38bdf8', fontSize: '10px', background: '#082f49', padding: '1px 6px', borderRadius: '3px' }}>{inc?.service}</span>
                            </div>
                            <span style={{ color: '#64748b', fontSize: '10px', fontFamily: 'monospace' }}>ID: {id}</span>
                          </div>
                          <span style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold' }}>VERIFIED ✔</span>
                        </div>
                      )
                    })}
                  </div>

                  <div style={{ background: '#1e1b4b', border: '1px solid #6366f1', padding: '14px', borderRadius: '6px', marginBottom: '20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ color: '#a5b4fc', fontSize: '14px' }}>🛡️</span>
                      <strong style={{ color: '#c7d2fe', fontSize: '11px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                        Zero-Trust Release Governance
                      </strong>
                    </div>
                    <p style={{ color: '#e0e7ff', fontSize: '11px', margin: 0, lineHeight: '1.4' }}>
                      Authorizing this batch will synthesize a unified release branch, run cross-patch sandbox verification, and open a single Consolidated GitHub Draft PR signed with reviewer authority (<strong>{currentUser?.email || 'on-call'}</strong>).
                    </p>
                  </div>

                  {detailError && <p className="error" role="alert" style={{ marginBottom: '16px' }}>{detailError}</p>}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button
                      type="button"
                      onClick={() => setShowBatchModal(false)}
                      style={{ background: 'transparent', border: '1px solid #475569', color: '#cbd5e1', padding: '10px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      disabled={batchApproving}
                      onClick={() => void executeBatchApproval()}
                      style={{
                        background: '#0284c7',
                        border: 'none',
                        color: '#ffffff',
                        padding: '10px 20px',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                        fontSize: '12px',
                        cursor: batchApproving ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      {batchApproving ? '⏳ BUNDLING & OPENING PR…' : `AUTHORIZE & OPEN CONSOLIDATED PR (${selectedIncidentIds.length} FIXES)`}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
      </>
    ) : (
      <section className="settings-panel" style={{ paddingTop: '40px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <p className="eyebrow" style={{ margin: '0 0 6px 0' }}>SYSTEM CONFIGURATION</p>
            <h2 style={{ color: 'white', textTransform: 'uppercase', letterSpacing: '2px', margin: 0, fontSize: '24px' }}>Settings</h2>
          </div>
        </div>

        {/* Settings Subtab Navigation */}
        <div className="settings-subtabs" style={{ display: 'flex', gap: '10px', borderBottom: '1px solid #222', marginBottom: '28px', paddingBottom: '0', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`settings-subtab-btn ${settingsTab === 'engine' ? 'active' : ''}`}
            onClick={() => { setSettingsTab('engine'); setTestResult(null); }}
          >
            <span>⚡</span> ENGINE & AI
          </button>
          <button
            type="button"
            className={`settings-subtab-btn ${settingsTab === 'notifications' ? 'active' : ''}`}
            onClick={() => { setSettingsTab('notifications'); setTestResult(null); }}
          >
            <span>🔔</span> NOTIFICATIONS & WEBHOOKS
          </button>
          <button
            type="button"
            className={`settings-subtab-btn ${settingsTab === 'governance' ? 'active' : ''}`}
            onClick={() => { setSettingsTab('governance'); setTestResult(null); }}
          >
            <span>🛡️</span> SECURITY & GOVERNANCE
          </button>
          <button
            type="button"
            className={`settings-subtab-btn ${settingsTab === 'danger' ? 'active' : ''}`}
            onClick={() => { setSettingsTab('danger'); setTestResult(null); }}
          >
            <span>⚠️</span> DANGER ZONE
          </button>
        </div>

        {settingsTab === 'engine' && (
          <>
            <div style={{ border: '1px solid #222', padding: '32px', backgroundColor: '#111', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Gemini 3.5 & 3.7 Foundation Models</h3>
                    <span style={{ 
                      fontSize: '10px', 
                      fontWeight: 'bold', 
                      padding: '3px 8px', 
                      borderRadius: '4px',
                      letterSpacing: '0.05em',
                      backgroundColor: 'rgba(56, 189, 248, 0.15)',
                      color: '#38bdf8',
                      border: '1px solid rgba(56, 189, 248, 0.4)'
                    }}>
                      ACTIVE: {geminiModel.toUpperCase()}
                    </span>
                  </div>
                  <p style={{ color: '#94a3b8', fontSize: '12px', lineHeight: '1.6', margin: '6px 0 0 0' }}>
                    Select the Google Gemini foundation model used for autonomous site reliability engineering, root cause analysis, and code patch synthesis.
                  </p>
                </div>
                {savingModel && <span style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold' }}>SAVING MODEL…</span>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginTop: '20px' }}>
                {availableModels.map(model => {
                  const isSelected = geminiModel === model.id
                  return (
                    <div 
                      key={model.id}
                      onClick={() => void selectGeminiModel(model.id)}
                      style={{
                        border: `1px solid ${isSelected ? '#38bdf8' : '#2a2a2a'}`,
                        backgroundColor: isSelected ? 'rgba(56, 189, 248, 0.06)' : '#161616',
                        padding: '20px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <span style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '13px' }}>{model.name}</span>
                          <span style={{ 
                            fontSize: '9px', 
                            fontWeight: 'bold', 
                            padding: '2px 6px', 
                            borderRadius: '3px',
                            backgroundColor: isSelected ? '#38bdf8' : '#333',
                            color: isSelected ? '#000000' : '#cbd5e1'
                          }}>
                            {model.badge}
                          </span>
                        </div>
                        <p style={{ color: '#94a3b8', fontSize: '11px', lineHeight: '1.5', margin: '0 0 12px 0' }}>
                          {model.description}
                        </p>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '10px', borderTop: '1px solid #222', fontSize: '10px' }}>
                        <span style={{ color: '#64748b' }}>LATENCY: <strong style={{ color: '#e2e8f0' }}>{model.latency}</strong></span>
                        <span style={{ color: isSelected ? '#38bdf8' : '#64748b', fontWeight: 'bold' }}>
                          {isSelected ? '✔ ACTIVE' : 'SELECT ›'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {settingsTab === 'notifications' && (
          <div className="notifications-settings-container">
            {/* Global Notification Event Triggers Card */}
            <div style={{ border: '1px solid #222', padding: '24px 32px', backgroundColor: '#111', marginBottom: '24px' }}>
              <h3 style={{ color: '#ffffff', margin: '0 0 8px 0', fontSize: '14px' }}>Incident Alert Triggers</h3>
              <p style={{ color: '#94a3b8', fontSize: '12px', margin: '0 0 16px 0', lineHeight: '1.5' }}>
                Select the incident lifecycle events that will automatically dispatch push notifications across configured channels.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', color: '#cbd5e1' }}>
                  <input
                    type="checkbox"
                    checked={notifications.triggers.on_incident_detected}
                    onChange={(e) => {
                      const updated = { ...notifications, triggers: { ...notifications.triggers, on_incident_detected: e.target.checked } }
                      setNotifications(updated)
                      void saveNotifications(updated)
                    }}
                    style={{ accentColor: '#38bdf8', width: '16px', height: '16px' }}
                  />
                  <span>Incident Ingested / Detected</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', color: '#cbd5e1' }}>
                  <input
                    type="checkbox"
                    checked={notifications.triggers.on_awaiting_approval}
                    onChange={(e) => {
                      const updated = { ...notifications, triggers: { ...notifications.triggers, on_awaiting_approval: e.target.checked } }
                      setNotifications(updated)
                      void saveNotifications(updated)
                    }}
                    style={{ accentColor: '#38bdf8', width: '16px', height: '16px' }}
                  />
                  <span>Remediation Verified (Awaiting Human Approval)</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', color: '#cbd5e1' }}>
                  <input
                    type="checkbox"
                    checked={notifications.triggers.on_pr_approved}
                    onChange={(e) => {
                      const updated = { ...notifications, triggers: { ...notifications.triggers, on_pr_approved: e.target.checked } }
                      setNotifications(updated)
                      void saveNotifications(updated)
                    }}
                    style={{ accentColor: '#38bdf8', width: '16px', height: '16px' }}
                  />
                  <span>Pull Request Created / Merged</span>
                </label>
              </div>
            </div>

            {testResult && (
              <div 
                style={{ 
                  padding: '16px 20px', 
                  border: `1px solid ${testResult.success ? '#10b981' : '#ef4444'}`, 
                  backgroundColor: testResult.success ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', 
                  marginBottom: '24px', 
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }}
              >
                <span style={{ fontSize: '16px' }}>{testResult.success ? '✔' : '✖'}</span>
                <div>
                  <strong style={{ display: 'block', color: testResult.success ? '#34d399' : '#f87171', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {testResult.channel.toUpperCase()} TEST RESULT: {testResult.success ? 'DELIVERY SUCCESSFUL' : 'DELIVERY FAILED'}
                  </strong>
                  <span style={{ color: '#cbd5e1', fontSize: '11px' }}>{testResult.message}</span>
                </div>
              </div>
            )}

            {/* Channels Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '24px', marginBottom: '24px' }}>
              {/* Channel 1: Email (SMTP) */}
              <div style={{ border: '1px solid #222', padding: '28px', backgroundColor: '#111', borderRadius: '6px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '18px' }}>✉</span>
                      <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Email (SMTP)</h3>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={notifications.email.enabled}
                        onChange={(e) => {
                          const updated = { ...notifications, email: { ...notifications.email, enabled: e.target.checked } }
                          setNotifications(updated)
                          void saveNotifications(updated)
                        }}
                        style={{ accentColor: '#38bdf8', width: '18px', height: '18px' }}
                      />
                      <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 'bold', color: notifications.email.enabled ? '#34d399' : '#64748b' }}>
                        {notifications.email.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </label>
                  </div>
                  <p style={{ color: '#94a3b8', fontSize: '11px', lineHeight: '1.5', margin: '0 0 16px 0' }}>
                    Send formatted HTML incident reports directly to on-call engineers and team distribution lists via SMTP.
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px', marginBottom: '12px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>SMTP Host</label>
                      <input
                        type="text"
                        placeholder="smtp.gmail.com"
                        value={notifications.email.smtp_host}
                        onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, smtp_host: e.target.value } })}
                        style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Port</label>
                      <input
                        type="number"
                        placeholder="587"
                        value={notifications.email.smtp_port}
                        onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, smtp_port: Number(e.target.value) } })}
                        style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Username</label>
                      <input
                        type="text"
                        placeholder="alerts@company.com"
                        value={notifications.email.username}
                        onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, username: e.target.value } })}
                        style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Password / App Key</label>
                      <input
                        type="password"
                        placeholder="••••••••••••"
                        value={notifications.email.password || ''}
                        onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, password: e.target.value } })}
                        style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                      />
                    </div>
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>From Address</label>
                    <input
                      type="text"
                      placeholder="NightZero Alerts <alerts@company.com>"
                      value={notifications.email.from_address}
                      onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, from_address: e.target.value } })}
                      style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                    />
                  </div>

                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Recipients (comma separated)</label>
                    <input
                      type="text"
                      placeholder="oncall@company.com, team@company.com"
                      value={Array.isArray(notifications.email.to_addresses) ? notifications.email.to_addresses.join(', ') : notifications.email.to_addresses}
                      onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, to_addresses: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })}
                      style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                    />
                  </div>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px', color: '#cbd5e1', marginBottom: '18px' }}>
                    <input
                      type="checkbox"
                      checked={notifications.email.use_tls}
                      onChange={(e) => setNotifications({ ...notifications, email: { ...notifications.email, use_tls: e.target.checked } })}
                      style={{ accentColor: '#38bdf8' }}
                    />
                    <span>Enable STARTTLS Security</span>
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid #222', paddingTop: '16px' }}>
                  <button
                    type="button"
                    disabled={testingChannel === 'email' || !notifications.email.smtp_host}
                    onClick={() => void testNotificationChannel('email')}
                    style={{ flex: 1, background: '#1e293b', border: '1px solid #334155', color: '#38bdf8', padding: '8px 12px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    {testingChannel === 'email' ? 'TESTING…' : 'SEND TEST EMAIL'}
                  </button>
                  <button
                    type="button"
                    disabled={savingNotifications}
                    onClick={() => void saveNotifications(notifications)}
                    style={{ background: '#38bdf8', border: 'none', color: '#000', padding: '8px 16px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    SAVE
                  </button>
                </div>
              </div>

              {/* Channel 2: Telegram */}
              <div style={{ border: '1px solid #222', padding: '28px', backgroundColor: '#111', borderRadius: '6px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '18px' }}>✈</span>
                      <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Telegram Bot</h3>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={notifications.telegram.enabled}
                        onChange={(e) => {
                          const updated = { ...notifications, telegram: { ...notifications.telegram, enabled: e.target.checked } }
                          setNotifications(updated)
                          void saveNotifications(updated)
                        }}
                        style={{ accentColor: '#38bdf8', width: '18px', height: '18px' }}
                      />
                      <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 'bold', color: notifications.telegram.enabled ? '#34d399' : '#64748b' }}>
                        {notifications.telegram.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </label>
                  </div>
                  <p style={{ color: '#94a3b8', fontSize: '11px', lineHeight: '1.5', margin: '0 0 16px 0' }}>
                    Broadcast real-time incident status alerts and one-click remediation links to an SRE Telegram group or channel.
                  </p>

                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Bot Token (from @BotFather)</label>
                    <input
                      type="password"
                      placeholder="123456789:ABCDefGhIjKlmnOpQrStUvWxYz"
                      value={notifications.telegram.bot_token}
                      onChange={(e) => setNotifications({ ...notifications, telegram: { ...notifications.telegram, bot_token: e.target.value } })}
                      style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                    />
                  </div>

                  <div style={{ marginBottom: '18px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Recipient Chat ID (from @userinfobot) / Group ID</label>
                    <input
                      type="text"
                      placeholder="e.g. 987654321 (Your User ID) or -1001234567890"
                      value={notifications.telegram.chat_id}
                      onChange={(e) => setNotifications({ ...notifications, telegram: { ...notifications.telegram, chat_id: e.target.value } })}
                      style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                    />
                    <span style={{ display: 'block', fontSize: '9px', color: '#64748b', marginTop: '4px' }}>Note: Telegram requires you to start a chat with your bot first (send <code>/start</code> in Telegram).</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid #222', paddingTop: '16px' }}>
                  <button
                    type="button"
                    disabled={testingChannel === 'telegram' || !notifications.telegram.bot_token || !notifications.telegram.chat_id}
                    onClick={() => void testNotificationChannel('telegram')}
                    style={{ flex: 1, background: '#1e293b', border: '1px solid #334155', color: '#38bdf8', padding: '8px 12px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    {testingChannel === 'telegram' ? 'TESTING…' : 'SEND TEST MESSAGE'}
                  </button>
                  <button
                    type="button"
                    disabled={savingNotifications}
                    onClick={() => void saveNotifications(notifications)}
                    style={{ background: '#38bdf8', border: 'none', color: '#000', padding: '8px 16px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    SAVE
                  </button>
                </div>
              </div>

              {/* Channel 3: Slack */}
              <div style={{ border: '1px solid #222', padding: '28px', backgroundColor: '#111', borderRadius: '6px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '18px' }}>💬</span>
                      <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Slack Webhook</h3>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={notifications.slack.enabled}
                        onChange={(e) => {
                          const updated = { ...notifications, slack: { ...notifications.slack, enabled: e.target.checked } }
                          setNotifications(updated)
                          void saveNotifications(updated)
                        }}
                        style={{ accentColor: '#38bdf8', width: '18px', height: '18px' }}
                      />
                      <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 'bold', color: notifications.slack.enabled ? '#34d399' : '#64748b' }}>
                        {notifications.slack.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </label>
                  </div>
                  <p style={{ color: '#94a3b8', fontSize: '11px', lineHeight: '1.5', margin: '0 0 16px 0' }}>
                    Deliver rich interactive Block Kit notifications with direct buttons to approve remediation PRs directly in Slack.
                  </p>

                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Incoming Webhook URL</label>
                    <input
                      type="password"
                      placeholder="https://hooks.slack.com/services/T00/B00/XXXX"
                      value={notifications.slack.webhook_url}
                      onChange={(e) => setNotifications({ ...notifications, slack: { ...notifications.slack, webhook_url: e.target.value } })}
                      style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                    />
                  </div>

                  <div style={{ marginBottom: '18px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Channel Override (optional)</label>
                    <input
                      type="text"
                      placeholder="#sre-incidents"
                      value={notifications.slack.channel}
                      onChange={(e) => setNotifications({ ...notifications, slack: { ...notifications.slack, channel: e.target.value } })}
                      style={{ width: '100%', background: '#1c1c1c', border: '1px solid #333', padding: '8px 10px', color: '#fff', fontSize: '11px', borderRadius: '4px' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid #222', paddingTop: '16px' }}>
                  <button
                    type="button"
                    disabled={testingChannel === 'slack' || !notifications.slack.webhook_url}
                    onClick={() => void testNotificationChannel('slack')}
                    style={{ flex: 1, background: '#1e293b', border: '1px solid #334155', color: '#38bdf8', padding: '8px 12px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    {testingChannel === 'slack' ? 'TESTING…' : 'SEND TEST SLACK'}
                  </button>
                  <button
                    type="button"
                    disabled={savingNotifications}
                    onClick={() => void saveNotifications(notifications)}
                    style={{ background: '#38bdf8', border: 'none', color: '#000', padding: '8px 16px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    SAVE
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {settingsTab === 'governance' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Model Armor Section */}
            <div style={{ border: '1px solid #222', padding: '32px', backgroundColor: '#111', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '20px' }}>🛡️</span>
                  <div>
                    <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Model Armor (Inline AI Firewall)</h3>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Real-time prompt injection filtering, PII/secret redaction, and patch safety guardrails</span>
                  </div>
                </div>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 'bold',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  letterSpacing: '0.05em',
                  backgroundColor: 'rgba(16, 185, 129, 0.15)',
                  color: '#34d399',
                  border: '1px solid rgba(16, 185, 129, 0.4)',
                }}>
                  STATUS: {governance?.model_armor?.status || 'ACTIVE (INLINE)'}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginTop: '16px' }}>
                <div style={{ background: '#161616', border: '1px solid #2a2a2a', padding: '16px', borderRadius: '4px' }}>
                  <strong style={{ color: '#38bdf8', fontSize: '11px', display: 'block', marginBottom: '4px' }}>🛡️ Prompt Injection Shield</strong>
                  <p style={{ color: '#94a3b8', fontSize: '11px', margin: 0, lineHeight: '1.4' }}>
                    Blocks jailbreaks, delimiter hijacking, and system override attempts in incoming logs and GitHub issues.
                  </p>
                </div>
                <div style={{ background: '#161616', border: '1px solid #2a2a2a', padding: '16px', borderRadius: '4px' }}>
                  <strong style={{ color: '#34d399', fontSize: '11px', display: 'block', marginBottom: '4px' }}>🔒 Secret & PII Redactor</strong>
                  <p style={{ color: '#94a3b8', fontSize: '11px', margin: 0, lineHeight: '1.4' }}>
                    Inline tokenization of Google API keys, GitHub PATs, JWTs, AWS credentials, passwords, and private keys.
                  </p>
                </div>
                <div style={{ background: '#161616', border: '1px solid #2a2a2a', padding: '16px', borderRadius: '4px' }}>
                  <strong style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '4px' }}>🚫 Patch Safety Scanner</strong>
                  <p style={{ color: '#94a3b8', fontSize: '11px', margin: 0, lineHeight: '1.4' }}>
                    Validates generated code patches against arbitrary shell executions, eval(), and dangerous constructs.
                  </p>
                </div>
              </div>
            </div>

            {/* Agent Identity (SPIFFE) Section */}
            <div style={{ border: '1px solid #222', padding: '32px', backgroundColor: '#111', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '20px' }}>🆔</span>
                  <div>
                    <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Agent Identity (Zero-Trust SPIFFE Registry)</h3>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Cryptographically signed Agent Identity Tokens (AITs) and granular subagent personas</span>
                  </div>
                </div>
                <span style={{ fontSize: '10px', color: '#38bdf8', fontFamily: 'monospace' }}>
                  DOMAIN: {governance?.agent_identity?.domain || 'nightzero.io'} · {governance?.agent_identity?.signing_algorithm || 'HMAC-SHA256'}
                </span>
              </div>

              <div style={{ overflowX: 'auto', marginTop: '16px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #2a2a2a', textAlign: 'left', color: '#64748b' }}>
                      <th style={{ padding: '8px 12px' }}>PERSONA</th>
                      <th style={{ padding: '8px 12px' }}>SPIFFE ID</th>
                      <th style={{ padding: '8px 12px' }}>AUTHORIZED ACTION SCOPES</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(governance?.agent_identity?.registered_personas || [
                      { persona: 'triage', spiffe_id: 'spiffe://nightzero.io/agent/triage', scopes: ['telemetry.read', 'telemetry.deduplicate', 'context.create'] },
                      { persona: 'inspector', spiffe_id: 'spiffe://nightzero.io/agent/inspector', scopes: ['git.read', 'ast.inspect', 'commit.blame'] },
                      { persona: 'rca', spiffe_id: 'spiffe://nightzero.io/agent/rca', scopes: ['llm.infer', 'rca.synthesize', 'gap_analysis.generate'] },
                      { persona: 'sandbox', spiffe_id: 'spiffe://nightzero.io/agent/sandbox', scopes: ['sandbox.spawn', 'sandbox.test_exec', 'manifest.analyze'] },
                      { persona: 'remediation', spiffe_id: 'spiffe://nightzero.io/agent/remediation', scopes: ['github.branch.create', 'github.commit.write', 'github.pr.create'] },
                    ]).map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #1a1a1a' }}>
                        <td style={{ padding: '10px 12px', color: '#ffffff', fontWeight: 'bold' }}>{p.persona.toUpperCase()}</td>
                        <td style={{ padding: '10px 12px', color: '#38bdf8', fontFamily: 'monospace' }}>{p.spiffe_id}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {p.scopes.map((s, si) => (
                              <span key={si} style={{ backgroundColor: '#1a1a1a', color: '#94a3b8', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontFamily: 'monospace' }}>
                                {s}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Agent Gateway Section */}
            <div style={{ border: '1px solid #222', padding: '32px', backgroundColor: '#111', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '20px' }}>🌐</span>
                  <div>
                    <h3 style={{ color: '#ffffff', margin: 0, fontSize: '14px' }}>Agent Gateway (Unified Routing & Policy Engine)</h3>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Centralized RBAC policy enforcement intercepting all Agent-to-Tool and Agent-to-LLM communications</span>
                  </div>
                </div>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 'bold',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  letterSpacing: '0.05em',
                  backgroundColor: 'rgba(56, 189, 248, 0.15)',
                  color: '#38bdf8',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                }}>
                  GATEWAY: {governance?.agent_gateway?.status || 'ENFORCING'}
                </span>
              </div>

              <div style={{ overflowX: 'auto', marginTop: '16px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #2a2a2a', textAlign: 'left', color: '#64748b' }}>
                      <th style={{ padding: '8px 12px' }}>ACTION SCOPE</th>
                      <th style={{ padding: '8px 12px' }}>ALLOWED SUBAGENTS</th>
                      <th style={{ padding: '8px 12px' }}>AUTHORITY MODEL</th>
                      <th style={{ padding: '8px 12px' }}>MODEL ARMOR GUARD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(governance?.agent_gateway?.policies || [
                      { action_scope: 'telemetry.read', allowed_personas: ['triage'], requires_delegation: false, requires_model_armor: true },
                      { action_scope: 'git.read', allowed_personas: ['inspector', 'sandbox'], requires_delegation: false, requires_model_armor: false },
                      { action_scope: 'llm.infer', allowed_personas: ['rca', 'sandbox'], requires_delegation: false, requires_model_armor: true },
                      { action_scope: 'sandbox.spawn', allowed_personas: ['sandbox'], requires_delegation: false, requires_model_armor: false },
                      { action_scope: 'sandbox.test_exec', allowed_personas: ['sandbox'], requires_delegation: false, requires_model_armor: false },
                      { action_scope: 'github.branch.create', allowed_personas: ['remediation'], requires_delegation: true, requires_model_armor: false },
                      { action_scope: 'github.commit.write', allowed_personas: ['remediation'], requires_delegation: true, requires_model_armor: true },
                      { action_scope: 'github.pr.create', allowed_personas: ['remediation'], requires_delegation: true, requires_model_armor: false },
                    ]).map((rule, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #1a1a1a' }}>
                        <td style={{ padding: '10px 12px', color: '#38bdf8', fontFamily: 'monospace', fontWeight: 'bold' }}>{rule.action_scope}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {rule.allowed_personas.map((p, pi) => (
                              <span key={pi} style={{ backgroundColor: '#1e293b', color: '#93c5fd', padding: '2px 6px', borderRadius: '3px', fontSize: '10px' }}>
                                {p}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {rule.requires_delegation ? (
                            <span style={{ color: '#facc15', backgroundColor: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', padding: '2px 6px', borderRadius: '3px', fontSize: '9px', fontWeight: 'bold' }}>
                              USER_DELEGATED (HUMAN REVIEW)
                            </span>
                          ) : (
                            <span style={{ color: '#94a3b8', fontSize: '10px' }}>OWN_AUTHORITY</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {rule.requires_model_armor ? (
                            <span style={{ color: '#34d399', backgroundColor: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '2px 6px', borderRadius: '3px', fontSize: '9px', fontWeight: 'bold' }}>
                              🛡️ REQUIRED
                            </span>
                          ) : (
                            <span style={{ color: '#64748b', fontSize: '10px' }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {settingsTab === 'danger' && (
          <div style={{ border: '1px solid #222', padding: '32px', backgroundColor: '#111' }}>
            <h3 style={{ color: '#ef4444', marginBottom: '8px' }}>Danger Zone</h3>
            <p style={{ color: '#94a3b8', marginBottom: '24px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Permanently clear all existing incidents and history from the database.</p>
            <button 
              className="simulate-btn"
              style={{ backgroundColor: 'rgba(220, 38, 38, 0.2)' }}
              onClick={async () => {
                if (window.confirm('Are you sure you want to delete all incidents? This action cannot be undone.')) {
                  try {
                    const res = await fetch(`${api}/api/v1/incidents`, { method: 'DELETE' })
                    if (!res.ok) throw new Error('Failed to delete incidents')
                    setCurrentTab('dashboard')
                    setIncidents([])
                    setTotalIncidents(0)
                    setPage(0)
                  } catch (err) {
                    alert(err instanceof Error ? err.message : 'Error clearing incidents')
                  }
                }
              }}
            >
              DELETE ALL INCIDENTS
            </button>
          </div>
        )}
      </section>
    )}
  </main></div>
}