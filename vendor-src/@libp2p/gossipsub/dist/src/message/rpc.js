import { decodeMessage, encodeMessage, MaxLengthError, message, streamMessage } from 'protons-runtime';
export var RPC;
(function (RPC) {
    let SubOpts;
    (function (SubOpts) {
        let _codec;
        SubOpts.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.subscribe != null) {
                        w.uint32(8);
                        w.bool(obj.subscribe);
                    }
                    if (obj.topic != null) {
                        w.uint32(18);
                        w.string(obj.topic);
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
                                obj.subscribe = reader.bool();
                                break;
                            }
                            case 2: {
                                obj.topic = reader.string();
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
                                    field: `${prefix}.subscribe`,
                                    value: reader.bool()
                                };
                                break;
                            }
                            case 2: {
                                yield {
                                    field: `${prefix}.topic`,
                                    value: reader.string()
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
            return encodeMessage(obj, SubOpts.codec());
        }
        SubOpts.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, SubOpts.codec(), opts);
        }
        SubOpts.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, SubOpts.codec(), opts);
        }
        SubOpts.stream = stream;
    })(SubOpts = RPC.SubOpts || (RPC.SubOpts = {}));
    let Message;
    (function (Message) {
        let _codec;
        Message.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.from != null) {
                        w.uint32(10);
                        w.bytes(obj.from);
                    }
                    if (obj.data != null) {
                        w.uint32(18);
                        w.bytes(obj.data);
                    }
                    if (obj.seqno != null) {
                        w.uint32(26);
                        w.bytes(obj.seqno);
                    }
                    if ((obj.topic != null && obj.topic !== '')) {
                        w.uint32(34);
                        w.string(obj.topic);
                    }
                    if (obj.signature != null) {
                        w.uint32(42);
                        w.bytes(obj.signature);
                    }
                    if (obj.key != null) {
                        w.uint32(50);
                        w.bytes(obj.key);
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        topic: ''
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                obj.from = reader.bytes();
                                break;
                            }
                            case 2: {
                                obj.data = reader.bytes();
                                break;
                            }
                            case 3: {
                                obj.seqno = reader.bytes();
                                break;
                            }
                            case 4: {
                                obj.topic = reader.string();
                                break;
                            }
                            case 5: {
                                obj.signature = reader.bytes();
                                break;
                            }
                            case 6: {
                                obj.key = reader.bytes();
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
                                    field: `${prefix}.from`,
                                    value: reader.bytes()
                                };
                                break;
                            }
                            case 2: {
                                yield {
                                    field: `${prefix}.data`,
                                    value: reader.bytes()
                                };
                                break;
                            }
                            case 3: {
                                yield {
                                    field: `${prefix}.seqno`,
                                    value: reader.bytes()
                                };
                                break;
                            }
                            case 4: {
                                yield {
                                    field: `${prefix}.topic`,
                                    value: reader.string()
                                };
                                break;
                            }
                            case 5: {
                                yield {
                                    field: `${prefix}.signature`,
                                    value: reader.bytes()
                                };
                                break;
                            }
                            case 6: {
                                yield {
                                    field: `${prefix}.key`,
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
    })(Message = RPC.Message || (RPC.Message = {}));
    let ControlMessage;
    (function (ControlMessage) {
        let _codec;
        ControlMessage.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.ihave != null && obj.ihave.length > 0) {
                        for (const value of obj.ihave) {
                            w.uint32(10);
                            RPC.ControlIHave.codec().encode(value, w);
                        }
                    }
                    if (obj.iwant != null && obj.iwant.length > 0) {
                        for (const value of obj.iwant) {
                            w.uint32(18);
                            RPC.ControlIWant.codec().encode(value, w);
                        }
                    }
                    if (obj.graft != null && obj.graft.length > 0) {
                        for (const value of obj.graft) {
                            w.uint32(26);
                            RPC.ControlGraft.codec().encode(value, w);
                        }
                    }
                    if (obj.prune != null && obj.prune.length > 0) {
                        for (const value of obj.prune) {
                            w.uint32(34);
                            RPC.ControlPrune.codec().encode(value, w);
                        }
                    }
                    if (obj.idontwant != null && obj.idontwant.length > 0) {
                        for (const value of obj.idontwant) {
                            w.uint32(42);
                            RPC.ControlIDontWant.codec().encode(value, w);
                        }
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        ihave: [],
                        iwant: [],
                        graft: [],
                        prune: [],
                        idontwant: []
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                if (opts.limits?.ihave != null && obj.ihave.length === opts.limits.ihave) {
                                    throw new MaxLengthError('Decode error - repeated field "ihave" had too many elements');
                                }
                                obj.ihave.push(RPC.ControlIHave.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.ihave$
                                }));
                                break;
                            }
                            case 2: {
                                if (opts.limits?.iwant != null && obj.iwant.length === opts.limits.iwant) {
                                    throw new MaxLengthError('Decode error - repeated field "iwant" had too many elements');
                                }
                                obj.iwant.push(RPC.ControlIWant.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.iwant$
                                }));
                                break;
                            }
                            case 3: {
                                if (opts.limits?.graft != null && obj.graft.length === opts.limits.graft) {
                                    throw new MaxLengthError('Decode error - repeated field "graft" had too many elements');
                                }
                                obj.graft.push(RPC.ControlGraft.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.graft$
                                }));
                                break;
                            }
                            case 4: {
                                if (opts.limits?.prune != null && obj.prune.length === opts.limits.prune) {
                                    throw new MaxLengthError('Decode error - repeated field "prune" had too many elements');
                                }
                                obj.prune.push(RPC.ControlPrune.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.prune$
                                }));
                                break;
                            }
                            case 5: {
                                if (opts.limits?.idontwant != null && obj.idontwant.length === opts.limits.idontwant) {
                                    throw new MaxLengthError('Decode error - repeated field "idontwant" had too many elements');
                                }
                                obj.idontwant.push(RPC.ControlIDontWant.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.idontwant$
                                }));
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
                        ihave: 0,
                        iwant: 0,
                        graft: 0,
                        prune: 0,
                        idontwant: 0
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                if (opts.limits?.ihave != null && obj.ihave === opts.limits.ihave) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "ihave" had too many elements');
                                }
                                for (const evt of RPC.ControlIHave.codec().stream(reader, reader.uint32(), `${prefix}.ihave[]`, {
                                    limits: opts.limits?.ihave$
                                })) {
                                    yield {
                                        ...evt,
                                        index: obj.ihave
                                    };
                                }
                                obj.ihave++;
                                break;
                            }
                            case 2: {
                                if (opts.limits?.iwant != null && obj.iwant === opts.limits.iwant) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "iwant" had too many elements');
                                }
                                for (const evt of RPC.ControlIWant.codec().stream(reader, reader.uint32(), `${prefix}.iwant[]`, {
                                    limits: opts.limits?.iwant$
                                })) {
                                    yield {
                                        ...evt,
                                        index: obj.iwant
                                    };
                                }
                                obj.iwant++;
                                break;
                            }
                            case 3: {
                                if (opts.limits?.graft != null && obj.graft === opts.limits.graft) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "graft" had too many elements');
                                }
                                for (const evt of RPC.ControlGraft.codec().stream(reader, reader.uint32(), `${prefix}.graft[]`, {
                                    limits: opts.limits?.graft$
                                })) {
                                    yield {
                                        ...evt,
                                        index: obj.graft
                                    };
                                }
                                obj.graft++;
                                break;
                            }
                            case 4: {
                                if (opts.limits?.prune != null && obj.prune === opts.limits.prune) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "prune" had too many elements');
                                }
                                for (const evt of RPC.ControlPrune.codec().stream(reader, reader.uint32(), `${prefix}.prune[]`, {
                                    limits: opts.limits?.prune$
                                })) {
                                    yield {
                                        ...evt,
                                        index: obj.prune
                                    };
                                }
                                obj.prune++;
                                break;
                            }
                            case 5: {
                                if (opts.limits?.idontwant != null && obj.idontwant === opts.limits.idontwant) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "idontwant" had too many elements');
                                }
                                for (const evt of RPC.ControlIDontWant.codec().stream(reader, reader.uint32(), `${prefix}.idontwant[]`, {
                                    limits: opts.limits?.idontwant$
                                })) {
                                    yield {
                                        ...evt,
                                        index: obj.idontwant
                                    };
                                }
                                obj.idontwant++;
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
            return encodeMessage(obj, ControlMessage.codec());
        }
        ControlMessage.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, ControlMessage.codec(), opts);
        }
        ControlMessage.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, ControlMessage.codec(), opts);
        }
        ControlMessage.stream = stream;
    })(ControlMessage = RPC.ControlMessage || (RPC.ControlMessage = {}));
    let ControlIHave;
    (function (ControlIHave) {
        let _codec;
        ControlIHave.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.topicID != null) {
                        w.uint32(10);
                        w.string(obj.topicID);
                    }
                    if (obj.messageIDs != null && obj.messageIDs.length > 0) {
                        for (const value of obj.messageIDs) {
                            w.uint32(18);
                            w.bytes(value);
                        }
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        messageIDs: []
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                obj.topicID = reader.string();
                                break;
                            }
                            case 2: {
                                if (opts.limits?.messageIDs != null && obj.messageIDs.length === opts.limits.messageIDs) {
                                    throw new MaxLengthError('Decode error - repeated field "messageIDs" had too many elements');
                                }
                                obj.messageIDs.push(reader.bytes());
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
                        messageIDs: 0
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                yield {
                                    field: `${prefix}.topicID`,
                                    value: reader.string()
                                };
                                break;
                            }
                            case 2: {
                                if (opts.limits?.messageIDs != null && obj.messageIDs === opts.limits.messageIDs) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "messageIDs" had too many elements');
                                }
                                yield {
                                    field: `${prefix}.messageIDs[]`,
                                    index: obj.messageIDs,
                                    value: reader.bytes()
                                };
                                obj.messageIDs++;
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
            return encodeMessage(obj, ControlIHave.codec());
        }
        ControlIHave.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, ControlIHave.codec(), opts);
        }
        ControlIHave.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, ControlIHave.codec(), opts);
        }
        ControlIHave.stream = stream;
    })(ControlIHave = RPC.ControlIHave || (RPC.ControlIHave = {}));
    let ControlIWant;
    (function (ControlIWant) {
        let _codec;
        ControlIWant.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.messageIDs != null && obj.messageIDs.length > 0) {
                        for (const value of obj.messageIDs) {
                            w.uint32(10);
                            w.bytes(value);
                        }
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        messageIDs: []
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                if (opts.limits?.messageIDs != null && obj.messageIDs.length === opts.limits.messageIDs) {
                                    throw new MaxLengthError('Decode error - repeated field "messageIDs" had too many elements');
                                }
                                obj.messageIDs.push(reader.bytes());
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
                        messageIDs: 0
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                if (opts.limits?.messageIDs != null && obj.messageIDs === opts.limits.messageIDs) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "messageIDs" had too many elements');
                                }
                                yield {
                                    field: `${prefix}.messageIDs[]`,
                                    index: obj.messageIDs,
                                    value: reader.bytes()
                                };
                                obj.messageIDs++;
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
            return encodeMessage(obj, ControlIWant.codec());
        }
        ControlIWant.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, ControlIWant.codec(), opts);
        }
        ControlIWant.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, ControlIWant.codec(), opts);
        }
        ControlIWant.stream = stream;
    })(ControlIWant = RPC.ControlIWant || (RPC.ControlIWant = {}));
    let ControlGraft;
    (function (ControlGraft) {
        let _codec;
        ControlGraft.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.topicID != null) {
                        w.uint32(10);
                        w.string(obj.topicID);
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
                                obj.topicID = reader.string();
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
                                    field: `${prefix}.topicID`,
                                    value: reader.string()
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
            return encodeMessage(obj, ControlGraft.codec());
        }
        ControlGraft.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, ControlGraft.codec(), opts);
        }
        ControlGraft.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, ControlGraft.codec(), opts);
        }
        ControlGraft.stream = stream;
    })(ControlGraft = RPC.ControlGraft || (RPC.ControlGraft = {}));
    let ControlPrune;
    (function (ControlPrune) {
        let _codec;
        ControlPrune.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.topicID != null) {
                        w.uint32(10);
                        w.string(obj.topicID);
                    }
                    if (obj.peers != null && obj.peers.length > 0) {
                        for (const value of obj.peers) {
                            w.uint32(18);
                            RPC.PeerInfo.codec().encode(value, w);
                        }
                    }
                    if (obj.backoff != null) {
                        w.uint32(24);
                        w.uint64Number(obj.backoff);
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        peers: []
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                obj.topicID = reader.string();
                                break;
                            }
                            case 2: {
                                if (opts.limits?.peers != null && obj.peers.length === opts.limits.peers) {
                                    throw new MaxLengthError('Decode error - repeated field "peers" had too many elements');
                                }
                                obj.peers.push(RPC.PeerInfo.codec().decode(reader, reader.uint32(), {
                                    limits: opts.limits?.peers$
                                }));
                                break;
                            }
                            case 3: {
                                obj.backoff = reader.uint64Number();
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
                        peers: 0
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                yield {
                                    field: `${prefix}.topicID`,
                                    value: reader.string()
                                };
                                break;
                            }
                            case 2: {
                                if (opts.limits?.peers != null && obj.peers === opts.limits.peers) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "peers" had too many elements');
                                }
                                for (const evt of RPC.PeerInfo.codec().stream(reader, reader.uint32(), `${prefix}.peers[]`, {
                                    limits: opts.limits?.peers$
                                })) {
                                    yield {
                                        ...evt,
                                        index: obj.peers
                                    };
                                }
                                obj.peers++;
                                break;
                            }
                            case 3: {
                                yield {
                                    field: `${prefix}.backoff`,
                                    value: reader.uint64Number()
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
            return encodeMessage(obj, ControlPrune.codec());
        }
        ControlPrune.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, ControlPrune.codec(), opts);
        }
        ControlPrune.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, ControlPrune.codec(), opts);
        }
        ControlPrune.stream = stream;
    })(ControlPrune = RPC.ControlPrune || (RPC.ControlPrune = {}));
    let PeerInfo;
    (function (PeerInfo) {
        let _codec;
        PeerInfo.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.peerID != null) {
                        w.uint32(10);
                        w.bytes(obj.peerID);
                    }
                    if (obj.signedPeerRecord != null) {
                        w.uint32(18);
                        w.bytes(obj.signedPeerRecord);
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
                                obj.peerID = reader.bytes();
                                break;
                            }
                            case 2: {
                                obj.signedPeerRecord = reader.bytes();
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
                                    field: `${prefix}.peerID`,
                                    value: reader.bytes()
                                };
                                break;
                            }
                            case 2: {
                                yield {
                                    field: `${prefix}.signedPeerRecord`,
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
    })(PeerInfo = RPC.PeerInfo || (RPC.PeerInfo = {}));
    let ControlIDontWant;
    (function (ControlIDontWant) {
        let _codec;
        ControlIDontWant.codec = () => {
            if (_codec == null) {
                _codec = message((obj, w, opts = {}) => {
                    if (opts.lengthDelimited !== false) {
                        w.fork();
                    }
                    if (obj.messageIDs != null && obj.messageIDs.length > 0) {
                        for (const value of obj.messageIDs) {
                            w.uint32(10);
                            w.bytes(value);
                        }
                    }
                    if (opts.lengthDelimited !== false) {
                        w.ldelim();
                    }
                }, (reader, length, opts = {}) => {
                    const obj = {
                        messageIDs: []
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                if (opts.limits?.messageIDs != null && obj.messageIDs.length === opts.limits.messageIDs) {
                                    throw new MaxLengthError('Decode error - repeated field "messageIDs" had too many elements');
                                }
                                obj.messageIDs.push(reader.bytes());
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
                        messageIDs: 0
                    };
                    const end = length == null ? reader.len : reader.pos + length;
                    while (reader.pos < end) {
                        const tag = reader.uint32();
                        switch (tag >>> 3) {
                            case 1: {
                                if (opts.limits?.messageIDs != null && obj.messageIDs === opts.limits.messageIDs) {
                                    throw new MaxLengthError('Streaming decode error - repeated field "messageIDs" had too many elements');
                                }
                                yield {
                                    field: `${prefix}.messageIDs[]`,
                                    index: obj.messageIDs,
                                    value: reader.bytes()
                                };
                                obj.messageIDs++;
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
            return encodeMessage(obj, ControlIDontWant.codec());
        }
        ControlIDontWant.encode = encode;
        function decode(buf, opts) {
            return decodeMessage(buf, ControlIDontWant.codec(), opts);
        }
        ControlIDontWant.decode = decode;
        function stream(buf, opts) {
            return streamMessage(buf, ControlIDontWant.codec(), opts);
        }
        ControlIDontWant.stream = stream;
    })(ControlIDontWant = RPC.ControlIDontWant || (RPC.ControlIDontWant = {}));
    let _codec;
    RPC.codec = () => {
        if (_codec == null) {
            _codec = message((obj, w, opts = {}) => {
                if (opts.lengthDelimited !== false) {
                    w.fork();
                }
                if (obj.subscriptions != null && obj.subscriptions.length > 0) {
                    for (const value of obj.subscriptions) {
                        w.uint32(10);
                        RPC.SubOpts.codec().encode(value, w);
                    }
                }
                if (obj.messages != null && obj.messages.length > 0) {
                    for (const value of obj.messages) {
                        w.uint32(18);
                        RPC.Message.codec().encode(value, w);
                    }
                }
                if (obj.control != null) {
                    w.uint32(26);
                    RPC.ControlMessage.codec().encode(obj.control, w);
                }
                if (opts.lengthDelimited !== false) {
                    w.ldelim();
                }
            }, (reader, length, opts = {}) => {
                const obj = {
                    subscriptions: [],
                    messages: []
                };
                const end = length == null ? reader.len : reader.pos + length;
                while (reader.pos < end) {
                    const tag = reader.uint32();
                    switch (tag >>> 3) {
                        case 1: {
                            if (opts.limits?.subscriptions != null && obj.subscriptions.length === opts.limits.subscriptions) {
                                throw new MaxLengthError('Decode error - repeated field "subscriptions" had too many elements');
                            }
                            obj.subscriptions.push(RPC.SubOpts.codec().decode(reader, reader.uint32(), {
                                limits: opts.limits?.subscriptions$
                            }));
                            break;
                        }
                        case 2: {
                            if (opts.limits?.messages != null && obj.messages.length === opts.limits.messages) {
                                throw new MaxLengthError('Decode error - repeated field "messages" had too many elements');
                            }
                            obj.messages.push(RPC.Message.codec().decode(reader, reader.uint32(), {
                                limits: opts.limits?.messages$
                            }));
                            break;
                        }
                        case 3: {
                            obj.control = RPC.ControlMessage.codec().decode(reader, reader.uint32(), {
                                limits: opts.limits?.control
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
                const obj = {
                    subscriptions: 0,
                    messages: 0
                };
                const end = length == null ? reader.len : reader.pos + length;
                while (reader.pos < end) {
                    const tag = reader.uint32();
                    switch (tag >>> 3) {
                        case 1: {
                            if (opts.limits?.subscriptions != null && obj.subscriptions === opts.limits.subscriptions) {
                                throw new MaxLengthError('Streaming decode error - repeated field "subscriptions" had too many elements');
                            }
                            for (const evt of RPC.SubOpts.codec().stream(reader, reader.uint32(), `${prefix}.subscriptions[]`, {
                                limits: opts.limits?.subscriptions$
                            })) {
                                yield {
                                    ...evt,
                                    index: obj.subscriptions
                                };
                            }
                            obj.subscriptions++;
                            break;
                        }
                        case 2: {
                            if (opts.limits?.messages != null && obj.messages === opts.limits.messages) {
                                throw new MaxLengthError('Streaming decode error - repeated field "messages" had too many elements');
                            }
                            for (const evt of RPC.Message.codec().stream(reader, reader.uint32(), `${prefix}.messages[]`, {
                                limits: opts.limits?.messages$
                            })) {
                                yield {
                                    ...evt,
                                    index: obj.messages
                                };
                            }
                            obj.messages++;
                            break;
                        }
                        case 3: {
                            yield* RPC.ControlMessage.codec().stream(reader, reader.uint32(), `${prefix}.control`, {
                                limits: opts.limits?.control
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
        return encodeMessage(obj, RPC.codec());
    }
    RPC.encode = encode;
    function decode(buf, opts) {
        return decodeMessage(buf, RPC.codec(), opts);
    }
    RPC.decode = decode;
    function stream(buf, opts) {
        return streamMessage(buf, RPC.codec(), opts);
    }
    RPC.stream = stream;
})(RPC || (RPC = {}));
//# sourceMappingURL=rpc.js.map