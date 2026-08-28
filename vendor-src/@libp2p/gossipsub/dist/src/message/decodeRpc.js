export const defaultDecodeRpcLimits = {
    // 5000 = GossipsubMaxIHaveLength, used as a generous upper bound for these
    maxSubscriptions: 5000,
    maxMessages: 5000,
    maxIhaveMessageIDs: 5000,
    maxIwantMessageIDs: 5000,
    maxControlMessages: 5000,
    maxIdontwantMessageIDs: 512, // GossipsubIdontwantMaxMessages
    maxPeerInfos: 16 // GossipsubPrunePeers
};
//# sourceMappingURL=decodeRpc.js.map