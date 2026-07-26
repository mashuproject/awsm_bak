module Api
  class ServicePoliciesController < BaseController
    skip_before_action :require_vault_device_scope

    def show
      render json: Coordination::ServicePolicy.current
    end
  end
end
