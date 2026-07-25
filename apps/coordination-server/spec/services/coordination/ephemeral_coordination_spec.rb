require "rails_helper"

RSpec.describe Coordination::EphemeralCoordination do
  around do |example|
    prior_url = ENV["AWSM_REDIS_URL"]
    prior_namespace = ENV["AWSM_REDIS_NAMESPACE"]
    prior_threads = ENV["RAILS_MAX_THREADS"]
    described_class.reset_pool!
    example.run
  ensure
    ENV["AWSM_REDIS_URL"] = prior_url
    ENV["AWSM_REDIS_NAMESPACE"] = prior_namespace
    ENV["RAILS_MAX_THREADS"] = prior_threads
    described_class.reset_pool!
  end

  it "validates the approved URL schemes, namespace, and positive pool size without connecting" do
    ENV["AWSM_REDIS_URL"] = "rediss://example.invalid/0"
    ENV["AWSM_REDIS_NAMESPACE"] = "awsm:coordination:test"
    ENV["RAILS_MAX_THREADS"] = "7"
    expect(Redis).not_to receive(:new)

    expect(described_class.validate_configuration!).to be(true)
    expect(described_class.channel_prefix).to eq("awsm_coordination_test")
  end

  it "rejects invalid configuration while naming only the setting" do
    {
      "AWSM_REDIS_URL" => [ "http://example.invalid", "AWSM_REDIS_URL" ],
      "AWSM_REDIS_NAMESPACE" => [ "invalid namespace", "AWSM_REDIS_NAMESPACE" ],
      "RAILS_MAX_THREADS" => [ "0", "RAILS_MAX_THREADS" ]
    }.each do |setting, (value, message)|
      ENV["AWSM_REDIS_URL"] = "redis://example.invalid/0"
      ENV["AWSM_REDIS_NAMESPACE"] = "awsm:coordination:test"
      ENV["RAILS_MAX_THREADS"] = "5"
      ENV[setting] = value

      expect { described_class.validate_configuration! }
        .to raise_error(ArgumentError, /#{message}/)
    end
  end

  it "creates pooled clients with one-second timeouts and command replay disabled" do
    ENV["AWSM_REDIS_URL"] = "redis://example.invalid/0"
    ENV["RAILS_MAX_THREADS"] = "1"
    client = Object.new
    client.define_singleton_method(:close) { }
    expect(Redis).to receive(:new).with(
      url: "redis://example.invalid/0",
      connect_timeout: 1,
      read_timeout: 1,
      write_timeout: 1,
      reconnect_attempts: 0
    ).and_return(client)

    expect { |block| described_class.with_redis(&block) }.to yield_with_args(client)
  end

  it "derives ticket keys from the namespace and SHA-256 only" do
    ENV["AWSM_REDIS_NAMESPACE"] = "awsm:coordination:test"
    raw_ticket = "A" * 43

    expect(described_class.ticket_key(raw_ticket)).to eq(
      "awsm:coordination:test:cable-ticket:#{Digest::SHA256.hexdigest(raw_ticket)}"
    )
    expect(described_class.ticket_key(raw_ticket)).not_to include(raw_ticket)
  end
end
