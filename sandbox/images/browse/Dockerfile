# syntax=docker/dockerfile:1
# The browse sandbox: Debian's Chromium and a small driver (app/driver.mjs). Build context: this folder.
#   docker build --target browse -t vha-browse:dev sandbox/images/browse     the sandbox
#   docker build --target probe  -t vha-probe:dev  sandbox/images/browse     the same plus attack probes (tests only)
# The base is pinned by digest. Debian's chromium comes from apt at build time; the manager runs the
# built image by digest on the sandbox machine, so every job starts from the image that was tested.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS browse
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # No setuid helper: nothing in the image can gain privileges.
 && rm -f /usr/lib/chromium/chrome-sandbox \
 && find / -xdev -perm /6000 -type f -exec chmod ug-s {} + \
 # The sandbox user: every sandbox runs as 10001.
 && groupadd -g 10001 sbx && useradd -u 10001 -g 10001 -m -d /home/sbx -s /usr/sbin/nologin sbx
WORKDIR /app
COPY package.json package-lock.json /app/
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY app/driver.mjs /app/
# The real binary, not /usr/bin/chromium: that wrapper exports Debian's Google API keys into the environment.
ENV CHROME_BIN=/usr/lib/chromium/chromium HOME=/home/sbx NODE_ENV=production
USER 10001:10001
ENTRYPOINT ["node", "/app/driver.mjs"]

FROM browse AS probe
COPY app/probes.mjs /app/
ENTRYPOINT ["node", "/app/probes.mjs"]
