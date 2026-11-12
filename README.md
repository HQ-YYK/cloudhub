# CloudHub

CloudHub 是一个基于 React、TypeScript、Cloudflare Pages Functions 和 D1
的个人云端工作台。目前已包含登录工作台和私有云盘目录浏览/新建文件夹原型。

## 技术栈

- React 19 + TypeScript
- Vite
- Cloudflare Pages Functions
- Cloudflare D1
- pnpm

## 本地开发地址

项目有两种本地运行方式，适用范围不同：

### Vite 前端开发

```powershell
pnpm dev
```

访问：

```text
http://localhost:5173/
```

该服务只提供 Vite 前端和热更新，不加载 `functions/`，也没有 D1 `DB`
绑定。因此 `/api/auth/*` 和 `/api/files` 在此地址下不能作为完整后端接口验收。

### Pages Functions + 本地 D1 验收

先生成最新前端构建产物：

```powershell
pnpm run build
```

再启动 Cloudflare Pages 本地运行时：

```powershell
pnpm exec wrangler pages dev dist --local --port 8788
```

访问：

```text
http://127.0.0.1:8788/
```

该服务加载 `dist/`、Pages Functions 和 `wrangler.jsonc` 中的本地
`cloudhub-db`，适合验收登录、会话和私有云盘 API。

如果 8788 端口曾运行过旧的 Wrangler/Workerd 进程并且请求无响应，先停止旧的
本地 Pages 服务，再重新启动；不要把卡住的服务误判为 API 的 404 或 401。

## 后端文件上传约束

文件上传服务保留 10 MiB 的实际读取上限。请求如果提供 `Content-Length`，
必须是非负安全整数，且必须与完整读取到的 body 字节数严格一致；缺少该请求头
时则按实际读取的字节数校验。长度不合法、超限或不一致时，会在创建 pending
文件元数据和写入 Blob 之前失败。

Blob 写入成功后，服务才会将文件状态从 `pending` 转为 `ready`。写入失败或
状态转换失败时，只有在确认 `pending` 已转换为 `failed` 后才会清理可能已经
写入的 Blob；状态转换不确定时不会删除对象。

## 本地 D1 和测试账号

迁移只使用本地 D1：

```powershell
pnpm exec wrangler d1 migrations apply cloudhub-db --local
```

认证只支持预先初始化的账号，不提供公开注册。账号初始化流程和密码哈希要求
请阅读 [AUTH.md](./AUTH.md)。密码必须通过专用的本地初始化脚本交互式输入，不要放入命令参数、日志、
前端变量或 Git：

```powershell
node scripts/init-local-test-user.mjs
```

脚本只更新本地已存在的 `test` 用户，使用内存生成 PBKDF2 hash/salt，并通过
一次性临时 SQL 文件调用 `cloudhub-db --local`。脚本会自动清理临时文件，
不会输出密码、hash、salt、Cookie 或 Token。

## 登录返回 401 的排查

先确认访问的是完整 Pages 本地地址，而不是 Vite 地址：

```text
http://127.0.0.1:8788/
```

确认本地 D1 迁移和账号存在：

```powershell
pnpm exec wrangler d1 migrations list cloudhub-db --local
pnpm exec wrangler d1 execute cloudhub-db --local --command "SELECT id, username, disabled FROM users WHERE username = 'test' LIMIT 1;"
```

查询时不要输出 `password_hash`、`password_salt`、Cookie 或 Token。

如果 `test` 用户存在、未禁用但仍返回 401，重新运行
`scripts/init-local-test-user.mjs`。不要直接执行
`scripts/auth-seed.example.sql`；其中的 `replace-with-*` 值只是占位模板，不能用于登录。

不要通过关闭认证、修改 Cookie、安全校验或限流来排查登录问题。

## 常用检查

```powershell
pnpm run build
pnpm run lint
pnpm exec tsc -p tsconfig.functions.json
pnpm run test:functions
git diff --check
```

## 相关文档

- [认证初始化与 API](./AUTH.md)
- [工程安全笔记](./docs/README.md)
- [当前架构](./docs/01-current-architecture.md)
- [私有云盘目录元数据](./docs/08-private-drive-metadata.md)
- [私有云盘前端第一阶段](./docs/09-private-drive-frontend.md)

## 安全边界

- 不访问远程 D1、Azure 或生产资源进行本地验收。
- 不提交密码、密码哈希、salt、Session Token、Cookie 或 Azure 凭据。
- 当前未实现文件上传、下载、删除、分享、Azure Blob 和 E2EE。
- 生产迁移和部署必须单独确认目标环境后执行。
