import fs from "node:fs";
import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  enableCors: boolean;
}

export interface StorageConfig {
  libraryRoots: string[];
  cacheDir: string;
  thumbnailDir: string;
  faceDir: string;
  memoryDir: string;
  tempDir: string;
}

export interface ScanConfig {
  cron: string;
  incremental: boolean;
  ignoreHidden: boolean;
  ignorePatterns: string[];
  maxConcurrency: number;
  batchSize: number;
}

export interface MediaConfig {
  supportedImageExt: string[];
  supportedVideoExt: string[];
  preferExifTime: boolean;
}

export interface ThumbnailsConfig {
  sizes: number[];
  format: string;
  quality: number;
  concurrency: number;
  regenerate: boolean;
  videoSeekSeconds: number;
  videoKeyframesOnly: boolean;
  ffmpegPath: string;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  scan: ScanConfig;
  media: MediaConfig;
  thumbnails: ThumbnailsConfig;
  [key: string]: unknown;
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: "0.0.0.0",
  port: 3000,
  enableCors: false,
};

const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  libraryRoots: [],
  cacheDir: path.resolve(process.cwd(), "data", "cache"),
  thumbnailDir: path.resolve(process.cwd(), "data", "thumbs"),
  faceDir: path.resolve(process.cwd(), "data", "faces"),
  memoryDir: path.resolve(process.cwd(), "data", "memories"),
  tempDir: path.resolve(process.cwd(), "data", "tmp"),
};

const DEFAULT_SCAN_CONFIG: ScanConfig = {
  cron: "0 3 * * *",
  incremental: true,
  ignoreHidden: true,
  ignorePatterns: [],
  maxConcurrency: 1,
  batchSize: 200,
};

const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  supportedImageExt: [".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"],
  supportedVideoExt: [".mp4", ".mov", ".m4v", ".mkv", ".avi"],
  preferExifTime: true,
};

const DEFAULT_THUMBNAILS_CONFIG: ThumbnailsConfig = {
  sizes: [256],
  format: "jpeg",
  quality: 82,
  concurrency: 1,
  regenerate: false,
  videoSeekSeconds: 1,
  videoKeyframesOnly: true,
  ffmpegPath: "",
};

export const CONFIG_PATH =
  process.env.NASPHOTO_CONFIG ?? path.resolve(process.cwd(), "config.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const normalizeStringArray = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : [...fallback];
};

const normalizePositiveInt = (value: unknown, fallback: number): number => {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
};

const normalizeNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const readJsonFile = (filePath: string): unknown => {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[config] cannot read file: ${filePath}. ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[config] invalid json: ${filePath}. ${message}`);
  }
};

const normalizeServerConfig = (value: unknown): ServerConfig => {
  if (!isRecord(value)) {
    return { ...DEFAULT_SERVER_CONFIG };
  }

  const host =
    typeof value.host === "string" && value.host.trim().length > 0
      ? value.host.trim()
      : DEFAULT_SERVER_CONFIG.host;

  const port =
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port < 65536
      ? value.port
      : DEFAULT_SERVER_CONFIG.port;

  const enableCors =
    typeof value.enableCors === "boolean"
      ? value.enableCors
      : DEFAULT_SERVER_CONFIG.enableCors;

  return { host, port, enableCors };
};

const normalizeStorageConfig = (value: unknown): StorageConfig => {
  if (!isRecord(value)) {
    return { ...DEFAULT_STORAGE_CONFIG };
  }

  const libraryRoots = normalizeStringArray(
    value.libraryRoots,
    DEFAULT_STORAGE_CONFIG.libraryRoots,
  ).map((item) => path.resolve(item));

  const cacheDir = path.resolve(
    normalizeString(value.cacheDir, DEFAULT_STORAGE_CONFIG.cacheDir),
  );
  const thumbnailDir = path.resolve(
    normalizeString(value.thumbnailDir, DEFAULT_STORAGE_CONFIG.thumbnailDir),
  );
  const faceDir = path.resolve(
    normalizeString(value.faceDir, DEFAULT_STORAGE_CONFIG.faceDir),
  );
  const memoryDir = path.resolve(
    normalizeString(value.memoryDir, DEFAULT_STORAGE_CONFIG.memoryDir),
  );
  const tempDir = path.resolve(
    normalizeString(value.tempDir, DEFAULT_STORAGE_CONFIG.tempDir),
  );

  return {
    libraryRoots,
    cacheDir,
    thumbnailDir,
    faceDir,
    memoryDir,
    tempDir,
  };
};

const normalizeScanConfig = (value: unknown): ScanConfig => {
  if (!isRecord(value)) {
    return { ...DEFAULT_SCAN_CONFIG };
  }

  const cron = normalizeString(value.cron, DEFAULT_SCAN_CONFIG.cron);
  const incremental =
    typeof value.incremental === "boolean"
      ? value.incremental
      : DEFAULT_SCAN_CONFIG.incremental;
  const ignoreHidden =
    typeof value.ignoreHidden === "boolean"
      ? value.ignoreHidden
      : DEFAULT_SCAN_CONFIG.ignoreHidden;
  const ignorePatterns = normalizeStringArray(
    value.ignorePatterns,
    DEFAULT_SCAN_CONFIG.ignorePatterns,
  );
  const maxConcurrency = normalizePositiveInt(
    value.maxConcurrency,
    DEFAULT_SCAN_CONFIG.maxConcurrency,
  );
  const batchSize = normalizePositiveInt(
    value.batchSize,
    DEFAULT_SCAN_CONFIG.batchSize,
  );

  return {
    cron,
    incremental,
    ignoreHidden,
    ignorePatterns,
    maxConcurrency,
    batchSize,
  };
};

const normalizeMediaConfig = (value: unknown): MediaConfig => {
  if (!isRecord(value)) {
    return { ...DEFAULT_MEDIA_CONFIG };
  }

  const normalizeExtList = (
    list: unknown,
    fallback: string[],
  ): string[] => {
    const items = normalizeStringArray(list, fallback);
    return items.map((item) =>
      item.startsWith(".") ? item.toLowerCase() : `.${item.toLowerCase()}`,
    );
  };

  const supportedImageExt = normalizeExtList(
    value.supportedImageExt,
    DEFAULT_MEDIA_CONFIG.supportedImageExt,
  );
  const supportedVideoExt = normalizeExtList(
    value.supportedVideoExt,
    DEFAULT_MEDIA_CONFIG.supportedVideoExt,
  );
  const preferExifTime =
    typeof value.preferExifTime === "boolean"
      ? value.preferExifTime
      : DEFAULT_MEDIA_CONFIG.preferExifTime;

  return { supportedImageExt, supportedVideoExt, preferExifTime };
};

const normalizeThumbnailsConfig = (value: unknown): ThumbnailsConfig => {
  if (!isRecord(value)) {
    return { ...DEFAULT_THUMBNAILS_CONFIG };
  }

  const sizes = Array.isArray(value.sizes)
    ? value.sizes
        .filter((item) => typeof item === "number" && item > 0)
        .map((item) => Math.floor(item))
    : DEFAULT_THUMBNAILS_CONFIG.sizes;

  const format = normalizeString(value.format, DEFAULT_THUMBNAILS_CONFIG.format);
  const quality = normalizeNumber(
    value.quality,
    DEFAULT_THUMBNAILS_CONFIG.quality,
  );
  const concurrency = normalizePositiveInt(
    value.concurrency,
    DEFAULT_THUMBNAILS_CONFIG.concurrency,
  );
  const regenerate =
    typeof value.regenerate === "boolean"
      ? value.regenerate
      : DEFAULT_THUMBNAILS_CONFIG.regenerate;
  const videoSeekSeconds = Math.max(
    0,
    normalizeNumber(
      value.videoSeekSeconds,
      DEFAULT_THUMBNAILS_CONFIG.videoSeekSeconds,
    ),
  );
  const videoKeyframesOnly =
    typeof value.videoKeyframesOnly === "boolean"
      ? value.videoKeyframesOnly
      : DEFAULT_THUMBNAILS_CONFIG.videoKeyframesOnly;
  const ffmpegPath = normalizeString(
    value.ffmpegPath,
    DEFAULT_THUMBNAILS_CONFIG.ffmpegPath,
  );

  return {
    sizes: sizes.length > 0 ? sizes : [...DEFAULT_THUMBNAILS_CONFIG.sizes],
    format,
    quality,
    concurrency,
    regenerate,
    videoSeekSeconds,
    videoKeyframesOnly,
    ffmpegPath,
  };
};

export const loadConfig = (filePath: string = CONFIG_PATH): AppConfig => {
  const parsed = readJsonFile(filePath);
  if (!isRecord(parsed)) {
    throw new Error(`[config] root must be an object: ${filePath}`);
  }

  return {
    ...parsed,
    server: normalizeServerConfig(parsed.server),
    storage: normalizeStorageConfig(parsed.storage),
    scan: normalizeScanConfig(parsed.scan),
    media: normalizeMediaConfig(parsed.media),
    thumbnails: normalizeThumbnailsConfig(parsed.thumbnails),
  } as AppConfig;
};
