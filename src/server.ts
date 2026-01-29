import HyperExpress from "hyper-express";

const server = new HyperExpress.Server();

server.get("/health", (_req, res) => {
  res.json({ ok: true });
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

const port = Number(process.env.PORT ?? 3000);

server.listen(port).then(() => {
  console.log(`[server] listening on http://127.0.0.1:${port}`);
});
