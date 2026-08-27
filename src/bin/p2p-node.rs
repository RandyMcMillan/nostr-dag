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

use std::collections::HashSet;
use std::time::Duration;

use libp2p::{
    futures::StreamExt,
    gossipsub::{self, IdentTopic, MessageAuthenticity},
    identity, mdns, noise,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId,
};
use nostr_dag::p2p::{NETWORK_TIME_PROTOCOL, NETWORK_TIME_VERSION, NOSTR_DAG_TOPIC};
use nostr_dag::p2p_node::{
    format_inbound_summary, parse_node_command, summarize_inbound_message, NodeCommand, HELP_TEXT,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
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
    let local_peer_id = local_key.public().to_peer_id();
    let topic = IdentTopic::new(NOSTR_DAG_TOPIC);

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

    let behaviour = Behaviour { gossipsub, mdns };

    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_behaviour(|_| behaviour)?
        .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse::<Multiaddr>()?)?;

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

    println!("READY peer_id={local_peer_id} topic={NOSTR_DAG_TOPIC}");
    println!("HELP\n{HELP_TEXT}");

    let mut discovered_peers = HashSet::<PeerId>::new();
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
                            "STATUS peer_id={local_peer_id} listen_addrs={} connected_peers={} discovered_peers={}",
                            listen_addrs.join(","),
                            swarm.connected_peers().count(),
                            discovered_peers.len(),
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
                            if discovered_peers.insert(peer_id) {
                                info!(%peer_id, %addr, "mDNS peer discovered");
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

                            let summary = summarize_inbound_message(&text);
                            println!(
                                "{} source={}",
                                format_inbound_summary(&summary),
                                propagation_source.to_string()
                            );
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
