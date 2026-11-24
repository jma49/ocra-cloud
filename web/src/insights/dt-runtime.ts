// The chart library asks its host platform for the user's theme, language
// and time zone; outside that platform the console answers itself, so the
// charts follow the browser and print no warnings.

import { isDark } from "../theme.js";

type Runtime = Record<"userPreferences" | "appEnvironment", Record<string, () => unknown>>;
const host = globalThis as typeof globalThis & { dtRuntime?: Runtime };

host.dtRuntime ??= {
  userPreferences: {
    getTheme: () => (isDark() ? "dark" : "light"),
    getLanguage: () => "en",
    getRegionalFormat: () => navigator.language,
    getTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  appEnvironment: {
    getAppId: () => "ocra-cloud",
    getAppName: () => "ocra Cloud",
    getAppVersion: () => "0.0.0",
    getEnvironmentId: () => "ocra-cloud",
    getEnvironmentUrl: () => location.origin,
    getCurrentUserDetails: () => ({ id: "", name: "", email: "" }),
  },
};
