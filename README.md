# CloudHub

给少数几个人用的私有云盘。前端和 API 跑在 Cloudflare Pages 免费计划上，元数据存在 Cloudflare D1，文件内容存在管理员自己的 Google Drive 里。

浏览器只和 Cloudflare 通信，由 Pages Functions 去连 Google Drive，所以在访问不了 Google 的网络里也能用（前提是你的自定义域名能访问）。

## 功能

- **账号**：没有公开注册，账号由管理员创建。新账号和被重置密码的账号，首次登录必须先改密码
- **两步验证**：支持 TOTP（RFC 6238），兼容常见的验证器 App，附带 10 个一次性恢复码。管理员可以给普通用户重置两步验证
- **管理员**：可以创建、停用账号和重置密码，负责绑定存储。看不到别人的文件，也看不到任何人的密码，库里只存 PBKDF2 哈希
- **多账号存储**：管理员可以在工作台的「存储」页添加多个 Google 账号，把空间串起来。每个文件只存在一个账号上，上传时自动选剩余空间最大的账号；账号可以设为只读、重新授权或移除
- **上传**：大文件按 32 MiB 分片，经 Functions 中转给 Google Drive 的断点续传会话。断线后从已收到的字节继续传，传完校验大小并记录 Google 返回的 MD5。最多同时上传 3 个文件，支持拖拽
- **下载**：支持 HTTP Range，浏览器自带的断点续传和多线程下载都能用
- **文件管理**：目录、重命名、移动。目录树只存在 D1 里，重命名和移动不会动 Drive 上的文件
- **回收站**：删除的文件保留 30 天，可以恢复、彻底删除或清空
- **分享链接**：随机 token，库里只存哈希，可以设过期时间、随时撤销，有下载计数。公开页面是 `/s/:token`

计划中：Passkey 登录、Cloudflare 免费额度的用量限制和提示。

## 架构

```
浏览器 ──> Cloudflare Pages（React 静态页面 + Functions /api/*）──> Google Drive API
                         │
                         └──> D1：用户、会话、两步验证、目录树、上传会话、回收站、分享
```

| 部分 | 技术 |
| --- | --- |
| 前端 | React 19 + Vite（`src/`） |
| API | Cloudflare Pages Functions（`functions/api/`） |
| 元数据 | Cloudflare D1（`migrations/`） |
| 文件内容 | Google Drive，OAuth 只申请 `drive.file` 权限 |

安全上的几个设计：

- 会话放在 HttpOnly Cookie 里，写操作校验同源 `Origin`/`Referer`
- Google 的 refresh token 和 TOTP 密钥用 AES-GCM 加密后存进 D1，加密密钥放在 Pages 的 secret 里
- 登录失败次数有上限，TOTP 有防重放，恢复码只能用一次，用条件 UPDATE 防止并发重复消费
- `drive.file` 只能访问 CloudHub 自己创建的文件，属于非敏感权限，OAuth 应用可以直接发布，不用经过 Google 审核，也不会遇到测试模式下 refresh token 7 天过期的问题

## 本地开发

需要 Node.js 22.6+（测试用到 `--experimental-strip-types`）和 pnpm。

```bash
pnpm install
pnpm exec wrangler d1 migrations apply cloudhub-db --local
node scripts/init-local-test-user.mjs
pnpm build
pnpm exec wrangler pages dev dist
```

打开 `http://127.0.0.1:8788/`。单独运行 `pnpm dev` 只会启动 Vite 前端，没有 API 和数据库。

本地 secret 写在 `.dev.vars` 里，这个文件已被 git 忽略：

```ini
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
STORAGE_ENCRYPTION_KEY=...   # 32 字节随机数，base64url 编码
```

注意：本地的 workerd 可能连不上 Google，存储相关功能建议在线上验证。

## 部署

1. 在 Cloudflare 创建 D1 数据库 `cloudhub-db`，创建 Pages 项目并绑定为 `DB`
2. 应用迁移：`pnpm exec wrangler d1 migrations apply cloudhub-db --remote`。**先迁移，再部署代码**
3. 在 Pages 项目里设置 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`STORAGE_ENCRYPTION_KEY` 这三个 secret
4. 在 Google Cloud 创建 OAuth 客户端，回调地址填 `https://<你的域名>/api/storage/callback`，然后把应用发布为正式版
5. 创建第一个管理员：用 `scripts/generate-password-hash.mjs` 在本地生成哈希，参照 `scripts/auth-seed.example.sql` 写入数据库，并把 `role` 设为 `admin`
6. 用管理员登录后，在工作台的「存储」页添加 Google 账号，按提示授权

Workers 生产环境限制 PBKDF2 最多 100,000 次迭代，本项目就用这个值。

## 测试

```bash
pnpm test:functions
pnpm test:frontend
pnpm lint
pnpm exec tsc -p tsconfig.functions.json --noEmit
```

`pnpm build` 只检查前端类型，Functions 的类型要用最后一条命令单独检查。

## 致谢

下面这些项目在设计上给了启发。CloudHub 只参考了思路，没有复制它们的代码。

- [mizorewww/gdirect](https://github.com/mizorewww/gdirect)（GPL-2.0）：用自己的 OAuth 客户端接自己的 Google 账号；发布 OAuth 应用来避开 refresh token 7 天过期；断点续传上传和 Range 下载
- [longern/FlareDrive](https://github.com/longern/FlareDrive)（MIT）及其分支 [sagan/FlareDrive](https://github.com/sagan/FlareDrive)：在 Cloudflare 上做网盘的整体思路，以及上传客户端的并发和失败重试
- [cloudflare/workerd#1346](https://github.com/cloudflare/workerd/issues/1346)：确认了 Workers 上 PBKDF2 迭代次数的上限

## 许可

[MIT](LICENSE)
