require "rails_helper"
require "redis"

RSpec.describe Coordination::CableTickets do
  let(:account) { create_account }
  let(:namespace) { "awsm:coordination:test:#{SecureRandom.hex(8)}" }
  let(:redis) do
    Redis.new(
      url: Coordination::EphemeralCoordination.url,
      connect_timeout: 1,
      read_timeout: 1,
      write_timeout: 1,
      reconnect_attempts: 0
    )
  end

  around do |example|
    prior_namespace = ENV["AWSM_REDIS_NAMESPACE"]
    ENV["AWSM_REDIS_NAMESPACE"] = namespace
    example.run
  ensure
    redis.scan_each(match: "#{namespace}:*").each { |key| redis.del(key) }
    redis.close
    ENV["AWSM_REDIS_NAMESPACE"] = prior_namespace
  end

  def expect_authentication_failed(raw_ticket)
    expect { described_class.consume(raw_ticket) }
      .to raise_error(Coordination::OutcomeError) do |error|
        expect(error.outcome).to eq("AUTHENTICATION_FAILED")
        expect(error.status).to eq(:unauthorized)
        expect(error.retryable).to be(false)
      end
  end

  it "stores only a TTL-bound digest key and Account UUID for a 256-bit opaque ticket" do
    raw_ticket, expires_at = described_class.issue(account)

    expect(raw_ticket).to match(/\A[A-Za-z0-9_-]{43}\z/)
    expect(Coordination::ProtocolEncoding.decode_base64url(raw_ticket, bytes: 32).bytesize).to eq(32)
    expect(expires_at).to be_between(Time.current, 60.seconds.from_now)

    keys = redis.scan_each(match: "#{namespace}:*").to_a
    expect(keys).to contain_exactly(Coordination::EphemeralCoordination.ticket_key(raw_ticket))
    expect(keys.first).not_to include(raw_ticket)
    expect(redis.get(keys.first)).to eq(account.id)
    expect(redis.get(keys.first)).not_to include(raw_ticket)
    expect(redis.ttl(keys.first)).to be_between(1, 60)
  end

  it "atomically consumes a valid ticket exactly once" do
    raw_ticket, = described_class.issue(account)

    expect(described_class.consume(raw_ticket)).to eq(account)
    expect(redis.exists?(Coordination::EphemeralCoordination.ticket_key(raw_ticket))).to be(false)
    expect_authentication_failed(raw_ticket)
  end

  it "keeps tickets bound to their issuing Accounts" do
    another_account = create_account(email: "another-#{SecureRandom.hex(4)}@example.test")
    first_ticket, = described_class.issue(account)
    second_ticket, = described_class.issue(another_account)

    expect(described_class.consume(first_ticket)).to eq(account)
    expect(described_class.consume(second_ticket)).to eq(another_account)
  end

  it "rejects malformed, expired, and deleted-Account tickets identically" do
    before_keys = redis.scan_each(match: "#{namespace}:*").to_a
    [ "", "a" * 42, "a" * 44, "+" * 43, "_" * 43 ].each do |candidate|
      expect_authentication_failed(candidate)
    end
    expect(redis.scan_each(match: "#{namespace}:*").to_a).to eq(before_keys)

    expired, = described_class.issue(account)
    redis.expire(Coordination::EphemeralCoordination.ticket_key(expired), 0)
    expect_authentication_failed(expired)

    deleted_account_ticket, = described_class.issue(account)
    account.destroy!
    expect_authentication_failed(deleted_account_ticket)
    expect(redis.exists?(
      Coordination::EphemeralCoordination.ticket_key(deleted_account_ticket)
    )).to be(false)

    invalid_value_ticket = Coordination::ProtocolEncoding.encode_base64url("z" * 32)
    invalid_value_key = Coordination::EphemeralCoordination.ticket_key(invalid_value_ticket)
    redis.set(invalid_value_key, account.id.upcase, ex: 60)
    expect_authentication_failed(invalid_value_ticket)
    expect(redis.exists?(invalid_value_key)).to be(false)
  end

  it "allows exactly one concurrent Redis consumer to receive the stored Account UUID" do
    raw_ticket, = described_class.issue(account)
    key = Coordination::EphemeralCoordination.ticket_key(raw_ticket)
    clients = 2.times.map do
      Redis.new(url: Coordination::EphemeralCoordination.url, reconnect_attempts: 0)
    end
    gate = Queue.new
    results = clients.map do |client|
      Thread.new do
        gate.pop
        client.getdel(key)
      end
    end
    2.times { gate << true }

    expect(results.map(&:value)).to contain_exactly(account.id, nil)
  ensure
    clients&.each(&:close)
  end

  it "maps Redis command failure to a retryable authentication outage without credential context" do
    raw_ticket = "A" * 43
    reporter = instance_double(ActiveSupport::ErrorReporter)
    allow(Rails).to receive(:error).and_return(reporter)
    expect(reporter).to receive(:report) do |error, handled:, context:|
      expect(error.message).to eq("ephemeral_coordination_unavailable")
      expect(handled).to be(true)
      expect(context).to eq(component: "ephemeral_coordination", operation: "consume")
      expect([ error, context ].inspect).not_to include(raw_ticket, "credential-sentinel")
    end
    allow(Coordination::EphemeralCoordination).to receive(:with_redis)
      .and_raise(Redis::CannotConnectError, "credential-sentinel")

    expect { described_class.consume(raw_ticket) }
      .to raise_error(Coordination::OutcomeError) do |error|
        expect(error.outcome).to eq("AUTHENTICATION_UNAVAILABLE")
        expect(error.status).to eq(:service_unavailable)
        expect(error.retryable).to be(true)
      end
  end

  it "retries collisions three times then reports a credential-free outage" do
    issuing_account = account
    allow(SecureRandom).to receive(:random_bytes).with(32)
      .and_return("a" * 32, "b" * 32, "c" * 32)
    client = instance_double(Redis, set: false)
    allow(Coordination::EphemeralCoordination).to receive(:with_redis).and_yield(client)
    reporter = instance_double(ActiveSupport::ErrorReporter)
    allow(Rails).to receive(:error).and_return(reporter)
    expect(reporter).to receive(:report) do |error, handled:, context:|
      expect(error.message).to eq("ticket_collision_budget_exhausted")
      expect(handled).to be(true)
      expect(context).to eq(component: "ephemeral_coordination", operation: "issue")
      expect(context.inspect).not_to match(/[A-Za-z0-9_-]{43}/)
    end

    expect { described_class.issue(issuing_account) }
      .to raise_error(Coordination::OutcomeError) do |error|
        expect(error.outcome).to eq("AUTHENTICATION_UNAVAILABLE")
        expect(error.retryable).to be(true)
      end
    expect(client).to have_received(:set).exactly(3).times
  end
end
