export const pageRoutes = [
  { path: '/', page: 'machines', role: 'user' },
  { path: '/operations', page: 'operations', role: 'user' },
  { path: '/admin', page: 'machines', role: 'admin' },
  { path: '/admin/operations', page: 'operations', role: 'admin' },
  { path: '/admin/users', page: 'users', role: 'admin' },
  { path: '/admin/audit', page: 'audit', role: 'admin' },
] as const

export function matchPage(pathname: string) {
  const path = pathname.replace(/\/$/, '') || '/'
  return pageRoutes.find((route) => route.path === path)
}
