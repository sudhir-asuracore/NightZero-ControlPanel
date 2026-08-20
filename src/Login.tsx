import { useState } from 'react'
import { type AuthUser, loginWithCredentials, loginWithGoogle } from './firebase'

type LoginProps = {
  onLoginSuccess: (user: AuthUser) => void
}

export default function Login({ onLoginSuccess }: LoginProps) {
  const defaultJudgeUser = import.meta.env.VITE_JUDGE_USERNAME || 'nightzero-judges@asuracore.com'
  const defaultJudgePass = import.meta.env.VITE_JUDGE_PASSWORD || 'nightzero-demo'

  const [email, setEmail] = useState(defaultJudgeUser)
  const [password, setPassword] = useState(defaultJudgePass)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleCredentialsLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) {
      setError('Please enter both email/username and password.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const user = await loginWithCredentials(email, password)
      onLoginSuccess(user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid credentials. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setLoading(true)
    setError('')
    try {
      const user = await loginWithGoogle()
      onLoginSuccess(user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-shell" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a', padding: '24px' }}>
      <div style={{ width: '100%', maxWidth: '440px', backgroundColor: '#111111', border: '1px solid #222222', padding: '40px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '48px', height: '48px', backgroundColor: '#dc2626', color: '#ffffff', fontWeight: 900, fontSize: '18px', marginBottom: '16px', letterSpacing: '0.05em' }}>
            NZ
          </div>
          <p className="eyebrow" style={{ margin: 0 }}>SECURITY CHECKPOINT</p>
          <h1 style={{ margin: '8px 0 0', fontSize: '22px', fontWeight: 'bold', color: '#ffffff', letterSpacing: '0.08em' }}>NIGHTZERO CONTROL PLANE</h1>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: '11px' }}>Autonomous SRE & Incident Approval Gateway</p>
        </div>

        {error && (
          <div className="error" style={{ marginBottom: '24px', padding: '12px 16px', fontSize: '11px', textAlign: 'left', marginTop: 0 }} role="alert">
            {error}
          </div>
        )}

        {/* Mode 2: Google OAuth */}
        <button
          type="button"
          onClick={() => void handleGoogleLogin()}
          disabled={loading}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            backgroundColor: '#ffffff',
            color: '#000000',
            border: 'none',
            padding: '12px 16px',
            fontSize: '12px',
            fontWeight: 'bold',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            transition: 'background-color 0.2s',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          CONTINUE WITH GOOGLE
        </button>

        <div style={{ display: 'flex', alignItems: 'center', margin: '24px 0', gap: '12px' }}>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#222222' }} />
          <span style={{ color: '#475569', fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase' }}>OR JUDGE ACCESS</span>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#222222' }} />
        </div>

        {/* Mode 1: Judge Credentials Form */}
        <form onSubmit={(e) => void handleCredentialsLogin(e)} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', color: '#64748b', fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '8px', fontWeight: 'bold' }}>
              JUDGE EMAIL / USERNAME
            </label>
            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. nightzero-judges@asuracore.com"
              style={{
                width: '100%',
                backgroundColor: '#0a0a0a',
                border: '1px solid #333333',
                color: '#ffffff',
                padding: '12px 14px',
                fontSize: '12px',
                fontFamily: 'inherit',
                outline: 'none',
                transition: 'border-color 0.2s',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', color: '#64748b', fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '8px', fontWeight: 'bold' }}>
              APPROVAL PASSWORD
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              style={{
                width: '100%',
                backgroundColor: '#0a0a0a',
                border: '1px solid #333333',
                color: '#ffffff',
                padding: '12px 14px',
                fontSize: '12px',
                fontFamily: 'inherit',
                outline: 'none',
                transition: 'border-color 0.2s',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: '8px',
              backgroundColor: 'rgba(220, 38, 38, 0.2)',
              border: '1px solid #dc2626',
              color: '#ffffff',
              padding: '14px 16px',
              fontWeight: 'bold',
              fontSize: '12px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              transition: 'all 0.2s',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'AUTHENTICATING…' : 'SIGN IN AS JUDGE →'}
          </button>
        </form>
      </div>
    </div>
  )
}
