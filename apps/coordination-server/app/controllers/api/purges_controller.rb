module Api
  class PurgesController < BaseController
    def create
      unless current_principal.confirmed_at && current_principal.confirmed_at >= 10.minutes.ago
        raise Coordination::OutcomeError.new("RECENT_AUTHENTICATION_REQUIRED", status: :forbidden)
      end
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CreateManualPurge")
      if (replay = idempotency.replay)
        return render json: purge_json(PurgeJob.find(replay.resource_id)), status: :accepted
      end
      vault = account_vault!
      purge = nil
      VaultReplica.transaction do
        vault.lock!
        if vault.purge_jobs.where(state: [ "Pending", "Running", "FailedRetryable" ]).exists?
          raise Coordination::OutcomeError.new("PURGE_IN_PROGRESS", status: :conflict)
        end
        generations = vault.vault_generations.where(state: "Superseded").to_a
        record_ids = GenerationMembership.where(vault_generation: generations).distinct.pluck(:opaque_record_id)
        purge = vault.purge_jobs.create!(state: "Pending", stage: "Snapshot", reason: "Manual",
          generation_count: generations.length,
          record_count: record_ids.length,
          total_bytes: OpaqueRecord.where(id: record_ids).sum(:byte_length),
          confirmed_at: current_principal.confirmed_at)
        generations.each do |generation|
          purge.purge_job_generations.create!(vault_generation: generation)
          generation.update!(state: "Purging", purge_started_at: Time.current)
        end
        TransferTicket.where(vault_generation: generations, purpose: "RecoveryDownload", revoked_at: nil)
          .update_all(revoked_at: Time.current)
        idempotency.persist!(resource_type: "PurgeJob", resource_id: purge.id)
      end
      PurgeGenerationJob.perform_later(purge.id)
      render json: purge_json(purge), status: :accepted
    end

    def show
      vault = purge_status_vault!
      purge = vault.purge_jobs.find(params[:purge_id])
      device_vault = current_principal.session&.vault_device&.vault_replica
      unless vault == device_vault ||
          (vault.state == "Replaced" && purge.reason == "VaultReplacement")
        raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
      end
      render json: purge_json(purge)
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
    end

    private

    def account_vault!
      bound_vault!
    end

    def purge_status_vault!
      current_account.vault_replicas.find_by!(vault_id: params[:vault_id])
    end

    def purge_json(purge)
      result = { purgeId: purge.id, state: purge.state, stage: purge.stage,
                generationCount: purge.generation_count, recordCount: purge.record_count,
                processedBytes: purge.processed_bytes, totalBytes: purge.total_bytes,
                retryCount: purge.retry_count }
      result[:outcome] = purge.error_outcome if purge.error_outcome
      result
    end
  end
end
