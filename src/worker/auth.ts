import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type { Viewer } from '../contracts'
import { ApiError } from './errors'

export interface Identity extends Viewer {
  id: string
}

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email())

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function identify(request: Request, env: Cloudflare.Env): Promise<Identity> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || token.length > 8192) {
    throw new ApiError(401, 'access_required', '请通过 Cloudflare Access 使用 Google 登录。')
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
  if (email === env.ADMIN_EMAIL.trim().toLowerCase()) {
    return { id: 'admin:' + email, email, role: 'admin' }
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND enabled = 1')
    .bind(email).first<{ id: string }>()
  if (!user) {
    throw new ApiError(403, 'user_not_allowed', '此 Google 账号未获授权，请联系管理员。')
  }
  return { id: user.id, email, role: 'user' }
}

async function verifiedEmail(
  token: string,
  keys: ReturnType<typeof createRemoteJWKSet>,
  issuer: string,
  audience: string,
) {
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
