module Authentication
  extend ActiveSupport::Concern

  included do
    before_action :require_authentication
    helper_method :authenticated?
  end

  class_methods do
    def allow_unauthenticated_access(**options)
      skip_before_action :require_authentication, **options
    end
  end

  private

  def authenticated?
    resume_session.present?
  end

  def require_authentication
    resume_session || request_authentication
  end

  def resume_session
    Current.browser_session ||= find_browser_session
  end

  def find_browser_session
    BrowserSession.includes(:account).find_by(id: cookies.signed[:browser_session_id])
  end

  def request_authentication
    session[:return_to_after_authenticating] = request.url
    redirect_to new_session_path
  end

  def after_authentication_url
    session.delete(:return_to_after_authenticating) || account_path
  end

  def start_new_session_for(account)
    account.browser_sessions.create!(
      user_agent: request.user_agent,
      ip_address: request.remote_ip
    ).tap do |browser_session|
      Current.browser_session = browser_session
      cookies.signed.permanent[:browser_session_id] = {
        value: browser_session.id,
        httponly: true,
        same_site: :lax,
        secure: Rails.env.production?
      }
    end
  end

  def terminate_session
    Current.browser_session&.destroy
    Current.browser_session = nil
    cookies.delete(:browser_session_id)
  end
end
