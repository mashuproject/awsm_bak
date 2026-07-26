Rails.application.routes.draw do
  mount ActionCable.server => "/cable"

  namespace :api do
    resource :server_information, only: :show, path: "server-information"
    resources :sessions, only: :create
    post "session/refresh", to: "sessions#refresh"
    delete "session", to: "session#destroy"
    resources :device_session_challenges, only: :create, path: "device-session-challenges"
    resources :device_sessions, only: :create, path: "device-sessions"
    namespace :account do
      resource :vault_enrollment, only: :show, path: "vault-enrollment"
    end
    resources :cable_tickets, only: :create, path: "cable-tickets"
    resource :service_policy, only: :show, path: "service-policy"
    resources :vaults, only: [ :index, :create, :show ], param: :vault_id do
      post :complete, on: :member
    end
    get "vaults/:vault_id/devices", to: "vault_devices#index"
    post "vaults/:vault_id/devices", to: "vault_devices#create"
    delete "vaults/:vault_id/devices/:device_id", to: "vault_devices#destroy"
    get "vaults/:vault_id/device-authority", to: "vault_devices#authority"
    post "vaults/:vault_id/future-protections", to: "vault_devices#future_protection"
    post "vaults/:vault_id/replacement-candidates", to: "replacement_candidates#create"
    post "vaults/:vault_id/replacement-candidates/:replacement_vault_id/activate",
      to: "replacement_candidates#activate"
    post "vaults/:vault_id/uploads", to: "uploads#create"
    get "vaults/:vault_id/uploads/:upload_id", to: "uploads#show"
    post "vaults/:vault_id/uploads/:upload_id/ticket", to: "uploads#ticket"
    post "vaults/:vault_id/uploads/:upload_id/complete", to: "uploads#complete"
    post "vaults/:vault_id/commits", to: "commits#create"
    get "vaults/:vault_id/records", to: "records#index"
    get "vaults/:vault_id/changes", to: "changes#index"
    post "vaults/:vault_id/records/:object_id/downloads", to: "records#download"
    post "vaults/:vault_id/generation-candidates", to: "generation_candidates#create"
    delete "vaults/:vault_id/generation-candidates/:generation_id", to: "generation_candidates#destroy"
    put "vaults/:vault_id/generation-candidates/:generation_id/retained-pages/:page_number",
      to: "generation_candidates#put_page"
    post "vaults/:vault_id/generation-candidates/:generation_id/seal", to: "generation_candidates#seal"
    post "vaults/:vault_id/generation-candidates/:generation_id/activate", to: "generation_candidates#activate"
    get "vaults/:vault_id/recoveries", to: "recoveries#index"
    get "vaults/:vault_id/recoveries/:generation_id/records", to: "recoveries#records"
    post "vaults/:vault_id/recoveries/:generation_id/records/:object_id/downloads",
      to: "recoveries#download"
    post "vaults/:vault_id/purges", to: "purges#create"
    get "vaults/:vault_id/purges/:purge_id", to: "purges#show"
    put "transfers/:ticket/parts/:part_number", to: "transfers#put_part"
    get "transfers/:ticket", to: "transfers#show"
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
  get "account/password", to: "account_passwords#edit", as: :edit_account_password
  patch "account/password", to: "account_passwords#update"
  get "privacy", to: "home#privacy"
  get "security", to: "home#security"
  get "glossary", to: "home#glossary"
  get "design-system", to: "home#design_system" unless Rails.env.production?
  root "home#show"
end
