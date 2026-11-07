import { useEffect, useState } from 'react'
import type { ApiProblem } from '../contracts'

export const isAdminPage = window.location.pathname.replace(/\/$/, '') === '/admin'

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (init?.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    const prefix = isAdminPage && !path.startsWith('/admin/') && !path.startsWith('/auth/') ? '/api/admin' : '/api'
    response = await fetch(prefix + path, { ...init, headers, redirect: 'error' })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new RequestError(0, '请求未完成，请检查连接或重新登录。')
  }
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as ApiProblem | null
    throw new RequestError(response.status, problem?.message ?? '请求失败，请稍后再试。')
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function mutation(method: string, body: object = {}, key?: string): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: key ? { 'Idempotency-Key': key } : undefined,
  }
}

export function useQuery<T>(path: string | null, revision: number, interval = 0) {
  const [state, setState] = useState<{ data?: T; error?: RequestError }>({})
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await api<T>(path!, { signal: controller.signal })
        if (!controller.signal.aborted) setState({ data })
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = error instanceof RequestError ? error : new RequestError(0, '请求失败，请重试。')
        setState((old) => ({
          data: failure.status === 401 || failure.status === 403 ? undefined : old.data,
          error: failure,
        }))
      } finally {
        if (interval && !controller.signal.aborted) timer = setTimeout(refresh, interval)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [path, revision, interval])
  return state
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
