# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# Build deps for native modules (e.g., better-sqlite3)
RUN apk add --no-cache python3 make g++ \
  && npm config set python /usr/bin/python3

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-alpine
WORKDIR /app

RUN apk add --no-cache ffmpeg \
  && mkdir -p data/photos data/cache data/thumbs data/faces data/memories data/tmp

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/public ./public
COPY --from=build /app/config.json ./config.json
COPY --from=build /app/config_dev.json ./config_dev.json

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.js"]
