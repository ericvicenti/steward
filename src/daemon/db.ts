import { Database } from "bun:sqlite";
import { join } from "path";
import { STEWARD_HOME } from "./config";

export type RepoRow = {
  id: number;
  path: string;
  name: string;
  head_branch: string | null;
  dirty_files: number;
  untracked_files: number;
  stashes: number;
  ahead: number;
  behind: number;
  remotes: string; // JSON array of {name, url}
  last_commit_at: number | null;
  last_commit_subject: string | null;
  junk_bytes: number;
  size_bytes: number;
  risk: "safe" | "attention" | "at-risk";
  risk_reasons: string; // JSON array of strings
  scanned_at: number;
};

export function openDb(): Database {
  const db = new Database(join(STEWARD_HOME, "steward.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      head_branch TEXT,
      dirty_files INTEGER NOT NULL DEFAULT 0,
      untracked_files INTEGER NOT NULL DEFAULT 0,
      stashes INTEGER NOT NULL DEFAULT 0,
      ahead INTEGER NOT NULL DEFAULT 0,
      behind INTEGER NOT NULL DEFAULT 0,
      remotes TEXT NOT NULL DEFAULT '[]',
      last_commit_at INTEGER,
      last_commit_subject TEXT,
      junk_bytes INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      risk TEXT NOT NULL DEFAULT 'attention',
      risk_reasons TEXT NOT NULL DEFAULT '[]',
      scanned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      repos_found INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}
