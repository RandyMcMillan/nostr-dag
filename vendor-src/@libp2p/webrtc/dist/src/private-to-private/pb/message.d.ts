import type { Codec, DecodeOptions } from 'protons-runtime';
import type { Uint8ArrayList } from 'uint8arraylist';
export interface Message {
    type?: Message.Type;
    data?: string;
}
export declare namespace Message {
    enum Type {
        SDP_OFFER = "SDP_OFFER",
        SDP_ANSWER = "SDP_ANSWER",
        ICE_CANDIDATE = "ICE_CANDIDATE"
    }
    namespace Type {
        const codec: () => Codec<Type>;
    }
    const codec: () => Codec<Message>;
    interface MessageTypeFieldEvent {
        field: '$.type';
        value: Message.Type;
    }
    interface MessageDataFieldEvent {
        field: '$.data';
        value: string;
    }
    function encode(obj: Partial<Message>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Message>): Message;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Message>): Generator<MessageTypeFieldEvent | MessageDataFieldEvent>;
}
//# sourceMappingURL=message.d.ts.map