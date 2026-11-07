import { Activity, Box, CircleOff, Cpu, HardDrive, LayoutGrid, Monitor, Power, Search, Server, Timer, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { actions, type Machine, type PowerAction } from '../contracts'
import { api, mutation } from './api'
import { Alert, Empty, MachineBadge, Modal, formatBytes, formatUptime, permissionLabel, useMutation } from './components'

export function MachineList({ machines, onAction }: {
  machines: Machine[]
  onAction: (machine: Machine, action: PowerAction) => void
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const active = machines.filter((machine) => machine.available)
  const counts = [
    { label: '机器总数', value: active.length, icon: Server, className: 'indigo' },
    { label: '运行中', value: active.filter((m) => m.status === 'running').length, icon: Activity, className: 'green' },
    { label: '已关机', value: active.filter((m) => m.status === 'stopped').length, icon: CircleOff, className: 'gray' },
    { label: '状态异常', value: active.filter((m) => m.status === 'unreachable' || m.status === 'unknown').length, icon: TriangleAlert, className: 'amber' },
  ]
  const visible = machines.filter((m) => {
    if (filter !== 'all' && m.status !== filter) return false
    return [m.name, m.vmid, m.node, m.kind].join(' ').toLowerCase().includes(search.trim().toLowerCase())
  })

  return <>
    <div className="stat-grid" aria-label="机器概览">
      {counts.map(({ label, value, icon: Icon, className }) => <div className="stat" key={label}>
        <span className={'stat-icon ' + className}><Icon size={19} aria-hidden /></span>
        <span><span className="stat-label">{label}</span><strong>{value}</strong></span>
      </div>)}
    </div>
    <section aria-label="机器列表">
      <div className="section-bar">
        <div className="section-title"><LayoutGrid size={18} aria-hidden /> <h2>机器列表</h2>
          <span className="count">{visible.length}</span></div>
        <div className="toolbar">
          <label className="search"><Search size={17} aria-hidden /><input placeholder="搜索名称、VMID 或节点" aria-label="搜索机器" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <select aria-label="筛选状态" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部状态</option><option value="running">运行中</option>
            <option value="stopped">已关机</option><option value="unknown">状态未知</option>
            <option value="unreachable">不可达</option>
          </select>
        </div>
      </div>
      {visible.length ? <div className="machine-grid">{visible.map((machine) =>
        <MachineCard key={machine.id} machine={machine} onAction={(action) => onAction(machine, action)} />)}
      </div> : <Empty icon={<Server size={27} />} title={machines.length ? '没有匹配的机器' : '暂无可用机器'}
        text={machines.length ? '请调整搜索内容或状态筛选。' : '同步 PVE 清单或请管理员为你分配机器。'} />}
    </section>
  </>
}

function MachineCard({ machine, onAction }: { machine: Machine; onAction: (action: PowerAction) => void }) {
  const Icon = machine.kind === 'qemu' ? Monitor : Box
  const allowed = actions.filter((action) => machine.permissions.includes(action))
  return <article className="machine-card" aria-label={machine.name}>
    <div className="machine-head">
      <div className="guest-icon"><Icon size={21} aria-hidden /></div>
      <div className="machine-name"><h3>{machine.name}</h3>
        <span>{machine.kind === 'qemu' ? 'QEMU 虚拟机' : 'LXC 容器'} <b>·</b> VMID {machine.vmid}</span></div>
      <MachineBadge status={machine.status} available={machine.available} />
    </div>
    <div className="machine-node"><Server size={14} aria-hidden /> {machine.node}</div>
    <dl className="metrics">
      <div><dt><Cpu size={14} aria-hidden /> CPU</dt><dd>{machine.cpu === null ? '—' : (machine.cpu * 100).toFixed(1) + '%'}</dd></div>
      <div><dt><HardDrive size={14} aria-hidden /> 内存</dt><dd>{formatBytes(machine.mem)} <span>/ {formatBytes(machine.maxmem)}</span></dd></div>
      <div><dt><Timer size={14} aria-hidden /> 运行时间</dt><dd>{formatUptime(machine.uptime)}</dd></div>
    </dl>
    <div className="machine-actions">
      {machine.busy && <span className="busy-label">有未结束的操作</span>}
      {!allowed.length && <span className="busy-label">{machine.available ? '仅查看' : '从清单移除'}</span>}
      {allowed.map((action) => <button key={action}
        className={action === 'force_stop' ? 'button small danger-outline' : 'button small'}
        disabled={machine.busy || machine.status !== (action === 'start' ? 'stopped' : 'running')}
        onClick={() => onAction(action)}>
        {action === 'force_stop' ? <TriangleAlert size={14} aria-hidden /> : <Power size={14} aria-hidden />}
        {permissionLabel[action]}
      </button>)}
    </div>
  </article>
}

export function PowerDialog({ machine, action, close, done }: {
  machine: Machine; action: PowerAction; close: () => void; done: (message: string) => void
}) {
  const [vmid, setVmid] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const { pending, error, run } = useMutation(done)
  const force = action === 'force_stop'
  const correctVmid = vmid.trim() === String(machine.vmid)
  return <Modal title={permissionLabel[action]} close={() => { if (!pending) close() }}>
    <form onSubmit={(event) => {
      event.preventDefault()
      if (force && !correctVmid) return
      void run(async () => {
        await api('/machines/' + machine.id + '/actions',
          mutation('POST', { action, ...(force ? { confirmVmid: Number(vmid) } : {}) }, key))
        return '操作已提交。可在操作记录中查看结果。'
      })
    }}>
      <div className="dialog-body">
        <p><strong>{machine.name}</strong> · VMID {machine.vmid}</p>
        {force ? <>
          <Alert>强制关机会立即中止机器，可能导致未保存的数据丢失。</Alert>
          <label className="field">输入 VMID {machine.vmid} 确认
            <input value={vmid} onChange={(e) => setVmid(e.target.value)} inputMode="numeric" autoComplete="off" required autoFocus />
          </label>
        </> : <p className="muted">{action === 'start' ? '向 PVE 提交开机请求。' : '向 PVE 提交正常关机请求，等待系统自行关机。'}</p>}
        {error && <Alert>{error}</Alert>}
      </div>
      <div className="dialog-footer">
        <button className="button" type="button" onClick={close} disabled={pending}>取消</button>
        <button className={'button ' + (force ? 'danger' : 'primary')} disabled={pending || (force && !correctVmid)}>
          {pending ? '正在提交…' : '确认' + permissionLabel[action]}
        </button>
      </div>
    </form>
  </Modal>
}
