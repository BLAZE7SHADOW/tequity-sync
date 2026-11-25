import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { FileStore } from '../src/store.ts';
import { FakeSalesforce } from '../src/fakeSalesforce.ts';
import { startWebhookEndpoint } from '../src/inbound.ts';
import { portalCreate, portalSave } from '../src/portal.ts';
import { Worker, backoffMs } from '../src/worker.ts';
import { TokenBucket, sleep } from '../src/limiter.ts';

test('§6B backoff is 1, 2, 4, 8 s (max, before jitter) and capped at 300 s', () => {
  assert.deepEqual([1, 2, 3, 4].map((a) => backoffMs(a, 1)), [1000, 2000, 4000, 8000]);
  assert.equal(backoffMs(20, 1), 300_000);
});

test('§9 loop rule end to end: portal edit is sent once; the echo is an ack; actor unchanged', async () => {
  const store = new FileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'db.json'));
  const sf = new FakeSalesforce(); const base = await sf.start();
  const ep = await startWebhookEndpoint(store); sf.webhookUrl = ep.url;
  const w = new Worker({ store, sfBaseUrl: base, limiter: new TokenBucket(10, 1), tickMs: 50 }); w.start();
  try {
    const pid = await portalCreate(store, 'cs@client.example', 'Contact', { full_name: 'A B', city: 'Delhi' });
    await sleep(600);
    const sfId = await store.read((db) => db.records[pid].sfId!);
    assert.ok(sfId, 'create acked and sf_id stored');
    const baseStamp = await store.read((db) => db.fields[`${pid}|city`].stampEventId);
    await portalSave(store, 'finance.user@client.example', { portalId: pid, changedFields: { city: 'Noida' }, baseStamps: { city: baseStamp } });
    await sleep(1200);
    const st = await store.read((db) => ({ city: db.fields[`${pid}|city`], echoes: db.history.filter((h) => h.outcome === 'echo_ack').length, pending: db.outbox.filter((o) => o.status !== 'done').length }));
    assert.equal(sf.records.get(sfId)!.fields.city, 'Noida');
    assert.equal(sf.writesTo(sfId), 1, 'exactly one PATCH by id; the echo did not cause another');
    assert.equal(st.city.actor, 'finance.user@client.example');
    assert.equal(st.city.sfValue, 'Noida');
    assert.ok(st.echoes >= 1); assert.equal(st.pending, 0);
  } finally { await w.stop(); await ep.close(); await sf.stop(); }
});
