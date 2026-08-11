import { useEffect, useState } from 'react'
import { judgeToken } from './firebase'

type Incident = { incident_id: string; title: string; service: string; severity: string; status: string; created_at: string; issue_url?: string; pr_url?: string }
type CommandResult = { command: string[]; exit_code: number; output: string }
type IncidentDetail = {
  context: Incident & { source_commit: string; issue_number: number; issue_url?: string }
  rca: { root_cause: string; confidence: number; culprit_commit: string; proposed_patch: string; evidence: { kind: string; source: string; detail: string }[] }
  verification: { branch_name: string; file_path: string; diff: string; before: CommandResult; after: CommandResult; staging_status: string }
  approval: { actor?: string; action?: string; branch?: string; commit_sha?: string; pr_number?: number; pr_url?: string; failure?: string } | null
}

const api = import.meta.env.VITE_NIGHTZERO_API_URL ?? 'http://localhost:8080'
const stages = ['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'AWAITING_APPROVAL', 'APPROVED']
const terminalStatuses = new Set(['APPROVED'])

function StageRail({ status }: { status: string }) {
  const active = status === 'IDLE' ? -1 : Math.max(stages.indexOf(status), status === 'STAGING_VERIFIED' ? 4 : 0)
  return <ol className="stage-rail" aria-label="Incident lifecycle">
    {stages.map((stage, index) => <li className={index <= active ? 'complete' : ''} key={stage}>{stage.replace('_', ' ')}</li>)}
  </ol>
}

function TestResult({ label, result }: { label: string; result: CommandResult }) {
  return <article className={`test-result ${result.exit_code === 0 ? 'passed' : 'failed'}`}>
    <div><span>{label}</span><strong>{result.exit_code === 0 ? 'PASS' : 'FAIL'}</strong></div>
    <code>{result.command.join(' ')}</code><pre>{result.output}</pre>
  </article>
}

export default function Dashboard() {
  const [health, setHealth] = useState('LOADING')
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [totalIncidents, setTotalIncidents] = useState(0)
  const [page, setPage] = useState(0)
  const pageSize = 10
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [reviewer, setReviewer] = useState('sre-reviewer')
  const [token, setToken] = useState('nightzero-demo')
  const [approving, setApproving] = useState(false)
  const [simulating, setSimulating] = useState(false)

  useEffect(() => {
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
    const interval = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(interval)
  }, [page])

  const simulateOutage = async () => {
    setSimulating(true)
    setError('')
    try {
      const response = await fetch(`${api}/api/v1/simulate-incident`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to simulate outage')
      const newDetail = await response.json() as IncidentDetail
      setDetail(newDetail)
      // Switch back to page 0 when simulating new incident to see it
      setPage(0)
      setIncidents(current => [newDetail.context, ...current].slice(0, pageSize))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Simulation failed') } finally { setSimulating(false) }
  }

  const selectIncident = async (incident: Incident) => {
    setDetail(null); setDetailError('')
    try {
      const response = await fetch(`${api}/api/v1/incidents/${incident.incident_id}`)
      if (!response.ok) throw new Error('Incident detail is unavailable')
      setDetail(await response.json() as IncidentDetail)
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Incident detail is unavailable') }
  }

  const approve = async () => {
    if (!detail) return
    setApproving(true); setDetailError('')
    try {
      let firebaseToken: string | null = null
      if (reviewer.includes('@')) {
        const pwd = token || window.prompt('Firebase reviewer password')
        if (pwd) {
          try { firebaseToken = await judgeToken(reviewer, pwd) } catch { /* ignore if local */ }
        }
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (firebaseToken) headers['Authorization'] = `Bearer ${firebaseToken}`

      const response = await fetch(`${api}/api/v1/incidents/${detail.context.incident_id}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ actor: reviewer, token: token }),
      })
      const body = await response.json() as IncidentDetail | { error: string }
      if (!response.ok || 'error' in body) throw new Error('error' in body ? body.error : 'Approval failed')
      setDetail(body)
      setIncidents(current => current.map(item => item.incident_id === body.context.incident_id
        ? { ...item, status: body.context.status }
        : item))
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Approval failed') } finally { setApproving(false) }
  }

  const totalPages = Math.ceil(totalIncidents / pageSize)

  return <div className="console-shell"><aside className="sidebar" aria-label="Control panel navigation"><span className="mark">NZ</span><span className="nav-active">▥</span><span>◫</span><span>⚙</span><b>NIGHTZERO</b></aside><main className="dashboard">
    <header><p className="eyebrow">CONSOLE <span>›</span> INCIDENTS</p><div className="agent-status"><i className={health === 'IDLE' ? 'idle' : 'active'} /> AGENT: <strong>{health}</strong></div></header>
    <section className="hero"><div><p className="eyebrow">AUTONOMOUS INCIDENT RESPONSE</p><h1>OPERATIONS</h1></div><div className="metric"><span>OPEN INCIDENTS</span><strong>{totalIncidents}</strong></div><div className="metric"><span>DEMO TRIGGER</span><button className="simulate-btn" disabled={simulating} onClick={() => void simulateOutage()}>{simulating ? '⚡ SIMULATING…' : '⚡ SIMULATE OUTAGE'}</button></div></section>
    {error && <p className="error" role="alert">{error}</p>}<section className="incident-list"><div className="section-heading"><h2>DETECTED INCIDENTS</h2><span>REFRESH: 5S</span></div>{incidents.length === 0 ? <p className="empty">No incidents detected. The Agent is standing by.</p> : <div className="incident-table">{incidents.map(item => <button className="incident-row" onClick={() => void selectIncident(item)} key={item.incident_id}><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="incident-title">{item.title}</span><span>{item.service}</span><span className="status">{item.status.replaceAll('_', ' ')}</span><span>›</span></button>)}</div>}
      
      {totalPages > 1 && (
        <div className="pagination" style={{ display: 'flex', gap: '1rem', marginTop: '1rem', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={{ padding: '0.25rem 0.5rem', background: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>PREV</button>
          <span style={{ fontSize: '0.875rem' }}>PAGE {page + 1} OF {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ padding: '0.25rem 0.5rem', background: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>NEXT</button>
        </div>
      )}
    </section>
    {detailError && <p className="error" role="alert">{detailError}</p>}{detail && <section className="detail-panel"><div className="section-heading"><div><p className="eyebrow">INCIDENT {detail.context.incident_id}</p><h2>{detail.context.title}</h2></div><button className="close" onClick={() => setDetail(null)}>CLOSE ×</button></div><StageRail status={detail.context.status} />{detail.rca && <div className="detail-grid"><article><h3>ROOT CAUSE ANALYSIS</h3><p>{detail.rca.root_cause}</p><dl><dt>CONFIDENCE</dt><dd>{Math.round(detail.rca.confidence * 100)}%</dd><dt>CULPRIT COMMIT</dt><dd>{detail.rca.culprit_commit}</dd><dt>PATCH</dt><dd>{detail.rca.proposed_patch}</dd></dl></article><article><h3>EVIDENCE</h3>{detail.rca.evidence.map(evidence => <div className="evidence" key={`${evidence.kind}-${evidence.source}`}><span>{evidence.kind}</span><b>{evidence.source}</b><p>{evidence.detail}</p></div>)}</article></div>}{detail.verification && <><h3>ISOLATED SANDBOX VERIFICATION</h3><p className="muted">{detail.verification.branch_name} · {detail.verification.file_path} · {detail.verification.staging_status}</p><div className="test-grid"><TestResult label="BEFORE PATCH" result={detail.verification.before} /><TestResult label="AFTER PATCH" result={detail.verification.after} /></div><pre className="diff">{detail.verification.diff}</pre></>}<section className="approval"><h3>HUMAN APPROVAL GATE</h3><p>{detail.context.issue_url && <a href={detail.context.issue_url} target="_blank" rel="noreferrer">VIEW ISSUE</a>}{detail.approval?.pr_url && <> · <a href={detail.approval.pr_url} target="_blank" rel="noreferrer">VIEW DRAFT PR #{detail.approval.pr_number}</a></>}</p>{detail.context.status === 'APPROVED' ? <p className="approved">APPROVED BY {detail.approval?.actor ?? 'REVIEWER'}</p> : <>{detail.context.status === 'PR_CREATION_FAILED' && <p className="error">PR CREATION FAILED: {detail.approval?.failure ?? 'Retry approval to resume.'}</p>}<label>REVIEWER<input value={reviewer} onChange={event => setReviewer(event.target.value)} /></label><label>APPROVAL TOKEN<input type="password" value={token} onChange={event => setToken(event.target.value)} /></label><button className="approve" disabled={!reviewer || !token || approving} onClick={() => void approve()}>{approving ? 'AUTHORIZING…' : detail.context.status === 'PR_CREATION_FAILED' ? 'RETRY PR CREATION' : 'APPROVE PROPOSAL'}</button></>}</section></section>}
  </main></div>
}