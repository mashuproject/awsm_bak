class HomeController < ApplicationController
  allow_unauthenticated_access
  layout "public", only: %i[show privacy security glossary]
  after_action :set_public_page_cache_policy, only: %i[show privacy security glossary]

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
    @glossary_sections = CanonicalGlossary.load
  end

  def design_system
    raise ActionController::RoutingError, "Not Found" if Rails.env.production?

    assign_public_context
  end

  private

  def assign_public_context
    @server_origin = Coordination::Registration.public_origin
    @registration_enabled = Coordination::Registration.enabled?
  end

  def set_public_page_cache_policy
    return unless response.successful?

    response.headers["Cache-Control"] = "public, max-age=300"
    response.headers["CDN-Cache-Control"] =
      "public, max-age=86400, stale-while-revalidate=86400, stale-if-error=604800"
  end
end
