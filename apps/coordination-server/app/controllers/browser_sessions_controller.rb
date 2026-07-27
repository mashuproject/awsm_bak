class BrowserSessionsController < ApplicationController
  def destroy
    browser_session = Current.account.browser_sessions.find_by(id: params[:id])
    return head :not_found unless browser_session

    if browser_session == Current.browser_session
      render plain: "Use Sign out to end this website session.", status: :unprocessable_content
      return
    end

    browser_session.destroy!
    redirect_to account_path(anchor: "website-sessions"),
      notice: "The website session was signed out."
  end

  def destroy_others
    Current.account.browser_sessions.where.not(id: Current.browser_session.id).delete_all
    redirect_to account_path(anchor: "website-sessions"),
      notice: "All other website sessions were signed out."
  end
end
