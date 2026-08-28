import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WASM_LIKE_BOOTSTRAP =
  '/dns4/example.com/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN';
const NATIVE_LIKE_BOOTSTRAP =
  '/ip4/127.0.0.1/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN';
const DETERMINISTIC_NATIVE_PEER_ID = '12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH';

function runNativePeer(bootstrap = WASM_LIKE_BOOTSTRAP, extraCommands = []) {
  return new Promise((resolve, reject) => {
    console.log('[native-node:test] launching cargo run --features p2p --bin p2p-node');
    const child = spawn('cargo', ['run', '--features', 'p2p', '--bin', 'p2p-node'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        P2P_BOOTSTRAP: bootstrap,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let sentCommands = false;
    let settled = false;
    const watchdog = setTimeout(() => {
      console.log('[native-node:test] timeout waiting for output, sending commands and stopping child');
      sendCommands();
      child.kill('SIGTERM');
    }, 180_000);

    const logChunk = (label, chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        console.log(`[native-node:${label}] ${line}`);
      }
    };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (err) reject(err);
      else resolve(result);
    };

    const sendCommands = () => {
      if (sentCommands) return;
      sentCommands = true;
      const commands = [...extraCommands, '/status', '/quit'];
      child.stdin.write(`${commands.join('\n')}\n`);
      child.stdin.end();
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      logChunk('stdout', chunk);
      if (/^BOOTSTRAP peers=\d+ wasm_like=\d+$/m.test(stdout)) {
        sendCommands();
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      logChunk('stderr', chunk);
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('close', (code, signal) => {
      console.log(`[native-node:test] child exited code=${code} signal=${signal ?? 'none'}`);
      finish(null, { code, signal, stdout, stderr });
    });
  });
}

async function assertNativePeerBootstrapSummary(bootstrap, expectedSummary) {
  const result = await runNativePeer(bootstrap);

  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /READY peer_id=/);
  assert.match(result.stdout, expectedSummary);
  assert.match(result.stdout, /STATUS nostr_pubkey=/);
  assert.match(result.stdout, /nat=observing/);
}

test('native p2p node reports wasm-like bootstrap peers', async () => {
  await assertNativePeerBootstrapSummary(WASM_LIKE_BOOTSTRAP, /BOOTSTRAP peers=1 wasm_like=1/);
});

test('native p2p node counts wasm-like peers inside a mixed bootstrap mesh', async () => {
  await assertNativePeerBootstrapSummary(
    [WASM_LIKE_BOOTSTRAP, NATIVE_LIKE_BOOTSTRAP].join(','),
    /BOOTSTRAP peers=2 wasm_like=1/,
  );
});

test('native p2p node publishes a nip-pip blob on demand', async () => {
  const result = await runNativePeer(WASM_LIKE_BOOTSTRAP, ['/pip hello nip-pip network']);

  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, new RegExp(`READY peer_id=${DETERMINISTIC_NATIVE_PEER_ID}\\b`));
  assert.match(result.stdout, /PIP publishing root_id=/);
  assert.match(result.stdout, /PIP manifest event=/);
  assert.match(result.stdout, /PIP publish attempted root_id=/);
});

// ---- Multi-peer helpers for round-trip tests ----

function startNativePeer({ bootstrapPeers = ',', nativeSeedHex = '' } = {}) {
  return new Promise((resolve, reject) => {
    console.log('[native-node:test] starting native peer');
    const child = spawn('cargo', ['run', '--quiet', '--features', 'p2p', '--bin', 'p2p-node'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        P2P_BOOTSTRAP: bootstrapPeers,
        ...(nativeSeedHex ? { NOSTR_DAG_NATIVE_LIBP2P_SEED_HEX: nativeSeedHex } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const stdoutLines = [];
    let peerId = '';
    let wsListenAddr = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    const observe = (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        stdoutLines.push(line);
        console.log(`[native-peer] ${line}`);
        const peerMatch = line.match(/^READY peer_id=([A-Za-z0-9]+)\b/);
        if (peerMatch) {
          peerId = peerMatch[1];
        }
        const listenMatch = line.match(/^LISTENING (\/ip4\/[^\s]+\/ws)\b/);
        if (listenMatch) {
          wsListenAddr = listenMatch[1];
        }
        if (peerId && wsListenAddr) {
          finish(null, {
            child,
            stdout,
            stderr,
            stdoutLines,
            getStdout: () => stdout,
            peerId,
            wsListenAddr,
          });
        }
      }
    };

    child.stdout.on('data', observe);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (!settled) {
        finish(new Error(`native peer exited early code=${code} signal=${signal ?? 'none'}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

function buildWsDialAddress(wsListenAddr, peerId) {
  return `${wsListenAddr}/p2p/${peerId}`;
}

function waitForLine(lines, pattern, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = lines.find((line) => pattern.test(line));
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for pattern ${pattern}`));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

test('two native peers exchange a nip-pip blob over libp2p', { timeout: 120_000 }, async () => {
  const publisher = await startNativePeer({ nativeSeedHex: '11'.repeat(32) });
  const publisherAddr = buildWsDialAddress(publisher.wsListenAddr, publisher.peerId);

  const receiver = await startNativePeer({
    bootstrapPeers: publisherAddr,
    nativeSeedHex: '22'.repeat(32),
  });

  try {
    // Wait for receiver to connect to publisher
    await waitForLine(receiver.stdoutLines, /DETECTED .* peer peer=/, 30_000);
    // Give gossipsub a moment to establish topic subscriptions
    await new Promise((r) => setTimeout(r, 2000));

    // Publisher sends PIP blob
    const pipStart = Date.now();
    publisher.child.stdin.write('/pip roundtrip-libp2p-test\n');

    // Receiver should see the inbound bridge envelopes (manifest + slice)
    await waitForLine(receiver.stdoutLines, /INBOUND bridge direction=nostr->libp2p/, 30_000);

    const rttMs = Date.now() - pipStart;
    console.log(`[native-node:test] libp2p->nostr->libp2p RTT ~${rttMs} ms`);
    assert.ok(rttMs < 30_000, `RTT ${rttMs} ms should be under 30s`);
  } finally {
    publisher.child.kill('SIGTERM');
    receiver.child.kill('SIGTERM');
  }
});

test('nip-pip round-trip logs manifest and slice event IDs', { timeout: 120_000 }, async () => {
  const publisher = await startNativePeer({ nativeSeedHex: 'aa'.repeat(32) });
  const publisherAddr = buildWsDialAddress(publisher.wsListenAddr, publisher.peerId);

  const receiver = await startNativePeer({
    bootstrapPeers: publisherAddr,
    nativeSeedHex: 'bb'.repeat(32),
  });

  try {
    await waitForLine(receiver.stdoutLines, /DETECTED .* peer peer=/, 30_000);
    await new Promise((r) => setTimeout(r, 2000));

    publisher.child.stdin.write('/pip log-store-test\n');

    const bridgeLines = [];
    const start = Date.now();
    while (bridgeLines.length < 2 && Date.now() - start < 30_000) {
      const line = receiver.stdoutLines.find((l) => /INBOUND bridge direction=nostr->libp2p/.test(l) && !bridgeLines.includes(l));
      if (line) bridgeLines.push(line);
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(bridgeLines.length, 2, 'should receive manifest and slice bridge envelopes');
    assert.ok(bridgeLines[0].includes('event='), 'bridge envelope should carry event ID');
    assert.ok(bridgeLines[1].includes('event='), 'bridge envelope should carry event ID');

    // Verify publisher also logged the staging
    await waitForLine(publisher.stdoutLines, /PIP manifest staged/, 30_000);
    await waitForLine(publisher.stdoutLines, /PIP slice staged seq=0/, 30_000);
  } finally {
    publisher.child.kill('SIGTERM');
    receiver.child.kill('SIGTERM');
  }
});
