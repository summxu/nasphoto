import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config";

export type SqliteDatabase = import("better-sqlite3").Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  dir_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  ctime_ms INTEGER NOT NULL,
  exif_time_ms INTEGER,
  taken_time_ms INTEGER,
  media_create_time_ms INTEGER,
  primary_time_ms INTEGER,
  thumbnail_path TEXT,
  scanned_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS media_items_unique
  ON media_items(root, rel_path);
CREATE INDEX IF NOT EXISTS media_items_dir_idx
  ON media_items(root, dir_path);
CREATE INDEX IF NOT EXISTS media_items_primary_time_idx
  ON media_items(primary_time_ms);
CREATE INDEX IF NOT EXISTS media_items_taken_time_idx
  ON media_items(taken_time_ms);
CREATE INDEX IF NOT EXISTS media_items_type_idx
  ON media_items(media_type);
`;

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

export const getDatabasePath = (config: AppConfig): string => {
  return path.resolve(config.storage.cacheDir, "nasphoto.sqlite");
};

export const openDatabase = (config: AppConfig): SqliteDatabase => {
  const dbPath = getDatabasePath(config);
  ensureDir(path.dirname(dbPath));

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  return db;
};
