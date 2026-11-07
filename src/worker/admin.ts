import { actions, type AuditEvent, type ManagedUser, type UserGrant } from '../contracts'
import { permissions } from './machines'
import type { Identity } from './auth'
import { ApiError } from './errors'

export async function listUsers(db: D1Database): Promise<ManagedUser[]> {
  const { results } = await db.prepare(`
    SELECT u.id, u.email, u.enabled, g.machine_id, g.can_start, g.can_shutdown, g.can_force_stop
    FROM users u LEFT JOIN grants g ON g.user_id = u.id ORDER BY u.email, g.machine_id
  `).all<{
    id: string
    email: string
    enabled: number
    machine_id: string | null
    can_start: number
    can_shutdown: number
    can_force_stop: number
  }>()
  const byUser = new Map<string, ManagedUser>()
  for (const row of results) {
    let user = byUser.get(row.id)
    if (!user) {
      user = { id: row.id, email: row.email, enabled: Boolean(row.enabled), grants: [] }
      byUser.set(row.id, user)
    }
    if (row.machine_id) user.grants.push({ machineId: row.machine_id, permissions: permissions(row) })
  }
  return [...byUser.values()]
}

export async function addUser(db: D1Database, actor: Identity, email: string) {
  if (email === actor.email) throw new ApiError(409, 'admin_email', '该邮箱已是全局管理员。')
  const id = crypto.randomUUID()
  const now = Date.now()
  const [inserted] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(id, email, now),
    db.prepare(`
      INSERT INTO audit (at, actor_email, action, target, result)
      SELECT ?, ?, 'add_user', email, 'ok' FROM users WHERE id = ?
    `).bind(now, actor.email, id),
  ])
  if (!inserted.meta.changes) throw new ApiError(409, 'user_exists', '这个邮箱已添加。')
  return { id, email, enabled: true, grants: [] }
}

async function userEmail(db: D1Database, id: string) {
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string }>()
  if (!user) throw new ApiError(404, 'user_not_found', '找不到该用户。')
  return user.email
}

export async function changeUser(db: D1Database, actor: Identity, id: string, enabled?: boolean) {
  const email = await userEmail(db, id)
  const action = enabled === undefined ? 'remove_user' : enabled ? 'enable_user' : 'disable_user'
  const mutation = enabled === undefined
    ? db.prepare('DELETE FROM users WHERE id = ?').bind(id)
    : db.prepare('UPDATE users SET enabled = ? WHERE id = ?').bind(Number(enabled), id)
  const [result] = await db.batch([
    mutation,
    db.prepare(`
      INSERT INTO audit (at, actor_email, action, target, result)
      SELECT ?, ?, ?, ?, 'ok' WHERE changes() > 0
    `).bind(Date.now(), actor.email, action, email),
  ])
  if (!result.meta.changes) throw new ApiError(404, 'user_not_found', '找不到该用户。')
}

export async function setGrants(db: D1Database, actor: Identity, id: string, grants: UserGrant[]) {
  const email = await userEmail(db, id)
  const data = JSON.stringify(grants.map(({ machineId, permissions: allowed }) => ({
    machineId,
    bits: actions.map((action) => Number(allowed.includes(action))),
  })))
  try {
    const [, , audited] = await db.batch([
      db.prepare('DELETE FROM grants WHERE user_id = ?').bind(id),
      db.prepare(`
        INSERT INTO grants (user_id, machine_id, can_start, can_shutdown, can_force_stop)
        SELECT ?, m.id, value ->> '$.bits[0]', value ->> '$.bits[1]', value ->> '$.bits[2]'
        FROM json_each(?) LEFT JOIN machines m ON m.id = value ->> 'machineId' AND m.available = 1
      `).bind(id, data),
      db.prepare(`
        INSERT INTO audit (at, actor_email, action, target, result)
        SELECT ?, ?, 'set_grants', ?, ? FROM users WHERE id = ?
      `).bind(Date.now(), actor.email, email, 'machines:' + grants.length, id),
    ])
    if (!audited.meta.changes) throw new ApiError(404, 'user_not_found', '找不到该用户。')
  } catch (error) {
    if (error instanceof Error && /(?:NOT NULL|FOREIGN KEY) constraint failed/.test(error.message)) {
      throw new ApiError(409, 'inventory_changed', '用户或机器清单已变更，请刷新后重新分配。')
    }
    throw error
  }
}

export async function listAudit(db: D1Database, before: number) {
  const { results } = await db.prepare(`
    SELECT a.id, a.at, a.actor_email AS actorEmail, a.action, a.result,
      CASE WHEN m.id IS NULL THEN a.target ELSE m.name || ' · ' || m.vmid END AS target
    FROM audit a LEFT JOIN machines m ON m.id = a.target
    WHERE a.id < ? ORDER BY a.id DESC LIMIT 51
  `).bind(before).all<AuditEvent>()
  return { events: results.slice(0, 50), next: results.length > 50 ? results[49].id : null }
}
