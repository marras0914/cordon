import * as jose from "jose";
import { config, oidcEnabled } from "../config.ts";

const SESSION_COOKIE = "cordon_session";
const STATE_COOKIE = "cordon_oidc_state";
const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours

// ---------- session ----------

const sessionSecret = new TextEncoder().encode(
  config.CORDON_SESSION_SECRET.padEnd(32, "0").slice(0, 32),
);

export interface SessionUser {
  sub: string;
  email: string;
  name?: string;
}

export async function createSession(user: SessionUser): Promise<string> {
  return new jose.SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionSecret);
}

export async function verifySession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, sessionSecret);
    return payload as unknown as SessionUser;
  } catch {
    return null;
  }
}

// ---------- OIDC discovery cache ----------

interface OidcConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let _oidcConfig: OidcConfig | null = null;

async function getOidcConfig(): Promise<OidcConfig> {
  if (_oidcConfig) return _oidcConfig;
  const res = await fetch(`${config.CORDON_OIDC_ISSUER}/.well-known/openid-configuration`);
  _oidcConfig = (await res.json()) as OidcConfig;
  return _oidcConfig;
}

// ---------- PKCE ----------

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function sha256(plain: string): Promise<string> {
  const enc = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return base64url(hash);
}

export async function getAuthorizationUrl(): Promise<{ url: string; stateCookie: string }> {
  const oidc = await getOidcConfig();
  const state = crypto.randomUUID();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256(verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.CORDON_OIDC_CLIENT_ID!,
    redirect_uri: config.CORDON_OIDC_REDIRECT_URI!,
    scope: config.CORDON_OIDC_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const url = `${oidc.authorization_endpoint}?${params}`;
  const cookiePayload = JSON.stringify({ state, verifier });
  const stateCookie = `${STATE_COOKIE}=${encodeURIComponent(cookiePayload)}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`;

  return { url, stateCookie };
}

export async function exchangeCode(code: string, verifier: string): Promise<SessionUser> {
  const oidc = await getOidcConfig();
  const res = await fetch(oidc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.CORDON_OIDC_REDIRECT_URI!,
      client_id: config.CORDON_OIDC_CLIENT_ID!,
      client_secret: config.CORDON_OIDC_CLIENT_SECRET!,
      code_verifier: verifier,
    }),
  });
  const tokens = (await res.json()) as { id_token: string };
  return validateIdToken(tokens.id_token, oidc.jwks_uri);
}

async function validateIdToken(idToken: string, jwksUri: string): Promise<SessionUser> {
  const JWKS = jose.createRemoteJWKSet(new URL(jwksUri));
  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    issuer: config.CORDON_OIDC_ISSUER,
    audience: config.CORDON_OIDC_CLIENT_ID,
  });
  return {
    sub: payload.sub!,
    email: (payload.email as string) ?? payload.sub!,
    name: payload.name as string | undefined,
  };
}

export { oidcEnabled, SESSION_COOKIE, STATE_COOKIE };
