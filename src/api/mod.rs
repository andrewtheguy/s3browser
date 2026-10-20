//! The JSON API under `/api/`, one module per route group.

pub mod auth;
pub mod bucket;
pub mod download;
pub mod objects;
pub mod upload;

use serde::Deserialize;

/// `?clear_region_cache=1` on the connection and bucket listings.
#[derive(Deserialize)]
pub struct ClearRegionCacheQuery {
    clear_region_cache: Option<String>,
}

impl ClearRegionCacheQuery {
    pub fn requested(&self) -> bool {
        matches!(self.clear_region_cache.as_deref(), Some("1" | "true"))
    }
}
