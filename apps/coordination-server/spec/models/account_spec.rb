require "rails_helper"

RSpec.describe Account, type: :model do
  let(:attributes) do
    {
      username: "quiet_vault",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    }
  end

  it "stores one normalized private username with a separate password authenticator" do
    account = described_class.create!(**attributes.merge(username: "  Quiet_Vault  "))

    expect(account.username).to eq("quiet_vault")
    expect(account.state).to eq("Active")
    expect(account.authenticate("correct horse battery staple")).to eq(account)
    expect(account.authenticate("wrong password")).to be(false)
    expect(account.channel_principal.password_authenticator.password_digest).to be_present
    expect(account.hosted_replicas).to be_empty
  end

  it "rejects duplicate normalized usernames" do
    described_class.create!(**attributes)

    duplicate = described_class.new(**attributes.merge(username: " QUIET_VAULT "))

    expect(duplicate).not_to be_valid
    expect(duplicate.errors[:username]).to be_present
  end

  it "accepts only the canonical 3-to-32-character ASCII username shape" do
    expect(described_class.new(**attributes.merge(username: "a-b_c9"))).to be_valid

    [ "ab", "-archive", "archive-", "a..b", "álbum", "a" * 33 ].each do |username|
      account = described_class.new(**attributes.merge(username:))

      expect(account).not_to be_valid
      expect(account.errors[:username]).to be_present
    end
  end

  it "defines only the canonical Account identity and lifecycle columns" do
    expect(described_class.column_names).to include(
      "username",
      "state",
      "last_activity_at"
    )
    expect(described_class.column_names).not_to include("email", "password_digest")
  end

  it "enforces username normalization and shape in PostgreSQL" do
    insert = <<~SQL.squish
      INSERT INTO accounts
        (username, state, last_activity_at, created_at, updated_at)
      VALUES
        ('INVALID', 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    SQL

    expect { described_class.connection.execute(insert) }.to raise_error(
      ActiveRecord::StatementInvalid,
      /accounts_normalized_username|accounts_username_shape/
    )
  end
end
