module Api
  class ServicePoliciesController < BaseController
    def show
      render json: Coordination::ServicePolicy.current
    end
  end
end
