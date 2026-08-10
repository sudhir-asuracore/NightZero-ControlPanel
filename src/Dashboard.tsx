import { useEffect, useState } from 'react'

type Incident = { incident_id: string; title: string; service: string; severity: string; status: string; created_at: string }
type CommandResult = { command: string[]; exit_code: number; output: string }
type IncidentDetail = {
  context: Incident & { source_commit: string; issue_number: number }
  rca: { root_cause: string; confidence: number; culprit_commit: string; proposed_patch: string; evidence: { kind: string; source: string; detail: string }[] }
  verification: { branch_name: string; file_path: string; diff: string; before: CommandResult; after: CommandResult; staging_status: string }
  approval: { actor?: string } | null
}

const api = import.meta.env.VITE_NIGHTZERO_API_URL ?? 'http://localhost:8080'
const stages = ['INGESTING', 'RCA', 'PATCHING', 'SANDBOX_TESTING', 'AWAITING_APPROVAL', 'APPROVED']

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
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [token, setToken] = useState('')
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const [healthResponse, incidentsResponse] = await Promise.all([fetch(`${api}/health`), fetch(`${api}/api/v1/incidents`)])
        if (!healthResponse.ok || !incidentsResponse.ok) throw new Error('Agent API is unavailable')
        setHealth((await healthResponse.json() as { status: string }).status)
        setIncidents(await incidentsResponse.json() as Incident[])
        setError('')
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Agent API is unavailable') }
    }
    void load()
    const interval = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(interval)
  }, [])

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
      const response = await fetch(`${api}/api/v1/incidents/${detail.context.incident_id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: reviewer, token }) })
      const body = await response.json() as IncidentDetail | { error: string }
      if (!response.ok || 'error' in body) throw new Error('error' in body ? body.error : 'Approval failed')
      setDetail(body); setToken('')
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Approval failed') } finally { setApproving(false) }
  }

  return <div className="console-shell"><aside className="sidebar" aria-label="Control panel navigation"><span className="mark">NZ</span><span className="nav-active">▥</span><span>◫</span><span>⚙</span><b>NIGHTZERO</b></aside><main className="dashboard">
    <header><p className="eyebrow">CONSOLE <span>›</span> INCIDENTS</p><div className="agent-status"><i className={health === 'IDLE' ? 'idle' : 'active'} /> AGENT: <strong>{health}</strong></div></header>
    <section className="hero"><div><p className="eyebrow">AUTONOMOUS INCIDENT RESPONSE</p><h1>OPERATIONS</h1></div><div className="metric"><span>OPEN INCIDENTS</span><strong>{incidents.length}</strong></div><div className="metric"><span>AGENT AVAILABILITY</span><strong className={health === 'IDLE' ? 'green' : 'red'}>{health}</strong></div></section>
    {error && <p className="error" role="alert">{error}</p>}<section className="incident-list"><div className="section-heading"><h2>DETECTED INCIDENTS</h2><span>REFRESH: 5S</span></div>{incidents.length === 0 ? <p className="empty">No incidents detected. The Agent is standing by.</p> : <div className="incident-table">{incidents.map(item => <button className="incident-row" onClick={() => void selectIncident(item)} key={item.incident_id}><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="incident-title">{item.title}</span><span>{item.service}</span><span className="status">{item.status.replaceAll('_', ' ')}</span><span>›</span></button>)}</div>}</section>
    {detailError && <p className="error" role="alert">{detailError}</p>}{detail && <section className="detail-panel"><div className="section-heading"><div><p className="eyebrow">INCIDENT {detail.context.incident_id}</p><h2>{detail.context.title}</h2></div><button className="close" onClick={() => setDetail(null)}>CLOSE ×</button></div><StageRail status={detail.context.status} /><div className="detail-grid"><article><h3>ROOT CAUSE ANALYSIS</h3><p>{detail.rca.root_cause}</p><dl><dt>CONFIDENCE</dt><dd>{Math.round(detail.rca.confidence * 100)}%</dd><dt>CULPRIT COMMIT</dt><dd>{detail.rca.culprit_commit}</dd><dt>PATCH</dt><dd>{detail.rca.proposed_patch}</dd></dl></article><article><h3>EVIDENCE</h3>{detail.rca.evidence.map(evidence => <div className="evidence" key={`${evidence.kind}-${evidence.source}`}><span>{evidence.kind}</span><b>{evidence.source}</b><p>{evidence.detail}</p></div>)}</article></div><h3>ISOLATED SANDBOX VERIFICATION</h3><p className="muted">{detail.verification.branch_name} · {detail.verification.file_path} · {detail.verification.staging_status}</p><div className="test-grid"><TestResult label="BEFORE PATCH" result={detail.verification.before} /><TestResult label="AFTER PATCH" result={detail.verification.after} /></div><pre className="diff">{detail.verification.diff}</pre><section className="approval"><h3>HUMAN APPROVAL GATE</h3>{detail.approval ? <p className="approved">APPROVED BY {detail.approval.actor ?? 'REVIEWER'}</p> : <><label>REVIEWER<input value={reviewer} onChange={event => setReviewer(event.target.value)} /></label><label>APPROVAL TOKEN<input type="password" value={token} onChange={event => setToken(event.target.value)} /></label><button className="approve" disabled={!reviewer || !token || approving} onClick={() => void approve()}>{approving ? 'AUTHORIZING…' : 'APPROVE PROPOSAL'}</button></>}</section></section>}
  </main></div>
}