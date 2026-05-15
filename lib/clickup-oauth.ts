import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const OAUTH_TOKEN_FILE = resolve(process.cwd(), ".clickup-oauth.json");
const CLICKUP_AUTH_URL = "https://api.clickup.com/api";

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
}

function loadTokens(): OAuthTokens | null {
  if (!existsSync(OAUTH_TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(OAUTH_TOKEN_FILE, "utf-8")) as OAuthTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: OAuthTokens): void {
  writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf-8");
}

function isOAuthConfigured(): boolean {
  return !!(process.env.CLICKUP_CLIENT_ID && process.env.CLICKUP_CLIENT_SECRET);
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const resp = await fetch(`${CLICKUP_AUTH_URL}/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.CLICKUP_CLIENT_ID,
      client_secret: process.env.CLICKUP_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) throw new Error(`ClickUp OAuth refresh failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json() as { access_token: string; refresh_token?: string; token_type: string };
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    token_type: data.token_type || "Bearer",
    expires_at: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

export async function getClickUpToken(): Promise<string> {
  if (isOAuthConfigured()) {
    const tokens = loadTokens();
    if (tokens) {
      if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
        if (tokens.refresh_token) {
          const refreshed = await refreshAccessToken(tokens.refresh_token);
          return refreshed.access_token;
        }
      }
      return tokens.access_token;
    }
  }
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error("No ClickUp credentials. Set CLICKUP_API_TOKEN env var.");
  return token;
}

export function getClickUpTokenSync(): string {
  if (isOAuthConfigured()) {
    const tokens = loadTokens();
    if (tokens && Date.now() < tokens.expires_at - 5 * 60 * 1000) return tokens.access_token;
  }
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error("No ClickUp token available (sync)");
  return token;
}
