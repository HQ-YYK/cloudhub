# 私有云盘目录元数据

当前阶段只实现 D1 中的文件/目录元数据，不接入 Azure Blob，也不实现文件内容上传、下载、删除、移动、重命名或分享。

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
- `POST /api/files/directories`：创建目录，JSON body 为 `{ "parent_id": string | null, "name": string }`。

所有接口都要求现有会话认证，资源查询使用服务端认证得到的用户 ID。不存在、已删除、非目录或其他用户的父目录统一返回不可见资源错误。响应只包含必要元数据，不返回 `object_key`，并使用统一的 `Cache-Control: no-store` 和安全响应头。

目录创建是使用 Cookie 会话的状态变更接口，会先复用现有 `sameOriginRequest()` 校验 `Origin` 或 `Referer`，再解析请求体或访问数据库。来源缺失、来源错误或 Referer 无法解析时返回 403。请求体必须是非数组 JSON 对象；无效 JSON、`null`、数组、字符串、数字和错误类型的 `parent_id` 返回 400。

活动同名冲突只在 D1 明确报告 `idx_files_active_name` 唯一索引错误时转换为 409。外键、CHECK、主键、其他唯一约束和未知数据库错误不会伪装成名称冲突，而由 API 返回通用服务错误。

本地 D1 集成测试每次运行生成随机用户和资源 ID，只清理本次运行的数据，并使用哨兵用户验证清理不会删除既有数据。测试仍使用共享的本地 Wrangler 状态并对 SQLite 锁冲突进行有限重试；这不代表已经验证生产 D1 的错误包装或并发行为。

### 当前未实现

上传、下载、删除、重命名、移动、分享、Azure Blob、对象键生成、文件内容 MIME 检测和 E2EE 均不属于本阶段。生产 D1 迁移仍需人工确认；本阶段测试只使用本地 Wrangler D1。

`deleting` 表示删除流程已开始，不表示 Blob 已经删除。删除成功后应通过
`deleted_at` 软删除记录；如果删除明确失败且对象仍可确认存在，后续实现应恢复
为 `ready`，只有在对象状态未知时才使用 `failed` 等待清理或核查；`failed` 不
证明对象一定不存在。软删除后的记录不能再次进行状态转换。当前状态机不表示
已经执行真实 Blob 操作。
