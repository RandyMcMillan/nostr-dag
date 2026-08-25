//! Dual-target libp2p node.
//!
//! * `#[cfg(feature = "p2p")]`       — native Tokio-based `SwarmHandle`
//! * `#[cfg(feature = "p2p-wasm")]`  — WASM `P2pNode` (`#[wasm_bindgen]`)
//!
//! Both expose the same logical interface:
//! * `broadcast(msg)` — publish a UTF-8 message on the nostr-dag gossipsub topic
//! * subscribe / `on_message(cb)` — receive messages from peers

// ---------------------------------------------------------------------------
// Shared constant
// ---------------------------------------------------------------------------

/// Gossipsub topic used by all nostr-dag peers (native and WASM).
pub const NOSTR_DAG_TOPIC: &str = "nostr-dag-bridge";

// ---------------------------------------------------------------------------
// Native implementation
// ---------------------------------------------------------------------------

#[cfg(feature = "p2p")]
pub mod native {
    use std::time::Duration;

    use libp2p::{
        futures::StreamExt,
        gossipsub::{self, IdentTopic, MessageAuthenticity},
        identity,
        mdns,
        noise,
        swarm::{NetworkBehaviour, SwarmEvent},
        tcp,
        yamux,
        Multiaddr,
    };
    use tokio::sync::mpsc;
    use tracing::{debug, info, warn};

    use super::NOSTR_DAG_TOPIC;

    #[derive(NetworkBehaviour)]
    struct Behaviour {
        gossipsub: gossipsub::Behaviour,
        mdns: mdns::tokio::Behaviour,
    }

    /// A running libp2p node.  Cheap to clone — cloning duplicates the sender
    /// handle only.
    #[derive(Clone)]
    pub struct SwarmHandle {
        tx: mpsc::Sender<String>,
    }

    impl SwarmHandle {
        /// Start a new libp2p node, listen on a random TCP port, and return a
        /// handle plus a receiver for inbound messages.
        pub async fn start() -> Result<(Self, mpsc::Receiver<String>), Box<dyn std::error::Error + Send + Sync>> {
            let local_key = identity::Keypair::generate_ed25519();

            let topic = IdentTopic::new(NOSTR_DAG_TOPIC);

            // Gossipsub
            let gossipsub_config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_secs(10))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .build()
                .map_err(|e| format!("gossipsub config: {e}"))?;
            let mut gossipsub = gossipsub::Behaviour::new(
                MessageAuthenticity::Signed(local_key.clone()),
                gossipsub_config,
            )
            .map_err(|e| format!("gossipsub init: {e}"))?;
            gossipsub.subscribe(&topic)?;

            // mDNS
            let mdns = mdns::tokio::Behaviour::new(
                mdns::Config::default(),
                local_key.public().to_peer_id(),
            )?;

            let behaviour = Behaviour { gossipsub, mdns };

            let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
                .with_tokio()
                .with_tcp(
                    tcp::Config::default(),
                    noise::Config::new,
                    yamux::Config::default,
                )?
                .with_behaviour(|_| behaviour)?
                .with_swarm_config(|cfg| {
                    cfg.with_idle_connection_timeout(Duration::from_secs(60))
                })
                .build();

            swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse::<Multiaddr>()?)?;

            let (tx, mut cmd_rx) = mpsc::channel::<String>(64);
            let (event_tx, event_rx) = mpsc::channel::<String>(256);

            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        msg = cmd_rx.recv() => {
                            match msg {
                                Some(text) => {
                                    if let Err(e) = swarm.behaviour_mut().gossipsub.publish(
                                        IdentTopic::new(NOSTR_DAG_TOPIC),
                                        text.as_bytes(),
                                    ) {
                                        warn!(?e, "gossipsub publish failed");
                                    }
                                }
                                None => break,
                            }
                        }
                        event = swarm.select_next_some() => {
                            match event {
                                SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                                    gossipsub::Event::Message { message, .. },
                                )) => {
                                    if let Ok(text) = String::from_utf8(message.data) {
                                        debug!(%text, "gossipsub message received");
                                        let _ = event_tx.send(text).await;
                                    }
                                }
                                SwarmEvent::Behaviour(BehaviourEvent::Mdns(
                                    mdns::Event::Discovered(peers),
                                )) => {
                                    for (peer_id, addr) in peers {
                                        info!(%peer_id, %addr, "mDNS peer discovered");
                                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                                    }
                                }
                                SwarmEvent::Behaviour(BehaviourEvent::Mdns(
                                    mdns::Event::Expired(peers),
                                )) => {
                                    for (peer_id, _) in peers {
                                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                                    }
                                }
                                SwarmEvent::NewListenAddr { address, .. } => {
                                    info!(%address, "p2p listening");
                                }
                                _ => {}
                            }
                        }
                    }
                }
            });

            Ok((Self { tx }, event_rx))
        }

        /// Publish `msg` on the nostr-dag gossipsub topic.
        pub async fn broadcast(&self, msg: String) -> Result<(), mpsc::error::SendError<String>> {
            self.tx.send(msg).await
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Two nodes discover each other via mDNS and exchange a message.
        /// This test is marked `#[ignore]` so it does not run in plain
        /// `cargo test` (mDNS requires a network interface); run it explicitly
        /// with `cargo test --features native,p2p -- --ignored`.
        #[tokio::test]
        #[ignore]
        async fn test_two_peer_gossipsub_echo() {
            let (node_a, mut rx_a) = SwarmHandle::start().await.expect("node a");
            let (node_b, mut rx_b) = SwarmHandle::start().await.expect("node b");

            // Give mDNS time to discover peers.
            tokio::time::sleep(Duration::from_secs(2)).await;

            node_a.broadcast("hello from A".into()).await.unwrap();
            node_b.broadcast("hello from B".into()).await.unwrap();

            // Collect messages for up to 3 s.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            let mut received_a = Vec::new();
            let mut received_b = Vec::new();
            loop {
                tokio::select! {
                    msg = rx_a.recv() => { if let Some(m) = msg { received_a.push(m); } }
                    msg = rx_b.recv() => { if let Some(m) = msg { received_b.push(m); } }
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }

            assert!(received_a.iter().any(|m| m.contains("from B")));
            assert!(received_b.iter().any(|m| m.contains("from A")));
        }
    }
}

// ---------------------------------------------------------------------------
// WASM implementation
// ---------------------------------------------------------------------------

#[cfg(all(feature = "p2p-wasm", target_arch = "wasm32"))]
pub mod wasm_node {
    use js_sys::Function;
    use libp2p::{
        gossipsub::{self, IdentTopic, MessageAuthenticity},
        identity,
        noise,
        swarm::{NetworkBehaviour, SwarmEvent},
        websocket_websys,
        yamux,
    };
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::spawn_local;

    use super::NOSTR_DAG_TOPIC;

    #[derive(NetworkBehaviour)]
    struct Behaviour {
        gossipsub: gossipsub::Behaviour,
    }

    /// Browser-side libp2p node exposed to JavaScript.
    ///
    /// ```js
    /// import init from './pkg/nostr_dag.js';
    /// await init();
    /// const node = new P2pNode();
    /// node.on_message((msg) => console.log('received', msg));
    /// await node.start();
    /// await node.broadcast('hello');
    /// ```
    #[wasm_bindgen]
    pub struct P2pNode {
        local_key: identity::Keypair,
        on_message: Option<Function>,
    }

    #[wasm_bindgen]
    impl P2pNode {
        /// Create a new node with a freshly generated Ed25519 identity.
        #[wasm_bindgen(constructor)]
        pub fn new() -> P2pNode {
            P2pNode {
                local_key: identity::Keypair::generate_ed25519(),
                on_message: None,
            }
        }

        /// Register a JavaScript callback that is invoked for every inbound
        /// gossipsub message.  `cb` receives a single `string` argument.
        pub fn on_message(&mut self, cb: Function) {
            self.on_message = Some(cb);
        }

        /// Start the swarm event loop (non-blocking; runs in a WASM future).
        pub fn start(&self) -> Result<(), JsValue> {
            let local_key = self.local_key.clone();
            let on_message = self.on_message.clone();

            spawn_local(async move {
                if let Err(e) = run_swarm(local_key, on_message).await {
                    web_sys::console::error_1(&e);
                }
            });
            Ok(())
        }

        /// Publish a message on the nostr-dag gossipsub topic.
        /// Returns a Promise that resolves once the publish completes.
        pub async fn broadcast(&self, msg: String) -> Result<(), JsValue> {
            // For the WASM node the publish happens inside the swarm loop.
            // We use a channel stored in thread-local storage.
            OUTBOUND_TX.with(|cell| {
                let borrow = cell.borrow();
                if let Some(tx) = borrow.as_ref() {
                    let _ = tx.try_send(msg);
                }
            });
            Ok(())
        }
    }

    // Thread-local channel used to hand messages from `broadcast` into the
    // swarm event loop.
    use std::cell::RefCell;
    use futures::channel::mpsc as fmpsc;

    thread_local! {
        static OUTBOUND_TX: RefCell<Option<fmpsc::Sender<String>>> = RefCell::new(None);
    }

    async fn run_swarm(
        local_key: identity::Keypair,
        on_message: Option<Function>,
    ) -> Result<(), JsValue> {
        let topic = IdentTopic::new(NOSTR_DAG_TOPIC);

        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .validation_mode(gossipsub::ValidationMode::Strict)
            .build()
            .map_err(|e| JsValue::from_str(&format!("gossipsub config: {e}")))?;
        let mut gossipsub = gossipsub::Behaviour::new(
            MessageAuthenticity::Signed(local_key.clone()),
            gossipsub_config,
        )
        .map_err(|e| JsValue::from_str(&format!("gossipsub init: {e}")))?;
        gossipsub.subscribe(&topic)
            .map_err(|e| JsValue::from_str(&format!("subscribe: {e}")))?;

        let behaviour = Behaviour { gossipsub };

        let (tx, mut cmd_rx) = fmpsc::channel::<String>(64);
        OUTBOUND_TX.with(|cell| {
            *cell.borrow_mut() = Some(tx);
        });

        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
            .with_wasm_bindgen()
            .with_other_transport(|key| {
                websocket_websys::Transport::default()
                    .upgrade(libp2p::core::upgrade::Version::V1)
                    .authenticate(noise::Config::new(key).map_err(|e| {
                        std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                    })?)
                    .multiplex(yamux::Config::default())
                    .boxed()
            })
            .map_err(|e| JsValue::from_str(&format!("transport: {e}")))?
            .with_behaviour(|_| behaviour)
            .map_err(|e| JsValue::from_str(&format!("behaviour: {e}")))?
            .build();

        loop {
            futures::select! {
                msg = cmd_rx.next() => {
                    if let Some(text) = msg {
                        let _ = swarm.behaviour_mut().gossipsub.publish(
                            IdentTopic::new(NOSTR_DAG_TOPIC),
                            text.as_bytes(),
                        );
                    }
                }
                event = swarm.select_next_some() => {
                    if let SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { message, .. },
                    )) = event
                    {
                        if let Ok(text) = String::from_utf8(message.data) {
                            if let Some(cb) = &on_message {
                                let _ = cb.call1(
                                    &JsValue::NULL,
                                    &JsValue::from_str(&text),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
