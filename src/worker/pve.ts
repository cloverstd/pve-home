import { z } from 'zod'
import type { PowerAction } from '../contracts'
import { ApiError } from './errors'

const resourceSchema = z.object({
  type: z.enum(['qemu', 'lxc']),
  vmid: z.number().int().min(100).max(999999999),
  node: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
  name: z.string().nullish(),
  status: z.string().nullish(),
  template: z.union([z.boolean(), z.number()]).optional(),
  cpu: z.number().nullish(),
  mem: z.number().nullish(),
  maxmem: z.number().nullish(),
  uptime: z.number().nullish(),
})

const taskSchema = z.object({
  status: z.enum(['running', 'stopped']),
  exitstatus: z.string().optional(),
})

export type Resource = z.infer<typeof resourceSchema>

export const PVE_READ_TIMEOUT_MS = 15_000
const PVE_WRITE_TIMEOUT_MS = 8_000

const retryableVpcErrors = new Set([
  'connection_terminated', 'connection_timeout', 'connection_read_timeout',
  'dns_error', 'dns_timeout', 'http_response_incomplete', 'proxy_internal_error',
])
const knownVpcErrors = new Set([
  ...retryableVpcErrors,
  'connection_refused', 'connection_limit_reached', 'connection_write_timeout',
  'destination_unavailable', 'destination_ip_unroutable', 'proxy_loop_detected',
  'tls_protocol_error', 'tls_certificate_error', 'http_request_error',
  'http_request_denied', 'http_protocol_error', 'rate_limited',
])

function vpcErrorCode(error: unknown) {
  if (!(error instanceof Error)) return null
  if (error.name === 'TimeoutError') return 'connection_read_timeout'
  const code = /ProxyError:\s*([a-z_]+)/.exec(error.message)?.[1]
  return code && knownVpcErrors.has(code) ? code : null
}

export function resourceKey(kind: string, vmid: number) {
  return kind + ':' + vmid
}

export class PveError extends ApiError {
  constructor(
    code: string,
    message: string,
    readonly uncertain = false,
    status: 502 | 503 | 504 = 502,
  ) {
    super(status, code, message)
  }
}

export class PveClient {
  constructor(private readonly env: Cloudflare.Env) {}

  async resources(): Promise<Resource[]> {
    const data = await this.request('/cluster/resources?type=vm')
    const entries = z.array(z.object({ type: z.string() }).passthrough()).safeParse(data)
    if (!entries.success) throw invalidResponse()
    const result = z.array(resourceSchema).safeParse(
      entries.data.filter((entry) => entry.type === 'qemu' || entry.type === 'lxc'),
    )
    if (!result.success) throw invalidResponse()

    const guests = result.data.filter((entry) => !entry.template)
    if (new Set(guests.map((entry) => resourceKey(entry.type, entry.vmid))).size !== guests.length) {
      throw invalidResponse()
    }
    return guests
  }

  async power(resource: Resource, action: PowerAction): Promise<string> {
    const verb = action === 'force_stop' ? 'stop' : action
    const path = '/nodes/' + encodeURIComponent(resource.node) + '/' + resource.type
      + '/' + resource.vmid + '/status/' + verb
    const params = new URLSearchParams(action === 'shutdown' ? { timeout: '60', forceStop: '0' } : {})
    const data = await this.request(path, params)
    if (typeof data !== 'string' || data.length > 512 || !data.startsWith('UPID:' + resource.node + ':')) {
      throw invalidResponse(true)
    }
    return data
  }

  async task(node: string, upid: string) {
    const data = await this.request('/nodes/' + encodeURIComponent(node) + '/tasks/' + encodeURIComponent(upid) + '/status')
    const result = taskSchema.safeParse(data)
    if (!result.success || (result.data.status === 'stopped' && !result.data.exitstatus)) {
      throw invalidResponse()
    }
    return result.data
  }

  private async request(path: string, params?: URLSearchParams): Promise<unknown> {
    const origin = URL.parse(this.env.PVE_ORIGIN)
    const binding = this.env.PVE
    if (!origin || origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash || !this.env.PVE_API_TOKEN || !binding) {
      throw new PveError('pve_not_configured', 'PVE 连接尚未配置。', false, 503)
    }

    const token = this.env.PVE_API_TOKEN.trim().replace(/^(?:Authorization:\s*)?PVEAPIToken\s*=\s*/i, '')
    if (!/^[^\s!=]+@[^\s@!=]+![^\s!=]+=[^\s=<>]+$/.test(token)) {
      throw new PveError('pve_token_format', 'PVE_API_TOKEN 格式应为 user@realm!token=secret。', false, 503)
    }

    const write = params !== undefined
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: 'PVEAPIToken=' + token,
    })
    if (write) headers.set('Content-Type', 'application/x-www-form-urlencoded')

    const signal = AbortSignal.timeout(write ? PVE_WRITE_TIMEOUT_MS : PVE_READ_TIMEOUT_MS)
    const fetchPve = () => binding.fetch(origin.origin + '/api2/json' + path, {
      method: write ? 'POST' : 'GET',
      headers,
      body: params?.toString(),
      redirect: 'manual',
      signal,
    })
    let response: Response
    try {
      response = await fetchPve().catch((error: unknown) => {
        const code = vpcErrorCode(error)
        if (write || signal.aborted || !code || !retryableVpcErrors.has(code)) throw error
        return fetchPve()
      })
    } catch (error) {
      const code = vpcErrorCode(error)
      const timedOut = signal.aborted || code === 'connection_read_timeout' || code === 'connection_timeout'
      console.warn(JSON.stringify({ event: 'pve_vpc_fetch_failed', code: code ?? (timedOut ? 'timeout' : 'unknown'), write }))
      const detail = code ? '（' + code + '）' : ''
      if (timedOut) throw new PveError('pve_timeout', 'PVE 请求超时' + detail + '。', write, 504)
      throw new PveError('pve_unreachable', '无法通过 VPC 连接 PVE' + detail + '。', write, 503)
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401) {
        throw new PveError('pve_token_invalid', 'PVE 未接受 API Token（HTTP 401）。请核对 Token ID、最新密钥及有效期。')
      }
      if (response.status === 403) {
        throw new PveError('pve_forbidden', 'PVE 拒绝此操作（HTTP 403）。请检查 Token 及所属用户的 PVE 权限。')
      }
      throw new PveError('pve_rejected', 'PVE 返回请求错误（HTTP ' + response.status + '）。',
        write && (response.status < 400 || response.status >= 500 || response.status === 408))
    }

    try {
      return z.object({ data: z.unknown() }).parse(await response.json()).data
    } catch {
      throw invalidResponse(write)
    }
  }
}

function invalidResponse(uncertain = false) {
  return new PveError('pve_invalid_response', 'PVE 返回了无法识别的响应。', uncertain)
}
