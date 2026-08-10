import { useEffect, useState } from 'react'

type Incident = { incident_id: string; title: string; service: string; severity: string; status: string; created_at: string }
const api = import.meta.env.VITE_NIGHTZERO_API_URL ?? 'http://localhost:8080'

export default function Dashboard() {
  const [health, setHealth] = useState('Loading')
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [selected, setSelected] = useState<Incident | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const [healthResponse, incidentsResponse] = await Promise.all([fetch(`${api}/health`), fetch(`${api}/api/v1/incidents`)])
        if (!healthResponse.ok || !incidentsResponse.ok) throw new Error('Agent API is unavailable')
        setHealth((await healthResponse.json()).status)
        setIncidents(await incidentsResponse.json())
        setError('')
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Agent API is unavailable') }
    }
    void load()
    const interval = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(interval)
  }, [])

  return <main style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '2rem auto' }}>
    <h1>NightZero Control Panel</h1><p>Agent status: <strong>{health}</strong></p>
    {error && <p role="alert">{error}</p>}
    <h2>Incidents</h2>{incidents.length === 0 ? <p>No incidents detected.</p> : <ul>{incidents.map(item => <li key={item.incident_id}><button onClick={() => setSelected(item)}>{item.title}</button> — {item.status} ({item.severity})</li>)}</ul>}
    {selected && <section><h2>{selected.title}</h2><p>Status: {selected.status}</p><p>Service: {selected.service}</p><button onClick={() => setSelected(null)}>Close</button></section>}
  </main>
}