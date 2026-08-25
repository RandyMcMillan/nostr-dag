//! NIP-34 `nostr://` clone URL parsing and helper utilities.
//!
//! Supports the NIP-34 clone URL formats:
//! - `nostr://<naddr>`
//! - `nostr://<npub|nip05>/<identifier>`
//! - `nostr://<npub|nip05>/<relay-hint>/<identifier>`

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NostrRemote {
    Announcement { naddr: String },
    Coordinate {
        owner: String,
        relay_hint: Option<String>,
        identifier: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Nip34Error {
    InvalidScheme,
    EmptyAuthority,
    MissingIdentifier,
    InvalidPathSegments,
    InvalidPercentEncoding,
    UnsupportedRemoteScheme,
}

impl std::fmt::Display for Nip34Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidScheme => write!(f, "expected nostr:// URL"),
            Self::EmptyAuthority => write!(f, "nostr:// URL is missing authority"),
            Self::MissingIdentifier => write!(f, "nostr:// coordinate is missing identifier"),
            Self::InvalidPathSegments => write!(f, "nostr:// URL has invalid path segments"),
            Self::InvalidPercentEncoding => write!(f, "nostr:// URL has invalid percent encoding"),
            Self::UnsupportedRemoteScheme => write!(f, "unsupported remote URL scheme"),
        }
    }
}

impl std::error::Error for Nip34Error {}

pub fn parse_nostr_clone_url(input: &str) -> Result<NostrRemote, Nip34Error> {
    parse_clone_url_with_scheme(input, "nostr://")
}

pub fn parse_p2p_clone_url(input: &str) -> Result<NostrRemote, Nip34Error> {
    parse_clone_url_with_scheme(input, "p2p://")
}

pub fn normalize_p2p_clone_url(input: &str) -> Result<String, Nip34Error> {
    let parsed = parse_p2p_clone_url(input)?;
    Ok(format_clone_url("p2p://", parsed))
}

pub fn p2p_to_nostr_clone_url(input: &str) -> Result<String, Nip34Error> {
    let parsed = parse_p2p_clone_url(input)?;
    Ok(format_clone_url("nostr://", parsed))
}

pub fn nostr_to_p2p_clone_url(input: &str) -> Result<String, Nip34Error> {
    let parsed = parse_nostr_clone_url(input)?;
    Ok(format_clone_url("p2p://", parsed))
}

pub fn git_remote_transport_url(input: &str) -> Result<String, Nip34Error> {
    if input.starts_with("nostr://") {
        return Ok(format!("nostr::{}", normalize_nostr_clone_url(input)?));
    }
    if input.starts_with("p2p://") {
        return Ok(format!("p2p::{}", normalize_p2p_clone_url(input)?));
    }
    if input.starts_with("https://")
        || input.starts_with("http://")
        || input.starts_with("ssh://")
        || input.starts_with("git@")
    {
        return Ok(input.to_string());
    }
    Err(Nip34Error::UnsupportedRemoteScheme)
}

fn parse_clone_url_with_scheme(input: &str, scheme: &str) -> Result<NostrRemote, Nip34Error> {
    let rest = input.strip_prefix(scheme).ok_or(Nip34Error::InvalidScheme)?;

    if rest.is_empty() {
        return Err(Nip34Error::EmptyAuthority);
    }
    if rest.contains('?') || rest.contains('#') {
        return Err(Nip34Error::InvalidPathSegments);
    }

    let mut parts = rest.split('/');
    let owner_or_naddr = parts.next().ok_or(Nip34Error::EmptyAuthority)?;
    if owner_or_naddr.is_empty() {
        return Err(Nip34Error::EmptyAuthority);
    }

    let remaining: Vec<&str> = parts.collect();
    match remaining.as_slice() {
        [] => Ok(NostrRemote::Announcement {
            naddr: owner_or_naddr.to_string(),
        }),
        [identifier_enc] => {
            if identifier_enc.is_empty() {
                return Err(Nip34Error::MissingIdentifier);
            }
            let identifier = percent_decode(identifier_enc)?;
            Ok(NostrRemote::Coordinate {
                owner: owner_or_naddr.to_string(),
                relay_hint: None,
                identifier,
            })
        }
        [relay_hint_enc, identifier_enc] => {
            if relay_hint_enc.is_empty() || identifier_enc.is_empty() {
                return Err(Nip34Error::MissingIdentifier);
            }
            let relay_hint = percent_decode(relay_hint_enc)?;
            let identifier = percent_decode(identifier_enc)?;
            Ok(NostrRemote::Coordinate {
                owner: owner_or_naddr.to_string(),
                relay_hint: Some(relay_hint),
                identifier,
            })
        }
        _ => Err(Nip34Error::InvalidPathSegments),
    }
}

pub fn normalize_nostr_clone_url(input: &str) -> Result<String, Nip34Error> {
    let parsed = parse_nostr_clone_url(input)?;
    Ok(format_clone_url("nostr://", parsed))
}

pub fn git_remote_helper_url(input: &str) -> Result<String, Nip34Error> {
    let normalized = normalize_nostr_clone_url(input)?;
    Ok(format!("nostr::{normalized}"))
}

fn format_clone_url(scheme: &str, parsed: NostrRemote) -> String {
    match parsed {
        NostrRemote::Announcement { naddr } => format!("{scheme}{naddr}"),
        NostrRemote::Coordinate {
            owner,
            relay_hint,
            identifier,
        } => {
            let identifier_enc = percent_encode(&identifier);
            if let Some(relay_hint) = relay_hint {
                let relay_enc = percent_encode(&relay_hint);
                format!("{scheme}{owner}/{relay_enc}/{identifier_enc}")
            } else {
                format!("{scheme}{owner}/{identifier_enc}")
            }
        }
    }
}

fn percent_decode(value: &str) -> Result<String, Nip34Error> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(Nip34Error::InvalidPercentEncoding);
            }
            let hi = decode_hex(bytes[i + 1]).ok_or(Nip34Error::InvalidPercentEncoding)?;
            let lo = decode_hex(bytes[i + 2]).ok_or(Nip34Error::InvalidPercentEncoding)?;
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| Nip34Error::InvalidPercentEncoding)
}

fn decode_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0F) as usize] as char);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn interop_vectors() -> Vec<Value> {
        let raw = include_str!("../test/fixtures/nip34-interop-vectors.json");
        serde_json::from_str(raw).expect("valid fixture json")
    }

    #[test]
    fn interop_vectors_match_rust_helper_behavior() {
        for fixture in interop_vectors() {
            let input = fixture["input"].as_str().expect("fixture input");
            let normalized = fixture["normalized"].as_str().expect("fixture normalized");
            let helper = fixture["helper"].as_str().expect("fixture helper");
            let kind = fixture["kind"].as_str().expect("fixture kind");

            let parsed = parse_nostr_clone_url(input).expect("parse fixture input");
            assert_eq!(normalize_nostr_clone_url(input).unwrap(), normalized);
            assert_eq!(git_remote_helper_url(input).unwrap(), helper);

            match (kind, parsed) {
                ("announcement", NostrRemote::Announcement { naddr }) => {
                    assert_eq!(naddr, fixture["naddr"].as_str().unwrap());
                }
                (
                    "coordinate",
                    NostrRemote::Coordinate {
                        owner,
                        relay_hint,
                        identifier,
                    },
                ) => {
                    assert_eq!(owner, fixture["owner"].as_str().unwrap());
                    assert_eq!(relay_hint.as_deref(), fixture["relay_hint"].as_str());
                    assert_eq!(identifier, fixture["identifier"].as_str().unwrap());
                }
                _ => panic!("fixture kind did not match parsed result"),
            }
        }
    }

    #[test]
    fn rejects_invalid_scheme() {
        assert!(matches!(
            parse_nostr_clone_url("https://example.com/repo"),
            Err(Nip34Error::InvalidScheme)
        ));
    }

    #[test]
    fn converts_nostr_and_p2p_urls() {
        let nostr = "nostr://npub1abcd/ws%3A%2F%2Flocalhost%3A7447/repo";
        let p2p = "p2p://npub1abcd/ws%3A%2F%2Flocalhost%3A7447/repo";
        assert_eq!(nostr_to_p2p_clone_url(nostr).unwrap(), p2p);
        assert_eq!(p2p_to_nostr_clone_url(p2p).unwrap(), nostr);
    }

    #[test]
    fn supports_transport_url_for_known_schemes() {
        assert_eq!(
            git_remote_transport_url("nostr://naddr1qqx8xq").unwrap(),
            "nostr::nostr://naddr1qqx8xq"
        );
        assert_eq!(
            git_remote_transport_url("p2p://naddr1qqx8xq").unwrap(),
            "p2p::p2p://naddr1qqx8xq"
        );
        assert_eq!(
            git_remote_transport_url("https://github.com/RandyMcMillan/nostr-dag").unwrap(),
            "https://github.com/RandyMcMillan/nostr-dag"
        );
        assert_eq!(
            git_remote_transport_url("ssh://git@github.com/RandyMcMillan/nostr-dag.git").unwrap(),
            "ssh://git@github.com/RandyMcMillan/nostr-dag.git"
        );
        assert_eq!(
            git_remote_transport_url("git@github.com:RandyMcMillan/nostr-dag.git").unwrap(),
            "git@github.com:RandyMcMillan/nostr-dag.git"
        );
        assert!(matches!(
            git_remote_transport_url("ftp://example.com/repo.git"),
            Err(Nip34Error::UnsupportedRemoteScheme)
        ));
    }
}
