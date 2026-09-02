/**
 * Cross-browser chat test: Chrome ↔ Safari (WebKit).
 *
 * This test verifies that two different browser engines can exchange chat
 * messages through the libp2p gossipsub mesh (with localStorage fallback
 * for same-origin cross-browser on localhost).
 *
 * Required tools:
 *   - Playwright (npm dependency)
 *   - Chromium browser binary (auto-installed via playwright install chromium)
 *   - WebKit browser binary (auto-installed via playwright install webkit)
 *
 * The test auto-installs missing browsers before running.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';

const BASE = process.env.SERVER_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';
const INSTALL_TIMEOUT_MS = 300_000;

async function serverHealthy() {
  try {
    const res = await fetch(`${BASE}/chat`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 302 || res.status === 304;
  } catch {
    return false;
  }
}

function ensureBrowsersInstalled() {
  const browsers = ['chromium', 'webkit'];
  for (const name of browsers) {
    try {
      const result = spawnSync('npx', ['playwright', 'install', '--with-deps', name], {
        timeout: INSTALL_TIMEOUT_MS,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (result.status !== 0 && result.stderr) {
        console.warn(`playwright install ${name} warning:`, result.stderr.slice(0, 500));
      }
    } catch (err) {
      console.warn(`playwright install ${name} failed:`, err.message);
    }
  }
}

function canLaunchBrowser(launcher) {
  return launcher.launch({ headless: true })
    .then((browser) => { browser.close(); return true; })
    .catch(() => false);
}

test('chat message propagates between Chrome and Safari', { timeout: 120_000 }, async (t) => {
  if (!(await serverHealthy())) {
    t.skip('server not running — start nostr-dag-server to run this test');
    return;
  }

  // Ensure Playwright browser binaries are present
  ensureBrowsersInstalled();

  const chromeAvailable = await canLaunchBrowser(chromium);
  const safariAvailable = await canLaunchBrowser(webkit);

  if (!chromeAvailable) {
    t.skip('Chromium browser not available (run: npx playwright install chromium)');
    return;
  }
  if (!safariAvailable) {
    t.skip('WebKit/Safari browser not available (run: npx playwright install webkit)');
    return;
  }

  let chromeBrowser;
  let safariBrowser;
  try {
    chromeBrowser = await chromium.launch({ headless: true });
    safariBrowser = await webkit.launch({ headless: true });

    const chromeContext = await chromeBrowser.newContext({ bypassCSP: true, ignoreHTTPSErrors: true });
    const safariContext = await safariBrowser.newContext({ bypassCSP: true, ignoreHTTPSErrors: true });

    const chromePage = await chromeContext.newPage();
    const safariPage = await safariContext.newPage();

    const chromeLogs = [];
    const safariLogs = [];
    chromePage.on('console', (msg) => chromeLogs.push(`[chrome ${msg.type()}] ${msg.text()}`));
    safariPage.on('console', (msg) => safariLogs.push(`[safari ${msg.type()}] ${msg.text()}`));

    // Load chat page in both browsers
    await chromePage.goto(`${BASE}/chat`, { waitUntil: "load", timeout: 30_000 });
    await safariPage.goto(`${BASE}/chat`, { waitUntil: "load", timeout: 30_000 });

    // Wait for nodes to start
    await chromePage.waitForSelector('#chatInput:not([disabled])', { timeout: 15_000 }).catch(() => {});
    await safariPage.waitForSelector('#chatInput:not([disabled])', { timeout: 15_000 }).catch(() => {});

    // Ensure nodes are started
    await chromePage.evaluate(() => {
      const btn = document.getElementById('startNodeBtn');
      if (btn && !btn.disabled) btn.click();
    });
    await safariPage.evaluate(() => {
      const btn = document.getElementById('startNodeBtn');
      if (btn && !btn.disabled) btn.click();
    });

    // Give libp2p time to bootstrap and (hopefully) form a mesh
    await new Promise(r => setTimeout(r, 8000));

    // Dump logs for diagnostics
    console.log('--- Chrome logs ---');
    chromeLogs.forEach(l => console.log(l));
    console.log('--- Safari logs ---');
    safariLogs.forEach(l => console.log(l));

    // Check chat contents for diagnostics
    const chromeChat = await chromePage.evaluate(() => document.getElementById('chatMessages')?.innerText || '');
    const safariChat = await safariPage.evaluate(() => document.getElementById('chatMessages')?.innerText || '');
    const filterChat = (text) => text.split('\n').filter(l => l.includes('Node started') || l.includes('Dialed') || l.includes('Dial failed') || l.includes('Peer joined') || l.includes('Node failed')).join('\n');
    console.log('--- Chrome chat key events ---\n', filterChat(chromeChat));
    console.log('--- Safari chat key events ---\n', filterChat(safariChat));

    // Send a unique message from Chrome
    const testMessage = `cross-browser-${Date.now()}`;
    await chromePage.evaluate((msg) => {
      const input = document.getElementById('chatInput');
      const btn = document.getElementById('sendBtn');
      if (input) input.value = msg;
      if (btn) btn.click();
    }, testMessage);

    // Wait for the message to appear in Safari
    const received = await safariPage.waitForFunction(
      (expected) => {
        const container = document.getElementById('chatMessages');
        if (!container) return false;
        return container.textContent.includes(expected);
      },
      testMessage,
      { timeout: 15_000 }
    ).then(() => true).catch(() => false);

    // Dump final chat contents
    const chromeChatFinal = await chromePage.evaluate(() => document.getElementById('chatMessages')?.innerText || '');
    const safariChatFinal = await safariPage.evaluate(() => document.getElementById('chatMessages')?.innerText || '');
    console.log('--- Chrome chat final key events ---\n', filterChat(chromeChatFinal));
    console.log('--- Safari chat final key events ---\n', filterChat(safariChatFinal));

    assert.ok(received, `Safari should receive the message from Chrome: "${testMessage}"`);

    // Also verify Chrome sees its own message
    const selfReceived = await chromePage.evaluate((expected) => {
      const container = document.getElementById('chatMessages');
      return container ? container.textContent.includes(expected) : false;
    }, testMessage);
    assert.ok(selfReceived, `Chrome should display its own sent message`);
  } finally {
    if (chromeBrowser) await chromeBrowser.close();
    if (safariBrowser) await safariBrowser.close();
  }
});
