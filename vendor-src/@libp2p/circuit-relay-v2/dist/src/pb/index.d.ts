import type { Codec, DecodeOptions } from 'protons-runtime';
import type { Uint8ArrayList } from 'uint8arraylist';
export interface HopMessage {
    type?: HopMessage.Type;
    peer?: Peer;
    reservation?: Reservation;
    limit?: Limit;
    status?: Status;
}
export declare namespace HopMessage {
    enum Type {
        RESERVE = "RESERVE",
        CONNECT = "CONNECT",
        STATUS = "STATUS"
    }
    namespace Type {
        const codec: () => Codec<Type>;
    }
    const codec: () => Codec<HopMessage>;
    interface HopMessageTypeFieldEvent {
        field: '$.type';
        value: HopMessage.Type;
    }
    interface HopMessagePeerIdFieldEvent {
        field: '$.peer.id';
        value: Uint8Array;
    }
    interface HopMessagePeerAddrsFieldEvent {
        field: '$.peer.addrs[]';
        index: number;
        value: Uint8Array;
    }
    interface HopMessageReservationExpireFieldEvent {
        field: '$.reservation.expire';
        value: bigint;
    }
    interface HopMessageReservationAddrsFieldEvent {
        field: '$.reservation.addrs[]';
        index: number;
        value: Uint8Array;
    }
    interface HopMessageReservationVoucherPublicKeyFieldEvent {
        field: '$.reservation.voucher.publicKey';
        value: Uint8Array;
    }
    interface HopMessageReservationVoucherPayloadTypeFieldEvent {
        field: '$.reservation.voucher.payloadType';
        value: Uint8Array;
    }
    interface HopMessageReservationVoucherPayloadRelayFieldEvent {
        field: '$.reservation.voucher.payload.relay';
        value: Uint8Array;
    }
    interface HopMessageReservationVoucherPayloadPeerFieldEvent {
        field: '$.reservation.voucher.payload.peer';
        value: Uint8Array;
    }
    interface HopMessageReservationVoucherPayloadExpirationFieldEvent {
        field: '$.reservation.voucher.payload.expiration';
        value: bigint;
    }
    interface HopMessageReservationVoucherSignatureFieldEvent {
        field: '$.reservation.voucher.signature';
        value: Uint8Array;
    }
    interface HopMessageLimitDurationFieldEvent {
        field: '$.limit.duration';
        value: number;
    }
    interface HopMessageLimitDataFieldEvent {
        field: '$.limit.data';
        value: bigint;
    }
    interface HopMessageStatusFieldEvent {
        field: '$.status';
        value: Status;
    }
    function encode(obj: Partial<HopMessage>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<HopMessage>): HopMessage;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<HopMessage>): Generator<HopMessageTypeFieldEvent | HopMessagePeerIdFieldEvent | HopMessagePeerAddrsFieldEvent | HopMessageReservationExpireFieldEvent | HopMessageReservationAddrsFieldEvent | HopMessageReservationVoucherPublicKeyFieldEvent | HopMessageReservationVoucherPayloadTypeFieldEvent | HopMessageReservationVoucherPayloadRelayFieldEvent | HopMessageReservationVoucherPayloadPeerFieldEvent | HopMessageReservationVoucherPayloadExpirationFieldEvent | HopMessageReservationVoucherSignatureFieldEvent | HopMessageLimitDurationFieldEvent | HopMessageLimitDataFieldEvent | HopMessageStatusFieldEvent>;
}
export interface StopMessage {
    type?: StopMessage.Type;
    peer?: Peer;
    limit?: Limit;
    status?: Status;
}
export declare namespace StopMessage {
    enum Type {
        CONNECT = "CONNECT",
        STATUS = "STATUS"
    }
    namespace Type {
        const codec: () => Codec<Type>;
    }
    const codec: () => Codec<StopMessage>;
    interface StopMessageTypeFieldEvent {
        field: '$.type';
        value: StopMessage.Type;
    }
    interface StopMessagePeerIdFieldEvent {
        field: '$.peer.id';
        value: Uint8Array;
    }
    interface StopMessagePeerAddrsFieldEvent {
        field: '$.peer.addrs[]';
        index: number;
        value: Uint8Array;
    }
    interface StopMessageLimitDurationFieldEvent {
        field: '$.limit.duration';
        value: number;
    }
    interface StopMessageLimitDataFieldEvent {
        field: '$.limit.data';
        value: bigint;
    }
    interface StopMessageStatusFieldEvent {
        field: '$.status';
        value: Status;
    }
    function encode(obj: Partial<StopMessage>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<StopMessage>): StopMessage;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<StopMessage>): Generator<StopMessageTypeFieldEvent | StopMessagePeerIdFieldEvent | StopMessagePeerAddrsFieldEvent | StopMessageLimitDurationFieldEvent | StopMessageLimitDataFieldEvent | StopMessageStatusFieldEvent>;
}
export interface Peer {
    id: Uint8Array;
    addrs: Uint8Array[];
}
export declare namespace Peer {
    const codec: () => Codec<Peer>;
    interface PeerIdFieldEvent {
        field: '$.id';
        value: Uint8Array;
    }
    interface PeerAddrsFieldEvent {
        field: '$.addrs[]';
        index: number;
        value: Uint8Array;
    }
    function encode(obj: Partial<Peer>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Peer>): Peer;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Peer>): Generator<PeerIdFieldEvent | PeerAddrsFieldEvent>;
}
export interface Reservation {
    expire: bigint;
    addrs: Uint8Array[];
    voucher?: Envelope;
}
export declare namespace Reservation {
    const codec: () => Codec<Reservation>;
    interface ReservationExpireFieldEvent {
        field: '$.expire';
        value: bigint;
    }
    interface ReservationAddrsFieldEvent {
        field: '$.addrs[]';
        index: number;
        value: Uint8Array;
    }
    interface ReservationVoucherPublicKeyFieldEvent {
        field: '$.voucher.publicKey';
        value: Uint8Array;
    }
    interface ReservationVoucherPayloadTypeFieldEvent {
        field: '$.voucher.payloadType';
        value: Uint8Array;
    }
    interface ReservationVoucherPayloadRelayFieldEvent {
        field: '$.voucher.payload.relay';
        value: Uint8Array;
    }
    interface ReservationVoucherPayloadPeerFieldEvent {
        field: '$.voucher.payload.peer';
        value: Uint8Array;
    }
    interface ReservationVoucherPayloadExpirationFieldEvent {
        field: '$.voucher.payload.expiration';
        value: bigint;
    }
    interface ReservationVoucherSignatureFieldEvent {
        field: '$.voucher.signature';
        value: Uint8Array;
    }
    function encode(obj: Partial<Reservation>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Reservation>): Reservation;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Reservation>): Generator<ReservationExpireFieldEvent | ReservationAddrsFieldEvent | ReservationVoucherPublicKeyFieldEvent | ReservationVoucherPayloadTypeFieldEvent | ReservationVoucherPayloadRelayFieldEvent | ReservationVoucherPayloadPeerFieldEvent | ReservationVoucherPayloadExpirationFieldEvent | ReservationVoucherSignatureFieldEvent>;
}
export interface Limit {
    duration?: number;
    data?: bigint;
}
export declare namespace Limit {
    const codec: () => Codec<Limit>;
    interface LimitDurationFieldEvent {
        field: '$.duration';
        value: number;
    }
    interface LimitDataFieldEvent {
        field: '$.data';
        value: bigint;
    }
    function encode(obj: Partial<Limit>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Limit>): Limit;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Limit>): Generator<LimitDurationFieldEvent | LimitDataFieldEvent>;
}
export declare enum Status {
    UNUSED = "UNUSED",
    OK = "OK",
    RESERVATION_REFUSED = "RESERVATION_REFUSED",
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED",
    PERMISSION_DENIED = "PERMISSION_DENIED",
    CONNECTION_FAILED = "CONNECTION_FAILED",
    NO_RESERVATION = "NO_RESERVATION",
    MALFORMED_MESSAGE = "MALFORMED_MESSAGE",
    UNEXPECTED_MESSAGE = "UNEXPECTED_MESSAGE"
}
export declare namespace Status {
    const codec: () => Codec<Status>;
}
export interface ReservationVoucher {
    relay: Uint8Array;
    peer: Uint8Array;
    expiration: bigint;
}
export declare namespace ReservationVoucher {
    const codec: () => Codec<ReservationVoucher>;
    interface ReservationVoucherRelayFieldEvent {
        field: '$.relay';
        value: Uint8Array;
    }
    interface ReservationVoucherPeerFieldEvent {
        field: '$.peer';
        value: Uint8Array;
    }
    interface ReservationVoucherExpirationFieldEvent {
        field: '$.expiration';
        value: bigint;
    }
    function encode(obj: Partial<ReservationVoucher>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ReservationVoucher>): ReservationVoucher;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<ReservationVoucher>): Generator<ReservationVoucherRelayFieldEvent | ReservationVoucherPeerFieldEvent | ReservationVoucherExpirationFieldEvent>;
}
export interface Envelope {
    publicKey: Uint8Array;
    payloadType: Uint8Array;
    payload?: ReservationVoucher;
    signature: Uint8Array;
}
export declare namespace Envelope {
    const codec: () => Codec<Envelope>;
    interface EnvelopePublicKeyFieldEvent {
        field: '$.publicKey';
        value: Uint8Array;
    }
    interface EnvelopePayloadTypeFieldEvent {
        field: '$.payloadType';
        value: Uint8Array;
    }
    interface EnvelopePayloadRelayFieldEvent {
        field: '$.payload.relay';
        value: Uint8Array;
    }
    interface EnvelopePayloadPeerFieldEvent {
        field: '$.payload.peer';
        value: Uint8Array;
    }
    interface EnvelopePayloadExpirationFieldEvent {
        field: '$.payload.expiration';
        value: bigint;
    }
    interface EnvelopeSignatureFieldEvent {
        field: '$.signature';
        value: Uint8Array;
    }
    function encode(obj: Partial<Envelope>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Envelope>): Envelope;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Envelope>): Generator<EnvelopePublicKeyFieldEvent | EnvelopePayloadTypeFieldEvent | EnvelopePayloadRelayFieldEvent | EnvelopePayloadPeerFieldEvent | EnvelopePayloadExpirationFieldEvent | EnvelopeSignatureFieldEvent>;
}
//# sourceMappingURL=index.d.ts.map