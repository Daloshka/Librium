//! Schema-free Protobuf wire view, matching the explicit renderer decoder.
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
    fn varint(&mut self) -> Option<u64> {
        let mut value = 0;
        for i in 0..10 {
            let b = self.take(1)?[0];
            if i == 9 && b > 1 {
                return None;
            }
            value |= u64::from(b & 127) << (i * 7);
            if b & 128 == 0 {
                return Some(value);
            }
        }
        None
    }
    fn fields(&mut self, depth: usize, group: Option<u64>) -> Option<Value> {
        if depth > 64 {
            return None;
        }
        let mut rows = Vec::new();
        while self.offset < self.bytes.len() {
            let offset = self.offset;
            let tag = self.varint()?;
            let field = tag >> 3;
            let wire = tag & 7;
            if !(1..=536870911).contains(&field) {
                return None;
            }
            if wire == 4 {
                return (group == Some(field)).then_some(json!(rows));
            }
            self.nodes += 1;
            if self.nodes > 10000 {
                return None;
            }
            let name = match wire {
                0 => "VARINT",
                1 => "I64",
                2 => "LEN",
                3 => "SGROUP",
                5 => "I32",
                _ => return None,
            };
            let mut row = json!({"offset":offset,"field":field,"wire":name});
            match wire {
                0 => row["value"] = json!(self.varint()?.to_string()),
                1 | 5 => row["hex"] = json!(hex(self.take(if wire == 1 { 8 } else { 4 })?)),
                2 => {
                    let size = usize::try_from(self.varint()?).ok()?;
                    let bytes = self.take(size)?;
                    row["hex"] = json!(hex(bytes));
                    if let Ok(text) = std::str::from_utf8(bytes) {
                        row["utf8"] = json!(text);
                    }
                }
                3 => row["fields"] = self.fields(depth + 1, Some(field))?,
                _ => unreachable!(),
            }
            rows.push(row);
        }
        group.is_none().then_some(json!(rows))
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn decode(bytes: &[u8]) -> Option<Value> {
    if bytes.len() > 65536 {
        return None;
    }
    Decoder {
        bytes,
        offset: 0,
        nodes: 0,
    }
    .fields(0, None)
}
pub fn search_text(encoded: &str, truncated: bool) -> String {
    use base64::{Engine, prelude::BASE64_STANDARD};
    if truncated || encoded.len() > 87384 {
        return String::new();
    }
    BASE64_STANDARD
        .decode(encoded)
        .ok()
        .and_then(|b| decode(&b))
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
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
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn wire_vectors_match_renderer_and_bound_malformed_input() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/protobuf-vectors.json")).unwrap();
        for row in vectors["valid"].as_array().unwrap() {
            let hex = row[0].as_str().unwrap();
            assert_eq!(decode(&bytes(hex)), Some(row[1].clone()), "{hex}");
        }
        for row in vectors["invalid"].as_array().unwrap() {
            let hex = row.as_str().unwrap();
            assert!(decode(&bytes(hex)).is_none(), "{hex}");
        }
        assert!(decode(&bytes(&("0b".repeat(65) + &"0c".repeat(65)))).is_none());
        assert!(decode(&bytes(&"0800".repeat(10001))).is_none());
        assert!(decode(&vec![0; 65537]).is_none());
        assert!(search_text("CJYB", true).is_empty());
        assert!(search_text("?", false).is_empty());
    }
}
