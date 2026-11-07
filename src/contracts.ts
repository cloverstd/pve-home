export const actions = ['start', 'shutdown', 'force_stop'] as const
export type PowerAction = typeof actions[number]
export type Permission = 'view' | PowerAction
export type MachineKind = 'qemu' | 'lxc'
export type MachineStatus = 'running' | 'stopped' | 'unknown' | 'unreachable'

export interface Viewer {
  email: string
  role: 'admin' | 'user'
}

export interface Machine {
  id: string
  kind: MachineKind
  vmid: number
  node: string
  name: string
  available: boolean
  status: MachineStatus
  cpu: number | null
  mem: number | null
  maxmem: number | null
  uptime: number | null
  permissions: Permission[]
  busy: boolean
}

export type OperationState = 'submitting' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'resolved'

export interface Operation {
  id: string
  machineId: string
  machineName: string
  vmid: number
  actorEmail: string
  action: PowerAction
  state: OperationState
  message: string | null
  createdAt: number
  updatedAt: number
}

export interface UserGrant {
  machineId: string
  permissions: Permission[]
}

export interface ManagedUser {
  id: string
  email: string
  enabled: boolean
  passkeyRegistered: boolean
  grants: UserGrant[]
}

export interface Enrollment {
  enrollmentToken: string
  enrollmentExpiresAt: number
}

export interface AuditEvent {
  id: number
  at: number
  actorEmail: string
  action: string
  target: string
  result: string
  ip: string | null
  userAgent: string | null
}

export interface ApiProblem {
  code: string
  message: string
}
