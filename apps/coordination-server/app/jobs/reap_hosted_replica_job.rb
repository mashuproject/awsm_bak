class ReapHostedReplicaJob < ApplicationJob
  queue_as :default
  retry_on StandardError, wait: :polynomially_longer, attempts: 10

  def perform(hosted_replica_reaping_job_id)
    Coordination::HostedReplicaReaper.perform!(hosted_replica_reaping_job_id)
  end
end
