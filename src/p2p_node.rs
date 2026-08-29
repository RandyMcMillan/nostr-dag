#[cfg(feature = "p2p")]
use std::collections::{HashMap, HashSet};
#[cfg(feature = "p2p")]
use std::io::Write;
#[cfg(feature = "p2p")]
use std::time::Duration;
#[cfg(feature = "p2p")]
use libp2p::{
    autonat, dcutr, dns, futures::StreamExt, gossipsub::{self, IdentTopic, MessageAuthenticity},
    identify, mdns, multiaddr::Protocol, noise, relay,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId,
};
#[cfg(feature = "p2p")]
use libp2p_webrtc::tokio::{Certificate as WebRtcCertificate, Transport as WebRtcTransport};
#[cfg(feature = "p2p")]
use nostr_relay_pool::prelude::*;
#[cfg(feature = "p2p")]
use libp2p::core::{muxing::StreamMuxerBox, upgrade::Version, Transport};
#[cfg(feature = "p2p")]
use tokio::io::{AsyncBufReadExt, BufReader};
#[cfg(feature = "p2p")]
use tokio::sync::mpsc;
#[cfg(feature = "p2p")]
use tracing::{debug, info, warn};

#[cfg(feature = "p2p")]
use crate::p2p::{
    deterministic_native_identity_keypair, deterministic_native_nostr_keys, NETWORK_TIME_PROTOCOL,
    NETWORK_TIME_VERSION, NOSTR_DAG_TOPIC,
};

#[cfg(feature = "p2p")]
macro_rules! safe_println {
    ($($arg:tt)*) => {{
        let _ = std::writeln!(std::io::stdout(), $($arg)*);
    }};
}

#[cfg(feature = "p2p")]
macro_rules! safe_eprintln {
    ($($arg:tt)*) => {{
        let _ = std::writeln!(std::io::stderr(), $($arg)*);
    }};
}

#[cfg(feature = "p2p")]
#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
    relay: relay::client::Behaviour,
    identify: identify::Behaviour,
    dcutr: dcutr::Behaviour,
    autonat: autonat::Behaviour,
}

#[cfg(feature = "p2p")]
/// Load or generate a self-signed TLS certificate for WSS.
fn load_or_generate_wss_cert() -> Result<(libp2p::websocket::tls::PrivateKey, libp2p::websocket::tls::Certificate), Box<dyn std::error::Error + Send + Sync>> {
    if let (Ok(cert_path), Ok(key_path)) = (std::env::var("WSS_CERT_DER_PATH"), std::env::var("WSS_KEY_DER_PATH")) {
        let cert_der = std::fs::read(&cert_path)?;
        let key_der = std::fs::read(&key_path)?;
        return Ok((
            libp2p::websocket::tls::PrivateKey::new(key_der),
            libp2p::websocket::tls::Certificate::new(cert_der),
        ));
    }
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()])?;
    let priv_key = libp2p::websocket::tls::PrivateKey::new(cert.serialize_private_key_der());
    let cert_der = libp2p::websocket::tls::Certificate::new(cert.serialize_der()?);
    Ok((priv_key, cert_der))
}

#[cfg(feature = "p2p")]
/// Run the native libp2p peer used by the `p2p-node` binary.
pub async fn run_native_p2p_node() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("p2p_node=info".parse()?)
                .add_directive("nostr_dag=info".parse()?),
        )
        .init();

    let local_key = deterministic_native_identity_keypair();
    let runtime_keys = deterministic_native_nostr_keys();
    let mut runtime = PeerRuntime::new_with_self_participation(runtime_keys.clone());
    let local_peer_id = local_key.public().to_peer_id();
    let topic = IdentTopic::new(NOSTR_DAG_TOPIC);
    let bootstrap_peers = parse_bootstrap_peers(std::env::var("P2P_BOOTSTRAP").ok().as_deref());
    let bootstrap_wasm_like = bootstrap_peers
        .iter()
        .filter(|addr| matches!(classify_peer_topic_role(addr), PeerTopicRole::WasmLike))
        .count();

    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(2))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .build()
        .map_err(|e| format!("gossipsub config: {e}"))?;
    let mut gossipsub = gossipsub::Behaviour::new(
        MessageAuthenticity::Signed(local_key.clone()),
        gossipsub_config,
    )
    .map_err(|e| format!("gossipsub init: {e}"))?;
    gossipsub.subscribe(&topic)?;

    let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;
    let identify = identify::Behaviour::new(identify::Config::new(
        format!("nostr-dag/{}", env!("CARGO_PKG_VERSION")),
        local_key.public(),
    ));
    let dcutr = dcutr::Behaviour::new(local_peer_id);
    let autonat = autonat::Behaviour::new(local_peer_id, autonat::Config::default());

    // Build TCP transport manually (no SwarmBuilder so we can inject WSS TLS).
    let tcp_transport = tcp::tokio::Transport::new(tcp::Config::default())
        .upgrade(Version::V1Lazy)
        .authenticate(noise::Config::new(&local_key)?)
        .multiplex(yamux::Config::default())
        .map(|(p, c), _| (p, StreamMuxerBox::new(c)));

    let dns_tcp = dns::tokio::Transport::system(tcp::tokio::Transport::new(tcp::Config::default()))?;
    let mut ws_config = libp2p::websocket::WsConfig::new(dns_tcp);

    if std::env::var("WSS_DISABLE").is_err() {
        match load_or_generate_wss_cert() {
            Ok((priv_key, cert)) => {
                match libp2p::websocket::tls::Config::new(priv_key, vec![cert]) {
                    Ok(tls_cfg) => {
                        ws_config.set_tls_config(tls_cfg);
                        info!("WSS TLS config applied");
                    }
                    Err(e) => warn!("WSS TLS config failed: {e}"),
                }
            }
            Err(e) => warn!("WSS cert generation failed: {e}"),
        }
    }

    let ws_transport = ws_config
        .upgrade(Version::V1Lazy)
        .authenticate(noise::Config::new(&local_key)?)
        .multiplex(yamux::Config::default())
        .map(|(p, c), _| (p, StreamMuxerBox::new(c)));

    let tcp_ws = ws_transport
        .or_transport(tcp_transport)
        .map(|either, _| either.into_inner());

    let (relay_transport, relay_behaviour) = libp2p::relay::client::new(local_peer_id);
    let relay_transport = relay_transport
        .upgrade(Version::V1Lazy)
        .authenticate(noise::Config::new(&local_key)?)
        .multiplex(yamux::Config::default())
        .map(|(p, c), _| (p, StreamMuxerBox::new(c)));
    let relay_tcp_ws = relay_transport
        .or_transport(tcp_ws)
        .map(|either, _| either.into_inner());

    let webrtc_cert = WebRtcCertificate::generate(&mut rand::thread_rng())
        .map_err(|e| format!("webrtc cert: {e}"))?;
    let webrtc_transport = WebRtcTransport::new(local_key.clone(), webrtc_cert)
        .map(|(p, c), _| (p, StreamMuxerBox::new(c)));

    let transport = webrtc_transport
        .or_transport(relay_tcp_ws)
        .map(|either, _| either.into_inner());

    let mut swarm = libp2p::swarm::Swarm::new(
        transport.boxed(),
        Behaviour {
            gossipsub,
            mdns,
            relay: relay_behaviour,
            identify,
            dcutr,
            autonat,
        },
        local_peer_id,
        libp2p::swarm::Config::with_tokio_executor()
            .with_idle_connection_timeout(Duration::from_secs(60)),
    );

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse::<Multiaddr>()?)?;
    swarm.listen_on("/ip4/127.0.0.1/tcp/0/ws".parse::<Multiaddr>()?)?;
    if std::env::var("WSS_DISABLE").is_err() {
        swarm.listen_on("/ip4/0.0.0.0/tcp/0/tls/ws".parse::<Multiaddr>()?)?;
    }
    swarm.listen_on("/ip4/0.0.0.0/udp/0/webrtc-direct".parse::<Multiaddr>()?)?;
    swarm.listen_on("/ip6/::/udp/0/webrtc-direct".parse::<Multiaddr>()?)?;
    for addr in &bootstrap_peers {
        if let Err(err) = swarm.dial(addr.clone()) {
            warn!(%addr, ?err, "bootstrap dial failed");
        } else {
            info!(%addr, "dialled bootstrap peer");
            let mut peer_id = None;
            for protocol in addr.iter() {
                if let Protocol::P2p(value) = protocol {
                    peer_id = Some(value);
                }
            }
            if let Some(peer_id) = peer_id {
                swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
            }
        }
    }

    // Connect to default Nostr relays so the browser on GitHub Pages can discover
    // this peer via kind-0 presence events (fallback when gossipsub mesh is empty).
    let relay_pool = {
        let pool = RelayPool::builder()
            .opts(RelayPoolOptions::new().automatic_authentication(false))
            .build();
        let default_relays = [
            "wss://nos.lol",
            "wss://relay.nostr.com",
            "wss://relay.nostr.band",
            "wss://relay.primal.net",
            "wss://nostr.wine",
            "wss://top.testrelay.top",
            "wss://relay.pocketnostr.com",
            "wss://basspistol.org",
            "wss://relay.ngit.dev",
        ];
        for url in default_relays {
            if let Err(e) = pool.add_relay(url, RelayOptions::default()).await {
                warn!(%url, ?e, "relay add failed");
            }
        }
        pool.connect().await;
        pool
    };

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<NodeCommand>(64);
    let (stdin_ready_tx, stdin_ready_rx) = tokio::sync::oneshot::channel::<()>();
    let cmd_tx_stdin = cmd_tx.clone();

    tokio::spawn(async move {
        let stdin = BufReader::new(tokio::io::stdin());
        let mut lines = stdin.lines();
        let _ = stdin_ready_tx.send(());
        while let Ok(Some(line)) = lines.next_line().await {
            match parse_node_command(&line) {
                Ok(Some(command)) => {
                    if cmd_tx_stdin.send(command).await.is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(err) => safe_eprintln!("COMMAND_ERROR {err}"),
            }
        }
    });

    let _ = stdin_ready_rx.await;

    safe_println!(
        "READY peer_id={local_peer_id} nostr_pubkey={} topic={NOSTR_DAG_TOPIC}",
        runtime.public_key()
    );
    let _ = std::io::stdout().flush();
    safe_println!(
        "BOOTSTRAP peers={} wasm_like={}",
        bootstrap_peers.len(),
        bootstrap_wasm_like
    );
    let _ = std::io::stdout().flush();
    safe_println!("HELP\n{HELP_TEXT}");
    let _ = std::io::stdout().flush();

    // Auto-start git mirrors from GIT_MIRROR_REPOS env var (comma-separated URLs).
    if let Ok(mirror_repos) = std::env::var("GIT_MIRROR_REPOS") {
        for url in mirror_repos.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let url = url.to_string();
            let cmd_tx = cmd_tx.clone();
            tokio::spawn(async move {
                // Stagger startup mirrors so we don't overwhelm the event loop.
                tokio::time::sleep(Duration::from_secs(2)).await;
                let _ = cmd_tx.send(NodeCommand::MirrorRepo(url)).await;
            });
        }
    }

    // Periodic re-mirror every 5 minutes for repos that change frequently.
    let mirror_remirror_cmd_tx = cmd_tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Ok(mirror_repos) = std::env::var("GIT_MIRROR_REPOS") {
                for url in mirror_repos.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    let _ = mirror_remirror_cmd_tx.send(NodeCommand::MirrorRepo(url.to_string())).await;
                }
            }
        }
    });

    let mut discovered_peers = HashSet::<PeerId>::new();
    let mut peer_topic_roles = HashMap::<PeerId, PeerTopicRole>::new();
    let mut relay_peers = HashSet::<PeerId>::new();
    let mut subscribed_topic_peers = HashSet::<PeerId>::new();
    let mut external_addrs = Vec::<String>::new();
    let mut listen_addrs: Vec<String> = Vec::new();
    let mut bundle_cache: HashMap<String, Vec<u8>> = HashMap::new();

    // Index bootstrap peers by PeerId so we can auto-listen on relay circuits.
    let mut bootstrap_peer_addrs = HashMap::<PeerId, Multiaddr>::new();
    for addr in &bootstrap_peers {
        if let Some(pid) = addr.iter().find_map(|p| if let Protocol::P2p(hash) = p {
            PeerId::from_multihash(hash.into()).ok()
        } else { None }) {
            bootstrap_peer_addrs.insert(pid, addr.clone());
        }
    }

    if let Ok(addr) = std::env::var("P2P_DIAL") {
        let addr = addr.trim();
        if !addr.is_empty() {
            let dial_addr = addr.parse::<Multiaddr>()?;
            safe_println!("DIAL {dial_addr}");
            swarm.dial(dial_addr)?;
        }
    }

    let relay_addr = std::env::var("P2P_RELAY").ok().and_then(|addr| addr.trim().parse::<Multiaddr>().ok());
    let relay_peer_id = relay_addr.as_ref().and_then(|addr| {
        addr.iter().find_map(|p| if let Protocol::P2p(hash) = p {
            Some(PeerId::from_multihash(hash.into()).ok()?)
        } else { None })
    });
    if let Some(ref addr) = relay_addr {
        safe_println!("RELAY dial {addr}");
        if let Err(err) = swarm.dial(addr.clone()) {
            warn!(%addr, ?err, "relay dial failed");
        }
    }

    let presence_cmd_tx = cmd_tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if presence_cmd_tx.send(NodeCommand::BroadcastPresence).await.is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            command = cmd_rx.recv() => {
                match command {
                    Some(NodeCommand::Broadcast(message)) => {
                        if let Err(err) = swarm.behaviour_mut().gossipsub.publish(
                            IdentTopic::new(NOSTR_DAG_TOPIC),
                            message.as_bytes(),
                        ) {
                            warn!(?err, "publish failed");
                        }
                    }
                    Some(NodeCommand::BroadcastPresence) => {
                        let addrs_json = listen_addrs
                            .iter()
                            .map(|a| format!("\"{a}\""))
                            .collect::<Vec<_>>()
                            .join(",");
                        let ext_addrs_json = external_addrs
                            .iter()
                            .map(|a| format!("\"{a}\""))
                            .collect::<Vec<_>>()
                            .join(",");
                        let presence = format!(
                            "{{\"type\":\"presence\",\"peer_id\":\"{local_peer_id}\",\"listen_addrs\":[{addrs_json}],\"external_addrs\":[{ext_addrs_json}],\"nostr_pubkey\":\"{}\"}}",
                            runtime.public_key()
                        );
                        if let Err(err) = swarm.behaviour_mut().gossipsub.publish(
                            IdentTopic::new(NOSTR_DAG_TOPIC),
                            presence.into_bytes(),
                        ) {
                            debug!(?err, "presence broadcast failed");
                        } else {
                            safe_println!("PRESENCE broadcast peers={} addrs={}", subscribed_topic_peers.len(), listen_addrs.len());
                            let _ = std::io::stdout().flush();
                        }
                        // Also publish a kind-0 Nostr event so GitHub Pages browsers can discover us.
                        let nostr_content = format!(
                            "{{\"type\":\"presence\",\"peer_id\":\"{local_peer_id}\",\"bridge_peer_id\":\"{local_peer_id}\",\"listen_addrs\":[{addrs_json}],\"external_addrs\":[{ext_addrs_json}],\"nostr_pubkey\":\"{}\",\"bridge_protocol\":\"nostr-dag-bridge\",\"bridge_topic\":\"nostr-dag-bridge\",\"bridge_version\":\"{}\"}}",
                            runtime.public_key(),
                            env!("CARGO_PKG_VERSION")
                        );
                        let tags = vec![
                            nostr::Tag::parse(vec!["t", "nostr-dag"]).expect("valid hashtag tag"),
                            nostr::Tag::parse(vec!["t", "bridge"]).expect("valid hashtag tag"),
                        ];
                        if let Ok(event) = nostr::EventBuilder::new(nostr::Kind::Custom(0), nostr_content)
                            .tags(tags)
                            .sign_with_keys(&runtime_keys)
                        {
                            let pool = relay_pool.clone();
                            tokio::spawn(async move {
                                if let Err(e) = pool.send_event(&event).await {
                                    debug!(?e, "nostr presence publish failed");
                                } else {
                                    safe_println!("NOSTR presence published id={}", event.id);
                                    let _ = std::io::stdout().flush();
                                }
                            });
                        }
                    }
                    Some(NodeCommand::Dial(addr)) => {
                        info!(%addr, "dial requested");
                        if let Err(err) = swarm.dial(addr) {
                            warn!(?err, "dial failed");
                        }
                    }
                    Some(NodeCommand::PublishPipBlob(message)) => {
                        publish_pip_payload(&runtime_keys, message.as_bytes(), &subscribed_topic_peers, &mut swarm, None).await;
                    }
                    Some(NodeCommand::PublishPipPayload(bytes, path)) => {
                        if let Some(ref p) = path {
                            bundle_cache.insert(p.clone(), bytes.clone());
                        }
                        publish_pip_payload(&runtime_keys, &bytes, &subscribed_topic_peers, &mut swarm, path.as_deref()).await;
                    }
                    Some(NodeCommand::MirrorRepo(url)) => {
                        let cmd_tx = cmd_tx.clone();
                        tokio::spawn(async move {
                            safe_println!("MIRROR starting url={}", url);
                            match mirror_repo_bundle(&url).await {
                                Ok(bytes) => {
                                    safe_println!("MIRROR bundle ready url={} bytes={}", url, bytes.len());
                                    let _ = cmd_tx.send(NodeCommand::PublishPipPayload(bytes, Some(url))).await;
                                }
                                Err(e) => {
                                    safe_println!("MIRROR failed url={} err={}", url, e);
                                }
                            }
                        });
                    }
                    Some(NodeCommand::Help) => {
                        safe_println!("HELP\n{HELP_TEXT}");
                    }
                    Some(NodeCommand::Status) => {
                        safe_println!(
                            "{} discovered_peers={} relay_peers={} wasm_like_peers={} external_addrs={} nat=observing",
                            runtime.status_line(&listen_addrs, swarm.connected_peers().count()),
                            discovered_peers.len(),
                            relay_peers.len(),
                            peer_topic_roles
                                .values()
                                .filter(|role| matches!(role, PeerTopicRole::WasmLike))
                                .count(),
                            external_addrs.len(),
                        );
                    }
                    Some(NodeCommand::Quit) => {
                        safe_println!("SHUTDOWN requested");
                        break;
                    }
                    None => break,
                }
            }
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        let address = address.to_string();
                        if !listen_addrs.iter().any(|existing| existing == &address) {
                            listen_addrs.push(address.clone());
                        }
                        safe_println!("LISTENING {address}");
                        let dial_addr = format!("{address}/p2p/{local_peer_id}");
                        safe_println!("DIAL {dial_addr}");
                    }
                    SwarmEvent::ExternalAddrConfirmed { address } => {
                        let address = address.to_string();
                        if !external_addrs.iter().any(|existing| existing == &address) {
                            external_addrs.push(address.clone());
                        }
                        safe_println!("PUBLIC_ADDR {address}");
                    }
                    SwarmEvent::NewExternalAddrOfPeer { peer_id, address } => {
                        safe_println!("PEER_EXTERNAL_ADDR peer={peer_id} addr={address}");
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                        for (peer_id, addr) in peers {
                            let role = classify_peer_topic_role(&addr);
                            peer_topic_roles.insert(peer_id, role);
                            if discovered_peers.insert(peer_id) {
                                info!(%peer_id, %addr, ?role, "mDNS peer discovered");
                                if matches!(role, PeerTopicRole::WasmLike) {
                                    safe_println!("DETECTED wasm-topic peer peer={} addr={}", peer_id, addr);
                                } else {
                                    safe_println!("DETECTED native-topic peer peer={} addr={}", peer_id, addr);
                                }
                            }
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Expired(peers))) => {
                        for (peer_id, _) in peers {
                            discovered_peers.remove(&peer_id);
                            swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                        }
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        let remote_addr = endpoint.get_remote_address().to_string();
                        let role = classify_peer_topic_role(endpoint.get_remote_address());
                        peer_topic_roles.insert(peer_id, role);
                        if matches!(role, PeerTopicRole::WasmLike) {
                            safe_println!("DETECTED wasm-topic peer peer={} addr={}", peer_id, remote_addr);
                        } else {
                            safe_println!("DETECTED native-topic peer peer={} addr={}", peer_id, remote_addr);
                        }
                        // If this is our explicit relay peer, start listening via the relay.
                        if relay_peer_id == Some(peer_id) {
                            if let Some(ref addr) = relay_addr {
                                let circuit = addr.clone().with(Protocol::P2pCircuit);
                                safe_println!("RELAY listening on {circuit}");
                                if let Err(err) = swarm.listen_on(circuit) {
                                    warn!(?err, "relay listen failed");
                                }
                            }
                        }
                        // Also try to listen on a circuit through any bootstrap peer that supports relay.
                        if let Some(addr) = bootstrap_peer_addrs.get(&peer_id) {
                            let circuit = addr.clone().with(Protocol::P2pCircuit);
                            safe_println!("BOOTSTRAP_RELAY listening on {circuit}");
                            if let Err(err) = swarm.listen_on(circuit) {
                                debug!(?err, "bootstrap relay listen failed (peer may not be a relay)");
                            }
                        }
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        peer_topic_roles.remove(&peer_id);
                        relay_peers.remove(&peer_id);
                        subscribed_topic_peers.remove(&peer_id);
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
                        peer_id,
                        info,
                        ..
                    })) => {
                        let role = classify_peer_topic_role_from_addrs(info.listen_addrs.clone());
                        peer_topic_roles.insert(peer_id, role);
                        if matches!(role, PeerTopicRole::WasmLike | PeerTopicRole::NativeLike) {
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                        }
                        if matches!(role, PeerTopicRole::WasmLike) {
                            safe_println!(
                                "IDENTIFIED wasm-topic peer peer={} addrs={}",
                                peer_id,
                                info.listen_addrs
                                    .iter()
                                    .map(|addr| addr.to_string())
                                    .collect::<Vec<_>>()
                                    .join(" | ")
                            );
                        }
                        // Detect relay support and try to obtain a reservation.
                        let hop_str = relay::HOP_PROTOCOL_NAME.to_string();
                        let protocols: Vec<String> = info.protocols.iter().map(|p| p.to_string()).collect();
                        let supports_relay = protocols.iter().any(|p| p == &hop_str);
                        if protocols.iter().any(|p| p.contains("circuit") || p.contains("relay")) {
                            safe_println!("RELAY protocols peer={} protocols={}", peer_id, protocols.join(", "));
                        }
                        if supports_relay && !relay_peers.contains(&peer_id) {
                            for addr in &info.listen_addrs {
                                let mut base = addr.clone();
                                if !base.iter().any(|p| matches!(p, Protocol::P2p(_))) {
                                    base.push(Protocol::P2p(peer_id));
                                }
                                let circuit = base.with(Protocol::P2pCircuit);
                                safe_println!("RELAY try reservation via peer={} circuit={circuit}", peer_id);
                                if let Err(err) = swarm.listen_on(circuit) {
                                    safe_println!("RELAY reservation request failed peer={} err={err:?}", peer_id);
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Subscribed {
                        peer_id,
                        topic: _,
                    })) => {
                        subscribed_topic_peers.insert(peer_id);
                        safe_println!("SUBSCRIBED peer={} topic_peers={}", peer_id, subscribed_topic_peers.len());
                        if matches!(peer_topic_roles.get(&peer_id), Some(PeerTopicRole::WasmLike | PeerTopicRole::NativeLike)) {
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
                        remote_peer_id,
                        result,
                        ..
                    })) => {
                        match result {
                            Ok(connection_id) => safe_println!(
                                "HOLE_PUNCH success peer={} connection={connection_id:?}",
                                remote_peer_id
                            ),
                            Err(error) => warn!(%remote_peer_id, ?error, "HOLE_PUNCH failed"),
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Relay(relay::client::Event::ReservationReqAccepted { relay_peer_id, .. })) => {
                        relay_peers.insert(relay_peer_id);
                        safe_println!("RELAY reserved peer={relay_peer_id}");
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { propagation_source, message, .. },
                    )) => {
                        if let Ok(text) = String::from_utf8(message.data) {
                            if let Some(response) = build_native_time_response(&text, &local_peer_id.to_string()) {
                                let _ = swarm.behaviour_mut().gossipsub.publish(
                                    IdentTopic::new(NOSTR_DAG_TOPIC),
                                    response.as_bytes(),
                                );
                            }

                            // Handle on-demand bundle requests from browsers (PIP.md §15).
                            // When a browser publishes `{"protocol":"nostr-dag-bridge","direction":"request","path":"<url>"}`
                            // we look up the bundle in our local cache and re-publish it if found.
                            if let Some(req_url) = parse_bundle_request(&text) {
                                if let Some(bytes) = bundle_cache.get(&req_url) {
                                    safe_println!("BUNDLE_REQUEST url={} cached_bytes={}", req_url, bytes.len());
                                    let _ = cmd_tx.try_send(NodeCommand::PublishPipPayload(bytes.clone(), Some(req_url)));
                                } else {
                                    safe_println!("BUNDLE_REQUEST url={} not cached", req_url);
                                }
                                continue;
                            }

                            let reaction = runtime.process_inbound_message(&text);
                            let summary = reaction.summary;
                            let topic_role = peer_topic_roles.get(&propagation_source).copied();
                            safe_println!(
                                "{} source={}{}",
                                format_inbound_summary(&summary),
                                propagation_source.to_string(),
                                topic_role
                                    .map(|role| match role {
                                        PeerTopicRole::WasmLike => " topic_peer=wasm-like",
                                        PeerTopicRole::NativeLike => " topic_peer=native-like",
                                    })
                                    .unwrap_or("")
                            );
                            if let Some(event_id) = reaction.inserted_event_id {
                                safe_println!(
                                    "DAG inserted event={event_id} canonical={} tips={}",
                                    reaction.canonical_count,
                                    reaction.tip_count
                                );
                            }
                            for ack in reaction.outbound_messages {
                                if let Err(err) = swarm.behaviour_mut().gossipsub.publish(
                                    IdentTopic::new(NOSTR_DAG_TOPIC),
                                    ack.as_bytes(),
                                ) {
                                    warn!(?err, "ack publish failed");
                                } else {
                                    safe_println!("ACK published");
                                }
                            }
                            debug!(%text, "gossipsub message received");
                        }
                    }
                    SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                        safe_println!("OUTGOING_CONN_ERROR peer={:?} err={}", peer_id, error);
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}


use crate::{
    bridge_native::unwrap_bridge_envelope,
    create_ack_event,
    event::DAG_EVENT_KIND,
    p2p::{
        encode_bridge_message, encode_payload_as_transfer_events_chained, parse_transfer_event,
        TransferEventPayload,
    },
    Dag, InsertResult, PIP_ATTEST_KIND, PIP_JOIN_KIND, PIP_SEAL_KIND,
};

#[cfg(feature = "p2p")]
use nostr::{Event, EventId, Keys, PublicKey};

#[cfg(feature = "p2p")]
use std::collections::BTreeSet;

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerTopicRole {
    NativeLike,
    WasmLike,
}

#[cfg(feature = "p2p")]
pub fn classify_peer_topic_role(address: &Multiaddr) -> PeerTopicRole {
    classify_peer_topic_role_str(&address.to_string())
}

#[cfg(feature = "p2p")]
pub fn classify_peer_topic_role_str(address: &str) -> PeerTopicRole {
    let lowered = address.to_ascii_lowercase();
    if lowered.contains("/ws")
        || lowered.contains("/wss")
        || lowered.contains("/webrtc")
        || lowered.contains("/webtransport")
        || lowered.contains("/p2p-circuit")
    {
        PeerTopicRole::WasmLike
    } else {
        PeerTopicRole::NativeLike
    }
}

#[cfg(feature = "p2p")]
pub fn classify_peer_topic_role_from_addrs(addrs: impl IntoIterator<Item = Multiaddr>) -> PeerTopicRole {
    if addrs
        .into_iter()
        .any(|addr| matches!(classify_peer_topic_role(&addr), PeerTopicRole::WasmLike))
    {
        PeerTopicRole::WasmLike
    } else {
        PeerTopicRole::NativeLike
    }
}

#[cfg(feature = "p2p")]
pub const DEFAULT_BOOTSTRAP_PEERS: &[&str] = &[
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
    "/dns4/sv15.bootstrap.libp2p.io/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dns4/ny5.bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dns4/am6.bootstrap.libp2p.io/tcp/443/wss/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dns4/sg1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

#[cfg(feature = "p2p")]
pub fn parse_bootstrap_peers(raw: Option<&str>) -> Vec<Multiaddr> {
    let source = raw.unwrap_or("").trim();
    let candidates: Vec<&str> = if source.is_empty() {
        DEFAULT_BOOTSTRAP_PEERS.to_vec()
    } else {
        source.split(',').map(str::trim).filter(|item| !item.is_empty()).collect()
    };

    candidates
        .into_iter()
        .filter_map(|item| item.parse::<Multiaddr>().ok())
        .collect()
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeCommand {
    Broadcast(String),
    BroadcastPresence,
    Dial(Multiaddr),
    Help,
    PublishPipBlob(String),
    MirrorRepo(String),
    PublishPipPayload(Vec<u8>, Option<String>),
    Status,
    Quit,
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReaction {
    pub summary: InboundSummary,
    pub outbound_messages: Vec<String>,
    pub inserted_event_id: Option<String>,
    pub canonical_count: usize,
    pub tip_count: usize,
}

#[cfg(feature = "p2p")]
pub struct PeerRuntime {
    keys: Keys,
    dag: Dag,
    participants: BTreeSet<PublicKey>,
}

#[cfg(feature = "p2p")]
#[derive(Debug, thiserror::Error)]
pub enum NipPipPublishError {
    #[error("transfer error: {0}")]
    Transfer(#[from] crate::p2p::TransferError),
    #[error("event build error: {0}")]
    EventBuild(#[from] nostr::event::builder::Error),
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NipPipPublication {
    pub root_id: String,
    pub total_bytes: usize,
    pub total_slices: usize,
    pub manifest_event_id: String,
    pub slice_event_ids: Vec<String>,
    pub messages: Vec<String>,
}

/// Build a complete NIP-PIP publication ready for gossipsub broadcast.
///
/// 1. Packetizes `payload` into a recursive tree with the given `threshold`.
/// 2. Creates a manifest event (kind 39078) and slice events (kind 39079) using
///    [`encode_payload_as_transfer_events_chained`], so each slice references its
///    parent event (manifest for slice 0, previous slice for slice N).
/// 3. Wraps every event in a bridge envelope (`nostr-dag-bridge`) so it can be
///    published directly on the gossipsub topic.
///
/// `path` is stored in the manifest (e.g. the git repo URL) so browsers can
/// index bundles by origin.
#[cfg(feature = "p2p")]
pub fn build_nip_pip_publication(
    keys: &Keys,
    root_id: &str,
    payload: &[u8],
    relay_hints: &[String],
    threshold: usize,
    path: Option<&str>,
) -> Result<NipPipPublication, NipPipPublishError> {
    let (manifest_event, slice_events) =
        encode_payload_as_transfer_events_chained(keys, root_id, payload, threshold, None, path)?;
    let manifest_message =
        encode_bridge_message(&manifest_event, "nostr->libp2p", relay_hints)?;

    let mut slice_event_ids = Vec::with_capacity(slice_events.len());
    let mut messages = Vec::with_capacity(slice_events.len() + 1);
    messages.push(manifest_message);

    for slice_event in &slice_events {
        slice_event_ids.push(slice_event.id.to_hex());
        messages.push(encode_bridge_message(
            slice_event,
            "nostr->libp2p",
            relay_hints,
        )?);
    }

    Ok(NipPipPublication {
        root_id: root_id.to_string(),
        total_bytes: payload.len(),
        total_slices: slice_events.len(),
        manifest_event_id: manifest_event.id.to_hex(),
        slice_event_ids,
        messages,
    })
}

/// Publish a payload as a NIP-PIP manifest + slices over gossipsub.
///
/// Waits up to 20 seconds for at least one subscribed peer before proceeding
/// (logs a warning if none appear).  Uses [`build_nip_pip_publication`] to
/// packetize the payload, then publishes each bridge envelope with retry logic
/// for `InsufficientPeers`.  If `path` is provided the bundle is also stored in
/// the in-memory `bundle_cache` so that on-demand requests can be satisfied
/// without re-packetizing.
#[cfg(feature = "p2p")]
async fn publish_pip_payload(
    runtime_keys: &Keys,
    payload: &[u8],
    subscribed_topic_peers: &HashSet<PeerId>,
    swarm: &mut libp2p::Swarm<Behaviour>,
    path: Option<&str>,
) {
    let mut waited = 0u64;
    while subscribed_topic_peers.is_empty() && waited < 20 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        waited += 1;
    }
    if subscribed_topic_peers.is_empty() {
        warn!("PIP publish proceeding without subscribed peers");
    } else {
        info!(
            subscribed_peers = subscribed_topic_peers.len(),
            "PIP publish has subscribed peers"
        );
    }
    let root_id = format!(
        "nip-pip-{}-{}",
        runtime_keys.public_key(),
        native_now_ms()
    );
    match build_nip_pip_publication(runtime_keys, &root_id, payload, &[], 32768, path) {
        Ok(publication) => {
            let NipPipPublication {
                root_id,
                total_bytes,
                total_slices,
                manifest_event_id,
                slice_event_ids,
                messages,
            } = publication;
            safe_println!(
                "PIP publishing root_id={} bytes={} slices={}",
                root_id, total_bytes, total_slices
            );
            safe_println!(
                "PIP manifest event={} root_id={}",
                manifest_event_id, root_id
            );

            for (index, message) in messages.into_iter().enumerate() {
                let mut attempt = 0usize;
                loop {
                    attempt += 1;
                    match swarm.behaviour_mut().gossipsub.publish(
                        IdentTopic::new(NOSTR_DAG_TOPIC),
                        message.as_bytes(),
                    ) {
                        Ok(_) => break,
                        Err(err)
                            if matches!(
                                err,
                                gossipsub::PublishError::InsufficientPeers
                            ) && attempt < 20 =>
                        {
                            warn!(
                                attempt,
                                ?err,
                                "PIP publish waiting for peers"
                            );
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                        Err(err) => {
                            warn!(attempt, ?err, "PIP publish failed");
                            break;
                        }
                    }
                }
                if index == 0 {
                    safe_println!("PIP manifest staged");
                } else if let Some(slice_event_id) = slice_event_ids.get(index - 1) {
                    safe_println!(
                        "PIP slice staged seq={} event={}",
                        index - 1,
                        slice_event_id
                    );
                } else {
                    safe_println!("PIP slice staged seq={}", index - 1);
                }
            }

            safe_println!(
                "PIP publish attempted root_id={} bytes={} slices={}",
                root_id, total_bytes, total_slices
            );
        }
        Err(err) => warn!(?err, "PIP publish build failed"),
    }
}

#[cfg(feature = "p2p")]
async fn mirror_repo_bundle(
    url: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use sha2::{Digest, Sha256};
    let url_hash = format!("{:x}", Sha256::digest(url.as_bytes()));
    let mirror_dir = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join(".nostr-dag-mirrors")
        .join(&url_hash);
    let bundle_path = mirror_dir.with_extension("bundle");

    if mirror_dir.exists() {
        safe_println!("MIRROR fetch existing url={} dir={}", url, mirror_dir.display());
        let out = tokio::process::Command::new("git")
            .args(["fetch", "--all", "--tags"])
            .current_dir(&mirror_dir)
            .output()
            .await
            .map_err(|e| format!("git fetch spawn failed: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git fetch failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )
            .into());
        }
    } else {
        safe_println!("MIRROR clone starting url={} dir={}", url, mirror_dir.display());
        tokio::fs::create_dir_all(&mirror_dir).await?;
        let out = tokio::process::Command::new("git")
            .args(["clone", "--mirror", url])
            .arg(&mirror_dir)
            .output()
            .await
            .map_err(|e| format!("git clone spawn failed: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git clone failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )
            .into());
        }
    }

    let out = tokio::process::Command::new("git")
        .args([
            "bundle",
            "create",
            bundle_path.to_str().unwrap_or("repo.bundle"),
            "--all",
        ])
        .current_dir(&mirror_dir)
        .output()
        .await
        .map_err(|e| format!("git bundle spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git bundle failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )
        .into());
    }

    let bundle_bytes = tokio::fs::read(&bundle_path).await?;
    safe_println!("MIRROR bundle ready url={} bytes={}", url, bundle_bytes.len());
    Ok(bundle_bytes)
}

#[cfg(feature = "p2p")]
impl PeerRuntime {
    pub fn new(keys: Keys, participants: impl IntoIterator<Item = PublicKey>) -> Self {
        let participants: BTreeSet<PublicKey> = participants.into_iter().collect();
        let dag = Dag::new(participants.iter().copied());
        Self {
            keys,
            dag,
            participants,
        }
    }

    pub fn new_with_self_participation(keys: Keys) -> Self {
        let self_pubkey = keys.public_key();
        Self::new(keys, [self_pubkey])
    }

    pub fn public_key(&self) -> PublicKey {
        self.keys.public_key()
    }

    pub fn participant_count(&self) -> usize {
        self.participants.len()
    }

    pub fn status_line(&self, listen_addrs: &[String], connected_peers: usize) -> String {
        format!(
            "STATUS nostr_pubkey={} listen_addrs={} connected_peers={} participants={} canonical={} tips={}",
            self.public_key(),
            listen_addrs.join(","),
            connected_peers,
            self.participant_count(),
            self.dag.canonical_events().count(),
            self.dag.tips().count(),
        )
    }

    pub fn process_inbound_message(&mut self, message: &str) -> PeerReaction {
        let summary = summarize_inbound_message(message);
        let Some(event) = decode_event_message(message) else {
            return PeerReaction {
                summary,
                outbound_messages: Vec::new(),
                inserted_event_id: None,
                canonical_count: self.dag.canonical_events().count(),
                tip_count: self.dag.tips().count(),
            };
        };

        let inserted_event_id = match self.dag.insert(event.clone()) {
            InsertResult::Inserted(id) | InsertResult::Buffered { event_id: id, .. } => {
                Some(id.to_hex())
            }
            InsertResult::Duplicate => None,
        };

        let mut outbound_messages = Vec::new();
        if should_ack_event(&event) {
            let tips: Vec<EventId> = self.dag.tips().collect();
            if !tips.is_empty() {
                if let Ok(ack) = create_ack_event(&self.keys, &tips) {
                    let ack_json = serde_json::to_string(&ack).unwrap();
                    let _ = self.dag.insert(ack.clone());
                    outbound_messages.push(ack_json);
                }
            }
        }

        PeerReaction {
            summary,
            outbound_messages,
            inserted_event_id,
            canonical_count: self.dag.canonical_events().count(),
            tip_count: self.dag.tips().count(),
        }
    }
}

#[cfg(feature = "p2p")]
pub fn parse_node_command(line: &str) -> Result<Option<NodeCommand>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed == "/help" || trimmed == "help" {
        return Ok(Some(NodeCommand::Help));
    }

    if trimmed == "/status" {
        return Ok(Some(NodeCommand::Status));
    }

    if trimmed == "/quit" || trimmed == "/exit" {
        return Ok(Some(NodeCommand::Quit));
    }

    if let Some(rest) = trimmed.strip_prefix("/dial ") {
        let addr = rest
            .trim()
            .parse::<Multiaddr>()
            .map_err(|err| format!("invalid multiaddr: {err}"))?;
        return Ok(Some(NodeCommand::Dial(addr)));
    }

    if let Some(rest) = trimmed.strip_prefix("/broadcast ") {
        let message = rest.trim();
        if message.is_empty() {
            return Err("/broadcast requires a message".to_string());
        }
        return Ok(Some(NodeCommand::Broadcast(message.to_string())));
    }

    if let Some(rest) = trimmed
        .strip_prefix("/pip ")
        .or_else(|| trimmed.strip_prefix("/nip-pip "))
    {
        let message = rest.trim();
        if message.is_empty() {
            return Err("/pip requires a message".to_string());
        }
        return Ok(Some(NodeCommand::PublishPipBlob(message.to_string())));
    }

    if let Some(rest) = trimmed.strip_prefix("/mirror ") {
        let url = rest.trim();
        if url.is_empty() {
            return Err("/mirror requires a repo URL".to_string());
        }
        return Ok(Some(NodeCommand::MirrorRepo(url.to_string())));
    }

    Ok(Some(NodeCommand::Broadcast(trimmed.to_string())))
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundSummary {
    BridgeEnvelope {
        direction: String,
        topic: String,
        event_id: String,
        relay_hints: usize,
        hop_count: u64,
    },
    TransferManifest {
        root: String,
        size: u64,
        packets: u64,
        depth: u32,
        event_id: String,
    },
    TransferSlice {
        id: String,
        seq_num: u64,
        total_packets: u64,
        is_parity: bool,
        event_id: String,
    },
    NostrEvent {
        kind: String,
        event_id: String,
    },
    Raw {
        message: String,
    },
}

#[cfg(feature = "p2p")]
pub fn summarize_inbound_message(message: &str) -> InboundSummary {
    if let Some(envelope) = unwrap_bridge_envelope(message) {
        return InboundSummary::BridgeEnvelope {
            direction: envelope.direction,
            topic: envelope.topic,
            event_id: envelope.event.id.to_hex(),
            relay_hints: envelope.relay_hints.len(),
            hop_count: envelope.hop_count,
        };
    }

    if let Ok(event) = serde_json::from_str::<nostr::Event>(message) {
        if let Ok(payload) = parse_transfer_event(&event) {
            return match payload {
                TransferEventPayload::Manifest(manifest) => InboundSummary::TransferManifest {
                    root: manifest.root,
                    size: manifest.size,
                    packets: manifest.packets,
                    depth: manifest.depth,
                    event_id: event.id.to_hex(),
                },
                TransferEventPayload::Slice(slice) => InboundSummary::TransferSlice {
                    id: slice.id,
                    seq_num: slice.header.seq_num,
                    total_packets: slice.header.total_packets,
                    is_parity: slice.is_parity,
                    event_id: event.id.to_hex(),
                },
            };
        }

        return InboundSummary::NostrEvent {
            kind: format!("{:?}", event.kind),
            event_id: event.id.to_hex(),
        };
    }

    InboundSummary::Raw {
        message: message.to_string(),
    }
}

#[cfg(feature = "p2p")]
pub fn format_inbound_summary(summary: &InboundSummary) -> String {
    match summary {
        InboundSummary::BridgeEnvelope {
            direction,
            topic,
            event_id,
            relay_hints,
            hop_count,
        } => format!(
            "INBOUND bridge direction={direction} topic={topic} event={event_id} relay_hints={relay_hints} hop_count={hop_count}"
        ),
        InboundSummary::TransferManifest {
            root,
            size,
            packets,
            depth,
            event_id,
        } => format!(
            "INBOUND transfer-manifest root={root} size={size} packets={packets} depth={depth} event={event_id}"
        ),
        InboundSummary::TransferSlice {
            id,
            seq_num,
            total_packets,
            is_parity,
            event_id,
        } => format!(
            "INBOUND transfer-slice id={id} seq={seq_num} total_packets={total_packets} is_parity={is_parity} event={event_id}"
        ),
        InboundSummary::NostrEvent { kind, event_id } => {
            format!("INBOUND nostr-event kind={kind} event={event_id}")
        }
        InboundSummary::Raw { message } => format!("INBOUND raw {message}"),
    }
}

#[cfg(feature = "p2p")]
fn decode_event_message(message: &str) -> Option<Event> {
    if let Some(envelope) = unwrap_bridge_envelope(message) {
        return Some(envelope.event);
    }

    serde_json::from_str::<Event>(message).ok()
}

/// Parse an on-demand bundle request gossipsub message.
///
/// Recognises the lightweight request envelope defined in PIP.md §15:
/// `{"protocol":"nostr-dag-bridge","direction":"request","path":"<repo-url>"}`.
/// Returns the repo URL when the envelope is valid, otherwise `None`.
#[cfg(feature = "p2p")]
fn parse_bundle_request(message: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;
    if parsed.get("protocol")?.as_str()? != "nostr-dag-bridge" {
        return None;
    }
    if parsed.get("direction")?.as_str()? != "request" {
        return None;
    }
    let path = parsed.get("path")?.as_str()?;
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

#[cfg(feature = "p2p")]
fn should_ack_event(event: &Event) -> bool {
    event.kind != DAG_EVENT_KIND
        && event.kind != PIP_ATTEST_KIND
        && event.kind != PIP_SEAL_KIND
        && event.kind != PIP_JOIN_KIND
        && event.kind != crate::p2p::TRANSFER_MANIFEST_KIND
        && event.kind != crate::p2p::TRANSFER_SLICE_KIND
}

#[cfg(feature = "p2p")]
pub const HELP_TEXT: &str = concat!(
    "Commands:\n",
    "  /help                 show this help\n",
    "  /status               print local peer status\n",
    "  /dial <multiaddr>     dial a peer by multiaddr\n",
    "  /pip <message>        publish a PIP/NIP-PIP blob\n",
    "  /mirror <url>         clone a git repo, bundle it, and publish via PIP\n",
    "  /broadcast <message>  publish a message\n",
    "  /quit                 exit the process\n",
    "Any other non-empty line is broadcast as-is.\n",
);

#[cfg(feature = "p2p")]
fn build_native_time_response(message: &str, local_peer_id: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;
    if parsed.get("protocol")?.as_str()? != NETWORK_TIME_PROTOCOL
        || parsed.get("version")?.as_u64()? != NETWORK_TIME_VERSION
        || parsed.get("type")?.as_str()? != "query"
    {
        return None;
    }

    let request_id = parsed.get("request_id")?.as_str()?.trim().to_string();
    if request_id.is_empty() {
        return None;
    }

    let requester_peer_id = parsed
        .get("requester_peer_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    if !requester_peer_id.trim().is_empty() && requester_peer_id == local_peer_id {
        return None;
    }

    let sent_at_ms = parsed.get("sent_at_ms")?.as_i64()?;
    serde_json::to_string(&serde_json::json!({
        "protocol": NETWORK_TIME_PROTOCOL,
        "version": NETWORK_TIME_VERSION,
        "type": "response",
        "request_id": request_id,
        "requester_peer_id": requester_peer_id,
        "responder_peer_id": local_peer_id,
        "sent_at_ms": sent_at_ms,
        "server_time_ms": native_now_ms(),
    }))
    .ok()
}

#[cfg(feature = "p2p")]
fn native_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "p2p")]
    use super::*;

    #[cfg(feature = "p2p")]
    use crate::{
        bridge_native::{build_bridge_envelope, serialize_bridge_envelope, BridgeEnvelopeMeta},
        p2p::{
            build_transfer_manifest_event, build_transfer_slice_event, packetize_payload,
            parse_transfer_event, PacketManifest, TransferEventPayload,
        },
    };

    #[cfg(feature = "p2p")]
    use nostr::{EventBuilder, Keys};
    #[cfg(feature = "p2p")]
    use sha2::Digest;

    #[cfg(feature = "p2p")]
    #[test]
    fn parse_node_command_recognizes_peer_controls() {
        assert!(matches!(parse_node_command("").unwrap(), None));
        assert!(matches!(
            parse_node_command("/help").unwrap(),
            Some(NodeCommand::Help)
        ));
        assert!(matches!(
            parse_node_command("/status").unwrap(),
            Some(NodeCommand::Status)
        ));
        assert!(matches!(
            parse_node_command("/quit").unwrap(),
            Some(NodeCommand::Quit)
        ));
        assert!(matches!(
            parse_node_command("/broadcast hello world").unwrap(),
            Some(NodeCommand::Broadcast(message)) if message == "hello world"
        ));
        assert!(matches!(
            parse_node_command("/pip hello world").unwrap(),
            Some(NodeCommand::PublishPipBlob(message)) if message == "hello world"
        ));
        assert!(matches!(
            parse_node_command("hello world").unwrap(),
            Some(NodeCommand::Broadcast(message)) if message == "hello world"
        ));
        assert!(matches!(
            parse_node_command("/mirror https://github.com/example/repo.git").unwrap(),
            Some(NodeCommand::MirrorRepo(url)) if url == "https://github.com/example/repo.git"
        ));
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn classify_peer_topic_role_marks_browser_like_transports() {
        assert_eq!(
            classify_peer_topic_role_str("/ip4/127.0.0.1/tcp/4001"),
            PeerTopicRole::NativeLike
        );
        assert_eq!(
            classify_peer_topic_role_str("/dns4/example.com/tcp/443/wss/p2p/abc"),
            PeerTopicRole::WasmLike
        );
        assert_eq!(
            classify_peer_topic_role_str("/webrtc/p2p/abc"),
            PeerTopicRole::WasmLike
        );
        assert_eq!(
            classify_peer_topic_role_from_addrs(vec![
                "/ip4/127.0.0.1/tcp/4001".parse().unwrap(),
                "/ip4/127.0.0.1/tcp/4001/p2p-circuit".parse().unwrap()
            ]),
            PeerTopicRole::WasmLike
        );
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn summarize_bridge_and_transfer_messages() {
        let keys = Keys::generate();
        let event = EventBuilder::new(nostr::Kind::Custom(21000), "{\"hello\":\"world\"}")
            .sign_with_keys(&keys)
            .unwrap();

        let envelope = build_bridge_envelope(
            event.clone(),
            "nostr->libp2p",
            ["wss://relay.one".to_string()],
            Some(BridgeEnvelopeMeta {
                topic: "nostr-dag-bridge".to_string(),
                origin_peer_id: "peer-a".to_string(),
                forwarded_by: "peer-b".to_string(),
                hop_count: 2,
                ts: Some(7),
            }),
        );
        let envelope_json = serialize_bridge_envelope(&envelope).unwrap();

        match summarize_inbound_message(&envelope_json) {
            InboundSummary::BridgeEnvelope {
                direction,
                topic,
                event_id,
                relay_hints,
                hop_count,
            } => {
                assert_eq!(direction, "nostr->libp2p");
                assert_eq!(topic, "nostr-dag-bridge");
                assert_eq!(event_id, event.id.to_hex());
                assert_eq!(relay_hints, 1);
                assert_eq!(hop_count, 2);
            }
            other => panic!("unexpected summary: {other:?}"),
        }

        let payload = b"nostr dag peer packet";
        let slices = packetize_payload("root-1", payload, 8);
        let manifest = PacketManifest {
            root: "root-1".to_string(),
            sha256: format!("{:x}", sha2::Sha256::digest(payload)),
            size: payload.len() as u64,
            packets: slices.len() as u64,
            depth: 1,
            mtu: 8,
            encoding: "json".to_string(),
            path: String::new(),
        };
        let manifest_event = build_transfer_manifest_event(&keys, &manifest).unwrap();
        let slice_event = build_transfer_slice_event(&keys, &slices[0], manifest_event.id).unwrap();

        let manifest_json = serde_json::to_string(&manifest_event).unwrap();
        match summarize_inbound_message(&manifest_json) {
            InboundSummary::TransferManifest {
                root,
                size,
                packets,
                depth,
                event_id,
            } => {
                assert_eq!(root, "root-1");
                assert_eq!(size, payload.len() as u64);
                assert_eq!(packets, slices.len() as u64);
                assert_eq!(depth, 1);
                assert_eq!(event_id, manifest_event.id.to_hex());
            }
            other => panic!("unexpected manifest summary: {other:?}"),
        }

        let slice_json = serde_json::to_string(&slice_event).unwrap();
        match summarize_inbound_message(&slice_json) {
            InboundSummary::TransferSlice {
                id,
                seq_num,
                total_packets,
                is_parity,
                event_id,
            } => {
                assert_eq!(id, slices[0].id);
                assert_eq!(seq_num, 0);
                assert_eq!(total_packets, slices.len() as u64);
                assert!(!is_parity);
                assert_eq!(event_id, slice_event.id.to_hex());
            }
            other => panic!("unexpected slice summary: {other:?}"),
        }

        match summarize_inbound_message("plain-text-message") {
            InboundSummary::Raw { message } => assert_eq!(message, "plain-text-message"),
            other => panic!("unexpected raw summary: {other:?}"),
        }
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn runtime_acknowledges_nostr_events_but_not_protocol_frames() {
        let runtime_keys = Keys::generate();
        let sender_keys = Keys::generate();
        let mut runtime = PeerRuntime::new_with_self_participation(runtime_keys.clone());

        let chat_event = EventBuilder::new(nostr::Kind::Custom(42), "{\"hello\":\"peer\"}")
            .sign_with_keys(&sender_keys)
            .unwrap();
        let chat_json = serde_json::to_string(&chat_event).unwrap();
        let reaction = runtime.process_inbound_message(&chat_json);

        assert!(matches!(
            reaction.summary,
            InboundSummary::NostrEvent { .. }
        ));
        assert_eq!(reaction.outbound_messages.len(), 1);
        assert!(reaction.inserted_event_id.is_some());
        assert!(reaction.canonical_count >= 1);
        assert!(reaction.tip_count >= 1);

        let payload = b"native peer protocol sample";
        let slices = packetize_payload("root-protocol", payload, 8);
        let manifest = PacketManifest {
            root: "root-protocol".to_string(),
            sha256: format!("{:x}", sha2::Sha256::digest(payload)),
            size: payload.len() as u64,
            packets: slices.len() as u64,
            depth: 1,
            mtu: 8,
            encoding: "json".to_string(),
            path: String::new(),
        };
        let manifest_event = build_transfer_manifest_event(&runtime_keys, &manifest).unwrap();
        let manifest_json = serde_json::to_string(&manifest_event).unwrap();
        let reaction = runtime.process_inbound_message(&manifest_json);

        assert!(matches!(
            reaction.summary,
            InboundSummary::TransferManifest { .. }
        ));
        assert!(reaction.outbound_messages.is_empty());
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn build_nip_pip_publication_wraps_manifest_and_slices_in_bridge_envelopes() {
        let keys = Keys::generate();
        let publication = build_nip_pip_publication(
            &keys,
            "nip-pip-root",
            b"hello nip-pip network",
            &[],
            8,
            None,
        )
        .unwrap();

        assert_eq!(publication.root_id, "nip-pip-root");
        assert_eq!(publication.total_bytes, b"hello nip-pip network".len());
        assert!(publication.total_slices >= 1);
        assert_eq!(publication.messages.len(), publication.total_slices + 1);
        assert_eq!(publication.slice_event_ids.len(), publication.total_slices);

        let manifest_envelope =
            crate::bridge_native::unwrap_bridge_envelope(&publication.messages[0])
                .expect("manifest bridge envelope");
        match parse_transfer_event(&manifest_envelope.event).unwrap() {
            TransferEventPayload::Manifest(manifest) => {
                assert_eq!(manifest.root, "nip-pip-root");
                assert_eq!(manifest.size, b"hello nip-pip network".len() as u64);
                assert_eq!(manifest.packets, publication.total_slices as u64);
            }
            other => panic!("unexpected manifest payload: {other:?}"),
        }

        let slice_envelope = crate::bridge_native::unwrap_bridge_envelope(&publication.messages[1])
            .expect("slice bridge envelope");
        match parse_transfer_event(&slice_envelope.event).unwrap() {
            TransferEventPayload::Slice(slice) => {
                assert!(slice.id.starts_with("nip-pip-root"));
                assert_eq!(slice.header.total_packets, publication.total_slices as u64);
            }
            other => panic!("unexpected slice payload: {other:?}"),
        }
    }
}
