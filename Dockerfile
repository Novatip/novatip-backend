# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# git: npm shells out to it to clone @novatip/sdk from GitHub.
# openssl: Prisma's query and schema engines link against libssl at runtime and
# fail with "Could not parse schema engine response" without it on Alpine.
RUN apk add --no-cache git openssl

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

# git and openssl again: this stage installs from GitHub and runs the Prisma
# engines, so it needs both for the same reasons as the builder.
RUN apk add --no-cache git openssl

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
