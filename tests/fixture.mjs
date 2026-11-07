import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

export const adminEmail = 'admin@example.test'
export const userEmail = 'operator@example.test'
export const issuer = 'https://pve-home-test.cloudflareaccess.com'
export const audience = 'pve-home-test-audience'
export const defaultOrigin = 'https://pve-home.example.test'

const output = new URL('../.cloudflare/output/v0/workers/default/', import.meta.url)
const migrationsDir = new URL('../migrations/', import.meta.url)
const migrations = await Promise.all((await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  .map((name) => readFile(new URL(name, migrationsDir), 'utf8')))

export async function fixture(origin = defaultOrigin, { pveToken = 'fixture@pve!power=only-a-fixture' } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
  const state = {
    guests: [
      { type: 'qemu', vmid: 101, name: 'build-vm', node: 'pve-a', status: 'running', cpu: 0.16, mem: 512e6, maxmem: 2048e6, uptime: 7200 },
      { type: 'lxc', vmid: 202, name: 'dev-container', node: 'pve-a', status: 'stopped' },
      { type: 'qemu', vmid: 303, name: 'private-vm', node: 'pve-a', status: 'running' },
      { type: 'qemu', vmid: 990, name: 'template', node: 'pve-a', status: 'stopped', template: 1 },
    ],
    commands: [],
    inventoryError: null,
    powerError: null,
    taskError: null,
    taskStatus: { status: 'running' },
  }
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'pve-home-test',
    modules: true,
    scriptPath: fileURLToPath(new URL('bundle/index.js', output)),
    compatibilityDate: '2026-11-07',
    unsafeTriggerHandlers: true,
    bindings: {
      APP_ORIGIN: origin,
      ACCESS_ISSUER: issuer,
      ACCESS_AUD: audience,
      ADMIN_EMAIL: adminEmail,
      PVE_ORIGIN: 'https://pve.internal.example.test:8006',
      PVE_API_TOKEN: pveToken,
    },
    d1Databases: { DB: 'test-db' },
    ratelimits: { AUTH_RATE_LIMIT: { namespace_id: '1001', simple: { limit: 30, period: 60 } } },
    assets: {
      directory: fileURLToPath(new URL('assets', output)),
      binding: 'ASSETS',
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
    },
    outboundService: (request) => request.url === issuer + '/cdn-cgi/access/certs'
      ? Response.json({ keys: [jwk] })
      : new Response('Unexpected outbound request', { status: 502 }),
    serviceBindings: {
      PVE: async (request) => {
        const url = new URL(request.url)
        if (url.origin !== 'https://pve.internal.example.test:8006' ||
            request.headers.get('Authorization') !== 'PVEAPIToken=fixture@pve!power=only-a-fixture' ||
            request.headers.has('Cf-Access-Jwt-Assertion')) {
          return new Response(null, { status: 401 })
        }
        if (url.pathname === '/api2/json/cluster/resources' && url.searchParams.get('type') === 'vm') {
          return state.inventoryError
            ? new Response(null, { status: state.inventoryError })
            : Response.json({ data: state.guests })
        }
        if (request.method === 'POST' && url.pathname.includes('/status/')) {
          const [, , , , node, kind, id, , verb] = url.pathname.split('/')
          state.commands.push({ node, kind, id: Number(id), verb, form: await request.text() })
          if (state.powerError) return new Response(null, { status: state.powerError })
          return Response.json({ data: 'UPID:' + node + ':00000001:00000002:00000003:' + verb + ':' + id + ':fixture@pve!power:' })
        }
        if (url.pathname.includes('/tasks/') && url.pathname.endsWith('/status')) {
          return state.taskError ? new Response(null, { status: state.taskError }) : Response.json({ data: state.taskStatus })
        }
        return new Response(null, { status: 404 })
      },
    },
  }))
  try {
    const db = await mf.getD1Database('DB')
    // Blank lines separate statements in migrations, including complete triggers.
    for (const migration of migrations) {
      await db.batch(migration.trim().split(/\n\s*\n/).map((sql) => db.prepare(sql)))
    }
    async function jwt(email, options = {}) {
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({ email, type: options.type ?? 'app' })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.aud ?? audience)
        .setIssuedAt(now)
        .setExpirationTime(options.exp ?? now + 300)
        .setSubject('access:' + email)
        .sign(options.key ?? privateKey)
    }
    const admin = await jwt(adminEmail)
    const user = randomBytes(32).toString('base64url')
    async function activateOperator(userId) {
      const hash = createHash('sha256').update(user).digest('base64url')
      await db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(hash, userId, Date.now() + 3600_000).run()
    }
    function request(path, { token = admin, method = 'GET', body, key, headers = {}, adminRoute = token === admin } = {}) {
      if (adminRoute && /^\/api\/(me|machines|operations)(?:\/|$)/.test(path)) {
        path = '/api/admin' + path.slice('/api'.length)
      }
      const requestHeaders = new Headers({
        ...(token === user ? { Cookie: '__Host-pve-session=' + user } : token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...headers,
      })
      return mf.dispatchFetch(origin + path, {
        method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    return { mf, db, state, jwt, admin, user, request, activateOperator }
  } catch (error) {
    await mf.dispose()
    throw error
  }
}
