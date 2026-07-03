# VaultChain — fictional mock custody platform (no real crypto, keys, or money).
FROM node:22-alpine

WORKDIR /app

RUN npm install -g pnpm@11.9.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY openapi ./openapi

RUN pnpm db:generate

ENV VAULTCHAIN_ENV=dev
EXPOSE 3000

# Migrate, seed deterministically, serve.
CMD ["sh", "-c", "pnpm db:migrate && pnpm seed && pnpm start"]
