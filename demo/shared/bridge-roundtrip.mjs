export const BRIDGE_RTT_TAG = 'bridge-rtt';

export function stampBridgeRoundTripTag(tags = [], startedAtMs = Date.now()) {
  const nextTags = Array.isArray(tags)
    ? tags.filter((tag) => !Array.isArray(tag) || tag[0] !== BRIDGE_RTT_TAG)
    : [];
  nextTags.push([BRIDGE_RTT_TAG, String(startedAtMs)]);
  return nextTags;
}

export function extractBridgeRoundTripStartMs(event) {
  if (!event || typeof event !== 'object' || !Array.isArray(event.tags)) return null;

  for (const tag of event.tags) {
    if (!Array.isArray(tag)) continue;
    if (tag[0] === BRIDGE_RTT_TAG && tag.length >= 2) {
      const value = Number(tag[1]);
      if (Number.isFinite(value)) return value;
    }
    if (tag[0] === 'x' && tag[1] === BRIDGE_RTT_TAG && tag.length >= 3) {
      const value = Number(tag[2]);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}
