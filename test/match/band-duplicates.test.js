// 「策略无限制」deployment switch (SP_BAND_DUPLICATES=1): with it on, teammates in one fixed pool group may pick the
// same strategy; with it off the official 「队友已选」 rule stands. The public draft tells the client which mode it is,
// so the room UI stops marking a taken strategy as unavailable.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

/** Start a co-op match with three humans and hand back the match plus the draft order. */
function draft(seed = 5) {
  const h = makeMatch({ mode: 'coop', humans: 3, seed }).start();
  const m = h.m;
  for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  return { h, m, order: m.draft.order.slice() };
}

afterEach(() => {
  delete process.env.SP_BAND_DUPLICATES;
});

test('default: a strategy a teammate already took is still refused, and the draft says duplicates are not allowed', () => {
  const { m, order } = draft();
  const [first, second, third] = order;
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true });
  assert.equal(m.publicView().draft.duplicatesAllowed, false);
  assert.equal(m.handle(second, { t: 'g.band', bandId: 'band_sarkazb' }).error, ERR.BAD_TARGET);
  assert.equal(m.draftTurn(), second, 'the refused pick keeps the turn');
  m.dispose();
  void third;
});

test('SP_BAND_DUPLICATES=1: a teammate may pick the same strategy, and the public draft announces it', () => {
  process.env.SP_BAND_DUPLICATES = '1';
  const { h, m, order } = draft();
  const [first, second, third] = order;
  assert.equal(m.publicView().draft.duplicatesAllowed, true);
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true });
  assert.deepEqual(m.handle(second, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true }, 'duplicates allowed');
  assert.equal(h.ps(second).bandId, 'band_sarkazb');
  assert.equal(h.ps(second).lp, 45, 'the same strategy pays its own starting LP');
  // the third player can duplicate as well, and the draft still finishes normally
  assert.deepEqual(m.handle(third, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  m.dispose();
});

test('SP_BAND_DUPLICATES=1 does not loosen anything else: a pick still needs your turn and a known strategy', () => {
  process.env.SP_BAND_DUPLICATES = '1';
  const { m, order } = draft();
  const [first, second] = order;
  assert.equal(m.handle(second, { t: 'g.band', bandId: 'band_amiya' }).error, ERR.NOT_YOUR_TURN);
  assert.equal(m.handle(first, { t: 'g.band', bandId: 'nope' }).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
  assert.equal(m.handle(first, { t: 'g.band', bandId: 'band_amiya' }).error, ERR.ALREADY, 'one pick per player');
  m.dispose();
});

test('with the switch on, a timed-out turn takes the highlighted strategy even when a teammate holds it', () => {
  process.env.SP_BAND_DUPLICATES = '1';
  const { h, m, order } = draft();
  const [first, second] = order;
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true });
  // the second player highlights the same strategy; when their turn runs out the highlighted one is taken
  m.handle(second, { t: 'g.bandFocus', bandId: 'band_sarkazb' });
  h.sched.advance(60_000);
  assert.equal(h.ps(second).bandId, 'band_sarkazb', 'timeout keeps the highlighted duplicate');
  m.dispose();
});
