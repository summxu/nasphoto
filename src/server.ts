import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import HyperExpress, { type Request, type Response } from "hyper-express";
import { CONFIG_PATH, loadConfig, type PwaConfig } from "./config";
import { openDatabase } from "./db";
import { createLogger } from "./logger";
import { MediaScanner } from "./scanner";
import { ThumbnailService, buildThumbnailPath } from "./thumbnails";
import exifr from "exifr";

const normalizePathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isPathInside = (root: string, target: string): boolean => {
  const rootKey = normalizePathKey(root);
  const targetKey = normalizePathKey(target);
  if (rootKey === targetKey) {
    return true;
  }
  const rootPrefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`;
  return targetKey.startsWith(rootPrefix);
};

const toFsPathFromPosix = (value: string): string => value.split("/").join(path.sep);

const parseQueryNumber = (
  value: string | undefined,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = options.integer ? Math.floor(parsed) : parsed;
  const min = options.min ?? normalized;
  const max = options.max ?? normalized;
  return Math.min(max, Math.max(min, normalized));
};

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

const getMimeType = (filePath: string): string | undefined => {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext];
};

const parseRangeHeader = (
  rangeHeader: string,
  size: number,
): { start: number; end: number } | null => {
  if (!rangeHeader.startsWith("bytes=")) {
    return null;
  }
  const [startRaw, endRaw] = rangeHeader.replace("bytes=", "").split("-");
  const start = startRaw ? Number(startRaw) : NaN;
  const end = endRaw ? Number(endRaw) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) {
    return null;
  }

  if (Number.isNaN(start) && !Number.isNaN(end)) {
    const length = Math.max(end, 0);
    const rangeStart = Math.max(size - length, 0);
    return { start: rangeStart, end: size - 1 };
  }

  const rangeStart = Number.isNaN(start) ? 0 : start;
  const rangeEnd = Number.isNaN(end) ? size - 1 : end;

  if (rangeStart < 0 || rangeEnd < rangeStart || rangeStart >= size) {
    return null;
  }

  return { start: rangeStart, end: Math.min(rangeEnd, size - 1) };
};

const normalizeExifValue = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `Binary(${value.length} bytes)`;
  }
  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, 32)
      .map((item) => normalizeExifValue(item))
      .filter((item) => item !== null)
      .join(", ");
    return value.length > 32 ? `${mapped} ... (${value.length})` : mapped;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 16)
      .map(([key, val]) => `${key}: ${normalizeExifValue(val)}`)
      .join("; ");
    return entries || String(value);
  }
  return String(value);
};

const sanitizeExif = (
  exif: Record<string, unknown> | null,
): Record<string, string | number | boolean> => {
  if (!exif) {
    return {};
  }
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(exif)) {
    const normalized = normalizeExifValue(value);
    if (normalized === null || normalized === "") {
      continue;
    }
    if (typeof normalized === "string" && normalized.length > 800) {
      sanitized[key] = `${normalized.slice(0, 800)}…`;
      continue;
    }
    sanitized[key] = normalized;
  }
  return sanitized;
};

const sendFileStream = async (
  req: Request | null,
  res: Response,
  filePath: string,
  options: { cacheControl?: string; contentType?: string } = {},
): Promise<void> => {
  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) {
      res.status(404).send();
      return;
    }
    const size = stat.size;
    const contentType = options.contentType ?? getMimeType(filePath);
    if (contentType) {
      res.header("Content-Type", contentType);
    }
    if (options.cacheControl) {
      res.header("Cache-Control", options.cacheControl);
    }
    res.header("Accept-Ranges", "bytes");

    const rangeHeader = req?.header("range");
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, size);
      if (range) {
        const chunkSize = range.end - range.start + 1;
        res
          .status(206)
          .header("Content-Length", String(chunkSize))
          .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        await res.stream(fs.createReadStream(filePath, range), chunkSize);
        return;
      }
    }

    res.header("Content-Length", String(size));
    await res.stream(fs.createReadStream(filePath), size);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as { code?: string }).code === "ENOENT") {
        res.status(404).send();
        return;
      }
    }
    res.status(500).json({ error: "file_stream_failed" });
  }
};

const resolvePublicPath = (root: string, urlPath: string): string | null => {
  try {
    const decoded = decodeURIComponent(urlPath);
    const relative = decoded.replace(/^\/+/, "");
    const resolved = path.resolve(root, relative);
    if (!isPathInside(root, resolved)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
};

const pickPwaConfig = (config: unknown): PwaConfig => {
  if (config && typeof config === "object") {
    const record = config as Partial<PwaConfig>;
    return {
      enabled: record.enabled ?? true,
      offlineCacheDays: record.offlineCacheDays ?? 365,
      maxCacheEntries: record.maxCacheEntries ?? 500,
    };
  }
  return { enabled: true, offlineCacheDays: 365, maxCacheEntries: 500 };
};

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

const publicDir = path.resolve(process.cwd(), "public");
const publicIndex = path.join(publicDir, "index.html");

const mediaStatements = {
  count: db.prepare("SELECT COUNT(*) as total FROM media_items"),
  list: db.prepare(`
    SELECT
      id,
      media_type,
      COALESCE(primary_time_ms, taken_time_ms, media_create_time_ms, mtime_ms, ctime_ms) AS sort_time_ms
    FROM media_items
    ORDER BY sort_time_ms ASC, id ASC
    LIMIT ? OFFSET ?
  `),
  byId: db.prepare(
    "SELECT id, root, rel_path, media_type, thumbnail_path FROM media_items WHERE id = ?",
  ),
  detail: db.prepare(`
    SELECT
      id,
      root,
      rel_path,
      dir_path,
      file_name,
      extension,
      media_type,
      size_bytes,
      mtime_ms,
      ctime_ms,
      exif_time_ms,
      taken_time_ms,
      media_create_time_ms,
      primary_time_ms
    FROM media_items
    WHERE id = ?
  `),
};

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

server.get("/api/pwa-config", (_req, res) => {
  const pwa = pickPwaConfig(config.pwa);
  res.header("Cache-Control", "no-store").json(pwa);
});

server.get("/api/media", (req: Request, res: Response) => {
  const query = req.query_parameters as Record<string, string | undefined>;
  const totalRow = mediaStatements.count.get() as { total?: number } | undefined;
  const total = totalRow?.total ?? 0;
  const limit = parseQueryNumber(query.limit, total, {
    min: 0,
    max: Math.max(total, 0),
    integer: true,
  });
  const offset = parseQueryNumber(query.offset, 0, {
    min: 0,
    max: Math.max(total - 1, 0),
    integer: true,
  });

  type MediaListRow = {
    id: number;
    media_type: "image" | "video";
    sort_time_ms: number | null;
  };

  const rows =
    limit > 0
      ? (mediaStatements.list.all(limit, offset) as MediaListRow[])
      : ([] as MediaListRow[]);

  const items = rows.map((row) => ({
    id: row.id,
    mediaType: row.media_type,
    timeMs: row.sort_time_ms ?? 0,
    thumbUrl: `/media/thumb/${row.id}`,
    originalUrl: `/media/original/${row.id}`,
  }));

  res.header("Cache-Control", "no-store").json({ total, items });
});

server.get("/api/media/:id/exif", async (req: Request, res: Response) => {
  const rawId = req.path_parameters.id;
  const id = Number(rawId);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  type MediaDetailRow = {
    id: number;
    root: string;
    rel_path: string;
    dir_path: string;
    file_name: string;
    extension: string;
    media_type: "image" | "video";
    size_bytes: number;
    mtime_ms: number;
    ctime_ms: number;
    exif_time_ms: number | null;
    taken_time_ms: number | null;
    media_create_time_ms: number | null;
    primary_time_ms: number | null;
  };

  const row = mediaStatements.detail.get(id) as MediaDetailRow | undefined;
  if (!row) {
    res.status(404).send();
    return;
  }

  const filePath = path.resolve(row.root, toFsPathFromPosix(row.rel_path));
  if (!isPathInside(row.root, filePath)) {
    res.status(404).send();
    return;
  }

  let exif: Record<string, unknown> | null = null;
  let gps: { latitude?: number; longitude?: number; altitude?: number } | null =
    null;
  if (row.media_type === "image") {
    try {
      exif = (await exifr.parse(filePath)) as Record<string, unknown> | null;
    } catch (error) {
      logger.warn("[exif] parse failed", { id, error: String(error) });
    }
    try {
      const gpsResult = (await exifr.gps(filePath)) as
        | { latitude?: number; longitude?: number; altitude?: number }
        | null;
      if (gpsResult && Number.isFinite(gpsResult.latitude ?? NaN)) {
        gps = gpsResult;
      }
    } catch (error) {
      logger.warn("[exif] gps parse failed", { id, error: String(error) });
    }
  }

  res.header("Cache-Control", "no-store").json({
    id: row.id,
    mediaType: row.media_type,
    fileName: row.file_name,
    relPath: row.rel_path,
    dirPath: row.dir_path,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    ctimeMs: row.ctime_ms,
    exifTimeMs: row.exif_time_ms,
    takenTimeMs: row.taken_time_ms,
    mediaCreateTimeMs: row.media_create_time_ms,
    primaryTimeMs: row.primary_time_ms,
    exif: sanitizeExif(exif),
    gps,
  });
});

server.get("/media/thumb/:id", async (req: Request, res: Response) => {
  const rawId = req.path_parameters.id;
  const id = Number(rawId);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  type MediaRow = {
    root: string;
    rel_path: string;
    media_type: "image" | "video";
    thumbnail_path: string | null;
  };

  const row = mediaStatements.byId.get(id) as MediaRow | undefined;
  if (!row) {
    res.status(404).send();
    return;
  }

  const thumbnailPath = row.thumbnail_path || buildThumbnailPath(config, row.rel_path);
  if (!isPathInside(config.storage.thumbnailDir, thumbnailPath)) {
    res.status(404).send();
    return;
  }

  await sendFileStream(req, res, thumbnailPath, {
    cacheControl: "public, max-age=31536000, immutable",
  });
});

server.get("/media/original/:id", async (req: Request, res: Response) => {
  const rawId = req.path_parameters.id;
  const id = Number(rawId);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  type MediaRow = {
    root: string;
    rel_path: string;
    media_type: "image" | "video";
  };

  const row = mediaStatements.byId.get(id) as MediaRow | undefined;
  if (!row) {
    res.status(404).send();
    return;
  }

  const filePath = path.resolve(row.root, toFsPathFromPosix(row.rel_path));
  if (!isPathInside(row.root, filePath)) {
    res.status(404).send();
    return;
  }

  await sendFileStream(req, res, filePath, {
    cacheControl: "public, max-age=31536000, immutable",
  });
});

server.get("/", async (_req, res) => {
  await sendFileStream(null, res, publicIndex, {
    cacheControl: "no-cache",
  });
});

server.get("/*", async (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) {
    res.status(404).send();
    return;
  }

  const resolved = resolvePublicPath(publicDir, req.path);
  if (!resolved) {
    res.status(404).send();
    return;
  }

  try {
    const stat = await fsPromises.stat(resolved);
    if (stat.isFile()) {
      const cacheControl = resolved === publicIndex ? "no-cache" : "public, max-age=604800";
      await sendFileStream(req, res, resolved, { cacheControl });
      return;
    }
  } catch {
    // handled below
  }

  if (path.extname(resolved) === "") {
    await sendFileStream(req, res, publicIndex, {
      cacheControl: "no-cache",
    });
    return;
  }

  res.status(404).send();
});

server.listen(port, host).then(() => {
  logger.info(`[server] listening on http://${host}:${port}`);
});
