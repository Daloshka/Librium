//! JSON-RPC 2.0 envelopes. Raw numbers never pass through floating point.
use crate::json_object::Object;
use base64::{Engine, prelude::BASE64_STANDARD};
use serde_json::{Value, value::RawValue};

// The exponent may itself have arbitrarily many digits. Only the mantissa's
// decimal-point / trailing-zero adjustment is bounded by the message size.
fn shift_exponent(exponent: &str, delta: i64) -> String {
    let neg = exponent.starts_with('-');
    let magnitude = exponent
        .trim_start_matches(['-', '+'])
        .trim_start_matches('0');
    let magnitude = if magnitude.is_empty() { "0" } else { magnitude };
    if delta == 0 {
        return format!(
            "{}{magnitude}",
            if neg && magnitude != "0" { "-" } else { "" }
        );
    }
    let other = delta.unsigned_abs().to_string();
    let same_sign = (neg && magnitude != "0") == delta.is_negative();
    let compare = magnitude
        .len()
        .cmp(&other.len())
        .then_with(|| magnitude.cmp(&other));
    let (a, b, negative) = if same_sign {
        (magnitude, other.as_str(), delta.is_negative())
    } else if compare.is_ge() {
        (magnitude, other.as_str(), neg)
    } else {
        (other.as_str(), magnitude, delta.is_negative())
    };
    let mut out = Vec::new();
    let mut carry = 0i16;
    let mut left = a.bytes().rev();
    let mut right = b.bytes().rev();
    loop {
        let (x, y) = (left.next(), right.next());
        if x.is_none() && y.is_none() {
            break;
        }
        let x = i16::from(x.unwrap_or(b'0') - b'0');
        let y = i16::from(y.unwrap_or(b'0') - b'0');
        let n = if same_sign {
            x + y + carry
        } else {
            x - y + carry
        };
        out.push(b'0' + n.rem_euclid(10) as u8);
        carry = if same_sign {
            n / 10
        } else if n < 0 {
            -1
        } else {
            0
        };
    }
    if same_sign && carry > 0 {
        out.push(b'0' + carry as u8);
    }
    while out.len() > 1 && out.last() == Some(&b'0') {
        out.pop();
    }
    out.reverse();
    let value = String::from_utf8(out).unwrap();
    format!("{}{value}", if negative && value != "0" { "-" } else { "" })
}
fn number_key(raw: &str) -> String {
    let (mantissa, exponent) = raw.split_once(['e', 'E']).unwrap_or((raw, "0"));
    let negative = mantissa.starts_with('-');
    let mantissa = mantissa.trim_start_matches('-');
    let fraction = mantissa.split_once('.').map_or(0, |(_, f)| f.len());
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return "0e0".into();
    }
    let coefficient = digits.trim_end_matches('0');
    let shift = (digits.len() - coefficient.len()) as i64 - fraction as i64;
    format!(
        "{}{coefficient}e{}",
        if negative { "-" } else { "" },
        shift_exponent(exponent, shift)
    )
}

pub struct Id {
    pub kind: &'static str,
    pub value: String,
    pub key: String,
}
pub struct Envelope {
    pub id: Option<Id>,
    pub method: Option<String>,
}
pub struct Entry {
    pub index: usize,
    pub envelope: Option<Envelope>,
}
fn identity(raw: &RawValue) -> Option<Id> {
    Some(match raw.get().as_bytes().first()? {
        b'"' => {
            let value = serde_json::from_str::<String>(raw.get()).ok()?;
            Id {
                key: format!("s:{value}"),
                value,
                kind: "string",
            }
        }
        b'n' => Id {
            kind: "null",
            value: "null".into(),
            key: "null".into(),
        },
        b'-' | b'0'..=b'9' => Id {
            kind: "number",
            value: raw.get().into(),
            key: format!("n:{}", number_key(raw.get())),
        },
        _ => return None,
    })
}
pub struct IdQuery(Option<String>);
impl IdQuery {
    pub fn new(query: &str) -> Option<Self> {
        if query.len() > 65536 {
            return None;
        }
        let query = query.trim_matches(|c: char| c.is_ascii_whitespace());
        if query.is_empty() {
            return Some(Self(None));
        }
        let raw: &RawValue = serde_json::from_str(query).ok()?;
        Some(Self(Some(identity(raw)?.key)))
    }
    pub fn matches(&self, envelope: &Envelope) -> bool {
        envelope
            .id
            .as_ref()
            .is_some_and(|id| self.0.as_ref().is_none_or(|key| key == &id.key))
    }
}
pub fn normalize_id_query(query: &str) -> Option<String> {
    IdQuery::new(query)?;
    Some(query.trim_matches(|c: char| c.is_ascii_whitespace()).into())
}
pub fn matching_entries(message: &Value, method: Option<&str>, id: Option<&IdQuery>) -> Vec<usize> {
    parse(message)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let envelope = entry.envelope?;
            let matched = if let Some(method) = method {
                envelope
                    .method
                    .as_ref()
                    .is_some_and(|value| value.contains(method))
            } else {
                id.is_some_and(|id| id.matches(&envelope))
            };
            matched.then_some(entry.index)
        })
        .collect()
}
fn envelope(raw: &RawValue) -> Option<Envelope> {
    let Object(fields) = serde_json::from_str(raw.get()).ok()?;
    let string = |key: &str| {
        fields
            .get(key)
            .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
    };
    if string("jsonrpc").as_deref() != Some("2.0") {
        return None;
    }
    let id = match fields.get("id") {
        None => None,
        Some(raw) => Some(identity(raw)?),
    };
    let method = if fields.contains_key("method") {
        if fields.contains_key("result") || fields.contains_key("error") {
            return None;
        }
        if fields
            .get("params")
            .is_some_and(|v| !matches!(v.get().as_bytes().first(), Some(b'{' | b'[')))
        {
            return None;
        }
        Some(string("method")?)
    } else {
        if id.is_none()
            || fields.contains_key("params")
            || fields.contains_key("result") == fields.contains_key("error")
        {
            return None;
        }
        if let Some(error) = fields.get("error") {
            let Object(error) = serde_json::from_str(error.get()).ok()?;
            let code = error.get("code")?.get();
            if !matches!(code.as_bytes().first(), Some(b'-' | b'0'..=b'9'))
                || number_key(code).split_once('e')?.1.starts_with('-')
                || serde_json::from_str::<String>(error.get("message")?.get()).is_err()
            {
                return None;
            }
        }
        None
    };
    Some(Envelope { id, method })
}
pub fn parse(message: &Value) -> Option<Vec<Entry>> {
    if message["truncated"] != false
        || !matches!(message["kind"].as_str()?, "TEXT" | "BINARY")
        || !matches!(message["direction"].as_str()?, "sent" | "received")
    {
        return None;
    }
    let encoded = message["base64"].as_str()?;
    if encoded.len() > 87384 {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if bytes.len() > 65536 || message["size"].as_u64()? != bytes.len() as u64 {
        return None;
    }
    parse_text(std::str::from_utf8(&bytes).ok()?)
}
pub fn parse_text(text: &str) -> Option<Vec<Entry>> {
    if text.len() > 65536 {
        return None;
    }
    let raw: &RawValue = serde_json::from_str(text).ok()?;
    let items: Vec<&RawValue> = if raw.get().starts_with('[') {
        serde_json::from_str(raw.get()).ok()?
    } else {
        vec![raw]
    };
    if items.is_empty() || items.len() > 256 {
        return None;
    }
    Some(
        items
            .into_iter()
            .enumerate()
            .map(|(index, raw)| Entry {
                index,
                envelope: envelope(raw),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn id_search_queries_share_literal_validation_with_renderer() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/jsonrpc-id-search-vectors.json"))
                .unwrap();
        for pair in vectors["valid"].as_array().unwrap() {
            assert_eq!(
                normalize_id_query(pair[0].as_str().unwrap()).as_deref(),
                pair[1].as_str()
            );
        }
        for input in vectors["invalid"].as_array().unwrap() {
            assert!(
                normalize_id_query(input.as_str().unwrap()).is_none(),
                "{input}"
            );
        }
        assert!(normalize_id_query(&format!("\"{}\"", "я".repeat(32768))).is_none());
    }
    #[test]
    fn decimal_identity_does_not_round_or_limit_exponents() {
        for n in -200i64..=200 {
            assert_eq!(
                number_key(&n.to_string()),
                number_key(&format!("{}e-1", n * 10))
            );
            assert_eq!(number_key(&n.to_string()), number_key(&format!("{n}.000")));
        }
        for (a, b) in [
            ("1", "1.000e0"),
            ("1000", "1e3"),
            ("-0.0e-999", "0"),
            ("0.00120", "12e-4"),
            ("-10e-100000000000000000000", "-1e-99999999999999999999"),
            ("10e99999999999999999999", "1e100000000000000000000"),
        ] {
            assert_eq!(number_key(a), number_key(b), "{a} {b}");
        }
        assert_ne!(
            number_key("9007199254740993"),
            number_key("9007199254740992")
        );
        assert_ne!(number_key("1e400"), number_key("1e401"));
    }
    #[test]
    fn raw_envelopes_validate_protocol_members_and_keep_batch_positions() {
        let wrap = |text: &str| serde_json::json!({"kind":"TEXT","direction":"sent","truncated":false,"size":text.len(),"base64":BASE64_STANDARD.encode(text)});
        let entries=parse(&wrap(r#"[{"jsonrpc":"2.0","method":"x","id":1e400},7,{"jsonrpc":"2.0","result":{},"id":"1"},{"jsonrpc":"2.0","method":"notice"}]"#)).unwrap();
        assert_eq!(entries.len(), 4);
        assert!(entries[1].envelope.is_none());
        assert_eq!(entries[2].index, 2);
        assert!(entries[3].envelope.as_ref().unwrap().id.is_none());
        for text in [
            r#"{"jsonrpc":"2.0","id":1,"i\u0064":2,"result":{}}"#,
            r#"{"jsonrpc":"2.0","id":true,"result":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"x","params":null}"#,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":1.5,"message":"bad"}}"#,
            r#"{"id":1,"result":{}}"#,
        ] {
            assert!(parse(&wrap(text)).unwrap()[0].envelope.is_none(), "{text}");
        }
        assert!(parse(&wrap("[]")).is_none());
        let mut partial = wrap(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        partial["truncated"] = true.into();
        assert!(parse(&partial).is_none());
    }
}
