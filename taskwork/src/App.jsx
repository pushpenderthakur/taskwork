import { useState } from 'react'
import AuthForm from './components/AuthForm'
import Dashboard from './components/Dashboard'
import { clearSession, getStoredUser } from './api'

function App() {
  const [user, setUser] = useState(() => getStoredUser())

  const handleSignedOut = () => {
    clearSession()
    setUser(null)
  }

  if (user) {
    return <Dashboard user={user} onSignedOut={handleSignedOut} />
  }

  return <AuthForm onAuthenticated={setUser} />
}

export default App