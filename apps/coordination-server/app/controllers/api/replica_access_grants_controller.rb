module Api
  class ReplicaAccessGrantsController < BaseController
    def create
      issuer = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.manage")
      grant = Coordination::HostedReplicaManagement.issue_grant!(
        issuer:,
        username: params.require(:username),
        capabilities: params.require(:capabilities),
        grantable_capabilities: params.fetch(:grantable_capabilities)
      )
      render json: serialize(grant), status: :created
    rescue ActionController::ParameterMissing
      raise Coordination::OutcomeError.new("protocol_invalid", status: :bad_request)
    rescue ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("request_conflict", status: :conflict)
    end

    def destroy
      issuer = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.manage")
      Coordination::HostedReplicaManagement.revoke_grant!(issuer:, grant_id: params[:id])
      head :no_content
    end

    private

    def serialize(grant)
      {
        grant_id: grant.id,
        replica_handle: grant.hosted_replica_id,
        username: grant.channel_principal.account.username,
        capabilities: grant.capabilities,
        grantable_capabilities: grant.grantable_capabilities
      }
    end
  end
end
