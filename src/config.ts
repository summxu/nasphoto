import fs from "node:fs";
import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  enableCors: boolean;
}

export interface AppConfig {
  server: ServerConfig;
  [key: string]: unknown;
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: "0.0.0.0",
  port: 3000,
  enableCors: false,
};

export const CONFIG_PATH =
  process.env.NASPHOTO_CONFIG ?? path.resolve(process.cwd(), "config.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

export const loadConfig = (filePath: string = CONFIG_PATH): AppConfig => {
  const parsed = readJsonFile(filePath);
  if (!isRecord(parsed)) {
    throw new Error(`[config] root must be an object: ${filePath}`);
  }

  return {
    ...parsed,
    server: normalizeServerConfig(parsed.server),
  } as AppConfig;
};
