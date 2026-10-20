# 私有云盘前端第一阶段

本阶段在已完成的目录元数据 API 之上，接入登录后工作台的目录浏览和新建文件夹功能。前端仍只通过同源 API 工作，不访问 D1、Azure 或其他存储服务。

## 前端边界

- [src/api/files.ts](../src/api/files.ts) 集中封装文件 API 请求；
- [src/components/CloudDrive.tsx](../src/components/CloudDrive.tsx) 负责目录页面状态和交互；
- [src/components/Workspace.tsx](../src/components/Workspace.tsx) 只负责工作台模块切换；
- [src/App.css](../src/App.css) 提供与现有工作台一致的目录页面样式。

所有请求使用 `credentials: 'same-origin'`，依赖服务端 HttpOnly Cookie 会话。前端不保存 Session Token，也不接触 `object_key`。

## 已实现交互

### 目录浏览

页面进入云盘模块后调用：

```text
GET /api/files
```

进入目录后调用：

```text
GET /api/files?parent_id=<directory-id>
```

页面只展示服务端返回的 `directory` 项。目录卡片可以进入子目录，面包屑可以返回当前路径中的任意上级目录。每次目录切换都会重新加载直接子项，不递归加载后代。

### 新建文件夹

调用：

```text
POST /api/files/directories
```

请求体：

```json
{
  "parent_id": null,
  "name": "Documents"
}
```

前端会阻止空名称和仅包含空格的名称提交；服务端名称规范化、权限校验、同名约束和 CSRF 校验仍是最终安全边界。创建成功后会重新加载当前目录。

## 状态与错误

页面提供以下状态：

- 目录加载中；
- 空目录；
- 目录加载失败和重试；
- 文件夹创建中；
- 空名称提示；
- 同名冲突；
- 登录失效；
- 来源校验失败；
- 网络错误和通用服务错误。

后端返回的内部错误、SQL 细节和对象存储信息不会展示给用户。

## 当前未实现

本阶段不包含：

- 文件上传、下载和删除；
- 文件夹重命名、移动和分享；
- 文件内容、Azure Blob 或对象键处理；
- E2EE；
- 前端自动化浏览器测试。

构建、Lint、Functions 类型检查和现有 Functions 测试已在本阶段完成验证；浏览器端真实账号验收仍需在本地 Pages Functions 环境中进行。
