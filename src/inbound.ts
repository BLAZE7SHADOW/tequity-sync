// Inbound path, design §5: webhook -> validate -> ONE transaction
// (inbox dedupe, resolve record, merge per field, history, sf_modstamp) -> 200.
// This module never writes the outbox (loop layer a, §9).
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { merge, type FieldEvent } from './merge.ts';
import { verify } from './signing.ts';
import { fieldKey, type DB, type Store } from './store.ts';

export const FIELDS: Record<string, string[]> = {
  Account: ['name', 'status', 'owner'],
  Contact: ['full_name', 'phone', 'email', 'city', 'owner', 'customer'],
};

export interface WebhookBody {
  eventId: string; recordId: string; objectType: string; occurredAt: string; changedBy: string;
  changedFields: Record<string, unknown>; systemModstamp?: string; portalId?: string | null;
}

export function validate(b: any): b is WebhookBody {
  return b && typeof b.eventId === 'string' && typeof b.recordId === 'string' && b.objectType in FIELDS
    && typeof b.occurredAt === 'string' && !Number.isNaN(Date.parse(b.occurredAt))
    && typeof b.changedBy === 'string' && b.changedFields && typeof b.changedFields === 'object';
}

/** Apply events for one record through merge(); appends one history row per field, always. */
export function applyFieldEvents(db: DB, portalId: string, events: { field: string; ev: FieldEvent }[]) {
  return events.map(({ field, ev }) => {
    const k = fieldKey(portalId, field);
    const { state, outcome } = merge(db.fields[k], ev);
    db.fields[k] = state;
    db.history.push({ portalId, field, value: ev.value, stampTime: ev.stampTime, eventId: ev.eventId, actor: ev.actor, source: ev.source, outcome, recordedAt: Date.now() });
    return { field, outcome };
  });
}

export async function applyWebhook(store: Store, b: WebhookBody) {
  const bodyHash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
  return store.tx((db) => {
    // 4a duplicate rule: inbox PK = eventId
    const seen = db.inbox[b.eventId];
    if (seen) {
      if (seen.bodyHash !== bodyHash) console.warn(`inbox_payload_mismatch ${b.eventId}`);
      return { status: 'duplicate' as const, outcomes: [] };
    }
    db.inbox[b.eventId] = { receivedAt: Date.now(), bodyHash };
    // 4b resolve record: by sf_id, then by portalId (echo of our create), else a Salesforce-side create
    let rec = Object.values(db.records).find((r) => r.sfId === b.recordId);
    if (!rec && b.portalId && db.records[b.portalId]) { rec = db.records[b.portalId]; rec.sfId = b.recordId; }
    if (!rec) {
      const portalId = randomUUID();
      rec = db.records[portalId] = { portalId, sfId: b.recordId, objectType: b.objectType as 'Account' | 'Contact', sfModstamp: null, lastSendAckAt: null };
    }
    // 3 map fields: in-scope only, others ignored
    const allowed = FIELDS[b.objectType];
    const stampTime = Date.parse(b.occurredAt);
    const events = Object.entries(b.changedFields).filter(([f]) => allowed.includes(f))
      .map(([field, value]) => ({ field, ev: { value, stampTime, eventId: b.eventId, actor: b.changedBy, source: 'salesforce' as const } }));
    // 4d merge per field
    const outcomes = applyFieldEvents(db, rec.portalId, events);
    // 4e sf_modstamp = GREATEST(...)
    if (b.systemModstamp) rec.sfModstamp = Math.max(rec.sfModstamp ?? 0, Date.parse(b.systemModstamp));
    return { status: 'applied' as const, portalId: rec.portalId, outcomes };
  });
}

/** Apply a Salesforce read (412 re-read) as a snapshot: only fields that differ from sf_value (§4 step 3). */
export function applySnapshot(db: DB, portalId: string, sfRow: Record<string, unknown>) {
  const rec = db.records[portalId];
  const M = Date.parse(String(sfRow.SystemModstamp));
  const actor = String(sfRow.LastModifiedById ?? 'unknown');
  const events = FIELDS[rec.objectType]
    .filter((f) => f in sfRow && JSON.stringify(sfRow[f]) !== JSON.stringify(db.fields[fieldKey(portalId, f)]?.sfValue))
    .map((field) => ({ field, ev: { value: sfRow[field], stampTime: M, eventId: `snap_${rec.sfId}_${M}`, actor, source: 'snapshot' as const } }));
  rec.sfModstamp = Math.max(rec.sfModstamp ?? 0, M);
  return applyFieldEvents(db, portalId, events);
}

/** Webhook endpoint, interface (A): 401 bad signature, 400 invalid, 200 applied|duplicate, 503 store error. */
export function startWebhookEndpoint(store: Store, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const reply = (s: number, body: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/webhooks/salesforce') return reply(404, {});
    if (!verify(raw, req.headers['x-signature'] as string, req.headers['x-timestamp'] as string)) return reply(401, { error: 'signature' });
    let body: unknown; try { body = JSON.parse(raw); } catch { return reply(400, { error: 'json' }); }
    if (!validate(body)) return reply(400, { error: 'schema' });
    try { reply(200, await applyWebhook(store, body)); } catch (e) { reply(503, { error: String(e) }); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${p}/webhooks/salesforce`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(() => r())); } });
  }));
}
