# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS node
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
# During managed-cloud builds pass --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt.
# This optional CA remains a build secret and is never included in the runtime image.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update; \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends bash git python3 python3-venv python3-pip ca-certificates libstdc++6; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends bash git python3 python3-venv python3-pip ca-certificates libstdc++6; \
    fi && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /workspace
USER 1000:1000
CMD ["bash"]
