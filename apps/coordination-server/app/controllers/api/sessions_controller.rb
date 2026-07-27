module Api
  class SessionsController < ProtocolController
    def create
      account = Coordination::AccountAuthenticator.authenticate_login(
        params.require(:username),
        params.require(:password)
      )
      issued = Coordination::SessionCredentials.issue(account:, scope: "Account")
      Coordination::AccountActivity.touch!(account:)
      render json: Coordination::AccountPayload.response(account:, issued:)
    rescue ActionController::ParameterMissing
      raise Coordination::OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
    end

    def refresh
      issued = Coordination::SessionCredentials.refresh(params.require(:refreshToken))
      account = issued.fetch(:session).account
      Coordination::AccountActivity.touch!(account:)
      render json: Coordination::AccountPayload.response(account:, issued:)
    rescue ActionController::ParameterMissing
      raise Coordination::OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
    end
  end
end
