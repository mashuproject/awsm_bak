class DispatchAccountDeletionsJob < ApplicationJob
  queue_as :default

  BATCH_SIZE = 100

  def perform(at: Time.current)
    cleanup_expired!(at)
    redrive_stranded!
    dispatch_due!(at)
  end

  private

  def cleanup_expired!(at)
    AccountDeletionJob.where(state: "Succeeded")
      .where(receipt_expires_at: ..at)
      .limit(BATCH_SIZE)
      .delete_all
  end

  def redrive_stranded!
    AccountDeletionJob.where(state: %w[Pending FailedRetryable])
      .order(:created_at, :id)
      .limit(BATCH_SIZE)
      .pluck(:id)
      .each { |job_id| enqueue(job_id) }
  end

  def dispatch_due!(at)
    retention = Coordination::ServicePolicy.current.inactive_account_retention_days.days
    Account.where(state: "Active")
      .where(last_activity_at: ..(at - retention))
      .order(:last_activity_at, :id)
      .limit(BATCH_SIZE)
      .pluck(:id)
      .each do |account_id|
        Coordination::AccountDeletion.accept_inactivity!(account_id:, at:)
      end
  end

  def enqueue(job_id)
    DeleteAccountJob.perform_later(job_id)
  rescue StandardError
    nil
  end
end
