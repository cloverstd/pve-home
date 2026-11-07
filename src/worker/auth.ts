import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type { Viewer } from '../contracts'
import { ApiError } from './errors'

export interface Identity extends Viewer {
  id: string
}

export type AppEnv = { Bindings: Cloudflare.Env; Variables: { actor: Identity } }

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email())
export const secretSchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/)
export const sessionCookie = '__Host-pve-session'
export const sessionLifetime = 8 * 60 * 60
const enrollmentLifetime = 24 * 60 * 60 * 1000

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function encodeBytes(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBytes(encoded: string) {
  const value = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(value), (letter) => letter.charCodeAt(0))
}

export function randomSecret() {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashSecret(secret: string) {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
}

export function loginAuditHeaders(request: Request) {
  const ip = request.headers.get('CF-Connecting-IP') || null
  const userAgent = request.headers.get('User-Agent')?.slice(0, 1024) || null
  return [ip, userAgent] as const
}

export async function newEnrollment() {
  const token = randomSecret()
  return { token, hash: await hashSecret(token), expiresAt: Date.now() + enrollmentLifetime }
}

export async function identifyUser(env: Cloudflare.Env, token?: string): Promise<Identity> {
  if (secretSchema.safeParse(token).success && token) {
    const user = await env.DB.prepare(`
      SELECT u.id, u.email FROM users u JOIN user_sessions s ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1
    `).bind(await hashSecret(token), Date.now()).first<{ id: string; email: string }>()
    if (user) return { ...user, role: 'user' }
  }
  throw new ApiError(401, 'passkey_required', '请使用 Passkey 登录。')
}

export async function identifyAdmin(request: Request, env: Cloudflare.Env): Promise<Identity> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || token.length > 8192) {
    throw new ApiError(401, 'access_required', '管理员请通过 Cloudflare Access 使用 GitHub 登录。')
  }

  const issuer = env.ACCESS_ISSUER
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !env.ACCESS_AUD || !env.ADMIN_EMAIL) {
    throw new ApiError(503, 'access_not_configured', 'Cloudflare Access 尚未配置。')
  }
  let keys = keySets.get(issuer)
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), { timeoutDuration: 5000 })
    keySets.set(issuer, keys)
  }
  const email = await verifiedEmail(token, keys, issuer, env.ACCESS_AUD)
  if (email !== env.ADMIN_EMAIL.trim().toLowerCase()) {
    throw new ApiError(403, 'admin_required', '需要管理员权限。')
  }
  // Access sends the application token on subsequent requests in the same session.
  const [ip, userAgent] = loginAuditHeaders(request)
  await env.DB.prepare(`
    INSERT INTO audit (at, actor_email, action, target, result, ip, user_agent, access_token_hash)
    VALUES (?, ?, 'login', 'Cloudflare Access', 'ok', ?, ?, ?)
    ON CONFLICT(access_token_hash) WHERE access_token_hash IS NOT NULL DO NOTHING
  `).bind(Date.now(), email, ip, userAgent, await hashSecret(token)).run()
  return { id: 'admin:' + email, email, role: 'admin' }
}

async function verifiedEmail(token: string, keys: ReturnType<typeof createRemoteJWKSet>, issuer: string, audience: string) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    })
    if (payload.type !== 'app' || !payload.sub) throw new Error('Expected an application user')
    return emailSchema.parse(payload.email)
  } catch {
    throw new ApiError(401, 'invalid_access_token', '登录凭据无效或已过期，请重新登录。')
  }
}
