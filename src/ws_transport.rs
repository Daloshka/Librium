//! WebSocket proxy transport without locally generated control replies.
use crate::{capture::Shared, websocket};
use anyhow::{Result, bail};
use fastwebsockets::{Frame, OpCode, Role, WebSocket, WebSocketRead, WebSocketWrite};
use hudsucker::{
    Body,
    hyper::{Request, Response, header},
    hyper_util::rt::TokioIo,
    rustls,
    tokio_tungstenite::{MaybeTlsStream, tungstenite},
};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

// fastwebsockets exposes unmasking but not the incoming mask bit. Validate
// framing at the read boundary, without buffering payloads or changing bytes.
struct MaskGuard<R> {
    inner: R,
    masked: bool,
    header: [u8; 14],
    got: usize,
    need: usize,
    left: u64,
}
impl<R> MaskGuard<R> {
    fn new(inner: R, masked: bool) -> Self {
        Self {
            inner,
            masked,
            header: [0; 14],
            got: 0,
            need: 2,
            left: 0,
        }
    }
    fn inspect(&mut self, mut bytes: &[u8]) -> std::io::Result<()> {
        while !bytes.is_empty() {
            if self.left > 0 {
                let skip = self.left.min(bytes.len() as u64) as usize;
                self.left -= skip as u64;
                bytes = &bytes[skip..];
                continue;
            }
            let take = (self.need - self.got).min(bytes.len());
            self.header[self.got..self.got + take].copy_from_slice(&bytes[..take]);
            self.got += take;
            bytes = &bytes[take..];
            if self.got < self.need {
                continue;
            }
            if self.need == 2 {
                if (self.header[1] & 128 != 0) != self.masked {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Invalid WebSocket frame masking",
                    ));
                }
                let code = self.header[1] & 127;
                self.need =
                    2 + if code == 126 {
                        2
                    } else if code == 127 {
                        8
                    } else {
                        0
                    } + if self.masked { 4 } else { 0 };
                if self.got < self.need {
                    continue;
                }
            }
            let code = self.header[1] & 127;
            let length = if code == 126 {
                u64::from(u16::from_be_bytes(self.header[2..4].try_into().unwrap()))
            } else if code == 127 {
                u64::from_be_bytes(self.header[2..10].try_into().unwrap())
            } else {
                u64::from(code)
            };
            if (code == 126 && length < 126)
                || (code == 127 && (length < 65536 || length >> 63 != 0))
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid WebSocket frame length",
                ));
            }
            if self.header[0] & 8 != 0 && (self.header[0] & 128 == 0 || length > 125) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid WebSocket control frame",
                ));
            }
            self.left = length;
            self.got = 0;
            self.need = 2;
        }
        Ok(())
    }
}
impl<R: AsyncRead + Unpin> AsyncRead for MaskGuard<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if let Err(error) = this.inspect(&buf.filled()[before..]) {
                    buf.set_filled(before);
                    Poll::Ready(Err(error))
                } else {
                    Poll::Ready(Ok(()))
                }
            }
            other => other,
        }
    }
}

pub enum Upstream {
    Accepted {
        socket: WebSocket<TokioIo<hudsucker::hyper::upgrade::Upgraded>>,
        protocol: Option<header::HeaderValue>,
    },
    Rejected(Response<Body>),
}
struct ConnectionTask(Option<tokio::task::JoinHandle<()>>);
impl Drop for ConnectionTask {
    fn drop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}
pub async fn connect(request: Request<Body>) -> Result<Upstream> {
    connect_with_tls(request, None).await
}
async fn connect_with_tls(
    mut request: Request<Body>,
    tls_config: Option<std::sync::Arc<rustls::ClientConfig>>,
) -> Result<Upstream> {
    let domain = request
        .uri()
        .host()
        .ok_or_else(|| anyhow::anyhow!("WebSocket host missing"))?
        .trim_matches(['[', ']'])
        .to_owned();
    let tls = request.uri().scheme_str() == Some("https");
    let port = request
        .uri()
        .port_u16()
        .unwrap_or(if tls { 443 } else { 80 });
    let tcp = tokio::net::TcpStream::connect((domain.as_str(), port)).await?;
    let stream = if tls {
        let config = match tls_config {
            Some(config) => config,
            None => {
                let mut roots = rustls::RootCertStore::empty();
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
                std::sync::Arc::new(
                    rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                        rustls::crypto::aws_lc_rs::default_provider(),
                    ))
                    .with_safe_default_protocol_versions()?
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
                )
            }
        };
        let name = rustls::pki_types::ServerName::try_from(domain)?;
        MaybeTlsStream::Rustls(
            tokio_rustls::TlsConnector::from(config)
                .connect(name, tcp)
                .await?,
        )
    } else {
        MaybeTlsStream::Plain(tcp)
    };
    let key = request
        .headers()
        .get("sec-websocket-key")
        .ok_or_else(|| anyhow::anyhow!("WebSocket key missing"))?
        .as_bytes()
        .to_vec();
    let offers: Vec<String> = request
        .headers()
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(|p| p.trim().to_owned()))
        .collect();
    request.headers_mut().remove("sec-websocket-extensions");
    *request.uri_mut() = request
        .uri()
        .path_and_query()
        .map_or("/", |p| p.as_str())
        .parse()?;
    let (mut sender, connection) =
        hudsucker::hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    let mut task = ConnectionTask(Some(tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    })));
    let mut response = sender.send_request(request).await?;
    if response.status() != 101 {
        let _ = task.0.take();
        return Ok(Upstream::Rejected(response.map(Body::from)));
    }
    let token = |name: &str, wanted: &str| {
        response
            .headers()
            .get_all(name)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.split(',').any(|v| v.trim().eq_ignore_ascii_case(wanted)))
    };
    if !token("connection", "upgrade")
        || !token("upgrade", "websocket")
        || response
            .headers()
            .get("sec-websocket-accept")
            .and_then(|v| v.to_str().ok())
            != Some(tungstenite::handshake::derive_accept_key(&key).as_str())
        || response.headers().contains_key("sec-websocket-extensions")
    {
        bail!("Invalid upstream WebSocket upgrade");
    }
    let protocol = response.headers().get("sec-websocket-protocol").cloned();
    if let Some(protocol) = &protocol
        && !offers
            .iter()
            .any(|offer| protocol.to_str().is_ok_and(|value| value == offer))
    {
        bail!("Unrequested WebSocket subprotocol");
    }
    let upgraded = hudsucker::hyper::upgrade::on(&mut response).await?;
    let _ = task.0.take();
    Ok(Upstream::Accepted {
        socket: WebSocket::after_handshake(TokioIo::new(upgraded), Role::Client),
        protocol,
    })
}

#[derive(Default)]
struct MessageCapture {
    kind: Option<OpCode>,
    preview: Vec<u8>,
    size: usize,
    utf8_tail: Vec<u8>,
}
impl MessageCapture {
    fn utf8(&mut self, mut bytes: &[u8], fin: bool) -> Result<()> {
        if !self.utf8_tail.is_empty() {
            let width = match self.utf8_tail[0] {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => bail!("Invalid UTF-8"),
            };
            let take = (width - self.utf8_tail.len()).min(bytes.len());
            self.utf8_tail.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.utf8_tail.len() == width {
                std::str::from_utf8(&self.utf8_tail)?;
                self.utf8_tail.clear();
            } else if fin {
                bail!("Incomplete UTF-8");
            } else {
                return Ok(());
            }
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => {}
            Err(error) if error.error_len().is_none() && !fin => self
                .utf8_tail
                .extend_from_slice(&bytes[error.valid_up_to()..]),
            Err(error) => return Err(error.into()),
        };
        Ok(())
    }
    fn frame(
        &mut self,
        history: &Shared,
        id: u64,
        direction: &str,
        frame: &Frame<'_>,
    ) -> Result<()> {
        let control = matches!(frame.opcode, OpCode::Close | OpCode::Ping | OpCode::Pong);
        if control {
            if !frame.fin || frame.payload.len() > 125 {
                bail!("Invalid WebSocket control frame");
            }
            if frame.opcode == OpCode::Close {
                if frame.payload.len() == 1 {
                    bail!("Invalid WebSocket close frame");
                }
                if frame.payload.len() >= 2 {
                    let code = tungstenite::protocol::frame::coding::CloseCode::from(
                        u16::from_be_bytes([frame.payload[0], frame.payload[1]]),
                    );
                    if !code.is_allowed() {
                        bail!("Invalid WebSocket close code");
                    }
                    std::str::from_utf8(&frame.payload[2..])?;
                }
            }
            websocket::record_bytes(
                history,
                id,
                direction,
                match frame.opcode {
                    OpCode::Close => "CLOSE",
                    OpCode::Ping => "PING",
                    _ => "PONG",
                },
                &frame.payload,
                frame.payload.len(),
            );
            return Ok(());
        }
        match frame.opcode {
            OpCode::Text | OpCode::Binary => {
                if self.kind.is_some() {
                    bail!("Overlapping WebSocket fragments");
                }
                self.kind = Some(frame.opcode);
            }
            OpCode::Continuation => {
                if self.kind.is_none() {
                    bail!("Unexpected WebSocket continuation");
                }
            }
            _ => bail!("Unexpected WebSocket opcode"),
        }
        self.size = self
            .size
            .checked_add(frame.payload.len())
            .ok_or_else(|| anyhow::anyhow!("WebSocket size overflow"))?;
        if self.size > 64 * 1024 * 1024 {
            bail!("WebSocket message exceeds 64 MiB");
        }
        if self.kind == Some(OpCode::Text) {
            self.utf8(&frame.payload, frame.fin)?;
        }
        let saved = (65536 - self.preview.len()).min(frame.payload.len());
        self.preview.extend_from_slice(&frame.payload[..saved]);
        if frame.fin {
            websocket::record_bytes(
                history,
                id,
                direction,
                if self.kind == Some(OpCode::Text) {
                    "TEXT"
                } else {
                    "BINARY"
                },
                &self.preview,
                self.size,
            );
            *self = Self::default();
        }
        Ok(())
    }
}
async fn forward<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut read: WebSocketRead<R>,
    mut write: WebSocketWrite<W>,
    history: &Shared,
    id: u64,
    direction: &str,
) -> Result<()> {
    read.set_auto_close(false);
    read.set_auto_pong(false);
    read.set_max_message_size(16 * 1024 * 1024 + 1);
    // Keep automatic unmasking: TEXT validation needs plaintext. The retained
    // mask key lets the upstream client writer reapply it exactly once.
    // Calling Frame::unmask here would XOR the already-decoded payload again.
    let mut capture = MessageCapture::default();
    loop {
        let frame = read
            .read_frame(&mut |_| async {
                Err::<(), std::io::Error>(std::io::Error::other(
                    "Unexpected automatic WebSocket reply",
                ))
            })
            .await?;
        capture.frame(history, id, direction, &frame)?;
        let closed = frame.opcode == OpCode::Close;
        write.write_frame(frame).await?;
        write.flush().await?;
        if closed {
            return Ok(());
        }
    }
}
pub async fn relay<A: AsyncRead + AsyncWrite + Unpin, B: AsyncRead + AsyncWrite + Unpin>(
    client: WebSocket<A>,
    server: WebSocket<B>,
    history: &Shared,
    id: u64,
) -> Result<()> {
    let (cr, cw) = client.split(|stream| {
        let (r, w) = tokio::io::split(stream);
        (MaskGuard::new(r, true), w)
    });
    let (sr, sw) = server.split(|stream| {
        let (r, w) = tokio::io::split(stream);
        (MaskGuard::new(r, false), w)
    });
    let a = async {
        forward(cr, sw, history, id, "sent")
            .await
            .map_err(|error| tungstenite::Error::Io(std::io::Error::other(error)))
    };
    let b = async {
        forward(sr, cw, history, id, "received")
            .await
            .map_err(|error| tungstenite::Error::Io(std::io::Error::other(error)))
    };
    websocket::relay_halves(a, b, std::time::Duration::from_secs(5)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn request(url: &str) -> Request<Body> {
        let uri: hudsucker::hyper::Uri = url.parse().unwrap();
        Request::builder()
            .uri(uri.clone())
            .header("host", uri.authority().unwrap().as_str())
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .body(Body::empty())
            .unwrap()
    }
    async fn headers<R: AsyncRead + Unpin>(stream: &mut R) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
            assert!(bytes.len() < 16384);
        }
        String::from_utf8(bytes).unwrap()
    }
    #[test]
    fn mask_guard_handles_split_headers_and_rejects_invalid_frames() {
        let wire = [
            0x81,
            0x82,
            1,
            2,
            3,
            4,
            b'a' ^ 1,
            b'b' ^ 2,
            0x88,
            0x80,
            5,
            6,
            7,
            8,
        ];
        for width in 1..=wire.len() {
            let mut guard = MaskGuard::new(tokio::io::empty(), true);
            for chunk in wire.chunks(width) {
                guard.inspect(chunk).unwrap();
            }
            assert_eq!(guard.got, 0);
            assert_eq!(guard.left, 0);
        }
        for bytes in [
            vec![0x81, 0],
            vec![0x89, 0xfe, 0, 126, 0, 0, 0, 0],
            vec![0x09, 0x80, 0, 0, 0, 0],
            vec![0x82, 0xfe, 0, 1, 0, 0, 0, 0],
            vec![0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ] {
            assert!(
                MaskGuard::new(tokio::io::empty(), true)
                    .inspect(&bytes)
                    .is_err()
            );
        }
        assert!(
            MaskGuard::new(tokio::io::empty(), false)
                .inspect(&wire)
                .is_err()
        );
    }
    #[test]
    fn capture_reassembles_utf8_and_bounds_binary_fragments() {
        let history = std::sync::Arc::new(std::sync::Mutex::new(
            crate::capture::History::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        websocket::start(&history, 1);
        let mut capture = MessageCapture::default();
        for (fin, opcode, bytes) in [
            (false, OpCode::Text, vec![0xd0]),
            (true, OpCode::Ping, vec![0, 255]),
            (true, OpCode::Continuation, vec![0x9f]),
            (false, OpCode::Binary, vec![1; 40000]),
            (true, OpCode::Continuation, vec![2; 40000]),
        ] {
            capture
                .frame(
                    &history,
                    1,
                    "sent",
                    &Frame::new(fin, opcode, None, bytes.into()),
                )
                .unwrap();
        }
        let h = history.lock().unwrap();
        let page = h.store.as_ref().unwrap().ws_page(1, None).unwrap();
        assert_eq!(page["messages"][0]["kind"], "PING");
        assert_eq!(page["messages"][1]["text"], "П");
        assert_eq!(page["messages"][2]["size"], 80000);
        assert_eq!(page["messages"][2]["truncated"], true);
        use base64::Engine;
        let bytes = base64::prelude::BASE64_STANDARD
            .decode(page["messages"][2]["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes.len(), 65536);
        assert!(bytes[..40000].iter().all(|v| *v == 1));
        assert!(bytes[40000..].iter().all(|v| *v == 2));
        drop(h);
        for (opcode, bytes) in [
            (OpCode::Continuation, vec![1]),
            (OpCode::Text, vec![255]),
            (OpCode::Close, vec![0]),
            (OpCode::Close, vec![3, 237]),
            (OpCode::Close, vec![3, 232, 255]),
        ] {
            assert!(
                MessageCapture::default()
                    .frame(
                        &history,
                        1,
                        "sent",
                        &Frame::new(true, opcode, None, bytes.into())
                    )
                    .is_err()
            );
        }
    }
    #[tokio::test]
    async fn handshake_validates_upgrade_and_preserves_http_refusal() {
        for mode in ["accept", "protocol", "extension", "refused"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = headers(&mut stream).await;
                assert!(request.starts_with("GET /path?q=1 HTTP/1.1\r\n"));
                assert!(!request.to_lowercase().contains("sec-websocket-extensions"));
                let response = match mode {
                    "accept" => "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: invalid\r\n\r\n".to_owned(),
                    "refused" => "HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied".to_owned(),
                    other => format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n{}\r\n", if other=="protocol" {"Sec-WebSocket-Protocol: unrequested\r\n"} else {"Sec-WebSocket-Extensions: permessage-deflate\r\n"}),
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let mut req = request(&format!("http://{address}/path?q=1"));
            req.headers_mut().insert(
                "sec-websocket-extensions",
                "permessage-deflate".parse().unwrap(),
            );
            let result = connect(req).await;
            if mode == "refused" {
                let Upstream::Rejected(response) = result.unwrap() else {
                    panic!("expected refusal")
                };
                assert_eq!(response.status(), 403);
                assert_eq!(
                    response.into_body().collect().await.unwrap().to_bytes(),
                    "denied"
                );
            } else {
                assert!(result.is_err(), "{mode}");
            }
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn cancelled_handshake_drops_owned_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            headers(&mut stream).await;
            let mut byte = [0];
            let read =
                tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut byte))
                    .await
                    .unwrap();
            assert!(matches!(read, Ok(0)) || read.is_err());
        });
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                connect(request(&format!("http://{address}/")))
            )
            .await
            .is_err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn tls_checks_trust_and_preserves_upgrade_read_ahead() {
        let hudsucker::rcgen::CertifiedKey { cert, signing_key } =
            hudsucker::rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let server_config = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
            )
            .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert.der().clone()).unwrap();
        let client_config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(server_config));
            let (tcp, _) = listener.accept().await.unwrap();
            let mut stream = acceptor.accept(tcp).await.unwrap();
            headers(&mut stream).await;
            // HTTP upgrade and the first frame share one write: Hyper must keep read-ahead.
            stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n\x81\x05hello").await.unwrap();
            let mut socket = WebSocket::after_handshake(stream, Role::Server);
            socket.set_auto_pong(false);
            let frame = socket.read_frame().await.unwrap();
            assert_eq!(frame.opcode, OpCode::Ping);
            assert_eq!(&*frame.payload, &[0, 255]);
            socket
                .write_frame(Frame::pong(vec![0, 255].into()))
                .await
                .unwrap();
            socket.flush().await.unwrap();
            let (tcp, _) = listener.accept().await.unwrap();
            assert!(acceptor.accept(tcp).await.is_err());
        });
        let url = format!("https://localhost:{port}/");
        let Upstream::Accepted { mut socket, .. } =
            connect_with_tls(request(&url), Some(std::sync::Arc::new(client_config)))
                .await
                .unwrap()
        else {
            panic!("upgrade refused")
        };
        socket.set_auto_pong(false);
        socket.set_auto_close(false);
        let greeting = socket.read_frame().await.unwrap();
        assert_eq!(greeting.opcode, OpCode::Text);
        assert_eq!(&*greeting.payload, b"hello");
        socket
            .write_frame(Frame::new(true, OpCode::Ping, None, vec![0, 255].into()))
            .await
            .unwrap();
        socket.flush().await.unwrap();
        let pong = socket.read_frame().await.unwrap();
        assert_eq!(pong.opcode, OpCode::Pong);
        assert_eq!(&*pong.payload, &[0, 255]);
        drop(socket);
        assert!(
            connect(request(&url)).await.is_err(),
            "production trust must reject a self-signed upstream"
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
}
