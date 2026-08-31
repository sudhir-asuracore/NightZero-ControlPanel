import { initializeApp } from 'firebase/app'
import {
  getAuth,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth'

const apiKey = import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyDaNWP4IHOdVAhnd2nJmE492KxIW5xcEFI'
const app = initializeApp({
  apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'nightzero.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'nightzero',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:164161200079:web:bd489873b83a58db11bcba',
})

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

export type AuthUser = {
  email: string
  name: string
  photoURL?: string
  token: string
  mode: 'judge' | 'google'
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem('nightzero_auth_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function getValidToken(): Promise<string> {
  const fbUser = auth.currentUser
  if (fbUser) {
    try {
      const freshToken = await fbUser.getIdToken(/* forceRefresh */ true)
      const stored = getStoredUser()
      if (stored) {
        stored.token = freshToken
        localStorage.setItem('nightzero_auth_user', JSON.stringify(stored))
      }
      return freshToken
    } catch (err) {
      console.warn('Failed to refresh Firebase ID token:', err)
    }
  }
  const stored = getStoredUser()
  return stored?.token || 'nightzero-demo'
}

export async function loginWithGoogle(): Promise<AuthUser> {
  const result = await signInWithPopup(auth, googleProvider)
  const token = await result.user.getIdToken()
  const user: AuthUser = {
    email: result.user.email || 'google-user@nightzero.io',
    name: result.user.displayName || result.user.email || 'Google User',
    photoURL: result.user.photoURL || undefined,
    token,
    mode: 'google',
  }
  localStorage.setItem('nightzero_auth_user', JSON.stringify(user))
  return user
}

export async function loginWithCredentials(email: string, password: string): Promise<AuthUser> {
  const envJudgeUser = import.meta.env.VITE_JUDGE_USERNAME || 'nightzero-judges@asuracore.com'
  const envJudgePass = import.meta.env.VITE_JUDGE_PASSWORD || 'nightzero-demo'

  let token = 'nightzero-demo'
  let name = email

  try {
    const credential = await signInWithEmailAndPassword(auth, email, password)
    token = await credential.user.getIdToken()
    name = credential.user.displayName || credential.user.email || email
  } catch (error) {
    // If Firebase Auth is not available or local judge credentials match, support direct judge login
    const isMatchingEnv =
      (email.toLowerCase() === envJudgeUser.toLowerCase() || email === 'judge' || email === 'admin') &&
      (password === envJudgePass || password === 'nightzero-demo')

    if (isMatchingEnv) {
      token = 'nightzero-demo'
      name = 'Hackathon Judge'
    } else {
      throw error
    }
  }

  const user: AuthUser = {
    email,
    name,
    token,
    mode: 'judge',
  }
  localStorage.setItem('nightzero_auth_user', JSON.stringify(user))
  return user
}

export async function logout(): Promise<void> {
  localStorage.removeItem('nightzero_auth_user')
  try {
    await fbSignOut(auth)
  } catch {
    // ignore
  }
}

export function subscribeToAuth(onUser: (user: AuthUser | null) => void): () => void {
  return onAuthStateChanged(auth, async (fbUser) => {
    if (fbUser) {
      const token = await fbUser.getIdToken()
      const user: AuthUser = {
        email: fbUser.email || 'user@nightzero.io',
        name: fbUser.displayName || fbUser.email || 'Reviewer',
        photoURL: fbUser.photoURL || undefined,
        token,
        mode: 'google',
      }
      localStorage.setItem('nightzero_auth_user', JSON.stringify(user))
      onUser(user)
    } else {
      const stored = getStoredUser()
      if (stored?.mode === 'judge') {
        onUser(stored)
      } else {
        onUser(null)
      }
    }
  })
}