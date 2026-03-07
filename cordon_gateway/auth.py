"""
OIDC/SSO authentication for the Cordon dashboard.

Auth priority (checked in order):
  1. OIDC  — all three CORDON_OIDC_* vars set
  2. Key   — CORDON_DASHBOARD_KEY set
  3. Open  — neither set (dev mode)

OIDC flow:
  GET /dashboard/auth/login     → redirect to IdP (PKCE + state stored in signed cookie)
  GET /dashboard/auth/callback  → validate state, exchange code, set session cookie
  GET /dashboard/logout         → clear session, redirect to login

Session cookie: signed + timestamped JSON payload via itsdangerous.
PKCE state cookie: short-lived (10 min), cleared after callback.
"""

import os
import json
import base64
import hashlib
import secrets
from typing import Optional
from urllib.parse import urlencode

import httpx
from jose import jwt, JWTError
from itsdangerous import URLSafeTimedSerializer, BadData

# ---------- config ----------

OIDC_ISSUER        = os.getenv("CORDON_OIDC_ISSUER", "")
OIDC_CLIENT_ID     = os.getenv("CORDON_OIDC_CLIENT_ID", "")
OIDC_CLIENT_SECRET = os.getenv("CORDON_OIDC_CLIENT_SECRET", "")
OIDC_REDIRECT_URI  = os.getenv(
    "CORDON_OIDC_REDIRECT_URI", "http://localhost:8000/dashboard/auth/callback"
)
OIDC_SCOPES        = os.getenv("CORDON_OIDC_SCOPES", "openid email profile")

SESSION_SECRET  = os.getenv("CORDON_SESSION_SECRET", secrets.token_hex(32))
SESSION_MAX_AGE = int(os.getenv("CORDON_SESSION_MAX_AGE", "28800"))  # 8 hours default

OIDC_ENABLED        = bool(OIDC_ISSUER and OIDC_CLIENT_ID and OIDC_CLIENT_SECRET)
SECRET_IS_EPHEMERAL = "CORDON_SESSION_SECRET" not in os.environ

# ---------- signers ----------

_session_signer = URLSafeTimedSerializer(SESSION_SECRET, salt="cordon-session")
_state_signer   = URLSafeTimedSerializer(SESSION_SECRET, salt="cordon-oidc-state")

# ---------- discovery + JWKS cache ----------

_discovery_cache: Optional[dict] = None
_jwks_cache: Optional[dict] = None


async def get_discovery() -> dict:
    global _discovery_cache
    if _discovery_cache is None:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{OIDC_ISSUER}/.well-known/openid-configuration")
            r.raise_for_status()
            _discovery_cache = r.json()
    return _discovery_cache


async def get_jwks() -> dict:
    global _jwks_cache
    if _jwks_cache is None:
        discovery = await get_discovery()
        async with httpx.AsyncClient() as client:
            r = await client.get(discovery["jwks_uri"])
            r.raise_for_status()
            _jwks_cache = r.json()
    return _jwks_cache


def clear_cache():
    """Force re-fetch of discovery + JWKS (useful after key rotation)."""
    global _discovery_cache, _jwks_cache
    _discovery_cache = None
    _jwks_cache = None


# ---------- PKCE ----------

def _pkce_pair() -> tuple[str, str]:
    """Returns (code_verifier, code_challenge)."""
    verifier  = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


# ---------- session ----------

def create_session(user: dict) -> str:
    """Sign and serialize a user dict into a session token."""
    return _session_signer.dumps(user)


def verify_session(token: str) -> Optional[dict]:
    """Verify and deserialize a session token. Returns None if invalid/expired."""
    if not token:
        return None
    try:
        return _session_signer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadData, Exception):
        return None


# ---------- PKCE state cookie ----------

def create_state_cookie(state: str, verifier: str) -> str:
    return _state_signer.dumps({"state": state, "verifier": verifier})


def verify_state_cookie(token: str) -> Optional[dict]:
    """Valid for 10 minutes — enough to complete the login redirect."""
    try:
        return _state_signer.loads(token, max_age=600)
    except BadData:
        return None


# ---------- OIDC flow ----------

async def get_authorization_url() -> tuple[str, str]:
    """
    Build the IdP authorization URL.
    Returns (redirect_url, state_cookie_value).
    """
    discovery = await get_discovery()
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)

    params = {
        "response_type": "code",
        "client_id":     OIDC_CLIENT_ID,
        "redirect_uri":  OIDC_REDIRECT_URI,
        "scope":         OIDC_SCOPES,
        "state":         state,
        "code_challenge":        challenge,
        "code_challenge_method": "S256",
    }
    auth_url = f"{discovery['authorization_endpoint']}?{urlencode(params)}"
    return auth_url, create_state_cookie(state, verifier)


async def exchange_code(code: str, code_verifier: str) -> dict:
    """
    Exchange authorization code for an ID token.
    Returns a normalized user dict: {sub, email, name}.
    """
    discovery = await get_discovery()
    async with httpx.AsyncClient() as client:
        r = await client.post(
            discovery["token_endpoint"],
            data={
                "grant_type":    "authorization_code",
                "code":          code,
                "redirect_uri":  OIDC_REDIRECT_URI,
                "client_id":     OIDC_CLIENT_ID,
                "client_secret": OIDC_CLIENT_SECRET,
                "code_verifier": code_verifier,
            },
        )
        r.raise_for_status()
        tokens = r.json()

    return await validate_id_token(tokens["id_token"])


async def validate_id_token(id_token: str) -> dict:
    """
    Validate the OIDC ID token against the IdP's JWKS.
    Returns a normalized user dict: {sub, email, name}.
    Raises ValueError or JWTError on invalid tokens.
    """
    jwks = await get_jwks()

    # Decode header to find which key to use
    header_b64 = id_token.split(".")[0]
    # Pad base64 to a multiple of 4
    header = json.loads(base64.urlsafe_b64decode(header_b64 + "=="))
    kid = header.get("kid")

    key = next(
        (k for k in jwks.get("keys", []) if k.get("kid") == kid),
        jwks.get("keys", [None])[0],   # fallback: first key if no kid match
    )
    if key is None:
        raise ValueError("No JWKS key found for ID token validation")

    claims = jwt.decode(
        id_token,
        key,
        algorithms=["RS256", "ES256", "RS384", "RS512"],
        audience=OIDC_CLIENT_ID,
        issuer=OIDC_ISSUER,
    )
    return {
        "sub":   claims["sub"],
        "email": claims.get("email", claims["sub"]),
        "name":  claims.get("name", claims.get("email", "Unknown")),
    }


# ---------- request helper ----------

def get_user_from_request(request) -> Optional[dict]:
    """
    Extract the current user from the session cookie.
    Works for both OIDC sessions (signed payload) and key auth (returns stub).
    Returns None if unauthenticated.
    """
    token = request.cookies.get("cordon_session")
    if not token:
        return None
    if OIDC_ENABLED:
        return verify_session(token)
    # Key auth: cookie value is the raw key — return a stub user
    from dashboard import DASHBOARD_KEY  # avoid circular import at module level
    if token == DASHBOARD_KEY:
        return {"sub": "admin", "email": "admin", "name": "Admin"}
    return None
