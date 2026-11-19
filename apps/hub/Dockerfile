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

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data bouvio \
    && mkdir -p /data && chown bouvio /data
COPY --from=build /usr/local/bin/bouvio-hub /usr/local/bin/bouvio-hub
USER bouvio
WORKDIR /data
ENV BOUVIO_HUB_ADDR=0.0.0.0:8787 \
    BOUVIO_HUB_DB=sqlite:///data/hub.db \
    RUST_LOG=info
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/bouvio-hub"]
