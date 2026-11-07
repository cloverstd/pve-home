import { once } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { expect, test } from '@playwright/test'
import { fixture, userEmail } from './fixture.mjs'

test('administrator issues a one-time token and operator enrolls, signs in and loses access on revocation', async ({ browser }) => {
  let app
  let origin
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers(request.headers)
      const match = headers.get('cookie')?.match(/(?:^|;\s*)fixture_access=([^;]+)/)
      headers.delete('Cf-Access-Jwt-Assertion')
      if (match) {
        headers.set('Cf-Access-Jwt-Assertion', match[1])
        const cookies = headers.get('cookie').split(';').filter((cookie) => !cookie.trim().startsWith('fixture_access='))
        if (cookies.length) headers.set('cookie', cookies.join(';'))
        else headers.delete('cookie')
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const result = await app.mf.dispatchFetch(origin + request.url, {
        method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      // dispatchFetch may decode compressed bodies. The browser receives the decoded stream.
      const responseHeaders = Object.fromEntries(result.headers)
      delete responseHeaders['content-encoding']
      delete responseHeaders['content-length']
      response.writeHead(result.status, responseHeaders)
      if (result.body) Readable.fromWeb(result.body).pipe(response)
      else response.end()
    } catch {
      response.writeHead(500).end()
    }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = 'http://localhost:' + server.address().port
  try {
    app = await fixture(origin)
    const admin = await browser.newContext()
    const operator = await browser.newContext({
      viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
      userAgent: 'Passkey test browser', extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.8' },
    })
    await admin.addCookies([{ url: origin, name: 'fixture_access', value: app.admin, httpOnly: true }])

    const consolePage = await admin.newPage()
    await consolePage.goto(origin + '/admin')
    await expect(consolePage.getByRole('heading', { name: '机器面板' })).toBeVisible()
    await consolePage.getByRole('button', { name: '同步机器' }).click()
    await expect(consolePage.getByRole('heading', { name: 'build-vm' })).toBeVisible()
    await consolePage.getByRole('button', { name: '用户与权限' }).click()
    await consolePage.getByLabel('用户邮箱').fill(userEmail)
    await consolePage.getByRole('button', { name: '添加用户' }).click()
    const invitation = consolePage.getByRole('dialog', { name: '一次性初始化 Token' })
    const token = await invitation.getByLabel('初始化 Token').inputValue()
    await invitation.getByRole('button', { name: '完成' }).click()
    await consolePage.getByRole('button', { name: '分配权限' }).click()
    const grant = consolePage.getByRole('group', { name: /build-vm/ })
    await grant.getByLabel('查看', { exact: true }).check()
    await grant.getByLabel('正常关机').check()
    await grant.getByLabel('强制关机').check()
    await consolePage.getByRole('button', { name: '保存权限' }).click()
    await expect(consolePage.getByText('已分配 1 台机器')).toBeVisible()

    const userPage = await operator.newPage()
    const cdp = await operator.newCDPSession(userPage)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } })
    await userPage.goto(origin)
    await userPage.getByText('首次绑定 Passkey', { exact: true }).click()
    await userPage.getByLabel('初始化 Token').fill(token)
    await userPage.getByRole('button', { name: '绑定并登录' }).click()
    const vm = userPage.getByRole('article', { name: 'build-vm' })
    await expect(vm).toBeVisible()
    const replay = await operator.request.post(origin + '/api/auth/enroll/options', {
      headers: { Origin: origin }, data: { token },
    })
    expect(replay.status()).toBe(403)
    await userPage.getByRole('button', { name: '退出登录' }).click()
    const loginResponse = userPage.waitForResponse(origin + '/api/auth/login/verify')
    await userPage.getByRole('button', { name: '使用 Passkey 登录' }).click()
    const login = await loginResponse
    expect(login.status()).toBe(204)
    await expect(vm).toBeVisible()
    const loginReplay = await operator.request.post(origin + '/api/auth/login/verify', {
      headers: { Origin: origin }, data: login.request().postDataJSON(),
    })
    expect(loginReplay.status()).toBe(401)
    await expect(userPage.getByRole('article', { name: 'private-vm' })).toHaveCount(0)
    await expect(userPage.getByRole('button', { name: '用户与权限' })).toHaveCount(0)
    expect(await userPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await vm.getByRole('button', { name: '强制关机' }).click()
    const confirm = userPage.getByRole('button', { name: '确认强制关机' })
    await expect(confirm).toBeDisabled()
    await userPage.getByLabel('输入 VMID 101 确认').fill('102')
    await expect(confirm).toBeDisabled()
    await userPage.getByLabel('输入 VMID 101 确认').fill('101')
    await confirm.click()
    await expect(userPage.getByRole('dialog')).not.toBeVisible()
    expect(app.state.commands).toHaveLength(1)
    expect(app.state.commands[0]).toMatchObject({ id: 101, verb: 'stop' })
    await userPage.getByRole('button', { name: '操作记录' }).click()
    await expect(userPage.getByText('执行中')).toBeVisible()
    app.state.taskStatus = { status: 'stopped', exitstatus: 'OK' }
    await expect(userPage.getByText('已完成')).toBeVisible({ timeout: 10_000 })

    await consolePage.getByRole('button', { name: '分配权限' }).click()
    await consolePage.getByRole('group', { name: /build-vm/ }).getByLabel('查看', { exact: true }).uncheck()
    await consolePage.getByRole('button', { name: '保存权限' }).click()
    await expect(consolePage.getByText('已分配 0 台机器')).toBeVisible()
    await userPage.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(userPage.getByText('暂无操作记录')).toBeVisible()
    await userPage.getByRole('button', { name: '机器面板' }).click()
    await expect(userPage.getByText('暂无可用机器')).toBeVisible()

    await consolePage.getByRole('button', { name: '审计日志' }).click()
    const passkeyLogins = consolePage.getByRole('row').filter({ hasText: userEmail }).filter({ hasText: 'Passkey' })
    await expect(passkeyLogins).toHaveCount(2)
    await expect(passkeyLogins.getByRole('cell', { name: '192.0.2.8', exact: true })).toHaveCount(2)
    await expect(passkeyLogins.getByRole('cell', { name: 'Passkey test browser', exact: true })).toHaveCount(2)
  } finally {
    await app?.mf.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
