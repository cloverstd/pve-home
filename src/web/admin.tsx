import { KeyRound, Plus, ShieldCheck, Trash2, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { actions, type AuditEvent, type Enrollment, type Machine, type ManagedUser, type Permission } from '../contracts'
import { api, mutation, useQuery } from './api'
import { Alert, Empty, Loading, Modal, formatTime, permissionLabel, useMutation } from './components'

export function UsersPage({ machines, revision, done }: {
  machines: Machine[]; revision: number; done: (message: string) => void
}) {
  const users = useQuery<{ users: ManagedUser[] }>('/admin/users', revision)
  const [email, setEmail] = useState('')
  const [editing, setEditing] = useState<ManagedUser>()
  const [removing, setRemoving] = useState<ManagedUser>()
  const [resetting, setResetting] = useState<ManagedUser>()
  const [invite, setInvite] = useState<Enrollment>()
  const add = useMutation((message) => { setEmail(''); done(message) })
  const toggle = useMutation(done)

  return <>
    <section className="panel padded">
      <div className="section-title"><ShieldCheck size={19} /><h2>添加普通用户</h2></div>
      <p className="muted">添加用户后，将一次性初始化 Token 交给对方绑定 Passkey。</p>
      <form className="add-user" onSubmit={(event) => {
        event.preventDefault()
        void add.run(async () => {
          setInvite(await api<Enrollment>('/admin/users', mutation('POST', { email })))
          return '已添加用户。'
        })
      }}>
        <label className="field"><span>用户邮箱</span>
          <input type="email" placeholder="user@example.com" value={email} maxLength={254}
            required onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button className="button primary" disabled={add.pending}><Plus size={17} /> 添加用户</button>
      </form>
      {add.error && <Alert>{add.error}</Alert>}
    </section>
    {users.error && <Alert>{users.error.message}</Alert>}
    {toggle.error && <Alert>{toggle.error}</Alert>}
    <section className="panel">
      <div className="panel-heading">
        <div className="section-title"><UsersRound size={18} /><h2>普通用户</h2>
          {users.data && <span className="count">{users.data.users.length}</span>}
        </div>
      </div>
      {!users.data && !users.error && <Loading />}
      {users.data?.users.length === 0 && <Empty icon={<UsersRound size={26} />} title="还没有普通用户"
        text="添加用户后，即可按机器分配权限。" />}
      {users.data?.users.map((user) => <div className="user-row" key={user.id}>
        <div className="user-name"><strong>{user.email}</strong><span>已分配 {user.grants.length} 台机器 · {user.passkeyRegistered ? '已绑定 Passkey' : '未绑定 Passkey'}</span></div>
        <span className={'badge ' + (user.enabled ? 'good' : 'neutral')}><i />{user.enabled ? '已启用' : '已禁用'}</span>
        <div className="row-actions">
          <button className="button small" onClick={() => setEditing(user)}><KeyRound size={14} /> 分配权限</button>
          <button className="button small" disabled={toggle.pending} onClick={() => void toggle.run(async () => {
            await api('/admin/users/' + user.id, mutation('PATCH', { enabled: !user.enabled }))
            return user.enabled ? '已禁用用户。' : '已启用用户。'
          })}>{user.enabled ? '禁用' : '启用'}</button>
          <button className="button small" onClick={() => setResetting(user)}>重发初始化 Token</button>
          <button className="icon-button delete" aria-label={'移除 ' + user.email} onClick={() => setRemoving(user)}><Trash2 size={16} /></button>
        </div>
      </div>)}
    </section>
    {invite && <EnrollmentDialog invite={invite} close={() => setInvite(undefined)} />}
    {resetting && <ResetEnrollmentDialog user={resetting} close={() => setResetting(undefined)}
      done={(nextInvite) => { setResetting(undefined); setInvite(nextInvite); done('已生成新的初始化 Token。') }} />}
    {editing && <GrantsDialog user={editing} machines={machines.filter((machine) => machine.available)}
      close={() => setEditing(undefined)} done={(message) => { setEditing(undefined); done(message) }} />}
    {removing && <RemoveUserDialog user={removing}
      close={() => setRemoving(undefined)} done={(message) => { setRemoving(undefined); done(message) }} />}
  </>
}

function EnrollmentDialog({ invite, close }: { invite: Enrollment; close: () => void }) {
  const [copied, setCopied] = useState(false)
  return <Modal title="一次性初始化 Token" close={close}>
    <div className="dialog-body">
      <p>请私下将 Token 交给用户。它只显示一次，使用后立即失效。</p>
      <p className="muted">有效期至 {formatTime(invite.enrollmentExpiresAt)}</p>
      <label className="field">初始化 Token
        <input className="token-copy" readOnly value={invite.enrollmentToken} onFocus={(e) => e.target.select()} />
      </label>
    </div>
    <div className="dialog-footer">
      <button className="button" onClick={() => {
        void navigator.clipboard.writeText(invite.enrollmentToken).then(() => setCopied(true)).catch(() => {})
      }}>{copied ? '已复制' : '复制 Token'}</button>
      <button className="button primary" onClick={close}>完成</button>
    </div>
  </Modal>
}

function ResetEnrollmentDialog({ user, close, done }: {
  user: ManagedUser; close: () => void; done: (invite: Enrollment) => void
}) {
  const { pending, error, run } = useMutation(() => {})
  return <Modal title="重发初始化 Token" close={() => { if (!pending) close() }}>
    <div className="dialog-body">
      <p><strong>{user.email}</strong> 的现有 Passkey 和登录会话将被撤销。请将新 Token 交给用户重新绑定。</p>
      {error && <Alert>{error}</Alert>}
    </div>
    <div className="dialog-footer">
      <button className="button" disabled={pending} onClick={close}>取消</button>
      <button className="button danger" disabled={pending} onClick={() => void run(async () => {
        done(await api<Enrollment>('/admin/users/' + user.id + '/enrollment', mutation('POST')))
        return ''
      })}>确认重发</button>
    </div>
  </Modal>
}

function GrantsDialog({ user, machines, close, done }: {
  user: ManagedUser; machines: Machine[]; close: () => void; done: (message: string) => void
}) {
  const [grants, setGrants] = useState(() => new Map(user.grants.map((grant) => [grant.machineId, grant.permissions])))
  const { pending, error, run } = useMutation(done)
  const toggle = (id: string, permission: Permission, checked: boolean) => {
    setGrants((old) => {
      const next = new Map(old)
      const permissions = new Set(next.get(id))
      if (permission === 'view' && !checked) next.delete(id)
      else {
        if (checked) permissions.add(permission)
        else permissions.delete(permission)
        next.set(id, [...permissions])
      }
      return next
    })
  }
  return <Modal title="分配机器权限" close={() => { if (!pending) close() }}>
    <form onSubmit={(event) => {
      event.preventDefault()
      void run(async () => {
        await api('/admin/users/' + user.id + '/grants', mutation('PUT', {
          grants: machines.flatMap((machine) => grants.has(machine.id)
            ? [{ machineId: machine.id, permissions: grants.get(machine.id) }] : []),
        }))
        return '已保存机器权限。'
      })
    }}>
      <div className="dialog-body">
        <p><strong>{user.email}</strong></p>
        <p className="muted">先勾选查看权限，再选择允许的电源操作。</p>
        {!machines.length && <Alert>暂无可分配机器。请先在机器面板同步清单。</Alert>}
        <div className="grant-list">
          {machines.map((machine) => <fieldset key={machine.id}>
            <legend>{machine.name} <span>· {machine.kind.toUpperCase()} {machine.vmid}</span></legend>
            <div className="permission-options">
              {(['view', ...actions] as const).map((permission) => <label key={permission}>
                <input type="checkbox" checked={grants.get(machine.id)?.includes(permission) ?? false}
                  disabled={pending || (permission !== 'view' && !grants.has(machine.id))}
                  onChange={(event) => toggle(machine.id, permission, event.target.checked)} />
                {permissionLabel[permission]}
              </label>)}
            </div>
          </fieldset>)}
        </div>
        {error && <Alert>{error}</Alert>}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button" disabled={pending} onClick={close}>取消</button>
        <button className="button primary" disabled={pending || !machines.length}>保存权限</button>
      </div>
    </form>
  </Modal>
}

function RemoveUserDialog({ user, close, done }: { user: ManagedUser; close: () => void; done: (message: string) => void }) {
  const { pending, error, run } = useMutation(done)
  return <Modal title="移除用户" close={() => { if (!pending) close() }}>
    <div className="dialog-body">
      <p>移除 <strong>{user.email}</strong> 后，该用户的机器授权将同时清除。</p>
      {error && <Alert>{error}</Alert>}
    </div>
    <div className="dialog-footer">
      <button className="button" disabled={pending} onClick={close}>取消</button>
      <button className="button danger" disabled={pending} onClick={() => void run(async () => {
        await api('/admin/users/' + user.id, mutation('DELETE'))
        return '已移除用户。'
      })}>确认移除</button>
    </div>
  </Modal>
}

const auditActions: Record<string, string> = {
  start: '开机', shutdown: '正常关机', force_stop: '强制关机', add_user: '添加用户',
  enable_user: '启用用户', disable_user: '禁用用户', remove_user: '移除用户',
  reset_enrollment: '重发初始化 Token', set_grants: '更新权限', sync_machines: '同步机器', resolve_operation: '核查操作',
}
const auditResults: Record<string, string> = {
  ok: '成功', submitting: '正在提交', running: '执行中', succeeded: '已完成',
  failed: '失败', unknown: '结果未知', resolved: '已核查',
}

function auditResult(result: string) {
  if (result.startsWith('synced:')) return '同步 ' + result.slice(7) + ' 台'
  if (result.startsWith('machines:')) return '分配 ' + result.slice(9) + ' 台'
  return auditResults[result] ?? result
}

export function AuditPage({ revision }: { revision: number }) {
  const [before, setBefore] = useState<number>()
  const path = '/admin/audit' + (before === undefined ? '' : '?before=' + before)
  const { data, error } = useQuery<{ events: AuditEvent[]; next: number | null }>(path, revision)
  return <section className="panel">
    {error && <Alert>{error.message}</Alert>}
    {!data && !error && <Loading />}
    {data?.events.length === 0 && <Empty icon={<ShieldCheck size={26} />} title="暂无审计记录" text="电源操作和管理变更将在这里显示。" />}
    {!!data?.events.length && <div className="table-wrap">
      <table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>结果</th></tr></thead>
        <tbody>{data.events.map((item) => <tr key={item.id}>
          <td>{formatTime(item.at)}</td><td>{item.actorEmail}</td><td>{auditActions[item.action] ?? item.action}</td>
          <td>{item.target}</td><td>{auditResult(item.result)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {(before || data?.next) && <div className="panel-footer">
      <button className="button small" disabled={!before} onClick={() => setBefore(undefined)}>最新记录</button>
      <button className="button small" disabled={!data?.next} onClick={() => setBefore(data?.next ?? undefined)}>更早记录</button>
    </div>}
  </section>
}
