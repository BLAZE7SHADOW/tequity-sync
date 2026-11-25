// Fake Salesforce record API + webhook sender. Implements only the assumed
// interface (B) from design §2, and sends webhooks shaped like interface (A).
// Field names are our names directly; the Q12 mapping is omitted in the demo.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { INTEGRATION_USER } from './merge.ts';
import { sign } from './signing.ts';

interface SfRecord { id: string; type: string; portalId: string | null; fields: Record<string, unknown>; systemModstamp: number; lastModifiedBy: string }

export interface Webhook {
  eventId: string; recordId: string; objectType: string; occurredAt: string; changedBy: string;
  changedFields: Record<string, unknown>; systemModstamp: string; portalId: string | null;
}

export class FakeSalesforce {
  readonly records = new Map<string, SfRecord>();
  readonly requestLog: { at: number; method: string; path: string; status: number }[] = [];
  /** Switches */
  down = false;            // outage: every connection is destroyed
  throttleNext = 0;        // answer the next N requests with 429 + Retry-After: 1
  webhookUrl = '';
  private server = http.createServer((req, res) => this.handle(req, res));
  private seq = 2000;

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }
  async stop(): Promise<void> { this.server.closeAllConnections(); await new Promise((r) => this.server.close(r)); }

  /** Largest number of requests that reached us inside any 1 s window. */
  maxPerSecond(): number {
    const ts = this.requestLog.map((r) => r.at).sort((a, b) => a - b);
    let best = 0;
    for (let i = 0, j = 0; j < ts.length; j++) { while (ts[j] - ts[i] >= 1000) i++; best = Math.max(best, j - i + 1); }
    return best;
  }
  writesTo(sfId: string): number { return this.requestLog.filter((r) => r.method === 'PATCH' && r.path.endsWith(sfId) && r.status < 300).length; }

  /** A sales user edits a record in Salesforce. Returns the webhook; it is NOT delivered (see deliver). */
  salesEdit(sfId: string, fields: Record<string, unknown>, user: string, at = Date.now()): Webhook {
    const rec = this.records.get(sfId)!;
    Object.assign(rec.fields, fields); rec.systemModstamp = at; rec.lastModifiedBy = user;
    return this.webhook(rec, fields, user, at);
  }
  /** A sales user creates a record. */
  salesCreate(type: string, fields: Record<string, unknown>, user: string): Webhook {
    const id = (type === 'Contact' ? '003' : '001') + randomUUID().replace(/-/g, '').slice(0, 12);
    const rec: SfRecord = { id, type, portalId: null, fields: { ...fields }, systemModstamp: Date.now(), lastModifiedBy: user };
    this.records.set(id, rec);
    return this.webhook(rec, fields, user, rec.systemModstamp);
  }
  /** Deliver webhooks to our endpoint, optionally duplicated or reversed (Salesforce's allowed misbehaviour). */
  async deliver(hooks: Webhook[], opts: { duplicate?: boolean; reverse?: boolean } = {}): Promise<number[]> {
    let list = opts.reverse ? [...hooks].reverse() : hooks;
    if (opts.duplicate) list = list.flatMap((h) => [h, h]);
    const statuses: number[] = [];
    for (const h of list) {
      const body = JSON.stringify(h);
      const r = await fetch(this.webhookUrl, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-signature': sign(body), 'x-timestamp': String(Date.now()) } });
      statuses.push(r.status);
    }
    return statuses;
  }

  private webhook(rec: SfRecord, fields: Record<string, unknown>, user: string, at: number): Webhook {
    return { eventId: `evt_${this.seq++}`, recordId: rec.id, objectType: rec.type, occurredAt: new Date(at).toISOString(),
      changedBy: user, changedFields: { ...fields }, systemModstamp: new Date(rec.systemModstamp).toISOString(), portalId: rec.portalId };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.down) { req.socket.destroy(); return; }                       // unreachable
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      this.requestLog.push({ at: Date.now(), method: req.method!, path: url.pathname, status });
      res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (this.throttleNext > 0) { this.throttleNext--; return send(429, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED' }], { 'retry-after': '1' }); }
    let raw = ''; for await (const c of req) raw += c;
    const parts = url.pathname.split('/').filter(Boolean); // sobjects/{Type}/{id} | sobjects/{Type}/Portal_Id__c/{pid}
    if (parts[0] !== 'sobjects') return send(404);
    const type = parts[1];

    if (req.method === 'GET' && parts.length === 3) {
      const rec = this.records.get(parts[2]); if (!rec) return send(404);
      return send(200, { Id: rec.id, ...rec.fields, SystemModstamp: new Date(rec.systemModstamp).toISOString(), LastModifiedById: rec.lastModifiedBy });
    }
    if (req.method !== 'PATCH') return send(405);
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    const now = Date.now();

    if (parts[2] === 'Portal_Id__c') {                                      // upsert by External ID
      const pid = parts[3];
      let rec = [...this.records.values()].find((r) => r.portalId === pid);
      const created = !rec;
      if (!rec) { rec = { id: (type === 'Contact' ? '003' : '001') + randomUUID().replace(/-/g, '').slice(0, 12), type, portalId: pid, fields: {}, systemModstamp: now, lastModifiedBy: INTEGRATION_USER }; this.records.set(rec.id, rec); }
      Object.assign(rec.fields, body); rec.systemModstamp = now; rec.lastModifiedBy = INTEGRATION_USER;
      send(created ? 201 : 200, { id: rec.id, created });
      this.echo(rec, body, now);
      return;
    }
    const rec = this.records.get(parts[2]); if (!rec) return send(404);
    const ius = req.headers['if-unmodified-since'];
    // HTTP-date has 1 s resolution (design Q8): compare whole seconds.
    if (ius && Math.floor(rec.systemModstamp / 1000) > Math.floor(Date.parse(ius) / 1000)) return send(412);
    Object.assign(rec.fields, body); rec.systemModstamp = now; rec.lastModifiedBy = INTEGRATION_USER;
    send(204);
    this.echo(rec, body, now);
  }

  /** Salesforce fires a webhook for our own write too: the echo, changedBy = integration user. */
  private echo(rec: SfRecord, fields: Record<string, unknown>, at: number): void {
    const hook = this.webhook(rec, fields, INTEGRATION_USER, at);
    setTimeout(() => { this.deliver([hook]).catch(() => {}); }, 50);
  }
}
