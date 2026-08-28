import type { Codec, DecodeOptions } from 'protons-runtime';
import type { Uint8ArrayList } from 'uint8arraylist';
export interface HolePunch {
    type?: HolePunch.Type;
    observedAddresses: Uint8Array[];
}
export declare namespace HolePunch {
    enum Type {
        UNUSED = "UNUSED",
        CONNECT = "CONNECT",
        SYNC = "SYNC"
    }
    namespace Type {
        const codec: () => Codec<Type>;
    }
    const codec: () => Codec<HolePunch>;
    interface HolePunchTypeFieldEvent {
        field: '$.type';
        value: HolePunch.Type;
    }
    interface HolePunchObservedAddressesFieldEvent {
        field: '$.observedAddresses[]';
        index: number;
        value: Uint8Array;
    }
    function encode(obj: Partial<HolePunch>): Uint8Array;
    function decode(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<HolePunch>): HolePunch;
    function stream(buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<HolePunch>): Generator<HolePunchTypeFieldEvent | HolePunchObservedAddressesFieldEvent>;
}
//# sourceMappingURL=message.d.ts.map