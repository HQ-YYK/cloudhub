# 参与贡献

## 开发环境

需要 Node.js 22.6+ 和 pnpm。

```bash
pnpm install
pnpm exec wrangler d1 migrations apply cloudhub-db --local
```

本地运行见 [README](./README.md#本地开发)。

## 提交前

```bash
pnpm lint
pnpm build
pnpm test:frontend
pnpm test:functions
pnpm exec tsc -p tsconfig.functions.json --noEmit
```

## 提交信息

格式：`<type>(<scope>): <subject>`，type 用 `feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore`。

## 代码规范

- 单个文件不超过 500 行
- 代码和注释用英文，界面和文档用中文
