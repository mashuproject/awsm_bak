class AccountDeletionsController < ApplicationController
  RECEIPT_COOKIE = :account_deletion_receipt

  allow_unauthenticated_access only: :show

  def new
    @account = Current.account
  end

  def create
    _job, receipt = Coordination::AccountDeletion.accept_manual!(
      account: Current.account,
      password: deletion_params.fetch(:current_password),
      username_confirmation: deletion_params.fetch(:username_confirmation)
    )
    Current.browser_session = nil
    clear_browser_session_cookies
    cookies.signed[RECEIPT_COOKIE] = {
      value: receipt,
      httponly: true,
      same_site: :lax,
      secure: Rails.env.production?,
      path: "/account/deletion"
    }
    redirect_to account_deletion_path
  rescue Coordination::AccountDeletion::InvalidConfirmation
    @account = Current.account
    flash.now[:alert] = "The password or username confirmation is incorrect."
    render :new, status: :unprocessable_content
  end

  def show
    response.headers["Cache-Control"] = "private, no-store"
    @deletion_job = Coordination::AccountDeletion.find_by_receipt(
      cookies.signed[RECEIPT_COOKIE]
    )
    return head :not_found unless @deletion_job

    if request.format.json?
      render json: {
        state: @deletion_job.public_state,
        stage: @deletion_job.stage,
        processedBytes: @deletion_job.processed_bytes,
        totalBytes: @deletion_job.total_bytes,
        retryCount: @deletion_job.retry_count,
        outcome: @deletion_job.error_outcome
      }
    end
  end

  private

  def deletion_params
    params.expect(
      account_deletion: [ :current_password, :username_confirmation ]
    ).to_h.symbolize_keys
  end
end
