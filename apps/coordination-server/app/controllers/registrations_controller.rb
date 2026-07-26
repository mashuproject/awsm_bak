class RegistrationsController < ApplicationController
  allow_unauthenticated_access
  before_action :require_registration

  def new
    @account = Account.new
  end

  def create
    @account = Account.new(account_params)
    if @account.save
      start_new_session_for(@account)
      redirect_to account_path
    else
      flash.now[:alert] = "We couldn't create that account. Check the details or sign in."
      render :new, status: :unprocessable_content
    end
  end

  private

  def require_registration
    head :not_found unless Coordination::Registration.enabled?
  end

  def account_params
    params.expect(account: [ :email, :password, :password_confirmation ])
  end
end
