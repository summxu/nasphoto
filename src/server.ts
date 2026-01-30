import HyperExpress from "hyper-express";
import { CONFIG_PATH, loadConfig } from "./config";
import { openDatabase } from "./db";
import { createLogger } from "./logger";
import { MediaScanner } from "./scanner";
import { ThumbnailService } from "./thumbnails";

const config = loadConfig();
const { host, port, enableCors } = config.server;
const logger = createLogger(config.logging);

logger.info(`[config] loaded ${CONFIG_PATH}`);

const db = openDatabase(config);
const scanner = new MediaScanner(config, db, logger);
const thumbnails = new ThumbnailService(config, db, logger);
scanner.schedule();
scanner.setOnComplete(() => {
  thumbnails.trigger("scan");
});

const server = new HyperExpress.Server();

if (enableCors) {
  server.use((req, res, next) => {
    res
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
      .header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send();
      return;
    }

    return next();
  });
}

server.get("/health", (_req, res) => {
  res.json({ ok: true });
});

server.get("/scan/status", (_req, res) => {
  logger.debug("[scan] status requested");
  res.json(scanner.getStatus());
});

server.get("/scan", (_req, res) => {
  const result = scanner.trigger("manual");
  logger.info("[scan] manual trigger", {
    started: result.started,
    runId: result.runId,
  });
  res.status(result.started ? 202 : 409).json(result);
});

server.get("/thumbnails/status", (_req, res) => {
  logger.debug("[thumbnails] status requested");
  res.json(thumbnails.getStatus());
});

server.get("/thumbnails", (_req, res) => {
  const result = thumbnails.trigger("manual");
  logger.info("[thumbnails] manual trigger", {
    started: result.started,
    queued: result.queued,
    runId: result.runId,
  });
  res.status(result.started ? 202 : 409).json(result);
});

server.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NAS Photo</title>
  </head>
  <body>
    <main>
      <h1>NAS Photo</h1>
      <p>最小启动示例已就绪。</p>
    </main>
  </body>
</html>`);
});

server.listen(port, host).then(() => {
  logger.info(`[server] listening on http://${host}:${port}`);
});
