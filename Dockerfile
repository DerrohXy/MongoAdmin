# ---- build: compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only ----
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/data/data.sqlite
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# persistent volume mount point, writable by the unprivileged "node" user
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# env vars come from the container environment (no .env file inside the image)
CMD ["node", "dist/server.js"]
