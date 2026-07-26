class HomeController < ApplicationController
  allow_unauthenticated_access

  def show
    assign_public_context
  end

  def privacy
    assign_public_context
  end

  def security
    assign_public_context
  end

  def glossary
    assign_public_context
  end

  def design_system
    raise ActionController::RoutingError, "Not Found" if Rails.env.production?

    assign_public_context
  end

  private

  def assign_public_context
    @server_origin = request.base_url
    @registration_enabled = Coordination::Registration.enabled?
    @current_account = authenticated? ? Current.browser_session.account : nil
  end
end
