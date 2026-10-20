# 私有云盘目录元数据

当前阶段只实现 D1 中的文件/目录元数据，不接入 Azure Blob，也不实现文件内容上传、下载、删除、移动、重命名或分享。

## 数据模型

`migrations/0002_files.sql` 创建统一的 `files` 表：

- `id`、`owner_id`、`parent_id`：服务端生成的资源 ID、所有者和父目录；
- `kind`：只能是 `file` 或 `directory`；
- `name`、`name_key`：服务端规范化后的显示名称和大小写折叠键；
- `object_key`、`size_bytes`、`mime_type`：为后续对象存储预留，目录必须为空；
- `created_at`、`updated_at`、`deleted_at`：生命周期时间。

根目录使用 `parent_id IS NULL`，不创建虚拟根目录。活动项目由所有者、父目录和 `name_key` 的部分唯一索引防止同名；软删除后可以重新使用名称。父目录的所有者由复合外键辅助约束，业务层仍会检查它是未删除的目录。

目录名称会先进行 NFC 规范化和前后空格去除，拒绝空名称、超过 255 个 JavaScript 字符的名称、控制字符以及路径分隔符。名称比较大小写不敏感。

## API

- `GET /api/files`：列出当前用户根目录的直接子项；
- `GET /api/files?parent_id=<directory-id>`：列出指定目录的直接子项；
- `POST /api/files/directories`：创建目录，JSON body 为 `{ "parent_id": string | null, "name": string }`。

所有接口都要求现有会话认证，资源查询使用服务端认证得到的用户 ID。不存在、已删除、非目录或其他用户的父目录统一返回不可见资源错误。响应只包含必要元数据，不返回 `object_key`，并使用统一的 `Cache-Control: no-store` 和安全响应头。

### 当前未实现

上传、下载、删除、重命名、移动、分享、Azure Blob、对象键生成、文件内容 MIME 检测和 E2EE 均不属于本阶段。生产 D1 迁移仍需人工确认；本阶段测试只使用本地 Wrangler D1。
