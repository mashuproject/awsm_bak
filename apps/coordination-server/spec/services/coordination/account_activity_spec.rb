require "rails_helper"

RSpec.describe Coordination::AccountActivity do
  let(:account) do
    create_account(last_activity_at: Time.utc(2026, 1, 1, 12))
  end
  let(:browser_session) do
    account.channel_principal.browser_sessions.create!(
      client_family: "Firefox",
      last_activity_at: Time.utc(2026, 1, 1, 12)
    )
  end

  it "touches an active Account and browser session only when at least 24 hours old" do
    first_activity = Time.utc(2026, 1, 3, 12)
    described_class.touch!(account:, browser_session:, at: first_activity)

    expect(account.reload.last_activity_at).to eq(first_activity)
    expect(browser_session.reload.last_activity_at).to eq(first_activity)

    described_class.touch!(account:, browser_session:, at: first_activity + 23.hours)

    expect(account.reload.last_activity_at).to eq(first_activity)
    expect(browser_session.reload.last_activity_at).to eq(first_activity)
  end

  it "fails closed without touching a Deleting Account" do
    account.update!(state: "Deleting")

    expect {
      described_class.touch!(account:, browser_session:, at: Time.utc(2026, 1, 3, 12))
    }.to raise_error(Coordination::OutcomeError) { |error|
      expect(error.outcome).to eq("AUTHENTICATION_FAILED")
    }

    expect(account.reload.last_activity_at).to eq(Time.utc(2026, 1, 1, 12))
    expect(browser_session.reload.last_activity_at).to eq(Time.utc(2026, 1, 1, 12))
  end
end
