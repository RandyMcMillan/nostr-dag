import { isIPv4 } from '@chainsafe/is-ip';
import { IceUdpMuxListener } from 'node-datachannel';
import { handleStunRequest } from "../../util.js";
export async function stunListener(host, port, log, cb) {
    const listener = new IceUdpMuxListener(port, host);
    listener.onUnhandledStunRequest(request => {
        handleStunRequest(request, log, cb);
    });
    return {
        close: async () => {
            listener.stop();
        },
        address: () => {
            return {
                address: host,
                family: isIPv4(host) ? 'IPv4' : 'IPv6',
                port
            };
        }
    };
}
//# sourceMappingURL=stun-listener.js.map