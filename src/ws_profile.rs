//! Content evidence, never an automatic choice of an arbitrary binary decoder.
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    JsonRpc,
    SocketIo,
    CdpLike,
    Json,
    Text,
    BinaryUtf8,
    Binary,
    GzipHeader,
    ZlibHeader,
    Empty,
    Incomplete,
    Control,
}
impl Kind {
    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(Value::String(value.into())).ok()
    }
}
pub struct Evidence {
    pub kind: Kind,
    pub entry: Option<usize>,
}
pub fn classify(message: &Value) -> Evidence {
    let evidence = |kind| Evidence { kind, entry: None };
    if matches!(
        message["kind"].as_str(),
        Some("PING" | "PONG" | "CLOSE" | "CONTINUATION")
    ) {
        return evidence(Kind::Control);
    }
    if !matches!(message["kind"].as_str(), Some("TEXT" | "BINARY"))
        || message["truncated"] != false
        || !matches!(message["direction"].as_str(), Some("sent" | "received"))
    {
        return evidence(Kind::Incomplete);
    }
    let Some(encoded) = message["base64"].as_str().filter(|s| s.len() <= 87384) else {
        return evidence(Kind::Incomplete);
    };
    let Ok(bytes) = BASE64_STANDARD.decode(encoded) else {
        return evidence(Kind::Incomplete);
    };
    if bytes.len() > 65536 || message["size"].as_u64() != Some(bytes.len() as u64) {
        return evidence(Kind::Incomplete);
    }
    if bytes.is_empty() {
        return evidence(Kind::Empty);
    }
    if message["kind"] == "BINARY" {
        if bytes.len() >= 10 && bytes.starts_with(&[0x1f, 0x8b, 8]) && bytes[3] & 0xe0 == 0 {
            return evidence(Kind::GzipHeader);
        }
        if bytes.len() >= 2
            && bytes[0] & 15 == 8
            && bytes[0] >> 4 <= 7
            && u16::from_be_bytes([bytes[0], bytes[1]]) % 31 == 0
        {
            return evidence(Kind::ZlibHeader);
        }
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return evidence(Kind::Binary);
    };
    if let Some(entry) = crate::jsonrpc::parse_text(text)
        .and_then(|entries| entries.into_iter().find(|entry| entry.envelope.is_some()))
    {
        return Evidence {
            kind: Kind::JsonRpc,
            entry: Some(entry.index),
        };
    }
    if message["kind"] == "TEXT" && crate::socketio::packet(text).is_some() {
        return evidence(Kind::SocketIo);
    }
    if crate::cdp_related::parse_text(text).is_some() {
        return evidence(Kind::CdpLike);
    }
    if serde_json::from_str::<&RawValue>(text).is_ok() {
        return evidence(Kind::Json);
    }
    evidence(if message["kind"] == "BINARY" {
        Kind::BinaryUtf8
    } else {
        Kind::Text
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wrap(bytes: &[u8], kind: &str) -> Value {
        serde_json::json!({"kind":kind,"direction":"sent","truncated":false,"size":bytes.len(),"base64":BASE64_STANDARD.encode(bytes),"text":"ignored display text"})
    }
    #[test]
    fn evidence_uses_saved_bytes_and_does_not_guess_binary_protocols() {
        for (bytes, kind, expected) in [
            (
                br#"{"jsonrpc":"2.0","method":"notify"}"#.as_slice(),
                "TEXT",
                Kind::JsonRpc,
            ),
            (
                br#"[7,{"jsonrpc":"2.0","id":"a","result":0}]"#.as_slice(),
                "BINARY",
                Kind::JsonRpc,
            ),
            (br#"42["ready",{}]"#.as_slice(), "TEXT", Kind::SocketIo),
            (
                br#"{"method":"Runtime.ready","params":{}}"#.as_slice(),
                "TEXT",
                Kind::CdpLike,
            ),
            (
                br#"{"jsonrpc":"1.0","id":1,"result":{}}"#.as_slice(),
                "TEXT",
                Kind::Json,
            ),
            (b"1e400".as_slice(), "TEXT", Kind::Json),
            (b"hello".as_slice(), "TEXT", Kind::Text),
            (b"hello".as_slice(), "BINARY", Kind::BinaryUtf8),
            (b"\x00\x01".as_slice(), "BINARY", Kind::BinaryUtf8),
            (b"\x81\xa1x\x01".as_slice(), "BINARY", Kind::Binary),
            (b"\x08\xff\x01".as_slice(), "BINARY", Kind::Binary),
            (b"".as_slice(), "TEXT", Kind::Empty),
            (b"x".as_slice(), "PING", Kind::Control),
            (
                b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03".as_slice(),
                "BINARY",
                Kind::GzipHeader,
            ),
            (b"\x78\x9c".as_slice(), "BINARY", Kind::ZlibHeader),
            (b"\x78\x9d".as_slice(), "BINARY", Kind::Binary),
        ] {
            assert_eq!(classify(&wrap(bytes, kind)).kind, expected, "{bytes:?}");
        }
        let rpc = wrap(br#"[7,{"jsonrpc":"2.0","id":1,"result":0}]"#, "TEXT");
        assert_eq!(classify(&rpc).entry, Some(1));
        for key in ["truncated", "size", "base64", "direction"] {
            let mut partial = rpc.clone();
            partial[key] = match key {
                "truncated" => true.into(),
                "size" => 1.into(),
                "base64" => "invalid".into(),
                _ => "unknown".into(),
            };
            assert_eq!(classify(&partial).kind, Kind::Incomplete);
        }
    }
}
