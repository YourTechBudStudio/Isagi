import { createContext, useContext } from "react";

import type { AppConfig } from "./appConfig";

interface AppConfigContextValue {
  readonly config: AppConfig | null;
  readonly configChecked: boolean;
  readonly setConfig: (next: AppConfig | null) => void;
}

const AppConfigContext = createContext<AppConfigContextValue | null>(null);

export const AppConfigProvider = AppConfigContext.Provider;

export function useAppConfig(): AppConfigContextValue {
  const value = useContext(AppConfigContext);
  if (!value) {
    throw new Error("useAppConfig must be used inside AppConfigProvider");
  }
  return value;
}
