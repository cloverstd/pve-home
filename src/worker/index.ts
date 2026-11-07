import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'
import { actions } from '../contracts'
import { addUser, changeUser, listAudit, listUsers, setGrants } from './admin'
import { emailSchema, identify, type Identity } from './auth'
import { ApiError, logFailure } from './errors'
import { liveMachines, machineRows, requireMachine, syncMachines } from './machines'
import { getOperation, listOperations, reconcileTasks, resolveOperation, submitPower } from './operations'
import { PveClient } from './pve'

const app = new Hono<{ Bindings: Cloudflare.Env; Variables: { actor: Identity } }>()
const machineId = z.string().regex(/^[a-f0-9]{32}$/)
const noFields = z.strictObject({})
const powerSchema = z.strictObject({
  action: z.enum(actions),
  confirmVmid: z.number().int().optional(),
})
const grantSchema = z.strictObject({
  grants: z.array(z.strictObject({
    machineId,
    permissions: z.array(z.enum(['view', ...actions])).max(4)
      .refine((list) => list.includes('view') && list.length === new Set(list).size),
  })).max(1000).refine((list) => list.length === new Set(list.map((grant) => grant.machineId)).size),
})

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
  },
  referrerPolicy: 'no-referrer',
}))
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.set('actor', await identify(c.req.raw, c.env))
  await next()
})

app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    if (!c.env.APP_ORIGIN || c.req.header('Origin') !== c.env.APP_ORIGIN) {
      throw new ApiError(403, 'invalid_origin', '仅允许从本站提交操作。')
    }
    if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new ApiError(415, 'json_required', '请求必须使用 JSON 格式。')
    }
  }
  await next()
})
app.use('/api/*', bodyLimit({
  maxSize: 256 * 1024,
  onError: () => { throw new ApiError(413, 'request_too_large', '请求体过大。') },
}))
app.use('/api/admin/*', async (c, next) => {
  if (c.var.actor.role !== 'admin') throw new ApiError(403, 'admin_required', '需要管理员权限。')
  await next()
})

app.get('/api/me', (c) => c.json({ email: c.var.actor.email, role: c.var.actor.role }))
app.get('/api/machines', async (c) => {
  const rows = await machineRows(c.env.DB, c.var.actor)
  return c.json({ machines: await liveMachines(c.env, c.var.actor, rows) })
})
app.get('/api/machines/:id', async (c) => {
  const row = await requireMachine(c.env.DB, c.var.actor, c.req.param('id'))
  const [machine] = await liveMachines(c.env, c.var.actor, [row])
  return c.json(machine)
})
app.post('/api/machines/:id/actions', async (c) => {
  const body = await parseBody(c.req.raw, powerSchema)
  const key = z.uuid().safeParse(c.req.header('Idempotency-Key'))
  if (!key.success) throw new ApiError(400, 'idempotency_key_required', '需要有效的操作编号。')
  const operationId = await submitPower(c.env, c.var.actor, c.req.param('id'), { ...body, key: key.data })
  c.header('Location', '/api/operations/' + operationId)
  return c.json({ operationId }, 202)
})
app.get('/api/operations', async (c) => c.json({
  operations: await listOperations(c.env, c.var.actor),
}))
app.get('/api/operations/:id', async (c) =>
  c.json(await getOperation(c.env, c.var.actor, c.req.param('id'))))

app.get('/api/admin/users', async (c) => c.json({ users: await listUsers(c.env.DB) }))
app.post('/api/admin/users', async (c) => {
  const { email } = await parseBody(c.req.raw, z.strictObject({ email: emailSchema }))
  return c.json(await addUser(c.env.DB, c.var.actor, email), 201)
})
app.patch('/api/admin/users/:id', async (c) => {
  const { enabled } = await parseBody(c.req.raw, z.strictObject({ enabled: z.boolean() }))
  await changeUser(c.env.DB, c.var.actor, c.req.param('id'), enabled)
  return c.body(null, 204)
})
app.delete('/api/admin/users/:id', async (c) => {
  await parseBody(c.req.raw, noFields)
  await changeUser(c.env.DB, c.var.actor, c.req.param('id'))
  return c.body(null, 204)
})
app.put('/api/admin/users/:id/grants', async (c) => {
  const { grants } = await parseBody(c.req.raw, grantSchema)
  await setGrants(c.env.DB, c.var.actor, c.req.param('id'), grants)
  return c.body(null, 204)
})
app.post('/api/admin/machines/sync', async (c) => {
  await parseBody(c.req.raw, noFields)
  return c.json(await syncMachines(c.env, c.var.actor))
})
app.get('/api/admin/connection', async (c) => {
  const startedAt = Date.now()
  const resources = await new PveClient(c.env).resources()
  return c.json({ reachable: true, guests: resources.length, elapsedMs: Date.now() - startedAt })
})
app.get('/api/admin/audit', async (c) => {
  const before = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .safeParse(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)
  if (!before.success) throw new ApiError(400, 'invalid_cursor', '审计分页参数无效。')
  return c.json(await listAudit(c.env.DB, before.data))
})
app.post('/api/admin/operations/:id/resolve', async (c) => {
  const { note } = await parseBody(c.req.raw, z.strictObject({ note: z.string().trim().min(1).max(300) }))
  await resolveOperation(c.env, c.var.actor, c.req.param('id'), note)
  return c.body(null, 204)
})

app.all('/api/*', (c) => c.json({ code: 'not_found', message: '接口不存在。' }, 404))
app.get('*', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw)
  c.res = response
  c.header('Cache-Control', 'private, no-store')
  return c.res
})
app.onError((error, c) => {
  if (error instanceof ApiError) {
    if (!c.req.path.startsWith('/api/') && (error.status === 401 || error.status === 403)) {
      return c.text(error.message, error.status)
    }
    return c.json({ code: error.code, message: error.message }, error.status)
  }
  logFailure('request_failed', error)
  return c.json({ code: 'internal_error', message: '服务暂时无法处理请求。' }, 500)
})

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
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

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    try {
      await reconcileTasks(env)
    } catch (error) {
      logFailure('task_reconciliation_failed', error)
      throw new Error('Task reconciliation failed')
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>
