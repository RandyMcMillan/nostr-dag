import type { Codec, DecodeOptions } from 'protons-runtime';
import type { Uint8ArrayList } from 'uint8arraylist';
export interface RPC {
    subscriptions: RPC.SubOpts[];
    messages: RPC.Message[];
    control?: RPC.ControlMessage;
}
export declare namespace RPC {
    interface SubOpts {
        subscribe?: boolean;
        topic?: string;
    }
    namespace SubOpts {
        const codec: () => Codec<SubOpts>;
        interface SubOptsSubscribeFieldEvent {
            field: '$.subscribe';
            value: boolean;
        }
        interface SubOptsTopicFieldEvent {
            field: '$.topic';
            value: string;
        }
        function encode(obj: Partial<SubOpts>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<SubOpts>): SubOpts;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<SubOpts>): Generator<SubOptsSubscribeFieldEvent | SubOptsTopicFieldEvent>;
    }
    interface Message {
        from?: Uint8Array;
        data?: Uint8Array;
        seqno?: Uint8Array;
        topic: string;
        signature?: Uint8Array;
        key?: Uint8Array;
    }
    namespace Message {
        const codec: () => Codec<Message>;
        interface MessageFromFieldEvent {
            field: '$.from';
            value: Uint8Array;
        }
        interface MessageDataFieldEvent {
            field: '$.data';
            value: Uint8Array;
        }
        interface MessageSeqnoFieldEvent {
            field: '$.seqno';
            value: Uint8Array;
        }
        interface MessageTopicFieldEvent {
            field: '$.topic';
            value: string;
        }
        interface MessageSignatureFieldEvent {
            field: '$.signature';
            value: Uint8Array;
        }
        interface MessageKeyFieldEvent {
            field: '$.key';
            value: Uint8Array;
        }
        function encode(obj: Partial<Message>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Message>): Message;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Message>): Generator<MessageFromFieldEvent | MessageDataFieldEvent | MessageSeqnoFieldEvent | MessageTopicFieldEvent | MessageSignatureFieldEvent | MessageKeyFieldEvent>;
    }
    interface ControlMessage {
        ihave: RPC.ControlIHave[];
        iwant: RPC.ControlIWant[];
        graft: RPC.ControlGraft[];
        prune: RPC.ControlPrune[];
        idontwant: RPC.ControlIDontWant[];
    }
    namespace ControlMessage {
        const codec: () => Codec<ControlMessage>;
        interface ControlMessageIhaveTopicIDFieldEvent {
            field: '$.ihave[].topicID';
            value: string;
            index: number;
        }
        interface ControlMessageIhaveMessageIDsFieldEvent {
            field: '$.ihave[].messageIDs[]';
            index: number;
            value: Uint8Array;
        }
        interface ControlMessageIwantMessageIDsFieldEvent {
            field: '$.iwant[].messageIDs[]';
            index: number;
            value: Uint8Array;
        }
        interface ControlMessageGraftTopicIDFieldEvent {
            field: '$.graft[].topicID';
            value: string;
            index: number;
        }
        interface ControlMessagePruneTopicIDFieldEvent {
            field: '$.prune[].topicID';
            value: string;
            index: number;
        }
        interface ControlMessagePrunePeersPeerIDFieldEvent {
            field: '$.prune[].peers[].peerID';
            value: Uint8Array;
            index: number;
        }
        interface ControlMessagePrunePeersSignedPeerRecordFieldEvent {
            field: '$.prune[].peers[].signedPeerRecord';
            value: Uint8Array;
            index: number;
        }
        interface ControlMessagePruneBackoffFieldEvent {
            field: '$.prune[].backoff';
            value: number;
            index: number;
        }
        interface ControlMessageIdontwantMessageIDsFieldEvent {
            field: '$.idontwant[].messageIDs[]';
            index: number;
            value: Uint8Array;
        }
        function encode(obj: Partial<ControlMessage>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlMessage>): ControlMessage;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlMessage>): Generator<ControlMessageIhaveTopicIDFieldEvent | ControlMessageIhaveMessageIDsFieldEvent | ControlMessageIwantMessageIDsFieldEvent | ControlMessageGraftTopicIDFieldEvent | ControlMessagePruneTopicIDFieldEvent | ControlMessagePrunePeersPeerIDFieldEvent | ControlMessagePrunePeersSignedPeerRecordFieldEvent | ControlMessagePruneBackoffFieldEvent | ControlMessageIdontwantMessageIDsFieldEvent>;
    }
    interface ControlIHave {
        topicID?: string;
        messageIDs: Uint8Array[];
    }
    namespace ControlIHave {
        const codec: () => Codec<ControlIHave>;
        interface ControlIHaveTopicIDFieldEvent {
            field: '$.topicID';
            value: string;
        }
        interface ControlIHaveMessageIDsFieldEvent {
            field: '$.messageIDs[]';
            index: number;
            value: Uint8Array;
        }
        function encode(obj: Partial<ControlIHave>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlIHave>): ControlIHave;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlIHave>): Generator<ControlIHaveTopicIDFieldEvent | ControlIHaveMessageIDsFieldEvent>;
    }
    interface ControlIWant {
        messageIDs: Uint8Array[];
    }
    namespace ControlIWant {
        const codec: () => Codec<ControlIWant>;
        interface ControlIWantMessageIDsFieldEvent {
            field: '$.messageIDs[]';
            index: number;
            value: Uint8Array;
        }
        function encode(obj: Partial<ControlIWant>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlIWant>): ControlIWant;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlIWant>): Generator<ControlIWantMessageIDsFieldEvent>;
    }
    interface ControlGraft {
        topicID?: string;
    }
    namespace ControlGraft {
        const codec: () => Codec<ControlGraft>;
        interface ControlGraftTopicIDFieldEvent {
            field: '$.topicID';
            value: string;
        }
        function encode(obj: Partial<ControlGraft>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlGraft>): ControlGraft;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlGraft>): Generator<ControlGraftTopicIDFieldEvent>;
    }
    interface ControlPrune {
        topicID?: string;
        peers: RPC.PeerInfo[];
        backoff?: number;
    }
    namespace ControlPrune {
        const codec: () => Codec<ControlPrune>;
        interface ControlPruneTopicIDFieldEvent {
            field: '$.topicID';
            value: string;
        }
        interface ControlPrunePeersPeerIDFieldEvent {
            field: '$.peers[].peerID';
            value: Uint8Array;
            index: number;
        }
        interface ControlPrunePeersSignedPeerRecordFieldEvent {
            field: '$.peers[].signedPeerRecord';
            value: Uint8Array;
            index: number;
        }
        interface ControlPruneBackoffFieldEvent {
            field: '$.backoff';
            value: number;
        }
        function encode(obj: Partial<ControlPrune>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlPrune>): ControlPrune;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlPrune>): Generator<ControlPruneTopicIDFieldEvent | ControlPrunePeersPeerIDFieldEvent | ControlPrunePeersSignedPeerRecordFieldEvent | ControlPruneBackoffFieldEvent>;
    }
    interface PeerInfo {
        peerID?: Uint8Array;
        signedPeerRecord?: Uint8Array;
    }
    namespace PeerInfo {
        const codec: () => Codec<PeerInfo>;
        interface PeerInfoPeerIDFieldEvent {
            field: '$.peerID';
            value: Uint8Array;
        }
        interface PeerInfoSignedPeerRecordFieldEvent {
            field: '$.signedPeerRecord';
            value: Uint8Array;
        }
        function encode(obj: Partial<PeerInfo>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfo>): PeerInfo;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfo>): Generator<PeerInfoPeerIDFieldEvent | PeerInfoSignedPeerRecordFieldEvent>;
    }
    interface ControlIDontWant {
        messageIDs: Uint8Array[];
    }
    namespace ControlIDontWant {
        const codec: () => Codec<ControlIDontWant>;
        interface ControlIDontWantMessageIDsFieldEvent {
            field: '$.messageIDs[]';
            index: number;
            value: Uint8Array;
        }
        function encode(obj: Partial<ControlIDontWant>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlIDontWant>): ControlIDontWant;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ControlIDontWant>): Generator<ControlIDontWantMessageIDsFieldEvent>;
    }
    const codec: () => Codec<RPC>;
    interface RPCSubscriptionsSubscribeFieldEvent {
        field: '$.subscriptions[].subscribe';
        value: boolean;
        index: number;
    }
    interface RPCSubscriptionsTopicFieldEvent {
        field: '$.subscriptions[].topic';
        value: string;
        index: number;
    }
    interface RPCMessagesFromFieldEvent {
        field: '$.messages[].from';
        value: Uint8Array;
        index: number;
    }
    interface RPCMessagesDataFieldEvent {
        field: '$.messages[].data';
        value: Uint8Array;
        index: number;
    }
    interface RPCMessagesSeqnoFieldEvent {
        field: '$.messages[].seqno';
        value: Uint8Array;
        index: number;
    }
    interface RPCMessagesTopicFieldEvent {
        field: '$.messages[].topic';
        value: string;
        index: number;
    }
    interface RPCMessagesSignatureFieldEvent {
        field: '$.messages[].signature';
        value: Uint8Array;
        index: number;
    }
    interface RPCMessagesKeyFieldEvent {
        field: '$.messages[].key';
        value: Uint8Array;
        index: number;
    }
    interface RPCControlIhaveTopicIDFieldEvent {
        field: '$.control.ihave[].topicID';
        value: string;
        index: number;
    }
    interface RPCControlIhaveMessageIDsFieldEvent {
        field: '$.control.ihave[].messageIDs[]';
        index: number;
        value: Uint8Array;
    }
    interface RPCControlIwantMessageIDsFieldEvent {
        field: '$.control.iwant[].messageIDs[]';
        index: number;
        value: Uint8Array;
    }
    interface RPCControlGraftTopicIDFieldEvent {
        field: '$.control.graft[].topicID';
        value: string;
        index: number;
    }
    interface RPCControlPruneTopicIDFieldEvent {
        field: '$.control.prune[].topicID';
        value: string;
        index: number;
    }
    interface RPCControlPrunePeersPeerIDFieldEvent {
        field: '$.control.prune[].peers[].peerID';
        value: Uint8Array;
        index: number;
    }
    interface RPCControlPrunePeersSignedPeerRecordFieldEvent {
        field: '$.control.prune[].peers[].signedPeerRecord';
        value: Uint8Array;
        index: number;
    }
    interface RPCControlPruneBackoffFieldEvent {
        field: '$.control.prune[].backoff';
        value: number;
        index: number;
    }
    interface RPCControlIdontwantMessageIDsFieldEvent {
        field: '$.control.idontwant[].messageIDs[]';
        index: number;
        value: Uint8Array;
    }
    function encode(obj: Partial<RPC>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<RPC>): RPC;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<RPC>): Generator<RPCSubscriptionsSubscribeFieldEvent | RPCSubscriptionsTopicFieldEvent | RPCMessagesFromFieldEvent | RPCMessagesDataFieldEvent | RPCMessagesSeqnoFieldEvent | RPCMessagesTopicFieldEvent | RPCMessagesSignatureFieldEvent | RPCMessagesKeyFieldEvent | RPCControlIhaveTopicIDFieldEvent | RPCControlIhaveMessageIDsFieldEvent | RPCControlIwantMessageIDsFieldEvent | RPCControlGraftTopicIDFieldEvent | RPCControlPruneTopicIDFieldEvent | RPCControlPrunePeersPeerIDFieldEvent | RPCControlPrunePeersSignedPeerRecordFieldEvent | RPCControlPruneBackoffFieldEvent | RPCControlIdontwantMessageIDsFieldEvent>;
}
//# sourceMappingURL=rpc.d.ts.map