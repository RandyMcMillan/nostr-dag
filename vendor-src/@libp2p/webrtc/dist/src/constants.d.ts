/**
 * STUN servers help clients discover their own public IPs.
 *
 * Using five or more servers causes warnings to be printed so
 * ensure we limit it to max x4
 *
 * @see https://gist.github.com/mondain/b0ec1cf5f60ae726202e
 */
export declare const DEFAULT_ICE_SERVERS: string[];
/**
 * Characters that can be present in a ufrag
 */
export declare const UFRAG_ALPHABET: string[];
/**
 * Used to detect the version of the WebRTC Direct connection protocol in use
 */
export declare const UFRAG_PREFIX = "libp2p+webrtc+v1/";
/**
 * How much can be buffered to the DataChannel at once
 */
export declare const MAX_BUFFERED_AMOUNT: number;
/**
 * Max message size that can be sent to the DataChannel. In browsers this is
 * 256KiB but go-libp2p and rust-libp2p only support 16KiB at the time of
 * writing.
 *
 * @see https://blog.mozilla.org/webrtc/large-data-channel-messages/
 * @see https://issues.webrtc.org/issues/40644524
 */
export declare const MAX_MESSAGE_SIZE: number;
/**
 * The maximum number of bytes buffered for a single incoming data channel that
 * arrives before the muxer has been created (`earlyDataChannels` in
 * `muxer.ts`). A well-behaved remote only puts its multistream-select proposal
 * on an early channel (well under 1 KB): `newStream` blocks on
 * multistream-select before the application can write, and WebRTC does not
 * pre-negotiate the stream protocol. If the `// TODO: pre-negotiate stream
 * protocol` in `muxer.ts` is ever implemented the application could write
 * immediately, so this assumption, and therefore this bound, must be revisited.
 * It is set to one maximum WebRTC message so a single legitimately-sized frame
 * is never rejected, even though the expected payload is far smaller. Channels
 * that exceed this are closed.
 */
export declare const MAX_EARLY_DATA_CHANNEL_BYTES: number;
/**
 * Default for the `maxEarlyStreams` transport option, which caps both the data
 * channels buffered before the muxer exists and the early streams the muxer
 * surfaces on adoption. They are one budget - buffered channels become early
 * streams on adoption, so a larger channel buffer would abort on hand-off.
 */
export declare const DEFAULT_MAX_EARLY_STREAMS = 10;
/**
 * Max buffered messages per early data channel. A legitimate early channel
 * carries only the multistream-select proposal (one or two frames), so this
 * bounds a flood of tiny or empty messages that would otherwise evade the byte
 * cap by contributing ~0 bytes each.
 */
export declare const MAX_EARLY_DATA_CHANNEL_MESSAGES = 8;
/**
 * The protobuf message overhead includes the maximum amount of all bytes in the
 * protobuf that aren't message field bytes
 */
export declare const PROTOBUF_OVERHEAD: number;
/**
 * When closing a stream, we wait for `bufferedAmount` to become 0 before
 * closing the underlying RTCDataChannel - this controls how long we wait in ms
 */
export declare const DATA_CHANNEL_DRAIN_TIMEOUT = 30000;
/**
 * Wait for the remote to acknowledge our FIN for this long
 */
export declare const DEFAULT_FIN_ACK_TIMEOUT = 10000;
/**
 * Set as the 'negotiated' muxer protocol name
 */
export declare const MUXER_PROTOCOL = "/webrtc";
/**
 * The protocol used for the signalling stream protocol
 */
export declare const SIGNALING_PROTOCOL = "/webrtc-signaling/0.0.1";
/**
 * Used to store generated certificates in the datastore
 */
export declare const DEFAULT_CERTIFICATE_DATASTORE_KEY = "/libp2p/webrtc-direct/certificate";
/**
 * Used to store the certificate private key in the keychain
 */
export declare const DEFAULT_CERTIFICATE_PRIVATE_KEY_NAME = "webrtc-direct-certificate-private-key";
/**
 * The default type of certificate private key
 */
export declare const DEFAULT_CERTIFICATE_PRIVATE_KEY_TYPE = "ECDSA";
/**
 * How long the certificate is valid for
 */
export declare const DEFAULT_CERTIFICATE_LIFESPAN = 1209600000;
/**
 * Renew the certificate this long before it expires
 */
export declare const DEFAULT_CERTIFICATE_RENEWAL_THRESHOLD = 86400000;
//# sourceMappingURL=constants.d.ts.map