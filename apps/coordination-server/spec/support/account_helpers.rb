module AccountHelpers
  def account_attributes(username: nil)
    sequence = SecureRandom.uuid
    {
      username: username || "reader_#{sequence.delete("-").first(16)}",
      password: "test password #{sequence}",
      password_confirmation: "test password #{sequence}",
      last_activity_at: Time.current
    }
  end

  def create_account(**attributes)
    Account.create!(**account_attributes.merge(attributes))
  end
end
