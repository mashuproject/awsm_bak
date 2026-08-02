require "digest"
require "securerandom"

module Coordination
  class AccountDeletion
    InvalidConfirmation = Class.new(StandardError)

    class << self
      def accept_manual!(account:, password:, username_confirmation:, at: Time.current)
        receipt = SecureRandom.urlsafe_base64(32, padding: false)
        job = Account.transaction do
          account = Account.lock.find(account.id)
          validate_manual_confirmation!(account:, password:, username_confirmation:)
          freeze_account!(
            account:,
            reason: "Manual",
            receipt_digest: Digest::SHA256.digest(receipt),
            at:
          )
        end

        enqueue_safely(job)
        [ job, receipt ]
      end

      def accept_inactivity!(account_id:, at: Time.current)
        job = Account.transaction do
          account = Account.lock("FOR UPDATE SKIP LOCKED").find_by(id: account_id)
          next unless account&.active?

          retention = Coordination::ServicePolicy.current.inactive_account_retention_days.days
          next if account.last_activity_at + retention > at

          freeze_account!(account:, reason: "Inactivity", receipt_digest: nil, at:)
        end
        enqueue_safely(job) if job
        job
      end

      def find_by_receipt(receipt)
        value = receipt.to_s
        return if value.empty?

        digest = Digest::SHA256.digest(value)
        job = AccountDeletionJob.find_by(receipt_digest: digest)
        return unless job&.receipt_digest
        return unless ActiveSupport::SecurityUtils.secure_compare(job.receipt_digest, digest)
        return if job.receipt_expires_at&.past?

        job
      end

      private

      def freeze_account!(account:, reason:, receipt_digest:, at:)
        job = account.account_deletion_jobs.create!(
          reason:,
          state: "Pending",
          stage: "Freeze",
          receipt_digest:
        )
        principal = account.channel_principal.lock!
        replica_ids = principal.replica_access_grants.where(revoked_at: nil)
          .distinct.pluck(:hosted_replica_id)

        account.update!(state: "Deleting")
        principal.update!(state: "Revoked")
        principal.browser_sessions.delete_all
        principal.api_sessions.find_each { |session| session.revoke!(at:) }
        principal.replica_access_grants.where(revoked_at: nil)
          .update_all(revoked_at: at, updated_at: at)
        schedule_orphan_reaping!(job:, replica_ids:)
        job
      end

      def schedule_orphan_reaping!(job:, replica_ids:)
        replica_ids.each do |replica_id|
          replica = HostedReplica.lock.find(replica_id)
          next if replica.replica_access_grants.where(revoked_at: nil).exists?

          replica.update!(state: "Reaping")
          replica.hosted_replica_reaping_jobs.create!(
            account_deletion_job: job,
            reason: "AccountDeletion",
            state: "Pending",
            stage: "Freeze"
          )
        end
      end

      def enqueue_safely(job)
        DeleteAccountJob.perform_later(job.id)
      rescue StandardError
        nil
      end

      def validate_manual_confirmation!(account:, password:, username_confirmation:)
        normalized = Account.normalize_value_for(:username, username_confirmation)
        valid = account.active? &&
          account.authenticate(password) &&
          ActiveSupport::SecurityUtils.secure_compare(account.username, normalized)
        raise InvalidConfirmation unless valid
      end
    end
  end
end
