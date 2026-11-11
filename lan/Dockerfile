# The game server for a LAN night, in a container (Yoshi, 11 Nov 2026: "The local server should run from Docker").
# Built from web/ (lan/compose.yaml sets the context): the packages, the game's build, then the server alone in a
# smaller image that runs as the unprivileged node user. Tonight's data lives in a volume at /app/.data.
# Named lan/Dockerfile, not web/Dockerfile: Railway builds brieltje.be from web/ and would pick up a Dockerfile there.

FROM node:22.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22.12.0-bookworm-slim
WORKDIR /app
# Plain http on the local network: secure cookies only with NODE_ENV=production (server.mjs), so it stays unset.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.mjs"]
