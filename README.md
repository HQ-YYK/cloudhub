# CloudHub

Private cloud drive for a small group of accounts. Runs on Cloudflare Pages (free plan), stores metadata in D1 and file content in Google Drive.

- Site: https://cloudhub.hqyyk.loc.cc
- Accounts are created by the admin. There is no public sign-up.
- The admin manages accounts, quotas and the storage connection, but cannot read other users' files or passwords.

## Stack

| Part | Tech |
| --- | --- |
| Frontend | React 19 + Vite |
| API | Cloudflare Pages Functions (`functions/api`) |
| Metadata | Cloudflare D1 (`migrations/`) |
| File content | Google Drive (work in progress) |

## Local development

```bash
pnpm install
pnpm exec wrangler d1 migrations apply cloudhub-db --local
node scripts/init-local-test-user.mjs
pnpm build
pnpm exec wrangler pages dev dist
```

Secrets go in `.dev.vars`, which is git-ignored. Never commit real credentials.

## Tests

```bash
pnpm test:functions
pnpm test:frontend
pnpm lint
```

## Work tracking

Development is split into task files under [`tasks/`](tasks/README.md). Each task names its goal, files, acceptance criteria and target branch.

## License

See [LICENSE](LICENSE).
