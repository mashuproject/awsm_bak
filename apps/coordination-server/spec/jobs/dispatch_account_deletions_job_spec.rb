require "rails_helper"
require "active_job/test_helper"

RSpec.describe DispatchAccountDeletionsJob do
  include ActiveJob::TestHelper

  around do |example|
    original = ENV["AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS"]
    ENV["AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS"] = "30"
    example.run
  ensure
    original.nil? ? ENV.delete("AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS") :
      ENV["AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS"] = original
  end

  it "locks, rechecks, freezes, and dispatches only due active Accounts" do
    now = Time.zone.parse("2026-07-27 12:00:00")
    due = create_account(username: "due_account", last_activity_at: now - 31.days)
    current = create_account(username: "current_account", last_activity_at: now - 29.days)
    due.browser_sessions.create!(client_family: "Firefox", last_activity_at: now - 31.days)
    credentials = Coordination::SessionCredentials.issue(account: due, scope: "Account")

    expect {
      described_class.perform_now(at: now)
    }.to have_enqueued_job(DeleteAccountJob)

    expect(due.reload.state).to eq("Deleting")
    expect(due.browser_sessions).to be_empty
    expect(credentials.fetch(:session).reload).to be_revoked
    expect(due.account_deletion_jobs.sole).to have_attributes(
      reason: "Inactivity",
      state: "Pending",
      stage: "Freeze",
      receipt_digest: nil
    )
    expect(current.reload).to be_active
    expect(current.account_deletion_jobs).to be_empty
  end

  it "rechecks the live deadline and does not freeze an Account made current" do
    now = Time.zone.parse("2026-07-27 12:00:00")
    account = create_account(username: "race_account", last_activity_at: now - 31.days)
    account.update!(last_activity_at: now - 1.day)

    described_class.perform_now(at: now)

    expect(account.reload).to be_active
    expect(account.account_deletion_jobs).to be_empty
  end

  it "redrives stranded work and removes expired receipt-only jobs" do
    now = Time.zone.parse("2026-07-27 12:00:00")
    stranded_account = create_account(username: "stranded_account")
    stranded_account.update!(state: "Deleting")
    stranded = stranded_account.account_deletion_jobs.create!(
      reason: "Manual",
      state: "FailedRetryable",
      stage: "DeleteOpaqueBytes",
      receipt_digest: Digest::SHA256.digest("receipt"),
      retry_count: 2
    )
    expired = AccountDeletionJob.create!(
      account: nil,
      reason: "Manual",
      state: "Succeeded",
      stage: "Complete",
      receipt_digest: Digest::SHA256.digest("expired"),
      completed_at: now - 25.hours,
      receipt_expires_at: now - 1.hour
    )

    expect {
      described_class.perform_now(at: now)
    }.to have_enqueued_job(DeleteAccountJob).with(stranded.id)
    expect(AccountDeletionJob.find_by(id: expired.id)).to be_nil
  end

  it "is configured as an hourly production recurring job" do
    recurring = YAML.safe_load(
      Rails.root.join("config/recurring.yml").read,
      permitted_classes: [ Symbol ]
    )

    expect(recurring.dig("production", "dispatch_account_deletions")).to eq(
      "class" => "DispatchAccountDeletionsJob",
      "queue" => "default",
      "schedule" => "every hour"
    )
  end
end
