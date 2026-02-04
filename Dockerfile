# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG APK_MIRROR=dl-cdn.alpinelinux.org

FROM node:${NODE_VERSION}-alpine AS build
ARG APK_MIRROR
WORKDIR /app

# Build deps for native modules (e.g., better-sqlite3)
RUN if [ "$APK_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
    sed -i "s|dl-cdn.alpinelinux.org|$APK_MIRROR|g" /etc/apk/repositories; \
  fi \
  && apk add --no-cache python3 make g++
ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine
ARG APK_MIRROR
WORKDIR /app

RUN if [ "$APK_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
    sed -i "s|dl-cdn.alpinelinux.org|$APK_MIRROR|g" /etc/apk/repositories; \
  fi \
  && apk add --no-cache ffmpeg \
  && mkdir -p data/photos data/cache data/thumbs data/faces data/memories data/tmp

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/public ./public
COPY --from=build /app/config.json ./config.json

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.js"]
