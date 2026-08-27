/**
 * dag-actions.mjs
 *
 * Extracted button action handlers for the nostr-dag demo page.
 *
 * Each action (resetDag, seedGenesis, runAckRound) is a pure function that
 * receives a `ctx` (context) object containing all live state and dependency
 * references instead of closing over module-level variables.  This makes the
 * handlers independently importable and fully testable in Node without a
 * browser or WASM runtime.
 *
 * Usage from demo/dag/index.html (wiring example):
 *
 *   import { resetDag, seedGenesis, runAckRound } from './dag-actions.mjs';
 *
 *   document.getElementById('resetBtn').addEventListener('click', () =>
 *     resetDag(ctx));
 *   document.getElementById('seedBtn').addEventListener('click', () =>
 *     seedGenesis(ctx));
 *   document.getElementById('ackRoundBtn').addEventListener('click', () =>
 *     runAckRound(ctx));
 *
 * The `ctx` shape is documented on the `createDagActionContext` factory below.
 */

/**
 * Create a context object for the DAG action handlers.
 *
 * @param {object} deps - Live state and dependency injections.
 * @param {object}   deps.state         - Mutable shared state bag.
 * @param {Function} deps.WasmDag       - WasmDag constructor (from wasm-bindgen pkg).
 * @param {Function} deps.ensureDagBootReady  - async () => void — waits for WASM boot.
 * @param {Function} deps.initParticipants    - async () => void — populates state.participants.
 * @param {Function} deps.publishProfiles     - async () => void — broadcasts profile events.
 * @param {Function} deps.publishEvents       - async (events, label) => void.
 * @param {Function} deps.render              - () => void — re-renders the dashboard.
 * @param {Function} deps.setStatus           - (message, ok?) => void.
 * @param {Function} deps.createNip34SequenceEvents   - async () => repoSequence.
 * @param {Function} deps.createQuorumSequenceEvents  - async (repoSequence) => quorumSequence.
 * @param {object}   [deps.log]         - Optional logger ({ log(ns, msg, level, state) }).
 * @returns {object} Context object consumed by the action functions.
 */
export function createDagActionContext(deps) {
  return { ...deps };
}

/**
 * Reset the DAG: re-initialise participants, create a fresh WasmDag, clear
 * event and availability caches, and re-render.
 *
 * Corresponds to clicking the "Reset DAG" button.
 *
 * @param {ReturnType<createDagActionContext>} ctx
 * @param {object} [options]
 * @param {boolean} [options.skipReadyCheck=false] - Skip the boot-ready guard
 *   (useful in tests where WASM is stubbed out).
 */
export async function resetDag(ctx, options = {}) {
  if (!options.skipReadyCheck) {
    await ctx.ensureDagBootReady();
  }
  ctx.log?.log('demo', 'Reset DAG clicked', 'info', 'checking');
  ctx.log?.log('demo', 'resetting DAG', 'info', 'checking');
  ctx.log?.log('demo', 'reset: reinitializing participants', 'trace', 'checking');
  await ctx.initParticipants();
  ctx.log?.log('demo', `reset: creating fresh DAG for ${ctx.state.participants.length} participants`, 'info', 'checking');
  ctx.state.dag = new ctx.WasmDag(
    JSON.stringify(ctx.state.participants.map((p) => p.pk)),
  );
  ctx.state.events.clear();
  ctx.state.njumpAvailability.clear();
  ctx.state.activeRepoSequence = null;
  ctx.log?.log('demo', 'reset: cleared events, njump cache, and active repo sequence', 'trace', 'available');
  ctx.render();
  ctx.setStatus('WASM loaded. DAG reset with 5 participants.', true);
  ctx.log?.log('demo', 'reset: publishing participant profiles', 'info', 'checking');
  await ctx.publishProfiles();
  ctx.log?.log('demo', 'reset complete', 'info', 'available');
}

/**
 * Broadcast a NIP-34 repository sequence (seed genesis events).
 *
 * Corresponds to clicking the "Broadcast NIP-34 Sequence" button.
 *
 * @param {ReturnType<createDagActionContext>} ctx
 */
export async function seedGenesis(ctx) {
  try {
    await ctx.ensureDagBootReady();
    ctx.log?.log('demo', 'Broadcast NIP-34 Sequence clicked', 'info', 'checking');
    ctx.log?.log('demo', 'broadcast: creating NIP-34 repository sequence', 'info', 'checking');
    ctx.state.activeRepoSequence = await ctx.createNip34SequenceEvents();
    ctx.log?.log(
      'demo',
      `broadcast: created ${ctx.state.activeRepoSequence.protocolEvents.length} protocol events`,
      'trace',
      'available',
    );
    ctx.render();
    ctx.log?.log('demo', 'broadcast: publishing NIP-34 protocol events', 'info', 'checking');
    await ctx.publishEvents(
      ctx.state.activeRepoSequence.protocolEvents,
      'NIP-34 repository sequence',
    );
    ctx.log?.log('demo', 'broadcast complete', 'info', 'available');
  } catch (e) {
    ctx.setStatus(`NIP-34 broadcast failed: ${e.message}`, false);
    ctx.log?.log('demo', `broadcast failed: ${e.message}`, 'error', 'unavailable');
  }
}

/**
 * Run a PIP quorum attestation sequence.  If no repository sequence exists yet
 * it is created first (mirrors the original "auto-seed" logic).
 *
 * Corresponds to clicking the "Run Quorum Sequence" button.
 *
 * @param {ReturnType<createDagActionContext>} ctx
 */
export async function runAckRound(ctx) {
  try {
    await ctx.ensureDagBootReady();
    ctx.log?.log('demo', 'Run Quorum Sequence clicked', 'info', 'checking');
    if (!ctx.state.activeRepoSequence) {
      ctx.log?.log('demo', 'quorum: no active repo sequence, auto-broadcasting first', 'debug', 'checking');
      ctx.state.activeRepoSequence = await ctx.createNip34SequenceEvents();
      ctx.log?.log(
        'demo',
        `quorum: auto-seeded ${ctx.state.activeRepoSequence.protocolEvents.length} protocol events`,
        'trace',
        'available',
      );
      ctx.log?.log('demo', 'quorum: publishing auto-seeded protocol events', 'debug', 'checking');
      await ctx.publishEvents(
        ctx.state.activeRepoSequence.protocolEvents,
        'NIP-34 repository sequence',
      );
    }
    ctx.log?.log('demo', 'quorum: creating quorum attest/manifest/slice/seal events', 'info', 'checking');
    const quorumSequence = await ctx.createQuorumSequenceEvents(
      ctx.state.activeRepoSequence,
    );
    ctx.log?.log(
      'demo',
      `quorum: prepared manifest + ${quorumSequence.sliceEvents.length} slices + ${quorumSequence.attestationEvents.length} attestations + seal`,
      'trace',
      'available',
    );
    ctx.render();
    ctx.log?.log('demo', 'quorum: publishing quorum events', 'info', 'checking');
    await ctx.publishEvents(
      [
        quorumSequence.manifestEvent,
        ...quorumSequence.sliceEvents,
        ...quorumSequence.attestationEvents,
        quorumSequence.sealEvent,
      ],
      'PIP quorum sequence',
    );
    ctx.log?.log('demo', 'quorum run complete', 'info', 'available');
  } catch (e) {
    ctx.setStatus(`Quorum sequence failed: ${e.message}`, false);
    ctx.log?.log('demo', `quorum run failed: ${e.message}`, 'error', 'unavailable');
  }
}

/**
 * Wire the three action buttons to their handlers.
 *
 * @param {object} buttons
 * @param {EventTarget} buttons.resetBtn
 * @param {EventTarget} buttons.seedBtn
 * @param {EventTarget} buttons.ackRoundBtn
 * @param {ReturnType<createDagActionContext>} ctx
 */
export function wireButtons(buttons, ctx) {
  buttons.resetBtn.addEventListener('click', () => { void resetDag(ctx); });
  buttons.seedBtn.addEventListener('click', () => { void seedGenesis(ctx); });
  buttons.ackRoundBtn.addEventListener('click', () => { void runAckRound(ctx); });
}
