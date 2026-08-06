import type { Decorator, Preview } from "@storybook/react";

import "../src/styles.css";
import { type AppearanceMode, AppearanceProvider } from "../src";

const withAppearance: Decorator = (Story, context) => {
  const mode = (context.globals.theme ?? "system") as AppearanceMode;
  return (
    <AppearanceProvider key={mode} initialMode={mode}>
      <Story />
    </AppearanceProvider>
  );
};

const preview: Preview = {
  decorators: [withAppearance],
  globalTypes: {
    theme: {
      description: "AWSM appearance",
      defaultValue: "system",
      toolbar: {
        icon: "paintbrush",
        items: ["system", "light", "dark"],
      },
    },
  },
  parameters: {
    a11y: { test: "error" },
    layout: "padded",
  },
};

export default preview;
