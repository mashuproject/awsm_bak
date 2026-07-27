require "rails_helper"

RSpec.describe "Plan 20 Account deletion", type: :request do
  let(:password) { "correct horse battery staple" }
  let(:account) do
    create_account(
      username: "quiet_vault",
      password:,
      password_confirmation: password
    )
  end

  def sign_in
    post "/session", params: { username: account.username, password: }
    expect(response).to redirect_to("/account")
  end

  it "renders the precise permanent-deletion confirmation without an Export gate" do
    sign_in

    get "/account/deletion/new"

    expect(response).to have_http_status(:ok)
    expect(response.body.squish).to include(
      "Permanently delete this Account",
      "Current password",
      "Type quiet_vault to confirm",
      "There is no recovery period",
      "does not delete data stored in your browser or in Exports"
    )
    expect(response.body).not_to include("Complete Export", "email")
  end

  it "keeps the Account active when password or typed username is invalid" do
    sign_in

    [
      { current_password: "wrong password", username_confirmation: account.username },
      { current_password: password, username_confirmation: "another_username" }
    ].each do |attempt|
      post "/account/deletion", params: { account_deletion: attempt }

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.body).to include("The password or username confirmation is incorrect.")
      expect(account.reload).to be_active
      expect(AccountDeletionJob.where(account:)).to be_empty
    end
  end

  it "atomically freezes the Account, revokes authority, and issues only an opaque receipt" do
    sign_in
    api = Coordination::SessionCredentials.issue(account:, scope: "Account")
    account.browser_sessions.create!(
      client_family: "Chrome",
      last_activity_at: Time.current
    )
    ticket = account.transfer_tickets.create!(
      vault_replica: account.vault_replicas.create!(
        vault_id: SecureRandom.uuid,
        state: "Provisional",
        head_cursor: 0
      ),
      token_sha256: Digest::SHA256.digest("ticket"),
      purpose: "RecoveryDownload",
      expires_at: 10.minutes.from_now
    )

    post "/account/deletion", params: {
      account_deletion: {
        current_password: password,
        username_confirmation: " QUIET_VAULT "
      }
    }

    expect(response).to redirect_to("/account/deletion")
    expect(account.reload.state).to eq("Deleting")
    expect(account.browser_sessions).to be_empty
    expect(api.fetch(:session).reload).to be_revoked
    expect(api.fetch(:session).session_credentials.where(revoked_at: nil)).to be_empty
    expect(ticket.reload.revoked_at).to be_present
    job = AccountDeletionJob.find_by!(account:)
    expect(job).to have_attributes(
      reason: "Manual",
      state: "Pending",
      stage: "Freeze",
      receipt_digest: be_present
    )
    expect(job.receipt_digest.bytesize).to eq(32)
    expect(response.cookies["account_deletion_receipt"]).to be_present
    expect(response.body).not_to include(account.username, account.id, job.id)
  end

  it "authorizes minimal no-store status only with the deletion receipt" do
    sign_in
    post "/account/deletion", params: {
      account_deletion: {
        current_password: password,
        username_confirmation: account.username
      }
    }

    get "/account/deletion", headers: { "Accept" => "application/json" }

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to eq("private, no-store")
    expect(response.parsed_body).to eq(
      "state" => "Pending",
      "stage" => "Freeze",
      "processedBytes" => 0,
      "totalBytes" => 0,
      "retryCount" => 0,
      "outcome" => nil
    )
    expect(response.body).not_to include(account.username, account.id)

    cookies[:account_deletion_receipt] = "invalid"
    get "/account/deletion", headers: { "Accept" => "application/json" }
    expect(response).to have_http_status(:not_found)
  end
end
