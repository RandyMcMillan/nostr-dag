import { decodeMessage, encodeMessage, enumeration, MaxLengthError, message, streamMessage } from 'protons-runtime';
export var HolePunch;
(function (HolePunch) {
    let Type;
    (function (Type) {
        Type["UNUSED"] = "UNUSED";
        Type["CONNECT"] = "CONNECT";
        Type["SYNC"] = "SYNC";
    })(Type = HolePunch.Type || (HolePunch.Type = {}));
    let __TypeValues;
    (function (__TypeValues) {
        __TypeValues[__TypeValues["UNUSED"] = 0] = "UNUSED";
        __TypeValues[__TypeValues["CONNECT"] = 100] = "CONNECT";
        __TypeValues[__TypeValues["SYNC"] = 300] = "SYNC";
    })(__TypeValues || (__TypeValues = {}));
    (function (Type) {
        Type.codec = () => {
            return enumeration(__TypeValues);
        };
    })(Type = HolePunch.Type || (HolePunch.Type = {}));
    let _codec;
    HolePunch.codec = () => {
        if (_codec == null) {
            _codec = message((obj, w, opts = {}) => {
                if (opts.lengthDelimited !== false) {
                    w.fork();
                }
                if (obj.type != null) {
                    w.uint32(8);
                    HolePunch.Type.codec().encode(obj.type, w);
                }
                if (obj.observedAddresses != null && obj.observedAddresses.length > 0) {
                    for (const value of obj.observedAddresses) {
                        w.uint32(18);
                        w.bytes(value);
                    }
                }
                if (opts.lengthDelimited !== false) {
                    w.ldelim();
                }
            }, (reader, length, opts = {}) => {
                const obj = {
                    observedAddresses: []
                };
                const end = length == null ? reader.len : reader.pos + length;
                while (reader.pos < end) {
                    const tag = reader.uint32();
                    switch (tag >>> 3) {
                        case 1: {
                            obj.type = HolePunch.Type.codec().decode(reader);
                            break;
                        }
                        case 2: {
                            if (opts.limits?.observedAddresses != null && obj.observedAddresses.length === opts.limits.observedAddresses) {
                                throw new MaxLengthError('Decode error - repeated field "observedAddresses" had too many elements');
                            }
                            obj.observedAddresses.push(reader.bytes());
                            break;
                        }
                        default: {
                            reader.skipType(tag & 7);
                            break;
                        }
                    }
                }
                return obj;
            }, function* (reader, length, prefix, opts = {}) {
                const obj = {
                    observedAddresses: 0
                };
                const end = length == null ? reader.len : reader.pos + length;
                while (reader.pos < end) {
                    const tag = reader.uint32();
                    switch (tag >>> 3) {
                        case 1: {
                            yield {
                                field: `${prefix}.type`,
                                value: HolePunch.Type.codec().decode(reader)
                            };
                            break;
                        }
                        case 2: {
                            if (opts.limits?.observedAddresses != null && obj.observedAddresses === opts.limits.observedAddresses) {
                                throw new MaxLengthError('Streaming decode error - repeated field "observedAddresses" had too many elements');
                            }
                            yield {
                                field: `${prefix}.observedAddresses[]`,
                                index: obj.observedAddresses,
                                value: reader.bytes()
                            };
                            obj.observedAddresses++;
                            break;
                        }
                        default: {
                            reader.skipType(tag & 7);
                            break;
                        }
                    }
                }
            });
        }
        return _codec;
    };
    function encode(obj) {
        return encodeMessage(obj, HolePunch.codec());
    }
    HolePunch.encode = encode;
    function decode(buf, opts) {
        return decodeMessage(buf, HolePunch.codec(), opts);
    }
    HolePunch.decode = decode;
    function stream(buf, opts) {
        return streamMessage(buf, HolePunch.codec(), opts);
    }
    HolePunch.stream = stream;
})(HolePunch || (HolePunch = {}));
//# sourceMappingURL=message.js.map