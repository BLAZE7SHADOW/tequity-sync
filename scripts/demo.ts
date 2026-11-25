// npm run demo: runs the design's rules against the fake Salesforce.
// Each scenario prints PASS/FAIL and the section of docs/design.md it proves.
import fs from 'node:fs';
import path from 'node:path';
import { FileStore, type Store } from '../src/store.ts';
import { FakeSalesforce } from '../src/fakeSalesforce.ts';
import { startWebhookEndpoint } from '../src/inbound.ts';
import { portalSave } from '../src/portal.ts';
import { Worker } from '../src/worker.ts';
import { TokenBucket, sleep } from '../src/limiter.ts';
import { portalCreate } from '../src/portal.ts';

const DATA = path.resolve('.demo-data'); const DB = path.join(DATA, 'db.json');
fs.rmSync(DATA, { recursive: true, force: true });
const CAP = { rate: 4, capacity: 1 }; // demo cap: <= 5 calls in any 1 s window (design uses 70/85 with capacity 5)
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const log = (m: string) => console.log(`    · ${m}`);
async function until(cond: () => Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(100); } return false; }

// "Process" = store + webhook endpoint + worker. Restart = throw it away and build a new one from the file.
async function bootProcess(sf: FakeSalesforce, sfBase: string) {
  const store = new FileStore(DB);
  const ep = await startWebhookEndpoint(store); sf.webhookUrl = ep.url;
  const worker = new Worker({ store, sfBaseUrl: sfBase, limiter: new TokenBucket(CAP.rate, CAP.capacity, 1), tickMs: 100, log });
  worker.start();
  return { store, ep, worker, stop: async () => { await worker.stop(); await ep.close(); } };
}
const portalIdOf = (s: Store, sfId: string) => s.read((db) => Object.values(db.records).find((r) => r.sfId === sfId)!.portalId);
const field = (s: Store, pid: string, f: string) => s.read((db) => db.fields[`${pid}|${f}`]);

const sf = new FakeSalesforce(); const sfBase = await sf.start();
let proc = await bootProcess(sf, sfBase);
console.log(`fake Salesforce at ${sfBase}; our store at ${DB}; demo cap ${CAP.rate}/s + burst ${CAP.capacity}\n`);

// Setup: a sales user creates a contact in Salesforce (webhook -> portal).
const created = sf.salesCreate('Contact', { full_name: 'Asha Rao', phone: '+911111111111', city: 'Delhi' }, 'sales.a@client.example', Date.now() - 180_000);
await sf.deliver([created]);
const sfId = created.recordId;
const pid = await portalIdOf(proc.store, sfId);

console.log('1. Duplicate webhook (design §8 duplicate rule)');
// Timeline: this edit happened 2 min ago; scenario 2's edits are 60 s and 30 s ago, so they are newer than this one.
const edit = sf.salesEdit(sfId, { phone: '+919876543210' }, 'sales.user@client.example', Date.now() - 120_000);
const st1 = await sf.deliver([edit], { duplicate: true });
const rows1 = await proc.store.read((db) => db.history.filter((h) => h.eventId === edit.eventId).length);
check(st1.join(',') === '200,200', `both deliveries of ${edit.eventId} answered 200 (so Salesforce stops retrying)`);
check(rows1 === 1, `applied once: ${rows1} history row for ${edit.eventId}`);

console.log('\n2. Older webhook after a newer one (design §8 out-of-order rule)');
const t = Date.now();
const older = sf.salesEdit(sfId, { phone: '+918888888888' }, 'sales.b@client.example', t - 60_000);
const newer = sf.salesEdit(sfId, { phone: '+917777777777' }, 'sales.user@client.example', t - 30_000);
await sf.deliver([older, newer], { reverse: true });  // newer arrives first
const phone = await field(proc.store, pid, 'phone');
const olderRow = await proc.store.read((db) => db.history.find((h) => h.eventId === older.eventId));
check(phone.value === '+917777777777' && phone.actor === 'sales.user@client.example', `current phone = ${phone.value} by ${phone.actor}`);
check(olderRow?.outcome === 'superseded', `older ${older.eventId} kept in history as '${olderRow?.outcome}' (by ${olderRow?.actor})`);

console.log('\n3. Our own update comes back as a webhook and is not sent again (design §9 loop rule)');
const cityBase = (await field(proc.store, pid, 'city')).stampEventId;
await portalSave(proc.store, 'finance.user@client.example', { portalId: pid, changedFields: { city: 'Noida' }, baseStamps: { city: cityBase } });
await until(async () => (await proc.store.read((db) => db.history.some((h) => h.outcome === 'echo_ack' && h.value === 'Noida'))), 5000);
await sleep(1500); // give any loop time to show itself
const city = await field(proc.store, pid, 'city');
const open3 = await proc.store.read((db) => db.outbox.filter((o) => o.portalId === pid && o.status !== 'done').length);
check(sf.records.get(sfId)!.fields.city === 'Noida', 'Salesforce shows the city the finance user set');
check(sf.writesTo(sfId) === 1, `exactly ${sf.writesTo(sfId)} PATCH to Salesforce; the echo caused none`);
check(city.actor === 'finance.user@client.example', `echo did not overwrite who changed the city: ${city.actor}`);
check(open3 === 0 && city.sfValue === 'Noida', 'nothing left to send (value = sf_value)');
check(phone.value === sf.records.get(sfId)!.fields.phone, 'phone set by sales survived next to the finance city (different fields)');

console.log('\n4. Pending call survives our restart while fake Salesforce is down (design §10)');
sf.down = true;
const base4 = (await field(proc.store, pid, 'city')).stampEventId;
await portalSave(proc.store, 'finance.user@client.example', { portalId: pid, changedFields: { city: 'Gurugram' }, baseStamps: { city: base4 } });
await until(async () => (await proc.store.read((db) => db.outbox.some((o) => o.portalId === pid && o.status === 'pending' && o.attempts >= 1))), 4000);
await proc.stop();                                         // process exits
// Simulate a crash in the middle of a call as well: the row is left in_flight with a lease (as the worker would leave it).
await new FileStore(DB).tx((db) => { const r = db.outbox.find((o) => o.portalId === pid && o.status === 'pending')!; r.status = 'in_flight'; r.leaseUntil = Date.now() + 1000; });
const onDisk = await new FileStore(DB).read((db) => db.outbox.find((o) => o.portalId === pid && o.status !== 'done'));
check(!!onDisk, `after the process died the call is on disk: status=${onDisk?.status}, attempts=${onDisk?.attempts}, lastError=${onDisk?.lastError}`);
proc = await bootProcess(sf, sfBase);                      // new process, same file
log('new process started; Salesforce still down for 2 s');
await sleep(2000);
check(sf.records.get(sfId)!.fields.city === 'Noida', 'nothing reached Salesforce while it was down');
sf.down = false; log('fake Salesforce back up');
const landed = await until(async () => sf.records.get(sfId)!.fields.city === 'Gurugram', 15_000);
check(landed, 'after the lease expired and Salesforce came back, the pending call was delivered: city = Gurugram');
const left4 = await proc.store.read((db) => db.outbox.filter((o) => o.portalId === pid && o.status !== 'done').length);
check(left4 === 0, 'outbox drained');

console.log(`\n5. Rate cap is enforced, including retries; a 429 slows us down and keeps the work (design §6C)`);
sf.requestLog.length = 0; sf.throttleNext = 2;
const pids = await Promise.all(Array.from({ length: 12 }, (_, i) => portalCreate(proc.store, 'cs@client.example', 'Account', { name: `Customer ${i}`, status: 'active' })));
const all = await until(async () => (await proc.store.read((db) => pids.every((p) => db.records[p].sfId))), 30_000);
const max = sf.maxPerSecond(), n429 = sf.requestLog.filter((r) => r.status === 429).length;
check(all, `all 12 portal-created customers reached Salesforce (upsert by Portal_Id__c) after ${n429} x 429`);
check(max <= CAP.rate + CAP.capacity, `max requests Salesforce saw in any 1 s window = ${max} <= ${CAP.rate + CAP.capacity} (cap incl. retries)`);

await proc.stop(); await sf.stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
