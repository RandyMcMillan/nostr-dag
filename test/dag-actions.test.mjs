/**
 * test/dag-actions.test.mjs
 *
 * Unit tests for the DAG button action handlers exported from
 * demo/dag/dag-actions.mjs.
 *
 * All WASM, network, and render dependencies are stubbed so these run
 * entirely in Node with no browser or wasm-pack output required.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDagActionContext, resetDag, seedGenesis, runAckRound } from '../demo/dag/dag-actions.mjs';

// ---------------------------------------------------------------------------
// Minimal WasmDag stub
// ---------------------------------------------------------------------------

class WasmDagStub {
  constructor(participantsJson) {
    this.participants = JSON.parse(participantsJson);
    this.addedEvents = [];
  }

  tip_ids() { return '[]'; }
  canonical_ids() { return '[]'; }
  add_event(json) { this.addedEvents.push(JSON.parse(json)); }
}

// ---------------------------------------------------------------------------
// Context factory helper
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  const state = {
    dag: null,
    participants: [{ pk: 'pk1' }, { pk: 'pk2' }],
    events: new Map(),
    njumpAvailability: new Map(),
    activeRepoSequence: null,
  };

  const calls = {
    ensureDagBootReady: 0,
    initParticipants: 0,
    publishProfiles: 0,
    publishEvents: [],
    render: 0,
    setStatus: [],
    createNip34Sequence: 0,
    createQuorumSequence: 0,
  };

  const fakeRepoSequence = {
    repoId: 'test-repo',
    protocolEvents: [{ id: 'e1' }, { id: 'e2' }],
  };
  const fakeQuorumSequence = {
    manifestEvent: { id: 'manifest' },
    sliceEvents: [{ id: 'slice1' }],
    attestationEvents: [{ id: 'attest1' }],
    sealEvent: { id: 'seal1' },
  };

  const ctx = createDagActionContext({
    state,
    WasmDag: WasmDagStub,
    async ensureDagBootReady() { calls.ensureDagBootReady += 1; },
    async initParticipants() {
      calls.initParticipants += 1;
      // participants already populated in state
    },
    async publishProfiles() { calls.publishProfiles += 1; },
    async publishEvents(evts, label) { calls.publishEvents.push({ evts, label }); },
    render() { calls.render += 1; },
    setStatus(msg, ok) { calls.setStatus.push({ msg, ok }); },
    async createNip34SequenceEvents() {
      calls.createNip34Sequence += 1;
      return fakeRepoSequence;
    },
    async createQuorumSequenceEvents() {
      calls.createQuorumSequence += 1;
      return fakeQuorumSequence;
    },
    ...overrides,
  });

  return { ctx, state, calls, fakeRepoSequence, fakeQuorumSequence };
}

// ---------------------------------------------------------------------------
// resetDag tests
// ---------------------------------------------------------------------------

test('resetDag skips boot-ready check when skipReadyCheck is true', async () => {
  const { ctx, calls } = makeCtx();
  await resetDag(ctx, { skipReadyCheck: true });
  assert.equal(calls.ensureDagBootReady, 0);
});

test('resetDag calls ensureDagBootReady by default', async () => {
  const { ctx, calls } = makeCtx();
  await resetDag(ctx);
  assert.equal(calls.ensureDagBootReady, 1);
});

test('resetDag creates a new WasmDag seeded with current participants', async () => {
  const { ctx, state } = makeCtx();
  await resetDag(ctx, { skipReadyCheck: true });
  assert.ok(state.dag instanceof WasmDagStub, 'state.dag should be a WasmDagStub');
  assert.deepEqual(state.dag.participants, ['pk1', 'pk2']);
});

test('resetDag clears events and njumpAvailability maps', async () => {
  const { ctx, state } = makeCtx();
  state.events.set('x', 1);
  state.njumpAvailability.set('y', true);
  await resetDag(ctx, { skipReadyCheck: true });
  assert.equal(state.events.size, 0);
  assert.equal(state.njumpAvailability.size, 0);
});

test('resetDag sets activeRepoSequence to null', async () => {
  const { ctx, state } = makeCtx();
  state.activeRepoSequence = { protocolEvents: [] };
  await resetDag(ctx, { skipReadyCheck: true });
  assert.equal(state.activeRepoSequence, null);
});

test('resetDag calls render and setStatus with success', async () => {
  const { ctx, calls } = makeCtx();
  await resetDag(ctx, { skipReadyCheck: true });
  assert.ok(calls.render >= 1);
  const lastStatus = calls.setStatus.at(-1);
  assert.ok(lastStatus.ok === true);
  assert.match(lastStatus.msg, /DAG reset/i);
});

test('resetDag calls initParticipants and publishProfiles', async () => {
  const { ctx, calls } = makeCtx();
  await resetDag(ctx, { skipReadyCheck: true });
  assert.equal(calls.initParticipants, 1);
  assert.equal(calls.publishProfiles, 1);
});

// ---------------------------------------------------------------------------
// seedGenesis tests
// ---------------------------------------------------------------------------

test('seedGenesis calls ensureDagBootReady', async () => {
  const { ctx, calls } = makeCtx();
  await seedGenesis(ctx);
  assert.equal(calls.ensureDagBootReady, 1);
});

test('seedGenesis creates NIP-34 sequence and stores it in state', async () => {
  const { ctx, state, fakeRepoSequence } = makeCtx();
  await seedGenesis(ctx);
  assert.equal(state.activeRepoSequence, fakeRepoSequence);
});

test('seedGenesis calls render after creating sequence', async () => {
  const { ctx, calls } = makeCtx();
  await seedGenesis(ctx);
  assert.ok(calls.render >= 1);
});

test('seedGenesis publishes protocol events with correct label', async () => {
  const { ctx, calls, fakeRepoSequence } = makeCtx();
  await seedGenesis(ctx);
  const publish = calls.publishEvents.find((p) => p.label === 'NIP-34 repository sequence');
  assert.ok(publish, 'should have published NIP-34 repository sequence');
  assert.deepEqual(publish.evts, fakeRepoSequence.protocolEvents);
});

test('seedGenesis catches errors and calls setStatus with failure', async () => {
  const { ctx, calls } = makeCtx({
    async createNip34SequenceEvents() { throw new Error('network down'); },
  });
  await seedGenesis(ctx);
  const errStatus = calls.setStatus.find((s) => s.ok === false);
  assert.ok(errStatus, 'should have set an error status');
  assert.match(errStatus.msg, /NIP-34 broadcast failed/);
});

// ---------------------------------------------------------------------------
// runAckRound tests
// ---------------------------------------------------------------------------

test('runAckRound calls ensureDagBootReady', async () => {
  const { ctx, calls } = makeCtx();
  await runAckRound(ctx);
  assert.equal(calls.ensureDagBootReady, 1);
});

test('runAckRound auto-seeds if activeRepoSequence is null', async () => {
  const { ctx, state, calls } = makeCtx();
  assert.equal(state.activeRepoSequence, null);
  await runAckRound(ctx);
  assert.equal(calls.createNip34Sequence, 1);
  assert.ok(state.activeRepoSequence != null);
});

test('runAckRound does NOT re-seed when activeRepoSequence already exists', async () => {
  const { ctx, state, calls, fakeRepoSequence } = makeCtx();
  state.activeRepoSequence = fakeRepoSequence;
  await runAckRound(ctx);
  assert.equal(calls.createNip34Sequence, 0);
});

test('runAckRound creates quorum sequence and renders', async () => {
  const { ctx, calls } = makeCtx();
  await runAckRound(ctx);
  assert.equal(calls.createQuorumSequence, 1);
  assert.ok(calls.render >= 1);
});

test('runAckRound publishes all quorum event types', async () => {
  const { ctx, calls, fakeQuorumSequence } = makeCtx();
  await runAckRound(ctx);
  const publish = calls.publishEvents.find((p) => p.label === 'PIP quorum sequence');
  assert.ok(publish, 'should publish PIP quorum sequence');
  // manifest + slices + attestations + seal
  assert.ok(publish.evts.includes(fakeQuorumSequence.manifestEvent));
  assert.ok(publish.evts.includes(fakeQuorumSequence.sealEvent));
  for (const s of fakeQuorumSequence.sliceEvents) assert.ok(publish.evts.includes(s));
  for (const a of fakeQuorumSequence.attestationEvents) assert.ok(publish.evts.includes(a));
});

test('runAckRound catches errors and calls setStatus with failure', async () => {
  const { ctx, calls } = makeCtx({
    async createQuorumSequenceEvents() { throw new Error('quorum exploded'); },
  });
  await runAckRound(ctx);
  const errStatus = calls.setStatus.find((s) => s.ok === false);
  assert.ok(errStatus, 'should have set an error status');
  assert.match(errStatus.msg, /Quorum sequence failed/);
});
