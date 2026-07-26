module Coordination
  class VaultAttachment
    Result = Data.define(:vault, :device, :generation, :upload)

    def initialize(account:, account_session_id:, body:)
      @account = account
      @account_session_id = account_session_id
      @body = body
    end

    def create!
      object = body.fetch("generationObject")
      validate!(object)
      vault_id = body.fetch("vaultId")
      recovery_generation_id = body.fetch("recoveryGeneration").fetch("recoveryGenerationId")
      key_epoch_id = body.fetch("keyEpoch").fetch("keyEpochId")
      recovery = RecoveryKit.decode!(
        body.fetch("recoveryGeneration"),
        expected_vault_id: vault_id,
        expected_recovery_generation_id: recovery_generation_id
      )
      certificate = DeviceCertificate.decode!(
        body.fetch("deviceCertificate"),
        expected_vault_id: vault_id,
        expected_recovery_generation_id: recovery_generation_id,
        expected_administrator_public_key: recovery.fetch(:administrator_public_key)
      )
      envelope = DeviceKeyEnvelope.decode!(
        body.fetch("deviceKeyEnvelope"),
        expected_vault_id: vault_id,
        expected_recovery_generation_id: recovery_generation_id,
        expected_key_epoch_id: key_epoch_id,
        expected_device_id: certificate.fetch(:device_id),
        expected_administrator_public_key: recovery.fetch(:administrator_public_key)
      )
      DeviceEnrollmentProof.verify!(
        body.fetch("deviceProofSignature"),
        certificate_cbor: certificate.fetch(:certificate_cbor),
        certificate_signature: certificate.fetch(:certificate_signature),
        signing_public_key: certificate.fetch(:signing_public_key),
        account_session_id:
      )

      vault = account.vault_replicas.create!(
        vault_id:,
        state: "Provisional",
        head_cursor: 0,
        active_key_epoch_id: key_epoch_id,
        active_recovery_generation_id: recovery_generation_id,
        provisional_expires_at: ServicePolicy.current.upload_staging_expiry_hours.hours.from_now
      )
      recovery_generation = vault.recovery_generations.create!(
        id: recovery_generation_id,
        ordinal: 0,
        activated_at: Time.current,
        **recovery.except(:vault_id, :recovery_generation_id)
      )
      key_epoch = vault.vault_key_epochs.create!(
        id: key_epoch_id,
        recovery_generation:,
        ordinal: 0,
        activated_at: Time.current
      )
      device = vault.vault_devices.create!(
        device_id: certificate.fetch(:device_id),
        recovery_generation:,
        enrolled_at: Time.current,
        **certificate.except(:device_id, :vault_id, :recovery_generation_id, :issued_at)
      )
      device.device_key_envelopes.create!(
        vault_key_epoch: key_epoch,
        recovery_generation:,
        **envelope.except(:vault_device_id, :vault_key_epoch_id, :recovery_generation_id)
      )
      generation = vault.vault_generations.create!(
        generation_id: body.fetch("generationId"),
        generation_number: body.fetch("generationNumber"),
        state: "Candidate"
      )
      record = vault.opaque_records.create!(
        object_id: object.fetch("objectId"),
        object_type: "VaultGeneration",
        byte_length: object.fetch("byteLength"),
        sha256: ProtocolEncoding.decode_sha256(object.fetch("sha256")),
        state: "Uploading",
        target_generation_id: generation.generation_id,
        vault_key_epoch: key_epoch
      )
      part_size = [ ServicePolicy.current.upload_part_size_bytes, record.byte_length ].min
      upload = record.create_upload!(
        state: "Open",
        part_size:,
        part_count: (record.byte_length.to_f / part_size).ceil,
        expires_at: vault.provisional_expires_at,
        last_activity_at: Time.current
      )
      generation.update!(generation_record: record)
      Result.new(vault:, device:, generation:, upload:)
    end

    private

    attr_reader :account, :account_session_id, :body

    def validate!(object)
      generation_number = body.fetch("generationNumber")
      key_epoch = body.fetch("keyEpoch")
      valid = generation_number.is_a?(Integer) &&
        generation_number.between?(0, 9_007_199_254_740_991) &&
        body.fetch("generationId") == object.fetch("objectId") &&
        object.fetch("objectType") == "VaultGeneration" &&
        object.fetch("byteLength").is_a?(Integer) &&
        object.fetch("keyEpochId") == key_epoch.fetch("keyEpochId") &&
        key_epoch.keys.sort == %w[keyEpochId ordinal].sort &&
        key_epoch.fetch("ordinal") == 0
      raise KeyError unless valid
    end
  end
end
