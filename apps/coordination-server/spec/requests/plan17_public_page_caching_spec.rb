require "rails_helper"

RSpec.describe "Plan 17 public page caching", type: :request do
  PUBLIC_PATHS = %w[/ /privacy /security /glossary].freeze
  BROWSER_CACHE_POLICY = "public, max-age=300"
  CDN_CACHE_POLICY =
    "public, max-age=86400, stale-while-revalidate=86400, stale-if-error=604800"

  def create_account
    Account.create!(
      email: "reader@example.test",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple"
    )
  end

  def sign_in(account = create_account)
    post "/session", params: { email: account.email, password: "correct horse battery staple" }
    expect(response).to redirect_to("/account")
    account
  end

  def normalized_public_body(body)
    body.gsub(%r{<meta name="csrf-token" content="[^"]+">}, "")
  end

  def set_cookie_headers
    Array(response.headers["Set-Cookie"])
  end

  it "applies the exact shared cache policy only to successful public pages" do
    PUBLIC_PATHS.each do |path|
      get path

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("text/html")
      expect(response.headers["Cache-Control"].split(", ").sort).to eq(
        BROWSER_CACHE_POLICY.split(", ").sort
      )
      expect(response.headers["CDN-Cache-Control"]).to eq(CDN_CACHE_POLICY)
      expect(response.headers["Set-Cookie"]).to be_nil
      expect(response.body).not_to include("csrf-param", "csrf-token", "authenticity_token")
      expect(response.body).to include("http://www.example.com", "Sign in")
    end
  end

  it "applies the same public policy to HEAD and does not vary public pages by query" do
    PUBLIC_PATHS.each do |path|
      head path
      expect(response).to have_http_status(:ok)
      expect(response.headers["Cache-Control"].split(", ").sort).to eq(
        BROWSER_CACHE_POLICY.split(", ").sort
      )
      expect(response.headers["CDN-Cache-Control"]).to eq(CDN_CACHE_POLICY)
      expect(response.headers["Set-Cookie"]).to be_nil
    end

    get "/privacy"
    canonical_body = response.body
    get "/privacy?utm_source=ignored&preview=ignored"
    expect(response.body).to eq(canonical_body)
  end

  it "renders one account-independent representation even with a valid browser session" do
    get "/"
    anonymous_body = normalized_public_body(response.body)

    sign_in
    get "/"
    authenticated_body = normalized_public_body(response.body)

    expect(authenticated_body).to eq(anonymous_body)
    expect(authenticated_body).not_to include(
      "reader@example.test",
      "Sign out",
      "Account for reader@example.test"
    )
  end

  it "uses configured deployment state rather than the request Host" do
    allow(Coordination::Registration).to receive(:public_origin).and_return("https://sync.example.test")
    allow(Coordination::Registration).to receive(:enabled?).and_return(false)

    get "/", headers: { "HOST" => "attacker.example.test" }

    expect(response.body).to include("https://sync.example.test")
    expect(response.body).not_to include("attacker.example.test", 'href="/sign_up"')
    expect(response.body).to include("Account creation is currently closed")
  end

  it "does not apply public caching to dynamic and failed routes" do
    [
      "/design-system",
      "/sign_up",
      "/session/new",
      "/account",
      "/ready",
      "/missing"
    ].each do |path|
      get path

      expect(response.headers["CDN-Cache-Control"]).to be_nil
      expect(response.headers["Cache-Control"]).not_to eq(BROWSER_CACHE_POLICY)
    end
  end

  describe "GET /session/status" do
    it "returns only private unauthenticated state without redirecting" do
      get "/session/status", headers: { "ACCEPT" => "application/json" }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("authenticated" => false)
      expect(response.headers["Cache-Control"]).to eq("private, no-store")
      expect(response.headers["CDN-Cache-Control"]).to be_nil
      expect(response.headers["Location"]).to be_nil
    end

    it "returns only the authenticated presentation state and a usable CSRF token" do
      sign_in

      get "/session/status", headers: { "ACCEPT" => "application/json" }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body.keys).to contain_exactly("authenticated", "account", "csrfToken")
      expect(response.parsed_body).to include(
        "authenticated" => true,
        "account" => { "email" => "reader@example.test" }
      )
      expect(response.parsed_body.fetch("csrfToken")).to be_present
      expect(response.body).not_to include(
        "accountId",
        "browserSession",
        "vault",
        "device",
        "synchronization"
      )
      expect(response.headers["Cache-Control"]).to eq("private, no-store")
      expect(response.headers["CDN-Cache-Control"]).to be_nil

      delete "/session", params: {
        authenticity_token: response.parsed_body.fetch("csrfToken")
      }
      expect(response).to redirect_to("/session/new")
    end

    it "treats forged browser and hint cookies as unauthenticated and expires the hint" do
      cookies[:browser_session_id] = "forged"
      cookies[:awsm_browser_session_hint] = "forged-hint"

      get "/session/status", headers: { "ACCEPT" => "application/json" }

      expect(response.parsed_body).to eq("authenticated" => false)
      expect(set_cookie_headers).to include(
        a_string_starting_with("awsm_browser_session_hint=").and(
          including("expires=Thu, 01 Jan 1970")
        )
      )
    end
  end

  describe "browser session hint" do
    it "sets a persistent readable random hint on signup and sign-in" do
      post "/sign_up", params: {
        account: {
          email: "reader@example.test",
          password: "correct horse battery staple",
          password_confirmation: "correct horse battery staple"
        }
      }

      signup_hint = response.cookies.fetch("awsm_browser_session_hint")
      expect(signup_hint).to be_present
      expect(set_cookie_headers).to include(
        a_string_starting_with("browser_session_id=").and(including("httponly")),
        a_string_starting_with("awsm_browser_session_hint=").and(
          including("path=/", "samesite=lax", "expires=")
        )
      )
      hint_cookie = set_cookie_headers.find {
        |value| value.start_with?("awsm_browser_session_hint=")
      }
      expect(hint_cookie).not_to include("httponly", "secure")

      delete "/session"
      post "/session", params: {
        email: "reader@example.test",
        password: "correct horse battery staple"
      }

      expect(response.cookies.fetch("awsm_browser_session_hint")).not_to eq(signup_hint)
    end

    it "marks both browser cookies secure in production" do
      allow(Rails.env).to receive(:production?).and_return(true)

      post "/session", params: {
        email: create_account.email,
        password: "correct horse battery staple"
      }, headers: { "HTTPS" => "on" }

      expect(set_cookie_headers).to include(
        a_string_starting_with("browser_session_id=").and(including("secure")),
        a_string_starting_with("awsm_browser_session_hint=").and(including("secure"))
      )
    end

    it "expires the authoritative cookie and hint on logout and password change" do
      account = sign_in

      delete "/session"
      expect(set_cookie_headers).to include(
        a_string_starting_with("browser_session_id=").and(including("expires=Thu, 01 Jan 1970")),
        a_string_starting_with("awsm_browser_session_hint=").and(
          including("expires=Thu, 01 Jan 1970")
        )
      )

      post "/session", params: {
        email: account.email,
        password: "correct horse battery staple"
      }
      patch "/account/password", params: {
        account: {
          current_password: "correct horse battery staple",
          password: "new correct horse battery staple",
          password_confirmation: "new correct horse battery staple"
        }
      }

      expect(set_cookie_headers).to include(
        a_string_starting_with("browser_session_id=").and(including("expires=Thu, 01 Jan 1970")),
        a_string_starting_with("awsm_browser_session_hint=").and(
          including("expires=Thu, 01 Jan 1970")
        )
      )
    end
  end
end
