import { useEffect, useState } from 'react'
import { type AuthUser, getStoredUser, logout, subscribeToAuth } from './firebase'
import Login from './Login'

type Incident = { incident_id: string; title: string; service: string; severity: string; status: string; created_at: string; issue_url?: string; pr_url?: string }
type CommandResult = { command: string[]; exit_code: number; output: string }
type IncidentDetail = {
  context: Incident & { source_commit: string; issue_number: number; issue_url?: string }
  rca: { root_cause: string; confidence: number; culprit_commit: string; proposed_patch: string; evidence: { kind: string; source: string; detail: string }[] }
  verification: { branch_name: string; file_path: string; diff: string; before: CommandResult; after: CommandResult; staging_status: string }
  approval: { actor?: string; action?: string; branch?: string; commit_sha?: string; pr_number?: number; pr_url?: string; failure?: string } | null
}

const api = import.meta.env.VITE_NIGHTZERO_API_URL ?? 'http://localhost:8080'
const stages = ['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'AWAITING_APPROVAL', 'APPROVED', 'RESOLVED']

function formatStatus(status: string) {
  if (status === 'APPROVED') return 'APPROVED (PR CREATED)'
  if (status === 'RESOLVED') return 'RESOLVED (MERGED)'
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
  }
  const active = stageMap[status] ?? (status === 'IDLE' ? -1 : 0)
  return <ol className="stage-rail" aria-label="Incident lifecycle">
    {stages.map((stage, index) => <li className={index <= active ? 'complete' : ''} key={stage}>{stage === 'APPROVED' ? 'APPROVED (PR CREATED)' : stage === 'RESOLVED' ? 'RESOLVED (MERGED)' : stage.replace('_', ' ')}</li>)}
  </ol>
}

function TestResult({ label, result }: { label: string; result: CommandResult }) {
  return <article className={`test-result ${result.exit_code === 0 ? 'passed' : 'failed'}`}>
    <div><span>{label}</span><strong>{result.exit_code === 0 ? 'PASS' : 'FAIL'}</strong></div>
    <code>{result.command.join(' ')}</code><pre>{result.output}</pre>
  </article>
}

export default function Dashboard() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(getStoredUser())
  const [currentTab, setCurrentTab] = useState<'dashboard' | 'settings'>('dashboard')
  const [health, setHealth] = useState('LOADING')
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [totalIncidents, setTotalIncidents] = useState(0)
  const [page, setPage] = useState(0)
  const pageSize = 10
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [approving, setApproving] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [simulationBanner, setSimulationBanner] = useState('')

  const openCount = incidents.filter(i => i.status !== 'APPROVED' && i.status !== 'RESOLVED').length
  const totalPages = Math.ceil(totalIncidents / pageSize)

  useEffect(() => {
    return subscribeToAuth(setCurrentUser)
  }, [])

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
    const interval = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(interval)
  }, [page, currentUser])

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
      setDetail(await response.json() as IncidentDetail)
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

  const handleLogout = async () => {
    await logout()
    setCurrentUser(null)
    setDetail(null)
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
    <header><p className="eyebrow">CONSOLE <span>›</span> INCIDENTS</p><div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}><div className="agent-status"><i className={health === 'IDLE' ? 'idle' : 'active'} /> AGENT: <strong>{health}</strong></div><div style={{ display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid #333333', padding: '8px 12px', background: '#111111' }}>{currentUser.photoURL ? <img src={currentUser.photoURL} alt={currentUser.name} style={{ width: '18px', height: '18px', borderRadius: '50%' }} /> : <span style={{ color: '#dc2626', fontWeight: 'bold', fontSize: '12px' }}>●</span>}<span style={{ color: '#cbd5e1', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.05em' }}>{currentUser.email}</span><button onClick={() => void handleLogout()} style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: '10px', letterSpacing: '0.05em', cursor: 'pointer', padding: '0 4px', textTransform: 'uppercase', fontWeight: 'bold' }} title="Sign Out">[LOGOUT]</button></div></div></header>
    <section className="hero"><div><p className="eyebrow">AUTONOMOUS INCIDENT RESPONSE</p><h1>OPERATIONS</h1></div><div className="metric"><span>OPEN INCIDENTS</span><strong>{openCount}</strong></div><div className="metric"><span>DEMO TRIGGER</span><button className="simulate-btn" disabled={simulating} onClick={() => void simulateOutage()}>{simulating ? '⚡ SIMULATING…' : '⚡ SIMULATE OUTAGE'}</button></div></section>
    {simulationBanner && <p className="approved" style={{ padding: '16px 24px', border: '1px solid #00d795', margin: '24px 0 0 0', backgroundColor: '#0b1612' }} role="alert">{simulationBanner}</p>}
    {error && <p className="error" role="alert">{error}</p>}<section className="incident-list"><div className="section-heading"><h2>DETECTED INCIDENTS</h2><span>REFRESH: 5S</span></div>{incidents.length === 0 ? <p className="empty">No incidents detected. The Agent is standing by.</p> : <div className="incident-table">{incidents.map(item => <div key={item.incident_id}><button className="incident-row" onClick={() => void selectIncident(item)}><span className={`severity severity-${item.severity.toLowerCase()}`}>{item.severity}</span><span className="incident-title">{item.title}</span><span>{item.service}</span><span className="status">{formatStatus(item.status)}</span><span>{detail?.context.incident_id === item.incident_id ? '⌄' : '›'}</span></button>{detail?.context.incident_id === item.incident_id && <section className="detail-panel" style={{ marginTop: 0, borderTop: 0, paddingBottom: '30px', borderBottom: '1px solid #1d2227' }}>{detailError && <p className="error" role="alert" style={{marginTop: 0, marginBottom: '24px'}}>{detailError}</p>}<div className="section-heading"><div><p className="eyebrow">INCIDENT {detail.context.incident_id}</p><h2>{detail.context.title}</h2></div><button className="close" onClick={() => setDetail(null)}>CLOSE ×</button></div><StageRail status={detail.context.status} />{detail.rca && <div className="detail-grid"><article><h3>ROOT CAUSE ANALYSIS</h3><p>{detail.rca.root_cause}</p><dl><dt>CONFIDENCE</dt><dd>{Math.round(detail.rca.confidence * 100)}%</dd><dt>CULPRIT COMMIT</dt><dd>{detail.rca.culprit_commit}</dd><dt>PATCH</dt><dd>{detail.rca.proposed_patch}</dd></dl></article><article><h3>EVIDENCE</h3>{detail.rca.evidence.map(evidence => <div className="evidence" key={`${evidence.kind}-${evidence.source}`}><span>{evidence.kind}</span><b>{evidence.source}</b><p>{evidence.detail}</p></div>)}</article></div>}{detail.verification && <><h3>ISOLATED SANDBOX VERIFICATION</h3><p className="muted">{detail.verification.branch_name} · {detail.verification.file_path} · {detail.verification.staging_status}</p><div className="test-grid"><TestResult label="BEFORE PATCH" result={detail.verification.before} /><TestResult label="AFTER PATCH" result={detail.verification.after} /></div><pre className="diff">{detail.verification.diff}</pre></>}<section className="approval"><h3>HUMAN APPROVAL GATE</h3><p className="muted" style={{ marginBottom: '16px', fontSize: '11px', lineHeight: '1.5' }}>Review the sandbox-verified remediation above. Authorizing this proposal will create an isolated GitHub branch, commit the verified fix, and open a Draft Pull Request on GitHub for engineering review.</p>{detail.context.status === 'RESOLVED' ? <div><p className="approved" style={{ marginBottom: detail.approval?.pr_url ? '16px' : '0', backgroundColor: '#160b24', borderColor: '#a855f7', color: '#d8b4fe' }}>✔ RESOLVED (PULL REQUEST MERGED ON GITHUB){detail.approval?.actor ? ` · REMEDIATED BY ${detail.approval.actor}` : ''}</p>{detail.approval?.pr_url && <div style={{ marginTop: '14px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}><a href={detail.approval.pr_url} target="_blank" rel="noreferrer" className="approve" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#8250df', color: '#ffffff', padding: '10px 16px', borderRadius: '4px', fontWeight: 'bold' }}><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.254V3.25v.004a.75.75 0 110-.004v.004zm0 9.492v.004a.75.75 0 110-.004v.004zm6-6.492v.004a.75.75 0 110-.004v.004z"/><path d="M5 1a2.25 2.25 0 00-1.5 3.922v6.156a2.25 2.25 0 101.5 0V7.072a4.502 4.502 0 013.75 1.178V5.84a3.003 3.003 0 00-3.75-1.12V4.922A2.25 2.25 0 005 1zm6 3.5a2.25 2.25 0 100 4.5 2.25 2.25 0 000-4.5z"/></svg>VIEW MERGED PR #{detail.approval.pr_number ?? ''} ↗</a>{detail.approval.branch && <span style={{ color: '#94a3b8', fontSize: '11px', fontFamily: 'monospace' }}>BRANCH: {detail.approval.branch}</span>}{detail.context.issue_url && <a href={detail.context.issue_url} target="_blank" rel="noreferrer" style={{ color: '#64748b', fontSize: '11px', textDecoration: 'underline' }}>VIEW ISSUE #{detail.context.issue_number || ''}</a>}</div>}</div> : detail.context.status === 'APPROVED' ? <div><p className="approved" style={{ marginBottom: detail.approval?.pr_url ? '16px' : '0' }}>APPROVED (PR CREATED) BY {detail.approval?.actor ?? 'REVIEWER'}</p>{detail.approval?.pr_url && <div style={{ marginTop: '14px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}><a href={detail.approval.pr_url} target="_blank" rel="noreferrer" className="approve" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#238636', color: '#ffffff', padding: '10px 16px', borderRadius: '4px', fontWeight: 'bold' }}><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/></svg>VIEW DRAFT PR #{detail.approval.pr_number ?? ''} ↗</a>{detail.approval.branch && <span style={{ color: '#94a3b8', fontSize: '11px', fontFamily: 'monospace' }}>BRANCH: {detail.approval.branch}</span>}{detail.context.issue_url && <a href={detail.context.issue_url} target="_blank" rel="noreferrer" style={{ color: '#64748b', fontSize: '11px', textDecoration: 'underline' }}>VIEW ISSUE #{detail.context.issue_number || ''}</a>}</div>}</div> : <><p style={{ marginBottom: '16px' }}>{detail.context.issue_url && <a href={detail.context.issue_url} target="_blank" rel="noreferrer">VIEW ISSUE</a>}{detail.approval?.pr_url && <> · <a href={detail.approval.pr_url} target="_blank" rel="noreferrer">VIEW DRAFT PR #{detail.approval.pr_number}</a></>}</p>{detail.context.status === 'PR_CREATION_FAILED' && <p className="error">PR CREATION FAILED: {detail.approval?.failure ?? 'Retry PR creation to resume.'}</p>}<button className="approve" disabled={approving} onClick={() => void approve()}>
        {approving ? 'CREATING DRAFT PR…' : detail.context.status === 'PR_CREATION_FAILED' ? 'RETRY DRAFT PR CREATION' : 'AUTHORIZE & CREATE DRAFT PR'}
      </button></>}</section></section>}</div>)}</div>}
      
      {totalPages > 1 && (
        <div className="pagination" style={{ display: 'flex', gap: '1rem', marginTop: '1rem', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={{ padding: '0.25rem 0.5rem', background: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>PREV</button>
          <span style={{ fontSize: '0.875rem' }}>PAGE {page + 1} OF {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ padding: '0.25rem 0.5rem', background: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>NEXT</button>
        </div>
      )}
    </section>
      </>
    ) : (
      <section className="settings-panel" style={{ paddingTop: '40px' }}>
        <h2 style={{ color: 'white', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '24px', fontSize: '20px' }}>Settings</h2>
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
      </section>
    )}
  </main></div>
}