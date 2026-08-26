/**
 * test/dag-button-ui.test.mjs
 *
 * DOM button wiring and click-simulation tests for the DAG demo page.
 *
 * Uses the same minimal-DOM-mock pattern as page-header.test.mjs — no
 * jsdom or browser required.  We build a tiny fake DOM with stubs for
 * getElementById and addEventListener, fire synthetic click events by
 * invoking the stored listener directly, then assert on observable state
 * mutations.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDagActionContext, wireButtons } from '../demo/dag/dag-actions.mjs';

// ---------------------------------------------------------------------------
// Minimal button stub
// ---------------------------------------------------------------------------

function makeButton(id) {
  const listeners = {};
  return {
    id,
    listeners,
    addEventListener(event, handler) {
      listeners[event] = handler;
    },
    // Simulate a click synchronously — returns the handler's return value.
    click() {
      if (!listeners.click) throw new Error(`No click listener on #${id}`);
      return listeners.click();
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal context factory
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  const state = {
    dag: null,
    participants: [{ pk: 'aaa' }, { pk: 'bbb' }],
    events: new Map(),
    njumpAvailability: new Map(),
    activeRepoSequence: null,
  };

  const calls = {
    resetDagCalled: 0,
    seedGenesisCalled: 0,
    runAckRoundCalled: 0,
    setStatus: [],
    render: 0,
    publishEvents: [],
  };

  const fakeSequence = { protocolEvents: [{ id: 'e1' }] };
  const fakeQuorum = {
    manifestEvent: { id: 'm' },
    sliceEvents: [],
    attestationEvents: [],
    sealEvent: { id: 'seal' },
  };

  const ctx = createDagActionContext({
    state,
    WasmDag: class {
      constructor() {}
      tip_ids() { return '[]'; }
      canonical_ids() { return '[]'; }
    },
    async ensureDagBootReady() {},
    async initParticipants() {},
    async publishProfiles() {},
    async publishEvents(evts, label) { calls.publishEvents.push({ evts, label }); },
    render() { calls.render += 1; },
    setStatus(msg, ok) { calls.setStatus.push({ msg, ok }); },
    async createNip34SequenceEvents() { return fakeSequence; },
    async createQuorumSequenceEvents() { return fakeQuorum; },
    ...overrides,
  });

  return { ctx, state, calls };
}

// ---------------------------------------------------------------------------
// wireButtons wiring tests
// ---------------------------------------------------------------------------

test('wireButtons attaches a click listener to each button', () => {
  const resetBtn = makeButton('resetBtn');
  const seedBtn = makeButton('seedBtn');
  const ackRoundBtn = makeButton('ackRoundBtn');
  const { ctx } = makeCtx();

  wireButtons({ resetBtn, seedBtn, ackRoundBtn }, ctx);

  assert.ok(typeof resetBtn.listeners.click === 'function', 'resetBtn should have click listener');
  assert.ok(typeof seedBtn.listeners.click === 'function', 'seedBtn should have click listener');
  assert.ok(typeof ackRoundBtn.listeners.click === 'function', 'ackRoundBtn should have click listener');
});

// ---------------------------------------------------------------------------
// Button click → handler execution tests
// ---------------------------------------------------------------------------

test('clicking resetBtn triggers resetDag — clears events and sets status', async () => {
  const resetBtn = makeButton('resetBtn');
  const seedBtn = makeButton('seedBtn');
  const ackRoundBtn = makeButton('ackRoundBtn');
  const { ctx, state, calls } = makeCtx();

  state.events.set('old', { id: 'old' });
  wireButtons({ resetBtn, seedBtn, ackRoundBtn }, ctx);

  // Fire click and wait for the async handler to settle
  await resetBtn.click();
  // resetDag returns a void promise; the listener wraps it in void so we need to
  // wait a microtask beat for any pending promise chains to flush.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(state.events.size, 0, 'events map should be cleared after reset');
  const statusCall = calls.setStatus.find((s) => s.ok === true && /DAG reset/i.test(s.msg));
  assert.ok(statusCall, 'resetDag should emit DAG reset status');
});

test('clicking seedBtn triggers seedGenesis — populates activeRepoSequence', async () => {
  const resetBtn = makeButton('resetBtn');
  const seedBtn = makeButton('seedBtn');
  const ackRoundBtn = makeButton('ackRoundBtn');
  const { ctx, state } = makeCtx();

  wireButtons({ resetBtn, seedBtn, ackRoundBtn }, ctx);
  await seedBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(state.activeRepoSequence != null, 'activeRepoSequence should be populated after seed');
});

test('clicking ackRoundBtn triggers runAckRound — publishes PIP quorum events', async () => {
  const resetBtn = makeButton('resetBtn');
  const seedBtn = makeButton('seedBtn');
  const ackRoundBtn = makeButton('ackRoundBtn');
  const { ctx, calls } = makeCtx();

  wireButtons({ resetBtn, seedBtn, ackRoundBtn }, ctx);
  await ackRoundBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  const pipPublish = calls.publishEvents.find((p) => p.label === 'PIP quorum sequence');
  assert.ok(pipPublish, 'runAckRound should publish PIP quorum sequence');
});

test('clicking seedBtn twice uses the same sequence on second click', async () => {
  const resetBtn = makeButton('resetBtn');
  const seedBtn = makeButton('seedBtn');
  const ackRoundBtn = makeButton('ackRoundBtn');

  let callCount = 0;
  const firstSeq = { protocolEvents: [{ id: 'first' }] };
  const { ctx, state } = makeCtx({
    async createNip34SequenceEvents() {
      callCount += 1;
      return firstSeq;
    },
  });

  wireButtons({ resetBtn, seedBtn, ackRoundBtn }, ctx);
  await seedBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  // seedGenesis always re-creates, but ackRound reuses — verify ackRound does not re-call
  const seqAfterSeed = state.activeRepoSequence;
  await ackRoundBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  // createNip34SequenceEvents should have been called once by seed, not again by ackRound
  assert.equal(callCount, 1, 'createNip34SequenceEvents should not be called again by runAckRound when sequence exists');
  assert.equal(state.activeRepoSequence, seqAfterSeed, 'activeRepoSequence should be unchanged');
});

test('seedBtn click error is caught and sets error status', async () => {
  const resetBtn = makeButton('resetBtn');
  const seedBtn = makeButton('seedBtn');
  const ackRoundBtn = makeButton('ackRoundBtn');
  const { ctx, calls } = makeCtx({
    async createNip34SequenceEvents() { throw new Error('seed exploded'); },
  });

  wireButtons({ resetBtn, seedBtn, ackRoundBtn }, ctx);
  await seedBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  const errStatus = calls.setStatus.find((s) => s.ok === false);
  assert.ok(errStatus, 'should report error status');
  assert.match(errStatus.msg, /NIP-34 broadcast failed/);
});
