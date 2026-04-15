FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

RUN if [ -d ".output/server/node_modules/better-sqlite3/build" ]; then \
      cp -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
            .output/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node; \
    fi

FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/.output .output
COPY --from=builder /app/package.json .
COPY --from=builder /app/src/server src/server
COPY --from=builder /app/src/lib src/lib
COPY --from=builder /app/tsconfig.json .

RUN apk add --no-cache python3 make g++ && \
    npm install better-sqlite3 && \
    apk del python3 make g++

RUN mkdir -p /app/data

EXPOSE 8080 3099

CMD ["sh", "-c", "node .output/start-services.cjs & node .output/server/index.mjs"]