// Portal API save/create, design §6 A0 and A. The edit and its outbox row
// commit in ONE transaction. Time = server clock at commit (stands in for
// Postgres clock_timestamp()); actor = session user, never the payload.
import { randomUUID } from 'node:crypto';
import { FIELDS, applyFieldEvents } from './inbound.ts';
import { fieldKey, type DB, type Store } from './store.ts';

export type SaveResult =
  | { status: 200; stamps: Record<string, string> }
  | { status: 409; conflicts: { field: string; currentValue: unknown; changedBy: string; changedAt: string }[] }
  | { status: 400; error: string };

function upsertOutbox(db: DB, portalId: string, now: number): void {
  const pending = db.outbox.find((o) => o.portalId === portalId && o.status === 'pending');
  if (pending) { pending.lastSaveAt = now; return; }  // one pending row per record
  db.outbox.push({ id: db.nextOutboxId++, portalId, status: 'pending', attempts: 0, consecutive412: 0, nextAttemptAt: now, leaseUntil: null, lastError: null, createdAt: now, lastSaveAt: now });
}

export function portalSave(store: Store, sessionUser: string,
  req: { portalId: string; changedFields: Record<string, unknown>; baseStamps: Record<string, string | null>; editedBy?: string }): Promise<SaveResult> {
  if (req.editedBy && req.editedBy !== sessionUser) return Promise.resolve({ status: 400, error: 'editedBy does not match session' });
  return store.tx((db): SaveResult => {
    const rec = db.records[req.portalId];
    if (!rec) return { status: 400, error: 'unknown record' };
    const fields = Object.keys(req.changedFields);
    if (fields.some((f) => !FIELDS[rec.objectType].includes(f))) return { status: 400, error: 'field out of scope' };
    const now = Date.now();
    // Optimistic check: whole save rejected if any field moved since the form loaded it.
    const conflicts = fields.flatMap((f) => {
      const cur = db.fields[fieldKey(req.portalId, f)];
      const base = req.baseStamps[f] ?? null;
      if ((cur?.stampEventId ?? null) === base) return [];
      return [{ field: f, currentValue: cur?.value, changedBy: cur?.actor ?? '', changedAt: new Date(cur?.changedAt ?? 0).toISOString() }];
    });
    if (conflicts.length) {
      for (const f of fields) db.history.push({ portalId: req.portalId, field: f, value: req.changedFields[f], stampTime: now, eventId: `p_rejected_${randomUUID()}`, actor: sessionUser, source: 'portal', outcome: 'rejected_409', recordedAt: now });
      return { status: 409, conflicts };
    }
    const eventId = `p_${randomUUID()}`;
    applyFieldEvents(db, req.portalId, fields.map((field) => ({ field, ev: { value: req.changedFields[field], stampTime: now, eventId, actor: sessionUser, source: 'portal' as const } })));
    upsertOutbox(db, req.portalId, now);
    return { status: 200, stamps: Object.fromEntries(fields.map((f) => [f, eventId])) };
  });
}

export function portalCreate(store: Store, sessionUser: string, objectType: 'Account' | 'Contact', fields: Record<string, unknown>): Promise<string> {
  return store.tx((db) => {
    const portalId = randomUUID(), now = Date.now(), eventId = `p_${randomUUID()}`;
    db.records[portalId] = { portalId, sfId: null, objectType, sfModstamp: null, lastSendAckAt: null };
    applyFieldEvents(db, portalId, Object.entries(fields).map(([field, value]) => ({ field, ev: { value, stampTime: now, eventId, actor: sessionUser, source: 'portal' as const } })));
    upsertOutbox(db, portalId, now);
    return portalId;
  });
}
