FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json biome.json wrangler.jsonc vite.config.ts index.html ./
COPY control-plane ./control-plane
COPY web ./web
COPY public ./public
COPY migrations ./migrations
RUN pnpm build && pnpm build:node

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && useradd --create-home --uid 65532 app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /src/dist-node ./dist-node
COPY --from=build /src/dist/client ./dist/client
COPY migrations ./migrations
USER 65532
EXPOSE 8080
CMD ["node", "dist-node/entry-node.js"]
