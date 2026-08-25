//! WASM fetch shim for git operations — available only with the `wasm` feature.
//!
//! Exposes the same `git_log` / `git_blame` surface as the native `git` module
//! but delegates to the `/git/log` and `/git/blame` HTTP routes already served
//! by `nostr-dag-server` (or any compatible backend).

#[cfg(feature = "wasm")]
pub mod wasm {
    use crate::nip34::{
        git_remote_helper_url, git_remote_transport_url, normalize_nostr_clone_url,
        normalize_p2p_clone_url, nostr_to_p2p_clone_url, p2p_to_nostr_clone_url,
    };
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{Request, RequestInit, RequestMode, Response};

    /// Fetch the git log for `repo` from the local server.
    ///
    /// `base_url` should point to the root of the nostr-dag server, e.g.
    /// `"http://127.0.0.1:3000"`.  `limit` is the maximum number of commits to
    /// return.  Returns a JSON string that matches the native `Vec<CommitInfo>`
    /// serialisation.
    #[wasm_bindgen]
    pub async fn git_log(base_url: &str, repo: &str, limit: u32) -> Result<String, JsValue> {
        let url = format!("{base_url}/git/log?repo={repo}&limit={limit}");
        fetch_text(&url).await
    }

    /// Fetch blame information for `file` in `repo` at `commit_ish` from the
    /// local server.  Returns a JSON string matching `Vec<BlameHunk>`.
    #[wasm_bindgen]
    pub async fn git_blame(
        base_url: &str,
        repo: &str,
        file: &str,
        commit_ish: &str,
    ) -> Result<String, JsValue> {
        let url = format!(
            "{base_url}/git/blame?repo={repo}&file={file}&commit={commit_ish}"
        );
        fetch_text(&url).await
    }

    /// Normalize a NIP-34 `nostr://` clone URL for consistent cross-runtime use.
    #[wasm_bindgen]
    pub fn normalize_nostr_remote(remote: &str) -> Result<String, JsValue> {
        normalize_nostr_clone_url(remote).map_err(|err| JsValue::from_str(&err.to_string()))
    }

    /// Return a Git remote-helper URL (`nostr::nostr://...`) for native clone handoff.
    #[wasm_bindgen]
    pub fn git_remote_nostr_helper_url(remote: &str) -> Result<String, JsValue> {
        git_remote_helper_url(remote).map_err(|err| JsValue::from_str(&err.to_string()))
    }

    /// Normalize a `p2p://` clone URL for consistent cross-runtime use.
    #[wasm_bindgen]
    pub fn normalize_p2p_remote(remote: &str) -> Result<String, JsValue> {
        normalize_p2p_clone_url(remote).map_err(|err| JsValue::from_str(&err.to_string()))
    }

    /// Convert a `nostr://` clone URL into an equivalent `p2p://` URL.
    #[wasm_bindgen]
    pub fn nostr_remote_to_p2p(remote: &str) -> Result<String, JsValue> {
        nostr_to_p2p_clone_url(remote).map_err(|err| JsValue::from_str(&err.to_string()))
    }

    /// Convert a `p2p://` clone URL into an equivalent `nostr://` URL.
    #[wasm_bindgen]
    pub fn p2p_remote_to_nostr(remote: &str) -> Result<String, JsValue> {
        p2p_to_nostr_clone_url(remote).map_err(|err| JsValue::from_str(&err.to_string()))
    }

    /// Return a transport-ready URL for clone/fetch (`nostr::`, `p2p::`, HTTP(S), SSH).
    #[wasm_bindgen]
    pub fn git_remote_transport(remote: &str) -> Result<String, JsValue> {
        git_remote_transport_url(remote).map_err(|err| JsValue::from_str(&err.to_string()))
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    async fn fetch_text(url: &str) -> Result<String, JsValue> {
        let mut opts = RequestInit::new();
        opts.method("GET");
        opts.mode(RequestMode::Cors);

        let request = Request::new_with_str_and_init(url, &opts)?;

        let window = web_sys::window().ok_or_else(|| JsValue::from_str("no window"))?;
        let resp_value = JsFuture::from(window.fetch_with_request(&request)).await?;
        let resp: Response = resp_value.dyn_into()?;

        if !resp.ok() {
            return Err(JsValue::from_str(&format!(
                "HTTP {} for {}",
                resp.status(),
                url
            )));
        }

        let text = JsFuture::from(resp.text()?).await?;
        text.as_string()
            .ok_or_else(|| JsValue::from_str("response body was not a string"))
    }
}
