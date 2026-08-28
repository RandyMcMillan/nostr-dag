//! Standalone native libp2p peer for the nostr-dag gossipsub topic.
//!
//! The process prints its local peer id, listens on a random TCP port, discovers
//! peers via mDNS, and accepts stdin commands:
//!   - any other non-empty line is broadcast as a gossipsub message
//!   - `/broadcast <message>` publishes a message
//!   - `/dial <multiaddr>` dials a peer
//!   - `/status` prints the local peer snapshot
//!   - `/help` shows the command list
//!   - `/quit` exits

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use libp2p::{
    futures::StreamExt,
    gossipsub::{self, IdentTopic, MessageAuthenticity},
    autonat, dcutr, identify, identity, mdns, noise, relay,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId,
};
use nostr_dag::p2p::{NETWORK_TIME_PROTOCOL, NETWORK_TIME_VERSION, NOSTR_DAG_TOPIC};
use nostr_dag::p2p_node::{
    classify_peer_topic_role, classify_peer_topic_role_from_addrs, format_inbound_summary,
    parse_bootstrap_peers, parse_node_command, NodeCommand, PeerRuntime, PeerTopicRole, HELP_TEXT,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
    relay: relay::client::Behaviour,
    identify: identify::Behaviour,
    dcutr: dcutr::Behaviour,
    autonat: autonat::Behaviour,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("p2p_node=info".parse()?)
                .add_directive("nostr_dag=info".parse()?),
        )
        .init();

    let local_key = identity::Keypair::generate_ed25519();
    let runtime_keys = nostr::Keys::generate();
    let mut runtime = PeerRuntime::new_with_self_participation(runtime_keys);
    let local_peer_id = local_key.public().to_peer_id();
    let topic = IdentTopic::new(NOSTR_DAG_TOPIC);
    let bootstrap_peers = parse_bootstrap_peers(std::env::var("P2P_BOOTSTRAP").ok().as_deref());

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

    let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;
    let identify = identify::Behaviour::new(identify::Config::new(
        format!("nostr-dag/{}", env!("CARGO_PKG_VERSION")),
        local_key.public(),
    ));
    let dcutr = dcutr::Behaviour::new(local_peer_id);
    let autonat = autonat::Behaviour::new(
        local_peer_id,
        autonat::Config::default(),
    );

    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(|_, relay| Behaviour {
            gossipsub,
            mdns,
            relay,
            identify,
            dcutr,
            autonat,
        })?
        .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse::<Multiaddr>()?)?;
    for addr in &bootstrap_peers {
        if let Err(err) = swarm.dial(addr.clone()) {
            warn!(%addr, ?err, "bootstrap dial failed");
        } else {
            info!(%addr, "dialled bootstrap peer");
        }
    }

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<NodeCommand>(64);
    let (stdin_ready_tx, stdin_ready_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        let stdin = BufReader::new(tokio::io::stdin());
        let mut lines = stdin.lines();
        let _ = stdin_ready_tx.send(());
        while let Ok(Some(line)) = lines.next_line().await {
            match parse_node_command(&line) {
                Ok(Some(command)) => {
                    if cmd_tx.send(command).await.is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(err) => eprintln!("COMMAND_ERROR {err}"),
            }
        }
    });

    let _ = stdin_ready_rx.await;

    println!(
        "READY peer_id={local_peer_id} nostr_pubkey={} topic={NOSTR_DAG_TOPIC}",
        runtime.public_key()
    );
    println!("BOOTSTRAP peers={}", bootstrap_peers.len());
    println!("HELP\n{HELP_TEXT}");

    let mut discovered_peers = HashSet::<PeerId>::new();
    let mut peer_topic_roles = HashMap::<PeerId, PeerTopicRole>::new();
    let mut relay_peers = HashSet::<PeerId>::new();
    let mut listen_addrs: Vec<String> = Vec::new();

    if let Ok(addr) = std::env::var("P2P_DIAL") {
        let addr = addr.trim();
        if !addr.is_empty() {
            let dial_addr = addr.parse::<Multiaddr>()?;
            println!("DIAL {dial_addr}");
            swarm.dial(dial_addr)?;
        }
    }

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
                    Some(NodeCommand::Dial(addr)) => {
                        info!(%addr, "dial requested");
                        if let Err(err) = swarm.dial(addr) {
                            warn!(?err, "dial failed");
                        }
                    }
                    Some(NodeCommand::Help) => {
                        println!("HELP\n{HELP_TEXT}");
                    }
                    Some(NodeCommand::Status) => {
                        println!(
                            "{} discovered_peers={} relay_peers={} wasm_like_peers={} nat=observing",
                            runtime.status_line(&listen_addrs, swarm.connected_peers().count()),
                            discovered_peers.len(),
                            relay_peers.len(),
                            peer_topic_roles
                                .values()
                                .filter(|role| matches!(role, PeerTopicRole::WasmLike))
                                .count(),
                        );
                    }
                    Some(NodeCommand::Quit) => {
                        println!("SHUTDOWN requested");
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
                        println!("LISTENING {address}");
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                        for (peer_id, addr) in peers {
                            let role = classify_peer_topic_role(&addr);
                            peer_topic_roles.insert(peer_id, role);
                            if discovered_peers.insert(peer_id) {
                                info!(%peer_id, %addr, ?role, "mDNS peer discovered");
                                if matches!(role, PeerTopicRole::WasmLike) {
                                    println!(
                                        "DETECTED wasm-topic peer peer={} addr={}",
                                        peer_id, addr
                                    );
                                } else {
                                    println!(
                                        "DETECTED native-topic peer peer={} addr={}",
                                        peer_id, addr
                                    );
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
                            println!(
                                "DETECTED wasm-topic peer peer={} addr={}",
                                peer_id, remote_addr
                            );
                        } else {
                            println!("DETECTED native-topic peer peer={} addr={}", peer_id, remote_addr);
                        }
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        peer_topic_roles.remove(&peer_id);
                        relay_peers.remove(&peer_id);
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
                        peer_id,
                        info,
                        ..
                    })) => {
                        let role = classify_peer_topic_role_from_addrs(info.listen_addrs.clone());
                        peer_topic_roles.insert(peer_id, role);
                        if matches!(role, PeerTopicRole::WasmLike) {
                            println!(
                                "IDENTIFIED wasm-topic peer peer={} addrs={}",
                                peer_id,
                                info.listen_addrs
                                    .iter()
                                    .map(|addr| addr.to_string())
                                    .collect::<Vec<_>>()
                                    .join(" | ")
                            );
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
                        remote_peer_id,
                        result,
                        ..
                    })) => {
                        match result {
                            Ok(connection_id) => println!(
                                "HOLE_PUNCH success peer={} connection={connection_id:?}",
                                remote_peer_id
                            ),
                            Err(error) => warn!(%remote_peer_id, ?error, "HOLE_PUNCH failed"),
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Relay(relay::client::Event::ReservationReqAccepted { relay_peer_id, .. })) => {
                        relay_peers.insert(relay_peer_id);
                        println!("RELAY reserved peer={relay_peer_id}");
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

                            let reaction = runtime.process_inbound_message(&text);
                            let summary = reaction.summary;
                            let topic_role = peer_topic_roles.get(&propagation_source).copied();
                            println!(
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
                                println!(
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
                                    println!("ACK published");
                                }
                            }
                            debug!(%text, "gossipsub message received");
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

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

fn native_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
