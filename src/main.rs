mod api;
mod assets;
mod cli;
mod config;
mod crypto;
mod db;
mod error;
mod indexer;
mod lock;
mod paths;
mod s3;
mod server;
mod session;
#[cfg(test)]
mod test_support;
mod validate;
mod zip;

use anyhow::Context;
use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // A missing .env is fine; settings then come from the real environment.
    let _ = dotenvy::dotenv();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();
    let config = config::Config::load(paths::AppPaths::from_home()?)?;
    match cli.command {
        Commands::Server(args) => {
            let bind = match args.bind {
                Some(bind) => bind,
                None => cli::parse_bind_address(config.bind().unwrap_or_default())
                    .map_err(anyhow::Error::msg)
                    .context(config::BIND_ENV_VAR)?,
            };
            server::run(config, bind).await
        }
        Commands::Index(args) => indexer::run_command(config, args).await,
    }
}
