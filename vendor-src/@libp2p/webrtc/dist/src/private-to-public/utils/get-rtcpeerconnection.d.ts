import { PeerConnection } from 'node-datachannel';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { DataChannelMuxerFactory } from '../../muxer.ts';
import type { DataChannelOptions, TransportCertificate } from '../../index.ts';
import type { CounterGroup, Logger } from '@libp2p/interface';
import type { CertificateFingerprint } from 'node-datachannel';
interface DirectRTCPeerConnectionInit extends RTCConfiguration {
    ufrag: string;
    peerConnection: PeerConnection;
}
export declare class DirectRTCPeerConnection extends RTCPeerConnection {
    private peerConnection;
    private readonly ufrag;
    constructor(init: DirectRTCPeerConnectionInit);
    createOffer(): Promise<globalThis.RTCSessionDescriptionInit | any>;
    createAnswer(): Promise<globalThis.RTCSessionDescriptionInit | any>;
    private setLocalUfrag;
    remoteFingerprint(): CertificateFingerprint;
}
export interface CreateDialerRTCPeerConnectionOptions {
    rtcConfiguration?: RTCConfiguration | (() => RTCConfiguration | Promise<RTCConfiguration>);
    certificate?: TransportCertificate;
    events?: CounterGroup;
    log?: Logger;
    dataChannel?: DataChannelOptions;
    maxEarlyStreams?: number;
}
export declare function createDialerRTCPeerConnection(role: 'client', ufrag: string, options?: CreateDialerRTCPeerConnectionOptions): Promise<{
    peerConnection: globalThis.RTCPeerConnection;
    muxerFactory: DataChannelMuxerFactory;
}>;
export declare function createDialerRTCPeerConnection(role: 'server', ufrag: string, options?: CreateDialerRTCPeerConnectionOptions): Promise<{
    peerConnection: DirectRTCPeerConnection;
    muxerFactory: DataChannelMuxerFactory;
}>;
export {};
//# sourceMappingURL=get-rtcpeerconnection.d.ts.map