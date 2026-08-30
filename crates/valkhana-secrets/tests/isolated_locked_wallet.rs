use secret_service::{EncryptionType, blocking::SecretService};
use valkhana_secrets::{SecretServiceStore, SecretStore};

#[test]
#[ignore = "requires an explicitly isolated disposable Secret Service session"]
fn locked_default_collection_fails_closed_without_unlocking() {
    assert_eq!(
        std::env::var("VALKHANA_ISOLATED_SECRET_SERVICE").as_deref(),
        Ok("1"),
        "refusing to run locked-wallet drill outside an explicitly isolated session"
    );

    let service = SecretService::connect(EncryptionType::Dh).unwrap();
    let collection = service.get_default_collection().unwrap_or_else(|_| {
        service
            .create_collection("ValKhana disposable locked-wallet drill", "default")
            .unwrap()
    });
    collection.lock().unwrap();
    assert!(collection.is_locked().unwrap());

    let probe_error = SecretServiceStore.probe().unwrap_err();
    assert!(format!("{probe_error:#}").contains("locked"));
    assert!(SecretServiceStore.list_metadata().is_err());
    assert!(collection.is_locked().unwrap());
}
