import { Activity, ClipboardList, DatabaseZap, HardDrive, LayoutGrid, LogOut, RefreshCw, ShieldCheck, UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Machine, Operation, PowerAction, Viewer } from '../contracts'
import { api, isAdminPage, mutation, useQuery } from './api'
import { AuditPage, UsersPage } from './admin'
import { Alert, Loading, useMutation } from './components'
import { MachineList, PowerDialog } from './machines'
import { OperationsPage } from './operations'
import { UserLogin } from './login'
import './styles.css'

const navigation = [
  { id: 'machines', title: '机器面板', icon: LayoutGrid, subtitle: '查看和管理虚拟机及容器的电源状态。' },
  { id: 'operations', title: '操作记录', icon: ClipboardList, subtitle: '跟踪电源操作的进度和结果。' },
  { id: 'users', title: '用户与权限', icon: UsersRound, subtitle: '添加用户、发放初始化 Token，按机器分配操作权限。' },
  { id: 'audit', title: '审计日志', icon: ShieldCheck, subtitle: '查看登录、电源操作和管理员变更。' },
] as const

type Page = typeof navigation[number]['id']

function Brand() {
  return <div className="brand">
    <div className="brand-mark"><HardDrive size={23} strokeWidth={2.2} aria-hidden /></div>
    <span><strong>PVE Home</strong><small>远程管理台</small></span>
  </div>
}

function App() {
  const [revision, setRevision] = useState(0)
  const { data: viewer, error } = useQuery<Viewer>('/me', revision, 30_000)
  if (viewer) return <Dashboard viewer={viewer} />
  return <main className="session">
    <div className="session-card">
      <Brand />
      {error && !isAdminPage ? <UserLogin done={() => setRevision((n) => n + 1)} /> : error ? <>
        <h1>{error.status === 403 ? '账号未获授权' : '无法进入管理台'}</h1>
        <Alert>{error.message}</Alert>
        <a className="button" href="/cdn-cgi/access/logout">切换账号或重新登录</a>
      </> : <Loading />}
    </div>
  </main>
}

function Dashboard({ viewer }: { viewer: Viewer }) {
  const [page, setPage] = useState<Page>('machines')
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [power, setPower] = useState<{ machine: Machine; action: PowerAction }>()
  const [fast, setFast] = useState(false)
  const admin = viewer.role === 'admin'
  const refresh = () => setRevision((value) => value + 1)
  const done = (message: string) => { setNotice(message); refresh() }
  const { pending, error, run, clearError } = useMutation(done)
  const interval = fast ? 3_000 : 15_000
  const machines = useQuery<{ machines: Machine[] }>('/machines', revision, interval)
  const operations = useQuery<{ operations: Operation[] }>('/operations', revision, interval)
  const operationList = operations.data?.operations ?? []
  const hasTasks = operationList.some(({ state }) => state === 'running' || state === 'submitting')
  const title = navigation.find((item) => item.id === page) ?? navigation[0]

  useEffect(() => { setFast(hasTasks) }, [hasTasks])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6500)
    return () => clearTimeout(timer)
  }, [notice])

  return <div className="shell">
    <a className="skip-link" href="#main">跳转到内容</a>
    <aside className="sidebar">
      <Brand />
      <div className="nav-label">工作台</div>
      <nav aria-label="主导航">
        {navigation.filter((item) => admin || item.id === 'machines' || item.id === 'operations')
          .map(({ id, title: label, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined}
            className={page === id ? 'active' : ''} onClick={() => { setPage(id); clearError() }}>
            <Icon size={18} aria-hidden /> {label}
          </button>)}
      </nav>
      <div className="sidebar-account">
        <div className="avatar" aria-hidden>{viewer.email.slice(0, 1).toUpperCase()}</div>
        <div className="account-info"><strong title={viewer.email}>{viewer.email}</strong>
          <span>{admin ? '全局管理员' : '普通用户'}</span></div>
        {admin ? <a className="sign-out" href="/cdn-cgi/access/logout" title="退出登录" aria-label="退出登录"><LogOut size={17} /></a>
          : <button className="sign-out sign-out-button" title="退出登录" aria-label="退出登录" onClick={() => void run(async () => {
            await api('/auth/logout', mutation('POST'))
            window.location.assign('/')
            return '已退出登录。'
          })}><LogOut size={17} /></button>}
      </div>
    </aside>
    <main id="main" className="main">
      <header className="topbar"><span>工作台 <b>/</b> {title.title}</span>
        <span className="topbar-right"><Activity size={15} aria-hidden /> Proxmox VE</span>
      </header>
      <div className="content">
        <div className="page-heading">
          <div><h1>{title.title}</h1><p>{title.subtitle}</p></div>
          <div className="toolbar">
            {admin && page === 'machines' && <>
              <button className="button" disabled={pending} onClick={() => void run(async () => {
                const result = await api<{ guests: number; elapsedMs: number }>('/admin/connection')
                return 'PVE 连接正常，发现 ' + result.guests + ' 台机器（' + result.elapsedMs + ' ms）。'
              })}><Activity size={16} /> 检查连接</button>
              <button className="button primary" disabled={pending} onClick={() => void run(async () => {
                const result = await api<{ synced: number; retired: number }>('/admin/machines/sync', mutation('POST'))
                return '已同步 ' + result.synced + ' 台机器' + (result.retired ? '，停用 ' + result.retired + ' 台。' : '。')
              })}><DatabaseZap size={16} /> 同步机器</button>
            </>}
            <button className="icon-button refresh" title="刷新" aria-label="刷新" onClick={refresh}><RefreshCw size={17} /></button>
          </div>
        </div>
        {notice && <Alert positive>{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        {page === 'machines' && <>
          {machines.error && <Alert>{machines.error.message}</Alert>}
          {!machines.data && !machines.error && <Loading />}
          {machines.data && <MachineList machines={machines.data.machines}
            onAction={(machine, action) => setPower({ machine, action })} />}
        </>}
        {page === 'operations' && <>
          {operations.error && <Alert>{operations.error.message}</Alert>}
          {!operations.data && !operations.error && <Loading />}
          {operations.data && <OperationsPage operations={operationList} admin={admin} done={done} />}
        </>}
        {admin && page === 'users' && <UsersPage machines={machines.data?.machines ?? []} revision={revision} done={done} />}
        {admin && page === 'audit' && <AuditPage revision={revision} />}
      </div>
    </main>
    {power && <PowerDialog {...power} close={() => setPower(undefined)}
      done={(message) => { setPower(undefined); done(message) }} />}
  </div>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
