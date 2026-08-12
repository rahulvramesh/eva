FROM docker.io/cloudflare/sandbox:0.12.5-python

ENV PATH="/usr/local/python/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bc jq ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
EXPOSE 8080
