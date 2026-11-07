import { once } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { expect, test } from '@playwright/test'
import { fixture, userEmail } from './fixture.mjs'

test('administrator grants access, operator controls a VM, then loses access on revocation', async ({ browser }) => {
  let app
  let origin
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers(request.headers)
      const match = headers.get('cookie')?.match(/(?:^|;\s*)fixture_access=([^;]+)/)
      headers.delete('Cf-Access-Jwt-Assertion')
      headers.delete('cookie')
      if (match) headers.set('Cf-Access-Jwt-Assertion', match[1])
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
  origin = 'http://127.0.0.1:' + server.address().port
  try {
    app = await fixture(origin)
    const admin = await browser.newContext()
    const operator = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
    await admin.addCookies([{ url: origin, name: 'fixture_access', value: app.admin, httpOnly: true }])
    await operator.addCookies([{ url: origin, name: 'fixture_access', value: app.user, httpOnly: true }])

    const consolePage = await admin.newPage()
    await consolePage.goto(origin)
    await expect(consolePage.getByRole('heading', { name: '机器面板' })).toBeVisible()
    await consolePage.getByRole('button', { name: '同步机器' }).click()
    await expect(consolePage.getByRole('heading', { name: 'build-vm' })).toBeVisible()
    await consolePage.getByRole('button', { name: '用户与权限' }).click()
    await consolePage.getByLabel('Google 邮箱').fill(userEmail)
    await consolePage.getByRole('button', { name: '添加用户' }).click()
    await consolePage.getByRole('button', { name: '分配权限' }).click()
    const grant = consolePage.getByRole('group', { name: /build-vm/ })
    await grant.getByLabel('查看', { exact: true }).check()
    await grant.getByLabel('正常关机').check()
    await grant.getByLabel('强制关机').check()
    await consolePage.getByRole('button', { name: '保存权限' }).click()
    await expect(consolePage.getByText('已分配 1 台机器')).toBeVisible()

    const userPage = await operator.newPage()
    await userPage.goto(origin)
    const vm = userPage.getByRole('article', { name: 'build-vm' })
    await expect(vm).toBeVisible()
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
  } finally {
    await app?.mf.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
