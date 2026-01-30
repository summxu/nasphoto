import fs from "node:fs";
import path from "node:path";
import type { LoggingConfig } from "./config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const normalizeLevel = (value: string): LogLevel => {
  const lowered = value.trim().toLowerCase();
  if (lowered === "debug" || lowered === "info" || lowered === "warn" || lowered === "error") {
    return lowered;
  }
  throw new Error(`[config] logging.level must be one of debug|info|warn|error, got ${value}`);
};

const ensureDir = (filePath: string) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

class FileLogger implements Logger {
  private readonly minLevel: number;
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly config: LoggingConfig) {
    const level = normalizeLevel(config.level);
    this.minLevel = LEVELS[level];
    this.filePath = config.file.trim();
    this.maxBytes = Math.max(1, Math.floor(config.maxSizeMB * 1024 * 1024));
    this.maxFiles = Math.max(1, Math.floor(config.maxFiles));
    if (this.filePath) {
      ensureDir(this.filePath);
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < this.minLevel) {
      return;
    }

    const line = this.formatLine(level, message, meta);
    this.writeConsole(level, line);
    this.writeFile(line);
  }

  private formatLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const base = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      return `${base} ${JSON.stringify(meta)}\n`;
    }
    return `${base}\n`;
  }

  private writeConsole(level: LogLevel, line: string): void {
    if (level === "error") {
      console.error(line.trimEnd());
      return;
    }
    if (level === "warn") {
      console.warn(line.trimEnd());
      return;
    }
    if (level === "debug") {
      console.debug(line.trimEnd());
      return;
    }
    console.log(line.trimEnd());
  }

  private writeFile(line: string): void {
    if (!this.filePath) {
      return;
    }
    this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
    fs.appendFileSync(this.filePath, line, "utf8");
  }

  private rotateIfNeeded(extraBytes: number): void {
    if (!this.filePath) {
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return;
        }
      }
      throw error;
    }

    if (size + extraBytes < this.maxBytes) {
      return;
    }

    const backupCount = Math.max(0, this.maxFiles - 1);
    if (backupCount === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }

    const deleteIfExists = (filePath: string) => {
      fs.rmSync(filePath, { force: true });
    };

    for (let index = backupCount; index >= 1; index -= 1) {
      const dest = `${this.filePath}.${index}`;
      const src = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      if (!fs.existsSync(src)) {
        continue;
      }
      deleteIfExists(dest);
      fs.renameSync(src, dest);
    }
  }
}

export const createLogger = (config: LoggingConfig): Logger => {
  if (config.maxSizeMB <= 0 || !Number.isFinite(config.maxSizeMB)) {
    throw new Error("[config] logging.maxSizeMB must be a positive number");
  }
  if (!Number.isInteger(config.maxFiles) || config.maxFiles <= 0) {
    throw new Error("[config] logging.maxFiles must be a positive integer");
  }
  return new FileLogger(config);
};
