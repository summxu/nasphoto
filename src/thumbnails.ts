import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { AppConfig } from "./config";
import type { SqliteDatabase } from "./db";
import type { Logger } from "./logger";

export type MediaType = "image" | "video";
type ThumbnailReason = "manual" | "scan" | "startup";
type SqliteStatement = import("better-sqlite3").Statement<unknown[]>;

export interface ThumbnailItem {
  root: string;
  rel_path: string;
  media_type: MediaType;
  mtime_ms: number;
}

interface MediaItemRow extends ThumbnailItem {}

interface ThumbnailCounts {
  targets: number;
  generated: number;
  skipped: number;
  failed: number;
  cleaned: number;
}

export interface ThumbnailSummary {
  runId: string;
  reason: ThumbnailReason;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counts: ThumbnailCounts;
  errorSamples: string[];
}

export interface ThumbnailStatus {
  running: boolean;
  queued: boolean;
  current?: {
    runId: string;
    reason: ThumbnailReason;
    startedAt: string;
  };
  last?: ThumbnailSummary;
}

export interface ThumbnailTriggerResult {
  started: boolean;
  queued?: boolean;
  runId?: string;
  status: ThumbnailStatus;
}

const normalizeFormat = (format: string): string => {
  const normalized = format.trim().toLowerCase();
  return normalized === "jpg" ? "jpeg" : normalized;
};

export const normalizeThumbExtension = (format: string): string => {
  const normalized = normalizeFormat(format);
  if (normalized === "jpeg") {
    return ".jpg";
  }
  if (normalized === "png") {
    return ".png";
  }
  if (normalized === "webp") {
    return ".webp";
  }
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
};

export const buildThumbnailPath = (
  config: AppConfig,
  relPosix: string,
  size: number = config.thumbnails.sizes[0] ?? 256,
): string => {
  const ext = normalizeThumbExtension(config.thumbnails.format);
  const parsed = path.posix.parse(relPosix);
  const targetRel = path.posix.join(parsed.dir, `${parsed.name}${ext}`);
  const segments = targetRel.split("/");
  return path.join(config.storage.thumbnailDir, String(size), ...segments);
};

const fromPosixPath = (value: string): string =>
  value.split("/").join(path.sep);

const normalizePathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

class TaskPool {
  private pending = new Set<Promise<void>>();

  constructor(private readonly limit: number) {}

  async run(task: () => Promise<void>): Promise<void> {
    if (this.limit <= 1) {
      await task();
      return;
    }
    const promise = task();
    this.pending.add(promise);
    const cleanup = () => this.pending.delete(promise);
    promise.then(cleanup, cleanup);
    if (this.pending.size >= this.limit) {
      await Promise.race(this.pending);
    }
  }

  async flush(): Promise<void> {
    if (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }
}

export class ThumbnailService {
  private readonly statements: {
    selectMedia: SqliteStatement;
  };
  private running = false;
  private current?: ThumbnailStatus["current"];
  private last?: ThumbnailSummary;
  private queuedReason?: ThumbnailReason;
  private readonly ffmpegPath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly db: SqliteDatabase,
    private readonly logger: Logger,
  ) {
    this.statements = {
      selectMedia: db.prepare(
        "SELECT root, rel_path, media_type, mtime_ms FROM media_items ORDER BY root, rel_path",
      ),
    };
    const configPath = this.config.thumbnails.ffmpegPath?.trim();
    this.ffmpegPath =
      configPath ||
      process.env.NASPHOTO_FFMPEG ||
      process.env.FFMPEG_PATH ||
      "ffmpeg";
  }

  trigger(reason: ThumbnailReason = "manual"): ThumbnailTriggerResult {
    if (this.running) {
      this.queuedReason = reason;
      return {
        started: false,
        queued: true,
        status: this.getStatus(),
      };
    }

    const runId = randomUUID();
    this.running = true;
    this.current = {
      runId,
      reason,
      startedAt: new Date().toISOString(),
    };
    this.logger.info("[thumbnails] started", { runId, reason });

    this.generate(runId, reason)
      .then((summary) => {
        this.last = summary;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        const startedAt = this.current?.startedAt ?? finishedAt;
        this.last = {
          runId,
          reason,
          startedAt,
          finishedAt,
          durationMs:
            new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
          counts: {
            targets: 0,
            generated: 0,
            skipped: 0,
            failed: 1,
            cleaned: 0,
          },
          errorSamples: [message],
        };
        this.logger.error(`[thumbnails] failed: ${message}`);
      })
      .finally(() => {
        this.running = false;
        this.current = undefined;
        const queued = this.queuedReason;
        this.queuedReason = undefined;
        if (queued) {
          this.trigger(queued);
        }
      });

    return {
      started: true,
      runId,
      status: this.getStatus(),
    };
  }

  getStatus(): ThumbnailStatus {
    return {
      running: this.running,
      queued: Boolean(this.queuedReason),
      current: this.current,
      last: this.last,
    };
  }

  async generateForItems(
    items: ThumbnailItem[],
    reason: ThumbnailReason = "manual",
  ): Promise<ThumbnailSummary> {
    const startedAt = new Date();
    const counts: ThumbnailCounts = {
      targets: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
      cleaned: 0,
    };
    const errorSamples: string[] = [];

    const recordError = (message: string) => {
      counts.failed += 1;
      if (errorSamples.length < 10) {
        errorSamples.push(message);
      }
    };

    const sizes = Array.from(
      new Set(
        this.config.thumbnails.sizes
          .map((size) => Math.floor(size))
          .filter((size) => size > 0),
      ),
    );
    if (sizes.length === 0) {
      sizes.push(256);
    }

    const pool = new TaskPool(this.config.thumbnails.concurrency);

    for (const item of items) {
      const sourcePath = path.join(item.root, fromPosixPath(item.rel_path));
      const targets = sizes.map((size) => ({
        size,
        path: buildThumbnailPath(this.config, item.rel_path, size),
      }));

      for (const target of targets) {
        counts.targets += 1;
      }

      await pool.run(async () => {
        for (const target of targets) {
          try {
            const generated = await this.generateIfNeeded(
              item,
              sourcePath,
              target.path,
              target.size,
            );
            if (generated) {
              counts.generated += 1;
            } else {
              counts.skipped += 1;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordError(
              `[thumbnails] generate failed ${sourcePath} -> ${target.path}: ${message}`,
            );
          }
        }
      });
    }

    await pool.flush();

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    this.logger.info(
      `[thumbnails] targeted done in ${durationMs}ms, generated=${counts.generated}, skipped=${counts.skipped}, failed=${counts.failed}`,
    );

    return {
      runId: randomUUID(),
      reason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      counts,
      errorSamples,
    };
  }

  private async generate(
    runId: string,
    reason: ThumbnailReason,
  ): Promise<ThumbnailSummary> {
    const startedAt = new Date();
    const counts: ThumbnailCounts = {
      targets: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
      cleaned: 0,
    };
    const errorSamples: string[] = [];

    const recordError = (message: string) => {
      counts.failed += 1;
      if (errorSamples.length < 10) {
        errorSamples.push(message);
      }
    };

    const sizes = Array.from(
      new Set(
        this.config.thumbnails.sizes
          .map((size) => Math.floor(size))
          .filter((size) => size > 0),
      ),
    );
    if (sizes.length === 0) {
      sizes.push(256);
    }

    const items = this.statements.selectMedia.iterate() as Iterable<MediaItemRow>;
    const pool = new TaskPool(this.config.thumbnails.concurrency);
    const expected = new Set<string>();

    for (const item of items) {
      const sourcePath = path.join(item.root, fromPosixPath(item.rel_path));
      const targets = sizes.map((size) => ({
        size,
        path: buildThumbnailPath(this.config, item.rel_path, size),
      }));

      for (const target of targets) {
        expected.add(normalizePathKey(target.path));
        counts.targets += 1;
      }

      await pool.run(async () => {
        for (const target of targets) {
          try {
            const generated = await this.generateIfNeeded(
              item,
              sourcePath,
              target.path,
              target.size,
            );
            if (generated) {
              counts.generated += 1;
            } else {
              counts.skipped += 1;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordError(
              `[thumbnails] generate failed ${sourcePath} -> ${target.path}: ${message}`,
            );
          }
        }
      });
    }

    await pool.flush();

    try {
      counts.cleaned += await this.cleanupThumbnails(sizes, expected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(`[thumbnails] cleanup failed: ${message}`);
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    this.logger.info(
      `[thumbnails] done in ${durationMs}ms, generated=${counts.generated}, skipped=${counts.skipped}, failed=${counts.failed}, cleaned=${counts.cleaned}`,
    );

    return {
      runId,
      reason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      counts,
      errorSamples,
    };
  }

  private async generateIfNeeded(
    item: MediaItemRow,
    sourcePath: string,
    targetPath: string,
    size: number,
  ): Promise<boolean> {
    if (!this.config.thumbnails.regenerate) {
      const exists = await this.thumbnailIsFresh(targetPath, item.mtime_ms);
      if (exists) {
        return false;
      }
    }

    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      throw new Error("source is not a file");
    }

    await this.generateThumbnail(
      sourcePath,
      targetPath,
      item.media_type,
      size,
    );
    return true;
  }

  private async thumbnailIsFresh(
    targetPath: string,
    sourceMtimeMs: number,
  ): Promise<boolean> {
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        return false;
      }
      return stat.mtimeMs >= sourceMtimeMs;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return false;
        }
      }
      throw error;
    }
  }

  private async generateThumbnail(
    sourcePath: string,
    targetPath: string,
    mediaType: MediaType,
    size: number,
  ): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const format = normalizeFormat(this.config.thumbnails.format);
    const qualityArgs = this.getQualityArgs(format, this.config.thumbnails.quality);
    const scaleFilter = `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`;

    const args: string[] = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
    ];

    if (mediaType === "video") {
      if (this.config.thumbnails.videoKeyframesOnly) {
        args.push("-skip_frame", "nokey");
      }
      if (this.config.thumbnails.videoSeekSeconds > 0) {
        args.push("-ss", String(this.config.thumbnails.videoSeekSeconds));
      }
    }

    args.push("-i", sourcePath);

    if (mediaType === "video") {
      args.push("-an");
    }

    args.push(
      "-vf",
      scaleFilter,
      "-frames:v",
      "1",
      "-threads",
      "1",
    );

    args.push(...qualityArgs, targetPath);

    try {
      await this.execFfmpeg(args);
    } catch (error) {
      await fs.rm(targetPath, { force: true });
      if (mediaType === "video" && this.config.thumbnails.videoSeekSeconds > 0) {
        await this.retryVideoThumbnail(sourcePath, targetPath, size, error);
        return;
      }
      throw error;
    }
  }

  private async retryVideoThumbnail(
    sourcePath: string,
    targetPath: string,
    size: number,
    error: unknown,
  ): Promise<void> {
    const format = normalizeFormat(this.config.thumbnails.format);
    const qualityArgs = this.getQualityArgs(format, this.config.thumbnails.quality);
    const scaleFilter = `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`;

    const args: string[] = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
    ];

    if (this.config.thumbnails.videoKeyframesOnly) {
      args.push("-skip_frame", "nokey");
    }

    args.push("-i", sourcePath, "-an", "-vf", scaleFilter, "-frames:v", "1", "-threads", "1");
    args.push(...qualityArgs, targetPath);

    try {
      await this.execFfmpeg(args);
    } catch (retryError) {
      await fs.rm(targetPath, { force: true });
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      const firstMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`ffmpeg failed (seek fallback): ${firstMessage}; retry: ${message}`);
    }
  }

  private getQualityArgs(format: string, quality: number): string[] {
    const normalized = normalizeFormat(format);
    const clampedQuality = clamp(Math.round(quality), 1, 100);

    if (normalized === "jpeg") {
      const jpegQuality = clamp(
        Math.round(31 - (clampedQuality / 100) * 29),
        2,
        31,
      );
      return ["-q:v", String(jpegQuality)];
    }

    if (normalized === "webp") {
      return ["-q:v", String(clampedQuality)];
    }

    if (normalized === "png") {
      return ["-compression_level", "6"];
    }

    return [];
  }

  private execFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";

      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4000) {
          stderr += chunk.toString();
        }
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const detail = stderr.trim();
          reject(new Error(detail || `ffmpeg exited with code ${code}`));
        }
      });
    });
  }

  private async cleanupThumbnails(
    sizes: number[],
    expected: Set<string>,
  ): Promise<number> {
    let removed = 0;

    try {
      const entries = await fs.readdir(this.config.storage.thumbnailDir, {
        withFileTypes: true,
      });
      const sizeSet = new Set(sizes.map((size) => String(size)));
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!/^\d+$/.test(entry.name)) {
          continue;
        }
        if (sizeSet.has(entry.name)) {
          continue;
        }
        const legacyDir = path.join(this.config.storage.thumbnailDir, entry.name);
        removed += await this.cleanupDir(legacyDir, expected);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
    }

    for (const size of sizes) {
      const sizeDir = path.join(this.config.storage.thumbnailDir, String(size));
      removed += await this.cleanupDir(sizeDir, expected);
    }

    return removed;
  }

  private async cleanupDir(
    dirPath: string,
    expected: Set<string>,
  ): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return 0;
        }
      }
      throw error;
    }

    let removed = 0;

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        removed += await this.cleanupDir(fullPath, expected);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!expected.has(normalizePathKey(fullPath))) {
        await fs.rm(fullPath, { force: true });
        removed += 1;
      }
    }

    try {
      const remaining = await fs.readdir(dirPath);
      if (remaining.length === 0) {
        await fs.rmdir(dirPath);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTEMPTY") {
          return removed;
        }
      }
    }

    return removed;
  }
}
