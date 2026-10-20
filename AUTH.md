# CloudHub 认证初始化

本阶段只支持预先创建的两个账号，不提供公开注册接口。密码仅以 PBKDF2-HMAC-SHA-256 哈希、独立随机盐和迭代次数保存，原始会话令牌只存在于 HttpOnly Cookie，D1 只保存其 SHA-256 哈希。

## 本地生成账号凭据

在交互式终端中分别执行两次以下命令。脚本不会把密码作为命令行参数，也不会回显输入的密码：

```bash
node scripts/generate-password-hash.mjs
```

脚本输出的 `username`、`password_hash`、`password_salt` 和 `password_iterations` 只应写入本地未跟踪文件或人工填入 SQL，不要提交到 Git，不要放入 `VITE_*` 变量。

将输出值替换到 [scripts/auth-seed.example.sql](./scripts/auth-seed.example.sql) 的两个占位账号中，并自行设置不含真实密码的 UUID 和 UTC 时间。建议先复制到仓库外的临时文件：

```text
cloudhub-auth-seed.local.sql
```

确认该文件未被 Git 跟踪后再使用。不要把真实凭据粘贴到聊天、日志或提交信息中。

## 本地 D1 流程

当前仓库没有 Wrangler 配置，也没有绑定数据库 ID，因此不会自动执行迁移。安装并登录 Wrangler 后，先创建本地 D1 数据库（或使用 Cloudflare 官方文档配置本地绑定），再执行：

```bash
wrangler d1 migrations apply cloudhub-db --local
wrangler d1 execute cloudhub-db --local --file=cloudhub-auth-seed.local.sql
```

具体数据库名称和绑定配置以你的 Wrangler/Pages 项目为准。不要在没有确认目标环境时省略 `--local`。

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
