# Blob 存储抽象、Mock 与 Azure REST 实现

本阶段定义应用服务端与对象存储之间的最小边界，并提供不连接真实 Azure 的
Mock 测试实现，以及使用 Entra ID OAuth 的 Azure Blob REST 适配器。

## 抽象接口

[BlobStore](../functions/_lib/blob-store.ts) 提供四个操作：

- `put`：写入对象。默认拒绝覆盖，调用方必须显式设置 `overwrite: true`；
- `get`：读取对象内容和元数据；
- `head`：只读取对象大小、类型、元数据和 ETag；
- `delete`：删除对象。

对象键由服务端生成。浏览器、文件名和客户端提交的路径不能直接成为对象键。

统一错误类型为 `BlobStoreError`，当前错误码为：

- `not_found`
- `conflict`
- `invalid_request`
- `too_large`
- `unavailable`

## Mock

[MockBlobStore](../functions/_lib/mock-blob-store.ts) 只使用内存和 Web 标准 API，适合 Functions 单元测试。它支持：

- `Uint8Array`、`ArrayBuffer` 和 `ReadableStream<Uint8Array>` 请求体；
- 可配置的对象大小上限；
- 对象元数据和 Content-Type；
- 重复写入冲突和显式覆盖；
- 对象不存在、删除后读取和元数据边界测试。

它不模拟 Azure 的网络、认证、重试、版本控制或最终一致性，不能替代真实 Azure 验收。

## Workers 兼容性结论

本阶段不引入 Node 专用 Azure SDK。抽象和 Mock 仅依赖：

- `Uint8Array`
- `ArrayBuffer`
- `ReadableStream`
- `TextEncoder`

这些 API 与 Cloudflare Workers/Pages Functions 的 Web API 运行时边界一致。后续 Azure 适配器应先单独验证 SDK 是否依赖 Node `http`、文件系统、`Buffer` 或其他 Workers 不保证的 Node API，不能默认 `@azure/storage-blob` 可直接运行。

## Azure REST Entra OAuth 适配器

[AzureBlobStore](../functions/_lib/azure-blob-store.ts) 使用原生 `fetch` 调用
Azure Blob REST API，[azure-blob-auth.ts](../functions/_lib/azure-blob-auth.ts)
通过 Entra OAuth 2.0 client credentials 获取并缓存
`https://storage.azure.com/.default` access token。适配器不使用 Storage Account
主密钥，不依赖 Node `crypto` 或 Node 专用 Azure SDK，也不支持认证失败后的静默降级。

REST 映射如下：

- `put` 使用 Block Blob、Content-Length、Content-Type、metadata 和
  `If-None-Match: *`；
- `get` 保留 Azure response body 流，不主动读取完整对象；
- `head` 只读取 Blob Properties；
- `delete` 将 404 映射为 `BlobStoreError('not_found')`。

适配器默认限制对象为 10 MiB；`Uint8Array` 和 `ArrayBuffer` 会带长度发送，
未知长度的 `ReadableStream` 明确拒绝，避免无限缓冲。请求禁止跟随重定向，
防止 Authorization header 被转发到非预期域名。

认证配置只能由服务端读取，不能使用 `VITE_` 变量，也不能进入日志、错误响应
或 Git。当前适配器和测试只使用 mock fetch，不代表已经连接或验收真实 Azure。

生产接入时需要由 Pages Functions 服务端 Secret/变量提供：

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_STORAGE_ACCOUNT`
- `AZURE_STORAGE_CONTAINER`
- 可选的 `AZURE_STORAGE_BLOB_ENDPOINT`

当前 `wrangler.jsonc` 和公开 API 尚未接入这些配置；本适配器不能单独代表生产
Azure 已连通。接入时还必须在 Azure RBAC 中为 Entra 应用授予目标容器所需的
Blob 数据权限，并通过部署平台的 Secret 管理注入 client secret。

## 未采用 Shared Key

本项目不将 Shared Key 作为默认认证方式。若未来确有需要单独实现，必须依据
Azure 官方规范验证：

1. `StringToSign` 的方法、Content-* 头、日期、条件头和 canonicalized headers；
2. canonicalized resource 对账户名、容器名、对象键和查询参数的编码；
3. `Authorization: SharedKey <account>:<signature>` 的 HMAC-SHA256 和 Base64；
4. `x-ms-version`、`x-ms-date`、ETag、Content-Length 和响应头映射；
5. UTF-8 文件名、空值头、重复头、对象键特殊字符和 Unicode；
6. 失败响应、超时、重试、Blob 不存在和条件请求；
7. 使用 Azure 官方示例签名结果与真实测试容器进行非生产验证。

需要覆盖的测试场景：

- 固定请求输入得到官方预期签名；
- PUT、GET、HEAD、DELETE 四种方法；
- 空文件和边界大小；
- Metadata key/value 编码；
- ETag 条件覆盖；
- 403、404、409、请求超时；
- Secret 不进入日志、响应或测试输出。
