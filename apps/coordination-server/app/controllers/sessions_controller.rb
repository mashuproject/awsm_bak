class SessionsController < ApplicationController
  allow_unauthenticated_access only: %i[new create show]

  def new
  end

  def create
    account = Coordination::AccountAuthenticator.authenticate_login(
      params.expect(:email),
      params.expect(:password)
    )
    start_new_session_for(account)
    redirect_to after_authentication_url
  rescue Coordination::OutcomeError, ActionController::ParameterMissing
    flash.now[:alert] = "That email or password is incorrect."
    render :new, status: :unprocessable_content
  end

  def show
    response.headers["Cache-Control"] = "private, no-store"

    if resume_session
      render json: {
        authenticated: true,
        account: { email: Current.browser_session.account.email },
        csrfToken: form_authenticity_token
      }
    else
      clear_browser_session_cookies if browser_session_hint_present?
      render json: { authenticated: false }
    end
  end

  def destroy
    terminate_session
    redirect_to new_session_path
  end
end
