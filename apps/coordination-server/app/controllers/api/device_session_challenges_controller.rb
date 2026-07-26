module Api
  class DeviceSessionChallengesController < BaseController
    skip_before_action :require_vault_device_scope
    before_action :require_account_scope

    def create
      vault = current_account.vault_replicas.find_by!(
        vault_id: params.require(:vaultId),
        state: "Active"
      )
      device = vault.vault_devices.find_by!(
        device_id: params.require(:deviceId),
        revoked_at: nil
      )
      issued = Coordination::DeviceSessionChallenges.issue!(
        account_session: current_principal.session,
        account: current_account,
        vault:,
        device:
      )
      render json: {
        challenge: issued.fetch(:challenge),
        expiresAt: Coordination::ProtocolEncoding.timestamp(issued.fetch(:expires_at))
      }, status: :created
    rescue ActionController::ParameterMissing, ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
    end
  end
end
