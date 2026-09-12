# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# @novatip/sdk is installed straight from GitHub, and npm shells out to git to
# clone it. The alpine image ships without git, so npm ci fails without this.
RUN apk add --no-cache git

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src

RUN npm run db:generate
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# git again: the production install also resolves @novatip/sdk from GitHub.
RUN apk add --no-cache git

# Only install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled output and the generated Prisma client
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# The prisma CLI is a devDependency and so is absent from this stage. Copy it
# from the builder rather than letting `npx` fetch it from the network on every
# container start, which makes boot depend on the registry being reachable.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY prisma ./prisma

EXPOSE 3001

# Apply any pending migrations, then start the API and indexer.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/app.js"]
