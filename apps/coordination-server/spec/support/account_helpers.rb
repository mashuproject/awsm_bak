require "digest"

module AccountHelpers
  def account_attributes(username: nil)
    sequence = SecureRandom.uuid
    {
      username: username || "reader_#{sequence.delete("-").first(16)}",
      password: "test password #{sequence}",
      password_confirmation: "test password #{sequence}",
      last_activity_at: Time.current
    }
  end

  def create_account(**attributes)
    Account.create!(**account_attributes.merge(attributes))
  end

  def vault_slot_attributes(account:, vault_id:)
    {}
  end

  def create_vault_device_principal(account:, vault:)
    Coordination::AccountAuthenticator
    recovery = vault.recovery_generations.first || begin
      ciphertext = SecureRandom.random_bytes(32)
      vault.recovery_generations.create!(
        id: SecureRandom.uuid,
        ordinal: 0,
        derivation_algorithm: RecoveryGeneration::DERIVATION_ALGORITHM,
        wrapping_algorithm: RecoveryGeneration::WRAPPING_ALGORITHM,
        administrator_signing_algorithm: RecoveryGeneration::SIGNING_ALGORITHM,
        administrator_public_key: SecureRandom.random_bytes(32),
        kit_nonce: SecureRandom.random_bytes(24),
        kit_ciphertext: ciphertext,
        kit_ciphertext_length: ciphertext.bytesize,
        kit_ciphertext_sha256: Digest::SHA256.digest(ciphertext),
        activated_at: Time.current
      )
    end
    epoch = vault.vault_key_epochs.first || vault.vault_key_epochs.create!(
      id: SecureRandom.uuid,
      recovery_generation: recovery,
      ordinal: 0,
      activated_at: Time.current
    )
    device = vault.vault_devices.first || vault.vault_devices.create!(
      device_id: SecureRandom.uuid,
      recovery_generation: recovery,
      certificate_id: SecureRandom.uuid,
      display_name: "Test Device",
      client_kind: "FirefoxExtension",
      signing_algorithm: "sign:ed25519:device:v1",
      signing_public_key: SecureRandom.random_bytes(32),
      wrapping_algorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      wrapping_public_key: SecureRandom.random_bytes(32),
      certificate_cbor: "certificate",
      certificate_signature: SecureRandom.random_bytes(64),
      enrolled_at: Time.current
    )
    vault.update!(
      active_recovery_generation_id: recovery.id,
      active_key_epoch_id: epoch.id
    )
    session = Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: device.device_id
    ).fetch(:session)
    Coordination::AccountPrincipal.new(
      account:,
      confirmed_at: session.confirmed_at,
      session:,
      scope: "VaultDevice"
    )
  end
end
