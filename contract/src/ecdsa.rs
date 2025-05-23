use crate::*;
use external::{mpc_contract, SignRequest};

const GAS: Gas = Gas::from_tgas(50);
const ATTACHED_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

pub fn get_sig(payload: Vec<u8>, path: String, key_version: u32) -> Promise {
    let request = SignRequest {
        payload: utils::vec_to_fixed(payload),
        path,
        key_version,
    };

    let mpc_contract_id = if env::current_account_id().as_str().contains("testnet") {
        "v1.signer-prod.testnet"
    } else {
        "v1.signer"
    };

    mpc_contract::ext(mpc_contract_id.parse().unwrap())
        .with_static_gas(GAS)
        .with_attached_deposit(ATTACHED_DEPOSIT)
        .sign(request)
}
