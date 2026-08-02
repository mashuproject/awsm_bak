module Api
  class ServerInformationsController < ProtocolController
    def show
      render json: {
        service: "AWSM Replica Host",
        protocol_version: "1",
        replica_capabilities: ReplicaAccessGrant::CAPABILITIES,
        registration: registration,
        account_policy: {
          inactive_retention_days: Coordination::ServicePolicy.current.inactive_account_retention_days
        }
      }
    end

    private

    def registration
      if Coordination::Registration.enabled?
        { enabled: true, sign_up_url: Coordination::Registration.sign_up_url }
      else
        { enabled: false }
      end
    end
  end
end
