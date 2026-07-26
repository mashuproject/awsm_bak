module Api
  class ReplacementCandidatesController < BaseController
    def create
      source = bound_vault!
      body = request.request_parameters
      replacement_body = body.fetch("replacement")
      idempotency = Coordination::Idempotency.new(
        account: current_account,
        request:,
        operation: "CreateVaultReplacement"
      )
      if (replay = idempotency.replay)
        replacement = current_account.vault_replicas.find(replay.resource_id)
        device = replacement.vault_devices.find_by!(revoked_at: nil)
        issued = Coordination::SessionCredentials.issue(
          account: current_account,
          scope: "VaultDevice",
          vault_device_id: device.device_id
        )
        return render_candidate(replacement, issued:)
      end

      replacement = nil
      issued = nil
      VaultReplica.transaction do
        source.lock!
        assert_source_fence!(source, body)
        account_session = current_account.api_sessions.find_by!(
          id: body.fetch("accountSessionId"),
          scope: "Account",
          revoked_at: nil
        )
        if current_account.vault_replicas.where(state: "Provisional").exists?
          raise Coordination::OutcomeError.new("VAULT_REPLACEMENT_CONFLICT", status: :conflict)
        end
        if VaultReplica.exists?(vault_id: replacement_body.fetch("vaultId"))
          raise Coordination::OutcomeError.new("VAULT_ID_UNAVAILABLE", status: :conflict)
        end
        attached = Coordination::VaultAttachment.new(
          account: current_account,
          account_session_id: account_session.id,
          body: replacement_body
        ).create!
        replacement = attached.vault
        issued = Coordination::SessionCredentials.issue(
          account: current_account,
          scope: "VaultDevice",
          vault_device_id: attached.device.device_id
        )
        idempotency.persist!(resource_type: "VaultReplica", resource_id: replacement.id)
      end
      render_candidate(replacement, issued:)
    rescue KeyError, ActiveRecord::RecordInvalid, ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    rescue ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("VAULT_REPLACEMENT_CONFLICT", status: :conflict)
    end

    def activate
      source = current_account.vault_replicas.find_by!(vault_id: params[:vault_id])
      replacement = current_principal.session&.vault_device&.vault_replica
      unless replacement&.vault_id == params[:replacement_vault_id]
        raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
      end
      body = request.request_parameters
      idempotency = Coordination::Idempotency.new(
        account: current_account,
        request:,
        operation: "ActivateVaultReplacement"
      )
      if (replay = idempotency.replay)
        purge = PurgeJob.find(replay.resource_id)
        return render_activation(source.reload, replacement.reload, purge)
      end

      purge = nil
      VaultReplica.transaction do
        [ source, replacement ].sort_by(&:id).each(&:lock!)
        assert_source_fence!(source, body)
        unless replacement.state == "Provisional" &&
            replacement.active_generation&.generation_id == body.fetch("replacementGenerationId") &&
            replacement.active_generation_number == body.fetch("replacementGenerationNumber")
          raise Coordination::OutcomeError.new("VAULT_REPLACEMENT_CONFLICT", status: :conflict)
        end
        now = Time.current
        source.update!(state: "Replaced", replaced_at: now)
        replacement.update!(state: "Active", provisional_expires_at: nil)
        source.vault_devices.where(revoked_at: nil).find_each do |device|
          device.update!(revoked_at: now, revocation_reason: "VaultReencrypted")
        end
        ApiSession.where(vault_device_id: source.vault_device_ids, revoked_at: nil)
          .update_all(revoked_at: now, updated_at: now)
        SessionCredential.joins(:api_session)
          .where(api_sessions: { vault_device_id: source.vault_device_ids })
          .where(revoked_at: nil)
          .update_all(revoked_at: now, updated_at: now)
        generations = source.vault_generations.where.not(state: "Purged").to_a
        record_ids = GenerationMembership.where(vault_generation: generations)
          .distinct.pluck(:opaque_record_id)
        purge = source.purge_jobs.create!(
          state: "Pending",
          stage: "Detach",
          reason: "VaultReplacement",
          generation_count: generations.length,
          record_count: record_ids.length,
          total_bytes: OpaqueRecord.where(id: record_ids).sum(:byte_length),
          confirmed_at: current_principal.confirmed_at
        )
        generations.each do |generation|
          purge.purge_job_generations.create!(vault_generation: generation)
          generation.update!(state: "Purging", purge_started_at: now)
        end
        TransferTicket.where(vault_generation: generations, revoked_at: nil)
          .update_all(revoked_at: now)
        idempotency.persist!(resource_type: "PurgeJob", resource_id: purge.id)
      end
      PurgeGenerationJob.perform_later(purge.id)
      Coordination::VaultNotifier.broadcast(source)
      Coordination::VaultNotifier.broadcast(replacement)
      render_activation(source.reload, replacement.reload, purge)
    rescue KeyError, ActiveRecord::RecordNotFound, ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("VAULT_REPLACEMENT_CONFLICT", status: :conflict)
    end

    private

    def assert_source_fence!(source, body)
      unless source.state == "Active" &&
          source.active_generation&.generation_id == body.fetch("expectedSourceGenerationId") &&
          source.active_generation_number == body.fetch("expectedSourceGenerationNumber") &&
          source.head_cursor == body.fetch("expectedSourceHeadCursor")
        raise Coordination::OutcomeError.new("VAULT_REPLACEMENT_CONFLICT", status: :conflict)
      end
    end

    def render_candidate(replacement, issued:)
      generation = replacement.vault_generations.find_by!(state: "Candidate")
      upload = generation.generation_record.upload
      render json: {
        vault: Coordination::Serializers.vault(replacement),
        upload: Coordination::Serializers.upload(upload),
        ticket: Coordination::TransferTicketIssuer.upload(
          account: current_account,
          vault: replacement,
          upload:
        ),
        session: Coordination::AccountPayload.response(account: current_account, issued:)
      }, status: :created
    end

    def render_activation(source, replacement, purge)
      render json: {
        sourceVaultId: source.vault_id,
        sourceState: source.state,
        vault: Coordination::Serializers.vault(replacement),
        purge: {
          purgeId: purge.id,
          state: purge.state,
          stage: purge.stage,
          processedBytes: purge.processed_bytes,
          totalBytes: purge.total_bytes
        }
      }, status: :accepted
    end
  end
end
