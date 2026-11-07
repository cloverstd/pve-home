import { ClipboardList } from 'lucide-react'
import { useState } from 'react'
import type { Operation } from '../contracts'
import { api, mutation } from './api'
import { Alert, Empty, Modal, OperationBadge, formatTime, permissionLabel, useMutation } from './components'

export function OperationsPage({ operations, admin, done }: {
  operations: Operation[]; admin: boolean; done: (message: string) => void
}) {
  const [resolving, setResolving] = useState<Operation>()
  return <section className="panel">
    {operations.length ? <div className="table-wrap">
      <table>
        <thead><tr><th>机器</th><th>操作</th><th>状态</th>{admin && <th>操作者</th>}<th>提交时间</th></tr></thead>
        <tbody>{operations.map((operation) => <tr key={operation.id}>
          <td><strong>{operation.machineName}</strong><span className="table-secondary">VMID {operation.vmid}</span></td>
          <td>{permissionLabel[operation.action]}</td>
          <td><OperationBadge state={operation.state} />
            {operation.message && <span className="table-secondary task-message">{operation.message}</span>}
            {admin && operation.state === 'unknown' && <button className="button small resolve-button"
              onClick={() => setResolving(operation)}>核查后解除</button>}
          </td>
          {admin && <td>{operation.actorEmail}</td>}
          <td>{formatTime(operation.createdAt)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <Empty icon={<ClipboardList size={26} />} title="暂无操作记录" text="提交电源操作后，可在此查看进度和结果。" />}
    {resolving && <ResolveDialog operation={resolving} close={() => setResolving(undefined)}
      done={(message) => { setResolving(undefined); done(message) }} />}
  </section>
}

function ResolveDialog({ operation, close, done }: { operation: Operation; close: () => void; done: (message: string) => void }) {
  const [note, setNote] = useState('')
  const { pending, error, run } = useMutation(done)
  return <Modal title="解除操作占用" close={() => { if (!pending) close() }}>
    <form onSubmit={(event) => {
      event.preventDefault()
      void run(async () => {
        await api('/admin/operations/' + operation.id + '/resolve', mutation('POST', { note }))
        return '已记录核查结果并解除占用。'
      })
    }}>
      <div className="dialog-body">
        <p><strong>{operation.machineName}</strong> · VMID {operation.vmid}</p>
        <Alert>请先在 PVE 检查机器和任务状态。解除占用后，可以再次提交电源操作。</Alert>
        <label className="field">核查结果<textarea value={note} onChange={(e) => setNote(e.target.value)} required maxLength={300} rows={3} /></label>
        {error && <Alert>{error}</Alert>}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button" disabled={pending} onClick={close}>取消</button>
        <button className="button primary" disabled={pending || !note.trim()}>确认解除</button>
      </div>
    </form>
  </Modal>
}
