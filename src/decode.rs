//! Text previews of captured bodies. The wire bytes stay as they were sent; for the preview and
//! for searching, a compressed body is decoded as far as the captured prefix allows.
use std::io::Read;

use crate::capture::PREVIEW_LIMIT;

fn encoding(headers: &[(String, String)]) -> String {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-encoding"))
        .map(|(_, value)| value.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Reads up to PREVIEW_LIMIT decoded bytes; a stream cut short (a truncated capture) yields
/// what could be decoded before the cut instead of nothing.
fn read_prefix(mut reader: impl Read) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    while out.len() < PREVIEW_LIMIT {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    out.truncate(PREVIEW_LIMIT);
    out
}

/// The body as text for the inspector and for `body:` searches: decoded when the encoding is
/// gzip, deflate or brotli, otherwise the bytes themselves, lossily as UTF-8.
pub fn preview(headers: &[(String, String)], bytes: &[u8]) -> String {
    let decoded = match encoding(headers).as_str() {
        "gzip" | "x-gzip" => Some(read_prefix(flate2::read::MultiGzDecoder::new(bytes))),
        "deflate" => {
            let zlib = read_prefix(flate2::read::ZlibDecoder::new(bytes));
            Some(if zlib.is_empty() {
                read_prefix(flate2::read::DeflateDecoder::new(bytes))
            } else {
                zlib
            })
        }
        "br" => Some(read_prefix(brotli::Decompressor::new(bytes, 8192))),
        _ => None,
    };
    match decoded {
        // Garbage in the first bytes means the capture is not what the header says: show the raw bytes.
        Some(text) if !text.is_empty() || bytes.is_empty() => {
            String::from_utf8_lossy(&text).into_owned()
        }
        _ => String::from_utf8_lossy(&bytes[..bytes.len().min(PREVIEW_LIMIT)]).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }
    #[test]
    fn compressed_bodies_are_previewed_as_text_even_when_cut_short() {
        let plain = "{\"message\":\"hello\"}".repeat(6000);
        let headers = vec![("Content-Encoding".to_string(), "gzip".to_string())];
        let whole = preview(&headers, &gzip(plain.as_bytes()));
        assert_eq!(whole.len(), PREVIEW_LIMIT);
        assert!(whole.starts_with("{\"message\":\"hello\"}"));
        let compressed = gzip(plain.as_bytes());
        let cut = preview(&headers, &compressed[..compressed.len() / 2]);
        assert!(
            cut.starts_with("{\"message\":\"hello\"}"),
            "a truncated stream still yields its prefix"
        );
        assert!(!cut.is_empty() && cut.len() < whole.len());
        let mut br = Vec::new();
        brotli::CompressorWriter::new(&mut br, 4096, 5, 22)
            .write_all(b"brotli body text")
            .unwrap();
        assert_eq!(
            preview(&[("content-encoding".into(), "br".into())], &br),
            "brotli body text"
        );
        assert_eq!(
            preview(&headers, b"not gzip at all"),
            "not gzip at all",
            "garbage falls back to the bytes"
        );
        assert_eq!(preview(&[], b"plain"), "plain");
        assert_eq!(
            preview(
                &[("content-encoding".into(), "zstd".into())],
                b"\x28\xb5\x2f\xfd"
            ),
            "(\u{fffd}/\u{fffd}"
        );
    }
}
