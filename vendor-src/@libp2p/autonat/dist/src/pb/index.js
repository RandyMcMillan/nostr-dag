import { decodeMessage, encodeMessage, enumeration, MaxLengthError, message, streamMessage } from 'protons-runtime';
export var Message;
(function (Message) {
    let MessageType;
    (function (MessageType) {
        MessageType["DIAL"] = "DIAL";
        MessageType["DIAL_RESPONSE"] = "DIAL_RESPONSE";
    })(MessageType = Message.MessageType || (Message.MessageType = {}));
    let __MessageTypeValues;
    (function (__MessageTypeValues) {
        __MessageTypeValues[__MessageTypeValues["DIAL"] = 0] = "DIAL";
        __MessageTypeValues[__MessageTypeValues["DIAL_RESPONSE"] = 1] = "DIAL_RESPONSE";
    })(__MessageTypeValues || (__MessageTypeValues = {}));
    (function (MessageType) {
        MessageType.codec = () => {
            return enumeration(__MessageTypeValues);
        };
    })(MessageType = Message.MessageType || (Message.MessageType = {}));
    let ResponseStatus;
    (function (ResponseStatus) {
        ResponseStatus["OK"] = "OK";
        ResponseStatus["E_DIAL_ERROR"] = "E_DIAL_ERROR";
        ResponseStatus["E_DIAL_REFUSED"] = "E_DIAL_REFUSED";
        ResponseStatus["E_BAD_REQUEST"] = "E_BAD_REQUEST";
        ResponseStatus["E_INTERNAL_ERROR"] = "E_INTERNAL_ERROR";
    })(ResponseStatus = Message.ResponseStatus || (Message.ResponseStatus = {}));
    let __ResponseStatusValues;
    (function (__ResponseStatusValues) {
        __ResponseStatusValues[__ResponseStatusValues["OK"] = 0] = "OK";
        __ResponseStatusValues[__ResponseStatusValues["E_DIAL_ERROR"] = 100] = "E_DIAL_ERROR";
        __ResponseStatusValues[__ResponseStatusValues["E_DIAL_REFUSED"] = 101] = "E_DIAL_REFUSED";
        __ResponseStatusValues[__ResponseStatusValues["E_BAD_REQUEST"] = 200] = "E_BAD_REQUEST";
        __ResponseStatusValues[__ResponseStatusValues["E_INTERNAL_ERROR"] = 300] = "E_INTERNAL_ERROR";
    })(__ResponseStatusValues || (__ResponseStatusValues = {}));
    (function (ResponseStatus) {
        ResponseStatus.codec = () => {
            return enumeration(__ResponseStatusValues);
        };
    })(ResponseStatus = Message.ResponseStatus || (Message.ResponseStatus = {}));
    let PeerInfo;
    (function (PeerInfo) {
        let _codec;
        PeerInfo.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.id != null) {
                        w.uint32(10);
                        w.bytes(obj.id);
                    }
                    if (obj.addrs != null && obj.addrs.length > 0) {
                        for (const value of obj.addrs) {
                            w.uint32(18);
                            w.bytes(value);
                        }
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        addrs: []
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                obj.id = reader.bytes();
                                break;
                            }
                            case 2: {
                                if (opts.limits?.addrs != null && obj.addrs.length === opts.limits.addrs) {
                                    throw new MaxLengthError('Decode error - repeated field "addrs" had too many elements');
                                }
                                obj.addrs.push(reader.bytes());
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
                        addrs: 0
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                yield {
                                    field: `${prefix}.id`,
                                    value: reader.bytes()
                                };
                                break;
                            }
                            case 2: {
                                if (opts.limits?.addrs != null && obj.addrs === opts.limits.addrs) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "addrs" had too many elements');
                                }
                                yield {
                                    field: `${prefix}.addrs[]`,
                                    index: obj.addrs,
                                    value: reader.bytes()
                                };
                                obj.addrs++;
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
            return encodeMessage(obj, PeerInfo.codec());
        }
        PeerInfo.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, PeerInfo.codec(), opts);
        }
        PeerInfo.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, PeerInfo.codec(), opts);
        }
        PeerInfo.stream = stream;
    })(PeerInfo = Message.PeerInfo || (Message.PeerInfo = {}));
    let Dial;
    (function (Dial) {
        let _codec;
        Dial.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.peer != null) {
                        w.uint32(10);
                        Message.PeerInfo.codec().encode(obj.peer, w);
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {};
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                obj.peer = Message.PeerInfo.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.peer
                                });
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
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                yield* Message.PeerInfo.codec().stream(reader, reader.uint32(), `${prefix}.peer`, {
                                    limits: opts.limits?.peer
                                });
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
            return encodeMessage(obj, Dial.codec());
        }
        Dial.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, Dial.codec(), opts);
        }
        Dial.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, Dial.codec(), opts);
        }
        Dial.stream = stream;
    })(Dial = Message.Dial || (Message.Dial = {}));
    let DialResponse;
    (function (DialResponse) {
        let _codec;
        DialResponse.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.status != null) {
                        w.uint32(8);
                        Message.ResponseStatus.codec().encode(obj.status, w);
                    }
                    if (obj.statusText != null) {
                        w.uint32(18);
                        w.string(obj.statusText);
                    }
                    if (obj.addr != null) {
                        w.uint32(26);
                        w.bytes(obj.addr);
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {};
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                obj.status = Message.ResponseStatus.codec().decode(reader);
                                break;
                            }
                            case 2: {
                                obj.statusText = reader.string();
                                break;
                            }
                            case 3: {
                                obj.addr = reader.bytes();
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
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                yield {
                                    field: `${prefix}.status`,
                                    value: Message.ResponseStatus.codec().decode(reader)
                                };
                                break;
                            }
                            case 2: {
                                yield {
                                    field: `${prefix}.statusText`,
                                    value: reader.string()
                                };
                                break;
                            }
                            case 3: {
                                yield {
                                    field: `${prefix}.addr`,
                                    value: reader.bytes()
                                };
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
            return encodeMessage(obj, DialResponse.codec());
        }
        DialResponse.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, DialResponse.codec(), opts);
        }
        DialResponse.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, DialResponse.codec(), opts);
        }
        DialResponse.stream = stream;
    })(DialResponse = Message.DialResponse || (Message.DialResponse = {}));
    let _codec;
    Message.codec = () => {
        if (_codec == null) {
            _codec = message((obj, w, opts = {}) => {
                if (opts.lengthDelimited !== false) {
                    w.fork();
                }
                if (obj.type != null) {
                    w.uint32(8);
                    Message.MessageType.codec().encode(obj.type, w);
                }
                if (obj.dial != null) {
                    w.uint32(18);
                    Message.Dial.codec().encode(obj.dial, w);
                }
                if (obj.dialResponse != null) {
                    w.uint32(26);
                    Message.DialResponse.codec().encode(obj.dialResponse, w);
                }
                if (opts.lengthDelimited !== false) {
                    w.ldelim();
                }
            }, (reader, length, opts = {}) => {
                const obj = {};
                const end = length == null ? reader.len : reader.pos + length;
                while (reader.pos < end) {
                    const tag = reader.uint32();
                    switch (tag >>> 3) {
                        case 1: {
                            obj.type = Message.MessageType.codec().decode(reader);
                            break;
                        }
                        case 2: {
                            obj.dial = Message.Dial.codec().decode(reader, reader.uint32(), {
                                limits: opts.limits?.dial
                            });
                            break;
                        }
                        case 3: {
                            obj.dialResponse = Message.DialResponse.codec().decode(reader, reader.uint32(), {
                                limits: opts.limits?.dialResponse
                            });
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
                const end = length == null ? reader.len : reader.pos + length;
                while (reader.pos < end) {
                    const tag = reader.uint32();
                    switch (tag >>> 3) {
                        case 1: {
                            yield {
                                field: `${prefix}.type`,
                                value: Message.MessageType.codec().decode(reader)
                            };
                            break;
                        }
                        case 2: {
                            yield* Message.Dial.codec().stream(reader, reader.uint32(), `${prefix}.dial`, {
                                limits: opts.limits?.dial
                            });
                            break;
                        }
                        case 3: {
                            yield* Message.DialResponse.codec().stream(reader, reader.uint32(), `${prefix}.dialResponse`, {
                                limits: opts.limits?.dialResponse
                            });
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
        return encodeMessage(obj, Message.codec());
    }
    Message.encode = encode;
    function decode(buf, opts) {
        return decodeMessage(buf, Message.codec(), opts);
    }
    Message.decode = decode;
    function stream(buf, opts) {
        return streamMessage(buf, Message.codec(), opts);
    }
    Message.stream = stream;
})(Message || (Message = {}));
//# sourceMappingURL=index.js.map