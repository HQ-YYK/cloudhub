# CloudHub 认证初始化

本阶段只支持预先创建的两个账号，不提供公开注册接口。密码仅以 PBKDF2-HMAC-SHA-256 哈希、独立随机盐和迭代次数保存，原始会话令牌只存在于 HttpOnly Cookie，D1 只保存其 SHA-256 哈希。

## 本地测试账号初始化

本地浏览器验收使用已有的 `test` 用户。使用专用脚本更新这条本地记录，
脚本不会把密码作为命令行参数、文件内容或日志输出，也不会创建新用户：

```bash
node scripts/init-local-test-user.mjs
```

脚本要求在交互式终端中运行，固定使用 `cloudhub-db --local`，执行前确认
`username = 'test'` 恰好匹配一条记录，并在执行后验证非敏感格式字段。
hash 和 salt 只在内存及一次性系统临时文件中短暂存在，脚本结束时会删除临时文件。
脚本拒绝更新其他用户名，也不接受远程数据库。

## 登录返回 401

登录接口返回 `401` 时，先确认使用的是包含 Pages Functions 和 D1 绑定的本地地址：

```text
http://127.0.0.1:8788/
```

`http://localhost:5173/` 只启动 Vite 前端，不提供认证接口，也没有 `DB` 绑定。
如果使用 Pages 本地运行时仍然返回 `401`，安全地检查测试账号是否存在且未禁用：

```bash
pnpm exec wrangler d1 execute cloudhub-db --local --command "SELECT id, username, disabled FROM users WHERE username = 'test' LIMIT 1;"
```

不要查询或输出 `password_hash`、`password_salt`、Cookie 或 Session Token。
如果账号存在且 `disabled = 0`，但密码仍无法验证，重新运行
`scripts/init-local-test-user.mjs`。该脚本会重新生成符合要求的 PBKDF2-HMAC-SHA-256
凭据（hash 长度 43、salt 长度 22），并只更新本地 `test` 用户。

## 本地 D1 流程

仓库已包含 [wrangler.jsonc](./wrangler.jsonc)，配置了本地 D1 数据库名称 `cloudhub-db`、绑定名 `DB` 和 `migrations` 迁移目录。Wrangler 已作为项目开发依赖安装。使用项目本地版本执行迁移：

```bash
pnpm exec wrangler d1 migrations apply cloudhub-db --local
```

这只操作本地 Wrangler 数据库，不代表生产 D1 已完成迁移。不要在没有确认目标环境时省略 `--local`。

不要直接执行 [scripts/auth-seed.example.sql](./scripts/auth-seed.example.sql)；
它是占位模板，不是可用的测试账号 seed 文件。

生产环境必须由你单独确认目标 Pages 项目和 D1 数据库后执行：

```bash
wrangler d1 migrations apply cloudhub-db --remote
wrangler d1 execute cloudhub-db --remote --file=cloudhub-auth-seed.local.sql
```

执行前应审查 SQL、确认 Cloudflare 登录账号和目标数据库，执行后删除本地明文 SQL 文件。此项目不会自动执行生产迁移。

## API

- `POST /api/auth/login`：要求同源 `Origin` 或 `Referer`，JSON body 为 `{ "username": "...", "password": "..." }`。成功返回 `{ "user": { "id", "username" } }` 并设置会话 Cookie；凭据错误返回 `401`，格式错误返回 `400`，数据库不可用返回 `503`。
- `GET /api/auth/me`：从 Cookie 重新验证会话，成功返回公开用户信息；未登录、过期或禁用账号返回 `401`。
- `POST /api/auth/logout`：要求同源 `Origin` 或 `Referer`，删除当前会话并清除 Cookie；跨站请求返回 `403`。其他方法返回 `405` 和 `Allow`。
- `POST /api/auth/logout-all`：要求同源 `Origin` 或 `Referer`，撤销当前用户的全部会话并清除当前 Cookie。

登录失败按用户名和客户端 IP 的 SHA-256 哈希在 D1 中限流。IP 仅作为辅助维度，不能作为身份认证依据。
