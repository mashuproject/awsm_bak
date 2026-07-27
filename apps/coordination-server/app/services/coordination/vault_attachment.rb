module Coordination
  class VaultAttachment
    FIELDS = %w[
      activeKeyEpochId
      deviceCertificate
      deviceKeyEnvelopes
      deviceProofSignature
      generationId
      generationNumber
      generationObject
      keyEpochs
      recoveryGeneration
      vaultId
    ].freeze
    KEY_EPOCH_FIELDS = %w[activatedAt keyEpochId ordinal].freeze
    GENERATION_OBJECT_FIELDS = %w[byteLength keyEpochId objectId objectType sha256].freeze

    Result = Data.define(:vault, :device, :generation, :upload)

    def initialize(account:, account_session_id:, body:)
      @account = account
      @account_session_id = account_session_id
      @body = body
    end

    def create!
      object = body.fetch("generationObject")
      key_epochs = validate!(object)
      vault_id = body.fetch("vaultId")
      recovery_generation_id = body.fetch("recoveryGeneration").fetch("recoveryGenerationId")
      active_key_epoch_id = body.fetch("activeKeyEpochId")
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
      envelopes = body.fetch("deviceKeyEnvelopes").zip(key_epochs).map do |value, epoch|
        DeviceKeyEnvelope.decode!(
          value,
          expected_vault_id: vault_id,
          expected_recovery_generation_id: recovery_generation_id,
          expected_key_epoch_id: epoch.fetch(:key_epoch_id),
          expected_device_id: certificate.fetch(:device_id),
          expected_administrator_public_key: recovery.fetch(:administrator_public_key)
        )
      end
      DeviceEnrollmentProof.verify!(
        body.fetch("deviceProofSignature"),
        certificate_cbor: certificate.fetch(:certificate_cbor),
        certificate_signature: certificate.fetch(:certificate_signature),
        signing_public_key: certificate.fetch(:signing_public_key),
        account_session_id:
      )

      account.lock!
      unless account.active?
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
      end
      vault = account.vault_replicas.create!(
        vault_id:,
        state: "Provisional",
        head_cursor: 0,
        active_key_epoch_id: active_key_epoch_id,
        active_recovery_generation_id: recovery_generation_id,
        provisional_expires_at: ServicePolicy.current.upload_staging_expiry_hours.hours.from_now
      )
      recovery_generation = vault.recovery_generations.create!(
        id: recovery_generation_id,
        ordinal: 0,
        activated_at: Time.current,
        **recovery.except(:vault_id, :recovery_generation_id)
      )
      persisted_key_epochs = key_epochs.each_with_index.map do |epoch, index|
        vault.vault_key_epochs.create!(
          id: epoch.fetch(:key_epoch_id),
          recovery_generation:,
          ordinal: epoch.fetch(:ordinal),
          activated_at: epoch.fetch(:activated_at),
          retired_at: key_epochs[index + 1]&.fetch(:activated_at)
        )
      end
      device = vault.vault_devices.create!(
        device_id: certificate.fetch(:device_id),
        recovery_generation:,
        enrolled_at: Time.current,
        **certificate.except(:device_id, :vault_id, :recovery_generation_id, :issued_at)
      )
      envelopes.zip(persisted_key_epochs).each do |envelope, key_epoch|
        device.device_key_envelopes.create!(
          vault_key_epoch: key_epoch,
          recovery_generation:,
          **envelope.except(:vault_device_id, :vault_key_epoch_id, :recovery_generation_id)
        )
      end
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
        vault_key_epoch: persisted_key_epochs.last
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
      key_epochs = body.fetch("keyEpochs")
      envelopes = body.fetch("deviceKeyEnvelopes")
      active_key_epoch_id = body.fetch("activeKeyEpochId")
      raise KeyError unless (body.keys - [ "vault" ]).sort == FIELDS.sort
      raise KeyError unless object.is_a?(Hash) && object.keys.sort == GENERATION_OBJECT_FIELDS.sort
      raise KeyError unless key_epochs.is_a?(Array) && key_epochs.any?
      raise KeyError unless envelopes.is_a?(Array) && envelopes.length == key_epochs.length

      decoded_key_epochs = key_epochs.each_with_index.map do |epoch, ordinal|
        raise KeyError unless epoch.is_a?(Hash) && epoch.keys.sort == KEY_EPOCH_FIELDS.sort
        raise KeyError unless epoch.fetch("ordinal") == ordinal

        key_epoch_id = epoch.fetch("keyEpochId")
        activated_at = Time.iso8601(epoch.fetch("activatedAt"))
        raise KeyError unless key_epoch_id.is_a?(String)

        { key_epoch_id:, ordinal:, activated_at: }
      end
      epoch_ids = decoded_key_epochs.pluck(:key_epoch_id)
      activation_times = decoded_key_epochs.pluck(:activated_at)
      valid = generation_number.is_a?(Integer) &&
        generation_number.between?(0, 9_007_199_254_740_991) &&
        body.fetch("generationId") == object.fetch("objectId") &&
        object.fetch("objectType") == "VaultGeneration" &&
        object.fetch("byteLength").is_a?(Integer) &&
        object.fetch("keyEpochId") == active_key_epoch_id &&
        epoch_ids.uniq.length == epoch_ids.length &&
        activation_times.each_cons(2).all? { |left, right| left < right } &&
        active_key_epoch_id == epoch_ids.last
      raise KeyError unless valid

      decoded_key_epochs
    rescue ArgumentError, TypeError
      raise KeyError
    end
  end
end
