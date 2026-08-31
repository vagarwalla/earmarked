# press worker — Raindrop polling, extraction, layout, compose, ordering.
#
# Chromium is the reason this exists as a separate runtime: Vivliostyle renders
# with a real browser engine, which does not fit inside a Vercel function.

FROM node:24-slim AS base

# Chromium and the fonts the layout falls back to. press.css names Georgia and
# Helvetica first, neither of which exists on Linux, so the Liberation and
# DejaVu families are what actually renders — they are a hard dependency of the
# design, not a nicety.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PRESS_CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

# Dependencies first, so a source change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild sharp

# The worker imports straight out of src/lib/press, so both come along.
COPY tsconfig.json ./
COPY src/lib/press ./src/lib/press
COPY worker ./worker

# tsx runs the TypeScript directly; a build step would buy nothing here.
RUN npm install --no-save tsx@4

CMD ["npx", "tsx", "worker/index.ts"]
