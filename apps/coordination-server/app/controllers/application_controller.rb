class ApplicationController < ActionController::Base
  include Authentication
  around_action :fence_authenticated_browser_mutation

  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  # Changes to the importmap will invalidate the etag for HTML responses
  stale_when_importmap_changes

  private

  def fence_authenticated_browser_mutation
    return yield if request.get? || request.head? || Current.account.nil?

    Account.transaction do
      account = Current.account
      account.lock!
      request_authentication unless account.active?
      yield if account.active?
    end
  end
end
