require "rails_helper"

RSpec.describe "Plan 20 username authentication", type: :request do
  let(:password) { "correct horse battery staple" }

  def create_account(username: "quiet_vault", state: "Active")
    Account.create!(
      username:,
      password:,
      password_confirmation: password,
      state:,
      last_activity_at: Time.current
    )
  end

  it "renders username-only signup and sign-in forms with permanent privacy guidance" do
    get "/sign_up"

    expect(response).to have_http_status(:ok)
    document = Nokogiri::HTML(response.body)
    username = document.at_css('input[name="account[username]"]')
    expect(username&.[]("autocomplete")).to eq("username")
    expect(document.css('input[type="email"]')).to be_empty
    expect(response.body).to include(
      "Choose a private username that does not identify you.",
      "Your username cannot be changed.",
      "does not collect an email address",
      "cannot reset this Account password"
    )

    get "/session/new"

    expect(response).to have_http_status(:ok)
    document = Nokogiri::HTML(response.body)
    username = document.at_css('input[name="username"]')
    expect(username&.[]("autocomplete")).to eq("username")
    expect(document.css('input[type="email"]')).to be_empty
  end

  it "creates a normalized Account and coarse browser session without accepting email identity" do
    post "/sign_up",
      params: {
        account: {
          username: "  Quiet_Vault  ",
          email: "must-not-be-stored@example.test",
          password:,
          password_confirmation: password
        }
      },
      headers: {
        "User-Agent" =>
          "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
      }

    expect(response).to redirect_to("/account")
    account = Account.find_by!(username: "quiet_vault")
    expect(account.last_activity_at).to be_within(5.seconds).of(Time.current)
    expect(account.browser_sessions.sole).to have_attributes(
      client_family: "Firefox",
      last_activity_at: be_within(5.seconds).of(Time.current)
    )
    expect(Account.column_names).not_to include("email")
  end

  it "uses one generic outcome for unknown, wrong-password, and Deleting Accounts" do
    active = create_account
    create_account(username: "pending_deletion", state: "Deleting")

    attempts = [
      { username: "unknown_account", password: },
      { username: active.username, password: "wrong password" },
      { username: "pending_deletion", password: }
    ]

    attempts.each do |attempt|
      post "/session", params: attempt

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.body).to include("That username or password is incorrect.")
    end
  end

  it "returns only the private username in authenticated public session status" do
    create_account
    post "/session", params: { username: " QUIET_VAULT ", password: }

    get "/session/status", headers: { "Accept" => "application/json" }

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include(
      "authenticated" => true,
      "account" => { "username" => "quiet_vault" }
    )
    expect(response.body).not_to include("email", "accountId")
  end

  it "filters usernames and credentials from Rails parameter inspection" do
    filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)

    expect(
      filter.filter(
        "username" => "quiet_vault",
        "password" => password,
        "deletion_receipt" => "receipt"
      )
    ).to eq(
      "username" => "[FILTERED]",
      "password" => "[FILTERED]",
      "deletion_receipt" => "[FILTERED]"
    )
  end
end
