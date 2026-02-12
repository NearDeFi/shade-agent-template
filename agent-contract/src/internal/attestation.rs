use crate::*;

impl Contract {
    pub(crate) fn verify_attestation(
        &self,
        attestation: DstackAttestation,
    ) -> (FullMeasurementsHex, Ppid) {
        let result: (FullMeasurementsHex, Ppid) = match self.requires_tee {
            true => {
                // Get the current time
                let current_time_seconds = block_timestamp_ms() / 1000;

                // Verify account_ID is an implicit account ID
                let account_id_str = env::predecessor_account_id().to_string();
                require!(
                    account_id_str.len() == 64
                        && account_id_str
                            .chars()
                            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
                    "Account ID must be implicit account"
                );

                // Create the report data by converting the account ID to bytes and padding to 64 bytes
                let account_id_bytes =
                    hex::decode(&account_id_str).expect("Failed to decode account ID");
                let mut report_data_bytes = [0u8; 64];
                report_data_bytes[..32].copy_from_slice(&account_id_bytes);
                let expected_report_data = ReportData::from(report_data_bytes);

                // Convert measurements to Vec and convert to FullMeasurements
                let expected_measurements: Vec<FullMeasurements> = self
                    .approved_measurements
                    .iter()
                    .cloned()
                    .map(Into::into)
                    .collect();

                // Convert PPIDs to Vec
                let approved_ppids: Vec<Ppid> = self.approved_ppids.iter().cloned().collect();

                // Verify the attestation
                match attestation.verify(
                    expected_report_data,
                    current_time_seconds,
                    &expected_measurements,
                    &approved_ppids,
                ) {
                    Ok((verified_measurements, verified_ppid)) => {
                        (verified_measurements.into(), verified_ppid)
                    }
                    Err(e) => {
                        panic!("Attestation verification failed: {}", e);
                    }
                }
            }
            false => {
                // For local mode check that the agent is whitelisted and the default measurements and PPID are approved
                require!(
                    self.whitelisted_agents_for_local
                        .contains(&env::predecessor_account_id()),
                    "Agent needs to be whitelisted for local mode"
                );
                let default_measurements = create_mock_full_measurements_hex();
                require!(
                    self.approved_measurements.contains(&default_measurements),
                    "Default measurements must be approved for local mode"
                );
                require!(
                    self.approved_ppids.contains(&Ppid::default()),
                    "Default PPID must be approved for local mode"
                );
                (default_measurements, Ppid::default())
            }
        };
        result
    }
}
