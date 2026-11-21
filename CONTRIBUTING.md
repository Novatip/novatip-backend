# Contributing to `novatip-backend`

Thanks for your interest. The full contribution guide for every Novatip
repository lives in one place:

**[Novatip contributing guide](https://novatip-docs.pages.dev/contributing)**
([source](https://github.com/Novatip/novatip-docs/blob/main/CONTRIBUTING.md))

Read that first. This page only covers what is specific to this repository.

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/novatip-backend
cd novatip-backend
git remote add upstream https://github.com/Novatip/novatip-backend
git checkout -b fix/short-description
```

`@novatip/sdk` is a `github:Novatip/novatip-sdk#...` dependency in
`package.json` — npm clones it straight from GitHub and builds it itself
through its own `prepare` script, so `npm install` needs `git` on your PATH,
but no sibling checkout of `novatip-sdk`:

```bash
npm install
npx prisma generate
```

PostgreSQL and Redis are needed to run the service. See the README for the
local setup.

## Before you push

CI runs exactly these, in this order (see `.github/workflows/ci.yml`), so run
them locally first:

```bash
npx prisma generate
npx prisma validate
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DATABASE_URL" \
  --exit-code
npm run lint
npm run check:env-docs
npm run typecheck
npm test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/novatip_test \
  npm run test:integration
npm run build
```

The `migrate diff` step replays `prisma/migrations` onto a scratch Postgres
database (used only as a shadow database, not your dev one) and diffs the
result against `schema.prisma`. CI passes its throwaway `DATABASE_URL` as the
shadow database; Prisma resets whatever database that URL names, so locally
make sure `DATABASE_URL` points at a scratch database for this step, not the
one holding your dev data.

The integration tests run against their own database, so CI overrides
`DATABASE_URL` for that step only. Point it at any empty Postgres database you
can create locally — the `postgres:postgres@localhost:5432/novatip_test` value
above is the one CI uses. A non-empty diff means either a schema
change has no migration, or a migration was hand-edited and no longer
matches `schema.prisma` — fix it before pushing, since `prisma migrate
deploy` would otherwise drift from the schema at deploy time. If you changed
`prisma/schema.prisma`, add the migration with `npm run db:migrate`.

## Opening a pull request

- One issue per pull request, opened against `main`
- Reference the issue so it closes on merge: `Closes #123`
- Use [conventional commits](https://novatip-docs.pages.dev/contributing):
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`

## Reporting security issues

Do not open a public issue. See
[SECURITY.md](https://github.com/Novatip/novatip-docs/blob/main/SECURITY.md).
