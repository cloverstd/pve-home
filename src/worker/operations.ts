import type { Operation, PowerAction } from '../contracts'
import type { Identity } from './auth'
import { ApiError, logFailure } from './errors'
import { permissions, requireMachine } from './machines'
import { PveClient, PveError } from './pve'

const SUBMISSION_DEADLINE = 30_000
const POLL_INTERVAL = 2_000
const POLL_LEASE = 12_000
const TASK_UNREACHABLE_DEADLINE = 15 * 60_000

interface OperationRow extends Operation {
  node: string
  upid: string | null
  checkedAt: number | null
  lastReachableAt: number | null
}

const select = `
  SELECT o.id, o.machine_id AS machineId, m.name AS machineName, m.vmid,
    o.actor_email AS actorEmail, o.action, o.state, o.message,
    o.created_at AS createdAt, o.updated_at AS updatedAt,
    o.node, o.upid, o.checked_at AS checkedAt, o.last_reachable_at AS lastReachableAt
  FROM operations o JOIN machines m ON m.id = o.machine_id
`
const visibility = `
  (? = 1 OR (o.actor_id = ? AND m.available = 1 AND EXISTS (
    SELECT 1 FROM grants WHERE user_id = ? AND machine_id = m.id
  )))
`
const visibleTo = (actor: Identity) => [Number(actor.role === 'admin'), actor.id, actor.id]

function publicOperation(row: OperationRow): Operation {
  const { node, upid, checkedAt, lastReachableAt, ...operation } = row
  return operation
}

async function operationById(db: D1Database, actor: Identity, id: string) {
  const row = await db.prepare(select + ' WHERE o.id = ? AND ' + visibility)
    .bind(id, ...visibleTo(actor)).first<OperationRow>()
  if (!row) throw new ApiError(404, 'operation_not_found', '找不到该操作。')
  return row
}

export async function listOperations(env: Cloudflare.Env, actor: Identity) {
  const { results } = await env.DB.prepare(select + ' WHERE ' + visibility + `
    ORDER BY (o.state IN ('unknown', 'running', 'submitting')) DESC, o.created_at DESC, o.id DESC LIMIT 50
  `).bind(...visibleTo(actor)).all<OperationRow>()
  // Refresh a small number of visible tasks per request. Cron handles the remainder.
  const due = results.filter((row) => isDue(row, Date.now())).slice(0, 6)
  const refreshed = new Map((await Promise.all(due.map(async (row) => [
    row.id, await refresh(env, row),
  ] as const))))
  return results.map((row) => publicOperation(refreshed.get(row.id) ?? row))
}

export async function getOperation(env: Cloudflare.Env, actor: Identity, id: string) {
  const row = await operationById(env.DB, actor, id)
  return publicOperation(isDue(row, Date.now()) ? await refresh(env, row) : row)
}

interface PowerRequest {
  action: PowerAction
  confirmVmid?: number
  key: string
}

export async function submitPower(env: Cloudflare.Env, actor: Identity, id: string, request: PowerRequest) {
  const machine = await requireMachine(env.DB, actor, id)
  const admin = actor.role === 'admin'
  if (!machine.available) throw new ApiError(409, 'machine_unavailable', '此机器已停用。')
  if (!admin && !permissions(machine).includes(request.action)) {
    throw new ApiError(403, 'action_forbidden', '你没有执行此操作的权限。')
  }
  if (request.action === 'force_stop' && request.confirmVmid !== machine.vmid) {
    throw new ApiError(400, 'vmid_confirmation', '请输入正确的 VMID 确认强制关机。')
  }

  const replay = async () => {
    const existing = await env.DB.prepare(`
      SELECT id, machine_id, action FROM operations WHERE actor_id = ? AND idempotency_key = ?
    `).bind(actor.id, request.key).first<{ id: string; machine_id: string; action: PowerAction }>()
    if (!existing) return null
    if (existing.machine_id !== id || existing.action !== request.action) {
      throw new ApiError(409, 'idempotency_conflict', '此操作编号已用于其他请求。')
    }
    return existing.id
  }
  const previous = await replay()
  if (previous) return previous
  if (machine.busy) throw machineBusy()

  const pve = new PveClient(env)
  const resource = (await pve.resources()).find((r) => r.type === machine.kind && r.vmid === machine.vmid)
  if (!resource) throw new ApiError(409, 'guest_missing', 'PVE 中找不到此机器，请联系管理员同步。')
  const requiredStatus = request.action === 'start' ? 'stopped' : 'running'
  if (resource.status !== requiredStatus) {
    throw new ApiError(409, 'invalid_machine_state', '当前机器状态不支持此操作，请刷新后检查。')
  }

  const operationId = crypto.randomUUID()
  const now = Date.now()
  const [reserved] = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO operations (
        id, machine_id, actor_id, actor_email, action, idempotency_key, state, node, created_at, updated_at
      )
      SELECT ?, m.id, ?, ?, ?, ?, 'submitting', ?, ?, ?
      FROM machines m WHERE m.id = ? AND m.available = 1 AND (? = 1 OR EXISTS (
        SELECT 1 FROM grants g JOIN users u ON u.id = g.user_id
        WHERE g.machine_id = m.id AND u.id = ? AND u.enabled = 1
        AND CASE ? WHEN 'start' THEN g.can_start WHEN 'shutdown' THEN g.can_shutdown ELSE g.can_force_stop END = 1
      ))
    `).bind(operationId, actor.id, actor.email, request.action, request.key, resource.node, now, now,
      id, Number(admin), actor.id, request.action),
    env.DB.prepare('UPDATE machines SET node = ? WHERE id = ? AND EXISTS (SELECT 1 FROM operations WHERE id = ?)')
      .bind(resource.node, id, operationId),
  ])

  if (!reserved.meta.changes) {
    const existing = await replay()
    if (existing) return existing
    const current = await requireMachine(env.DB, actor, id)
    if (current.busy) throw machineBusy()
    throw new ApiError(409, 'authorization_changed', '机器或授权已变更，请刷新后重试。')
  }

  let upid: string
  try {
    upid = await pve.power(resource, request.action)
  } catch (error) {
    const knownFailure = error instanceof PveError && !error.uncertain
    const message = error instanceof PveError ? error.message : '未能确认 PVE 是否收到操作。'
    await env.DB.prepare(`
      UPDATE operations SET state = ?, message = ?, updated_at = ? WHERE id = ? AND state = 'submitting'
    `).bind(knownFailure ? 'failed' : 'unknown', message, Date.now(), operationId).run()
    logFailure('pve_power_submission', error)
    return operationId
  }
  const acceptedAt = Date.now()
  await env.DB.prepare(`
    UPDATE operations SET state = 'running', upid = ?, updated_at = ?, last_reachable_at = ?
    WHERE id = ? AND state = 'submitting'
  `).bind(upid, acceptedAt, acceptedAt, operationId).run()
  return operationId
}

function machineBusy() {
  return new ApiError(409, 'machine_busy', '此机器有未结束的操作，请查看操作记录。')
}

function isDue(row: OperationRow, now: number) {
  return (row.state === 'running' && (row.checkedAt ?? 0) <= now - POLL_INTERVAL)
    || (row.state === 'submitting' && row.createdAt <= now - SUBMISSION_DEADLINE)
}

async function refresh(env: Cloudflare.Env, row: OperationRow): Promise<OperationRow> {
  const now = Date.now()
  // A crashed poll releases its lease automatically. Slow polls cannot overwrite a newer result.
  const lease = now + POLL_LEASE
  const claim = await env.DB.prepare(`
    UPDATE operations SET poll_until = ? WHERE id = ? AND state = ?
      AND (poll_until IS NULL OR poll_until <= ?)
      AND (checked_at IS NULL OR checked_at <= ?)
    RETURNING last_reachable_at AS lastReachableAt
  `).bind(lease, row.id, row.state, now, now - POLL_INTERVAL)
    .first<{ lastReachableAt: number | null }>()
  if (!claim) return row

  let state = row.state
  let message = row.message
  let lastReachable = claim.lastReachableAt
  if (row.state === 'submitting' || !row.upid) {
    state = 'unknown'
    message = '未收到 PVE 提交结果，请管理员核查。'
  } else {
    try {
      const task = await new PveClient(env).task(row.node, row.upid)
      lastReachable = Date.now()
      if (task.status === 'stopped') {
        state = task.exitstatus === 'OK' ? 'succeeded' : 'failed'
        message = state === 'succeeded' ? null : 'PVE 任务未成功，请在 PVE 中查看任务详情。'
      } else {
        message = null
      }
    } catch (error) {
      logFailure('pve_task_status', error)
      if (now - (lastReachable ?? row.createdAt) >= TASK_UNREACHABLE_DEADLINE) {
        state = 'unknown'
        message = '长时间无法查询 PVE 任务，请管理员核查。'
      } else {
        message = '暂时无法查询任务，系统将继续检查。'
      }
    }
  }

  const changed = state !== row.state || message !== row.message
  const checkedAt = Date.now()
  const updatedAt = changed ? checkedAt : row.updatedAt
  const result = await env.DB.prepare(`
    UPDATE operations SET state = ?, message = ?, last_reachable_at = ?, updated_at = ?,
      checked_at = ?, poll_until = NULL
    WHERE id = ? AND state = ? AND poll_until = ?
  `).bind(state, message, lastReachable, updatedAt, checkedAt, row.id, row.state, lease).run()
  return result.meta.changes
    ? { ...row, state, message, lastReachableAt: lastReachable, updatedAt, checkedAt }
    : row
}

export async function reconcileTasks(env: Cloudflare.Env) {
  const now = Date.now()
  const { results } = await env.DB.prepare(select + `
    WHERE coalesce(o.poll_until, 0) <= ? AND (
      (o.state = 'running' AND coalesce(o.checked_at, 0) <= ?)
      OR (o.state = 'submitting' AND o.created_at <= ?)
    )
    ORDER BY coalesce(o.checked_at, 0), o.created_at LIMIT 12
  `).bind(now, now - POLL_INTERVAL, now - SUBMISSION_DEADLINE).all<OperationRow>()
  for (let offset = 0; offset < results.length; offset += 4) {
    await Promise.all(results.slice(offset, offset + 4).map((row) => refresh(env, row)))
  }
}

export async function resolveOperation(env: Cloudflare.Env, actor: Identity, id: string, note: string) {
  const row = await operationById(env.DB, actor, id)
  if (row.state !== 'unknown') {
    throw new ApiError(409, 'operation_not_unknown', '只能解除结果未知的操作。')
  }
  const result = await env.DB.prepare(`
    UPDATE operations SET state = 'resolved', resolved_by = ?, message = ?, updated_at = ?
    WHERE id = ? AND state = 'unknown'
  `).bind(actor.email, note, Date.now(), id).run()
  if (!result.meta.changes) {
    throw new ApiError(409, 'operation_not_unknown', '此操作已经处理，请刷新。')
  }
}
