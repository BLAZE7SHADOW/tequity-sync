// Per-field merge rule: docs/design.md §4 "Merge rule", steps 1–7.
// Pure: no I/O. This is the only code that decides field_state.value.

export const INTEGRATION_USER = 'integration@tequity.example';
export const EPS_MS = 1000; // ε, clock-skew margin (Q6)

export type Source = 'portal' | 'salesforce' | 'snapshot';
export type Outcome = 'applied' | 'superseded' | 'equal_value' | 'echo_ack' | 'unprovable';

export interface FieldState {
  value: unknown;
  stampTime: number;        // ms epoch; ordering key part 1
  stampEventId: string;     // ordering key part 2 (tie-break)
  actor: string;            // who last CHANGED the value
  changedAt: number;
  source: Source;
  sfValue: unknown;         // last value we know Salesforce holds
  sfStamp: number | null;   // W: last time we knew Salesforce held sfValue
  conflict: boolean;
}

export interface FieldEvent {
  value: unknown;
  stampTime: number;        // occurredAt | commit time | SystemModstamp (M) for snapshots
  eventId: string;
  actor: string;
  source: Source;
}

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Compare stamps as (time, eventId) pairs. */
export function cmpStamp(t1: number, id1: string, t2: number, id2: string): number {
  if (t1 !== t2) return t1 < t2 ? -1 : 1;
  return id1 < id2 ? -1 : id1 > id2 ? 1 : 0;
}

/** True when the field holds a portal edit Salesforce does not have yet. */
export const hasUnsentPortalEdit = (s: FieldState): boolean => s.source === 'portal' && !same(s.value, s.sfValue);

export function merge(S: FieldState | undefined, E: FieldEvent): { state: FieldState; outcome: Outcome } {
  const fresh = (): FieldState => ({
    value: E.value, stampTime: E.stampTime, stampEventId: E.eventId, actor: E.actor,
    changedAt: E.stampTime, source: E.source,
    sfValue: E.source === 'portal' ? null : E.value,
    sfStamp: E.source === 'portal' ? null : E.stampTime,
    conflict: false,
  });

  // Step 4 (no state yet) also covers an echo for a field we never stored.
  if (!S) return { state: fresh(), outcome: 'applied' };

  // Step 1: echo of our own write is an ack: sf_value only, guarded by sf_stamp.
  if (E.source === 'salesforce' && E.actor === INTEGRATION_USER) {
    const st = { ...S };
    if (st.sfStamp === null || E.stampTime > st.sfStamp) { st.sfValue = E.value; st.sfStamp = E.stampTime; }
    return { state: st, outcome: 'echo_ack' };
  }

  const W = S.sfStamp;          // read BEFORE step 2 updates it
  const oldSfValue = S.sfValue;
  const st: FieldState = { ...S };

  // Step 2: track what Salesforce holds.
  if (E.source !== 'portal' && (st.sfStamp === null || E.stampTime > st.sfStamp)) {
    st.sfValue = E.value; st.sfStamp = E.stampTime;
  }

  // Step 3: snapshot against an unsent portal edit: interval rule.
  if (E.source === 'snapshot' && !same(E.value, oldSfValue) && hasUnsentPortalEdit(S)) {
    const P = S.stampTime, M = E.stampTime, w = W ?? Number.NEGATIVE_INFINITY;
    if (P > M + EPS_MS) return { state: st, outcome: 'superseded' };              // portal provably later
    if (P <= w - EPS_MS) return { state: applyE(st, E), outcome: 'applied' };     // Salesforce provably later
    return { state: { ...st, conflict: true }, outcome: 'unprovable' };           // keep portal, flag
  }

  const c = cmpStamp(E.stampTime, E.eventId, S.stampTime, S.stampEventId);
  const clearConflict = E.source !== 'snapshot'; // a delta has an exact time
  // Step 5: older or equal stamp.
  if (c <= 0) return { state: clearConflict ? { ...st, conflict: false } : st, outcome: 'superseded' };
  // Step 6: same value: advance the stamp, keep actor and changedAt.
  if (same(E.value, S.value)) {
    return { state: { ...st, stampTime: E.stampTime, stampEventId: E.eventId, conflict: clearConflict ? false : st.conflict }, outcome: 'equal_value' };
  }
  // Step 7: newer stamp wins.
  const applied = applyE(st, E);
  if (clearConflict) applied.conflict = false;
  return { state: applied, outcome: 'applied' };
}

function applyE(st: FieldState, E: FieldEvent): FieldState {
  return { ...st, value: E.value, stampTime: E.stampTime, stampEventId: E.eventId, actor: E.actor, changedAt: E.stampTime, source: E.source };
}
