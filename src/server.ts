import HyperExpress from "hyper-express";
import { CONFIG_PATH, loadConfig } from "./config";
import { openDatabase } from "./db";
import { MediaScanner } from "./scanner";
import { ThumbnailService } from "./thumbnails";

const config = loadConfig();
const { host, port, enableCors } = config.server;

console.log(`[config] loaded ${CONFIG_PATH}`);

const db = openDatabase(config);
const scanner = new MediaScanner(config, db);
const thumbnails = new ThumbnailService(config, db);
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
  res.json(scanner.getStatus());
});

server.get("/scan", (_req, res) => {
  const result = scanner.trigger("manual");
  res.status(result.started ? 202 : 409).json(result);
});

server.get("/thumbnails/status", (_req, res) => {
  res.json(thumbnails.getStatus());
});

server.get("/thumbnails", (_req, res) => {
  const result = thumbnails.trigger("manual");
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
  console.log(`[server] listening on http://${host}:${port}`);
});
