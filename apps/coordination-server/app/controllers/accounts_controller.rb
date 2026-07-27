class AccountsController < ApplicationController
  def show
    response.headers["Cache-Control"] = "private, no-store"
    @account = Current.account
    @vault = @account.vault_replicas.where(state: %w[Active Provisional])
      .order(Arel.sql("CASE state WHEN 'Active' THEN 0 ELSE 1 END")).first
    @devices = @vault ? ordered_devices(@vault) : []
    @browser_sessions = @account.browser_sessions.order(
      Arel.sql("CASE WHEN id = #{BrowserSession.connection.quote(Current.browser_session.id)} " \
        "THEN 0 ELSE 1 END"),
      last_activity_at: :desc,
      created_at: :desc
    )
    @inactive_deletion_at = @account.last_activity_at +
      Coordination::ServicePolicy.current.inactive_account_retention_days.days
  end

  private

  def ordered_devices(vault)
    vault.vault_devices.order(
      Arel.sql("CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END"),
      enrolled_at: :desc,
      revoked_at: :desc
    )
  end
end
