import type { Codec, DecodeOptions } from 'protons-runtime';
import type { Uint8ArrayList } from 'uint8arraylist';
export interface Message {
    type?: Message.MessageType;
    dial?: Message.Dial;
    dialResponse?: Message.DialResponse;
}
export declare namespace Message {
    enum MessageType {
        DIAL = "DIAL",
        DIAL_RESPONSE = "DIAL_RESPONSE"
    }
    namespace MessageType {
        const codec: () => Codec<MessageType>;
    }
    enum ResponseStatus {
        OK = "OK",
        E_DIAL_ERROR = "E_DIAL_ERROR",
        E_DIAL_REFUSED = "E_DIAL_REFUSED",
        E_BAD_REQUEST = "E_BAD_REQUEST",
        E_INTERNAL_ERROR = "E_INTERNAL_ERROR"
    }
    namespace ResponseStatus {
        const codec: () => Codec<ResponseStatus>;
    }
    interface PeerInfo {
        id?: Uint8Array;
        addrs: Uint8Array[];
    }
    namespace PeerInfo {
        const codec: () => Codec<PeerInfo>;
        interface PeerInfoIdFieldEvent {
            field: '$.id';
            value: Uint8Array;
        }
        interface PeerInfoAddrsFieldEvent {
            field: '$.addrs[]';
            index: number;
            value: Uint8Array;
        }
        function encode(obj: Partial<PeerInfo>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfo>): PeerInfo;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfo>): Generator<PeerInfoIdFieldEvent | PeerInfoAddrsFieldEvent>;
    }
    interface Dial {
        peer?: Message.PeerInfo;
    }
    namespace Dial {
        const codec: () => Codec<Dial>;
        interface DialPeerIdFieldEvent {
            field: '$.peer.id';
            value: Uint8Array;
        }
        interface DialPeerAddrsFieldEvent {
            field: '$.peer.addrs[]';
            index: number;
            value: Uint8Array;
        }
        function encode(obj: Partial<Dial>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Dial>): Dial;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Dial>): Generator<DialPeerIdFieldEvent | DialPeerAddrsFieldEvent>;
    }
    interface DialResponse {
        status?: Message.ResponseStatus;
        statusText?: string;
        addr?: Uint8Array;
    }
    namespace DialResponse {
        const codec: () => Codec<DialResponse>;
        interface DialResponseStatusFieldEvent {
            field: '$.status';
            value: Message.ResponseStatus;
        }
        interface DialResponseStatusTextFieldEvent {
            field: '$.statusText';
            value: string;
        }
        interface DialResponseAddrFieldEvent {
            field: '$.addr';
            value: Uint8Array;
        }
        function encode(obj: Partial<DialResponse>): Uint8Array;
        function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<DialResponse>): DialResponse;
        function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<DialResponse>): Generator<DialResponseStatusFieldEvent | DialResponseStatusTextFieldEvent | DialResponseAddrFieldEvent>;
    }
    const codec: () => Codec<Message>;
    interface MessageTypeFieldEvent {
        field: '$.type';
        value: Message.MessageType;
    }
    interface MessageDialPeerIdFieldEvent {
        field: '$.dial.peer.id';
        value: Uint8Array;
    }
    interface MessageDialPeerAddrsFieldEvent {
        field: '$.dial.peer.addrs[]';
        index: number;
        value: Uint8Array;
    }
    interface MessageDialResponseStatusFieldEvent {
        field: '$.dialResponse.status';
        value: Message.ResponseStatus;
    }
    interface MessageDialResponseStatusTextFieldEvent {
        field: '$.dialResponse.statusText';
        value: string;
    }
    interface MessageDialResponseAddrFieldEvent {
        field: '$.dialResponse.addr';
        value: Uint8Array;
    }
    function encode(obj: Partial<Message>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Message>): Message;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Message>): Generator<MessageTypeFieldEvent | MessageDialPeerIdFieldEvent | MessageDialPeerAddrsFieldEvent | MessageDialResponseStatusFieldEvent | MessageDialResponseStatusTextFieldEvent | MessageDialResponseAddrFieldEvent>;
}
//# sourceMappingURL=index.d.ts.map