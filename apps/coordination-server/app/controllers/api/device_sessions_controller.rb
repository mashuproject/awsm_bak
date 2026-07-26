module Api
  class DeviceSessionsController < BaseController
    skip_before_action :require_vault_device_scope
    before_action :require_account_scope

    def create
      vault = current_account.vault_replicas.find_by!(
        vault_id: params.require(:vaultId),
        state: "Active"
      )
      device = vault.vault_devices.find_by!(
        device_id: params.require(:deviceId)
      )
      Coordination::DeviceSessionChallenges.consume_and_verify!(
        challenge: params.require(:challenge),
        signature: params.require(:signature),
        account_session: current_principal.session,
        account: current_account,
        vault:,
        device:
      )
      issued = Coordination::SessionCredentials.issue(
        account: current_account,
        scope: "VaultDevice",
        vault_device_id: device.device_id
      )
      render json: Coordination::AccountPayload.response(account: current_account, issued:)
    rescue ActionController::ParameterMissing, ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
    end
  end
end
