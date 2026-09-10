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

This package resolves `@novatip/sdk` from a sibling checkout, so clone and
build it alongside this repo:

```bash
git clone https://github.com/Novatip/novatip-sdk ../novatip-sdk
(cd ../novatip-sdk && npm ci && npm run build)
npm install
npx prisma generate
```

PostgreSQL and Redis are needed to run the service (not to run the checks).
See the README for the local setup.

## Before you push

CI runs exactly these, so run them locally first:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Opening a pull request

- One issue per pull request, opened against `main`
- Reference the issue so it closes on merge: `Closes #123`
- Use [conventional commits](https://novatip-docs.pages.dev/contributing):
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`

## Reporting security issues

Do not open a public issue. See
[SECURITY.md](https://github.com/Novatip/novatip-docs/blob/main/SECURITY.md).
