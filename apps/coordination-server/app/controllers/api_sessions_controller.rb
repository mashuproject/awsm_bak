class ApiSessionsController < ApplicationController
  def destroy
    api_session = Current.account.channel_principal.api_sessions.find_by(id: params[:id])
    return head :not_found unless api_session

    api_session.revoke!
    redirect_to account_path(anchor: "api-sessions"),
      notice: "The API session was revoked."
  end
end
