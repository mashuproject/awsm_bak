module Coordination
  class HostedReplicaManagement
    Result = Data.define(:grant, :reaping_job)

    class << self
      def issue_grant!(issuer:, username:, capabilities:, grantable_capabilities:)
        HostedReplica.transaction do
          replica, locked_issuer = lock_management_context!(issuer)
          capabilities = Array(capabilities).uniq.sort
          grantable_capabilities = Array(grantable_capabilities).uniq.sort
          allowed = (capabilities + grantable_capabilities).all? do |capability|
            locked_issuer.grantable_capabilities.include?(capability)
          end
          unless allowed
            raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
          end
          unless grantable_capabilities.empty? || capabilities.include?("awsm.replica.manage")
            raise Coordination::OutcomeError.new("protocol_invalid", status: :bad_request)
          end

          target_principal = ChannelPrincipal.joins(:account).lock.find_by(
            accounts: { username:, state: "Active" },
            state: "Active"
          )
          raise Coordination::OutcomeError.new("access_denied", status: :forbidden) unless target_principal

          ReplicaAccessGrant.create!(
            hosted_replica: replica,
            channel_principal: target_principal,
            capabilities:,
            grantable_capabilities:,
            created_by_grant: locked_issuer
          )
        end
      end

      def revoke_grant!(issuer:, grant_id:, at: Time.current)
        result = HostedReplica.transaction do
          replica, locked_issuer = lock_management_context!(issuer)
          grant = replica.replica_access_grants.lock.find_by(id: grant_id, revoked_at: nil)
          raise replica_not_found unless grant

          grant.update!(revoked_at: at)
          reaping_job = fence_if_orphaned!(replica:, at:)
          Result.new(grant:, reaping_job:)
        end
        dispatch(result.reaping_job)
        result
      end

      def reap!(issuer:, at: Time.current)
        result = HostedReplica.transaction do
          replica, = lock_management_context!(issuer)
          replica.replica_access_grants.where(revoked_at: nil)
            .update_all(revoked_at: at, updated_at: at)
          reaping_job = fence!(replica:, reason: "Manual")
          Result.new(grant: nil, reaping_job:)
        end
        dispatch(result.reaping_job)
        result
      end

      private

      def lock_management_context!(issuer)
        replica = HostedReplica.lock.find_by(id: issuer.hosted_replica_id, state: "Active")
        raise replica_not_found unless replica

        locked_issuer = replica.replica_access_grants.lock.find_by(id: issuer.id, revoked_at: nil)
        unless locked_issuer&.permits?("awsm.replica.manage")
          raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
        end

        [ replica, locked_issuer ]
      end

      def fence_if_orphaned!(replica:, at:)
        return if replica.replica_access_grants.where(revoked_at: nil).exists?

        fence!(replica:, reason: "NoActiveGrants", at:)
      end

      def fence!(replica:, reason:, at: Time.current)
        replica.update!(state: "Reaping", updated_at: at)
        replica.hosted_replica_reaping_jobs.create!(
          reason:,
          state: "Pending",
          stage: "Freeze"
        )
      end

      def dispatch(job)
        ReapHostedReplicaJob.perform_later(job.id) if job
      end

      def replica_not_found
        Coordination::OutcomeError.new("replica_not_found", status: :not_found)
      end
    end
  end
end
