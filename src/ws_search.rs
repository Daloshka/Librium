use base64::{Engine, prelude::BASE64_STANDARD};

pub fn contains(text: &str, query: &str) -> bool {
    text.to_lowercase().contains(&query.to_lowercase())
}
pub fn normalize_hex(query: &str) -> Option<String> {
    if query.len() > 4096 {
        return None;
    }
    let digits: Vec<u8> = query
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != 11)
        .collect();
    if !digits.len().is_multiple_of(2) || !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    Some(String::from_utf8(digits).ok()?.to_ascii_lowercase())
}
pub fn hex_offset(encoded: &str, query: &str) -> Option<usize> {
    if encoded.len() > 87384 {
        return None;
    }
    let query = normalize_hex(query)?;
    if query.is_empty() {
        return None;
    }
    let pattern: Vec<u8> = query
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect();
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    // KMP bounds work even for long repetitive previews / patterns.
    let mut prefix = vec![0; pattern.len()];
    let mut matched = 0;
    for i in 1..pattern.len() {
        while matched > 0 && pattern[i] != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if pattern[i] == pattern[matched] {
            matched += 1;
        }
        prefix[i] = matched;
    }
    matched = 0;
    for (i, byte) in bytes.iter().enumerate() {
        while matched > 0 && *byte != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if *byte == pattern[matched] {
            matched += 1;
        }
        if matched == pattern.len() {
            return Some(i + 1 - pattern.len());
        }
    }
    None
}
fn hex_mask_parts(query: &str) -> Option<(Option<usize>, String)> {
    if query.len() > 4096 {
        return None;
    }
    let compact: String = query
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != 11)
        .map(char::from)
        .collect();
    let (anchor, digits) = if let Some(raw) = compact.strip_prefix('@') {
        let (offset, pattern) = raw.split_once(':')?;
        let parsed = if let Some(hex) = offset
            .strip_prefix("0x")
            .or_else(|| offset.strip_prefix("0X"))
        {
            if hex.is_empty() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            usize::from_str_radix(hex, 16).ok()?
        } else {
            if offset.is_empty() || !offset.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            offset.parse::<usize>().ok()?
        };
        if parsed >= 65536 || pattern.is_empty() {
            return None;
        }
        (Some(parsed), pattern)
    } else {
        (None, compact.as_str())
    };
    if digits.len() > 512
        || !digits.len().is_multiple_of(2)
        || !digits
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .all(|pair| pair == b"??" || pair.iter().all(u8::is_ascii_hexdigit))
        || anchor.is_some_and(|offset| offset + digits.len() / 2 > 65536)
    {
        return None;
    }
    Some((anchor, digits.to_ascii_lowercase()))
}
pub fn normalize_hex_mask(query: &str) -> Option<String> {
    let (anchor, digits) = hex_mask_parts(query)?;
    Some(match anchor {
        Some(offset) => format!("@{offset}:{digits}"),
        None => digits,
    })
}
pub struct MaskPattern {
    accept: Box<[[u64; 4]; 256]>,
    width: usize,
    anchor: Option<usize>,
}
impl MaskPattern {
    pub fn new(query: &str) -> Option<Self> {
        let (anchor, normalized) = hex_mask_parts(query)?;
        let width = normalized.len() / 2;
        let mut accept = Box::new([[0_u64; 4]; 256]);
        for (index, pair) in normalized.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let word = index / 64;
            let bit = 1_u64 << (index % 64);
            if pair == b"??" {
                for row in accept.iter_mut() {
                    row[word] |= bit;
                }
            } else {
                let byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
                accept[byte as usize][word] |= bit;
            }
        }
        Some(Self {
            accept,
            width,
            anchor,
        })
    }
    pub fn width(&self) -> usize {
        self.width
    }
    pub fn offset(&self, encoded: &str) -> Option<usize> {
        if self.width == 0 || encoded.len() > 87384 {
            return None;
        }
        let bytes = BASE64_STANDARD.decode(encoded).ok()?;
        self.find_bytes(&bytes)
    }
    fn find_bytes(&self, bytes: &[u8]) -> Option<usize> {
        if self.width == 0 || bytes.len() > 65536 {
            return None;
        }
        let (bytes, base) = if let Some(offset) = self.anchor {
            (bytes.get(offset..offset + self.width)?, offset)
        } else {
            (bytes, 0)
        };
        let words = self.width.div_ceil(64);
        let end = 1_u64 << ((self.width - 1) % 64);
        let mut state = [0_u64; 4];
        // Shift-And with four fixed words: at most four updates per input byte,
        // including overlapping candidates and arbitrarily placed wildcards.
        for (index, byte) in bytes.iter().enumerate() {
            let mut carry = 1;
            for (word, value) in state.iter_mut().enumerate().take(words) {
                let next = *value >> 63;
                *value = ((*value << 1) | carry) & self.accept[*byte as usize][word];
                carry = next;
            }
            if state[words - 1] & end != 0 {
                return Some(base + index + 1 - self.width);
            }
        }
        None
    }
}
pub fn utf8_text(encoded: &str, truncated: bool) -> Option<String> {
    if encoded.len() > 87384 {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    // Match the default UTF-8 TextDecoder used by the message viewer.
    Some(text.strip_prefix('\u{feff}').unwrap_or(text).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_search_matches_vectors_and_bounds_repetitive_patterns() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../scripts/hex-search-vectors.json")).unwrap();
        for row in vectors["normalization"].as_array().unwrap() {
            assert_eq!(
                normalize_hex(row[0].as_str().unwrap()),
                Some(row[1].as_str().unwrap().into())
            );
        }
        for row in vectors["invalid"].as_array().unwrap() {
            assert!(normalize_hex(row.as_str().unwrap()).is_none());
        }
        for row in vectors["matches"].as_array().unwrap() {
            let bytes: Vec<u8> = row[0]
                .as_str()
                .unwrap()
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
                .collect();
            assert_eq!(
                hex_offset(&BASE64_STANDARD.encode(bytes), row[1].as_str().unwrap()),
                row[2].as_u64().map(|v| v as usize)
            );
        }
        let mut bytes = vec![0; 65536];
        bytes[65535] = 1;
        assert_eq!(
            hex_offset(&BASE64_STANDARD.encode(bytes), &("00".repeat(2047) + "01")),
            Some(65536 - 2048)
        );
        assert!(normalize_hex(&"0".repeat(4097)).is_none());
        assert!(hex_offset("?", "00").is_none());
        assert!(hex_offset(&BASE64_STANDARD.encode(vec![0; 65537]), "00").is_none());
    }
    #[test]
    fn masked_search_matches_shared_vectors_overlaps_and_word_boundaries() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../scripts/hex-search-vectors.json")).unwrap();
        for row in vectors["mask_normalization"].as_array().unwrap() {
            assert_eq!(
                normalize_hex_mask(row[0].as_str().unwrap()),
                Some(row[1].as_str().unwrap().into())
            );
        }
        for row in vectors["mask_invalid"].as_array().unwrap() {
            assert!(normalize_hex_mask(row.as_str().unwrap()).is_none());
        }
        for row in vectors["mask_matches"].as_array().unwrap() {
            let bytes: Vec<_> = row[0]
                .as_str()
                .unwrap()
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            assert_eq!(
                MaskPattern::new(row[1].as_str().unwrap())
                    .unwrap()
                    .offset(&BASE64_STANDARD.encode(bytes)),
                row[2].as_u64().map(|n| n as usize)
            );
        }
        let mut bytes = vec![0; 65536];
        bytes[65535] = 1;
        for width in [1, 63, 64, 65, 127, 128, 129, 255, 256] {
            assert_eq!(
                MaskPattern::new(&("??".repeat(width - 1) + "01"))
                    .unwrap()
                    .find_bytes(&bytes),
                Some(65536 - width)
            );
        }
        assert_eq!(
            MaskPattern::new("@65535:01").unwrap().find_bytes(&bytes),
            Some(65535)
        );
        assert!(
            MaskPattern::new("@65534:01")
                .unwrap()
                .find_bytes(&bytes)
                .is_none()
        );
        assert!(MaskPattern::new(&"??".repeat(257)).is_none());
        assert!(MaskPattern::new(&" ".repeat(4097)).is_none());
        assert!(MaskPattern::new("??").unwrap().offset("?").is_none());
        assert!(
            MaskPattern::new("??")
                .unwrap()
                .find_bytes(&vec![0; 65537])
                .is_none()
        );
        let mut seed = 19_u64;
        let mut random = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as u8
        };
        for case in 0..300 {
            let width = case % 256 + 1;
            let start = case % 128;
            let bytes: Vec<_> = (0..512).map(|_| random() % 4).collect();
            let pattern: Vec<_> = (0..width)
                .map(|index| {
                    if random() % 3 == 0 {
                        None
                    } else {
                        Some(bytes[start + index])
                    }
                })
                .collect();
            let query: String = pattern
                .iter()
                .map(|value| value.map_or("??".to_owned(), |byte| format!("{byte:02x}")))
                .collect();
            let expected = bytes.windows(width).position(|window| {
                pattern
                    .iter()
                    .zip(window)
                    .all(|(value, byte)| value.is_none_or(|value| value == *byte))
            });
            assert_eq!(
                MaskPattern::new(&query).unwrap().find_bytes(&bytes),
                expected,
                "{query}"
            );
            assert_eq!(
                MaskPattern::new(&format!("@{start}:{query}"))
                    .unwrap()
                    .find_bytes(&bytes),
                Some(start)
            );
        }
    }
    #[test]
    fn utf8_prefixes_match_renderer_vectors_without_replacement_bytes() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../scripts/utf8-search-vectors.json")).unwrap();
        for vector in vectors {
            let hex = vector["hex"].as_str().unwrap();
            let bytes: Vec<_> = hex
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            assert_eq!(
                utf8_text(
                    &BASE64_STANDARD.encode(bytes),
                    vector["truncated"].as_bool().unwrap()
                ),
                vector["text"].as_str().map(str::to_owned),
                "{hex}"
            );
        }
        assert!(contains("ПРИВЕТ мир", "привет МИР"));
        assert!(utf8_text("?", false).is_none());
        assert!(utf8_text(&BASE64_STANDARD.encode(vec![b'a'; 65537]), true).is_none());
    }
}
