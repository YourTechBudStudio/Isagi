import * as SecureStore from "expo-secure-store";

const STORE_KEY_API_URL = "isagi_api_url";
const STORE_KEY_USER_API_KEY = "isagi_user_api_key";

export interface AppConfig {
  readonly apiUrl: string;
  readonly userApiKey: string;
}

/**
 * Normalize a user-entered URL so it always ends with `/api`.
 *
 * Handles trailing slashes and the common case where someone
 * enters `http://host:13000` without the path segment.
 */
export function normalizeApiUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");

  if (!url.endsWith("/api")) {
    url = `${url}/api`;
  }

  return url;
}

/** Read persisted config. Returns `null` when either value is missing. */
export async function getAppConfig(): Promise<AppConfig | null> {
  const [apiUrl, userApiKey] = await Promise.all([
    SecureStore.getItemAsync(STORE_KEY_API_URL),
    SecureStore.getItemAsync(STORE_KEY_USER_API_KEY),
  ]);

  if (!apiUrl || !userApiKey) {
    return null;
  }

  return { apiUrl, userApiKey };
}

/** Persist config after normalizing the URL. */
export async function setAppConfig(config: {
  apiUrl: string;
  userApiKey: string;
}): Promise<AppConfig> {
  const normalizedUrl = normalizeApiUrl(config.apiUrl);
  const normalizedUserApiKey = config.userApiKey.trim();

  await Promise.all([
    SecureStore.setItemAsync(STORE_KEY_API_URL, normalizedUrl),
    SecureStore.setItemAsync(STORE_KEY_USER_API_KEY, normalizedUserApiKey),
  ]);

  return {
    apiUrl: normalizedUrl,
    userApiKey: normalizedUserApiKey,
  };
}
