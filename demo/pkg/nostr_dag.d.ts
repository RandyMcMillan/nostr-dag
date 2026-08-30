/* tslint:disable */
/* eslint-disable */

export class WasmDag {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Return the IDs (hex) of all canonical events as a JSON array.
     */
    canonical_ids(): string;
    /**
     * Insert a JSON-serialised Nostr event.
     * Returns a JSON string with the result: `{"type":"Inserted","id":"..."}`,
     * `{"type":"Buffered","id":"...","missing":[...]}`, or `{"type":"Duplicate"}`.
     */
    insert(event_json: string): string;
    /**
     * Create a new DAG with the given participant public keys (hex strings).
     */
    constructor(pubkeys_json: string);
    /**
     * Return the IDs (hex) of current DAG tips as a JSON array.
     */
    tip_ids(): string;
}

/**
 * Read the bridge RTT marker from a Nostr event and return the start timestamp in ms.
 */
export function extractBridgeRoundTripStartMs(event: any): bigint | undefined;

/**
 * Fetch blame information for `file` in `repo` at `commit_ish` from the
 * local server.  Returns a JSON string matching `Vec<BlameHunk>`.
 */
export function git_blame(base_url: string, repo: string, file: string, commit_ish: string): Promise<string>;

/**
 * Fetch the git log for `repo` from the local server.
 *
 * `base_url` should point to the root of the nostr-dag server, e.g.
 * `"http://127.0.0.1:3000"`.  `limit` is the maximum number of commits to
 * return.  Returns a JSON string that matches the native `Vec<CommitInfo>`
 * serialisation.
 */
export function git_log(base_url: string, repo: string, limit: number): Promise<string>;

/**
 * Return a Git remote-helper URL (`nostr::nostr://...`) for native clone handoff.
 */
export function git_remote_nostr_helper_url(remote: string): string;

/**
 * Return a transport-ready URL for clone/fetch (`nostr::`, `p2p::`, HTTP(S), SSH).
 */
export function git_remote_transport(remote: string): string;

/**
 * Normalize a NIP-34 `nostr://` clone URL for consistent cross-runtime use.
 */
export function normalize_nostr_remote(remote: string): string;

/**
 * Normalize a `p2p://` clone URL for consistent cross-runtime use.
 */
export function normalize_p2p_remote(remote: string): string;

/**
 * Convert a `nostr://` clone URL into an equivalent `p2p://` URL.
 */
export function nostr_remote_to_p2p(remote: string): string;

/**
 * Convert a `p2p://` clone URL into an equivalent `nostr://` URL.
 */
export function p2p_remote_to_nostr(remote: string): string;

/**
 * Append the bridge RTT marker tag to an array of tags, replacing any previous marker.
 */
export function stampBridgeRoundTripTag(tags: any, started_at_ms: bigint): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly git_blame: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
    readonly git_log: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly git_remote_nostr_helper_url: (a: number, b: number) => [number, number, number, number];
    readonly git_remote_transport: (a: number, b: number) => [number, number, number, number];
    readonly normalize_nostr_remote: (a: number, b: number) => [number, number, number, number];
    readonly normalize_p2p_remote: (a: number, b: number) => [number, number, number, number];
    readonly nostr_remote_to_p2p: (a: number, b: number) => [number, number, number, number];
    readonly p2p_remote_to_nostr: (a: number, b: number) => [number, number, number, number];
    readonly __wbg_wasmdag_free: (a: number, b: number) => void;
    readonly extractBridgeRoundTripStartMs: (a: any) => [number, bigint, number, number];
    readonly stampBridgeRoundTripTag: (a: any, b: bigint) => [number, number, number];
    readonly wasmdag_canonical_ids: (a: number) => [number, number];
    readonly wasmdag_insert: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmdag_new: (a: number, b: number) => [number, number, number];
    readonly wasmdag_tip_ids: (a: number) => [number, number];
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly wasm_bindgen_ab874b650d7c13e9___convert__closures_____invoke___wasm_bindgen_ab874b650d7c13e9___JsValue__core_f0fd674eaa06beef___result__Result_____wasm_bindgen_ab874b650d7c13e9___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_ab874b650d7c13e9___convert__closures_____invoke___js_sys_259eee8e32a44776___Function_fn_wasm_bindgen_ab874b650d7c13e9___JsValue_____wasm_bindgen_ab874b650d7c13e9___sys__Undefined___js_sys_259eee8e32a44776___Function_fn_wasm_bindgen_ab874b650d7c13e9___JsValue_____wasm_bindgen_ab874b650d7c13e9___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
