use serde::{Deserialize, Serialize};

pub const SERVICE_NAME: &str = "valkhana-core";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct HealthResponse {
    pub name: String,
    pub version: String,
    pub status: HealthStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Healthy,
}

impl HealthResponse {
    pub fn healthy(version: &str) -> Self {
        Self {
            name: SERVICE_NAME.to_owned(),
            version: version.to_owned(),
            status: HealthStatus::Healthy,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_response_uses_canonical_service_name() {
        let response = HealthResponse::healthy("0.1.0");
        assert_eq!(response.name, "valkhana-core");
        assert_eq!(response.status, HealthStatus::Healthy);
    }
}
