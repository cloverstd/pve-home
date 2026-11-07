import { AlertCircle, CircleCheck, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MachineStatus, OperationState, Permission } from '../contracts'
import { errorText } from './api'

export const permissionLabel: Record<Permission, string> = {
  view: '查看', start: '开机', shutdown: '正常关机', force_stop: '强制关机',
}
export const operationLabel: Record<OperationState, string> = {
  submitting: '正在提交', running: '执行中', succeeded: '已完成', failed: '失败', unknown: '结果未知', resolved: '已核查',
}

const statusLabel: Record<MachineStatus, string> = {
  running: '运行中', stopped: '已关机', unknown: '状态未知', unreachable: '不可达',
}

export function MachineBadge({ status, available }: { status: MachineStatus; available: boolean }) {
  const tone = !available ? 'neutral' : status === 'running' ? 'good' : status === 'stopped' ? 'neutral' : 'warn'
  return <span className={'badge ' + tone}><i />{available ? statusLabel[status] : '已停用'}</span>
}

export function OperationBadge({ state }: { state: OperationState }) {
  const tone = state === 'succeeded' ? 'good' : state === 'failed' ? 'bad' :
    state === 'unknown' ? 'warn' : state === 'running' || state === 'submitting' ? 'info' : 'neutral'
  return <span className={'badge ' + tone}><i />{operationLabel[state]}</span>
}

export function Alert({ children, positive = false }: { children: ReactNode; positive?: boolean }) {
  const Icon = positive ? CircleCheck : AlertCircle
  return <div className={'alert ' + (positive ? 'positive' : '')} role={positive ? 'status' : 'alert'}>
    <Icon size={17} aria-hidden /> <span>{children}</span>
  </div>
}

export function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3><p>{text}</p>
  </div>
}

export function Loading() {
  return <div className="loading" role="status"><LoaderCircle className="spin" size={18} /> 正在加载</div>
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog} className="dialog" aria-label={title} onCancel={(event) => {
    event.preventDefault()
    close()
  }}>
    <div className="dialog-header">
      <h2>{title}</h2>
      <button className="icon-button" type="button" aria-label="关闭" onClick={close}><X size={20} /></button>
    </div>
    {children}
  </dialog>
}

export function useMutation(onSuccess: (message: string) => void) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const run = async (request: () => Promise<string>) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      onSuccess(await request())
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { pending, error, run, clearError: () => setError('') }
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false })
export const formatTime = (value: number) => timeFormat.format(new Date(value))

export function formatBytes(value: number | null) {
  if (value === null) return '—'
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1) + ' GiB'
  return Math.round(value / 1024 ** 2) + ' MiB'
}

export function formatUptime(value: number | null) {
  if (!value) return '—'
  const days = Math.floor(value / 86_400)
  const hours = Math.floor(value % 86_400 / 3600)
  const minutes = Math.floor(value % 3600 / 60)
  return days ? days + ' 天 ' + hours + ' 小时' : hours ? hours + ' 小时 ' + minutes + ' 分钟' : minutes + ' 分钟'
}
