module Coordination
  class HostedReplicaReaper
    ActiveGrantPresent = Class.new(StandardError)
    DeletionVerificationFailed = Class.new(StandardError)

    class << self
      def perform!(job_id, at: Time.current)
        job, replica_id = begin_reaping!(job_id, at:)
        return job if job.state == "Succeeded"

        prepare_inventory!(job, replica_id)
        delete_opaque_bytes!(job, replica_id)
        delete_policy!(job, replica_id, at:)
      rescue StandardError => error
        mark_retryable!(job_id, error)
        raise
      end

      private

      def begin_reaping!(job_id, at:)
        HostedReplicaReapingJob.transaction do
          job = HostedReplicaReapingJob.lock.find(job_id)
          return [ job, nil ] if job.state == "Succeeded"

          replica = HostedReplica.lock.find(job.hosted_replica_id)
          raise ActiveGrantPresent if replica.replica_access_grants.where(revoked_at: nil).exists?

          replica.update!(state: "Reaping") unless replica.state == "Reaping"
          job.update!(
            state: "Running",
            stage: "DeleteOpaqueBytes",
            started_at: job.started_at || at,
            error_outcome: nil
          )
          [ job, replica.id ]
        end
      end

      def prepare_inventory!(job, replica_id)
        remaining = storage_rows(replica_id).sum { |_record, byte_length| byte_length }
        total = [ job.total_bytes, checked_add(job.processed_bytes, remaining) ].max
        job.update!(total_bytes: total)
      end

      def delete_opaque_bytes!(job, replica_id)
        storage_rows(replica_id).each do |record, byte_length|
          DiskStore.delete(record.storage_key)
          raise DeletionVerificationFailed if DiskStore.exists?(record.storage_key)

          HostedReplicaReapingJob.transaction do
            locked_job = HostedReplicaReapingJob.lock.find(job.id)
            record.destroy! if record.persisted?
            locked_job.update!(
              processed_bytes: [ checked_add(locked_job.processed_bytes, byte_length),
                locked_job.total_bytes ].min
            )
          end
        end
      end

      def storage_rows(replica_id)
        items = OpaqueStorageItem.where(hosted_replica_id: replica_id).order(:storage_key)
          .map { |record| [ record, record.byte_length ] }
        parts = OpaqueUploadPart.joins(:opaque_upload)
          .where(opaque_uploads: { hosted_replica_id: replica_id }).order(:storage_key)
          .map { |record| [ record, record.byte_length ] }
        uploads = OpaqueUpload.where(hosted_replica_id: replica_id).order(:storage_key)
          .map { |record| [ record, record.byte_length ] }
        (items + parts + uploads).sort_by { |record, _byte_length| record.storage_key }
      end

      def delete_policy!(job, replica_id, at:)
        job.update!(stage: "DeletePolicy")
        HostedReplicaReapingJob.transaction do
          locked_job = HostedReplicaReapingJob.lock.find(job.id)
          replica = HostedReplica.lock.find(replica_id)
          raise ActiveGrantPresent if replica.replica_access_grants.where(revoked_at: nil).exists?
          raise DeletionVerificationFailed if storage_rows(replica_id).any?

          replica.destroy!
          locked_job.reload.update!(
            state: "Succeeded",
            stage: "Complete",
            processed_bytes: locked_job.total_bytes,
            error_outcome: nil,
            completed_at: at
          )
          locked_job
        end
      end

      def checked_add(left, right)
        sum = Integer(left) + Integer(right)
        raise RangeError, "reaping byte count overflow" if sum > (2**63 - 1)

        sum
      end

      def mark_retryable!(job_id, error)
        job = HostedReplicaReapingJob.find_by(id: job_id)
        return unless job && job.state != "Succeeded"

        outcome = case error
        when ActiveGrantPresent then "ACTIVE_GRANT_PRESENT"
        when DeletionVerificationFailed then "DELETE_VERIFICATION_FAILED"
        when SystemCallError then "STORAGE_UNAVAILABLE"
        else "INTERNAL_RETRY"
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
