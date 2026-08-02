module Api
  class SessionController < BaseController
    def destroy
      current_principal.session.revoke!
      head :no_content
    end
  end
end
