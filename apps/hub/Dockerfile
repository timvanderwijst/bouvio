# Build from the repository root:
#   docker build -f apps/hub/Dockerfile -t bouvio-hub .
# (apps/hub/compose.yml does this for you.)

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p bouvio-hub \
    && cp target/release/bouvio-hub /usr/local/bin/bouvio-hub

# The web client, served by the hub under /app/ (Bouvio in a browser, no install).
FROM node:22-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @bouvio/desktop...
COPY apps/desktop apps/desktop
RUN pnpm --filter @bouvio/desktop build:web

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data bouvio \
    && mkdir -p /data && chown bouvio /data
COPY --from=build /usr/local/bin/bouvio-hub /usr/local/bin/bouvio-hub
COPY --from=web /src/apps/desktop/dist-web /srv/web
USER bouvio
WORKDIR /data
ENV BOUVIO_HUB_ADDR=0.0.0.0:8787 \
    BOUVIO_HUB_DB=sqlite:///data/hub.db \
    BOUVIO_HUB_WEB_DIR=/srv/web \
    RUST_LOG=info
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/bouvio-hub"]
