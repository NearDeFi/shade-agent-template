use crate::*;

const EVENT_STANDARD: &str = "shade-contract-template";
const EVENT_STANDARD_VERSION: &str = "1.0.0";

/// Maximum number of advisory IDs surfaced in an event; the full count is reported
/// separately via `number_of_advisory_ids` to keep event/log size bounded.
pub const MAX_ADVISORY_IDS: usize = 8;

/// Caps advisory IDs to at most [`MAX_ADVISORY_IDS`] for [`Event::AgentRegistered`],
/// returning the capped list together with the true total.
pub fn summarize_advisory_ids(advisory_ids: &[String]) -> (Vec<String>, u16) {
    let number_of_advisory_ids = u16::try_from(advisory_ids.len()).unwrap_or(u16::MAX);
    let advisory_ids_truncated = advisory_ids
        .iter()
        .take(MAX_ADVISORY_IDS)
        .cloned()
        .collect();
    (advisory_ids_truncated, number_of_advisory_ids)
}

#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
#[must_use = "Don't forget to `.emit()` this event"]
pub enum Event<'a> {
    AgentRegistered {
        account_id: &'a AccountId,
        measurements: &'a FullMeasurementsHex,
        ppid: &'a Ppid,
        advisory_ids_truncated: Vec<String>,
        number_of_advisory_ids: u16,
        current_time_ms: U64,
        valid_until_ms: U64,
        // Cannot log attestation, it's too large
    },
    AgentRemoved {
        account_id: &'a AccountId,
        reasons: Vec<AgentRemovalReason>,
    },
}

impl Event<'_> {
    pub fn emit(&self) {
        let data = serde_json::json!(self);
        let event_json = serde_json::json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_STANDARD_VERSION,
            "event": data["event"],
            "data": [data["data"]]
        })
        .to_string();
        log!("EVENT_JSON:{}", event_json);
    }
}
