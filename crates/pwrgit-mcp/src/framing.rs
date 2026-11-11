//! One bounded decision per peer. HTTP bytes remain opaque after the request
//! line; the desktop's HTTP parser owns every subsequent byte and request.
use std::{io, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Debug, PartialEq)]
pub enum Greeting {
    Raw {
        version: String,
        identity: Option<String>,
        /// The role the relay's operator asked for with `--role`. `None`
        /// means the relay named none, which the desktop answers with its
        /// most capable role.
        role: Option<String>,
    },
    Http(Vec<u8>),
}
/// Longest role id a relay may request. The whole raw greeting must fit in
/// 128 bytes; generated custom role ids are 41 characters.
pub const MAX_ROLE_ID: usize = 64;
/// The desktop's role-id alphabet (`access-policy.ts` `ID_PATTERN`), capped so
/// the greeting stays bounded.
pub fn valid_role_id(id: &str) -> bool {
    (1..=MAX_ROLE_ID).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
const MAX_LINE: usize = 4096;
const RAW_PREFIX: &[u8] = b"PWRGIT-MCP/";
const METHODS: &[&[u8]] = &[
    b"GET ",
    b"POST ",
    b"DELETE ",
    b"OPTIONS ",
    b"HEAD ",
    b"PUT ",
    b"PATCH ",
];

pub async fn accept<R: AsyncRead + Unpin>(reader: &mut R, http: bool) -> io::Result<Greeting> {
    tokio::time::timeout(Duration::from_secs(3), detect(reader, http)).await?
}
async fn detect<R: AsyncRead + Unpin>(reader: &mut R, http: bool) -> io::Result<Greeting> {
    let mut bytes = Vec::new();
    loop {
        bytes.push(reader.read_u8().await?);
        let raw = RAW_PREFIX.starts_with(&bytes) || bytes.starts_with(RAW_PREFIX);
        let is_http = http
            && METHODS
                .iter()
                .any(|method| method.starts_with(&bytes) || bytes.starts_with(method));
        if (!raw && !is_http) || bytes.len() > MAX_LINE || (raw && bytes.len() >= 128) {
            return Err(super::error("invalid or oversized IPC framing preamble"));
        }
        if bytes.last() != Some(&b'\n') {
            continue;
        }
        let line = std::str::from_utf8(&bytes).map_err(|_| super::error("invalid IPC framing"))?;
        if raw {
            let fields: Vec<_> = line.trim_end_matches('\n').split(' ').collect();
            let role = match fields.get(3) {
                None => None,
                Some(field) => match field.strip_prefix("role=") {
                    Some(role) if valid_role_id(role) => Some(role.to_owned()),
                    _ => {
                        return Err(super::error(
                            "invalid requested role in MCP transport greeting",
                        ));
                    }
                },
            };
            if !(2..=4).contains(&fields.len())
                || fields[0] != super::WIRE
                || fields[1].is_empty()
                || fields
                    .iter()
                    .any(|s| s.bytes().any(|b| b.is_ascii_control()))
            {
                return Err(super::error(
                    "incompatible MCP transport; update the relay and desktop, then reconnect",
                ));
            }
            return Ok(Greeting::Raw {
                version: fields[1].into(),
                identity: fields.get(2).filter(|s| !s.is_empty()).map(|s| (*s).into()),
                role,
            });
        }
        let fields: Vec<_> = line.strip_suffix("\r\n").unwrap_or("").split(' ').collect();
        if fields.len() != 3
            || !matches!(fields[2], "HTTP/1.0" | "HTTP/1.1")
            || !fields[1].starts_with('/')
            || fields[1].bytes().any(|b| !(0x21..=0x7e).contains(&b))
        {
            return Err(super::error("invalid HTTP/1.x request line"));
        }
        return Ok(Greeting::Http(bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    #[test]
    fn fragmented_http_preserves_prefetched_and_following_bytes() {
        runtime().block_on(async {
            use tokio::io::AsyncWriteExt;
            for split in 1..28 {
                let (mut read, mut write) = tokio::io::duplex(256);
                let request = b"POST /mcp HTTP/1.1\r\nHost: local\r\n\r\n{}";
                let task =
                    tokio::spawn(async move { accept(&mut read, true).await.map(|g| (g, read)) });
                write.write_all(&request[..split]).await.unwrap();
                tokio::task::yield_now().await;
                write.write_all(&request[split..]).await.unwrap();
                drop(write);
                let (greeting, mut read) = task.await.unwrap().unwrap();
                let Greeting::Http(mut bytes) = greeting else {
                    panic!("HTTP expected")
                };
                read.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, request);
            }
        });
    }
    #[test]
    fn strict_raw_identity_and_rejection_of_ambiguous_or_malformed_prefixes() {
        runtime().block_on(async {
            assert_eq!(
                accept(&mut &b"PWRGIT-MCP/1 0.0.1 token\n"[..], true)
                    .await
                    .unwrap(),
                Greeting::Raw {
                    version: "0.0.1".into(),
                    identity: Some("token".into()),
                    role: None
                }
            );
            for line in ["POST /mcp HTTP/1.1\r\n", "GET / HTTP/1.0\r\n"] {
                assert!(accept(&mut line.as_bytes(), false).await.is_err());
            }
            for line in [
                "PWRGIT-MCP/9 1\n",
                "PWRGIT-MCP/1 1 token extra\n",
                "PWRGIT-MCP/1 1  role=\n",
                "PWRGIT-MCP/1 1  role=has space\n",
                "PWRGIT-MCP/1 1  role=bad/char\n",
                "PWRGIT-MCP/1 1  role=builtin.discovery extra\n",
                "POST / HTTP/2.0\r\n",
                "POST / HTTP/1.1\n",
                "POST  / HTTP/1.1\r\n",
                "GET http://host/ HTTP/1.1\r\n",
                "PRI * HTTP/2.0\r\n",
                "{",
                "POST",
                "PWR",
                "",
            ] {
                assert!(accept(&mut line.as_bytes(), true).await.is_err(), "{line}");
            }
            for line in [
                format!("POST /{}", "x".repeat(MAX_LINE)),
                format!("PWRGIT-MCP/1 {}", "x".repeat(128)),
            ] {
                assert!(accept(&mut line.as_bytes(), true).await.is_err());
            }
        });
    }
    #[test]
    fn stalled_prefix_has_a_deadline_and_can_be_cancelled() {
        runtime().block_on(async {
            let (mut read, _write) = tokio::io::duplex(32);
            let started = std::time::Instant::now();
            assert!(accept(&mut read, true).await.is_err());
            assert!(started.elapsed() < Duration::from_secs(4));
            let (mut read, _write) = tokio::io::duplex(32);
            let task = tokio::spawn(async move { accept(&mut read, true).await });
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        });
    }
    #[test]
    fn requested_role_is_an_optional_fourth_field() {
        runtime().block_on(async {
            // A relay that names no role sends the three fields every
            // earlier desktop accepts; it reports no role.
            for (line, identity, role) in [
                ("PWRGIT-MCP/1 1.0.0 \n", None, None),
                ("PWRGIT-MCP/1 1.0.0\n", None, None),
                (
                    "PWRGIT-MCP/1 1.0.0  role=builtin.local-reader\n",
                    None,
                    Some("builtin.local-reader"),
                ),
                (
                    "PWRGIT-MCP/1 1.0.0 token role=role_1f0e\n",
                    Some("token"),
                    Some("role_1f0e"),
                ),
            ] {
                assert_eq!(
                    accept(&mut line.as_bytes(), true).await.unwrap(),
                    Greeting::Raw {
                        version: "1.0.0".into(),
                        identity: identity.map(Into::into),
                        role: role.map(Into::into),
                    },
                    "{line:?}"
                );
            }
            let longest = "r".repeat(MAX_ROLE_ID);
            let line = format!("PWRGIT-MCP/1 1.0.0  role={longest}\n");
            assert!(line.len() < 128);
            assert!(accept(&mut line.as_bytes(), true).await.is_ok());
            assert!(!valid_role_id(&"r".repeat(MAX_ROLE_ID + 1)));
        });
    }
}
