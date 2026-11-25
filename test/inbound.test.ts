import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { FileStore } from '../src/store.ts';
import { applyWebhook } from '../src/inbound.ts';

const tmpStore = () => new FileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'db.json'));
const hook = (eventId: string, occurredAt: string, phone: string, by = 'sales.user@client.example') =>
  ({ eventId, recordId: '0031A00000Abc', objectType: 'Contact', occurredAt, changedBy: by, changedFields: { phone } });

test('§8 duplicate: second delivery of evt_1001 writes nothing', async () => {
  const s = tmpStore();
  const a = await applyWebhook(s, hook('evt_1001', '2026-11-02T11:30:04.000Z', '+919876543210'));
  const b = await applyWebhook(s, hook('evt_1001', '2026-11-02T11:30:04.000Z', '+919876543210'));
  assert.equal(a.status, 'applied'); assert.equal(b.status, 'duplicate');
  assert.equal(await s.read((db) => db.history.length), 1);
});

test('§8 out of order: evt_1000 (older) after evt_1001 is superseded and kept in history', async () => {
  const s = tmpStore();
  await applyWebhook(s, hook('evt_1001', '2026-11-02T11:30:04.000Z', '+919876543210'));
  const r = await applyWebhook(s, hook('evt_1000', '2026-11-02T11:20:00.000Z', '+918888888888', 'sales.b@client.example'));
  assert.deepEqual(r.outcomes, [{ field: 'phone', outcome: 'superseded' }]);
  const { value, actor, n } = await s.read((db) => { const f = Object.values(db.fields)[0]; return { value: f.value, actor: f.actor, n: db.history.length }; });
  assert.equal(value, '+919876543210'); assert.equal(actor, 'sales.user@client.example'); assert.equal(n, 2);
});

test('§5 store survives a reopen (file is the commit)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')); const f = path.join(dir, 'db.json');
  await applyWebhook(new FileStore(f), hook('evt_1', '2026-11-02T11:00:00.000Z', '1'));
  assert.equal(await new FileStore(f).read((db) => Object.keys(db.inbox).length), 1);
});
