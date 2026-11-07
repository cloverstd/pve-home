import { bindings, defineConfig, triggers } from 'cf/config'

const appOrigin = process.env.APP_ORIGIN
const vpcServiceId = process.env.PVE_VPC_SERVICE_ID
const databaseId = process.env.PVE_HOME_D1_ID ?? '00000000-0000-4000-8000-000000000001'

export default defineConfig(({ mode }) => {
  const bootstrap = mode === 'bootstrap'
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    worker: {
      name: process.env.PVE_HOME_WORKER ?? 'pve-home',
      entrypoint: './src/worker/index.ts',
      compatibilityDate: '2026-11-07',
      workersDev: false,
      previewUrls: false,
      domains: !bootstrap && appOrigin?.startsWith('https://') ? [new URL(appOrigin).hostname] : [],
      assets: { runWorkerFirst: true },
      observability: { enabled: true, traces: { enabled: true } },
      triggers: bootstrap ? [] : [triggers.scheduled({ schedule: '* * * * *' })],
      env: {
        ASSETS: bindings.assets(),
        DB: bindings.d1({ id: databaseId }),
        // Workers VPC requires a real remote binding. Keep unconfigured local dev offline.
        ...(!bootstrap && (vpcServiceId || mode !== 'development') ? {
          PVE: bindings.vpcService({ id: vpcServiceId ?? '00000000-0000-4000-8000-000000000002' }),
        } : {}),
        PVE_ORIGIN: bindings.text(process.env.PVE_ORIGIN ?? ''),
        ...(!bootstrap ? { PVE_API_TOKEN: bindings.secret() } : {}),
        APP_ORIGIN: bindings.text(appOrigin ?? ''),
        ACCESS_ISSUER: bindings.text(process.env.ACCESS_ISSUER ?? ''),
        ACCESS_AUD: bindings.text(process.env.ACCESS_AUD ?? ''),
        ADMIN_EMAIL: bindings.text(process.env.ADMIN_EMAIL ?? ''),
      },
    },
  }
})
