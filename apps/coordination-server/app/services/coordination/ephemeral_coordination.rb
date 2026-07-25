require "connection_pool"
require "digest"
require "redis"

module Coordination
  module EphemeralCoordination
    module_function

    DEFAULT_URL = "redis://127.0.0.1:6379/0"
    DEFAULT_POOL_SIZE = 5
    POOL_TIMEOUT = 1
    NAMESPACE_PATTERN = /\A[a-z0-9][a-z0-9:_-]*\z/
    private_constant :DEFAULT_URL, :DEFAULT_POOL_SIZE, :POOL_TIMEOUT, :NAMESPACE_PATTERN

    class Unavailable < StandardError
      def initialize
        super("ephemeral_coordination_unavailable")
      end
    end
    private_constant :Unavailable

    def validate_configuration!
      configured_url
      namespace
      pool_size
      true
    end

    def url
      configured_url
    end

    def asset_precompilation?
      defined?(Rake) && Rake.application.top_level_tasks.include?("assets:precompile")
    end

    def namespace
      value = ENV.fetch("AWSM_REDIS_NAMESPACE", "awsm:coordination:#{Rails.env}")
      unless value.ascii_only? && value.length.between?(1, 64) && NAMESPACE_PATTERN.match?(value)
        raise ArgumentError, "AWSM_REDIS_NAMESPACE is invalid"
      end

      value
    end

    def channel_prefix
      namespace.tr(":", "_")
    end

    def ticket_key(raw_ticket)
      "#{namespace}:cable-ticket:#{Digest::SHA256.hexdigest(raw_ticket)}"
    end

    def with_redis(&)
      pool.with(&)
    end

    def ping
      with_redis(&:ping)
    end

    def unavailable_error
      Unavailable.new
    end

    def reset_pool!
      raise "test-only Redis pool reset" unless Rails.env.test?

      @pool&.shutdown(&:close)
      @pool = nil
    end

    def pool
      @pool ||= ConnectionPool.new(size: pool_size, timeout: POOL_TIMEOUT) do
        Redis.new(
          url: configured_url,
          connect_timeout: 1,
          read_timeout: 1,
          write_timeout: 1,
          reconnect_attempts: 0
        )
      end
    end
    private_class_method :pool

    def configured_url
      value = if Rails.env.production? && asset_precompilation?
        DEFAULT_URL
      elsif Rails.env.production?
        ENV["AWSM_REDIS_URL"]
      else
        ENV.fetch("AWSM_REDIS_URL", DEFAULT_URL)
      end
      unless value.present? && value.match?(/\Arediss?:\/\//)
        raise ArgumentError, "AWSM_REDIS_URL is invalid"
      end

      value
    end
    private_class_method :configured_url

    def pool_size
      value = Integer(ENV.fetch("RAILS_MAX_THREADS", DEFAULT_POOL_SIZE.to_s), exception: false)
      raise ArgumentError, "RAILS_MAX_THREADS is invalid" unless value&.positive?

      value
    end
    private_class_method :pool_size
  end
end
