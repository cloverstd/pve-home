import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { Fingerprint, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { api, mutation } from './api'
import { Alert, useMutation } from './components'

export function UserLogin({ done }: { done: () => void }) {
  const [token, setToken] = useState('')
  const { pending, error, run } = useMutation(done)
  return <>
    <h1>登录管理台</h1>
    <p className="muted login-intro">已绑定 Passkey 的用户可直接登录。</p>
    <button className="button primary login-primary" disabled={pending} onClick={() => void run(async () => {
      const flow = await api<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
        '/auth/login/options', mutation('POST'),
      )
      const response = await startAuthentication({ optionsJSON: flow.options })
      await api('/auth/login/verify', mutation('POST', { flowId: flow.flowId, response }))
      return '已登录。'
    })}><Fingerprint size={17} /> 使用 Passkey 登录</button>

    <details className="enrollment-form">
      <summary>首次绑定 Passkey</summary>
      <form onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const secret = token.trim()
          const flow = await api<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
            '/auth/enroll/options', mutation('POST', { token: secret }),
          )
          const response = await startRegistration({ optionsJSON: flow.options })
          await api('/auth/enroll/verify', mutation('POST', { flowId: flow.flowId, token: secret, response }))
          setToken('')
          return '已绑定 Passkey。'
        })
      }}>
        <label className="field">初始化 Token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required maxLength={64} />
        </label>
        <button className="button login-primary" disabled={pending || !token.trim()}>
          <KeyRound size={16} /> 绑定并登录
        </button>
      </form>
    </details>
    {error && <Alert>{error}</Alert>}
    <a className="admin-login-link" href="/admin">管理员 GitHub 登录</a>
  </>
}
