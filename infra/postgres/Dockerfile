# syntax=docker/dockerfile:1.7
# Setu's Postgres for the co-hosted staging (ADR 0019, follow-up 1): postgres:16 + WAL-G, which archives every WAL
# segment to an S3-compatible bucket off the VPS (Cloudflare R2), pushes the nightly base backups and the encrypted
# logical dumps, and restores to a point in time. Encrypted client-side (libsodium) before anything leaves the box.
# WAL-G (Kamrul 08/10/2026: approved over the 1 MB rule) is pinned by version and checksum.
FROM postgres:16
ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256=d6795c663894d836ba20840bffe8970aed81bbe25d3151bd4951f6f9c362def9
ADD --checksum=sha256:${WALG_SHA256} --chmod=0755 https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-amd64 /usr/local/bin/wal-g
RUN wal-g --version
