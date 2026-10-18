// Generates an isolated localhost TLS leaf for network integration tests.
use anyhow::{Context, Result};
use std::{fs::OpenOptions, io::Write, path::PathBuf};
fn main() -> Result<()> {
    let directory = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .context("Pass the owned fixture directory")?,
    );
    std::fs::create_dir_all(&directory)?;
    let hudsucker::rcgen::CertifiedKey { cert, signing_key } =
        hudsucker::rcgen::generate_simple_self_signed(vec![
            "localhost".to_owned(),
            "127.0.0.1".to_owned(),
        ])?;
    for (name, bytes) in [
        ("cert.pem", cert.pem()),
        ("key.pem", signing_key.serialize_pem()),
    ] {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(directory.join(name))?
            .write_all(bytes.as_bytes())?;
    }
    Ok(())
}
