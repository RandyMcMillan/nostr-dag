import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const WASM_LIKE_BOOTSTRAP =
  '/dns4/example.com/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN';

function runNativePeer() {
  return new Promise((resolve, reject) => {
    console.log('[native-node:test] launching cargo run --features p2p --bin p2p-node');
    const child = spawn('cargo', ['run', '--features', 'p2p', '--bin', 'p2p-node'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        P2P_BOOTSTRAP: WASM_LIKE_BOOTSTRAP,
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
      child.stdin.write('/status\n/quit\n');
      child.stdin.end();
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      logChunk('stdout', chunk);
      if (stdout.includes('BOOTSTRAP peers=1 wasm_like=1')) {
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

test('native p2p node reports wasm-like bootstrap peers', async () => {
  const result = await runNativePeer();

  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /READY peer_id=/);
  assert.match(result.stdout, /BOOTSTRAP peers=1 wasm_like=1/);
  assert.match(result.stdout, /STATUS nostr_pubkey=/);
  assert.match(result.stdout, /nat=observing/);
});
