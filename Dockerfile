FROM node:24-bookworm-slim

# Changing this refreshes Brave. See "ridealong update".
ARG REFRESH=0
RUN echo "refresh $REFRESH" \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends curl ca-certificates \
 && curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
      https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
 && curl -fsSLo /etc/apt/sources.list.d/brave-browser-release.sources \
      https://brave-browser-apt-release.s3.brave.com/brave-browser.sources \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      brave-browser xvfb x11vnc openbox procps \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

WORKDIR /app
COPY viewer/package.json viewer/package-lock.json viewer/
COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd viewer && npm ci --omit=dev --silent --no-audit --no-fund \
 && cd ../mcp && npm ci --omit=dev --silent --no-audit --no-fund

COPY viewer/server.mjs viewer/
COPY viewer/public viewer/public
COPY mcp/ridealong-mcp.mjs mcp/
COPY ridealong-cursor ridealong-cursor
COPY docker/supervise.mjs docker/openbox.xml ./
COPY docker/ridealong-mcp /usr/local/bin/ridealong-mcp

# Brave keeps running a cached background script unless its file name changes,
# even across version bumps, so every build gets a new name.
RUN STAMP=$(date +%s) \
 && mv ridealong-cursor/background.js "ridealong-cursor/background-$STAMP.js" \
 && sed -i "s/\"background.js\"/\"background-$STAMP.js\"/; s/\"version\": \"\([0-9]*\.[0-9]*\)\.[0-9]*\"/\"version\": \"\1.$(( STAMP % 60000 ))\"/" ridealong-cursor/manifest.json

ARG VERSION=dev
ARG BUILT=0
ENV RIDEALONG_VERSION=$VERSION RIDEALONG_BUILT=$BUILT HOME=/tmp/home DISPLAY=:99
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS -m 4 http://127.0.0.1:9222/json/version >/dev/null && curl -fsS -m 4 "http://127.0.0.1:${VIEWER_PORT:-6086}/api/health" >/dev/null
CMD ["node", "/app/supervise.mjs"]
