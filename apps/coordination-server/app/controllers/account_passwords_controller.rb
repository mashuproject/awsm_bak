class AccountPasswordsController < ApplicationController
  def edit
  end

  def update
    account = Current.account
    attributes = password_params
    unless account.authenticate(attributes.delete(:current_password))
      flash.now[:alert] = "The current password is incorrect."
      return render :edit, status: :unprocessable_content
    end

    account.replace_password!(
      password: attributes.fetch(:password),
      password_confirmation: attributes.fetch(:password_confirmation)
    )
    Current.browser_session = nil
    clear_browser_session_cookies
    redirect_to new_session_path, notice: "Password changed. Log in again on every device."
  rescue ActiveRecord::RecordInvalid
    flash.now[:alert] = "The new password and confirmation must match."
    render :edit, status: :unprocessable_content
  end

  private

  def password_params
    params.expect(account: [ :current_password, :password, :password_confirmation ]).to_h.symbolize_keys
  end
end
