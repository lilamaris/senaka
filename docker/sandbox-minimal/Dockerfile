FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    bash \
    coreutils \
    findutils \
    grep \
    sed \
    gawk \
    procps \
    git \
    jq \
    ripgrep \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["sleep", "infinity"]
