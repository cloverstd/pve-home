import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair } from 'jose'
import { fixture, issuer, userEmail } from './fixture.mjs'

async function setup(t) {
  const app = await fixture()
  t.after(() => app.mf.dispose())
  return app
}

async function checked(response, status) {
  const result = await response
  assert.equal(result.status, status, await result.clone().text())
  return status === 204 ? undefined : result.json()
}

async function inventory(app) {
  await checked(app.request('/api/admin/machines/sync', { method: 'POST', body: {} }), 200)
  const { machines } = await checked(app.request('/api/machines'), 200)
  assert.ok(machines.every((machine) => machine.vmid !== 990))
  return machines
}

async function addOperator(app) {
  const user = await checked(app.request('/api/admin/users', {
    method: 'POST', body: { email: '  ' + userEmail.toUpperCase() + '  ' },
  }), 201)
  await app.activateOperator(user.id)
  return user
}

function grant(app, userId, grants) {
  return app.request('/api/admin/users/' + userId + '/grants', { method: 'PUT', body: { grants } })
}

function power(app, machineId, action, options = {}) {
  const { confirmVmid, key = crypto.randomUUID(), ...requestOptions } = options
  return app.request('/api/machines/' + machineId + '/actions', {
    method: 'POST', key, body: { action, confirmVmid }, ...requestOptions,
  })
}

const operationUrl = (id) => '/api/operations/' + id

test('Access requires a signed application token for the correct issuer and audience', async (t) => {
  const app = await setup(t)
  const { privateKey } = await generateKeyPair('RS256')
  const cases = [
    null,
    await app.jwt('admin@example.test', { key: privateKey }),
    await app.jwt('admin@example.test', { aud: 'other-application' }),
    await app.jwt('admin@example.test', { issuer: issuer.replace('pve-home', 'other') }),
    await app.jwt('admin@example.test', { type: 'org' }),
    await app.jwt('admin@example.test', { exp: Math.floor(Date.now() / 1000) - 1 }),
  ]
  for (const token of cases) {
    await checked(app.request('/api/admin/me', { token, headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.test' } }), 401)
  }
  assert.equal((await app.request('/', { token: null })).status, 200)
  assert.equal((await app.request('/admin', { token: null })).status, 401)
  await checked(app.request('/api/me', { adminRoute: false }), 401)
  assert.equal((await checked(app.request('/api/me'), 200)).role, 'admin')
  await checked(app.request('/api/admin/me', { token: await app.jwt(userEmail) }), 403)
  await checked(app.request('/api/me', { token: app.user }), 401)
  await checked(app.request('/api/admin/machines/sync', {
    method: 'POST', body: {}, headers: { Origin: 'https://attacker.example.test' },
  }), 403)
  await checked(app.request('/api/admin/machines/sync', {
    method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' },
  }), 415)
})

test('per-guest grants, task ownership, revocation and user lifecycle', async (t) => {
  const app = await setup(t)
  const [vm, container] = await inventory(app)
  const user = await addOperator(app)
  assert.equal(user.email, userEmail)
  await checked(grant(app, user.id, [{ machineId: vm.id, permissions: ['shutdown'] }]), 400)
  await checked(grant(app, user.id, [{ machineId: vm.id, permissions: ['view', 'shutdown'] }]), 204)
  await checked(grant(app, user.id, [{ machineId: 'a'.repeat(32), permissions: ['view'] }]), 409)

  const result = await checked(app.request('/api/machines', { token: app.user }), 200)
  assert.deepEqual(result.machines.map(({ id, permissions }) => [id, permissions]), [[vm.id, ['view', 'shutdown']]])
  await checked(app.request('/api/machines/' + container.id, { token: app.user }), 404)
  await checked(power(app, container.id, 'start', { token: app.user }), 404)
  await checked(power(app, vm.id, 'force_stop', { confirmVmid: vm.vmid, token: app.user }), 403)
  await checked(app.request('/api/admin/users', { token: app.user }), 401)
  const { operationId: adminOperation } = await checked(power(app, vm.id, 'shutdown'), 202)
  await checked(app.request(operationUrl(adminOperation), { token: app.user }), 404)
  app.state.taskStatus = { status: 'stopped', exitstatus: 'ERROR: shutdown timed out' }
  const failed = await checked(app.request(operationUrl(adminOperation)), 200)
  assert.equal(failed.state, 'failed')

  const { operationId } = await checked(power(app, vm.id, 'shutdown', { token: app.user }), 202)
  await checked(app.request(operationUrl(operationId), { token: app.user }), 200)
  await checked(grant(app, user.id, []), 204)
  await checked(app.request(operationUrl(operationId), { token: app.user }), 404)
  assert.deepEqual((await checked(app.request('/api/operations', { token: app.user }), 200)).operations, [])
  await checked(app.request('/api/admin/users/' + user.id, { method: 'PATCH', body: { enabled: false } }), 204)
  await checked(app.request('/api/me', { token: app.user }), 401)
  await checked(app.request('/api/admin/users/' + user.id, { method: 'DELETE', body: {} }), 204)
  assert.equal((await checked(app.request('/api/admin/users'), 200)).users.length, 0)
  const { events } = await checked(app.request('/api/admin/audit'), 200)
  for (const action of ['add_user', 'set_grants', 'disable_user', 'remove_user', 'shutdown']) {
    assert.ok(events.some((event) => event.action === action), action)
  }
})

test('QEMU and LXC power calls use the current node and track UPID results', async (t) => {
  const app = await setup(t)
  const machines = (await inventory(app)).filter(({ vmid }) => vmid !== 303)
  for (const machine of machines) {
    const resource = app.state.guests.find((guest) => guest.vmid === machine.vmid)
    resource.node = 'pve-b'
    for (const [action, verb, status] of [
      ['start', 'start', 'stopped'], ['shutdown', 'shutdown', 'running'], ['force_stop', 'stop', 'running'],
    ]) {
      resource.status = status
      const confirmation = action === 'force_stop' ? machine.vmid : undefined
      if (confirmation) await checked(power(app, machine.id, action, { confirmVmid: 999 }), 400)
      app.state.taskStatus = { status: 'running' }
      const { operationId } = await checked(power(app, machine.id, action, { confirmVmid: confirmation }), 202)
      const active = await checked(app.request(operationUrl(operationId)), 200)
      assert.equal(active.state, 'running')
      assert.equal('upid' in active, false)
      assert.deepEqual(app.state.commands.at(-1), {
        node: 'pve-b', kind: machine.kind, id: machine.vmid, verb,
        form: action === 'shutdown' ? 'timeout=60&forceStop=0' : '',
      })
      app.state.taskStatus = { status: 'stopped', exitstatus: 'OK' }
      await app.db.prepare('UPDATE operations SET checked_at = 0 WHERE id = ?').bind(operationId).run()
      const cron = await app.mf.dispatchFetch('https://pve-home.example.test/cdn-cgi/local/scheduled')
      assert.equal(cron.status, 200, await cron.text())
      const result = await checked(app.request(operationUrl(operationId)), 200)
      assert.equal(result.state, 'succeeded')
    }
  }
  assert.equal(app.state.commands.length, 6)
})

test('concurrent requests share an idempotent operation and exclude conflicting actions', async (t) => {
  const app = await setup(t)
  const [vm] = await inventory(app)
  const key = crypto.randomUUID()
  const [first, second] = await Promise.all([
    checked(power(app, vm.id, 'shutdown', { key }), 202),
    checked(power(app, vm.id, 'shutdown', { key }), 202),
  ])
  assert.equal(first.operationId, second.operationId)
  assert.equal(app.state.commands.length, 1)
  await checked(power(app, vm.id, 'force_stop', { key, confirmVmid: vm.vmid }), 409)
  app.state.taskStatus = { status: 'stopped', exitstatus: 'OK' }
  await checked(app.request(operationUrl(first.operationId)), 200)
  const conflicts = await Promise.all([
    power(app, vm.id, 'shutdown'),
    power(app, vm.id, 'force_stop', { confirmVmid: vm.vmid }),
  ])
  assert.deepEqual(conflicts.map((response) => response.status).sort(), [202, 409])
  assert.equal(app.state.commands.length, 2)
})

test('upstream errors stay distinguishable from stopped machines, and unknown submissions require review', async (t) => {
  const app = await setup(t)
  const [vm] = await inventory(app)
  const user = await addOperator(app)
  await checked(grant(app, user.id, [{ machineId: vm.id, permissions: ['view', 'shutdown'] }]), 204)

  app.state.inventoryError = 502
  const offline = await checked(app.request('/api/machines/' + vm.id, { token: app.user }), 200)
  assert.equal(offline.status, 'unreachable')
  await checked(app.request('/api/admin/machines/sync', { method: 'POST', body: {} }), 502)
  app.state.inventoryError = null
  assert.equal((await checked(app.request('/api/machines/' + vm.id, { token: app.user }), 200)).available, true)

  app.state.powerError = 403
  const rejected = await checked(power(app, vm.id, 'shutdown', { token: app.user }), 202)
  assert.equal((await checked(app.request(operationUrl(rejected.operationId)), 200)).state, 'failed')

  app.state.powerError = null
  const delayed = await checked(power(app, vm.id, 'shutdown', { token: app.user }), 202)
  app.state.taskError = 502
  const checking = await checked(app.request(operationUrl(delayed.operationId)), 200)
  assert.equal(checking.state, 'running')
  assert.match(checking.message, /暂时无法查询/)
  await app.db.prepare('UPDATE operations SET checked_at = 0, last_reachable_at = 0 WHERE id = ?')
    .bind(delayed.operationId).run()
  const unreachable = await checked(app.request(operationUrl(delayed.operationId)), 200)
  assert.equal(unreachable.state, 'unknown')
  await checked(app.request('/api/admin/operations/' + delayed.operationId + '/resolve', {
    method: 'POST', body: { note: '已在 PVE 确认任务结束。' },
  }), 204)
  app.state.taskError = null

  app.state.powerError = 504
  const unknown = await checked(power(app, vm.id, 'shutdown', { token: app.user }), 202)
  assert.equal((await checked(app.request(operationUrl(unknown.operationId)), 200)).state, 'unknown')
  await checked(power(app, vm.id, 'shutdown', { token: app.user }), 409)
  const resolve = '/api/admin/operations/' + unknown.operationId + '/resolve'
  await checked(app.request(resolve, { method: 'POST', body: { note: 'PVE 未收到操作。' }, token: app.user }), 401)
  await checked(app.request(resolve, { method: 'POST', body: { note: 'PVE 未收到操作。' } }), 204)
  assert.equal((await checked(app.request(operationUrl(unknown.operationId)), 200)).state, 'resolved')
  assert.equal((await checked(app.request('/api/machines/' + vm.id), 200)).busy, false)

  const removed = app.state.guests.shift()
  await inventory(app)
  await checked(app.request('/api/machines/' + vm.id, { token: app.user }), 404)
  app.state.guests.unshift(removed)
  await inventory(app)
  await checked(app.request('/api/machines/' + vm.id, { token: app.user }), 404)
})

test('invitation rotation rejects old enrollment tokens and revokes ordinary-user sessions', async (t) => {
  const app = await setup(t)
  const operator = await addOperator(app)
  const options = (token) => app.request('/api/auth/enroll/options', {
    token: null, method: 'POST', body: { token },
  })
  const original = await checked(options(operator.enrollmentToken), 200)
  assert.equal(original.options.user.name, userEmail)
  const next = await checked(app.request('/api/admin/users/' + operator.id + '/enrollment', {
    method: 'POST', body: {},
  }), 200)
  await checked(options(operator.enrollmentToken), 403)
  await checked(options(next.enrollmentToken), 200)
  await checked(app.request('/api/me', { token: app.user }), 401)
  const stored = await app.db.prepare('SELECT enrollment_hash FROM users WHERE id = ?').bind(operator.id).first()
  assert.notEqual(stored.enrollment_hash, next.enrollmentToken)
  await app.db.prepare('UPDATE users SET enrollment_expires_at = 0 WHERE id = ?').bind(operator.id).run()
  await checked(options(next.enrollmentToken), 403)
})
