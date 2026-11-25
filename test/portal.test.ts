import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { FileStore } from '../src/store.ts';
import { portalCreate, portalSave } from '../src/portal.ts';

test('§6A save writes the outbox in the same tx; stale base -> 409, only the winner is queued', async () => {
  const s = new FileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'db.json'));
  const pid = await portalCreate(s, 'cs@client.example', 'Contact', { city: 'Delhi' });
  const base = await s.read((db) => db.fields[`${pid}|city`].stampEventId);
  const a = await portalSave(s, 'finance.a@client.example', { portalId: pid, changedFields: { city: 'Noida' }, baseStamps: { city: base } });
  const b = await portalSave(s, 'finance.b@client.example', { portalId: pid, changedFields: { city: 'Pune' }, baseStamps: { city: base } });
  assert.equal(a.status, 200); assert.equal(b.status, 409);
  const st = await s.read((db) => ({ v: db.fields[`${pid}|city`].value, pending: db.outbox.filter((o) => o.status === 'pending').length, rej: db.history.filter((h) => h.outcome === 'rejected_409').length }));
  assert.deepEqual(st, { v: 'Noida', pending: 1, rej: 1 });
  const bad = await portalSave(s, 'x@client.example', { portalId: pid, changedFields: { city: 'X' }, baseStamps: {}, editedBy: 'someone.else@client.example' });
  assert.equal(bad.status, 400);
});
