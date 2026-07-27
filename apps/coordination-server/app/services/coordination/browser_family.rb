module Coordination
  module BrowserFamily
    module_function

    def classify(user_agent)
      value = user_agent.to_s
      return "Firefox" if value.match?(/Firefox\//i)
      return "Chrome" if value.match?(/(?:Chrome|Chromium|CriOS|Edg|OPR)\//i)

      "Other"
    end
  end
end
