import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Event } from "../shared/types";

/** Collections are fixed even though their payloads are JSON. No SQL identifiers come from callers. */
export const COLLECTIONS = [
  "sessions",
  "messages",
  "tasks",
  "models",
  "projects",
  "goals",
  "memories",
  "approvals",
  "inbox",
  "settings",
  "tool_operations",
  "workspaces",
  "attachments",
] as const;
export type Collection = (typeof COLLECTIONS)[number];
export type StoredRecord = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};
export interface RecordMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export type RecordInput<T> = Omit<T, keyof RecordMetadata> &
  Partial<RecordMetadata>;

type Row = { document: string; revision: number };
export interface ListOptions<T> {
  /** Equality comparisons run in SQLite; nested keys are intentionally unsupported. */
  where?: Record<string, string | number | boolean | null>;
  predicate?: (record: T) => boolean;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
  orderBy?: "createdAt" | "updatedAt";
}

export interface AuditEvent extends Event {
  cursor: number;
  sessionId?: string;
}

export interface Occurrence {
  goalId: string;
  scheduledAt: string;
  taskId: string;
  createdAt: string;
}

export class MissingRecordError extends Error {
  constructor(collection: Collection, id: string) {
    super(`${collection} record ${id} does not exist`);
    this.name = "MissingRecordError";
  }
}

export class DuplicateRecordError extends Error {
  constructor(collection: Collection, id: string) {
    super(`${collection} record ${id} already exists`);
    this.name = "DuplicateRecordError";
  }
}

/** Synchronous operations keep multi-record state changes atomic on Node's event loop. */
export class Store {
  readonly path: string;
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;
  private closed = false;

  constructor(
    path = join(
      process.env.CIT_DATA_DIR ?? join(process.cwd(), ".cit-data"),
      "cit.sqlite",
    ),
  ) {
    this.path = path;
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    this.migrate();
  }

  private migrate(): void {
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (version > 1)
      throw new Error(
        `Database schema ${version} is newer than this application supports`,
      );
    if (version === 1) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE records (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          document TEXT NOT NULL CHECK(json_valid(document)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(collection, id)
        ) STRICT;
        CREATE INDEX records_collection_updated ON records(collection, updated_at DESC, id);
        CREATE INDEX records_collection_created ON records(collection, created_at, id);
        CREATE INDEX records_session ON records(collection, json_extract(document, '$.sessionId'));
        CREATE INDEX records_parent ON records(collection, json_extract(document, '$.parentId'));
        CREATE TABLE audit_events (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          task_id TEXT,
          session_id TEXT,
          data TEXT NOT NULL CHECK(json_valid(data)),
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX audit_events_task ON audit_events(task_id, cursor);
        CREATE TABLE schedule_occurrences (
          goal_id TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          task_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(goal_id, scheduled_at)
        ) STRICT;
        CREATE TABLE versioned_kv (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          content TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(namespace, key)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    });
  }

  /** Transactions must not await: all writes commit or roll back before returning. */
  transaction<T>(operation: () => T): T {
    const savepoint = `dots_${++this.savepointSequence}`;
    const nested = this.transactionDepth > 0;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = operation();
      if (result && typeof result === "object" && "then" in result) {
        throw new TypeError(
          "Store transactions must be synchronous; await outside the transaction",
        );
      }
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(
        nested
          ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`
          : "ROLLBACK",
      );
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  get<T = StoredRecord>(collection: Collection, id: string): T | undefined {
    this.checkCollection(collection);
    const row = this.db
      .prepare("SELECT document FROM records WHERE collection = ? AND id = ?")
      .get(collection, id) as Row | undefined;
    return row ? (JSON.parse(row.document) as T) : undefined;
  }

  require<T = StoredRecord>(collection: Collection, id: string): T {
    const record = this.get<T>(collection, id);
    if (!record) throw new MissingRecordError(collection, id);
    return record;
  }

  getVersioned<T = StoredRecord>(
    collection: Collection,
    id: string,
  ): { record: T; version: number } | undefined {
    this.checkCollection(collection);
    const row = this.db
      .prepare(
        "SELECT document, revision FROM records WHERE collection = ? AND id = ?",
      )
      .get(collection, id) as Row | undefined;
    return row
      ? { record: JSON.parse(row.document) as T, version: row.revision }
      : undefined;
  }

  list<T = StoredRecord>(
    collection: Collection,
    options: ListOptions<T> | ((record: T) => boolean) = {},
  ): T[] {
    this.checkCollection(collection);
    const config =
      typeof options === "function" ? { predicate: options } : options;
    const parameters: (string | number | null)[] = [collection];
    const conditions = ["collection = ?"];
    for (const [key, value] of Object.entries(config.where ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key))
        throw new Error(`Invalid record filter key: ${key}`);
      conditions.push("json_extract(document, ?) IS ?");
      parameters.push(
        `$.${key}`,
        typeof value === "boolean" ? Number(value) : value,
      );
    }
    const orderBy =
      config.orderBy === "createdAt" ? "created_at" : "updated_at";
    const order = config.order === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(
        `SELECT document FROM records WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} ${order}, rowid ${order}`,
      )
      .all(...parameters) as Row[];
    const parsed = rows.map((row) => JSON.parse(row.document) as T);
    const filtered = config.predicate
      ? parsed.filter(config.predicate)
      : parsed;
    const offset = Math.max(0, config.offset ?? 0);
    const limit =
      config.limit === undefined ? filtered.length : Math.max(0, config.limit);
    return filtered.slice(offset, offset + limit);
  }

  count(collection: Collection): number {
    this.checkCollection(collection);
    return Number(
      (
        this.db
          .prepare("SELECT count(*) AS count FROM records WHERE collection = ?")
          .get(collection) as { count: number }
      ).count,
    );
  }

  insert<T extends object>(
    collection: Collection,
    record: T | RecordInput<T>,
  ): T & RecordMetadata {
    this.checkCollection(collection);
    const now = new Date().toISOString();
    const input = record as T & Partial<RecordMetadata>;
    const id = input.id ?? randomUUID();
    this.checkId(id);
    const value = {
      ...input,
      id,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      version: 1,
    } as T & RecordMetadata;
    try {
      this.db
        .prepare(
          "INSERT INTO records(collection, id, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          collection,
          id,
          this.serialize(value),
          value.createdAt,
          value.updatedAt,
        );
    } catch (error) {
      if (this.get(collection, id))
        throw new DuplicateRecordError(collection, id);
      throw error;
    }
    return value;
  }

  /** Upsert an entire record. Use update for a patch or compareAndSet for conflict detection. */
  put<T extends { id: string }>(collection: Collection, record: T): T {
    return this.transaction(() => {
      if (this.get(collection, record.id))
        return this.update<T>(collection, record.id, () => record);
      return this.insert(collection, record);
    });
  }

  update<T extends object = StoredRecord>(
    collection: Collection,
    id: string,
    patch: Partial<T> | ((record: T) => T),
  ): T & RecordMetadata {
    this.checkCollection(collection);
    return this.transaction(() => {
      const { record: old, version } =
        this.getVersioned<T>(collection, id) ??
        (() => {
          throw new MissingRecordError(collection, id);
        })();
      const next =
        typeof patch === "function" ? patch(old) : { ...old, ...patch };
      if ((next as T & { id: string }).id !== id)
        throw new Error("Record IDs cannot be changed");
      const value = {
        ...next,
        id,
        createdAt: (old as T & RecordMetadata).createdAt,
        updatedAt: new Date().toISOString(),
        version: version + 1,
      } as T & RecordMetadata;
      this.db
        .prepare(
          "UPDATE records SET document = ?, revision = revision + 1, updated_at = ? WHERE collection = ? AND id = ?",
        )
        .run(this.serialize(value), value.updatedAt, collection, id);
      return value;
    });
  }

  compareAndSet<T extends { id: string }>(
    collection: Collection,
    id: string,
    expectedVersion: number | null,
    record: T,
  ): boolean {
    this.checkCollection(collection);
    if (record.id !== id) throw new Error("Record IDs cannot be changed");
    return this.transaction(() => {
      const old = this.getVersioned<T>(collection, id);
      if (expectedVersion === null) {
        if (old) return false;
        this.insert(collection, record);
        return true;
      }
      if (!old || old.version !== expectedVersion) return false;
      this.update(collection, id, () => record);
      return true;
    });
  }

  remove(collection: Collection, id: string): boolean {
    this.checkCollection(collection);
    return (
      this.db
        .prepare("DELETE FROM records WHERE collection = ? AND id = ?")
        .run(collection, id).changes > 0
    );
  }

  getSetting<T>(key: string, fallback: T): T;
  getSetting<T = unknown>(key: string): T | undefined;
  getSetting<T>(key: string, fallback?: T): T | undefined {
    const record = this.get<{ value: T }>("settings", key);
    return record ? record.value : fallback;
  }

  setSetting<T>(key: string, value: T): T {
    this.put("settings", { id: key, value });
    return value;
  }

  addMessage<T extends object>(
    sessionId: string,
    message: T | Omit<RecordInput<T>, "sessionId">,
  ): T & RecordMetadata & { sessionId: string } {
    return this.insert<T & { sessionId: string }>("messages", {
      ...message,
      sessionId,
    } as T & { sessionId: string });
  }

  messages<T = StoredRecord>(sessionId: string, limit?: number): T[] {
    return this.list<T>("messages", {
      where: { sessionId },
      orderBy: "createdAt",
      order: "asc",
      limit,
    });
  }

  event(
    type: string,
    data: unknown,
    taskId?: string,
    sessionId?: string,
  ): AuditEvent {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO audit_events(id, type, task_id, session_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        type,
        taskId ?? null,
        sessionId ?? null,
        this.serialize(data),
        createdAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      cursor: Number(result.lastInsertRowid),
      type,
      data,
      taskId,
      sessionId,
      createdAt,
    };
  }

  events(afterCursor = 0, limit = 500, taskId?: string): AuditEvent[] {
    const boundedLimit = Math.max(0, Math.min(1000, Math.trunc(limit)));
    const sql = `SELECT cursor, id, type, task_id, session_id, data, created_at FROM audit_events WHERE cursor > ?${taskId ? " AND task_id = ?" : ""} ORDER BY cursor ASC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(
        ...(taskId
          ? [afterCursor, taskId, boundedLimit]
          : [afterCursor, boundedLimit]),
      ) as {
      cursor: number;
      id: string;
      type: string;
      task_id: string | null;
      session_id: string | null;
      data: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      cursor: row.cursor,
      id: row.cursor,
      type: row.type,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
    }));
  }

  latestCursor(): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT coalesce(max(cursor), 0) AS cursor FROM audit_events",
          )
          .get() as { cursor: number }
      ).cursor,
    );
  }

  latestEventCursor(): number {
    return this.latestCursor();
  }

  /** Wrap this and task insertion in transaction() so the occurrence and its job commit together. */
  claimOccurrence(
    goalId: string,
    scheduledAt: string,
    taskId: string,
  ): boolean {
    const canonicalTime = new Date(scheduledAt).toISOString();
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO schedule_occurrences(goal_id, scheduled_at, task_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(goalId, canonicalTime, taskId, new Date().toISOString())
        .changes === 1
    );
  }

  occurrence(goalId: string, scheduledAt: string): Occurrence | undefined {
    const row = this.db
      .prepare(
        "SELECT goal_id, scheduled_at, task_id, created_at FROM schedule_occurrences WHERE goal_id = ? AND scheduled_at = ?",
      )
      .get(goalId, new Date(scheduledAt).toISOString()) as
      | {
          goal_id: string;
          scheduled_at: string;
          task_id: string;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          goalId: row.goal_id,
          scheduledAt: row.scheduled_at,
          taskId: row.task_id,
          createdAt: row.created_at,
        }
      : undefined;
  }

  getVersionedKV(
    namespace: string,
    key: string,
  ): { content: string; version: string } | null {
    const row = this.db
      .prepare(
        "SELECT content, revision FROM versioned_kv WHERE namespace = ? AND key = ?",
      )
      .get(namespace, key) as { content: string; revision: number } | undefined;
    return row ? { content: row.content, version: String(row.revision) } : null;
  }

  /** Returns null on conflict. Compatible with an Eve MemoryDocumentBackend adapter. */
  compareAndSetKV(
    namespace: string,
    key: string,
    content: string,
    expectedVersion: string | null,
  ): { content: string; version: string } | null {
    if (Buffer.byteLength(content, "utf8") > 1_048_576)
      throw new Error("Memory document exceeds 1 MiB");
    return this.transaction(() => {
      const current = this.getVersionedKV(namespace, key);
      if (expectedVersion === null) {
        if (current) return null;
        this.db
          .prepare(
            "INSERT INTO versioned_kv(namespace, key, content, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
          )
          .run(namespace, key, content, new Date().toISOString());
        return { content, version: "1" };
      }
      if (!current || current.version !== expectedVersion) return null;
      const revision = Number(current.version) + 1;
      this.db
        .prepare(
          "UPDATE versioned_kv SET content = ?, revision = ?, updated_at = ? WHERE namespace = ? AND key = ?",
        )
        .run(content, revision, new Date().toISOString(), namespace, key);
      return { content, version: String(revision) };
    });
  }

  deleteKV(namespace: string, key: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM versioned_kv WHERE namespace = ? AND key = ?")
        .run(namespace, key).changes > 0
    );
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private checkCollection(collection: Collection): void {
    if (!(COLLECTIONS as readonly string[]).includes(collection))
      throw new Error(`Unknown collection: ${collection}`);
  }

  private checkId(id: string): void {
    if (!id || Buffer.byteLength(id, "utf8") > 2048)
      throw new Error("Record id must contain 1–2048 UTF-8 bytes");
  }

  private serialize(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined)
      throw new Error("Record content must be JSON serializable");
    if (Buffer.byteLength(json, "utf8") > 8_388_608)
      throw new Error("Record exceeds 8 MiB");
    return json;
  }
}
