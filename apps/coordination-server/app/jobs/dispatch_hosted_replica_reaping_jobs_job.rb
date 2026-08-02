class DispatchHostedReplicaReapingJobsJob < ApplicationJob
  queue_as :default

  BATCH_SIZE = 100

  def perform
    HostedReplicaReapingJob.where(account_deletion_job_id: nil)
      .where.not(hosted_replica_id: nil)
      .where(state: %w[Pending FailedRetryable])
      .order(:created_at, :id)
      .limit(BATCH_SIZE)
      .pluck(:id)
      .each { |job_id| enqueue(job_id) }
  end

  private

  def enqueue(job_id)
    ReapHostedReplicaJob.perform_later(job_id)
  rescue StandardError
    nil
  end
end
