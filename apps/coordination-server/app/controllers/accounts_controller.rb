class AccountsController < ApplicationController
  CAPABILITY_LABELS = {
    "awsm.replica.inventory.read" => "Inventory read",
    "awsm.replica.item.read" => "Item read",
    "awsm.replica.item.write" => "Item write",
    "awsm.replica.hint.read" => "Hint read",
    "awsm.replica.hint.write" => "Hint write",
    "awsm.replica.manage" => "Manage access"
  }.freeze

  helper_method :capability_label

  def show
    response.headers["Cache-Control"] = "private, no-store"
    @account = Current.account
    @principal = @account.channel_principal
    @authenticators = @principal.channel_authenticators.order(:created_at)
    @current_grants = @principal.replica_access_grants.where(revoked_at: nil)
      .includes(:hosted_replica).order(created_at: :asc)
    @hosted_replicas = @current_grants.map(&:hosted_replica)
    @visible_grants_by_replica_id = visible_grants_by_replica_id
    @browser_sessions = @principal.browser_sessions.order(
      Arel.sql("CASE WHEN id = #{BrowserSession.connection.quote(Current.browser_session.id)} " \
        "THEN 0 ELSE 1 END"),
      last_activity_at: :desc,
      created_at: :desc
    )
    @api_sessions = @principal.api_sessions.includes(:session_credentials)
      .order(revoked_at: :asc, created_at: :desc)
    @inactive_deletion_at = @account.last_activity_at +
      Coordination::ServicePolicy.current.inactive_account_retention_days.days
  end

  private

  def visible_grants_by_replica_id
    @current_grants.to_h do |current_grant|
      visible = if current_grant.permits?("awsm.replica.manage")
        current_grant.hosted_replica.replica_access_grants.where(revoked_at: nil)
          .includes(channel_principal: :account).order(:created_at)
      else
        [ current_grant ]
      end
      [ current_grant.hosted_replica_id, visible ]
    end
  end

  def capability_label(capability)
    CAPABILITY_LABELS.fetch(capability)
  end
end
