module Api
  class HostedReplicasController < BaseController
    def index
      grants = current_principal.channel_principal.replica_access_grants
        .includes(:hosted_replica)
        .where(revoked_at: nil, hosted_replicas: { state: "Active" })
        .order(:hosted_replica_id)
      render json: { replicas: grants.map { |grant| summary(grant) } }
    end

    def create
      grant = HostedReplica.transaction do
        replica = HostedReplica.create!
        ReplicaAccessGrant.create!(
          hosted_replica: replica,
          channel_principal: current_principal.channel_principal,
          capabilities: ReplicaAccessGrant::CAPABILITIES,
          grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
        )
      end
      render json: summary(grant), status: :created
    end

    def destroy
      issuer = current_replica_grant!(params[:id], "awsm.replica.manage")
      result = Coordination::HostedReplicaManagement.reap!(issuer:)
      render json: {
        replica_handle: params[:id],
        state: "reaping",
        reaping_job_id: result.reaping_job.id
      }, status: :accepted
    end

    private

    def summary(grant)
      replica = grant.hosted_replica
      {
        replica_handle: replica.id,
        capabilities: grant.capabilities,
        quota_bytes: replica.quota_bytes,
        stored_bytes: replica.stored_bytes
      }
    end
  end
end
