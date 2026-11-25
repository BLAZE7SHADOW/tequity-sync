import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, INTEGRATION_USER, type FieldState, type FieldEvent } from '../src/merge.ts';

const t = (hms: string) => Date.parse(`2026-11-02T${hms}Z`);
const sfEv = (value: string, hms: string, id: string, actor = 'sales.user@client.example'): FieldEvent =>
  ({ value, stampTime: t(hms), eventId: id, actor, source: 'salesforce' });
const synced = (value: string, hms: string, id: string, actor: string): FieldState =>
  ({ value, stampTime: t(hms), stampEventId: id, actor, changedAt: t(hms), source: 'salesforce', sfValue: value, sfStamp: t(hms), conflict: false });

test('§8 out of order: an older event after a newer one is history only', () => {
  let s: FieldState = synced('+911111111111', '11:00:00.000', 'evt_0990', 'sales.a');
  const r1 = merge(s, sfEv('+919876543210', '11:30:04.000', 'evt_1001'));
  assert.equal(r1.outcome, 'applied'); s = r1.state;
  const r2 = merge(s, sfEv('+918888888888', '11:20:00.000', 'evt_1000', 'sales.b'));
  assert.equal(r2.outcome, 'superseded');
  assert.equal(r2.state.value, '+919876543210');
  assert.equal(r2.state.actor, 'sales.user@client.example');
});

test('§4 step 6: equal value advances the stamp so a late in-between event cannot apply', () => {
  const s0 = synced('A', '10:00:00.000', 'evt_1', 'x');
  const r1 = merge(s0, sfEv('A', '10:30:00.000', 'evt_3', 'y'));
  assert.equal(r1.outcome, 'equal_value');
  assert.equal(r1.state.actor, 'x');
  const r2 = merge(r1.state, sfEv('B', '10:15:00.000', 'evt_2'));
  assert.equal(r2.outcome, 'superseded');
  assert.equal(r2.state.value, 'A');
});

test('§4 tie-break: equal times are ordered by event id string', () => {
  const s0 = synced('A', '10:00:00.000', 'evt_5', 'x');
  assert.equal(merge(s0, sfEv('B', '10:00:00.000', 'evt_4')).outcome, 'superseded');
  assert.equal(merge(s0, sfEv('B', '10:00:00.000', 'evt_6')).outcome, 'applied');
});

test('§9(b) echo is an ack: value and actor unchanged; late echo cannot hide a newer sales value', () => {
  const portal: FieldState = { value: 'Noida', stampTime: t('11:00:00.000'), stampEventId: 'p_1', actor: 'finance.user@client.example',
    changedAt: t('11:00:00.000'), source: 'portal', sfValue: 'Delhi', sfStamp: t('09:00:00.000'), conflict: false };
  const echo = merge(portal, sfEv('Noida', '11:00:00.400', 'evt_e', INTEGRATION_USER));
  assert.equal(echo.outcome, 'echo_ack');
  assert.equal(echo.state.actor, 'finance.user@client.example');
  assert.equal(echo.state.sfValue, 'Noida');
  // case 2 of the §7 race: sales Pune (.300) arrives first, then our echo (.200)
  const pune = merge(portal, sfEv('Pune', '11:00:00.300', 'evt_p'));
  assert.equal(pune.state.value, 'Pune');
  const late = merge(pune.state, sfEv('Noida', '11:00:00.200', 'evt_e2', INTEGRATION_USER));
  assert.equal(late.state.sfValue, 'Pune', 'late echo must not overwrite sf_value');
});

// §4 step 3, worked examples A/B/C. W = 08:00, M = 10:00.
const pending = (P: string, W: string): FieldState => ({ value: 'Noida', stampTime: t(P), stampEventId: 'p_x', actor: 'finance.user@client.example',
  changedAt: t(P), source: 'portal', sfValue: 'Delhi', sfStamp: t(W), conflict: false });
const snap = (value: string): FieldEvent => ({ value, stampTime: t('10:00:00.000'), eventId: 'snap_1', actor: 'sales.user@client.example', source: 'snapshot' });

test('§4 step 3 case A: portal provably later keeps the portal value', () => {
  const r = merge(pending('10:30:00.000', '08:00:00.000'), snap('Pune'));
  assert.equal(r.outcome, 'superseded'); assert.equal(r.state.value, 'Noida'); assert.equal(r.state.sfValue, 'Pune');
});
test('§4 step 3 case B: Salesforce provably later applies the snapshot', () => {
  const r = merge(pending('07:59:30.000', '08:00:00.000'), snap('Pune'));
  assert.equal(r.outcome, 'applied'); assert.equal(r.state.value, 'Pune');
});
test('§4 step 3 case C: unprovable keeps the portal value and flags it; a later delta clears the flag', () => {
  const r = merge(pending('09:00:00.000', '08:00:00.000'), snap('Pune'));
  assert.equal(r.outcome, 'unprovable'); assert.equal(r.state.value, 'Noida'); assert.equal(r.state.conflict, true);
  const d = merge(r.state, sfEv('Pune', '09:30:00.000', 'evt_d'));
  assert.equal(d.state.value, 'Pune'); assert.equal(d.state.conflict, false);
});
