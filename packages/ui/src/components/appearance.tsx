import * as React from "react";

export type AppearanceMode = "system" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "awsm.appearance";

function readStoredAppearance(): AppearanceMode | undefined {
  if (typeof window === "undefined") return undefined;
  const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : undefined;
}

function resolveAppearance(mode: AppearanceMode): ResolvedAppearance {
  if (mode !== "system") return mode;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyAppearanceMode(mode: AppearanceMode): ResolvedAppearance {
  const resolved = resolveAppearance(mode);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.awsmTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

interface AppearanceContextValue {
  readonly mode: AppearanceMode;
  readonly resolved: ResolvedAppearance;
  readonly setMode: (mode: AppearanceMode) => void;
}

const AppearanceContext = React.createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({
  children,
  initialMode = "system",
}: {
  readonly children: React.ReactNode;
  readonly initialMode?: AppearanceMode;
}): React.ReactElement {
  const [mode, setModeState] = React.useState<AppearanceMode>(
    () => readStoredAppearance() ?? initialMode,
  );
  const [resolved, setResolved] = React.useState<ResolvedAppearance>(() => resolveAppearance(mode));

  const setMode = React.useCallback((next: AppearanceMode) => {
    setModeState(next);
    if (typeof window !== "undefined") window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
  }, []);

  React.useEffect(() => {
    const update = () => setResolved(applyAppearanceMode(mode));
    update();
    if (mode !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [mode]);

  const value = React.useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = React.useContext(AppearanceContext);
  if (value === null) throw new Error("useAppearance must be used within AppearanceProvider.");
  return value;
}

export function AppearanceControl({
  label = "Appearance",
}: {
  readonly label?: string;
}): React.ReactElement {
  const { mode, setMode } = useAppearance();
  return (
    <label className="grid gap-2 text-sm font-semibold text-awsm-ink">
      <span>{label}</span>
      <select
        className="min-h-11 w-full rounded-compact border-2 border-awsm-ink bg-awsm-paper px-3 text-base text-awsm-ink outline-none focus:awsm-focus-ring"
        value={mode}
        onChange={(event) => setMode(event.target.value as AppearanceMode)}
      >
        <option value="system">System default</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
