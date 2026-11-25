// Store interface. The design (§4) uses Postgres. The demo swaps in a
// file-backed store: each tx() is applied to a copy of the whole state and
// written atomically (temp file + rename), so a crash leaves either the old or
// the new file, never half a transaction. tx() calls are serialised, which
// stands in for the per-record FOR UPDATE lock (single process only).
import fs from 'node:fs';
import path from 'node:path';
import type { FieldState, Outcome, Source } from './merge.ts';

export interface RecordRow { portalId: string; sfId: string | null; objectType: 'Account' | 'Contact'; sfModstamp: number | null; lastSendAckAt: number | null }
export interface HistoryRow { portalId: string; field: string; value: unknown; stampTime: number; eventId: string; actor: string; source: Source; outcome: Outcome | 'rejected_409'; recordedAt: number }
export type OutboxStatus = 'pending' | 'in_flight' | 'done' | 'dead';
export interface OutboxRow { id: number; portalId: string; status: OutboxStatus; attempts: number; consecutive412: number; nextAttemptAt: number; leaseUntil: number | null; lastError: string | null; createdAt: number; lastSaveAt: number }

export interface DB {
  records: Record<string, RecordRow>;
  fields: Record<string, FieldState>;      // key `${portalId}|${field}`
  history: HistoryRow[];                   // append-only
  inbox: Record<string, { receivedAt: number; bodyHash: string }>;
  outbox: OutboxRow[];
  nextOutboxId: number;
}

export interface Store {
  tx<T>(fn: (db: DB) => T): Promise<T>;
  read<T>(fn: (db: DB) => T): Promise<T>;
}

export const fieldKey = (portalId: string, field: string) => `${portalId}|${field}`;
const empty = (): DB => ({ records: {}, fields: {}, history: [], inbox: {}, outbox: [], nextOutboxId: 1 });

export class FileStore implements Store {
  private db: DB;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as DB) : empty();
  }
  tx<T>(fn: (db: DB) => T): Promise<T> {
    const run = this.chain.then(() => {
      const draft = structuredClone(this.db);
      const out = fn(draft);                         // throws -> nothing is written (rollback)
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(draft));
      fs.renameSync(tmp, this.file);                 // atomic commit
      this.db = draft;
      return out;
    });
    this.chain = run.catch(() => {});
    return run;
  }
  read<T>(fn: (db: DB) => T): Promise<T> { return this.chain.then(() => fn(structuredClone(this.db))); }
}
