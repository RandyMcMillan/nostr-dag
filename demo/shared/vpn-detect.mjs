/**
 * VPN / proxy detection utilities.
 *
 * Heuristics used:
 *   1. Timezone mismatch (device timezone vs IP geolocation timezone)
 *   2. WebRTC IP leak comparison (public vs local addresses)
 *
 * These are probabilistic — a mismatch strongly suggests a VPN or proxy,
 * but false positives are possible (e.g. travelling users, corporate networks).
 */

/**
 * Fetch IP metadata from a public geolocation service.
 * Falls back to null fields if the service is unreachable.
 */
export async function fetchIpMetadata(signal) {
  try {
    const res = await fetch('https://ipapi.co/json/', { signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Detect timezone mismatch between the device and the IP geolocation.
 * @returns {{mismatch: boolean, deviceTimezone: string, ipTimezone: string|null}}
 */
export function checkTimezoneMismatch(ipData) {
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ipTimezone = ipData?.timezone || null;
  return {
    mismatch: ipTimezone ? deviceTimezone !== ipTimezone : false,
    deviceTimezone,
    ipTimezone,
  };
}

/**
 * Gather local ICE candidates via WebRTC to compare against public IP.
 * @returns {Promise<string[]>} List of local IP addresses found.
 */
export function gatherLocalIceCandidates(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const ips = new Set();
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then((o) => pc.setLocalDescription(o));
      pc.onicecandidate = (ice) => {
        if (!ice || !ice.candidate || !ice.candidate.candidate) return;
        const m = ice.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) ips.add(m[1]);
      };
      setTimeout(() => {
        pc.close();
        resolve([...ips]);
      }, timeoutMs);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Run all VPN heuristics and return a summary.
 *
 * @returns {Promise<{
 *   probableVpn: boolean,
 *   score: number,        // 0–1, higher = more likely
 *   reasons: string[],
 *   timezone: object,
 *   publicIp: string|null,
 *   localIps: string[]
 * }>}
 */
export async function detectProbableVpn() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const ipData = await fetchIpMetadata(controller.signal);
  clearTimeout(timeout);

  const publicIp = ipData?.ip || null;
  const tz = checkTimezoneMismatch(ipData);
  const localIps = await gatherLocalIceCandidates(2000);

  const reasons = [];
  let score = 0;

  if (tz.mismatch) {
    reasons.push(`timezone mismatch (device=${tz.deviceTimezone}, ip=${tz.ipTimezone})`);
    score += 0.6;
  }

  // If public IP is in a known data-centre / hosting ASN but local IPs are
  // RFC-1918, that is normal.  The absence of any local candidates when the
  // browser supports WebRTC can indicate a VPN that blocks WebRTC.
  if (localIps.length === 0 && typeof RTCPeerConnection !== 'undefined') {
    reasons.push('no local ICE candidates (WebRTC may be blocked by VPN)');
    score += 0.3;
  }

  return {
    probableVpn: score >= 0.5,
    score: Math.min(score, 1),
    reasons,
    timezone: tz,
    publicIp,
    localIps,
  };
}
