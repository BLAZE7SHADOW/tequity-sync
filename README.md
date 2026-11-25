# Tequity Round 1: two-way Salesforce ↔ portal sync

- Brief: [docs/brief.md](docs/brief.md)
- **Design (main deliverable): [docs/design.md](docs/design.md)**
- Code (optional): a TypeScript demo of the design's rules against a fake Salesforce.

## Run

Needs Node.js ≥ 20.6. No API keys and no real Salesforce: the fake CRM runs in-process on localhost.

```sh
npm install && npm run demo   # ~17 s, prints PASS/FAIL per check, exit code 1 on any failure
npm test                      # 15 unit/integration tests (node:test)
```

## What each demo scenario proves

| # | Scenario | Rule proved | Design |
|--|--|--|--|
| 1 | Fake Salesforce delivers `evt_…` twice | Duplicate: both answered 200, applied once (one history row). Key = `eventId` in the inbox. | §8, §5 step 4a |
| 2 | Two sales edits delivered newest-first | Out of order: the newer value stays current; the older is kept in history as `superseded`, with its author. Key = `(occurredAt, eventId)` per field. | §8, §4 steps 5–7 |
| 3 | Finance sets city; Salesforce echoes our write back | Loop: exactly 1 PATCH; the echo is `echo_ack`; "who changed the city" stays finance.user; nothing left to send. The sales phone survives beside the finance city (different fields). | §9, §4 step 1, §7 |
| 4 | Fake Salesforce down; portal edit; our process exits (row also left `in_flight`, as a mid-call crash would leave it); new process starts | The pending call is on disk after the restart, the lease expires, nothing reaches Salesforce while it is down, and the call is delivered when it comes back. | §10, §6B lease |
| 5 | 12 portal creates with a demo cap of 4/s + burst 1, and two forced 429s | The cap is enforced on every call including retries (max seen by Salesforce in any 1 s window ≤ 5). A 429 halves the rate, honours `Retry-After`, keeps the work. Creates are upserts by `Portal_Id__c`. | §6C, §6 A0 |

Scenario 5 peaks well under the cap, because the 429s halve the rate early. `test/limiter.test.ts` shows the bucket running close to its bound (≤ rate + capacity) without 429s.

## Where the code differs from the doc (deliberately)

The rule is that the code must match the doc. Where they disagreed, the line below says which one was fixed.

- **Store.** The doc says Postgres. The demo uses `FileStore` behind the same `Store` interface: whole-state atomic write (temp file + rename) per transaction, and serialised transactions standing in for `FOR UPDATE`. Single process only.
- **Portal stamp tick.** The doc says `+1 µs`, the demo uses `+1 ms` (JS clock resolution). The rule itself, `GREATEST(now, current + tick)`, was **missing from the doc** until a demo test caught a same-millisecond lost save. **Doc and code were fixed together** (commit `a089366`).
- **Limiter floor.** The doc's floor is 10/s (for r = 70/85). The demo passes floor 1, because its demo rate is 4/s.
- **Field mapping (Q12) is omitted.** The fake Salesforce uses our field names.
- **Not implemented in code** (doc only; not needed for the four required checks):
  - circuit breaker and probes
  - live lane and the 70↔85 mode switch (the limiter takes one configured rate)
  - collision trigger and `verify_queue` (§5 step 4f, §7)
  - reconciliation (§10)
  - advisory-lock leader election
  - the 30 s metrics (§11)

  412 re-read with the 15 s "unprovable" wait **is** implemented. So are the dirty sweep and the retry-merge into an existing pending row.

## Requirement → section checklist

| Brief requirement | Where it is met |
|--|--|
| Assumptions + questions at the top, incl. the brief's five, each with "what changes if it flips" | §1 Q1–Q5 (the brief's five), Q6–Q21 |
| Peak and quiet edit rate, used in the arithmetic | §1 Q1; §10 arithmetic |
| Delta vs full record: pick one, say what happens in the other case | §1 Q2 + closing line; §4 step 3 |
| Can we query what changed in 6 h? | §1 Q3; §10 reconciliation |
| Two portal users, same field: what the other sees, what goes to Salesforce | §1 Q4; §6A step 2; §7 |
| Order and actor for a portal edit (sample has no time) | §1 Q5; §4 "Stamp"; §6A |
| Webhook fields added, and why | §1 Q14 (`systemModstamp`, `portalId`) |
| One service or two; what crosses the boundary | §2 (two deployables; the Postgres schema, with a table-ownership table) |
| Who calls whom, network boundary, interface each side | §2 diagram + interfaces (A), (portal), (B) |
| Subproblems named first, in risk order, components only when needed | §3 |
| Data stored | §4 schema |
| Inbound path | §5 |
| Outbound path | §6 |
| Visible within 30 s while both are up | §6D |
| Both sides create / update | §5 step 4b (Salesforce create), §6 A0 (portal create), §6A (update) |
| History: earlier values, who, when; no dropped change | §4 `field_events` (append-only, losers included); §8 example |
| Same record edited concurrently: different fields survive, same field one current value + history | §7 (incl. the T1/T2 in-flight race walkthrough) |
| Field that decides which edit is current, on a webhook and on a portal save | §4 "Stamp" (`stamp_time` = `occurredAt` / commit time) |
| **Duplicate webhook rule** | §8 |
| **Out-of-order rule** | §8 (+ worked example on `evt_1001`) |
| **Loop rule** | §9 |
| **6-hour outage: on disk, drain, minutes with division shown** | §10 (120.0 min design drain; 122.2 min total; variants incl. retries 5/10/20 % and the 429 burst) |
| ≤ 100 req/s including retries; slow down on request and keep the work | §6C (bucket bound + jitter, catch-up 85/s), §6B 429 row |
| Pending calls survive our restart | §6B lease; §10 restart; demo scenario 4 |
| APIs we need that the brief does not give, marked as assumptions | §1 Q3, Q8, Q9, Q14, Q19, Q20; §6 A0 (external-id relationship) |
| Three numbers to watch + paging values | §11 (three + measured clock skew) |
| Left out this weekend | §12 |
| Code: TypeScript, Node ≥ 20, fake CRM, one command, cap enforced | this README; `npm run demo` |

## Note on the git history

Commit `ce77e7b` ("Phase 8 self-review: 16 fixes …") lists **14 numbered groups**, not 16; some groups hold two fixes, and the headline count is loose. It is left unamended on purpose: the brief asks for an unrewritten history. Commits `22089f0`…`2eed26a` and the demo commit record two wrong turns found while coding: the same-millisecond stamp bug (doc and code fixed), and a demo timeline error (demo fixed, rule unchanged).
