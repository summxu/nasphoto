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

export interface LoggingConfig {
  level: string;
  file: string;
  maxSizeMB: number;
  maxFiles: number;
}

export interface PwaConfig {
  enabled: boolean;
  offlineCacheDays: number;
  maxCacheEntries: number;
}

export interface PermissionsConfig {
  hiddenDirs: string[];
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  scan: ScanConfig;
  media: MediaConfig;
  thumbnails: ThumbnailsConfig;
  logging: LoggingConfig;
  permissions: PermissionsConfig;
  pwa?: PwaConfig;
  [key: string]: unknown;
}

export const CONFIG_PATH =
  process.env.NASPHOTO_CONFIG ?? path.resolve(process.cwd(), "config.json");

type SchemaChecker = (value: unknown, path: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertType = (
  value: unknown,
  pathLabel: string,
  predicate: (value: unknown) => boolean,
  expected: string,
): void => {
  if (!predicate(value)) {
    throw new Error(`[config] ${pathLabel} must be ${expected}`);
  }
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number");

const CONFIG_SCHEMA: Record<string, Record<string, SchemaChecker>> = {
  server: {
    host: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    port: (value, pathLabel) =>
      assertType(value, pathLabel, isInteger, "an integer"),
    enableCors: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
  },
  storage: {
    libraryRoots: (value, pathLabel) =>
      assertType(value, pathLabel, isStringArray, "a string array"),
    cacheDir: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    thumbnailDir: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    faceDir: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    memoryDir: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    tempDir: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
  },
  scan: {
    cron: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    incremental: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
    ignoreHidden: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
    ignorePatterns: (value, pathLabel) =>
      assertType(value, pathLabel, isStringArray, "a string array"),
    maxConcurrency: (value, pathLabel) =>
      assertType(value, pathLabel, isInteger, "an integer"),
    batchSize: (value, pathLabel) =>
      assertType(value, pathLabel, isInteger, "an integer"),
  },
  media: {
    supportedImageExt: (value, pathLabel) =>
      assertType(value, pathLabel, isStringArray, "a string array"),
    supportedVideoExt: (value, pathLabel) =>
      assertType(value, pathLabel, isStringArray, "a string array"),
    preferExifTime: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
  },
  thumbnails: {
    sizes: (value, pathLabel) =>
      assertType(value, pathLabel, isNumberArray, "a number array"),
    format: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    quality: (value, pathLabel) =>
      assertType(value, pathLabel, isFiniteNumber, "a number"),
    concurrency: (value, pathLabel) =>
      assertType(value, pathLabel, isInteger, "an integer"),
    regenerate: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
    videoSeekSeconds: (value, pathLabel) =>
      assertType(value, pathLabel, isFiniteNumber, "a number"),
    videoKeyframesOnly: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
    ffmpegPath: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
  },
  logging: {
    level: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    file: (value, pathLabel) =>
      assertType(value, pathLabel, isString, "a string"),
    maxSizeMB: (value, pathLabel) =>
      assertType(value, pathLabel, isFiniteNumber, "a number"),
    maxFiles: (value, pathLabel) =>
      assertType(value, pathLabel, isInteger, "an integer"),
  },
  pwa: {
    enabled: (value, pathLabel) =>
      assertType(value, pathLabel, isBoolean, "a boolean"),
    offlineCacheDays: (value, pathLabel) =>
      assertType(value, pathLabel, isFiniteNumber, "a number"),
    maxCacheEntries: (value, pathLabel) =>
      assertType(value, pathLabel, isInteger, "an integer"),
  },
  permissions: {
    hiddenDirs: (value, pathLabel) =>
      assertType(value, pathLabel, isStringArray, "a string array"),
  },
};

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

const validateConfig = (config: Record<string, unknown>): void => {
  for (const [section, fields] of Object.entries(CONFIG_SCHEMA)) {
    if (!(section in config)) {
      throw new Error(`[config] missing required section: ${section}`);
    }
    const sectionValue = config[section];
    if (!isRecord(sectionValue)) {
      throw new Error(`[config] ${section} must be an object`);
    }
    for (const [field, checker] of Object.entries(fields)) {
      if (!(field in sectionValue)) {
        throw new Error(`[config] missing required field: ${section}.${field}`);
      }
      checker(sectionValue[field], `${section}.${field}`);
    }
  }
};

export const loadConfig = (filePath: string = CONFIG_PATH): AppConfig => {
  const parsed = readJsonFile(filePath);
  if (!isRecord(parsed)) {
    throw new Error(`[config] root must be an object: ${filePath}`);
  }

  validateConfig(parsed);
  return parsed as AppConfig;
};
