module Api
  class VaultDevicesController < BaseController
    skip_before_action :require_vault_device_scope, only: :create
    before_action :require_account_scope, only: :create

    def index
      vault = device_vault!
      render json: {
        devices: vault.vault_devices.order(:enrolled_at, :device_id).map do |device|
          {
            deviceId: device.device_id,
            certificateId: device.certificate_id,
            displayName: device.display_name,
            clientKind: device.client_kind,
            recoveryGenerationId: device.recovery_generation_id,
            deviceCertificate: {
              content: Coordination::ProtocolEncoding.encode_base64url(device.certificate_cbor),
              recoveryAdministratorPublicKey:
                Coordination::ProtocolEncoding.encode_base64url(
                  device.recovery_generation.administrator_public_key
                ),
              signature:
                Coordination::ProtocolEncoding.encode_base64url(device.certificate_signature)
            },
            enrolledAt: Coordination::ProtocolEncoding.timestamp(device.enrolled_at),
            current: device.device_id == current_principal.session.vault_device_id,
            **(device.revoked_at.nil? ? {} : {
              revokedAt: Coordination::ProtocolEncoding.timestamp(device.revoked_at),
              revocationReason: device.revocation_reason
            })
          }
        end
      }
    end

    def authority
      vault = device_vault!
      device = current_principal.session.vault_device
      recovery = vault.active_recovery_generation
      epoch = vault.active_key_epoch
      unless device.active? && device.recovery_generation_id == recovery.id
        raise Coordination::OutcomeError.new("DEVICE_REVOKED", status: :unauthorized)
      end
      envelope = device.device_key_envelopes.find_by!(vault_key_epoch_id: epoch.id)
      metadata = Coordination::CanonicalCbor.decode(envelope.signed_metadata).fetch("metadata")
      render json: {
        vaultId: vault.vault_id,
        activeRecoveryGenerationId: recovery.id,
        activeKeyEpochId: epoch.id,
        keyEpochOrdinal: epoch.ordinal,
        deviceCertificate: {
          content: Coordination::ProtocolEncoding.encode_base64url(device.certificate_cbor),
          recoveryAdministratorPublicKey:
            Coordination::ProtocolEncoding.encode_base64url(recovery.administrator_public_key),
          signature: Coordination::ProtocolEncoding.encode_base64url(device.certificate_signature)
        },
        deviceKeyEnvelope: {
          metadata:
            Coordination::ProtocolEncoding.encode_base64url(
              Coordination::CanonicalCbor.encode(metadata)
            ),
          ciphertext: Coordination::ProtocolEncoding.encode_base64url(envelope.ciphertext),
          ciphertextSha256:
            Coordination::ProtocolEncoding.encode_base64url(envelope.ciphertext_sha256),
          administratorSignature:
            Coordination::ProtocolEncoding.encode_base64url(envelope.administrator_signature)
        }
      }
    rescue ActiveRecord::RecordNotFound, KeyError, ArgumentError
      raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
        status: :unprocessable_content)
    end

    def destroy
      vault = device_vault!
      VaultDevice.transaction do
        vault.lock!
        device = vault.vault_devices.find(params[:device_id])
        device.lock!
        if device.revoked?
          raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
            status: :unprocessable_content)
        end
        now = Time.current
        device.update!(revoked_at: now, revocation_reason: "Removed")
        device.api_sessions.where(revoked_at: nil).find_each { |session| session.revoke!(at: now) }
        vault.transfer_tickets.where(revoked_at: nil).update_all(
          revoked_at: now,
          updated_at: now
        )
      end
      Coordination::VaultNotifier.broadcast(vault)
      head :no_content
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
    end

    def future_protection
      vault = device_vault!
      body = request.request_parameters
      idempotency = Coordination::Idempotency.new(
        account: current_account,
        request:,
        operation: "ProtectFutureContent"
      )
      if (replay = idempotency.replay)
        return render json: Coordination::Serializers.vault(VaultReplica.find(replay.resource_id))
      end
      expected_recovery_id = body.fetch("expectedRecoveryGenerationId")
      expected_epoch_id = body.fetch("expectedKeyEpochId")
      target_device_id = body.fetch("targetDeviceId")
      recovery_id = body.fetch("recoveryGeneration").fetch("recoveryGenerationId")
      key_epoch = body.fetch("keyEpoch")
      unless vault.active_recovery_generation_id == expected_recovery_id &&
          vault.active_key_epoch_id == expected_epoch_id
        raise Coordination::OutcomeError.new("RECOVERY_GENERATION_CHANGED", status: :conflict)
      end
      next_ordinal = vault.vault_key_epochs.find_by(id: expected_epoch_id)&.ordinal&.+(1)
      unless key_epoch.keys.sort == %w[keyEpochId ordinal].sort &&
          next_ordinal && key_epoch.fetch("ordinal") == next_ordinal
        raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
          status: :unprocessable_content)
      end
      recovery = Coordination::RecoveryKit.decode!(
        body.fetch("recoveryGeneration"),
        expected_vault_id: vault.vault_id,
        expected_recovery_generation_id: recovery_id
      )
      active_devices = vault.vault_devices.where(revoked_at: nil).order(:device_id).to_a
      target = active_devices.find { |device| device.device_id == target_device_id }
      remaining = active_devices.reject { |device| device.device_id == target_device_id }
      submitted = body.fetch("remainingDevices")
      unless target &&
          target.device_id != current_principal.session.vault_device_id &&
          submitted.is_a?(Array) &&
          submitted.length == remaining.length
        raise Coordination::OutcomeError.new("RECOVERY_GENERATION_CHANGED", status: :conflict)
      end
      decoded = submitted.map do |candidate|
        certificate = Coordination::DeviceCertificate.decode!(
          candidate.fetch("deviceCertificate"),
          expected_vault_id: vault.vault_id,
          expected_recovery_generation_id: recovery_id,
          expected_administrator_public_key: recovery.fetch(:administrator_public_key)
        )
        existing = remaining.find { |device| device.device_id == certificate.fetch(:device_id) }
        unless existing
          raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
            status: :unprocessable_content)
        end
        expected_facts = [
          existing.device_id, existing.display_name, existing.client_kind,
          existing.signing_algorithm, existing.signing_public_key,
          existing.wrapping_algorithm, existing.wrapping_public_key
        ]
        actual_facts = certificate.values_at(
          :device_id, :display_name, :client_kind, :signing_algorithm, :signing_public_key,
          :wrapping_algorithm, :wrapping_public_key
        )
        unless actual_facts == expected_facts
          raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
            status: :unprocessable_content)
        end
        envelope = Coordination::DeviceKeyEnvelope.decode!(
          candidate.fetch("deviceKeyEnvelope"),
          expected_vault_id: vault.vault_id,
          expected_recovery_generation_id: recovery_id,
          expected_key_epoch_id: key_epoch.fetch("keyEpochId"),
          expected_device_id: existing.device_id,
          expected_administrator_public_key: recovery.fetch(:administrator_public_key)
        )
        [ existing, certificate, envelope ]
      end
      unless decoded.map { |device, _certificate, _envelope| device.device_id }.sort ==
          remaining.map(&:device_id).sort
        raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
          status: :unprocessable_content)
      end

      VaultReplica.transaction do
        vault.lock!
        unless vault.active_recovery_generation_id == expected_recovery_id &&
            vault.active_key_epoch_id == expected_epoch_id &&
            recovery_id != expected_recovery_id &&
            vault.vault_devices.where(revoked_at: nil).order(:device_id).pluck(:device_id) ==
              active_devices.map(&:device_id)
          raise Coordination::OutcomeError.new("RECOVERY_GENERATION_CHANGED", status: :conflict)
        end
        old_recovery = vault.active_recovery_generation
        old_epoch = vault.active_key_epoch
        now = Time.current
        old_recovery.update!(retired_at: now, kit_ciphertext: nil)
        old_epoch.update!(retired_at: now)
        new_recovery = vault.recovery_generations.create!(
          id: recovery_id,
          ordinal: old_recovery.ordinal + 1,
          activated_at: now,
          **recovery.except(:vault_id, :recovery_generation_id)
        )
        new_epoch = vault.vault_key_epochs.create!(
          id: key_epoch.fetch("keyEpochId"),
          recovery_generation: new_recovery,
          ordinal: next_ordinal,
          activated_at: now
        )
        decoded.each do |device, certificate, envelope|
          device.update!(
            recovery_generation: new_recovery,
            **certificate.except(:device_id, :vault_id, :recovery_generation_id, :issued_at)
          )
          device.device_key_envelopes.create!(
            vault_key_epoch: new_epoch,
            recovery_generation: new_recovery,
            **envelope.except(
              :vault_device_id, :vault_key_epoch_id, :recovery_generation_id
            )
          )
        end
        target.update!(revoked_at: now, revocation_reason: "FutureProtection")
        active_devices.each do |device|
          device.api_sessions.where(revoked_at: nil).find_each { |session| session.revoke!(at: now) }
        end
        vault.transfer_tickets.where(revoked_at: nil).update_all(
          revoked_at: now,
          updated_at: now
        )
        DeviceKeyEnvelope.where(
          vault_device_id: active_devices.map(&:device_id),
          recovery_generation_id: old_recovery.id
        ).delete_all
        vault.update!(
          active_recovery_generation: new_recovery,
          active_key_epoch: new_epoch
        )
        idempotency.persist!(resource_type: "VaultReplica", resource_id: vault.id)
      end
      vault.reload
      Coordination::VaultNotifier.broadcast(vault)
      render json: Coordination::Serializers.vault(vault)
    rescue KeyError, ActiveRecord::RecordInvalid
      raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
        status: :unprocessable_content)
    rescue ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("RECOVERY_GENERATION_CHANGED", status: :conflict)
    end

    def create
      idempotency = Coordination::Idempotency.new(
        account: current_account,
        request:,
        operation: "EnrollVaultDevice"
      )
      if (replay = idempotency.replay)
        device = account_vault!.vault_devices.find(replay.resource_id)
        issued = Coordination::SessionCredentials.issue(
          account: current_account,
          scope: "VaultDevice",
          vault_device_id: device.device_id
        )
        return render json: Coordination::AccountPayload.response(account: current_account, issued:),
          status: :created
      end

      vault = account_vault!
      recovery_generation = vault.active_recovery_generation
      unless recovery_generation&.activated_at? && recovery_generation.retired_at.nil?
        raise Coordination::OutcomeError.new("RECOVERY_GENERATION_CHANGED", status: :conflict)
      end
      body = request.request_parameters
      certificate = Coordination::DeviceCertificate.decode!(
        body.fetch("deviceCertificate"),
        expected_vault_id: vault.vault_id,
        expected_recovery_generation_id: recovery_generation.id,
        expected_administrator_public_key: recovery_generation.administrator_public_key
      )
      Coordination::DeviceEnrollmentProof.verify!(
        body.fetch("deviceProofSignature"),
        certificate_cbor: certificate.fetch(:certificate_cbor),
        certificate_signature: certificate.fetch(:certificate_signature),
        signing_public_key: certificate.fetch(:signing_public_key),
        account_session_id: current_principal.session.id
      )
      epochs = vault.vault_key_epochs.order(:ordinal).to_a
      submitted_envelopes = body.fetch("deviceKeyEnvelopes")
      unless submitted_envelopes.is_a?(Array) && epochs.present? &&
          submitted_envelopes.length == epochs.length
        raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
          status: :unprocessable_content)
      end
      decoded_envelopes = epochs.zip(submitted_envelopes).map do |epoch, envelope|
        Coordination::DeviceKeyEnvelope.decode!(
          envelope,
          expected_vault_id: vault.vault_id,
          expected_recovery_generation_id: recovery_generation.id,
          expected_key_epoch_id: epoch.id,
          expected_device_id: certificate.fetch(:device_id),
          expected_administrator_public_key: recovery_generation.administrator_public_key
        )
      end

      device = nil
      issued = nil
      VaultDevice.transaction do
        vault.lock!
        unless vault.active_recovery_generation_id == recovery_generation.id &&
            vault.vault_key_epochs.order(:ordinal).pluck(:id) == epochs.map(&:id)
          raise Coordination::OutcomeError.new("RECOVERY_GENERATION_CHANGED", status: :conflict)
        end
        device = vault.vault_devices.create!(
          device_id: certificate.fetch(:device_id),
          recovery_generation:,
          enrolled_at: Time.current,
          **certificate.except(
            :device_id, :vault_id, :recovery_generation_id, :issued_at
          )
        )
        epochs.zip(decoded_envelopes).each do |epoch, envelope|
          device.device_key_envelopes.create!(
            vault_key_epoch: epoch,
            recovery_generation:,
            **envelope.except(
              :vault_device_id, :vault_key_epoch_id, :recovery_generation_id
            )
          )
        end
        issued = Coordination::SessionCredentials.issue(
          account: current_account,
          scope: "VaultDevice",
          vault_device_id: device.device_id
        )
        idempotency.persist!(resource_type: "VaultDevice", resource_id: device.device_id)
      end

      render json: Coordination::AccountPayload.response(account: current_account, issued:),
        status: :created
    rescue KeyError, ActiveRecord::RecordInvalid
      raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
        status: :unprocessable_content)
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
    rescue ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("DEVICE_ENROLLMENT_INVALID",
        status: :unprocessable_content)
    end

    private

    def account_vault!
      current_account.vault_replicas.find_by!(vault_id: params[:vault_id], state: "Active")
    end

    def device_vault!
      device = current_principal.session.vault_device
      vault = device.vault_replica
      return vault if vault.state == "Active" && vault.vault_id == params[:vault_id]

      raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
    end
  end
end
