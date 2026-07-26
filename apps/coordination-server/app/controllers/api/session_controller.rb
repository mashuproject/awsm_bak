module Api
  class SessionController < BaseController
    skip_before_action :require_vault_device_scope

    def destroy
      current_principal.session.revoke!
      head :no_content
    end
  end
end
