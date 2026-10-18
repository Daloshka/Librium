use anyhow::{Context, Result};
use hudsucker::{
    certificate_authority::RcgenAuthority,
    rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose},
    rustls::crypto::aws_lc_rs,
};
use std::path::Path;

pub fn load(dir: &Path) -> Result<(RcgenAuthority, String)> {
    std::fs::create_dir_all(dir)?;
    let cert_path = dir.join("ca.crt");
    let key_path = dir.join("ca.key");
    if !cert_path.exists() && !key_path.exists() {
        let key = KeyPair::generate()?;
        let mut params = CertificateParams::default();
        params
            .distinguished_name
            .push(DnType::CommonName, "Librium Local CA");
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let cert = params.self_signed(&key)?;
        // create_new prevents overwriting a CA created by another instance.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(&key_path)?
            .write_all(key.serialize_pem().as_bytes())?;
        options.open(&cert_path)?.write_all(cert.pem().as_bytes())?;
    }
    let pem = std::fs::read_to_string(&cert_path).context(
        "Cannot read CA certificate; restore the CA pair or remove both files to regenerate",
    )?;
    let key = KeyPair::from_pem(
        &std::fs::read_to_string(key_path).context("Cannot read CA private key")?,
    )?;
    let issuer = Issuer::from_ca_cert_pem(&pem, key)?;
    Ok((
        RcgenAuthority::new(issuer, 256, aws_lc_rs::default_provider()),
        pem,
    ))
}
