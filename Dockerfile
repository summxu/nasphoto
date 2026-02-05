# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG APK_MIRROR=dl-cdn.alpinelinux.org

FROM node:${NODE_VERSION}-alpine AS deps
ARG APK_MIRROR
WORKDIR /app

# Build deps for native modules (e.g., better-sqlite3)
RUN if [ "$APK_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
    sed -i "s|dl-cdn.alpinelinux.org|$APK_MIRROR|g" /etc/apk/repositories; \
  fi \
  && apk add --no-cache python3 py3-setuptools make g++ git

COPY package*.json ./
RUN npm install --omit=dev

FROM node:${NODE_VERSION}-alpine
ARG APK_MIRROR
WORKDIR /app

RUN if [ "$APK_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
    sed -i "s|dl-cdn.alpinelinux.org|$APK_MIRROR|g" /etc/apk/repositories; \
  fi \
  && apk add --no-cache ffmpeg \
  && mkdir -p data/photos data/cache data/thumbs data/faces data/memories data/tmp dist public

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY public ./public

ENV NODE_ENV=production
ENV NASPHOTO_CONFIG=/app/dist/config.json
EXPOSE 3000
CMD ["node", "dist/server.js"]
