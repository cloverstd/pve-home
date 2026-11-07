import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const env = process.env
const dryRun = process.argv.includes('--dry-run')
if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) {
  fail('仅支持 --dry-run 参数。')
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function httpsOrigin(value) {
  const url = URL.parse(value ?? '')
  return url?.protocol === 'https:' && url.origin === value ? url : null
}

if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) fail('请填写 CLOUDFLARE_ACCOUNT_ID。')
function requireResourceId(name) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(env[name] ?? '') ||
      env[name].startsWith('00000000-0000-4000-8000-00000000000')) {
    fail('请填写有效的 ' + name + '。')
  }
}
requireResourceId('PVE_HOME_D1_ID')

const args = ['deploy', '--no-provision']
if (env.PVE_HOME_BOOTSTRAP === '1') {
  if (['APP_ORIGIN', 'ACCESS_ISSUER', 'ACCESS_AUD', 'PVE_VPC_SERVICE_ID', 'PVE_ORIGIN', 'PVE_SECRETS_FILE']
    .some((name) => env[name])) {
    fail('启用项目域名、Access 或 PVE 前，请移除 PVE_HOME_BOOTSTRAP。')
  }
  args.push('--mode', 'bootstrap')
} else {
  const app = httpsOrigin(env.APP_ORIGIN)
  if (!app || app.port || !app.hostname.includes('.')) fail('APP_ORIGIN 必须是 HTTPS 自定义域名的 origin。')
  if (!httpsOrigin(env.PVE_ORIGIN)) fail('PVE_ORIGIN 必须是匹配证书的 HTTPS origin，可指定 8006 端口。')
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER ?? '')) {
    fail('ACCESS_ISSUER 必须是 Access 团队域名。')
  }
  if (!/^[a-f0-9]{64}$/.test(env.ACCESS_AUD ?? '')) fail('ACCESS_AUD 必须是 Access 应用的 AUD tag。')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL ?? '')) fail('ADMIN_EMAIL 必须是有效邮箱。')
  requireResourceId('PVE_VPC_SERVICE_ID')
}
if (dryRun) args.push('--dry-run')
if (env.PVE_SECRETS_FILE) {
  let secrets
  try {
    secrets = JSON.parse(readFileSync(env.PVE_SECRETS_FILE, 'utf8'))
  } catch {
    fail('PVE_SECRETS_FILE 必须指向可读的 JSON 文件。')
  }
  if (!secrets || Object.keys(secrets).length !== 1 ||
      !/^[^\s!]+![^\s=]+=[^\s]+$/.test(secrets.PVE_API_TOKEN ?? '')) {
    fail('秘密文件必须只包含 PVE_API_TOKEN，格式为 user@realm!token=secret。')
  }
  args.push('--secrets-file', env.PVE_SECRETS_FILE)
}

const childEnv = { ...env }
if (env.PVE_SECRETS_FILE) delete childEnv.PVE_API_TOKEN
const result = spawnSync('cf', args, { stdio: 'inherit', env: childEnv })
if (result.error) fail('无法运行 cf，请先安装项目依赖。')
process.exit(result.status ?? 1)
