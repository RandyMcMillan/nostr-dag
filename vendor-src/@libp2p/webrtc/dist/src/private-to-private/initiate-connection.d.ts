import { DataChannelMuxerFactory } from '../muxer.ts';
import type { WebRTCDialEvents, WebRTCTransportMetrics } from './transport.ts';
import type { DataChannelOptions } from '../index.ts';
import type { LoggerOptions, ComponentLogger, AbortOptions } from '@libp2p/interface';
import type { ConnectionManager, TransportManager } from '@libp2p/interface-internal';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { ProgressOptions } from 'progress-events';
export interface IncomingStreamOptions extends AbortOptions {
    rtcConfiguration?: RTCConfiguration;
    dataChannelOptions?: Partial<DataChannelOptions>;
}
export interface ConnectOptions extends LoggerOptions, ProgressOptions<WebRTCDialEvents> {
    rtcConfiguration?: RTCConfiguration;
    dataChannel?: DataChannelOptions;
    maxEarlyStreams?: number;
    multiaddr: Multiaddr;
    connectionManager: ConnectionManager;
    transportManager: TransportManager;
    dataChannelOptions?: Partial<DataChannelOptions>;
    signal?: AbortSignal;
    metrics?: WebRTCTransportMetrics;
    logger: ComponentLogger;
}
export declare function initiateConnection({ rtcConfiguration, dataChannel, maxEarlyStreams, signal, metrics, multiaddr: ma, connectionManager, transportManager, log, logger, onProgress }: ConnectOptions): Promise<{
    remoteAddress: Multiaddr;
    peerConnection: globalThis.RTCPeerConnection;
    muxerFactory: DataChannelMuxerFactory;
}>;
//# sourceMappingURL=initiate-connection.d.ts.map