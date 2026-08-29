/**
 * Curl-based smoke test that verifies the git viewer page actually serves
 * working HTML and the CORS proxy forwards git smart-HTTP requests.
 *
 * The user explicitly asked for curl verification instead of assuming the
 * page works: "dont assume the page is working until you curl it!!"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

function curl(url, opts = []) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-L', ...opts, url];
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

test('git page HTML contains expected repos via curl', { timeout: 30_000 }, async () => {
  const html = await curl(`${BASE}/git/`);
  assert.ok(html.includes('nostr-dag'), 'page should mention nostr-dag');
  assert.ok(html.includes('isomorphic-git'), 'page should mention isomorphic-git');
  assert.ok(html.includes('Git Viewer'), 'page title should be present');
});

test('proxy forwards info/refs via curl', { timeout: 30_000 }, async () => {
  const proxyUrl = `${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`;
  const body = await curl(proxyUrl, ['-H', 'User-Agent: git/2.0']);
  assert.ok(body.includes('001e# service=git-upload-pack'), 'should get git-upload-pack advertisement');
});

test('shared libp2p-stack module is served via curl', { timeout: 10_000 }, async () => {
  const body = await curl(`${BASE}/shared/libp2p-stack.mjs`);
  assert.ok(body.includes('createSharedLibp2pStack'), 'libp2p-stack.mjs should export createSharedLibp2pStack');
});
