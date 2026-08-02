module Coordination
  class AccountDeletionWorker
    class << self
      def perform!(job_id, at: Time.current)
        job = begin_deletion!(job_id, at:)
        return job if job.state == "Succeeded"

        reap_orphan_replicas!(job, at:)
        delete_identity!(job, at:)
      rescue StandardError => error
        mark_retryable!(job_id, error)
        raise
      end

      private

      def begin_deletion!(job_id, at:)
        AccountDeletionJob.transaction do
          job = AccountDeletionJob.lock.find(job_id)
          return job if job.state == "Succeeded"

          account = Account.lock.find(job.account_id)
          principal = account.channel_principal.lock!
          raise "Account deletion fence is absent" unless account.state == "Deleting"
          raise "Channel Principal deletion fence is absent" unless principal.state == "Revoked"
          if principal.replica_access_grants.where(revoked_at: nil).exists?
            raise "Account deletion retains an active Replica Access Grant"
          end

          job.update!(
            state: "Running",
            stage: "ReapReplicas",
            started_at: job.started_at || at,
            error_outcome: nil
          )
          job
        end
      end

      def reap_orphan_replicas!(job, at:)
        job.hosted_replica_reaping_jobs.order(:created_at, :id).find_each do |reaping_job|
          next if reaping_job.state == "Succeeded"

          HostedReplicaReaper.perform!(reaping_job.id, at:)
        end
        jobs = job.hosted_replica_reaping_jobs.reload
        job.update!(
          total_bytes: jobs.sum(&:total_bytes),
          processed_bytes: jobs.sum(&:processed_bytes)
        )
      end

      def delete_identity!(job, at:)
        job.update!(stage: "DeleteIdentity")
        AccountDeletionJob.transaction do
          locked_job = AccountDeletionJob.lock.find(job.id)
          account = Account.lock.find(locked_job.account_id)
          raise "Account deletion fence is absent" unless account.state == "Deleting"
          if locked_job.hosted_replica_reaping_jobs.where.not(state: "Succeeded").exists?
            raise "Hosted Replica reaping is incomplete"
          end

          account.destroy!
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

      def mark_retryable!(job_id, error)
        job = AccountDeletionJob.find_by(id: job_id)
        return unless job && job.state != "Succeeded"

        outcome = error.is_a?(SystemCallError) ? "STORAGE_UNAVAILABLE" : "INTERNAL_RETRY"
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
