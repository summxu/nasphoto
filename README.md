# nasphoto

最小可运行脚手架（无业务逻辑）。

## 目录结构
- `src/` 后端 TypeScript 源码
- `public/` 前端静态文件占位

## 本地启动
```bash
npm install
npm run dev
```

配置文件默认读取 `config.json`（可用 `NASPHOTO_CONFIG` 指定路径）。

访问：
- `http://localhost:3000/`
- `http://localhost:3000/health`

## 生产构建
```bash
npm run build
npm start
```

## Docker（可选）
```bash
docker compose up --build
```
