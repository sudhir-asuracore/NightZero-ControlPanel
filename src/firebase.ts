import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'

const apiKey = import.meta.env.VITE_FIREBASE_API_KEY || 'demo-api-key-placeholder'
const app = initializeApp({
  apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'nightzero.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'nightzero',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:123456789:web:demo',
})

const auth = getAuth(app)

export async function judgeToken(email: string, password: string): Promise<string> {
  const credential = await signInWithEmailAndPassword(auth, email, password)
  return credential.user.getIdToken()
}