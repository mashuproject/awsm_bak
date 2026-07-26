class AccountsController < ApplicationController
  def show
    @account = Current.account
  end
end
