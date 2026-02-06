import path from "node:path";
import fs from "node:fs";
import type { Dirent } from "node:fs";
import fsPromises from "node:fs/promises";
import { randomUUID } from "node:crypto";
import HyperExpress, { type Request, type Response } from "hyper-express";
import { CONFIG_PATH, loadConfig, type PwaConfig } from "./config";
import { openDatabase } from "./db";
import { createLogger } from "./logger";
import { MediaScanner } from "./scanner";
import { ThumbnailService, buildThumbnailPath, type ThumbnailItem } from "./thumbnails";
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
const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const normalizeFolderPath = (value?: string): string | null => {
  if (!value) {
    return "/";
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  let normalized = decoded.replace(/\\/g, "/").trim();
  if (normalized === "") {
    return "/";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  normalized = path.posix.normalize(normalized);
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "." || normalized === "/.") {
    return "/";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) {
    return null;
  }
  return normalized;
};

const normalizeRoutePath = (value?: string): string => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "/";
  }
  let normalized = raw.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  normalized = path.posix.normalize(normalized);
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || "/";
};

type RouteContext = {
  routePath: string;
  ignoreHidden: boolean;
  allowDelete: boolean;
};

const getRouteContext = (req: Request): RouteContext => {
  const headerPath =
    req.header("x-nasphoto-route") ?? req.header("x-route-path") ?? "";
  let routePath = headerPath ? normalizeRoutePath(headerPath) : "";
  if (!routePath) {
    const referer = req.header("referer");
    if (referer) {
      try {
        routePath = normalizeRoutePath(new URL(referer).pathname);
      } catch {
        routePath = "";
      }
    }
  }
  if (!routePath) {
    routePath = "/";
  }
  const segments = routePath.split("/").filter(Boolean);
  const ignoreHidden = segments[0] === "all";
  const allowDelete = segments[segments.length - 1] === "admin";
  return { routePath, ignoreHidden, allowDelete };
};

const normalizeHiddenDir = (value: string): string | null => {
  const normalized = normalizeFolderPath(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const buildHiddenDirFilter = (
  hiddenDirs: string[],
): { clause: string; args: string[] } => {
  if (hiddenDirs.length === 0) {
    return { clause: "", args: [] };
  }
  const parts: string[] = [];
  const args: string[] = [];
  hiddenDirs.forEach((dir) => {
    parts.push("(dir_path = ? OR dir_path LIKE ?)");
    const prefix = dir === "/" ? "/" : dir.replace(/\/+$/, "");
    args.push(prefix, prefix === "/" ? "/%" : `${prefix}/%`);
  });
  return { clause: `AND NOT (${parts.join(" OR ")})`, args };
};

const isHiddenDirPath = (hiddenDirs: string[], dirPath: string): boolean => {
  if (hiddenDirs.length === 0) {
    return false;
  }
  const normalized = dirPath.length > 1 ? dirPath.replace(/\/+$/, "") : dirPath;
  return hiddenDirs.some((dir) => {
    if (dir === "/") {
      return true;
    }
    if (normalized === dir) {
      return true;
    }
    return normalized.startsWith(`${dir}/`);
  });
};

const folderPathToRelative = (folderPath: string): string =>
  folderPath.replace(/^\/+/, "");

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
  ".3gp": "video/3gpp",
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

const parseExifDate = (value: unknown): Date | null => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const pickExifDate = (
  exif: Record<string, unknown> | null,
  keys: string[],
): Date | null => {
  if (!exif) {
    return null;
  }
  for (const key of keys) {
    const date = parseExifDate(exif[key]);
    if (date) {
      return date;
    }
  }
  return null;
};

const buildDirPath = (relPosix: string): string => {
  const dir = path.posix.dirname(relPosix);
  return dir === "." ? "/" : `/${dir}`;
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

const getRootById = (rootId: number): string | null => {
  if (!Number.isFinite(rootId)) {
    return null;
  }
  const index = Math.floor(rootId);
  if (index < 0 || index >= libraryRoots.length) {
    return null;
  }
  return libraryRoots[index];
};

const getRootName = (rootId: number): string => rootNames[rootId] ?? "图库";

const getRootIdByPath = (rootPath: string): number | null => {
  const targetKey = normalizePathKey(rootPath);
  for (let index = 0; index < libraryRoots.length; index += 1) {
    if (normalizePathKey(libraryRoots[index]) === targetKey) {
      return index;
    }
  }
  return null;
};

const resolveFolderFsPath = (root: string, folderPath: string): string | null => {
  const rel = folderPathToRelative(folderPath);
  const resolved = path.resolve(root, rel);
  if (!isPathInside(root, resolved)) {
    return null;
  }
  return resolved;
};

const buildUniquePath = async (dirPath: string, fileName: string): Promise<string> => {
  const parsed = path.parse(fileName);
  let candidate = path.join(dirPath, fileName);
  let counter = 1;
  while (true) {
    try {
      await fsPromises.access(candidate);
      const suffix = `_${counter}`;
      candidate = path.join(dirPath, `${parsed.name}${suffix}${parsed.ext}`);
      counter += 1;
      if (counter > 200) {
        throw new Error("too_many_duplicates");
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return candidate;
        }
      }
      if (error instanceof Error && error.message === "too_many_duplicates") {
        throw error;
      }
      return candidate;
    }
  }
};

const removeThumbnailsForRelPath = async (relPath: string): Promise<void> => {
  const sizes = Array.from(
    new Set(
      config.thumbnails.sizes
        .map((size) => Math.floor(size))
        .filter((size) => size > 0),
    ),
  );
  const targetSizes = sizes.length > 0 ? sizes : [256];
  await Promise.all(
    targetSizes.map((size) =>
      fsPromises.rm(buildThumbnailPath(config, relPath, size), { force: true }),
    ),
  );
};

const indexMediaFile = async (
  root: string,
  fullPath: string,
): Promise<{ id: number | null; item: ThumbnailItem }> => {
  const extension = path.extname(fullPath).toLowerCase();
  const mediaType = getMediaType(extension);
  if (!mediaType) {
    throw new Error("unsupported_media_type");
  }

  const stats = await fsPromises.stat(fullPath);
  const relPath = toPosixPath(path.relative(root, fullPath));
  if (relPath.startsWith("..")) {
    throw new Error("outside_root");
  }

  const sizeBytes = stats.size;
  const mtimeMs = Math.floor(stats.mtimeMs);
  const ctimeMs = Math.floor(
    stats.birthtimeMs && stats.birthtimeMs > 0
      ? stats.birthtimeMs
      : stats.ctimeMs || stats.mtimeMs,
  );

  let exif: Record<string, unknown> | null = null;
  if (mediaType === "image") {
    try {
      exif = (await exifr.parse(fullPath, {
        pick: [
          "DateTimeOriginal",
          "DateTimeDigitized",
          "CreateDate",
          "MediaCreateDate",
          "ModifyDate",
        ],
      })) as Record<string, unknown> | null;
    } catch (error) {
      logger.warn("[upload] exif parse failed", { path: fullPath, error: String(error) });
    }
  }

  const exifOriginal = pickExifDate(exif, [
    "DateTimeOriginal",
    "DateTimeDigitized",
  ]);
  const exifCreate = pickExifDate(exif, [
    "CreateDate",
    "MediaCreateDate",
    "ModifyDate",
  ]);

  const fileCreateMs = ctimeMs || mtimeMs;
  const mediaCreateMs = exifCreate?.getTime() ?? fileCreateMs ?? mtimeMs;
  const exifTimeMs = exifOriginal?.getTime() ?? null;
  const takenTimeMs = exifOriginal?.getTime() ?? mediaCreateMs ?? mtimeMs;
  const primaryTimeMs = config.media.preferExifTime
    ? exifOriginal?.getTime() ?? mediaCreateMs ?? mtimeMs
    : mediaCreateMs ?? exifOriginal?.getTime() ?? mtimeMs;

  const dirPath = buildDirPath(relPath);
  const fileName = path.basename(fullPath);
  const thumbnailPath = buildThumbnailPath(config, relPath);

  mediaStatements.upsert.run({
    root,
    rel_path: relPath,
    dir_path: dirPath,
    file_name: fileName,
    extension,
    media_type: mediaType,
    size_bytes: sizeBytes,
    mtime_ms: mtimeMs,
    ctime_ms: ctimeMs,
    exif_time_ms: exifTimeMs,
    taken_time_ms: takenTimeMs ?? null,
    media_create_time_ms: mediaCreateMs ?? null,
    primary_time_ms: primaryTimeMs ?? null,
    thumbnail_path: thumbnailPath,
    scanned_at: Date.now(),
  });

  const idRow = mediaStatements.byRootRel.get(root, relPath) as
    | { id?: number }
    | undefined;

  return {
    id: typeof idRow?.id === "number" ? idRow.id : null,
    item: {
      root,
      rel_path: relPath,
      media_type: mediaType,
      mtime_ms: mtimeMs,
    },
  };
};

const config = loadConfig();
const { host, port, enableCors } = config.server;
const logger = createLogger(config.logging);

const libraryRoots = config.storage.libraryRoots.map((root) => path.resolve(root));
const rootNames = libraryRoots.map((root) => {
  const name = path.basename(root);
  return name || root;
});
const imageExt = new Set(
  config.media.supportedImageExt.map((ext) => ext.toLowerCase()),
);
const videoExt = new Set(
  config.media.supportedVideoExt.map((ext) => ext.toLowerCase()),
);
const ignoreHidden = config.scan.ignoreHidden;
const ignorePatterns = config.scan.ignorePatterns.map((item) => item.toLowerCase());
const hiddenDirs = Array.from(
  new Set(
    config.permissions.hiddenDirs
      .map((dir) => normalizeHiddenDir(dir))
      .filter((dir): dir is string => Boolean(dir)),
  ),
);
const hiddenDirFilter = buildHiddenDirFilter(hiddenDirs);

const getMediaType = (extension: string): "image" | "video" | null => {
  if (imageExt.has(extension)) {
    return "image";
  }
  if (videoExt.has(extension)) {
    return "video";
  }
  return null;
};

const shouldIgnoreEntry = (name: string): boolean => {
  if (ignoreHidden && name.startsWith(".")) {
    return true;
  }
  if (ignorePatterns.length === 0) {
    return false;
  }
  const lowered = name.toLowerCase();
  return ignorePatterns.some((pattern) => lowered.includes(pattern));
};

const UPLOAD_CHUNK_SIZE = 64 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type UploadSession = {
  id: string;
  root: string;
  tempPath: string;
  targetPath: string;
  size: number;
  receivedBytes: number;
  createdAt: number;
};

const uploadSessions = new Map<string, UploadSession>();

const cleanupUploadSessions = async () => {
  const now = Date.now();
  const stale: UploadSession[] = [];
  for (const session of uploadSessions.values()) {
    if (now - session.createdAt > UPLOAD_SESSION_TTL_MS) {
      stale.push(session);
    }
  }
  for (const session of stale) {
    uploadSessions.delete(session.id);
    try {
      await fsPromises.rm(session.tempPath, { force: true });
    } catch {
      // ignore
    }
  }
};

const safeRename = async (fromPath: string, toPath: string) => {
  try {
    await fsPromises.rename(fromPath, toPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as { code?: string }).code === "EXDEV") {
        await fsPromises.copyFile(fromPath, toPath);
        await fsPromises.rm(fromPath, { force: true });
        return;
      }
    }
    throw error;
  }
};

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
      root,
      media_type,
      COALESCE(primary_time_ms, taken_time_ms, media_create_time_ms, mtime_ms, ctime_ms) AS sort_time_ms
    FROM media_items
    ORDER BY sort_time_ms ASC, id ASC
    LIMIT ? OFFSET ?
  `),
  byId: db.prepare(
    "SELECT id, root, rel_path, dir_path, media_type, thumbnail_path FROM media_items WHERE id = ?",
  ),
  byRootRel: db.prepare("SELECT id FROM media_items WHERE root = ? AND rel_path = ?"),
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
  listByDir: db.prepare(`
    SELECT
      id,
      rel_path,
      file_name,
      media_type,
      COALESCE(primary_time_ms, taken_time_ms, media_create_time_ms, mtime_ms, ctime_ms) AS sort_time_ms
    FROM media_items
    WHERE root = ? AND dir_path = ?
    ORDER BY sort_time_ms ASC, id ASC
  `),
  listByDirRecursive: db.prepare(`
    SELECT id, rel_path
    FROM media_items
    WHERE root = ? AND (dir_path = ? OR dir_path LIKE ?)
  `),
  upsert: db.prepare(`
    INSERT INTO media_items (
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
      primary_time_ms,
      thumbnail_path,
      scanned_at
    )
    VALUES (
      @root,
      @rel_path,
      @dir_path,
      @file_name,
      @extension,
      @media_type,
      @size_bytes,
      @mtime_ms,
      @ctime_ms,
      @exif_time_ms,
      @taken_time_ms,
      @media_create_time_ms,
      @primary_time_ms,
      @thumbnail_path,
      @scanned_at
    )
    ON CONFLICT(root, rel_path) DO UPDATE SET
      dir_path = excluded.dir_path,
      file_name = excluded.file_name,
      extension = excluded.extension,
      media_type = excluded.media_type,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      ctime_ms = excluded.ctime_ms,
      exif_time_ms = excluded.exif_time_ms,
      taken_time_ms = excluded.taken_time_ms,
      media_create_time_ms = excluded.media_create_time_ms,
      primary_time_ms = excluded.primary_time_ms,
      thumbnail_path = excluded.thumbnail_path,
      scanned_at = excluded.scanned_at
  `),
};

const server = new HyperExpress.Server({
  max_body_length: 1024 * 1024 * 1024,
  max_body_buffer: 1024 * 1024 * 1024,
});

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

server.get("/api/media/formats", (_req, res) => {
  res
    .header("Cache-Control", "no-store")
    .json({
      supportedImageExt: config.media.supportedImageExt,
      supportedVideoExt: config.media.supportedVideoExt,
    });
});

server.get("/api/folders", async (req: Request, res: Response) => {
  const query = req.query_parameters as Record<string, string | undefined>;
  const routeContext = getRouteContext(req);
  const rootCount = libraryRoots.length;
  const rawRoot = query.root ?? query.rootId;
  let rootId: number | null = null;
  if (rawRoot !== undefined) {
    const parsed = Number(rawRoot);
    if (Number.isFinite(parsed)) {
      rootId = Math.floor(parsed);
    }
  } else if (rootCount === 1) {
    rootId = 0;
  }

  const root = rootId !== null ? getRootById(rootId) : null;
  if (!root) {
    const folders = libraryRoots.map((value, index) => ({
      rootId: index,
      name: rootNames[index] || value,
    }));
    res.header("Cache-Control", "no-store").json({
      rootList: true,
      rootId: null,
      rootName: null,
      path: "/",
      parentPath: null,
      rootCount,
      folders,
      items: [],
    });
    return;
  }
  const resolvedRootId = rootId ?? 0;

  const folderPath = normalizeFolderPath(query.path);
  if (!folderPath) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }
  if (!routeContext.ignoreHidden && isHiddenDirPath(hiddenDirs, folderPath)) {
    res.status(404).send();
    return;
  }

  const absFolder = resolveFolderFsPath(root, folderPath);
  if (!absFolder) {
    res.status(404).send();
    return;
  }

  try {
    const stat = await fsPromises.stat(absFolder);
    if (!stat.isDirectory()) {
      res.status(404).send();
      return;
    }
  } catch {
    res.status(404).send();
    return;
  }

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(absFolder, { withFileTypes: true });
  } catch (error) {
    logger.warn("[folders] read failed", { root: absFolder, error: String(error) });
    res.status(500).json({ error: "list_failed" });
    return;
  }

  const folders = entries
    .filter((entry) => entry.isDirectory() && !shouldIgnoreEntry(entry.name))
    .map((entry) => {
      const joined = path.posix.join(folderPath, entry.name);
      return {
        name: entry.name,
        path: joined.startsWith("/") ? joined : `/${joined}`,
      };
    })
    .filter(
      (entry) => routeContext.ignoreHidden || !isHiddenDirPath(hiddenDirs, entry.path),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));

  type FolderMediaRow = {
    id: number;
    rel_path: string;
    file_name: string;
    media_type: "image" | "video";
    sort_time_ms: number | null;
  };

  const rows = mediaStatements.listByDir.all(root, folderPath) as FolderMediaRow[];
  const items = rows.map((row) => ({
    id: row.id,
    mediaType: row.media_type,
    timeMs: row.sort_time_ms ?? 0,
    relPath: row.rel_path,
    fileName: row.file_name,
    thumbUrl: `/media/thumb/${row.id}`,
    originalUrl: `/media/original/${row.id}`,
  }));

  const parentPath = folderPath === "/" ? null : path.posix.dirname(folderPath);

  res.header("Cache-Control", "no-store").json({
    rootList: false,
    rootId: resolvedRootId,
    rootName: getRootName(resolvedRootId),
    path: folderPath,
    parentPath,
    rootCount,
    folders,
    items,
  });
});

server.post("/api/folders", async (req: Request, res: Response) => {
  let body: { rootId?: number; path?: string; name?: string } | null = null;
  try {
    body = (await req.json()) as { rootId?: number; path?: string; name?: string };
  } catch {
    body = null;
  }
  if (!body) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const rootId = Number(body.rootId);
  const root = getRootById(rootId);
  if (!root) {
    res.status(400).json({ error: "invalid_root" });
    return;
  }

  const folderPath = normalizeFolderPath(body.path);
  if (!folderPath) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }

  const targetPath = path.posix.join(folderPath, name);
  const absTarget = resolveFolderFsPath(root, targetPath);
  if (!absTarget) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  try {
    await fsPromises.mkdir(absTarget, { recursive: false });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as { code?: string }).code === "EEXIST") {
        res.status(409).json({ error: "exists" });
        return;
      }
    }
    res.status(500).json({ error: "create_failed" });
    return;
  }

  res.status(201).json({
    rootId,
    path: targetPath.startsWith("/") ? targetPath : `/${targetPath}`,
    name,
  });
});

server.post("/api/upload", async (req: Request, res: Response) => {
  const query = req.query_parameters as Record<string, string | undefined>;
  const rawRoot = query.root ?? query.rootId;
  const rootId = rawRoot !== undefined ? Number(rawRoot) : NaN;
  const root = getRootById(rootId);
  if (!root) {
    res.status(400).json({ error: "invalid_root" });
    return;
  }

  const folderPath = normalizeFolderPath(query.path);
  if (!folderPath) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  const absFolder = resolveFolderFsPath(root, folderPath);
  if (!absFolder) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  try {
    await fsPromises.mkdir(absFolder, { recursive: true });
  } catch (error) {
    res.status(500).json({ error: "mkdir_failed" });
    return;
  }

  const uploaded: { name: string; id: number | null }[] = [];
  const failed: { name: string; error: string }[] = [];
  const thumbTargets: ThumbnailItem[] = [];

  try {
    await req.multipart(async (field) => {
      const file = field.file;
      if (!file) {
        return;
      }
      const safeName = path.basename(file.name || "upload");
      const extension = path.extname(safeName).toLowerCase();
      const mediaType = getMediaType(extension);
      if (!mediaType) {
        failed.push({ name: safeName, error: "unsupported" });
        return;
      }

      let targetPath: string;
      try {
        targetPath = await buildUniquePath(absFolder, safeName);
      } catch (error) {
        failed.push({ name: safeName, error: "duplicate" });
        return;
      }

      if (!isPathInside(root, targetPath)) {
        failed.push({ name: safeName, error: "invalid_path" });
        return;
      }

      try {
        await field.write(targetPath);
      } catch (error) {
        failed.push({ name: safeName, error: "write_failed" });
        return;
      }

      try {
        const indexed = await indexMediaFile(root, targetPath);
        if (indexed.item) {
          thumbTargets.push(indexed.item);
        }
        uploaded.push({
          name: path.basename(targetPath),
          id: indexed.id,
        });
      } catch (error) {
        failed.push({ name: safeName, error: "index_failed" });
      }
    });
  } catch (error) {
    logger.warn("[upload] multipart failed", { error: String(error) });
    res.status(500).json({ error: "upload_failed" });
    return;
  }

  if (thumbTargets.length > 0) {
    try {
      await thumbnails.generateForItems(thumbTargets, "manual");
    } catch (error) {
      logger.warn("[upload] thumbnails failed", { error: String(error) });
    }
  }

  res.header("Cache-Control", "no-store").json({
    uploaded,
    failed,
    total: uploaded.length,
  });
});

server.post("/api/upload/init", async (req: Request, res: Response) => {
  await cleanupUploadSessions();
  let body:
    | { rootId?: number; path?: string; name?: string; size?: number }
    | null = null;
  try {
    body = (await req.json()) as {
      rootId?: number;
      path?: string;
      name?: string;
      size?: number;
    };
  } catch {
    body = null;
  }
  if (!body) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const rootId = Number(body.rootId);
  const root = getRootById(rootId);
  if (!root) {
    res.status(400).json({ error: "invalid_root" });
    return;
  }

  const folderPath = normalizeFolderPath(body.path);
  if (!folderPath) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    res.status(400).json({ error: "invalid_size" });
    return;
  }

  const extension = path.extname(name).toLowerCase();
  if (!getMediaType(extension)) {
    res.status(400).json({ error: "unsupported_media_type" });
    return;
  }

  const absFolder = resolveFolderFsPath(root, folderPath);
  if (!absFolder) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  try {
    await fsPromises.mkdir(absFolder, { recursive: true });
  } catch {
    res.status(500).json({ error: "mkdir_failed" });
    return;
  }

  let targetPath: string;
  try {
    targetPath = await buildUniquePath(absFolder, name);
  } catch {
    res.status(500).json({ error: "target_failed" });
    return;
  }
  if (!isPathInside(root, targetPath)) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  const uploadId = randomUUID();
  const tempDir = path.resolve(config.storage.tempDir, "uploads");
  const tempPath = path.join(tempDir, `${uploadId}.part`);

  try {
    await fsPromises.mkdir(tempDir, { recursive: true });
    await fsPromises.writeFile(tempPath, "");
  } catch {
    res.status(500).json({ error: "temp_failed" });
    return;
  }

  uploadSessions.set(uploadId, {
    id: uploadId,
    root,
    tempPath,
    targetPath,
    size,
    receivedBytes: 0,
    createdAt: Date.now(),
  });

  res.header("Cache-Control", "no-store").json({
    uploadId,
    chunkSize: UPLOAD_CHUNK_SIZE,
    targetName: path.basename(targetPath),
  });
});

server.post("/api/upload/chunk/:id", async (req: Request, res: Response) => {
  const uploadId = req.path_parameters.id;
  const session = uploadSessions.get(uploadId);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const query = req.query_parameters as Record<string, string | undefined>;
  const offsetRaw = query.offset ?? req.header("x-upload-offset");
  const offset = offsetRaw ? Number(offsetRaw) : NaN;
  if (!Number.isFinite(offset) || offset < 0) {
    res.status(400).json({ error: "invalid_offset" });
    return;
  }
  if (offset !== session.receivedBytes) {
    res.status(409).json({ error: "offset_mismatch" });
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await req.buffer();
  } catch (error) {
    res.status(400).json({ error: "invalid_chunk" });
    return;
  }

  const nextSize = session.receivedBytes + buffer.length;
  if (nextSize > session.size) {
    res.status(400).json({ error: "chunk_too_large" });
    return;
  }

  try {
    await fsPromises.appendFile(session.tempPath, buffer);
  } catch (error) {
    res.status(500).json({ error: "write_failed" });
    return;
  }

  session.receivedBytes = nextSize;
  res.header("Cache-Control", "no-store").json({
    receivedBytes: session.receivedBytes,
    size: session.size,
  });
});

server.post("/api/upload/complete/:id", async (req: Request, res: Response) => {
  const uploadId = req.path_parameters.id;
  const session = uploadSessions.get(uploadId);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (session.receivedBytes !== session.size) {
    res.status(409).json({ error: "incomplete" });
    return;
  }

  try {
    await safeRename(session.tempPath, session.targetPath);
  } catch (error) {
    res.status(500).json({ error: "finalize_failed" });
    return;
  }

  let indexedId: number | null = null;
  let thumbItem: ThumbnailItem | null = null;
  try {
    const indexed = await indexMediaFile(session.root, session.targetPath);
    indexedId = indexed.id;
    thumbItem = indexed.item;
  } catch (error) {
    logger.warn("[upload] chunk finalize index failed", {
      path: session.targetPath,
      error: String(error),
    });
  }

  if (thumbItem) {
    try {
      await thumbnails.generateForItems([thumbItem], "manual");
    } catch (error) {
      logger.warn("[upload] chunk thumbnails failed", { error: String(error) });
    }
  }

  uploadSessions.delete(uploadId);

  res.header("Cache-Control", "no-store").json({
    id: indexedId,
    name: path.basename(session.targetPath),
  });
});

server.delete("/api/upload/:id", async (req: Request, res: Response) => {
  const uploadId = req.path_parameters.id;
  const session = uploadSessions.get(uploadId);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  uploadSessions.delete(uploadId);
  try {
    await fsPromises.rm(session.tempPath, { force: true });
  } catch {
    // ignore
  }
  res.header("Cache-Control", "no-store").json({ ok: true });
});

server.delete("/api/folders/items", async (req: Request, res: Response) => {
  const routeContext = getRouteContext(req);
  if (!routeContext.allowDelete) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  let body:
    | { rootId?: number; mediaIds?: number[]; folderPaths?: string[] }
    | null = null;
  try {
    body = (await req.json()) as {
      rootId?: number;
      mediaIds?: number[];
      folderPaths?: string[];
    };
  } catch {
    body = null;
  }
  if (!body) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const rootId = Number(body.rootId);
  const root = getRootById(rootId);
  if (!root) {
    res.status(400).json({ error: "invalid_root" });
    return;
  }

  const mediaIds = Array.isArray(body.mediaIds)
    ? body.mediaIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];
  const folderPaths = Array.isArray(body.folderPaths)
    ? body.folderPaths.map((item) => String(item))
    : [];

  const idsToDelete = new Set<number>();
  const relPathsToDelete = new Set<string>();

  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, rel_path FROM media_items WHERE root = ? AND id IN (${placeholders})`,
      )
      .all(root, ...mediaIds) as { id: number; rel_path: string }[];
    rows.forEach((row) => {
      idsToDelete.add(row.id);
      relPathsToDelete.add(row.rel_path);
    });
  }

  for (const rawPath of folderPaths) {
    const folderPath = normalizeFolderPath(rawPath);
    if (!folderPath) {
      continue;
    }
    const absFolder = resolveFolderFsPath(root, folderPath);
    if (!absFolder) {
      continue;
    }
    const likePattern = folderPath === "/" ? "/%" : `${folderPath}/%`;
    const rows = mediaStatements.listByDirRecursive.all(
      root,
      folderPath,
      likePattern,
    ) as { id: number; rel_path: string }[];
    rows.forEach((row) => {
      idsToDelete.add(row.id);
      relPathsToDelete.add(row.rel_path);
    });
    try {
      await fsPromises.rm(absFolder, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  for (const relPath of relPathsToDelete) {
    const filePath = path.resolve(root, toFsPathFromPosix(relPath));
    if (!isPathInside(root, filePath)) {
      continue;
    }
    try {
      await fsPromises.rm(filePath, { force: true });
    } catch {
      // ignore
    }
    try {
      await removeThumbnailsForRelPath(relPath);
    } catch {
      // ignore
    }
  }

  if (idsToDelete.size > 0) {
    const ids = Array.from(idsToDelete);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM media_items WHERE root = ? AND id IN (${placeholders})`).run(
      root,
      ...ids,
    );
  }

  res.header("Cache-Control", "no-store").json({
    deleted: idsToDelete.size,
  });
});

server.get("/api/media", (req: Request, res: Response) => {
  const query = req.query_parameters as Record<string, string | undefined>;
  const routeContext = getRouteContext(req);
  const activeFilter = routeContext.ignoreHidden ? { clause: "", args: [] } : hiddenDirFilter;
  const totalRow = activeFilter.clause
    ? (db
        .prepare(`SELECT COUNT(*) as total FROM media_items WHERE 1=1 ${activeFilter.clause}`)
        .get(...activeFilter.args) as { total?: number } | undefined)
    : (mediaStatements.count.get() as { total?: number } | undefined);
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
    root: string;
    media_type: "image" | "video";
    sort_time_ms: number | null;
  };

  let rows: MediaListRow[] = [];
  if (limit > 0) {
    if (activeFilter.clause) {
      rows = db
        .prepare(
          `
          SELECT
            id,
            root,
            media_type,
            COALESCE(primary_time_ms, taken_time_ms, media_create_time_ms, mtime_ms, ctime_ms) AS sort_time_ms
          FROM media_items
          WHERE 1=1 ${activeFilter.clause}
          ORDER BY sort_time_ms ASC, id ASC
          LIMIT ? OFFSET ?
        `,
        )
        .all(...activeFilter.args, limit, offset) as MediaListRow[];
    } else {
      rows = mediaStatements.list.all(limit, offset) as MediaListRow[];
    }
  }

  const items = rows.map((row) => ({
    id: row.id,
    rootId: getRootIdByPath(row.root),
    mediaType: row.media_type,
    timeMs: row.sort_time_ms ?? 0,
    thumbUrl: `/media/thumb/${row.id}`,
    originalUrl: `/media/original/${row.id}`,
  }));

  res.header("Cache-Control", "no-store").json({ total, items });
});

server.get("/api/media/:id/exif", async (req: Request, res: Response) => {
  const routeContext = getRouteContext(req);
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
  if (!routeContext.ignoreHidden && isHiddenDirPath(hiddenDirs, row.dir_path)) {
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
  const routeContext = getRouteContext(req);

  type MediaRow = {
    root: string;
    rel_path: string;
    dir_path: string;
    media_type: "image" | "video";
    thumbnail_path: string | null;
  };

  const row = mediaStatements.byId.get(id) as MediaRow | undefined;
  if (!row) {
    res.status(404).send();
    return;
  }
  if (!routeContext.ignoreHidden && isHiddenDirPath(hiddenDirs, row.dir_path)) {
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
  const routeContext = getRouteContext(req);

  type MediaRow = {
    root: string;
    rel_path: string;
    dir_path: string;
    media_type: "image" | "video";
  };

  const row = mediaStatements.byId.get(id) as MediaRow | undefined;
  if (!row) {
    res.status(404).send();
    return;
  }
  if (!routeContext.ignoreHidden && isHiddenDirPath(hiddenDirs, row.dir_path)) {
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
