import { actions, type Machine, type MachineKind, type Permission } from '../contracts'
import type { Identity } from './auth'
import { ApiError, logFailure } from './errors'
import { PveClient, resourceKey, type Resource } from './pve'

type Bits = {
  can_start: number
  can_shutdown: number
  can_force_stop: number
}

export interface MachineRow extends Bits {
  id: string
  kind: MachineKind
  vmid: number
  name: string
  node: string
  available: number
  busy: number
}

export function permissions(row: Bits): Permission[] {
  return ['view', ...actions.filter((action) => row['can_' + action as keyof Bits] === 1)]
}

export async function machineRows(db: D1Database, actor: Identity, id?: string) {
  const query = `
    SELECT m.*, g.can_start, g.can_shutdown, g.can_force_stop,
      EXISTS (SELECT 1 FROM operations o WHERE o.machine_id = m.id
        AND o.state IN ('submitting', 'running', 'unknown')) AS busy
    FROM machines m
    LEFT JOIN grants g ON g.machine_id = m.id AND g.user_id = ?
    WHERE (? = 1 OR (m.available = 1 AND g.user_id IS NOT NULL))
      AND (? IS NULL OR m.id = ?)
    ORDER BY m.available DESC, m.vmid, m.kind
  `
  const result = await db.prepare(query).bind(actor.id, Number(actor.role === 'admin'), id ?? null, id ?? null)
    .all<MachineRow>()
  return result.results
}

export async function liveMachines(env: Cloudflare.Env, actor: Identity, rows: MachineRow[]): Promise<Machine[]> {
  if (!rows.length) return []

  let live: Map<string, Resource> | undefined
  if (rows.some((row) => row.available)) {
    try {
      const resources = await new PveClient(env).resources()
      live = new Map(resources.map((resource) => [resourceKey(resource.type, resource.vmid), resource]))
    } catch (error) {
      logFailure('pve_inventory_unavailable', error)
    }
  }

  return rows.map((row) => {
    const resource = row.available ? live?.get(resourceKey(row.kind, row.vmid)) : undefined
    const status = resource?.status
    return {
      id: row.id,
      kind: row.kind,
      vmid: row.vmid,
      name: resource?.name || row.name,
      node: resource?.node ?? row.node,
      available: row.available === 1,
      status: status === 'running' || status === 'stopped' ? status
        : row.available && !live ? 'unreachable' : 'unknown',
      cpu: resource?.cpu ?? null,
      mem: resource?.mem ?? null,
      maxmem: resource?.maxmem ?? null,
      uptime: resource?.uptime ?? null,
      permissions: row.available ? actor.role === 'admin' ? ['view', ...actions] : permissions(row) : [],
      busy: Boolean(row.busy),
    }
  })
}

export async function requireMachine(db: D1Database, actor: Identity, id: string) {
  const [machine] = await machineRows(db, actor, id)
  if (!machine) throw new ApiError(404, 'machine_not_found', '找不到该机器。')
  return machine
}

export async function syncMachines(env: Cloudflare.Env, actor: Identity) {
  const resources = await new PveClient(env).resources()
  const inventory = JSON.stringify(resources.map((r) => ({
    kind: r.type, vmid: r.vmid, node: r.node, name: r.name || r.type + ' ' + r.vmid,
  })))

  const [, retired] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO machines (id, kind, vmid, node, name, available)
      SELECT lower(hex(randomblob(16))), value ->> 'kind', value ->> 'vmid', value ->> 'node', value ->> 'name', 1
      FROM json_each(?) WHERE true
      ON CONFLICT (kind, vmid) DO UPDATE SET node = excluded.node, name = excluded.name, available = 1
    `).bind(inventory),
    env.DB.prepare(`
      UPDATE machines SET available = 0
      WHERE available = 1 AND NOT EXISTS (
        SELECT 1 FROM json_each(?)
        WHERE value ->> 'kind' = machines.kind AND value ->> 'vmid' = machines.vmid
      )
    `).bind(inventory),
    env.DB.prepare(`
      INSERT INTO audit (at, actor_email, action, target, result)
      VALUES (?, ?, 'sync_machines', 'PVE', ?)
    `).bind(Date.now(), actor.email, 'synced:' + resources.length),
  ])
  return { synced: resources.length, retired: retired.meta.changes }
}
