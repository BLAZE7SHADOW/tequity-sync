# Two-way sync: Salesforce ↔ Tequity portal — design

Status: draft. Brief: [brief.md](brief.md). Section numbers follow the brief's outline.

## 1. Assumptions and open questions

Each row: the question I would ask before locking the design, the assumption I closed it with, and what changes if the answer flips. Q1–Q5 are the brief's five.

| # | Question | Assumption used | If the answer flips |
|---|----------|-----------------|---------------------|
| Q1 | Peak and quiet edit rate? | Peak **50 edits/s** = **20/s portal→SF** + **30/s SF→portal**; quiet hour **1/s**. Worst case: peak lasts the whole 6 h outage. An "edit" = one save of one record (1–3 fields). | If portal→SF peak exceeds ~65/s (70 − 5 verification reserve), the 70/s steady target has no headroom and the 30 s bound breaks; we would need the Composite API (up to 25 records per call — new assumption) to raise records/request. |
| Q2 | Does a webhook carry only changed fields or the full record? | **Delta**: `changedFields` holds only fields that changed. | Full record: diff each field against `sf_value` (last value we know Salesforce holds, §4) — **not** against our current value, or an unsent portal edit would look like a Salesforce change. Only differing fields become events, `kind = snapshot`. The rest of the pipeline is unchanged. |
| Q3 | Can we ask Salesforce what changed during the 6 h? | **Yes**: a query by `SystemModstamp >= reconcile_from` (= outage start − 15 min, §10), 2,000 rows per page (SOQL query + queryMore). Assumption. | If not: changes made in Salesforce during the window whose webhooks were lost stay unknown until the next edit of that record, or a full 5 M-record export (2,500 pages). Intermediate values inside the window are unrecoverable **either way** — the query returns only the latest value. |
| Q4 | Two portal users edit the same field: what does the other see, what goes to SF? | Optimistic concurrency per field. The form submits the stamp (`stamp_event_id`) it loaded. If the field's current stamp differs → **409** with the current value, who set it, when. The loser's attempt is written to history as `rejected`. **Only the winner is sent to Salesforce.** | If the client prefers silent last-write-wins: drop the 409, the later commit wins, the earlier value stays in history. Outbound is unchanged. |
| Q5 | What orders a portal edit (sample has no time)? | **Server commit timestamp** from Postgres (`clock_timestamp()` inside the write transaction) plus a server-generated `event_id`. **Actor = authenticated session user**; `editedBy` in the payload is ignored (rejected with 400 if it disagrees with the session). | If the client insists on a client-side time, we would need skew bounds per browser; I would refuse and keep server time. |
| Q6 | How far apart are Salesforce's clock (`occurredAt`) and ours? | Both NTP-synced, **skew < 1 s** (margin ε = 1 s in §4 step 3). **Measured, not trusted.** Every echo of our own PATCH must have an `occurredAt` inside `[t_send, t_ack]` of our call, both read on our clock. Provable skew per echo = `max(0, t_send − occurredAt, occurredAt − t_ack)`. Its 5-min median is a watched number (§11). | Cross-side edits of the **same field** within the skew window can resolve in the wrong order. Larger skew → add a rule "within N s, Salesforce wins" and flag for review. Different-field edits are unaffected. |
| Q7 | Does `changedBy` identify our integration user on echoes? | Yes. We call Salesforce as one dedicated user, `integration@tequity.example`, which appears as `changedBy`. | Loop layer (b) fails; layers (a) and (c) still stop the loop (§9), but the echo would be recorded as a normal SF edit with the wrong actor. Fallback: match the echo value against the last value we sent (`sf_value`). |
| Q8 | Does the record API support conditional update (`If-Unmodified-Since` → 412)? | **Yes** (assumption). Used to avoid overwriting a sales edit that landed while our PATCH was queued. The header is an HTTP-date, which has **1 s resolution**, so a sales edit in the same second as our base is not caught. The collision check (§7) covers that gap. | Without it, a same-field cross-side race can leave Salesforce on the older value until reconciliation repairs it (§7, §10). |
| Q9 | Can we add an External ID field to Account and Contact? | Yes: `Portal_Id__c` (unique, external ID). Portal creates use **upsert by `Portal_Id__c`**, so a retried create cannot duplicate. | Without it, a create that times out and is retried may duplicate; we would query by `Portal_Id`-like natural key before each retry (+1 call per retry). |
| Q10 | How are webhooks authenticated? | HMAC-SHA256 of the raw body in header `X-Signature`, shared secret, plus a timestamp header rejected if > 5 min old. | If only a static token is available: token in header + IP allowlist; replay protection then relies on `inbox_events` only. |
| Q11 | Does Salesforce retry a webhook on non-2xx, and how long? | Yes, with backoff for at least 1 h. We return 200 **only after commit**. | If no retry, any 5xx from us loses the event; reconciliation (§10) must also run on a schedule (every 15 min), not only after outages. |
| Q12 | Object/field mapping? | Customer = `Account` (`Name`, `Status__c`, `OwnerId`); Contact = `Contact` (full name = `Name`, written as `FirstName`/`LastName`; `Phone`, `Email`, `MailingCity`, `OwnerId`, `AccountId`). Portal owners map to SF user IDs via a lookup table we keep. | If a portal owner may not be an SF user, `owner` cannot sync for that record; we would keep it portal-only and say so in the UI. |
| Q13 | What does a Salesforce **create** webhook contain? | Same shape, `changedFields` = every populated field, plus `Portal_Id__c` if the record was created by us. | If create webhooks omit fields, we fetch the record once (1 API call per SF create, ≤ 30/s, inside budget). |
| Q14 | May we add fields to the webhook? | Yes, two: **`systemModstamp`** (Salesforce's record version — the base for `If-Unmodified-Since` and the reconciliation watermark) and **`portalId`** (`Portal_Id__c`) — so the echo of a portal-created record matches our row even if it arrives before our worker stored the returned `sf_id`. | Without `portalId`, an early create-echo would make a second portal record; we would hold unmatched Contact/Account creates for 60 s and re-check. |
| Q15 | Is our webhook endpoint also down during the 6 h? | No. Only the Salesforce API is unreachable; Salesforce's webhook sends **may** fail too and are not guaranteed to be retried (brief). | If our endpoint is down too, same recovery path (§10); nothing new. |
| Q16 | How long must history be kept? | Forever, append-only. Upper bound 50 edits/s × 86,400 s = 4.32 M rows/day at sustained peak; real days far lower. | If a retention limit exists, partition `field_events` by month and drop old partitions. |
| Q17 | How quickly does Salesforce send a webhook after the edit? | Within 5 s typical, 15 s worst. | If slower than ~25 s, the SF→portal 30 s bound cannot be met by us at all; that half of the SLA is theirs. |
| Q18 | Can a Contact arrive before its Account? | Yes (any order). `customer` is stored as a reference string, `sf:<AccountId>` or `portal:<portal_id>` (for a portal-created Account not yet in Salesforce), with no FK; resolved at read time. | — |
| Q20 | How does Salesforce count "100 requests per second"? | A sliding 1 s window over **arrival** time at Salesforce. Our one-way latency jitter is ≤ 100 ms. | If Salesforce counts per calendar second at its side, the same bound holds. If jitter is larger, catch-up `r` must drop further: r ≤ (100 − 5) ÷ (1 + δ) (§6C). |
| Q21 | Is there also a daily API quota? | Not modelled; the brief gives only the per-second cap. | The drain alone is 432,000 + 324 = 432,324 calls, and steady state uses 25/s × 86,400 = 2.16 M/day. A lower daily quota would make the drain take days, and Bulk/Composite (§12) would become mandatory. |
| Q19 | Can we read Salesforce field history (per-field change times)? | No, not assumed. | If yes, the "unprovable" band of §4 step 3 collapses: the history gives the true time of the Salesforce change, so every case is decided by stamp. |

Decision on the brief's "Pick one"
: **delta webhooks** (Q2), with the snapshot rule as the defined behaviour for the other case.

## 2. Systems, callers, boundary, interfaces

```
  Sales user                                   Finance / CS user
      | (browser)                                     | (browser, authenticated session)
      v                                               v
 +-----------------+                       +-----------------------------+
 | Salesforce      |                       | Portal API (existing app)   |
 | (their DB)      |                       |  PATCH /records/{type}/{id} |
 +-----------------+                       +-------------+---------------+
   |          ^                                          | one txn: field_state,
   | (A)      | (B) record API                           | field_events, outbox
   | webhook  | PATCH / upsert / query                   v
   | HTTPS    | HTTPS, <=100 req/s          +-----------------------------+
   |          |                             |          Postgres           |
===|==========|=== public internet =========|  records  field_state       |
   |          |    (only path: HTTPS)       |  field_events inbox_events  |
   v          |                             |  outbox   sync_state        |
                                            |  verify_queue  records      |
 +----------------------+   writes          +-----------------------------+
 | Webhook endpoint     |------------------>      ^            ^
 | stateless, N replicas|  inbox_events,          |            | claim/ack outbox,
 +----------------------+  field_state,           |            | write sf_value,
                            field_events          |            | reconcile
              +-----------------------------------+------------+
              | Sync worker: single leader (pg_try_advisory_lock(42)),     |
              | token bucket, backoff, breaker, reconciliation             |
              +------------------------------------------------------------+
                          | (B) calls Salesforce
```

**Choice: one codebase, two deployables.** The webhook endpoint must answer fast and scale horizontally. The worker must be the single owner of the rate budget, because a token bucket split across replicas cannot honour one cap without coordination. The two never call each other. **What crosses between them is the Postgres schema, not only the outbox.** The starting brief said "only the outbox", which is wrong: the worker reads `field_state` to build each call and writes `sf_value` after a success. Ownership per table:

| Table | Written by | Read by |
|-------|-----------|---------|
| `inbox_events` | endpoint only (snapshots use `snap_` ids and never enter the inbox) | endpoint |
| `records` | endpoint (SF creates, `sf_modstamp`), portal API (portal creates), worker (`sf_id`, `sf_modstamp`, `last_send_ack_at`) | all |
| `field_state` | all three, **only through `merge`**: endpoint (webhooks), portal API (saves), worker (snapshots from 412 re-reads, verification reads, reconciliation; `sf_value`/`sf_stamp` on ack) | all |
| `field_events` | all three, append-only | portal UI (history) |
| `outbox` | portal API (insert on save), worker (lease, status; repair inserts from read paths and the dirty sweep) | worker |
| `verify_queue` | endpoint (insert), worker (delete after the read) | worker |
| `sync_state` | worker (`reconcile_from`, breaker) | worker |

Shared code, `applyFieldEvents(tx, recordKey, events[])`, is the **only** function that changes `field_state.value`. The endpoint, the portal API and the worker's read paths (412 re-read, verification, reconciliation) all call it (§4 rule).

**Interface (A), Salesforce → us.** `POST /webhooks/salesforce`, JSON as in the brief plus `systemModstamp` and `portalId` (Q14). Headers `X-Signature`, `X-Timestamp`. Responses: `200` applied or duplicate; `400` schema invalid (logged, Salesforce should not retry); `401` bad signature; `503` database unavailable (Salesforce retries). Never `200` before commit.

**Interface (portal), user → portal API.** `PATCH /records/{objectType}/{portalId}`, body `{changedFields:{city:"Noida"}, baseStamps:{city:"<event_id the form loaded>"}}`. Responses: `200` with new stamps; `409` `{field, currentValue, changedBy, changedAt}` per stale field (the whole save is rejected, so a form is never half-applied); `400` if `editedBy` ≠ session user.

**Interface (B), us → Salesforce.** Our assumption of the record API: `PATCH /sobjects/{Type}/{sfId}` with header `If-Unmodified-Since: <sf_modstamp>`; `PATCH /sobjects/{Type}/Portal_Id__c/{portalId}` (create-or-update by External ID); `GET /sobjects/{Type}/{sfId}?fields=…,SystemModstamp,LastModifiedById` (412 re-read, verification); `GET /query?q=SELECT … WHERE SystemModstamp >= …` (reconciliation). Outcomes: `2xx` ack; `412` re-read and re-merge; `429`/`503` + `Retry-After` slow down and keep the row; other `4xx` dead-letter the row and alert; timeout/connection error retry with backoff.

## 3. Subproblems, in build order (risk first)

1. **Per-field merge and ordering** (pure function `merge(state, event) → {state', historyRow}`). Riskiest because every path calls it, and a bug loses data silently with no error. Cheapest to prove: unit tests, no I/O. Needs: the stamp definition. No component.
2. **Idempotent inbound apply** (duplicate and out-of-order in one transaction). Second because Salesforce *will* duplicate and reorder from day one. Needs: `inbox_events` (PK `event_id`) and a conditional upsert.
3. **Loop prevention.** A loop costs the rate budget at 2× per bounce and corrupts the actor. Must exist before the worker sends anything. Needs: integration-user identity and the `sf_value` column. No component.
4. **Cross-side race on an in-flight update** (a sales edit lands while our PATCH is queued or in flight). Moved ahead of the queue at the Phase 2 review because it fixes the **payload format**: values are computed from `field_state` at send time, `If-Unmodified-Since: sf_modstamp` is attached, and a collision check feeds a read-only `verify_queue`. Needs: Q8, plus the `verify_queue` table.
5. **Durable outbound queue.** "Pending calls survive restart" is a hard requirement. Needs: the `outbox` table written in the portal's save transaction, plus leases. Adds the **worker** deployable.
6. **Rate limiter, backoff, breaker.** The cap counts retries, so the limiter must wrap every attempt. Needs: an in-process token bucket in the single leader. Adds the **advisory lock** (leader election without new infrastructure).
7. **Creates and ID mapping.** Retried creates must not duplicate, and a create's echo must find its row. Needs: `Portal_Id__c` upsert and `portalId` in the webhook.
8. **Outage recovery.** Drain plus reconciliation of lost webhooks. Needs: `sync_state.reconcile_from` and the query API (Q3). Built late because it reuses 2, 5 and 6 unchanged.
9. **Observability.** Three paging metrics plus measured clock skew (§11).

Rejected components: no Kafka, no Redis, no separate queue. Postgres already has the transactional write we need: the outbox row commits with the edit or not at all. At 20 rows/s the outbox is ~1.7 M rows/day at sustained peak, which is trivial for Postgres.

## 4. The data we store (Postgres)

```sql
CREATE TABLE records (
  portal_id    uuid PRIMARY KEY,              -- = Portal_Id__c in Salesforce
  sf_id        text UNIQUE,                   -- NULL until our create is acked
  object_type  text NOT NULL CHECK (object_type IN ('Account','Contact')),
  sf_modstamp  timestamptz,                   -- latest SystemModstamp seen; base for If-Unmodified-Since
  last_send_ack_at timestamptz                 -- end of our last successful write; collision window = in flight or ack + 10 s
);

CREATE TABLE field_state (                    -- one row per (record, field): the CURRENT value
  portal_id      uuid  REFERENCES records,
  field          text,                        -- name|status|owner|full_name|phone|email|city|customer
  value          jsonb,
  stamp_time     timestamptz NOT NULL,        -- ORDERING key, part 1
  stamp_event_id text        NOT NULL,        -- ORDERING key, part 2 (tie-break)
  actor          text        NOT NULL,        -- who last CHANGED the value
  changed_at     timestamptz NOT NULL,        -- when the value last changed (display)
  source         text NOT NULL,               -- portal | salesforce | snapshot
  sf_value       jsonb,                       -- last value we know Salesforce holds
  sf_stamp       timestamptz,                 -- W: last time we KNEW Salesforce held sf_value for this field
  conflict       boolean NOT NULL DEFAULT false, -- set by the unprovable case of merge step 3
  PRIMARY KEY (portal_id, field)
);

CREATE TABLE field_events (                   -- append-only history; never UPDATE/DELETE
  id          bigserial PRIMARY KEY,
  portal_id   uuid, field text, value jsonb,
  stamp_time  timestamptz, event_id text, actor text, source text,
  outcome     text NOT NULL,  -- applied | superseded | equal_value | echo_ack | rejected_409 | unprovable
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbox_events (event_id text PRIMARY KEY, received_at timestamptz, payload jsonb);

CREATE TABLE outbox (                         -- "this record has portal edits Salesforce lacks"
  id            bigserial PRIMARY KEY,
  portal_id     uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending', -- pending | in_flight | done | dead
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until   timestamptz,
  last_error    text,
  last_save_at  timestamptz NOT NULL DEFAULT now(), -- latest portal save that touched this row; drives the live lane (§6C)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready ON outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE verify_queue (                   -- read-only verification requests; NOT the outbox (loop layer a)
  portal_id uuid PRIMARY KEY,                 -- PK = at most one pending read per record
  due_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_state (key text PRIMARY KEY, value jsonb);  -- reconcile watermark, breaker
```

- `customer` on a Contact is stored as `sf:<AccountId>` or `portal:<portal_id>`, with no foreign key. It is resolved at read time, because the Contact may arrive before its Account (Q18), or its Account may not be in Salesforce yet (§6 A0).
- **History is the full sequence of `field_events` rows**, including losers, echoes and rejected saves. "Who changed the city" = `actor` on the `field_state` row. "Who changed it before" = earlier rows with `outcome='applied'`.
- **Stamp.** `stamp = (stamp_time, stamp_event_id)`, compared as a pair: time first, then the event id as a string. The two sides set it as follows:
  - Webhook: `(occurredAt, eventId)`.
  - Portal save: `(GREATEST(clock_timestamp(), current stamp_time + 1 µs), 'p_'+uuidv7)`, taken under the record lock. The `GREATEST` makes it monotonic per field. The 409 check already proved the user saw the current value, so the save must win even inside the same clock tick. Without it, the random part of the id would decide, and the save could be `superseded` while returning 200. *Found by the demo's unit test in Phase 9; doc and code fixed together.* (The demo uses 1 ms.)
  - Snapshot or reconciliation: `(SystemModstamp, 'snap_'+sfId+'_'+SystemModstamp)`. Actor = `LastModifiedById` mapped via Q12, marked approximate by `source='snapshot'`: it is the record's last modifier, not necessarily this field's.
  - **The field that decides which edit is current:** `stamp_time`, which is `occurredAt` on a webhook and the Postgres commit-time `clock_timestamp()` on a portal save, with `stamp_event_id` as the tie-break.
- **The outbox row does not store values.** It only marks the record dirty. At send time the worker computes what to send from `field_state` (§6). An outbox row therefore never carries a stale value, and repeated edits to one record merge into one call.
- Size: 5 M records × ~5 fields ≈ 25 M `field_state` rows. `field_events` grows ≤ 4.32 M rows/day at sustained peak (Q16).

### Merge rule (pure function; the only writer of `field_state.value`)

`merge(S, E)`: S is the current `field_state` row (possibly absent), E is an incoming field event. The steps run in order and the first match wins.

1. **Echo.** If `E.source='salesforce'` and `E.actor = integration@tequity.example`: **if `E.stamp_time > sf_stamp`**, set `sf_value=E.value`, `sf_stamp=E.stamp_time`. Leave `value`, `actor` and stamp unchanged in all cases. History `echo_ack`. The guard matters: a late echo of our older write must not hide a newer sales value.
2. **Track Salesforce.** For any other Salesforce or snapshot event with `E.stamp_time > sf_stamp`: set `sf_value=E.value`. This happens whatever step 3 decides. Step 3 reads W = `sf_stamp` from *before* this update.
3. **Snapshot against an unsent portal edit: interval rule.** This replaces "pending always wins", which the Phase 2 review rejected: it picks the portal value even when the portal edit is the older one. The rule applies only when all three hold:
   - E is a snapshot: a full-record webhook, a reconciliation row or a verification read.
   - `E.value ≠ sf_value`, so Salesforce changed the field since we last knew its value.
   - The field holds an unsent portal edit (`S.source='portal'` and `S.value ≠ sf_value`), with time `P = S.stamp_time`.

   The Salesforce change happened somewhere in **(W, M]**:
   - **W** = `field_state.sf_stamp`, the last time we knew Salesforce held `sf_value` *for this field*.
   - **M** = the record's `SystemModstamp` (for a full-record webhook, its `occurredAt`).
   - **ε** = 1 s skew margin (Q6).

   | Case | Condition | Result |
   |--|--|--|
   | Portal provably later | `P > M + ε` | Keep `value`. E is recorded `superseded`. The outbox sends the portal value. |
   | Salesforce provably later | `P ≤ W − ε` | Apply E with stamp `(M, snap id)`. Since `M > W > P`, it beats P. `value = sf_value` now, so the queued portal value is never sent. |
   | Unprovable | otherwise | Keep the portal value as the current one, as a **reversible tie-break**. Set `field_state.conflict = true` and record E as `unprovable` (both values are in history). Increment `reconcile_conflicts`. The outbox sends the portal value, so both sides converge on it. A reviewer settles it with a normal portal save, which clears the flag. |

   **W is per field, not per record.** A delta webhook for `phone` at 09:30 proves nothing about `city`. A record-level W = 09:30 would wrongly turn a 09:00 portal city edit into "Salesforce wins", even if the lost sales city change was at 08:30.

   **If the M assumption is wrong.** `SystemModstamp` also advances on system-only updates. That makes M *later* than the true change, so the band gets wider: more flags, but never a wrong verdict. The rule is unsafe only if M is *earlier* than the true change, or if skew exceeds ε. Then a "portal provably later" verdict could be false. The skew metric (§11) detects the second cause. The fallback is to set ε very large, which sends every case to "unprovable".

   **Worked examples** (Contact city):

   | | W (`sf_stamp`) | M (`SystemModstamp`) | P (portal edit) | Case | Current city |
   |--|--|--|--|--|--|
   | A | 08:00 (echo of our last city send) | 10:00 (sales changed city, webhook lost) | 10:30 (finance edit queued while SF was down) | `10:30 > 10:00:01` → portal provably later | finance value. Salesforce is overwritten. The sales value stays in history. |
   | B | 08:00:00 (echo of send #1) | 10:00 | 07:59:30 (finance edit #2, queued behind #1 because only one call per record is in flight) | `07:59:30 ≤ 07:59:59` → Salesforce provably later | sales value. Edit #2 is history only. |
   | C | 08:00 | 10:00 | 09:00 (the review's example) | `08:00 < 09:00 ≤ 10:00` → unprovable | finance value, flagged. |

   On C, honestly: if the sales edit really was at 10:00, Salesforce should win, and the default picks wrong. The change is that we now *say* it is unprovable and flag it. Only Q19 (field history) resolves it.

   If E is a snapshot and the field has **no** unsent portal edit, E goes through steps 4–7 with stamp `(M, snap id)`.
4. **No state yet.** If S is absent, insert the row from E. History `applied`.
5. **Older or equal stamp.** If `E.stamp ≤ S.stamp`: no change. History `superseded`.
6. **Same value.** If `E.stamp > S.stamp` and `E.value = S.value`: advance the stamp, keep `actor` and `changed_at`. History `equal_value`. The stamp must advance, or a late event with a stamp between the old and new stamp would wrongly apply.
7. **Newer stamp.** Otherwise (`E.stamp > S.stamp`): set `value`, the stamp, `actor`, `changed_at` and `source` from E. History `applied`.

The SQL form of steps 5–7 is one statement, so concurrent replicas cannot interleave:
`INSERT … ON CONFLICT (portal_id, field) DO UPDATE SET value=EXCLUDED.value, stamp_time=EXCLUDED.stamp_time, stamp_event_id=EXCLUDED.stamp_event_id, actor = CASE WHEN field_state.value = EXCLUDED.value THEN field_state.actor ELSE EXCLUDED.actor END, changed_at = CASE … same … END, … WHERE (field_state.stamp_time, field_state.stamp_event_id) < (EXCLUDED.stamp_time, EXCLUDED.stamp_event_id)`. If 0 rows are updated, the outcome is `superseded`. The `CASE` is step 6.

**Clearing a conflict.** A *delta* event (exact time) that reaches step 5 or 7 on a field with `conflict = true` sets `conflict = false`: the stamp rule has now decided it provably.

## 5. Inbound path: webhook → Postgres

Endpoint `POST /webhooks/salesforce`, any replica:

1. **Authenticate.** Check the HMAC-SHA256 of the raw body against `X-Signature`. Reject if `X-Timestamp` is more than 5 min from now. Failure → `401`, nothing stored.
2. **Validate.** Required: `eventId`, `recordId`, `objectType ∈ {Account, Contact}`, `occurredAt` (ISO-8601 with ms), `changedBy`, and a `changedFields` object. Failure → `400`, logged.
3. **Map fields.** Map Salesforce fields to ours (Q12). Fields outside the 8 in scope are ignored and logged, not rejected, because Salesforce may send more. If no in-scope field remains, the event is still recorded in the inbox and gets `200`.
4. **Open one transaction.** Steps 4a–4e run inside it:
   - a. `INSERT INTO inbox_events (event_id, …) VALUES ($eventId, …) ON CONFLICT DO NOTHING RETURNING event_id`. **No row returned → duplicate**: `COMMIT`, `200`, stop (§8).
   - b. Resolve the record. Look up `records` by `sf_id = recordId`. If not found and `portalId` is present, look up by `portal_id` and set `sf_id` (this is the echo of our own create). If still not found, `INSERT INTO records … ON CONFLICT (sf_id) DO NOTHING`, then select: a Salesforce-side create. Two different events for the same new record cannot make two rows.
   - c. `SELECT … FROM records WHERE portal_id=$1 FOR UPDATE`. This serialises all writers of one record: replicas, the portal API and the worker.
   - d. For each field, run `merge(S, E)` (§4), with `E = {value, stamp=(occurredAt, eventId), actor=changedBy, source='salesforce'}`. Append one `field_events` row per field, always, whatever the outcome.
   - e. `UPDATE records SET sf_modstamp = GREATEST(sf_modstamp, $systemModstamp)`.
   - f. **Collision trigger** (§7). If `changedBy ≠` integration user, and either the record's outbox row is `in_flight` or `last_send_ack_at > now() − 10 s`: `INSERT INTO verify_queue … ON CONFLICT DO NOTHING`. This is a read-only request, not a write.
5. **Commit, then answer.** `COMMIT` → `200`. Any database error → `ROLLBACK` → `503`. The inbox row rolls back too, so Salesforce's retry is applied, not mistaken for a duplicate.

**The webhook endpoint never inserts into `outbox`** (it may insert into `verify_queue`, which only ever causes a GET). Writes to Salesforce come only from portal saves and from the worker's read paths (§9). This is loop layer (a), §9.

Load: 30 webhooks/s at peak × ~3 statements per field. That is well inside one Postgres primary. The endpoint holds no state, so replicas are added for availability, not throughput.

## 6. Outbound path: portal edit → Salesforce API call

**A0. Portal create.** `POST /records/{objectType}`: one transaction inserts `records` (new `portal_id`, `sf_id` NULL), all `field_state` rows (`sf_value` NULL, so every field is dirty) and `field_events`, plus an `outbox` row. The worker then upserts by `Portal_Id__c`. A Contact whose customer is a portal-created Account with no `sf_id` yet sends the reference as `Account: {Portal_Id__c: …}`. That is an upsert relationship by external ID, an assumption tied to Q9. Salesforce resolves it, so there is no ordering wait. If unsupported: defer the Contact row by 2 s until the Account's `sf_id` is set.

**A. Portal save (portal API, one transaction).**
1. `SELECT … FROM records WHERE portal_id=$1 FOR UPDATE`.
2. For each field in `changedFields`, compare `baseStamps[field]` with `field_state.stamp_event_id`. Any mismatch → `ROLLBACK`, `409` for the whole save, plus one `rejected_409` history row per field (written in a separate short transaction).
3. Set the stamp to `(GREATEST(clock_timestamp(), current stamp_time + 1 µs), 'p_'+uuidv7())` per field (§4 Stamp). Set the actor to the session user. Run `merge` (§4) and append `field_events`.
4. `INSERT INTO outbox (portal_id) VALUES ($1) ON CONFLICT … DO UPDATE`. On conflict: `UPDATE SET last_save_at = now()`. A partial unique index `ON outbox(portal_id) WHERE status='pending'` keeps it to one pending row per record. If a row is already `in_flight`, the new pending row is the "send again afterwards".
5. `COMMIT` → `200`. The edit and its outbox row commit together or not at all.

**B. Worker (single leader holding `pg_try_advisory_lock(42)`; 32 concurrent HTTP slots).**
- **Claim**, every 200 ms or on `LISTEN outbox_new`:
  ```sql
  UPDATE outbox SET status='in_flight', lease_until=now()+interval '15 s', attempts=attempts+1
  WHERE id IN (SELECT o.id FROM outbox o
               WHERE o.status='pending' AND o.next_attempt_at<=now()
                 AND NOT EXISTS (SELECT 1 FROM outbox i WHERE i.portal_id=o.portal_id AND i.status='in_flight')
               ORDER BY o.next_attempt_at LIMIT 50 FOR UPDATE SKIP LOCKED)
  RETURNING id, portal_id;
  ```
  A partial unique index `ON outbox(portal_id) WHERE status='in_flight'` enforces **one in-flight call per record**.
- **Build the payload** from `field_state` *at send time*: every field where `value IS DISTINCT FROM sf_value`. The values are absolute, so re-sending is idempotent. If the set is empty → mark `done`, with no call. For example, Salesforce won the field in the meantime.
- **Call, after `limiter.take()`.**
  - `sf_id` known: `PATCH /sobjects/{Type}/{sfId}` with `If-Unmodified-Since: sf_modstamp`, body = the changed fields only.
  - `sf_id` NULL: `PATCH /sobjects/{Type}/Portal_Id__c/{portalId}` (upsert) with all 8 fields. Request timeout 10 s.
- **Outcome**, in one transaction under the record lock:

| Response | Action |
|--|--|
| 2xx | For each sent field: if `sf_stamp < t_send`, set `sf_value = sent value`, `sf_stamp = t_send` (never clobber a newer Salesforce fact that arrived during the flight). Set `sf_id` on create. Set `last_send_ack_at = now()`. Row → `done`. |
| 412 | Salesforce changed since our base. `GET` the record (takes a token), apply it as a snapshot (merge step 3), set `sf_modstamp`. If step 3 says **unprovable**, wait for the delta webhook: row → `pending`, `next_attempt_at = now()+15 s` (Q17 worst webhook latency). The delta carries the exact `occurredAt` and decides by stamp. If it never arrives, the default applies on the retry. Otherwise row → `pending`, retry now (the payload is recomputed). After 5 consecutive 412s → `dead` + alert. |
| 429, or 503 with `Retry-After` | Row → `pending`, `next_attempt_at = now()+Retry-After`. Limiter: pause all sends until then and halve the rate (§6C). Work is kept. Not counted toward dead-lettering. |
| 5xx, timeout, connection error | Row → `pending`, `next_attempt_at = now() + min(300 s, 2^(attempts−1) s) × U(0.5, 1)` (exponential backoff with jitter: 1, 2, 4, 8 … s). Feeds the breaker. |
| other 4xx (400 validation, 404) | Row → `dead`, `last_error` stored, page (§11). The value stays current in the portal and in history. |

- **Returning a row to `pending` when the record already has a pending row** (a save arrived during the flight): this would violate the partial unique index. Instead, the in-flight row → `done`, and the existing pending row takes `attempts` and `next_attempt_at = GREATEST(its own, this backoff)`, plus `created_at = LEAST(…)` so the age metric keeps the oldest edit. The payload is recomputed anyway, so nothing is lost.
- **`sf_modstamp` after our own write.** A 2xx PATCH returns no body, so we do not learn the new `SystemModstamp` until the echo arrives (it carries `systemModstamp`, Q14; §5 step 4e). A second edit sent before the echo will 412, re-read (`value = sf_value`, so it learns the modstamp) and retry: +1 GET +1 PATCH. This is bounded by back-to-back sends to one record inside ~5 s of echo latency, and is accepted.
- **Lease and restart.** A sweeper resets `in_flight` rows with `lease_until < now()` to `pending` every 5 s. After a crash, a new leader takes the advisory lock, and the rows come back within 15 s + 5 s. A re-send is safe: the values are absolute, creates are upserts, and a PATCH that already applied hits 412, then the read shows `value = sf_value`, so nothing is sent.
- **Dirty sweep (convergence invariant).** *If any field has `value ≠ sf_value`, a pending or in-flight outbox row exists within 60 s.* The worker scans every 60 s, using a partial index on `field_state(portal_id) WHERE value IS DISTINCT FROM sf_value`, and inserts any missing row. This covers the one path that can make Salesforce stale without a portal save: an echo or read that shows Salesforce holding an older value than ours (§7 example, case 1b). The sweeper is a worker read path, so the webhook endpoint still never writes `outbox`.

**C. Rate limiter (inside the leader).**
- Token bucket, refill rate `r`, **capacity 5 tokens**. Any 1 s window of *our* sends then holds at most `r + 5` calls: 75 in steady state, 90 in catch-up. With ≤ 100 ms jitter, Salesforce sees at most `r × 1.1 + 5` = 82 or 98.5, which is ≤ 100 **by construction**, even at burst (Q20).
- **Every** HTTP call to Salesforce takes a token first: first attempts, retries, 412 re-reads, verification GETs (sub-cap 5/s), reconciliation pages and breaker probes.
- **Modes.** Steady `r = 70`. Catch-up `r = 85` when outbox pending > 1,000 or right after the breaker closes; back to 70 when pending < 100.
- **Why these rates (and why not 95).**
  - **Retries do not need headroom above `r`.** The bucket counts every call, so retries, re-reads and probes are *inside* `r`. They can slow useful work (sensitivity rows in §10) but cannot push us over the cap. The margin between `r` and 100 is for two other things:
    - (i) **The burst capacity** of 5 tokens.
    - (ii) **Network jitter.** Salesforce counts *arrivals* (Q20). Requests we space over 1 s can bunch at its side, so it can see up to `r × (1 + δ) + 5` in one of its windows.
  - **Why not 95.** At δ = 0.1 s: 95 × 1.1 + 5 = **109.5**, which breaks the cap. 85 × 1.1 + 5 = **98.5** holds. The largest safe rate is (100 − 5) ÷ 1.1 = 86.4, so **catch-up r = 85**. *Changed from 95 at the pre-Phase-9 review.*
  - **Why steady state runs at 70, not 85.** The 30 s bound needs short queues. 25/s of steady work ÷ 70 = 35.7 % utilisation keeps token waits near zero, even when a burst of edits or a 412 wave arrives. It also leaves 15/s for Salesforce-side load we cannot see (another integration in the same org).
- **Claim order: live lane first.** Rows touched by a portal save since the breaker last closed (`outbox.last_save_at > breaker.closed_at`) are claimed before backlog rows; within a lane, oldest `next_attempt_at` first. Without this, a live edit would wait behind up to 2 h of backlog. With it, live edits see the normal ≈ 1 s path as long as `r ≥ 25`.
- **On 429.** `r := max(10, r/2)`, and pause until `Retry-After`. Then +5/s for every 10 s without a 429, back up to the mode's target.
- **Throughput check.** Little's law: 85 req/s × 0.3 s typical latency ≈ 25.5 concurrent calls, under the 32 slots. One leader is enough.
- **Breaker.** Opens after 20 consecutive failures (5xx, timeout or connection error). While open there are no sends, only **one probe every 30 s** (a `GET` of one known record, 1 token). Probe success → half-open: send 10 rows; all succeed → closed, catch-up mode. Any failure → open again.

**D. The 30 s bound, closed.**
- **Portal → Salesforce, typical:** commit → claim ≤ 0.2 s → token wait ≈ 0 at 35.7 % load (§7) → HTTP ≈ 0.3–0.5 s, so ≈ 1 s.
- **Portal → Salesforce, worst with transient errors:** attempts at 0, 1, 2, 4 and 8 s of backoff = 15 s, plus 5 × 0.5 s calls = 17.5 s < 30 s.
- **Worker crash:** 15 s lease + 5 s sweep + 1 s = 21 s.
- **Unprovable 412:** +15 s wait. If that coincides with retries the bound can be exceeded; it is rare, and counted in the oldest-unsent metric.
- **Salesforce → portal:** Salesforce's webhook latency (≤ 15 s, Q17) + our apply < 0.1 s.

## 7. The rule when both sides change the same record

- **Different fields, any sides:** each field has its own `field_state` row and its own stamp, so both edits survive. Brief example: finance sets city=Noida at 11:00, sales sets phone at 11:30. The rows are independent and both values stay current. `city.actor=finance.user`, `phone.actor=sales.user`.
- **Same field, both on the portal:** optimistic check on `baseStamps` → the second save gets `409`. Its attempt is recorded `rejected_409`. Only the first is ever sent to Salesforce (Q4).
- **Same field, both in Salesforce:** Salesforce decides its own value. We order its webhooks by `occurredAt` (§8).
- **Same field, opposite sides:** the higher stamp wins (merge step 7), and the loser stays in `field_events` with `superseded`. The two copies then converge:
  - *Portal wins.* `value ≠ sf_value`, so the outbox sends it and Salesforce ends on the portal value.
  - *Salesforce wins.* `value = sf_value`, so the worker finds nothing to send for that field and the queued portal value is never sent.
  - *Sales edit while our PATCH is in flight.* Handled by `If-Unmodified-Since` (§6), plus the collision check below.
- **Opposite case: equal stamps.** Both time and event id equal means it is the same event, which the inbox rejects first. Equal times with different ids are ordered by the id string. That order is arbitrary but deterministic, so every replica decides the same way.

**Collision check (verification read).** The guard has two gaps: `If-Unmodified-Since` has only 1 s resolution, and Q8 may be false. To cover them, the inbound path runs one extra check:
- **Trigger.** A **non-echo** webhook (`changedBy ≠` integration user) for a record that is either in flight (its outbox row is `in_flight`) or inside the window `records.last_send_ack_at > now() − 10 s`.
- **Action.** The endpoint runs `INSERT INTO verify_queue (portal_id) … ON CONFLICT DO NOTHING`, so a record has at most one pending read.
- **Read.** The worker later issues one `GET /sobjects/{Type}/{sfId}` for the 8 in-scope fields plus `SystemModstamp`. The result is applied as a snapshot (merge step 3).
- **Result.** If Salesforce ended on an older value than `field_state.value`, then `value ≠ sf_value` and the worker re-sends. Otherwise nothing changes.

Echoes must be excluded from the trigger, because every send produces one echo: that alone would be +20 reads/s. `verify_queue` is a separate table from `outbox` because it holds only read-only calls. The inbound path therefore still never queues a *write* to Salesforce (loop layer a).

**Cost of the collision check, against the cap:**
- Records inside a window at peak: 20 sends/s × (0.5 s in flight + 10 s) = **210 records**.
- If sales edits are spread uniformly over 5 M records: 30 webhooks/s × 210 / 5,000,000 = **0.0013 reads/s**.
- Worst case, where every recently sent record is edited again by sales: the per-record `verify_queue` primary key bounds reads by sends, so ≤ **20 reads/s**.
- We **cap verification at 5 reads/s** with a sub-bucket inside the main limiter. Overflow waits in `verify_queue`, and the next reconciliation also covers it.
- Steady state: (20 writes + 5 reads) / 70 = **35.7 %** of the target (was 28.6 %). The 30 s bound still holds.
- **This changes the drain arithmetic (§10).** Catch-up spends 20/s on live writes and reserves 5/s for verification, so the backlog gets `r − 25`. At the final catch-up rate of 85/s: 432,000 ÷ 60 = 7,200 s = **120.0 min**. Unused verification tokens flow back into the drain, so this is an upper bound.

**Worked example: a sales edit at T2 lands while our PATCH from T1 is in flight.** Contact `0031A00000Abc`, field city. Clocks agree (Q6).

Before: `value = sf_value = Delhi`, `sf_stamp = sf_modstamp = 09:00:00`.
- **T1 = 11:00:00.000**: finance saves `Noida`. Outbox row inserted.
- **.150**: the worker sends `PATCH {MailingCity: Noida}` with `If-Unmodified-Since: 09:00:00` (`t_send = .150`).
- **T2 = .300**: sales saves `Pune` in Salesforce.

| Case | What Salesforce does | What we do | Final Salesforce | Final portal (actor) | Calls |
|--|--|--|--|--|--|
| **1** Sales lands first; our PATCH is processed at .400 | Pune at .300. Our PATCH → **412** (modstamp .300 > base) | `GET` → city Pune, M = .300. Step 3, using the W = 09:00 from before step 2: `P(.000) ≤ M+ε` and `P > W−ε` → unprovable (`conflict = true`, GET row recorded `unprovable`) → **wait 15 s**. Delta webhook at ~11:00:02: Pune, `(.300, evt)` > `(.000, p_…)` → `applied`, and `conflict` is cleared. Retry at 11:00:15: `value = sf_value` → payload empty → `done`, no call. | **Pune** (sales.user) | **Pune** (sales.user). History: Noida finance `applied`, Pune sales `applied`. | 2 |
| **1b** Same order, but the 412 does not fire (Q8 false, or same second as base) | Pune at .300, then our Noida at .400 → Salesforce holds **Noida** (by integration user) | 2xx: `sf_value = Noida`, `sf_stamp = t_send = .150` (a lower bound on when Salesforce applied it). Webhooks, in either order: Pune `(.300)` beats P → `value = Pune`. Echo Noida `(.400)` > `sf_stamp` → `sf_value = Noida`. Pune is non-echo and within 10 s of the ack → **verification GET**: Noida, M = .400, confirms `sf_value = Noida`. `value(Pune) ≠ sf_value(Noida)` → the worker's read path enqueues a repair → `PATCH Pune` → echo acked. | **Pune** (last modified by the integration user; the real author is in our history) | **Pune** (sales.user) | 3 |
| **2** Our PATCH is processed first, at .200 | Noida at .200, then Pune at .300 → Pune | 2xx: `sf_value = Noida`, `sf_stamp = .150`. Echo `(.200)` and Pune `(.300)`, in either order: Pune applied with `sf_value = Pune`. A late echo (.200 < .300) is ignored by the step-1 guard. Verification GET → Pune = `sf_value` → nothing. | **Pune** | **Pune** (sales.user) | 2 |
| **3** Sales edits **phone**, not city, at .300 | Phone at .300. Our PATCH → 412 (the modstamp is per record) | `GET`: city Delhi = `sf_value` → no change. Phone ≠ `sf_value` and has no pending portal edit → steps 4–7, stamp `(.300, snap…)`, actor = `LastModifiedById` → `applied`. Retry → `PATCH {city: Noida}` → 2xx. The later phone delta has the same time with `evt_` < `snap_`, so it is `superseded`, with the same value. | city **Noida**, phone new | city Noida (finance.user), phone new (sales.user) | 3 |

**Answer: does the echo overwrite "who changed the city"?** **No.** The echo is merge step 1: it changes `sf_value`/`sf_stamp` only, and only when it is newer than `sf_stamp`. `actor` stays `finance.user` (case 2: after the echo of Noida, the actor stays finance.user until the real sales edit replaces it). A history row `echo_ack` records that Salesforce confirmed the value. If Q7 fails, step 6 (`equal_value`) still keeps the actor in the common case (§9).

In every case both systems end on the value whose stamp is highest, and every value appears in `field_events`.

## 8. Duplicate webhook; older webhook after a newer one

**Duplicate rule.** The key is `inbox_events.event_id` (PRIMARY KEY = webhook `eventId`). The second delivery inserts 0 rows, so nothing else runs: no history row, no state change, and the answer is `200` so Salesforce stops retrying. Edge cases:
- Two copies arrive at once on two replicas. The second `INSERT` blocks on the first's uncommitted key.
  - First commits → the second sees a conflict and does nothing.
  - First rolls back → the second inserts and applies. Exactly one applies either way.
- Same `eventId`, different body. Still a duplicate, but we compare a SHA-256 of the body with the stored payload. A mismatch logs `inbox_payload_mismatch` and alerts, because it means Salesforce reused an id.

**Out-of-order rule.** The key is the per-field stamp `(occurredAt, eventId)`. An event whose stamp is ≤ the field's current stamp does not change `value`. It is appended to `field_events` with `outcome='superseded'`, so the older edit and its author stay in history. Only the 0-or-1-row conditional upsert decides, so arrival order never matters.

**Worked example.** Contact `0031A00000Abc`, starting state:
- `phone = +911111111111`, stamp `(11:00:00.000, evt_0990)`, actor `sales.a`.
- `city = Delhi`, stamp `(10:00, evt_0950)`.

Arrivals in order:

| Arrives | Event | occurredAt | Field / value | Outcome | `phone` after | actor |
|--|--|--|--|--|--|--|
| 1 | `evt_1001` (brief sample) | 11:30:04.000 | phone `+919876543210` by `sales.user` | stamp > (11:00, evt_0990) → `applied` | +919876543210 | sales.user |
| 2 | `evt_1001` again | — | — | inbox conflict → **duplicate**, nothing written | +919876543210 | sales.user |
| 3 | `evt_1000` (late) | 11:20:00.000 | phone `+918888888888` by `sales.b` | (11:20) < (11:30:04) → `superseded`, history only | +919876543210 | sales.user |
| 4 | portal save, finance.user | commit 11:31:10.120 | city `Noida` | different field → `applied`; outbox row inserted (portal path) | +919876543210 | city: finance.user |

Final phone history: `evt_0990 applied` → `evt_1001 applied` → `evt_1000 superseded`. The brief's question "who changed the phone?" is answered by `sales.user` at 11:30:04. The fact that `sales.b` set `+918888888888` at 11:20 is kept. The city still shows Noida by finance.user.

**Other case: a newer event arrives first and the older one never arrives.** Nothing is needed. The current value is already the newest one.

## 9. The rule that stops a loop

A write to Salesforce has exactly two possible causes:
1. A portal user's save.
2. A worker **read** (412 re-read, verification GET, reconciliation page, dirty sweep) proving that Salesforce holds a value different from `field_state.value`, where the stamps in §4 justify `value`.

Our own echo is neither, so it cannot start a write. Three layers:

- **(a) Structural.** Only the portal API and the worker's read paths insert `outbox` rows. The webhook endpoint never does; its collision trigger only inserts into `verify_queue`, which only issues GETs.
- **(b) Echo is an ack.** A webhook with `changedBy = integration@tequity.example` runs merge step 1. It updates `sf_value` and `sf_stamp`, and only if `occurredAt > sf_stamp`. It never touches `value`, `actor`, `changed_at` or the stamp. History records `echo_ack`.
- **(c) Equal value is a no-op.** The worker sends only fields where `value ≠ sf_value`. After our write is acked or echoed, `value = sf_value`, so there is nothing to send. A webhook with the current value hits merge step 6 (`equal_value`), and the actor is kept.

**Why (b) is needed even with (c).** Finance saves city v1 (P1), then v2 (P2) while v1 is in flight. The echo of v1 has `occurredAt` later than P2, because Salesforce applied v1 after P2 committed. Without (b), the stamp rule would apply the echo and turn the portal back to v1. With (b), the echo only sets `sf_value = v1`. Then `value(v2) ≠ sf_value`, the pending row sends v2, the echo of v2 is acked, and it stops.

**Bound.** Each portal save causes ≤ 1 write, plus ≤ 1 repair per read that finds Salesforce different. A repair's echo is an ack (b), and it is excluded from the collision trigger. A repair therefore cannot cause another repair unless a *human* edits again. The loop is bounded by human edits.

**Other case: Q7 false** (the echo's `changedBy` is not our user). Layer (c) still holds in the common case: equal value → `equal_value`, actor kept. The v1/v2 case above would then flip the portal back to v1 for one round, until the next sweep sees `value(v1) = sf_value(v1)`, so v2 stops being current without anyone choosing that (it stays in history, but nobody is told). That is why Q7 is a hard prerequisite, with value-matching against `sf_value` as the fallback detector.

## 10. The 6-hour Salesforce outage

**Detection.** Calls fail with connection errors, timeouts or 5xx and back off (§6B). After 20 consecutive failures the breaker **opens**, and `sync_state.breaker = {state:'open', opened_at}` is written to Postgres, so a restarted process stays open and does not hammer. While open there is one probe every 30 s: 720 probes in 6 h, each costing 1 token.

**What is on disk (Postgres, replicated; nothing lives only in memory).**

| Data | Volume over 6 h at sustained peak | Why it is enough |
|--|--|--|
| Portal edits in `field_state` + `field_events` | 20 × 21,600 = 432,000 edits | The current value and full history are committed at save time; the outage changes nothing for portal users. |
| `outbox` rows, `pending` | ≤ 432,000 (one pending row per record, so fewer if records repeat) ≈ 86 MB at ~200 B/row | This *is* the pending work. Every row survives a restart. |
| Webhooks that do arrive (endpoint still up) | ≤ 30 × 21,600 = 648,000 | Applied normally by §5. Only *lost* ones need reconciliation. |
| `sync_state.breaker`, `sync_state.reconcile_from` | 2 rows | Where to resume. |

**Restart during the outage.** The process dies and a new leader takes the advisory lock. The breaker state is read from `sync_state` (still open, probes continue). `in_flight` rows have their lease expire (≤ 15 s) and return to `pending` with their `attempts` and `next_attempt_at` intact. The outbox is never held in memory, so **no pending call is lost**. This is demo scenario 4.

**Recovery, in this order.**
1. **Probe succeeds → half-open.** 10 rows are sent; if all succeed → **closed** and the limiter switches to **catch-up, r = 85/s**.
2. **Reconcile first**, with the drain paused:
   - Query `SELECT Id, <8 fields>, SystemModstamp, LastModifiedById FROM Contact|Account WHERE SystemModstamp >= :reconcile_from ORDER BY SystemModstamp`, paged at 2,000 (Q3).
   - `reconcile_from = breaker.opened_at − 15 min`: 5 min skew margin plus 10 min for webhooks that were already in Salesforce's retry queue.
   - Each row is applied as a **snapshot** (§4, merge step 3). Fields equal to `sf_value` are skipped. Fields that differ go through the interval rule, which moves `sf_value` and `sf_modstamp`.
   - On completion: `reconcile_from = start time of this query − 5 min`. The query is idempotent, so a crash mid-reconcile simply re-runs it.
3. **Drain** the outbox at 85/s, live lane first, then backlog by oldest `next_attempt_at` (§6C), with the normal per-record payload (`value ≠ sf_value`). Live edits keep arriving at 20/s; edits to a record already pending coalesce into its row.
4. Pending < 100 → steady mode, r = 70/s.

**Why reconcile before draining.** If sales edits are spread uniformly, 648,000 / 5,000,000 = **12.96 %** of records were also changed in Salesforce. Draining first would send ~432,000 × 0.1296 ≈ **55,987** PATCHes against a stale `sf_modstamp`. Each one 412s and costs a GET plus a retry: 111,974 extra calls ÷ 60/s net drain = 1,866 s ≈ **31.1 min**. Reconciling first costs ≈ 2.2 min and makes those PATCHes either correct or unnecessary.

**Arithmetic (every division shown):**
- Outage length: 6 h × 3,600 s = **21,600 s**.
- Backlog (upper bound, every edit hits a different record): 20 edits/s × 21,600 s = **432,000 calls**.
- Reconciliation, changed records: 30 × 21,600 = 648,000 records ÷ 2,000 per page = **324 calls**. 324 ÷ 85/s = **3.8 s** of API time. Applying 648,000 rows at an assumed 5,000 merges/s: 648,000 ÷ 5,000 = 129.6 s ≈ **2.2 min** (database-bound).
- Reconciliation, absolute bound (every record changed): 5,000,000 ÷ 2,000 = 2,500 calls ÷ 85/s = 29.4 s of API time.
- **Drain (the design):** catch-up 85/s − (20/s live writes + 5/s verification reserve = 25/s) = **60/s** for the backlog. 432,000 ÷ 60 = 7,200 s ÷ 60 = **120.0 min**.
- **Total catch-up:** 3.8 s + 129.6 s + 7,200 s = 7,333 s ÷ 60 ≈ **122.2 min**.

Useful rate = `r × (1 − retry fraction)`. Reserve = 20 live + 5 verification = 25/s. Net = useful − reserve.

| Variant | Useful rate | Net drain rate | 432,000 ÷ net | Minutes |
|--|--|--|--|--|
| Steady target only | 70 | 70 − 25 = 45/s | 9,600 s | 160.0 |
| **Catch-up, design** | **85** | **85 − 25 = 60/s** | **7,200 s** | **120.0** |
| Catch-up, 5 % of calls are retries | 85 × 0.95 = 80.75 | 55.75/s | 7,749 s | 129.1 |
| Catch-up, 10 % retries | 85 × 0.90 = 76.5 | 51.5/s | 8,388 s | 139.8 |
| Catch-up, 20 % retries | 85 × 0.80 = 68 | 43/s | 10,047 s | 167.4 |
| **429 burst: limiter halves 85 → 42.5**, reserve kept | 42.5 | 42.5 − 25 = 17.5/s | 24,686 s | 411.4 |
| 429 burst, verification shed (reserve = 20 live only) | 42.5 | 42.5 − 20 = 22.5/s | 19,200 s | 320.0 |
| 429 persists, second halving to 21.25, verification shed | 21.25 | 1.25/s | 345,600 s | 5,760 (96 h) |
| Old design, catch-up 95 (rejected: 109.5 at Salesforce, §6C) | 95 | 70/s | 6,171 s | 102.9 |
| Coalesced: edits hit only 100,000 distinct records | 85 | 60/s | 100,000 ÷ 60 = 1,667 s | 27.8 |

**If 429s persist.** Salesforce is telling us that the org's real budget is smaller than ours, for example because another integration shares it.
1. **Page.** §11 #2 fires at ≥ 10 × 429 in a minute. The on-call asks the client who else is calling, and whether the limit can be raised.
2. **Shed what can wait.**
   - When `r < 50`, the verification reserve goes to 0. Collisions fall back to the next reconciliation, which runs every 15 min while shedding.
   - Reconciliation pages are deferred until `r` recovers. Only 324 calls, but they compete with live edits.
3. **Never drop edits.** Rows stay `pending`; "slow down and keep the work" (brief).
4. **Live edits in this mode.** The live lane is served first, so at `r = 42.5` live work is 20 ÷ 42.5 = 47 % utilisation (58.8 % with the verification reserve). Live edits still land in ≈ 1–2 s and the **30 s target holds**; only the backlog slows.
   - At `r = 21.25` (second halving), live writes alone use 20 of 21.25. Queueing delay rises sharply, but the target still holds while `r ≥ 20`.
   - Below 20/s (the limiter floor is 10), live edits queue at `20 − r` per second, so the **30 s target is broken by Salesforce's throttling**. The oldest-unsent alert (§11 #1) fires within 5 min.

The values without retries or 429s are upper bounds. Coalescing only shortens the drain. Unused verification tokens flow back into the drain.

**What we cannot recover.** For a record changed in Salesforce during the window whose webhooks were lost, reconciliation returns only the **latest** value, `LastModifiedById` and `SystemModstamp`. Intermediate Salesforce values from the window, and their authors, are **not recoverable** without field history (Q19). Our history records the reconciled value as `source='snapshot'`. If Salesforce later delivers delayed webhooks, they are applied normally. Older ones become `superseded`, which *adds* the missing intermediate history.

## 11. Numbers we watch, and when we call someone

| # | Number (how it is computed) | Normal | Page when | Why that value |
|--|--|--|--|--|
| 1 | **Oldest unsent outbox age** = `now() − min(created_at)` over `status IN ('pending','in_flight')` | ≈ 1 s (§6D) | **> 20 s for 5 min** while the breaker is closed | 20 s leaves 10 s before the 30 s bound is broken. 5 min filters out a single slow retry chain. While the breaker is open, page instead on **breaker open > 5 min**: that is the outage itself. |
| 2 | **Salesforce call rate**, every call counted at `limiter.take()`, and **429s per minute** | 25/s (20 writes + verification) | **Mode-aware: > r_mode + 15 for 5 min**, i.e. **> 85/s in steady mode (r = 70)** and **> 100/s in catch-up (r = 85)**; or **≥ 10 × 429 in a minute** | A fixed 85/s threshold would fire on every recovery, because catch-up runs at 85/s with bursts to 90/s. The bucket bounds our own 1 s windows at `r + 5` (75 steady, 90 catch-up), so exceeding `r + 15` means a call path bypasses the limiter: a bug, not load. Repeated 429s mean Salesforce sees a different budget than ours, for example another integration sharing the org's limit. |
| 3 | **Minutes since the last webhook** | seconds | **> 10 min, 09:00–19:00 client time** | Quiet hour = 1 edit/s, × 0.6 from Salesforce = 360 expected webhooks in 10 min. Seeing none is not chance: delivery is broken or our endpoint is rejecting. Runs reconciliation automatically, as well as paging. |
| 4 | **Clock skew**: 5-min median of `max(0, t_send − occurredAt, occurredAt − t_ack)` over our echoes (Q6) | 0 s | **> 1 s for 10 min** | 1 s = ε. Above it, interval-rule verdicts (§4 step 3) and cross-side same-field ordering can be wrong. Automatic action: set ε = 2 × measured skew until fixed. |

Also paged, but not part of the three-plus-one: **any `dead` outbox row** (an edit that will not reach Salesforce without a human), and `inbox_payload_mismatch`. Not paged, reviewed daily: count of `field_state.conflict = true` (unprovable fields awaiting a reviewer).

## 12. Left out of this weekend's work

- **Deletes and Salesforce record merges** (out of scope per the brief). A merged Account would orphan Contacts' `customer` ids, and a delete would leave `outbox` rows that 404 into `dead`.
- **The conflict-review UI.** The data exists (`conflict` flag, both values in `field_events`). The screen does not.
- **Bulk / Composite API.** These are the main lever if the drain must be faster: 25 records per Composite call would divide the 120.0 min by up to 25. Not assumed, so not used in the arithmetic.
- **Verifying assumptions Q3, Q8, Q9, Q14 and Q19 against a real org**, and a load test against real Salesforce (out of scope).
- **Postgres HA, backups, a second region.** Assumed managed, with a single primary.
- **Owner-id mapping maintenance** (Q12), field-level security, PII encryption at rest, and secret rotation for the webhook HMAC.
- **Purging `done` outbox rows** (1.73 M/day at sustained peak; a nightly delete of rows older than 7 days is the obvious answer). **History retention / partitioning** (Q16) and schema evolution of the webhook payload.
- **Per-field permissions** (who may edit which field on each side), and validation parity with Salesforce rules. Today a Salesforce validation rule rejection becomes a `dead` row.
