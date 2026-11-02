# syntax=docker/dockerfile:1.7
# Build both frontends from source; no macOS runtime or user data is copied.
FROM node:22-bookworm-slim AS engine-source
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/astrbot
RUN git init . && git remote add origin https://github.com/AstrBotDevs/AstrBot.git \
    && git fetch --depth 1 origin f61a7f42696da6df25dc7a249ec9b8d54ed9da18 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = f61a7f42696da6df25dc7a249ec9b8d54ed9da18 \
    && echo '39f90cd7da9ce25928fadd9793dee57c57912fd9cfd787bf296ef08bbd61c792  uv.lock' | sha256sum --check
RUN npm install --global pnpm@10.28.2
WORKDIR /opt/astrbot/dashboard
RUN pnpm install --frozen-lockfile && pnpm run build \
    && mkdir -p dist/assets ../astrbot/dashboard \
    && echo 'v4.29.3' > dist/assets/version \
    && cp -a dist ../astrbot/dashboard/dist \
    && rm -rf node_modules
WORKDIR /opt/astrbot
RUN printf '%s\n' 'AstrBot 4.29.3' 'https://github.com/AstrBotDevs/AstrBot' 'f61a7f42696da6df25dc7a249ec9b8d54ed9da18' 'AGPL-3.0-or-later' > MIOBOT-UPSTREAM.txt \
    && rm -rf .git

FROM node:22-bookworm-slim AS frontend
WORKDIR /opt/miobot
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
COPY shared ./shared
COPY assets ./assets
COPY public ./public
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg libgomp1 libopus0 git fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node
RUN python -m pip install --no-cache-dir uv==0.13.4
COPY --from=engine-source /opt/astrbot /opt/astrbot
WORKDIR /opt/astrbot
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
RUN uv sync --frozen --no-dev --no-install-project --python /usr/local/bin/python3.12 \
    && uv pip install --python /opt/astrbot/.venv/bin/python --no-deps networkx==3.7 pytz==2026.6 \
    && test "$(sha256sum uv.lock | cut -d ' ' -f 1)" = 39f90cd7da9ce25928fadd9793dee57c57912fd9cfd787bf296ef08bbd61c792
WORKDIR /opt/miobot
COPY package.json package-lock.json LICENSE THIRD_PARTY.md README-cloud.md ./
COPY server ./server
COPY shared ./shared
COPY integrations ./integrations
COPY scripts/patch-managed-runtime.mjs ./scripts/patch-managed-runtime.mjs
COPY licenses ./licenses
COPY --from=frontend /opt/miobot/dist ./dist
COPY --from=frontend /opt/miobot/node_modules ./node_modules
RUN node scripts/patch-managed-runtime.mjs /opt/astrbot \
    && mkdir -p /data && chmod 700 /data
ENV NODE_ENV=production MIOBOT_DATA=/data MIOBOT_PORT=4318 \
    MIOBOT_ASTRBOT_SOURCE=/opt/astrbot MIOBOT_PYTHON=/opt/astrbot/.venv/bin/python
VOLUME ["/data"]
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4318/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/cloud-main.mjs"]
