class PurgeGenerationJob < ApplicationJob
  queue_as :default

  def perform(purge_id)
    purge = PurgeJob.find(purge_id)
    purge.with_lock do
      return if purge.state == "Succeeded"
      purge.update!(state: "Running", stage: "Detach", started_at: purge.started_at || Time.current,
        error_outcome: nil)
    end
    generations = purge.vault_generations.to_a
    record_ids = GenerationMembership.where(vault_generation: generations).distinct.pluck(:opaque_record_id)
    purge.update!(stage: "Analyze")

    records = OpaqueRecord.where(id: record_ids).to_a
    deletable = records.reject { |record| referenced_elsewhere?(record, generations) }
    purge.update!(stage: "DeleteBytes")
    processed = purge.processed_bytes
    deletable.each do |record|
      delete_and_verify!(record)
      processed += record.byte_length
      purge.update!(processed_bytes: processed)
    end

    purge.update!(stage: "Tombstone")
    now = Time.current
    OpaqueRecord.transaction do
      if purge.reason == "VaultReplacement"
        purge_replaced_vault!(purge, generations, deletable, now)
        return
      end
      deletable.each do |record|
        TransferTicket.where(upload: record.upload).delete_all if record.upload
        record.update!(state: "Purged", storage_key: nil, purged_at: now)
        record.upload&.destroy!
      end
      GenerationMembership.where(vault_generation: generations).delete_all
      generations.each do |generation|
        generation.generation_reachability_pages.destroy_all
        generation.update!(state: "Purged", purged_at: now)
      end
      purge.update!(state: "Succeeded", stage: "Complete", completed_at: now,
        processed_bytes: deletable.sum(&:byte_length))
    end
  rescue StandardError
    if (failed = PurgeJob.find_by(id: purge_id))
      failed.update_columns(state: "FailedRetryable", error_outcome: "STORAGE_UNAVAILABLE",
        retry_count: failed.retry_count + 1, updated_at: Time.current)
    end
    raise
  end

  private

  def purge_replaced_vault!(purge, generations, records, now)
    vault = purge.vault_replica
    raise "replacement source became authoritative again" unless vault.state == "Replaced"
    unless records.length == vault.opaque_records.where.not(state: "Purged").count
      raise "replacement source still has externally referenced records"
    end

    record_ids = records.map(&:id)
    TransferTicket.where(vault_replica: vault).delete_all
    DeliveryChange.where(vault_replica: vault).delete_all
    EventCommit.where(vault_replica: vault).delete_all
    RecordDependency.where(event_record_id: record_ids).or(
      RecordDependency.where(dependency_record_id: record_ids)
    ).delete_all
    Upload.where(opaque_record_id: record_ids).destroy_all
    GenerationMembership.where(vault_generation: generations).delete_all
    GenerationReachabilityEntry.where(vault_generation: generations).delete_all
    GenerationReachabilityPage.where(vault_generation: generations).delete_all
    vault.update!(
      active_generation: nil,
      active_generation_number: nil,
      active_key_epoch: nil,
      active_recovery_generation: nil
    )
    purge.purge_job_generations.delete_all
    VaultGeneration.where(id: generations.map(&:id)).update_all(
      predecessor_generation_id: nil,
      generation_record_id: nil,
      updated_at: now
    )
    OpaqueRecord.where(id: record_ids).destroy_all
    generations.each(&:destroy!)
    DeviceKeyEnvelope.where(vault_device: vault.vault_devices).delete_all
    vault.recovery_generations.update_all(
      kit_ciphertext: nil,
      retired_at: now,
      updated_at: now
    )
    vault.vault_key_epochs.where(retired_at: nil).update_all(retired_at: now, updated_at: now)
    purge.update!(
      state: "Succeeded",
      stage: "Complete",
      completed_at: now,
      processed_bytes: records.sum(&:byte_length)
    )
  end

  def referenced_elsewhere?(record, purged_generations)
    record.generation_memberships.where.not(vault_generation: purged_generations).exists? ||
      GenerationReachabilityEntry.where(opaque_record: record)
        .where.not(vault_generation: purged_generations).exists? ||
      VaultGeneration.where(generation_record: record).where.not(id: purged_generations.map(&:id))
        .where.not(state: "Purged").exists?
  end

  def delete_and_verify!(record)
    return unless record.storage_key
    path = Coordination::DiskStore.path(record.storage_key)
    File.delete(path) if File.exist?(path)
    raise "opaque byte deletion could not be verified" if File.exist?(path)
  end
end
