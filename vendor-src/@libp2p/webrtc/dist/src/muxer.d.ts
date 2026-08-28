import { AbstractStreamMuxer } from '@libp2p/utils';
import { WebRTCStream } from './stream.ts';
import type { DataChannelOptions } from './index.ts';
import type { ComponentLogger, CounterGroup, Logger, StreamMuxer, StreamMuxerFactory, CreateStreamOptions, MultiaddrConnection } from '@libp2p/interface';
export interface DataChannelMuxerFactoryInit {
    /**
     * WebRTC Peer Connection
     */
    peerConnection: RTCPeerConnection;
    /**
     * The protocol to use
     */
    protocol?: string;
    /**
     * Optional metrics for this data channel muxer
     */
    metrics?: CounterGroup;
    /**
     * Optional logger, used to report early data channels that are dropped or
     * rejected, and best-effort close errors
     */
    log?: Logger;
    /**
     * Caps the early data channel buffer and the muxer's early streams from one
     * value (see `DEFAULT_MAX_EARLY_STREAMS`)
     */
    maxEarlyStreams?: number;
    /**
     * Options used to create data channels
     */
    dataChannelOptions?: DataChannelOptions;
}
export interface DataChannelMuxerFactoryComponents {
    logger: ComponentLogger;
}
interface EarlyDataChannel {
    channel: RTCDataChannel;
    /**
     * Messages buffered before the muxer adopted the channel; without these they
     * would be dropped, since the stream's `message` listener is only attached
     * when the muxer is created
     */
    messages: Array<MessageEvent<ArrayBuffer>>;
}
export declare class DataChannelMuxerFactory implements StreamMuxerFactory {
    readonly protocol: string;
    /**
     * WebRTC Peer Connection
     */
    private readonly peerConnection;
    private readonly metrics?;
    private readonly log?;
    private readonly dataChannelOptions?;
    private readonly maxEarlyStreams;
    private readonly earlyDataChannels;
    private handedOff;
    constructor(init: DataChannelMuxerFactoryInit);
    private onEarlyDataChannel;
    private closeEarlyDataChannel;
    createStreamMuxer(maConn: MultiaddrConnection): StreamMuxer;
    /**
     * Discards any early data channels buffered before the muxer was created and
     * detaches the `datachannel` listener. Called by the transport whenever
     * connection establishment fails; it is a no-op once `createStreamMuxer` has
     * handed the channels to the muxer, and otherwise ensures a peer whose
     * connection is rejected cannot leave buffered data or listeners behind.
     */
    close(): void;
}
export interface DataChannelMuxerInit extends DataChannelMuxerFactoryInit {
    protocol: string;
    /**
     * Incoming data channels opened by the remote before the muxer was created,
     * along with the messages that arrived on them in that window
     */
    earlyDataChannels: EarlyDataChannel[];
}
export interface DataChannelMuxerComponents {
    logger: ComponentLogger;
}
/**
 * A libp2p data channel stream muxer
 */
export declare class DataChannelMuxer extends AbstractStreamMuxer<WebRTCStream> implements StreamMuxer<WebRTCStream> {
    private readonly peerConnection;
    private readonly dataChannelOptions;
    constructor(maConn: MultiaddrConnection, init: DataChannelMuxerInit);
    private onDataChannel;
    onCreateStream(options?: CreateStreamOptions): Promise<WebRTCStream>;
    onData(): void;
}
export {};
//# sourceMappingURL=muxer.d.ts.map