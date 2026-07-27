module Api
  class ServerInformationsController < ProtocolController
    def show
      render json: {
        service: "AWSM Coordination Server",
        protocolVersion: "1",
        capabilities: {
          accountPassword: true,
          accountVaultLimit: 1,
          completeReplicaSynchronization: true,
          deviceEnrollment: "RecoveryPhrase",
          deviceRevocation: true
        },
        registration: registration,
        accountPolicy: {
          inactiveRetentionDays: Coordination::ServicePolicy.current.inactive_account_retention_days
        }
      }
    end

    private

    def registration
      if Coordination::Registration.enabled?
        { enabled: true, signUpUrl: Coordination::Registration.sign_up_url }
      else
        { enabled: false }
      end
    end
  end
end
