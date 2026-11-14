# 私有云盘目录元数据

当前阶段实现 D1 中的文件/目录元数据、后端文件上传和下载 API，以及使用依赖注入 BlobStore
的文件 service。删除、移动、重命名或分享仍未实现。生产上传使用服务端
Azure BlobStore 配置，本地测试使用 MockBlobStore。

## 数据模型

`migrations/0002_files.sql` 创建统一的 `files` 表，`migrations/0003_blob_file_state.sql`
为文件内容增加存储状态：

- `id`、`owner_id`、`parent_id`：服务端生成的资源 ID、所有者和父目录；
- `kind`：只能是 `file` 或 `directory`；
- `name`、`name_key`：服务端规范化后的显示名称和大小写折叠键；
- `object_key`、`size_bytes`、`mime_type`：为后续对象存储预留，目录必须为空；
- `created_at`、`updated_at`、`deleted_at`：生命周期时间。
- `storage_status`：文件内容状态；目录固定为 `ready`。

根目录使用 `parent_id IS NULL`，不创建虚拟根目录。活动项目由所有者、父目录和 `name_key` 的部分唯一索引防止同名；软删除后可以重新使用名称。父目录的所有者由复合外键辅助约束，业务层仍会检查它是未删除的目录。

文件状态使用以下语义：

```text
pending  -> 文件元数据已创建，内容尚未确认可用
ready    -> 文件内容已成功保存，可以授权下载
failed   -> 保存失败，等待清理或重试
deleting -> 正在删除文件内容
```

允许的状态转换由服务层集中校验：`pending` 可到 `ready`、`failed` 或
`deleting`；`failed` 可重新开始 `pending` 或进入 `deleting`；`ready` 只能进入
`deleting`；删除失败可从 `deleting` 回到 `failed`。数据库更新同时要求当前
`owner_id`、`kind = 'file'` 和期望的旧状态，避免跨用户更新和并发覆盖。

目录也有 `storage_status` 列以保持统一行结构，但目录创建时固定为 `ready`。
repository 保留内部 `listChildren()` 全状态查询，供后续清理、恢复和诊断使用；
普通用户列表使用独立的 `listVisibleChildren()` 查询，只返回目录和 `ready` 文件，
不会把 `pending`、`failed` 或 `deleting` 当作可下载文件。这个 SQL 过滤不依赖
公共序列化函数。

失败文件不占用同目录的活动同名约束，因此清理失败记录前也可以创建同名重试文件；
`pending`、`ready`、`deleting` 文件以及目录仍然阻止同名活动项目。

目录名称会先进行 NFC 规范化和前后空格去除，拒绝空名称、超过 255 个 JavaScript 字符的名称、控制字符以及路径分隔符。名称比较大小写不敏感。

## API

- `GET /api/files`：列出当前用户根目录的直接子项；
- `GET /api/files?parent_id=<directory-id>`：列出指定目录的直接子项；
- `GET /api/files/:id/download`：下载当前用户拥有的 ready 文件；
- `DELETE /api/files/:id`：删除当前用户拥有的文件；
- `POST /api/files/directories`：创建目录，JSON body 为 `{ "parent_id": string | null, "name": string }`。
- `POST /api/files/upload`：上传一个文件，使用 `multipart/form-data` body。

所有接口都要求现有会话认证，资源查询使用服务端认证得到的用户 ID。不存在、已删除、非目录或其他用户的父目录统一返回不可见资源错误。响应只包含必要元数据，不返回 `object_key`，并使用统一的 `Cache-Control: no-store` 和安全响应头。

目录创建是使用 Cookie 会话的状态变更接口，会先复用现有 `sameOriginRequest()` 校验 `Origin` 或 `Referer`，再解析请求体或访问数据库。来源缺失、来源错误或 Referer 无法解析时返回 403。请求体必须是非数组 JSON 对象；无效 JSON、`null`、数组、字符串、数字和错误类型的 `parent_id` 返回 400。

上传接口同样要求 Cookie 会话和同源请求。multipart body 只允许以下字段：

- `file`：必填且只能出现一次，文件名来自 multipart 的 `filename`；
- `parent_id`：可选且最多出现一次，缺省表示根目录。

其他字段（包括 `owner_id`、`object_key`、`file_id` 和 `storage_status`）都会被拒绝。
multipart 请求体上限为 10 MiB + 64 KiB，单个文件上限为 10 MiB，单个 part header
上限为 8 KiB，最多允许两个 part。请求体会通过 Web Streams 逐块计数；超过上限时
立即取消底层读取。存在 `Content-Length` 时会校验其格式、上限和实际读取长度。
文件名、MIME 类型和父目录权限继续由上传 service 校验。

成功响应为 HTTP 201：

```json
{
  "item": {
    "id": "file-id",
    "parent_id": null,
    "kind": "file",
    "name": "example.txt",
    "size_bytes": 7,
    "mime_type": "text/plain",
    "created_at": "2030-01-01T00:00:00.000Z",
    "updated_at": "2030-01-01T00:00:00.000Z"
  }
}
```

响应不会包含 `owner_id`、`object_key`、`storage_status`、Azure URL 或任何凭据。常见
错误为：401 `unauthorized`、403 `forbidden`、400 `invalid_request`/文件校验错误、
404 `not_found`、409 `conflict`、413 `too_large` 和 503 `service_unavailable`。

下载接口只接受 GET，并通过 Cookie Session 认证。文件 ID 会先验证格式，再使用已认证
用户 ID 和文件 ID 查询；目录、其他用户文件、软删除文件以及 `pending`、`failed`、
`deleting` 状态的文件统一返回 404。只有 `ready` 文件才会调用 BlobStore，并直接以
流式响应返回对象内容，不把整个文件读入 API 内存。响应使用 `Content-Disposition:
attachment`，同时提供安全 ASCII `filename` fallback 和 UTF-8 `filename*`，并设置
可信的 `Content-Length`、文件 MIME 类型、`X-Content-Type-Options: nosniff` 及
`Cache-Control: private, no-store`。BlobStore 缺失对象、鉴权失败或其他存储异常统一
返回 503，不向客户端暴露 object key、Azure endpoint、响应正文或凭据。

删除接口只接受 DELETE，并要求同源 Cookie Session。文件 ID 和当前用户归属在服务端
验证；目录、其他用户文件、已软删除文件或不存在的文件统一返回 404。删除不会物理
删除 D1 记录，也不接受客户端提供的 `owner_id` 或 `object_key`。服务端先以原子条件
转换 `pending`、`ready` 或 `failed` 到 `deleting`，再使用记录中的 object key 删除
Blob，最后以 `deleting` 条件执行 D1 软删除并设置 `deleted_at`。成功响应为
`{ "deleted": true }`。

Blob 不存在按既有幂等语义继续软删除；其他 Blob 删除失败会尽力将状态恢复为
`failed`，不会软删除元数据。如果 Blob 已删除但 D1 软删除失败，记录会保留在
`deleting`，不会错误恢复为 `ready`，并返回 503，供后续清理或核查。并发请求只有一
个能取得有效的 `deleting` 状态转换；重复请求返回 404 或冲突响应。当前不支持目录
删除、回收站恢复或永久删除。

生产 Azure 上传需要以下服务端环境变量；`AZURE_CLIENT_SECRET` 只能配置为 Pages
Secret，不得写入 `wrangler.jsonc`、`VITE_*` 或前端代码：

- `AZURE_TENANT_ID`：Microsoft Entra tenant；
- `AZURE_CLIENT_ID`：Entra 应用 client ID；
- `AZURE_CLIENT_SECRET`：Entra 应用 secret；
- `AZURE_STORAGE_ACCOUNT`：Storage Account 名称；
- `AZURE_STORAGE_CONTAINER`：目标 Blob 容器；
- `AZURE_STORAGE_BLOB_ENDPOINT`：可选的 HTTPS Blob endpoint，缺省使用官方 endpoint。

本地 Functions 测试通过依赖注入使用 MockBlobStore 和内存 repository，不访问真实
Azure 或远程 D1。当前测试和构建通过不代表已经完成真实 Azure 连通性验证。

### 前端文件管理

CloudDrive 页面复用以上后端接口提供基本文件操作：

- 选择单个文件上传到当前目录；前端提示 10 MiB 限制，但实际限制仍由后端执行；
- 文件卡片显示名称、大小、MIME 类型和更新时间；
- 通过后端下载接口获取当前用户自己的文件，不暴露 Azure URL 或 object key；
- 删除文件前要求确认，删除成功后刷新当前目录，目录不能删除；
- 上传、下载和删除期间分别显示进行中状态，失败时保留列表并显示错误。

前端 API 使用同源 Cookie Session。上传使用浏览器生成 boundary 的 `FormData`，不
手动设置 multipart `Content-Type`；下载使用响应中的 `Content-Disposition` 文件名。
本地可运行 `pnpm run test:frontend` 验证 FormData 字段、下载 URL、同源凭据和删除
HTTP 方法；`pnpm test:functions` 验证 Pages Functions 后端。前端测试和本地构建均
不连接真实 Azure 或远程 D1。

活动同名冲突只在 D1 明确报告 `idx_files_active_name` 唯一索引错误时转换为 409。外键、CHECK、主键、其他唯一约束和未知数据库错误不会伪装成名称冲突，而由 API 返回通用服务错误。

本地 D1 集成测试每次运行生成随机用户和资源 ID，只清理本次运行的数据，并使用哨兵用户验证清理不会删除既有数据。测试仍使用共享的本地 Wrangler 状态并对 SQLite 锁冲突进行有限重试；这不代表已经验证生产 D1 的错误包装或并发行为。

### 当前未实现

HEAD、公开链接、分享、断点续传、目录删除、回收站恢复、永久删除、重命名、移动、
文件内容 MIME 魔数检测和 E2EE 均不属于本阶段；下载仅支持已登录用户通过后端流式
获取自己的 ready 文件。
2C-1 的上传 service 限制文件 body 为 10 MiB，先有界读取并校验 `Content-Length`
与实际大小，再创建 `pending` 元数据，写入对象并原子转换为 `ready`；
失败时转换为 `failed` 并尽可能清理对象。生产 D1 迁移仍需人工确认；本阶段测试只
使用本地 Wrangler D1 或内存测试替身。

`deleting` 表示删除流程已开始，不表示 Blob 已经删除。删除成功后应通过
`deleted_at` 软删除记录；如果删除明确失败且对象仍可确认存在，后续实现应恢复
为 `ready`，只有在对象状态未知时才使用 `failed` 等待清理或核查；`failed` 不
证明对象一定不存在。软删除后的记录不能再次进行状态转换。当前状态机不表示
已经执行真实 Blob 操作。

上传 service 只有在确认 `pending -> failed` 成功后才删除可能已写入的对象；如果
状态更新本身发生竞争或结果未知，则不会冒险删除，避免留下 `ready` 但对象缺失的
记录，后续应交由清理或核查流程处理。
