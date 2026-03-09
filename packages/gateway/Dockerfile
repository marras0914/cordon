FROM oven/bun:1 AS base
WORKDIR /app

# Install deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 8000
ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]
