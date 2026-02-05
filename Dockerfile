# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bullseye-slim AS deps
WORKDIR /app

# Build deps for native modules (e.g., better-sqlite3)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

FROM node:${NODE_VERSION}-bullseye-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p data/photos data/cache data/thumbs data/faces data/memories data/tmp dist public

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY public ./public

ENV NODE_ENV=production
ENV NASPHOTO_CONFIG=/app/dist/config.json
EXPOSE 3000
CMD ["node", "dist/server.js"]
