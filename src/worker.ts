// Sync worker, design §6B. Single leader (the demo runs one process; the
// advisory lock is not modelled). Every Salesforce call goes through the limiter.
import { FIELDS, applySnapshot } from './inbound.ts';
import { same } from './merge.ts';
import { fieldKey, type DB, type OutboxRow, type Store } from './store.ts';
import { TokenBucket } from './limiter.ts';

export interface WorkerOpts {
  store: Store; sfBaseUrl: string; limiter: TokenBucket;
  leaseMs?: number; slots?: number; tickMs?: number; dirtySweepMs?: number; log?: (m: string) => void;
}

export const backoffMs = (attempts: number, rand = Math.random()) =>
  Math.min(300, 2 ** Math.max(0, attempts - 1)) * 1000 * (0.5 + 0.5 * rand); // 1, 2, 4, 8 … s, jittered

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<void>>();
  private lastDirtySweep = 0;
  private busy = false;
  constructor(private o: WorkerOpts) {}

  start(): void { this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 200); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await Promise.all(this.inFlight); }

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const now = Date.now();
      const sweepDirty = now - this.lastDirtySweep >= (this.o.dirtySweepMs ?? 60_000);
      if (sweepDirty) this.lastDirtySweep = now;
      const free = (this.o.slots ?? 32) - this.inFlight.size;
      const claimed = await this.o.store.tx((db) => {
        // Lease sweep: crashed in_flight rows return to pending.
        for (const r of db.outbox) if (r.status === 'in_flight' && (r.leaseUntil ?? 0) < now) { r.status = 'pending'; r.leaseUntil = null; }
        if (sweepDirty) dirtySweep(db, now);
        const busyRecords = new Set(db.outbox.filter((r) => r.status === 'in_flight').map((r) => r.portalId));
        const ready = db.outbox.filter((r) => r.status === 'pending' && r.nextAttemptAt <= now && !busyRecords.has(r.portalId))
          .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt).slice(0, Math.max(0, free));
        for (const r of ready) { r.status = 'in_flight'; r.leaseUntil = now + (this.o.leaseMs ?? 15_000); r.attempts++; }
        return ready.map((r) => ({ ...r }));
      });
      for (const row of claimed) {
        const p = this.process(row).catch((e) => this.o.log?.(`worker error ${e}`)).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
    } finally { this.busy = false; }
  }

  private async process(row: OutboxRow): Promise<void> {
    const { store, sfBaseUrl, limiter } = this.o;
    const plan = await store.read((db) => {
      const rec = db.records[row.portalId];
      const dirty = FIELDS[rec.objectType].filter((f) => { const s = db.fields[fieldKey(rec.portalId, f)]; return s && !same(s.value, s.sfValue); });
      const all = FIELDS[rec.objectType].filter((f) => db.fields[fieldKey(rec.portalId, f)]);
      const send = rec.sfId ? dirty : all;                      // create = upsert with all fields
      return { rec, body: Object.fromEntries(send.map((f) => [f, db.fields[fieldKey(rec.portalId, f)].value])), dirty };
    });
    if (plan.dirty.length === 0) { await this.finish(row.id, (r) => { r.status = 'done'; }); return; } // nothing Salesforce lacks
    const { rec, body } = plan;
    const url = rec.sfId ? `${sfBaseUrl}/sobjects/${rec.objectType}/${rec.sfId}` : `${sfBaseUrl}/sobjects/${rec.objectType}/Portal_Id__c/${rec.portalId}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (rec.sfId && rec.sfModstamp) headers['if-unmodified-since'] = new Date(rec.sfModstamp).toUTCString();

    await limiter.take();
    const tSend = Date.now();
    let res: Response;
    try { res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); }
    catch (e: any) { this.o.log?.(`  PATCH ${rec.objectType} failed: ${e.cause?.code ?? e.name}; retry in backoff`); return this.retry(row.id, `network ${e.cause?.code ?? e.name}`, backoffMs(row.attempts)); }

    if (res.ok) {
      const created = res.status === 201 || res.status === 200 ? await res.json().catch(() => null) : null;
      this.o.log?.(`  PATCH ${rec.objectType} ${Object.keys(body).join(',')} -> ${res.status}`);
      await this.finish(row.id, (r, db) => {
        const rr = db.records[row.portalId];
        if (created?.id && !rr.sfId) rr.sfId = created.id;
        for (const [f, v] of Object.entries(body)) {             // never clobber a newer Salesforce fact
          const s = db.fields[fieldKey(row.portalId, f)];
          if (s.sfStamp === null || s.sfStamp < tSend) { s.sfValue = v; s.sfStamp = tSend; }
        }
        rr.lastSendAckAt = Date.now();
        r.status = 'done'; r.consecutive412 = 0; r.lastError = null;
      });
      return;
    }
    if (res.status === 412) {
      this.o.log?.(`  PATCH -> 412, re-reading`);
      await limiter.take();
      let read: Response;
      try { read = await fetch(`${sfBaseUrl}/sobjects/${rec.objectType}/${rec.sfId}`, { signal: AbortSignal.timeout(10_000) }); }
      catch { return this.retry(row.id, 'network on re-read', backoffMs(row.attempts)); }
      const sfRow = (await read.json()) as Record<string, unknown>;
      await this.finish(row.id, (r, db) => {
        const outcomes = applySnapshot(db, row.portalId, sfRow);
        r.consecutive412++;
        if (r.consecutive412 >= 5) { r.status = 'dead'; r.lastError = '5 consecutive 412'; return; }
        const unprovable = outcomes.some((o) => o.outcome === 'unprovable');
        returnToPending(db, r, Date.now() + (unprovable ? 15_000 : 0), '412');   // wait for the exact-time delta
      });
      return;
    }
    if (res.status === 429 || (res.status === 503 && res.headers.get('retry-after'))) {
      const ra = Number(res.headers.get('retry-after') ?? '1') * 1000;
      limiter.throttled(ra);
      this.o.log?.(`  PATCH -> ${res.status}, Retry-After ${ra} ms, rate now ${limiter.rate}/s; work kept`);
      return this.retry(row.id, `${res.status}`, ra);
    }
    if (res.status >= 500) return this.retry(row.id, `${res.status}`, backoffMs(row.attempts));
    await this.finish(row.id, (r) => { r.status = 'dead'; r.lastError = `${res.status}`; });  // other 4xx: page
  }

  private retry(id: number, err: string, delayMs: number): Promise<void> {
    return this.finish(id, (r, db) => returnToPending(db, r, Date.now() + delayMs, err));
  }
  private finish(id: number, fn: (r: OutboxRow, db: DB) => void): Promise<void> {
    return this.o.store.tx((db) => { const r = db.outbox.find((x) => x.id === id)!; r.leaseUntil = null; fn(r, db); });
  }
}

/** Return an in-flight row to pending. If a save created a pending row meanwhile, merge into it (§6B). */
function returnToPending(db: DB, r: OutboxRow, nextAttemptAt: number, err: string): void {
  const other = db.outbox.find((o) => o.portalId === r.portalId && o.status === 'pending' && o.id !== r.id);
  r.lastError = err;
  if (!other) { r.status = 'pending'; r.nextAttemptAt = nextAttemptAt; return; }
  r.status = 'done';
  other.attempts = Math.max(other.attempts, r.attempts);
  other.nextAttemptAt = Math.max(other.nextAttemptAt, nextAttemptAt);
  other.createdAt = Math.min(other.createdAt, r.createdAt);
}

/** Invariant: value != sf_value implies a pending or in-flight outbox row (§6B dirty sweep). */
function dirtySweep(db: DB, now: number): void {
  const queued = new Set(db.outbox.filter((o) => o.status === 'pending' || o.status === 'in_flight').map((o) => o.portalId));
  for (const [k, s] of Object.entries(db.fields)) {
    const pid = k.split('|')[0];
    if (!queued.has(pid) && db.records[pid]?.sfId && !same(s.value, s.sfValue)) {
      db.outbox.push({ id: db.nextOutboxId++, portalId: pid, status: 'pending', attempts: 0, consecutive412: 0, nextAttemptAt: now, leaseUntil: null, lastError: 'dirty sweep', createdAt: now, lastSaveAt: now });
      queued.add(pid);
    }
  }
}
