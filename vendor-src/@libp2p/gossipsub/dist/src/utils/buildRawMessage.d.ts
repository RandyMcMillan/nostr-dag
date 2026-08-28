import { StrictSign, StrictNoSign } from '../index.ts';
import { RPC } from '../message/rpc.ts';
import { ValidateError } from '../types.ts';
import type { Message } from '../index.ts';
import type { PublishConfig, TopicStr } from '../types.ts';
export declare const SignPrefix: Uint8Array<ArrayBuffer>;
export interface RawMessageAndMessage {
    raw: RPC.Message;
    msg: Message;
}
export declare function buildRawMessage(publishConfig: PublishConfig, topic: TopicStr, originalData: Uint8Array, transformedData: Uint8Array): Promise<RawMessageAndMessage>;
export type ValidationResult = {
    valid: true;
    message: Message;
} | {
    valid: false;
    error: ValidateError;
};
export declare function validateToRawMessage(signaturePolicy: typeof StrictNoSign | typeof StrictSign, msg: RPC.Message): Promise<ValidationResult>;
//# sourceMappingURL=buildRawMessage.d.ts.map