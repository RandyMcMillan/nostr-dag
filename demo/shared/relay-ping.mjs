export function relayWebSocketUrl(relayUrl) {
  const value = String(relayUrl || '').trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(parsed.protocol)) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export async function measureRelayPing(relayUrl, timeoutMs = 5000) {
  const wsUrl = relayWebSocketUrl(relayUrl);
  if (!wsUrl || typeof WebSocket !== 'function') return null;

  return await new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    let socket = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      try {
        socket?.close?.();
      } catch {
        // best effort only
      }
      resolve(value);
    };

    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

    try {
      socket = new WebSocket(wsUrl);
      socket.addEventListener('open', () => {
        finish(Math.max(0, Math.round(performance.now() - startedAt)));
      });
      socket.addEventListener('error', () => finish(null));
      socket.addEventListener('close', () => finish(null));
    } catch {
      finish(null);
    }
  });
}
