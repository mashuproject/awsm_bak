class DeleteAccountJob < ApplicationJob
  queue_as :default
  retry_on StandardError, wait: :polynomially_longer, attempts: 10

  def perform(account_deletion_job_id)
    Coordination::AccountDeletionWorker.perform!(account_deletion_job_id)
  end
end
