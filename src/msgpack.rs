//! Bounded MessagePack display values, matching the explicit renderer mode.
use serde_json::{Value, json};

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    nodes: usize,
}
impl Decoder<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let end = self.offset.checked_add(n)?;
        let bytes = self.bytes.get(self.offset..end)?;
        self.offset = end;
        Some(bytes)
    }
    fn unsigned(&mut self, n: usize) -> Option<u64> {
        Some(
            self.take(n)?
                .iter()
                .fold(0, |v, b| (v << 8) | u64::from(*b)),
        )
    }
    fn length(&mut self, n: usize) -> Option<usize> {
        usize::try_from(self.unsigned(n)?).ok()
    }
    fn string(&mut self, n: usize) -> Option<Value> {
        let bytes = self.take(n)?;
        Some(match std::str::from_utf8(bytes) {
            Ok(s) => json!(s),
            Err(_) => json!({"$stringBytes":hex(bytes)}),
        })
    }
    fn binary(&mut self, n: usize) -> Option<Value> {
        Some(json!({"$binary":hex(self.take(n)?)}))
    }
    fn extension(&mut self, n: usize) -> Option<Value> {
        let kind = self.unsigned(1)? as i8;
        Some(json!({"$extension":{"type":kind,"hex":hex(self.take(n)?)}}))
    }
    fn array(&mut self, n: usize, depth: usize) -> Option<Value> {
        if n > 10000 - self.nodes {
            return None;
        }
        let mut values = Vec::new();
        for _ in 0..n {
            values.push(self.read(depth + 1)?);
        }
        Some(Value::Array(values))
    }
    fn map(&mut self, n: usize, depth: usize) -> Option<Value> {
        if n > (10000 - self.nodes) / 2 {
            return None;
        }
        let mut pairs = Vec::new();
        let mut object = serde_json::Map::new();
        let mut plain = true;
        for _ in 0..n {
            let key = self.read(depth + 1)?;
            let value = self.read(depth + 1)?;
            if let Some(key) = key.as_str() {
                if object.contains_key(key) {
                    plain = false;
                }
                object.insert(key.into(), value.clone());
            } else {
                plain = false;
            }
            pairs.push(json!([key, value]));
        }
        Some(if plain {
            Value::Object(object)
        } else {
            json!({"$map":pairs})
        })
    }
    fn read(&mut self, depth: usize) -> Option<Value> {
        if depth > 64 || self.nodes >= 10000 {
            return None;
        }
        self.nodes += 1;
        let tag = self.unsigned(1)? as u8;
        Some(match tag {
            0x00..=0x7f => json!(tag),
            0xe0..=0xff => json!(tag as i8),
            0x80..=0x8f => return self.map(usize::from(tag & 15), depth),
            0x90..=0x9f => return self.array(usize::from(tag & 15), depth),
            0xa0..=0xbf => return self.string(usize::from(tag & 31)),
            0xc0 => Value::Null,
            0xc2 => json!(false),
            0xc3 => json!(true),
            0xc4..=0xc6 => {
                let n = self.length(1 << (tag - 0xc4))?;
                return self.binary(n);
            }
            0xc7..=0xc9 => {
                let n = self.length(1 << (tag - 0xc7))?;
                return self.extension(n);
            }
            0xca | 0xcb => {
                let value = if tag == 0xca {
                    f32::from_bits(self.unsigned(4)? as u32) as f64
                } else {
                    f64::from_bits(self.unsigned(8)?)
                };
                if value == 0.0 && value.is_sign_negative() {
                    json!({"$float":"-0"})
                } else if value.is_nan() {
                    json!({"$float":"NaN"})
                } else if value.is_infinite() {
                    json!({"$float":if value.is_sign_negative(){"-Infinity"}else{"Infinity"}})
                } else {
                    json!(value)
                }
            }
            0xcc..=0xcf => {
                let value = self.unsigned(1 << (tag - 0xcc))?;
                if value > 9007199254740991 {
                    json!({"$integer":value.to_string()})
                } else {
                    json!(value)
                }
            }
            0xd0..=0xd3 => {
                let n = 1 << (tag - 0xd0);
                let raw = self.unsigned(n)?;
                let shift = 64 - n * 8;
                let value = ((raw << shift) as i64) >> shift;
                if !(-9007199254740991..=9007199254740991).contains(&value) {
                    json!({"$integer":value.to_string()})
                } else {
                    json!(value)
                }
            }
            0xd4..=0xd8 => return self.extension(1 << (tag - 0xd4)),
            0xd9..=0xdb => {
                let n = self.length(1 << (tag - 0xd9))?;
                return self.string(n);
            }
            0xdc..=0xdd => {
                let n = self.length(2 << (tag - 0xdc))?;
                return self.array(n, depth);
            }
            0xde..=0xdf => {
                let n = self.length(2 << (tag - 0xde))?;
                return self.map(n, depth);
            }
            _ => return None,
        })
    }
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|b| {
            [
                char::from(DIGITS[(b >> 4) as usize]),
                char::from(DIGITS[(b & 15) as usize]),
            ]
        })
        .collect()
}
pub fn decode(bytes: &[u8]) -> Option<Value> {
    if bytes.len() > 65536 {
        return None;
    }
    let mut decoder = Decoder {
        bytes,
        offset: 0,
        nodes: 0,
    };
    let value = decoder.read(0)?;
    (decoder.offset == bytes.len()).then_some(value)
}
pub fn search_text(encoded: &str, truncated: bool) -> String {
    use base64::{Engine, prelude::BASE64_STANDARD};
    if truncated || encoded.len() > 87384 {
        return String::new();
    }
    BASE64_STANDARD
        .decode(encoded)
        .ok()
        .and_then(|bytes| decode(&bytes))
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bytes(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn matches_renderer_vectors_and_rejects_incomplete_values() {
        let vectors: Vec<(String, Value)> =
            serde_json::from_str(include_str!("../scripts/msgpack-vectors.json")).unwrap();
        for (hex, expected) in vectors {
            assert_eq!(decode(&bytes(&hex)), Some(expected), "{hex}");
        }
        for invalid in [
            "",
            "c1",
            "01ff",
            "dbffffffff",
            "ddffffffff",
            "dfffffffff",
            "cf00",
            "a261",
        ] {
            assert_eq!(decode(&bytes(invalid)), None, "{invalid}");
        }
        assert!(decode(&bytes(&("91".repeat(66) + "00"))).is_none());
        assert!(decode(&bytes(&("dc2710".to_owned() + &"00".repeat(10000)))).is_none());
        assert!(decode(&vec![0; 65537]).is_none());
        assert!(search_text("wA==", true).is_empty());
        assert!(search_text("?", false).is_empty());
    }
}
