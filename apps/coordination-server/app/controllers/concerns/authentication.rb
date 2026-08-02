module Authentication
  extend ActiveSupport::Concern

  BROWSER_SESSION_COOKIE = :browser_session_id
  BROWSER_SESSION_HINT_COOKIE = :awsm_browser_session_hint

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
    BrowserSession.includes(channel_principal: :account)
      .find_by(id: cookies.signed[BROWSER_SESSION_COOKIE]).then do |value|
      value if value&.account&.active?
    end
  end

  def request_authentication
    session[:return_to_after_authenticating] = request.url
    redirect_to new_session_path
  end

  def after_authentication_url
    session.delete(:return_to_after_authenticating) || account_path
  end

  def start_new_session_for(account)
    now = Time.current
    Account.transaction do
      account.lock!
      unless account.active?
        raise Coordination::OutcomeError.new("authentication_required", status: :unauthorized)
      end
      Coordination::AccountActivity.touch!(account:, at: now)
      account.channel_principal.browser_sessions.create!(
        client_family: Coordination::BrowserFamily.classify(request.user_agent),
        last_activity_at: now
      ).tap do |browser_session|
        Current.browser_session = browser_session
        cookies.signed.permanent[BROWSER_SESSION_COOKIE] = {
          value: browser_session.id,
          httponly: true,
          **browser_cookie_options
        }
        cookies.permanent[BROWSER_SESSION_HINT_COOKIE] = {
          value: SecureRandom.urlsafe_base64(32),
          httponly: false,
          **browser_cookie_options
        }
      end
    end
  end

  def terminate_session
    Current.browser_session&.destroy
    Current.browser_session = nil
    clear_browser_session_cookies
  end

  def clear_browser_session_cookies
    cookies.delete(BROWSER_SESSION_COOKIE, **browser_cookie_options)
    cookies.delete(BROWSER_SESSION_HINT_COOKIE, **browser_cookie_options)
  end

  def browser_session_hint_present?
    cookies[BROWSER_SESSION_HINT_COOKIE].present?
  end

  def browser_cookie_options
    {
      path: "/",
      same_site: :lax,
      secure: Rails.env.production?
    }
  end
end
