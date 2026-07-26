class HomeController < ApplicationController
  allow_unauthenticated_access

  def show
    redirect_to authenticated? ? account_path : new_session_path
  end
end
