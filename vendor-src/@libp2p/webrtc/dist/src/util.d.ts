import type { Logger, LoggerOptions } from '@libp2p/interface';
import type { Duplex } from 'it-stream-types';
import type { IceUdpMuxRequest, PeerConnection } from 'node-datachannel';
export declare const nopSource: () => AsyncGenerator<Uint8Array, any, unknown>;
export declare const nopSink: (_: any) => Promise<void>;
export declare function inertDuplex(): Duplex<any, any, any>;
export declare function drainAndClose(channel: RTCDataChannel, direction: string, drainTimeout: number | undefined, options: LoggerOptions): void;
export interface AbortPromiseOptions {
    signal?: AbortSignal;
    message?: string;
}
export declare function isPeerConnection(obj: any): obj is PeerConnection;
export declare function getRtcConfiguration(config?: RTCConfiguration | (() => RTCConfiguration | Promise<RTCConfiguration>)): Promise<RTCConfiguration>;
export declare const genUfrag: (len?: number) => string;
export declare const isValidUfrag: (ufrag: string) => boolean;
export declare function handleStunRequest(request: IceUdpMuxRequest, log: Logger, cb: (ufrag: string, host: string, port: number) => void): void;
//# sourceMappingURL=util.d.ts.map