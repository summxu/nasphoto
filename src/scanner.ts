import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import exifr from "exifr";
import cron, { ScheduledTask } from "node-cron";
import type { AppConfig } from "./config";
import type { SqliteDatabase } from "./db";
import type { Logger } from "./logger";
import { buildThumbnailPath } from "./thumbnails";

type MediaType = "image" | "video";
type ScanReason = "manual" | "cron" | "startup";
type SqliteStatement = import("better-sqlite3").Statement<unknown[]>;

interface MediaRow {
  root: string;
  rel_path: string;
  dir_path: string;
  file_name: string;
  extension: string;
  media_type: MediaType;
  size_bytes: number;
  mtime_ms: number;
  ctime_ms: number;
  exif_time_ms: number | null;
  taken_time_ms: number | null;
  media_create_time_ms: number | null;
  primary_time_ms: number | null;
  thumbnail_path: string | null;
  scanned_at: number;
}

interface ScanCounts {
  filesSeen: number;
  mediaFiles: number;
  inserted: number;
  updated: number;
  skipped: number;
  removed: number;
  errors: number;
}

interface ScanRootSummary extends ScanCounts {
  root: string;
}

export interface ScanSummary {
  runId: string;
  reason: ScanReason;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counts: ScanCounts;
  roots: ScanRootSummary[];
  errorSamples: string[];
}

export interface ScanStatus {
  running: boolean;
  current?: {
    runId: string;
    reason: ScanReason;
    startedAt: string;
  };
  last?: ScanSummary;
}

export interface ScanTriggerResult {
  started: boolean;
  runId?: string;
  status: ScanStatus;
}

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const buildDirPath = (relPosix: string): string => {
  const dir = path.posix.dirname(relPosix);
  return dir === "." ? "/" : `/${dir}`;
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
    const normalized = value.replace(
      /^(\d{4}):(\d{2}):(\d{2})/,
      "$1-$2-$3",
    );
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

class BatchWriter<T> {
  private buffer: T[] = [];
  private writePromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly batchSize: number,
    private readonly writeBatch: (items: T[]) => void,
  ) {}

  async enqueue(item: T): Promise<void> {
    this.buffer.push(item);
    if (this.buffer.length >= this.batchSize) {
      await this.flushInternal();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      await this.flushInternal();
    }
    await this.writePromise;
  }

  private async flushInternal(): Promise<void> {
    const batch = this.buffer.splice(0, this.buffer.length);
    this.writePromise = this.writePromise.then(() => {
      this.writeBatch(batch);
    });
    await this.writePromise;
  }
}

export class MediaScanner {
  private readonly imageExt: Set<string>;
  private readonly videoExt: Set<string>;
  private readonly ignorePatterns: string[];
  private readonly roots: string[];
  private readonly statements: {
    selectExisting: SqliteStatement;
    touch: SqliteStatement;
    upsert: SqliteStatement;
    deleteRoot: SqliteStatement;
    deleteStale: SqliteStatement;
  };
  private running = false;
  private current?: ScanStatus["current"];
  private last?: ScanSummary;
  private scheduledTask?: ScheduledTask;
  private onComplete?: (summary: ScanSummary) => void;

  constructor(
    private readonly config: AppConfig,
    private readonly db: SqliteDatabase,
    private readonly logger: Logger,
  ) {
    this.imageExt = new Set(
      config.media.supportedImageExt.map((ext) => ext.toLowerCase()),
    );
    this.videoExt = new Set(
      config.media.supportedVideoExt.map((ext) => ext.toLowerCase()),
    );
    this.ignorePatterns = config.scan.ignorePatterns.map((item) =>
      item.toLowerCase(),
    );
    this.roots = config.storage.libraryRoots.map((root) => path.resolve(root));

    this.statements = {
      selectExisting: db.prepare(
        "SELECT size_bytes, mtime_ms, ctime_ms FROM media_items WHERE root = ? AND rel_path = ?",
      ),
      touch: db.prepare(
        "UPDATE media_items SET scanned_at = ? WHERE root = ? AND rel_path = ?",
      ),
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
      deleteRoot: db.prepare("DELETE FROM media_items WHERE root = ?"),
      deleteStale: db.prepare(
        "DELETE FROM media_items WHERE root = ? AND scanned_at < ?",
      ),
    };
  }

  schedule(): void {
    if (!this.config.scan.cron) {
      return;
    }
    if (!cron.validate(this.config.scan.cron)) {
      this.logger.warn(
        `[scan] invalid cron expression: ${this.config.scan.cron}`,
      );
      return;
    }
    this.scheduledTask = cron.schedule(this.config.scan.cron, () => {
      this.trigger("cron");
    });
    this.logger.info(`[scan] scheduled cron ${this.config.scan.cron}`);
  }

  trigger(reason: ScanReason = "manual"): ScanTriggerResult {
    if (this.running) {
      return {
        started: false,
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
    this.logger.info("[scan] started", { runId, reason });

    this.scan(runId, reason)
      .then((summary) => {
        this.last = summary;
        this.onComplete?.(summary);
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
          durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
          counts: {
            filesSeen: 0,
            mediaFiles: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            removed: 0,
            errors: 1,
          },
          roots: [],
          errorSamples: [message],
        };
        if (this.last) {
          this.onComplete?.(this.last);
        }
        this.logger.error(`[scan] failed: ${message}`);
      })
      .finally(() => {
        this.running = false;
        this.current = undefined;
      });

    return {
      started: true,
      runId,
      status: this.getStatus(),
    };
  }

  getStatus(): ScanStatus {
    return {
      running: this.running,
      current: this.current,
      last: this.last,
    };
  }

  setOnComplete(handler: (summary: ScanSummary) => void): void {
    this.onComplete = handler;
  }

  private async scan(runId: string, reason: ScanReason): Promise<ScanSummary> {
    const startedAt = new Date();
    const scanStamp = startedAt.getTime();
    const totals: ScanCounts = {
      filesSeen: 0,
      mediaFiles: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      errors: 0,
    };
    const errorSamples: string[] = [];
    const roots: ScanRootSummary[] = [];

    if (this.roots.length === 0) {
      const message = "[scan] no library roots configured";
      this.logger.warn(message);
      errorSamples.push(message);
    }

    for (const root of this.roots) {
      const summary = await this.scanRoot(root, scanStamp, totals, errorSamples);
      roots.push(summary);
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    this.logger.info(
      `[scan] done in ${durationMs}ms, mediaFiles=${totals.mediaFiles}, errors=${totals.errors}`,
    );

    return {
      runId,
      reason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      counts: totals,
      roots,
      errorSamples,
    };
  }

  private async scanRoot(
    root: string,
    scanStamp: number,
    totals: ScanCounts,
    errorSamples: string[],
  ): Promise<ScanRootSummary> {
    const summary: ScanRootSummary = {
      root,
      filesSeen: 0,
      mediaFiles: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      errors: 0,
    };

    const recordError = (message: string) => {
      summary.errors += 1;
      totals.errors += 1;
      if (errorSamples.length < 10) {
        errorSamples.push(message);
      }
    };

    try {
      const stats = await fs.stat(root);
      if (!stats.isDirectory()) {
        recordError(`[scan] root is not a directory: ${root}`);
        return summary;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(`[scan] cannot access root ${root}: ${message}`);
      return summary;
    }

    if (!this.config.scan.incremental) {
      this.statements.deleteRoot.run(root);
    }

    const batchInsert = this.db.transaction((rows: MediaRow[]) => {
      for (const row of rows) {
        this.statements.upsert.run(row);
      }
    });

    const writer = new BatchWriter<MediaRow>(
      this.config.scan.batchSize,
      batchInsert,
    );
    const pool = new TaskPool(this.config.scan.maxConcurrency);

    const stack: string[] = [root];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordError(`[scan] cannot read directory ${currentDir}: ${message}`);
        continue;
      }

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        summary.filesSeen += 1;
        totals.filesSeen += 1;

        const extension = path.extname(entry.name).toLowerCase();
        const mediaType = this.getMediaType(extension);
        if (!mediaType) {
          continue;
        }
        summary.mediaFiles += 1;
        totals.mediaFiles += 1;

        await pool.run(async () => {
          try {
            await this.processFile({
              root,
              fullPath,
              extension,
              mediaType,
              scanStamp,
              summary,
              totals,
              writer,
              recordError,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordError(`[scan] processing failed ${fullPath}: ${message}`);
          }
        });
      }
    }

    await pool.flush();
    await writer.flush();

    if (this.config.scan.incremental) {
      const result = this.statements.deleteStale.run(root, scanStamp);
      summary.removed += result.changes;
      totals.removed += result.changes;
    }

    return summary;
  }

  private async processFile(params: {
    root: string;
    fullPath: string;
    extension: string;
    mediaType: MediaType;
    scanStamp: number;
    summary: ScanCounts;
    totals: ScanCounts;
    writer: BatchWriter<MediaRow>;
    recordError: (message: string) => void;
  }): Promise<void> {
    const {
      root,
      fullPath,
      extension,
      mediaType,
      scanStamp,
      summary,
      totals,
      writer,
      recordError,
    } = params;

    let stats: Stats;
    try {
      stats = await fs.stat(fullPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(`[scan] cannot stat ${fullPath}: ${message}`);
      return;
    }

    const relPath = toPosixPath(path.relative(root, fullPath));
    if (relPath.startsWith("..")) {
      return;
    }

    const sizeBytes = stats.size;
    const mtimeMs = Math.floor(stats.mtimeMs);
    const ctimeMs = Math.floor(
      stats.birthtimeMs && stats.birthtimeMs > 0
        ? stats.birthtimeMs
        : stats.ctimeMs || stats.mtimeMs,
    );

    let hadExisting = false;
    if (this.config.scan.incremental) {
      const existing = this.statements.selectExisting.get(root, relPath) as
        | { size_bytes: number; mtime_ms: number; ctime_ms: number }
        | undefined;
      if (
        existing &&
        existing.size_bytes === sizeBytes &&
        existing.mtime_ms === mtimeMs &&
        existing.ctime_ms === ctimeMs
      ) {
        this.statements.touch.run(scanStamp, root, relPath);
        summary.skipped += 1;
        totals.skipped += 1;
        return;
      }
      hadExisting = Boolean(existing);
    }

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
        const message = error instanceof Error ? error.message : String(error);
        recordError(`[scan] exif parse failed ${fullPath}: ${message}`);
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
    const primaryTimeMs = this.config.media.preferExifTime
      ? exifOriginal?.getTime() ?? mediaCreateMs ?? mtimeMs
      : mediaCreateMs ?? exifOriginal?.getTime() ?? mtimeMs;

    const dirPath = buildDirPath(relPath);
    const fileName = path.basename(fullPath);
    const thumbnailPath = buildThumbnailPath(this.config, relPath);

    const row: MediaRow = {
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
      scanned_at: scanStamp,
    };

    try {
      await writer.enqueue(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(`[scan] db write failed ${fullPath}: ${message}`);
      return;
    }

    if (this.config.scan.incremental && hadExisting) {
      summary.updated += 1;
      totals.updated += 1;
    } else {
      summary.inserted += 1;
      totals.inserted += 1;
    }
  }

  private shouldIgnore(name: string): boolean {
    if (this.config.scan.ignoreHidden && name.startsWith(".")) {
      return true;
    }
    if (this.ignorePatterns.length === 0) {
      return false;
    }
    const lowered = name.toLowerCase();
    return this.ignorePatterns.some((pattern) => lowered.includes(pattern));
  }

  private getMediaType(extension: string): MediaType | null {
    if (this.imageExt.has(extension)) {
      return "image";
    }
    if (this.videoExt.has(extension)) {
      return "video";
    }
    return null;
  }
}
