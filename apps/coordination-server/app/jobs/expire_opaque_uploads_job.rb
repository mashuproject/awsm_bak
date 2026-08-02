class ExpireOpaqueUploadsJob < ApplicationJob
  queue_as :default
  retry_on StandardError, wait: :polynomially_longer, attempts: 10

  BATCH_SIZE = 100

  def perform(at: Time.current)
    OpaqueUpload.where(expires_at: ..at)
      .order(:expires_at, :id)
      .limit(BATCH_SIZE)
      .pluck(:id)
      .each { |upload_id| Coordination::ExpiredUploadCleanup.perform!(upload_id, at:) }
  end
end
