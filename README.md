# PVE Home

PVE Home 是部署在 Cloudflare Workers 上的远程管理台。它接入一个 Proxmox VE 单机或集群，为管理员和普通用户提供 QEMU、LXC 的开机、正常关机和强制关机。

管理员通过 Cloudflare Access 的 GitHub OAuth 登录。普通用户首次用一次性初始化 Token 绑定 Passkey，之后使用 Passkey 登录。Worker 从 D1 读取应用权限，并通过 Workers VPC Service 和 Cloudflare Tunnel 访问 PVE API。

普通用户可直达机器面板 `/` 和操作记录 `/operations`。管理员可直达机器面板 `/admin`、操作记录 `/admin/operations`、用户与权限 `/admin/users` 和审计日志 `/admin/audit`。

## 开发和测试

需要 Node.js 22.18+。项目锁定 Cloudflare CLI 和支持 `cloudflare.config.ts` 的 Cloudflare Vite 插件 beta 版本。

```sh
npm ci
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
```

测试使用本地 Workers 运行时、D1、签名 JWT 和模拟 PVE。浏览器测试覆盖授权、强制关机确认、任务完成和撤销权限，并检查手机布局。可以用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安装的 Chromium。

```sh
npm run db:migrate:local
npm run dev -- --host 127.0.0.1
```

本地开发沿用生产身份校验。管理员入口要求有效 Access JWT，普通用户的业务 API 要求已登录会话。要调试完整浏览器流程，可运行 `npm run test:browser -- --headed`。没有设置 VPC Service ID 时，开发服务器以离线模式启动。提供真实 VPC Service ID 会启用 Cloudflare 远程绑定，可能影响真实机器，联调时应使用独立的测试资源。

## 部署

### 1. 准备 PVE 和私网连接

1. 给 PVE API 使用与内网 DNS 主机名匹配的可信证书。可使用公开受信 CA 或 Cloudflare Origin CA。确保 Tunnel 的连接器能够解析该主机名，并访问 PVE 的 HTTPS 端口（默认 8006）。
2. 创建或复用 [Workers VPC 支持的 Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)。在内网运行 `cloudflared`，使用 QUIC，允许出站 UDP 7844。PVE API 无需公网入口。
3. 在同一个 Cloudflare 账号下创建 [VPC Service](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)，类型选择 HTTP，设置 Tunnel、内网主机名、HTTPS 端口和 `verify_full`。保存服务 ID。创建及绑定服务需要对应的 Connectivity Directory 权限。

也可以使用已登录的 `cf` CLI 创建 VPC Service。以下参数使用真实主机名和 Tunnel ID 替换：

```sh
npx cf workers-vpc services create --name pve-home-api --type http \
  --host-resolver-network-tunnel-id "$PVE_TUNNEL_ID" \
  --host-hostname "$PVE_INTERNAL_HOST" --https-port 8006 \
  --tls-settings-cert-verification-mode verify_full
```

在 PVE 创建专用账号、开启权限分离的 Token 和仅含 `VM.Audit VM.PowerMgmt` 的角色。分别给账号和 Token 授权到需要管理的 `/vms/<VMID>` 路径。Token 的权限取两者交集。下例授权测试机器 101，其他机器按需重复 ACL 步骤。参考 [PVE 用户权限管理](https://pve.proxmox.com/pve-docs/pveum.1.html) 和 [API Token](https://pve.proxmox.com/wiki/Proxmox_VE_API#API_Tokens)。

```sh
pveum user add pve-home@pve
pveum role add HomePower --privs 'VM.Audit VM.PowerMgmt'
pveum user token add pve-home@pve power --privsep 1
pveum acl modify /vms/101 --users pve-home@pve --roles HomePower
pveum acl modify /vms/101 --tokens 'pve-home@pve!power' --roles HomePower
```

### 2. 配置 GitHub 管理员和 Passkey 用户

1. 使用现有的 [GitHub 身份提供方](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/)，或在 Cloudflare Access 创建一个。
2. 创建一个 Self-hosted Access 应用，包含应用域名的 `/admin` 和 `/api/admin` 两个目标路径。仅选中 GitHub 身份提供方。关联 `Allow` 策略，Include 指定管理员邮箱，Require 指定 `Login Methods = GitHub`。普通用户入口 `/` 及 Passkey API 由 Worker 校验。
3. 将 Access 团队域名和应用 AUD tag 写入部署配置。将 `ADMIN_EMAIL` 设置为 GitHub 经 Access 提供的管理员邮箱。
4. 管理员添加用户后，将页面显示的一次性初始化 Token 私下交给对方。Token 有效期 24 小时。用户在首页选择「首次绑定 Passkey」完成绑定，之后用 Passkey 登录。重发初始化 Token 会撤销现有 Passkey 和会话。

### 3. 创建 D1，配置并发布 Worker

```sh
npx cf auth login
npx cf d1 create --name pve-home
npm run db:migrate -- "$D1_DATABASE_ID"
cp .env.deploy.example .env.deploy
```

将 `D1_DATABASE_ID` 设为创建数据库时返回的 ID，再执行迁移。在 `.env.deploy` 填写账号、数据库、VPC 服务、应用 origin、Access issuer/AUD、管理员邮箱和 PVE origin。origin 只包含协议、主机和可选端口。PVE origin 主机名必须匹配 VPC 服务和证书。

首次部署或 Token 轮换时，将完整 Token 写入本机私有 JSON 文件，并把路径填入 `PVE_SECRETS_FILE`。建议将文件保存在仓库外，权限设为 600。文件格式如下：

```json
{ "PVE_API_TOKEN": "pve-home@pve!power=替换成实际Token密钥" }
```

```sh
npm run deploy -- --dry-run
npm run deploy
```

部署脚本将 Token 上传为 Workers Secret，已有 Secret 的后续版本可省略秘密文件。Worker 绑定自定义域名，`workers.dev` 和版本预览 URL 均关闭。部署脚本使用已创建的 D1 和 VPC 资源。

### 4. 通过 Workers Builds 持续发布

在 Cloudflare Workers 的 **Settings → Builds** 将 `pve-home` 连接到 GitHub 仓库，生产分支选择 `main`，根目录选择 `/`。关闭预览构建。

| 设置 | 值 |
| --- | --- |
| Build command | `npm ci --include=dev && npm run typecheck && npm test` |
| Deploy command | `npm run deploy` |
| `NODE_VERSION` | `22.23.3` |
| `SKIP_DEPENDENCY_INSTALL` | `true` |

在 **Build variables and secrets** 填写 `.env.deploy.example` 中的非秘密配置。PVE Token 在 Worker 的 **Variables and Secrets** 中单独添加为运行时 Secret `PVE_API_TOKEN`。数据库迁移在发布前通过 `npm run db:migrate` 执行。

发布凭据由 Workers Builds 注入。启用正式连接前，确认构建所选 API Token 有权绑定 VPC Service，以及为应用所在 Zone 配置 Worker 自定义域名。

初始化 CI 时，只设置 Cloudflare 账号、D1 ID 和 `PVE_HOME_BOOTSTRAP=1`。这个模式发布 Worker 版本，且关闭自定义域名、`workers.dev`、预览 URL 和 Cron。准备好 GitHub Access 应用、VPC Service 和运行时 Secret 后，在 Builds 中移除 `PVE_HOME_BOOTSTRAP` 并补全配置。首次替换初始化版本的运行时变量时，用同一组配置在终端运行 `npm run deploy`，核对并确认变更。之后推送 `main` 会继续由 Workers Builds 发布。参考 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

### 5. 联调和日常操作

- 用管理员账号打开自定义域名，执行「检查连接」及「同步机器」，核对测试 VM 与 LXC。
- 添加测试用户并分别授予查看、开机、正常关机和强制关机权限。用该账号验证允许的操作和操作记录，然后撤销授权，确认后续请求失去权限。
- 正常关机由 PVE 等待 60 秒。强制关机需要单独权限和 VMID 确认。提交后以 PVE 任务结果为准。
- 操作记录优先显示未结束任务，总计最多 50 条。Cron 每分钟补查任务。遇到「结果未知」，管理员先在 PVE 核查，再在操作记录中填写核查结果并解除占用。
- PVE 机器被移除后，执行一次成功同步以清除该 VMID 的旧授权。回收 VMID 时，在复用前完成这一步。更换整个 PVE 环境时使用新的 D1 数据库。
- PVE 返回 401 时，检查 Secret 中的完整 Token ID 和最新密钥，以及用户和 Token 是否已过期。PVE 返回 403 时，使用 `pveum user token permissions pve-home@pve power` 核对有效权限。启用权限分离后，账号和 Token 均需授权。其他连接异常可检查 Tunnel、VPC TLS 配置和 Workers Logs。应用日志记录错误分类，D1 审计记录用户变更及电源操作。
- Worker 发布异常可在 Cloudflare 控制台回滚到上一个版本。D1 迁移独立执行，回滚 Worker 时保留审计数据。

## API 约定

API 与页面同源。修改请求使用 JSON（没有参数时发送 `{}`），且浏览器 `Origin` 必须匹配 `APP_ORIGIN`。

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/me` | 当前邮箱和角色 |
| `POST /api/auth/enroll/options`、`POST /api/auth/enroll/verify` | 使用初始化 Token 绑定 Passkey |
| `POST /api/auth/login/options`、`POST /api/auth/login/verify`、`POST /api/auth/logout` | Passkey 登录与退出 |
| `GET /api/machines`、`GET /api/machines/:id` | 查询可见机器及状态 |
| `POST /api/machines/:id/actions` | 提交电源操作 |
| `GET /api/operations`、`GET /api/operations/:id` | 查询可见操作记录 |
| `GET /api/admin/users`、`POST /api/admin/users` | 查看及添加普通用户 |
| `POST /api/admin/users/:id/enrollment` | 撤销旧 Passkey 和会话，重发初始化 Token |
| `PATCH /api/admin/users/:id`、`DELETE /api/admin/users/:id` | 启用、禁用或移除用户 |
| `PUT /api/admin/users/:id/grants` | 替换用户的逐机授权 |
| `POST /api/admin/machines/sync` | 同步机器清单 |
| `GET /api/admin/connection`、`GET /api/admin/audit` | 检查连接及查询审计 |
| `POST /api/admin/operations/:id/resolve` | 提交核查备注并解除未知任务占用 |

管理员从 `/api/admin` 前缀使用同样的机器、操作记录和身份接口。

提交电源操作时，发送 UUID 格式的 `Idempotency-Key` 和请求体 `{"action":"shutdown"}`。强制关机使用 `{"action":"force_stop","confirmVmid":101}`。接受请求后返回 `202`、`operationId` 和查询地址。发送同一个操作的重试应复用原幂等键。
