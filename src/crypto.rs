//! Encryption of saved secret access keys: AES-256-GCM under a key derived
//! with scrypt from the configured encryption key and a per-database salt.
//! Stored values are `base64(iv || tag || ciphertext)`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, anyhow, ensure};
use base64::Engine;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::{DecodePaddingMode, general_purpose};

const IV_LENGTH: usize = 12;
const AUTH_TAG_LENGTH: usize = 16;
pub const SALT_LENGTH: usize = 32;

/// Unpadded URL-safe base64 out, padding optional in.
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn base64url(data: &[u8]) -> String {
    BASE64URL.encode(data)
}

pub fn base64url_decode(value: &str) -> Option<Vec<u8>> {
    BASE64URL.decode(value).ok()
}

pub fn base64_encode(data: &[u8]) -> String {
    STANDARD.encode(data)
}

pub fn base64_decode(value: &str) -> Option<Vec<u8>> {
    general_purpose::STANDARD.decode(value).ok()
}

/// scrypt with N=2^14, r=8, p=1 and a 32-byte output.
pub fn scrypt32(password: &[u8], salt: &[u8]) -> [u8; 32] {
    let params = scrypt::Params::new(14, 8, 1, 32).expect("valid scrypt parameters");
    let mut out = [0u8; 32];
    scrypt::scrypt(password, salt, &params, &mut out).expect("32 is a valid scrypt output length");
    out
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    rand::random()
}

pub struct Cipher {
    cipher: Aes256Gcm,
}

impl Cipher {
    /// Derives the key, which takes tens of milliseconds; call off the async
    /// executor.
    pub fn new(key_source: &str, salt: &[u8]) -> anyhow::Result<Self> {
        ensure!(salt.len() == SALT_LENGTH, "Salt must be exactly {SALT_LENGTH} bytes");
        let key = scrypt32(key_source.as_bytes(), salt);
        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(&key).expect("32-byte key"),
        })
    }

    pub fn encrypt(&self, plaintext: &str) -> String {
        let iv: [u8; IV_LENGTH] = random_bytes();
        let sealed = self
            .cipher
            .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
            .expect("AES-GCM encryption of an in-memory buffer cannot fail");
        // The crate appends the tag; the stored layout puts it before the ciphertext.
        let (ciphertext, tag) = sealed.split_at(sealed.len() - AUTH_TAG_LENGTH);
        let mut combined = Vec::with_capacity(IV_LENGTH + sealed.len());
        combined.extend_from_slice(&iv);
        combined.extend_from_slice(tag);
        combined.extend_from_slice(ciphertext);
        base64_encode(&combined)
    }

    pub fn decrypt(&self, encoded: &str) -> anyhow::Result<String> {
        let combined = base64_decode(encoded).context("Invalid ciphertext: not base64")?;
        ensure!(combined.len() >= IV_LENGTH + AUTH_TAG_LENGTH, "Invalid ciphertext: too short");
        let (iv, rest) = combined.split_at(IV_LENGTH);
        let (tag, ciphertext) = rest.split_at(AUTH_TAG_LENGTH);
        let mut sealed = Vec::with_capacity(rest.len());
        sealed.extend_from_slice(ciphertext);
        sealed.extend_from_slice(tag);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(iv), sealed.as_slice())
            .map_err(|_| anyhow!("decryption failed: wrong key or corrupted ciphertext"))?;
        String::from_utf8(plaintext).context("decrypted value is not UTF-8")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_then_decrypt_round_trips_and_wrong_key_fails() {
        let salt = [7u8; SALT_LENGTH];
        let cipher = Cipher::new(&"k".repeat(32), &salt).unwrap();
        let sealed = cipher.encrypt("secret-access-key");
        assert_ne!(sealed, cipher.encrypt("secret-access-key"), "fresh IV per call");
        assert_eq!(cipher.decrypt(&sealed).unwrap(), "secret-access-key");

        let other = Cipher::new(&"x".repeat(32), &salt).unwrap();
        assert!(other.decrypt(&sealed).is_err());
        assert!(cipher.decrypt("c2hvcnQ=").is_err());
        assert!(Cipher::new("key", &[0u8; 8]).is_err());
    }

    #[test]
    fn decrypts_values_written_by_the_python_backend() {
        // iv || tag || ciphertext from the former Python implementation, key
        // source "k" * 32, salt b"\x07" * 32, IV bytes 0..12, plaintext "hello".
        let cipher = Cipher::new(&"k".repeat(32), &[7u8; SALT_LENGTH]).unwrap();
        assert_eq!(cipher.decrypt("AAECAwQFBgcICQoLdqu0kWIkr2R+/GZ37KgvHyklh9sN").unwrap(), "hello");
    }

    #[test]
    fn base64url_round_trips_with_or_without_padding() {
        assert_eq!(base64url(b"\xff\xfe"), "__4");
        assert_eq!(base64url_decode("__4").unwrap(), b"\xff\xfe");
        assert_eq!(base64url_decode("__4=").unwrap(), b"\xff\xfe");
        assert!(base64url_decode("!!").is_none());
    }
}
