# Build from the repository root:
#   docker build -f apps/hub/Dockerfile -t cuna-hub .
# (apps/hub/compose.yml does this for you.)

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p cuna-hub \
    && cp target/release/cuna-hub /usr/local/bin/cuna-hub

# The web client, served by the hub under /app/ (Cuna in a browser, no install).
FROM node:22-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cuna/desktop...
COPY apps/desktop apps/desktop
# The web build also imports these from outside apps/desktop (picker.js?raw, generated types).
COPY crates/runner/src/ext crates/runner/src/ext
COPY crates/protocol/bindings crates/protocol/bindings
RUN pnpm --filter @cuna/desktop build:web
# The landing page, served at /. It shares the app's stylesheets.
COPY apps/site apps/site
RUN mkdir -p /site/styles \
    && cp apps/site/*.html apps/site/*.css apps/site/*.js /site/ \
    && cp apps/desktop/src/styles/tokens.css apps/desktop/src/styles/app.css apps/desktop/src/styles/screens.css /site/styles/ \
    && sed -i 's#\.\./desktop/src/styles/#styles/#g' /site/index.html

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data cuna \
    && mkdir -p /data && chown cuna /data
COPY --from=build /usr/local/bin/cuna-hub /usr/local/bin/cuna-hub
COPY --from=web /src/apps/desktop/dist-web /srv/web
COPY --from=web /site /srv/site
USER cuna
WORKDIR /data
ENV CUNA_HUB_ADDR=0.0.0.0:8787 \
    CUNA_HUB_DB=sqlite:///data/hub.db \
    CUNA_HUB_WEB_DIR=/srv/web \
    CUNA_HUB_SITE_DIR=/srv/site \
    RUST_LOG=info
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/cuna-hub"]
