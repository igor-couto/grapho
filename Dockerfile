# Build a static musl binary, then put it on a scratch image: no shell or
# package manager in the result.
FROM rust:1.89-alpine AS build

RUN apk add --no-cache build-base ca-certificates

WORKDIR /src
COPY Cargo.toml Cargo.lock LICENSE ./
COPY src ./src
COPY assets ./assets

# Assemble the runtime filesystem here so the final image needs a single layer.
RUN cargo build --locked --release --bin grapho \
    && mkdir -p /rootfs/data \
    && cp target/release/grapho /rootfs/grapho \
    && cp LICENSE /rootfs/LICENSE \
    && chmod 0755 /rootfs/grapho

FROM scratch

# The image has no passwd file, so refer to the unprivileged user by number.
COPY --from=build --chown=65534:65534 /rootfs /

ENV GRAPHO_ADDR=0.0.0.0:25265 \
    GRAPHO_DATA_DIR=/data

EXPOSE 25265
USER 65534:65534
ENTRYPOINT ["/grapho"]
