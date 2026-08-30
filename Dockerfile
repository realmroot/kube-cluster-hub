FROM node:26-bookworm-slim AS build
WORKDIR /src
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json biome.json wrangler.toml vite.config.ts index.html ./
COPY control-plane ./control-plane
COPY data-plane ./data-plane
COPY web ./web
COPY public ./public
COPY migrations ./migrations
COPY migrations-postgres ./migrations-postgres
RUN pnpm build && pnpm build:node

FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --no-optional && pnpm store prune

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --create-home --uid 65532 app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /src/dist-node ./dist-node
COPY --from=build /src/dist/client ./dist/client
COPY migrations ./migrations
COPY migrations-postgres ./migrations-postgres
USER 65532
EXPOSE 8080
CMD ["node", "dist-node/entry-node.js"]
