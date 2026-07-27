module Coordination
  class AccountDeletionWorker
    BATCH_SIZE = 100
    DeletionVerificationFailed = Class.new(StandardError)

    class << self
      def perform!(job_id, at: Time.current)
        job = begin_deletion!(job_id)
        return job if job.state == "Succeeded"

        account_id = job.account_id
        prepare_inventory!(job, account_id)
        delete_opaque_bytes!(job, account_id)
        delete_relational_state!(job, account_id, at:)
      rescue StandardError => error
        mark_retryable!(job_id, error)
        raise
      end

      private

      def begin_deletion!(job_id)
        AccountDeletionJob.transaction do
          job = AccountDeletionJob.lock.find(job_id)
          return job if job.state == "Succeeded"

          account = Account.lock.find(job.account_id)
          raise "Account deletion fence is absent" unless account.state == "Deleting"

          job.update!(
            state: "Running",
            stage: job.stage == "Freeze" ? "DeleteOpaqueBytes" : job.stage,
            started_at: job.started_at || Time.current,
            error_outcome: nil
          )
          job
        end
      end

      def prepare_inventory!(job, account_id)
        remaining = inventory_bytes(account_id)
        total = [ job.total_bytes, checked_add(job.processed_bytes, remaining) ].max
        job.update!(total_bytes: total)
      end

      def inventory_bytes(account_id)
        total = 0
        each_owned_storage_key(account_id) do |key|
          total = checked_add(total, owned_byte_length(account_id, key))
        end
        total
      end

      def delete_opaque_bytes!(job, account_id)
        each_owned_storage_key(account_id) do |key|
          reject_cross_account_key!(account_id, key)
          DiskStore.delete(key)
          raise DeletionVerificationFailed if DiskStore.exists?(key)

          AccountDeletionJob.transaction do
            locked_job = AccountDeletionJob.lock.find(job.id)
            bytes = owned_byte_length(account_id, key)
            owned_records(account_id).where(storage_key: key).update_all(
              storage_key: nil,
              updated_at: Time.current
            )
            owned_parts(account_id).where(storage_key: key).update_all(
              storage_key: nil,
              updated_at: Time.current
            )
            locked_job.update!(
              processed_bytes: [ checked_add(locked_job.processed_bytes, bytes),
                locked_job.total_bytes ].min
            )
          end
        end

        if owned_records(account_id).where.not(storage_key: nil).exists? ||
            owned_parts(account_id).where.not(storage_key: nil).exists?
          raise DeletionVerificationFailed
        end
      end

      def each_owned_storage_key(account_id)
        cursor = nil
        loop do
          record_keys = next_keys(owned_records(account_id), cursor)
          part_keys = next_keys(owned_parts(account_id), cursor)
          keys = (record_keys + part_keys).uniq.sort.first(BATCH_SIZE)
          break if keys.empty?

          keys.each { |key| yield key }
          cursor = keys.last
        end
      end

      def next_keys(relation, cursor)
        storage_key = relation.klass.arel_table[:storage_key]
        scoped = relation.where.not(storage_key: nil)
        scoped = scoped.where(storage_key.gt(cursor)) if cursor
        scoped.distinct.order(storage_key).limit(BATCH_SIZE).pluck(storage_key)
      end

      def owned_records(account_id)
        OpaqueRecord.joins(:vault_replica).where(vault_replicas: { account_id: })
      end

      def owned_parts(account_id)
        UploadPart.joins(upload: { opaque_record: :vault_replica })
          .where(vault_replicas: { account_id: })
      end

      def owned_byte_length(account_id, key)
        [
          owned_records(account_id).where(storage_key: key).maximum(:byte_length).to_i,
          owned_parts(account_id).where(storage_key: key).maximum(:byte_length).to_i
        ].max
      end

      def reject_cross_account_key!(account_id, key)
        foreign_record = OpaqueRecord.joins(:vault_replica)
          .where(storage_key: key).where.not(vault_replicas: { account_id: }).exists?
        foreign_part = UploadPart.joins(upload: { opaque_record: :vault_replica })
          .where(storage_key: key).where.not(vault_replicas: { account_id: }).exists?
        raise DeletionVerificationFailed if foreign_record || foreign_part
      end

      def delete_relational_state!(job, account_id, at:)
        job.update!(stage: "DeleteRelationalState")
        AccountDeletionJob.transaction do
          locked_job = AccountDeletionJob.lock.find(job.id)
          account = Account.lock.find(account_id)
          raise "Account deletion fence is absent" unless account.state == "Deleting"

          vault_ids = VaultReplica.where(account_id:).pluck(:id)
          generation_ids = VaultGeneration.where(vault_replica_id: vault_ids).pluck(:id)
          record_ids = OpaqueRecord.where(vault_replica_id: vault_ids).pluck(:id)
          upload_ids = Upload.where(opaque_record_id: record_ids).pluck(:id)
          purge_ids = PurgeJob.where(vault_replica_id: vault_ids).pluck(:id)
          device_ids = VaultDevice.where(vault_replica_id: vault_ids).pluck(:device_id)
          api_session_ids = ApiSession.where(account_id:).pluck(:id)

          GenerationReachabilityEntry.where(vault_generation_id: generation_ids).delete_all
          GenerationReachabilityPage.where(vault_generation_id: generation_ids).delete_all
          GenerationMembership.where(vault_generation_id: generation_ids).delete_all
          RecordDependency.where(event_record_id: record_ids)
            .or(RecordDependency.where(dependency_record_id: record_ids)).delete_all
          DeliveryChange.where(vault_replica_id: vault_ids).delete_all
          EventCommit.where(vault_replica_id: vault_ids).delete_all
          PurgeJobGeneration.where(purge_job_id: purge_ids).delete_all
          PurgeJob.where(id: purge_ids).delete_all
          TransferTicket.where(account_id:).delete_all
          UploadPart.where(upload_id: upload_ids).delete_all
          Upload.where(id: upload_ids).delete_all
          ::DeviceKeyEnvelope.where(vault_device_id: device_ids).delete_all
          SessionCredential.where(api_session_id: api_session_ids).delete_all
          ApiSession.where(id: api_session_ids).delete_all
          IdempotencyRecord.where(account_id:).delete_all

          VaultReplica.where(id: vault_ids).update_all(
            active_generation_id: nil,
            active_generation_number: nil,
            active_key_epoch_id: nil,
            active_recovery_generation_id: nil,
            updated_at: at
          )
          VaultGeneration.where(id: generation_ids).update_all(
            predecessor_generation_id: nil,
            generation_record_id: nil,
            updated_at: at
          )
          OpaqueRecord.where(id: record_ids).delete_all
          VaultDevice.where(device_id: device_ids).delete_all
          VaultKeyEpoch.where(vault_replica_id: vault_ids).delete_all
          RecoveryGeneration.where(vault_replica_id: vault_ids).delete_all
          VaultGeneration.where(id: generation_ids).delete_all
          VaultReplica.where(id: vault_ids).delete_all
          BrowserSession.where(account_id:).delete_all
          Account.where(id: account_id).delete_all

          locked_job.reload.update!(
            account_id: nil,
            state: "Succeeded",
            stage: "Complete",
            error_outcome: nil,
            completed_at: at,
            receipt_expires_at: at + 24.hours,
            processed_bytes: locked_job.total_bytes
          )
          locked_job
        end
      end

      def checked_add(left, right)
        sum = Integer(left) + Integer(right)
        raise RangeError, "deletion byte count overflow" if sum > (2**63 - 1)

        sum
      end

      def mark_retryable!(job_id, error)
        job = AccountDeletionJob.find_by(id: job_id)
        return unless job && job.state != "Succeeded"

        outcome = if error.is_a?(DeletionVerificationFailed)
          "DELETE_VERIFICATION_FAILED"
        elsif error.is_a?(SystemCallError)
          "STORAGE_UNAVAILABLE"
        else
          "INTERNAL_RETRY"
        end
        job.update_columns(
          state: "FailedRetryable",
          error_outcome: outcome,
          retry_count: job.retry_count + 1,
          updated_at: Time.current
        )
      end
    end
  end
end
