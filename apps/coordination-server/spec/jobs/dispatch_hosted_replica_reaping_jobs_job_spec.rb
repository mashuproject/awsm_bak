require "rails_helper"
require "active_job/test_helper"

RSpec.describe DispatchHostedReplicaReapingJobsJob do
  include ActiveJob::TestHelper

  it "redrives only standalone pending or retryable Hosted Replica reaping" do
    pending = create_reaping_job(state: "Pending")
    failed = create_reaping_job(state: "FailedRetryable")
    create_reaping_job(state: "Running")
    linked = create_reaping_job(state: "Pending", account_deletion_job: create_account_deletion_job)

    expect {
      described_class.perform_now
    }.to have_enqueued_job(ReapHostedReplicaJob).exactly(2).times

    expect(enqueued_jobs.filter_map { |entry|
      entry.fetch(:args).first if entry.fetch(:job) == ReapHostedReplicaJob
    }).to contain_exactly(pending.id, failed.id)
    expect(enqueued_jobs.map { |entry| entry.fetch(:args).first }).not_to include(linked.id)
  end

  it "is configured as an hourly production recurring job" do
    recurring = YAML.safe_load(
      Rails.root.join("config/recurring.yml").read,
      permitted_classes: [ Symbol ]
    )

    expect(recurring.dig("production", "dispatch_hosted_replica_reaping_jobs")).to eq(
      "class" => "DispatchHostedReplicaReapingJobsJob",
      "queue" => "default",
      "schedule" => "every hour at minute 10"
    )
  end

  private

  def create_reaping_job(state:, account_deletion_job: nil)
    replica = HostedReplica.create!(state: "Reaping")
    replica.hosted_replica_reaping_jobs.create!(
      account_deletion_job:,
      reason: account_deletion_job ? "AccountDeletion" : "Manual",
      state:,
      stage: state == "Pending" ? "Freeze" : "DeleteOpaqueBytes"
    )
  end

  def create_account_deletion_job
    create_account(username: "linked_deletion").account_deletion_jobs.create!(
      reason: "Manual",
      state: "Pending",
      stage: "ReapReplicas"
    )
  end
end
