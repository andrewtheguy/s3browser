use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

pub const DEFAULT_PORT: u16 = 8170;

/// Settings also come from `S3BROWSER_*` environment variables (a `.env` in
/// the working directory is loaded first) and `~/.s3browser/config.toml`.
#[derive(Parser)]
#[command(name = "s3browser", version, about = "S3-compatible file manager and indexing CLI")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Run the HTTP server with the web UI
    Server(ServerArgs),
    /// Index an S3 bucket for full-text search
    Index(IndexArgs),
}

#[derive(Args)]
pub struct ServerArgs {
    /// Address to bind (e.g. :8170, 127.0.0.1:3000, [::1]:3000,
    /// unix:/tmp/s3browser.sock; socket paths are capped at 108 bytes);
    /// defaults to S3BROWSER_BIND, then 0.0.0.0:8170
    #[arg(short, long, value_parser = parse_bind_address)]
    pub bind: Option<BindAddress>,
}

#[derive(Args)]
pub struct IndexArgs {
    /// Saved S3 connection ID
    #[arg(short, long, required_unless_present = "reset", value_parser = clap::value_parser!(i64).range(1..))]
    pub connection: Option<i64>,

    /// Bucket to index (defaults to the connection's saved bucket)
    #[arg(long)]
    pub bucket: Option<String>,

    /// Objects processed per S3 page/write loop
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(i32).range(1..))]
    pub batch_size: i32,

    /// Delete the search index database and exit
    #[arg(long)]
    pub reset: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BindAddress {
    /// `None` binds every IPv4 interface.
    pub host: Option<String>,
    pub port: u16,
    /// A Unix domain socket path, used instead of host and port.
    pub uds: Option<PathBuf>,
}

impl Default for BindAddress {
    fn default() -> Self {
        Self {
            host: None,
            port: DEFAULT_PORT,
            uds: None,
        }
    }
}

fn parse_port(raw: &str, bind: &str) -> Result<u16, String> {
    raw.parse()
        .map_err(|_| format!("Invalid bind address \"{bind}\": port must be a number from 0 to 65535"))
}

/// `PORT`, `:PORT`, `HOST`, `HOST:PORT`, `[IPV6]:PORT` or `unix:PATH`; empty
/// means the default.
pub fn parse_bind_address(bind: &str) -> Result<BindAddress, String> {
    if bind.is_empty() {
        return Ok(BindAddress::default());
    }
    if let Some(path) = bind.strip_prefix("unix:") {
        if path.is_empty() {
            return Err(
                "Invalid bind address \"unix:\": a socket path is required, e.g. unix:/tmp/s3browser.sock".to_string(),
            );
        }
        return Ok(BindAddress {
            uds: Some(PathBuf::from(path)),
            ..BindAddress::default()
        });
    }
    let host_port = |host: &str, port: u16| BindAddress {
        host: Some(host.to_string()),
        port,
        uds: None,
    };
    if bind.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(BindAddress {
            port: parse_port(bind, bind)?,
            ..BindAddress::default()
        });
    }
    if let Some(port) = bind.strip_prefix(':')
        && !port.contains(':')
    {
        return Ok(BindAddress {
            port: parse_port(port, bind)?,
            ..BindAddress::default()
        });
    }
    if let Some(rest) = bind.strip_prefix('[') {
        let Some((host, port)) = rest.split_once("]:") else {
            return Err(format!("Invalid bind address \"{bind}\": expected [IPV6]:PORT"));
        };
        return Ok(host_port(host, parse_port(port, bind)?));
    }
    match bind.matches(':').count() {
        0 => Ok(host_port(bind, DEFAULT_PORT)),
        1 => {
            let (host, port) = bind.split_once(':').expect("one colon");
            Ok(host_port(host, parse_port(port, bind)?))
        }
        _ => Err(format!(
            "Invalid bind address \"{bind}\": IPv6 must use bracket notation, e.g. [{}]:{DEFAULT_PORT}",
            bind.rsplit_once(':').map_or(bind, |(host, _)| host)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn tcp(host: Option<&str>, port: u16) -> BindAddress {
        BindAddress {
            host: host.map(str::to_string),
            port,
            uds: None,
        }
    }

    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn host_port_forms() {
        for (bind, expected) in [
            ("", tcp(None, 8170)),
            ("8170", tcp(None, 8170)),
            (":3000", tcp(None, 3000)),
            ("127.0.0.1:3000", tcp(Some("127.0.0.1"), 3000)),
            ("[::1]:3000", tcp(Some("::1"), 3000)),
            ("127.0.0.1", tcp(Some("127.0.0.1"), 8170)),
            ("localhost:3001", tcp(Some("localhost"), 3001)),
        ] {
            assert_eq!(parse_bind_address(bind).unwrap(), expected, "{bind}");
        }
    }

    #[test]
    fn unix_sockets() {
        for path in ["/run/s3browser.sock", "./s3browser.sock", "/tmp/dir with spaces/s3b.sock"] {
            let parsed = parse_bind_address(&format!("unix:{path}")).unwrap();
            assert_eq!(parsed.uds, Some(PathBuf::from(path)));
            assert_eq!((parsed.host, parsed.port), (None, 8170));
        }
        assert!(parse_bind_address("unix:").is_err());
    }

    #[test]
    fn invalid_forms() {
        let error = parse_bind_address("::1:3000").unwrap_err();
        assert!(error.contains("e.g. [::1]:8170"), "{error}");
        for bind in ["host:abc", "99999", ":", "[::1]", "[::1]:x"] {
            assert!(parse_bind_address(bind).is_err(), "{bind}");
        }
    }

    #[test]
    fn subcommand_flags() {
        let cli = Cli::try_parse_from(["s3browser", "server", "-b", ":9000"]).unwrap();
        let Commands::Server(args) = cli.command else { panic!("expected server") };
        assert_eq!(args.bind, Some(tcp(None, 9000)));

        let cli = Cli::try_parse_from(["s3browser", "index", "-c", "2", "--bucket", "b", "--batch-size", "500"]).unwrap();
        let Commands::Index(args) = cli.command else { panic!("expected index") };
        assert_eq!((args.connection, args.bucket.as_deref(), args.batch_size, args.reset), (Some(2), Some("b"), 500, false));

        assert!(Cli::try_parse_from(["s3browser", "index", "--reset"]).is_ok());
        assert!(Cli::try_parse_from(["s3browser", "index"]).is_err(), "--connection is required without --reset");
        assert!(Cli::try_parse_from(["s3browser", "index", "-c", "0"]).is_err());
        assert!(Cli::try_parse_from(["s3browser", "index", "-c", "1", "--batch-size", "0"]).is_err());
    }
}
