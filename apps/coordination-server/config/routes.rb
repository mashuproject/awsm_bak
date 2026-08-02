Rails.application.routes.draw do
  namespace :api do
    resource :server_information, only: :show, path: "server-information"
    resources :sessions, only: :create
    post "session/refresh", to: "sessions#refresh"
    delete "session", to: "session#destroy"
    resource :service_policy, only: :show, path: "service-policy"
    resources :upload_transfers, only: :update, path: "uploads", param: :upload_handle do
      post :finalize, on: :member
    end
    resources :hosted_replicas, only: %i[index create destroy], path: "replicas" do
      resources :replica_access_grants, only: %i[create destroy], path: "grants"
      resource :opaque_inventory, only: :show, path: "inventory"
      get "hint", to: "opaque_hints#show"
      post "hint", to: "opaque_hints#create"
      resources :opaque_items, only: %i[show update], path: "items", param: :storage_item_id
      resources :opaque_uploads, only: :create, path: "uploads", param: :upload_handle do
        post :capability, on: :member
      end
    end
  end

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check
  get "ready" => "readiness#show", as: :readiness

  get "sign_up", to: "registrations#new"
  post "sign_up", to: "registrations#create"
  get "session/new", to: "sessions#new", as: :new_session
  get "session/status", to: "sessions#show"
  post "session", to: "sessions#create"
  delete "session", to: "sessions#destroy"
  get "account", to: "accounts#show"
  delete "account/browser-sessions", to: "browser_sessions#destroy_others",
    as: :account_browser_sessions
  delete "account/browser-sessions/:id", to: "browser_sessions#destroy",
    as: :account_browser_session
  delete "account/api-sessions/:id", to: "api_sessions#destroy",
    as: :account_api_session
  get "account/password", to: "account_passwords#edit", as: :edit_account_password
  patch "account/password", to: "account_passwords#update"
  get "account/deletion/new", to: "account_deletions#new", as: :new_account_deletion
  post "account/deletion", to: "account_deletions#create", as: :start_account_deletion
  get "account/deletion", to: "account_deletions#show", as: :account_deletion
  get "privacy", to: "home#privacy"
  get "security", to: "home#security"
  get "glossary", to: "home#glossary"
  get "design-system", to: "home#design_system" unless Rails.env.production?
  root "home#show"
end
