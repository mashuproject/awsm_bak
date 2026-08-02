require "rails_helper"

RSpec.describe "canonical Account deletion", type: :request do
  let(:password) { "correct horse battery staple" }
  let(:account) do
    create_account(
      username: "quiet_replica",
      password:,
      password_confirmation: password
    )
  end

  def sign_in
    post "/session", params: { username: account.username, password: }
    expect(response).to redirect_to("/account")
  end

  it "explains Host-local deletion without claiming to delete the Vault elsewhere" do
    sign_in

    get "/account/deletion/new"

    expect(response).to have_http_status(:ok)
    expect(response.body.squish).to include(
      "Permanently delete this Account",
      "Current password",
      "Type quiet_replica to confirm",
      "There is no recovery period",
      "Copies stored elsewhere are unaffected"
    )
    expect(response.body).not_to include("Device", "Recovery Kit", "email")
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

  it "atomically revokes the Channel Principal, sessions, and Grants and schedules orphan reaping" do
    replica = HostedReplica.create!(management_label: "Delete with Account")
    access_grant = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )
    api = Coordination::SessionCredentials.issue(account:)
    sign_in

    post "/account/deletion", params: {
      account_deletion: {
        current_password: password,
        username_confirmation: " QUIET_REPLICA "
      }
    }

    expect(response).to redirect_to("/account/deletion")
    expect(account.reload.state).to eq("Deleting")
    expect(account.channel_principal.reload.state).to eq("Revoked")
    expect(account.channel_principal.browser_sessions).to be_empty
    expect(api.fetch(:session).reload).to be_revoked
    expect(access_grant.reload.revoked_at).to be_present
    expect(replica.reload.state).to eq("Reaping")
    expect(replica.hosted_replica_reaping_jobs.sole).to have_attributes(
      reason: "AccountDeletion",
      state: "Pending",
      stage: "Freeze"
    )
    expect(AccountDeletionJob.find_by!(account:)).to have_attributes(
      reason: "Manual",
      state: "Pending",
      stage: "Freeze",
      receipt_digest: be_present
    )
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
