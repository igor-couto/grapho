# Release image. The static musl binary is copied in, never built here, so this
# Dockerfile works for any architecture without emulation.
FROM scratch

# Extracts an empty /data owned by 65534, so a named volume inherits a
# directory the unprivileged user can write to.
ADD rootfs.tar /

COPY grapho /grapho
COPY LICENSE /LICENSE

ENV GRAPHO_ADDR=0.0.0.0:25265 \
    GRAPHO_DATA_DIR=/data

EXPOSE 25265
USER 65534:65534
ENTRYPOINT ["/grapho"]
