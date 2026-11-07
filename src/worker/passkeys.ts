import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  decodeBytes, encodeBytes, hashSecret, randomSecret, secretSchema,
  sessionCookie, sessionLifetime, type AppEnv,
} from './auth'
import { ApiError } from './errors'

const challengeLifetime = 5 * 60_000
const credentialBase = {
  id: z.base64url().max(1024),
  rawId: z.base64url().max(1024),
  type: z.literal('public-key'),
  clientExtensionResults: z.object({}),
}
const registration = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: z.base64url().max(4096),
    attestationObject: z.base64url().max(24_000),
  }),
})
const authentication = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: z.base64url().max(4096),
    authenticatorData: z.base64url().max(4096),
    signature: z.base64url().max(4096),
    userHandle: z.base64url().max(128).optional(),
  }),
})

export const passkeys = new Hono<AppEnv>()
const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

passkeys.use('*', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.AUTH_RATE_LIMIT.limit({ key: ip })
  if (!success) throw new ApiError(429, 'rate_limited', '尝试次数过多，请稍后重试。')
  await next()
})

export async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let data: unknown
  try {
    data = await request.json()
  } catch {
    throw new ApiError(400, 'invalid_json', '请求不是有效的 JSON。')
  }
  const result = schema.safeParse(data)
  if (!result.success) throw new ApiError(400, 'invalid_input', '请求内容无效，请检查输入。')
  return result.data
}

function relyingParty(env: Cloudflare.Env) {
  const url = URL.parse(env.APP_ORIGIN)
  if (!url) throw new ApiError(503, 'auth_not_configured', '登录服务尚未配置。')
  return { expectedOrigin: url.origin, expectedRPID: url.hostname }
}

function enrollmentError() {
  return new ApiError(403, 'invalid_enrollment', '初始化 Token 无效、已使用或已过期。')
}

function authError() {
  return new ApiError(401, 'passkey_failed', 'Passkey 验证失败，请重新尝试。')
}

async function beginChallenge(db: D1Database, kind: 'registration' | 'authentication', challenge: string, userId?: string, enrollmentHash?: string) {
  const flowId = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO auth_challenges (id, kind, user_id, enrollment_hash, challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(flowId, kind, userId ?? null, enrollmentHash ?? null, challenge, Date.now() + challengeLifetime).run()
  return flowId
}

async function newSession(c: Context<AppEnv>) {
  const token = randomSecret()
  const hash = await hashSecret(token)
  return {
    hash,
    insert: (id: string) => c.env.DB.prepare(`
      INSERT INTO user_sessions (token_hash, user_id, expires_at)
      SELECT ?, ?, ? WHERE changes() > 0
    `).bind(hash, id, Date.now() + sessionLifetime * 1000),
    set: () => setCookie(c, sessionCookie, token, { ...cookieOptions, maxAge: sessionLifetime }),
  }
}

passkeys.post('/enroll/options', async (c) => {
  const { token } = await parseBody(c.req.raw, z.strictObject({ token: secretSchema }))
  const hash = await hashSecret(token)
  const user = await c.env.DB.prepare(`
    SELECT id, email FROM users WHERE enrollment_hash = ? AND enrollment_expires_at > ? AND enabled = 1
  `).bind(hash, Date.now()).first<{ id: string; email: string }>()
  if (!user) throw enrollmentError()
  const { expectedRPID } = relyingParty(c.env)
  const options = await generateRegistrationOptions({
    rpName: 'PVE Home', rpID: expectedRPID, userName: user.email, userID: new TextEncoder().encode(user.id),
    attestationType: 'none', timeout: 90_000,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
  })
  const flowId = await beginChallenge(c.env.DB, 'registration', options.challenge, user.id, hash)
  return c.json({ flowId, options })
})

passkeys.post('/enroll/verify', async (c) => {
  const { flowId, token, response } = await parseBody(c.req.raw, z.strictObject({
    flowId: z.uuid(), token: secretSchema, response: registration,
  }))
  const hash = await hashSecret(token)
  const db = c.env.DB
  const flow = await db.prepare(`
    SELECT f.challenge, u.id FROM auth_challenges f JOIN users u ON u.id = f.user_id
    WHERE f.id = ? AND f.kind = 'registration' AND f.expires_at > ? AND f.enrollment_hash = ?
    AND u.enrollment_hash = f.enrollment_hash AND u.enrollment_expires_at > ? AND u.enabled = 1
  `).bind(flowId, Date.now(), hash, Date.now()).first<{ challenge: string; id: string }>()
  if (!flow) throw enrollmentError()

  const verified = await verifyRegistrationResponse({
    response, expectedChallenge: flow.challenge, ...relyingParty(c.env),
    requireUserVerification: true, supportedAlgorithmIDs: [-7, -257],
  }).catch(() => null)
  if (!verified?.verified) throw authError()
  const credential = verified.registrationInfo.credential
  const session = await newSession(c)
  const now = Date.now()
  const [registered] = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO passkeys (id, user_id, public_key, counter)
      SELECT ?, u.id, ?, ? FROM auth_challenges f JOIN users u ON u.id = f.user_id
      WHERE f.id = ? AND f.expires_at > ? AND f.enrollment_hash = ?
      AND u.enrollment_hash = f.enrollment_hash AND u.enrollment_expires_at > ? AND u.enabled = 1
    `).bind(credential.id, encodeBytes(credential.publicKey), credential.counter, flowId, now, hash, now),
    session.insert(flow.id),
    db.prepare(`
      UPDATE users SET enrollment_hash = NULL, enrollment_expires_at = NULL WHERE id = ?
      AND EXISTS (SELECT 1 FROM user_sessions WHERE token_hash = ?)
    `).bind(flow.id, session.hash),
    db.prepare(`
      DELETE FROM auth_challenges WHERE user_id = ? AND kind = 'registration'
      AND EXISTS (SELECT 1 FROM user_sessions WHERE token_hash = ?)
    `).bind(flow.id, session.hash),
  ])
  if (!registered.meta.changes) throw enrollmentError()
  session.set()
  return c.body(null, 204)
})

passkeys.post('/login/options', async (c) => {
  const { expectedRPID } = relyingParty(c.env)
  const options = await generateAuthenticationOptions({
    rpID: expectedRPID, timeout: 90_000, userVerification: 'required',
  })
  const flowId = await beginChallenge(c.env.DB, 'authentication', options.challenge)
  return c.json({ flowId, options })
})

passkeys.post('/login/verify', async (c) => {
  const { flowId, response } = await parseBody(c.req.raw, z.strictObject({ flowId: z.uuid(), response: authentication }))
  const db = c.env.DB
  const flow = await db.prepare(`
    SELECT f.challenge, p.user_id, p.public_key, p.counter FROM auth_challenges f
    JOIN passkeys p ON p.id = ? JOIN users u ON u.id = p.user_id
    WHERE f.id = ? AND f.kind = 'authentication' AND f.expires_at > ? AND u.enabled = 1
  `).bind(response.id, flowId, Date.now()).first<{ challenge: string; user_id: string; public_key: string; counter: number }>()
  if (!flow || (response.response.userHandle &&
      response.response.userHandle !== encodeBytes(new TextEncoder().encode(flow.user_id)))) throw authError()
  const verified = await verifyAuthenticationResponse({
    response, expectedChallenge: flow.challenge, ...relyingParty(c.env), requireUserVerification: true,
    credential: { id: response.id, publicKey: decodeBytes(flow.public_key), counter: flow.counter },
  }).catch(() => null)
  if (!verified?.verified) throw authError()
  const session = await newSession(c)
  const [authenticated] = await db.batch([
    db.prepare(`
      UPDATE passkeys SET counter = ? WHERE id = ? AND user_id = ? AND counter = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND enabled = 1)
      AND EXISTS (SELECT 1 FROM auth_challenges WHERE id = ? AND kind = 'authentication' AND expires_at > ?)
    `).bind(verified.authenticationInfo.newCounter, response.id, flow.user_id, flow.counter, flow.user_id, flowId, Date.now()),
    session.insert(flow.user_id),
    db.prepare(`
      DELETE FROM auth_challenges WHERE id = ? AND EXISTS (SELECT 1 FROM user_sessions WHERE token_hash = ?)
    `).bind(flowId, session.hash),
  ])
  if (!authenticated.meta.changes) throw authError()
  session.set()
  return c.body(null, 204)
})

passkeys.post('/logout', async (c) => {
  const token = getCookie(c, sessionCookie)
  if (token && secretSchema.safeParse(token).success) {
    await c.env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(await hashSecret(token)).run()
  }
  deleteCookie(c, sessionCookie, cookieOptions)
  return c.body(null, 204)
})

export async function purgeExpiredAuth(db: D1Database) {
  const now = Date.now()
  await db.batch([
    db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').bind(now),
    db.prepare('UPDATE users SET enrollment_hash = NULL, enrollment_expires_at = NULL WHERE enrollment_expires_at <= ?').bind(now),
  ])
}
