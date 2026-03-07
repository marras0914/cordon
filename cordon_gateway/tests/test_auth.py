"""
Auth module tests: OIDC flow, session management, middleware behaviour.
OIDC network calls are fully mocked — no real IdP needed.
"""
import json
import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import auth
import dashboard


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

FAKE_DISCOVERY = {
    "authorization_endpoint": "https://idp.example.com/authorize",
    "token_endpoint":         "https://idp.example.com/token",
    "jwks_uri":               "https://idp.example.com/.well-known/jwks.json",
}

FAKE_USER = {"sub": "u-123", "email": "alice@example.com", "name": "Alice"}

TEST_SESSION_SECRET = "test-secret-key-stable"


@pytest.fixture(autouse=True)
def stable_session_secret(monkeypatch):
    """Use a fixed secret so session tokens are stable across the test."""
    monkeypatch.setattr(auth, "SESSION_SECRET", TEST_SESSION_SECRET)
    from itsdangerous import URLSafeTimedSerializer
    monkeypatch.setattr(auth, "_session_signer",
                        URLSafeTimedSerializer(TEST_SESSION_SECRET, salt="cordon-session"))
    monkeypatch.setattr(auth, "_state_signer",
                        URLSafeTimedSerializer(TEST_SESSION_SECRET, salt="cordon-oidc-state"))


@pytest.fixture(autouse=True)
def clear_discovery_cache():
    """Prevent cached discovery from leaking between tests."""
    auth.clear_cache()
    yield
    auth.clear_cache()


def mock_get(url, **kwargs):
    resp = MagicMock()
    if "openid-configuration" in url:
        resp.json.return_value = FAKE_DISCOVERY
    elif "jwks" in url:
        resp.json.return_value = {"keys": [{"kid": "k1", "kty": "RSA"}]}
    resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# session signing
# ---------------------------------------------------------------------------

class TestSession:
    def test_roundtrip(self):
        token = auth.create_session(FAKE_USER)
        assert auth.verify_session(token) == FAKE_USER

    def test_invalid_token_returns_none(self):
        assert auth.verify_session("garbage") is None

    def test_tampered_token_returns_none(self):
        token = auth.create_session(FAKE_USER)
        assert auth.verify_session(token[:-4] + "XXXX") is None

    def test_expired_token_returns_none(self, monkeypatch):
        token = auth.create_session(FAKE_USER)
        monkeypatch.setattr(auth, "SESSION_MAX_AGE", -1)  # -1 = always expired
        assert auth.verify_session(token) is None


# ---------------------------------------------------------------------------
# state cookie
# ---------------------------------------------------------------------------

class TestStateCookie:
    def test_roundtrip(self):
        cookie = auth.create_state_cookie("mystate", "myverifier")
        data = auth.verify_state_cookie(cookie)
        assert data == {"state": "mystate", "verifier": "myverifier"}

    def test_invalid_returns_none(self):
        assert auth.verify_state_cookie("bad") is None

    def test_tampered_returns_none(self):
        cookie = auth.create_state_cookie("s", "v")
        assert auth.verify_state_cookie(cookie + "X") is None


# ---------------------------------------------------------------------------
# OIDC discovery + authorization URL
# ---------------------------------------------------------------------------

class TestAuthorizationUrl:
    @pytest.mark.anyio
    async def test_redirects_to_idp_with_pkce(self, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ISSUER",    "https://idp.example.com")
        monkeypatch.setattr(auth, "OIDC_CLIENT_ID", "my-client")

        async def fake_get(url, **kwargs):
            return mock_get(url)

        with patch("httpx.AsyncClient.get", side_effect=fake_get):
            url, state_cookie = await auth.get_authorization_url()

        assert url.startswith("https://idp.example.com/authorize")
        assert "code_challenge=" in url
        assert "code_challenge_method=S256" in url
        assert "response_type=code" in url
        assert "client_id=my-client" in url

    @pytest.mark.anyio
    async def test_state_cookie_is_signed_and_valid(self, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ISSUER",    "https://idp.example.com")
        monkeypatch.setattr(auth, "OIDC_CLIENT_ID", "my-client")

        async def fake_get(url, **kwargs):
            return mock_get(url)

        with patch("httpx.AsyncClient.get", side_effect=fake_get):
            url, state_cookie = await auth.get_authorization_url()

        data = auth.verify_state_cookie(state_cookie)
        assert data is not None
        assert "state" in data
        assert "verifier" in data


# ---------------------------------------------------------------------------
# token exchange + ID token validation
# ---------------------------------------------------------------------------

class TestExchangeCode:
    @pytest.mark.anyio
    async def test_exchange_returns_user(self, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ISSUER",        "https://idp.example.com")
        monkeypatch.setattr(auth, "OIDC_CLIENT_ID",     "my-client")
        monkeypatch.setattr(auth, "OIDC_CLIENT_SECRET", "secret")

        async def fake_get(url, **kwargs):
            return mock_get(url)

        token_resp = MagicMock()
        token_resp.json.return_value = {"id_token": "fake.id.token"}
        token_resp.raise_for_status = MagicMock()

        async def fake_post(url, **kwargs):
            return token_resp

        # Mock validate_id_token so we don't need real JWT/JWKS
        with patch("httpx.AsyncClient.get",  side_effect=fake_get), \
             patch("httpx.AsyncClient.post", side_effect=fake_post), \
             patch.object(auth, "validate_id_token", new=AsyncMock(return_value=FAKE_USER)):
            user = await auth.exchange_code("auth-code-123", "verifier-abc")

        assert user == FAKE_USER

    @pytest.mark.anyio
    async def test_exchange_passes_pkce_verifier(self, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ISSUER",        "https://idp.example.com")
        monkeypatch.setattr(auth, "OIDC_CLIENT_ID",     "my-client")
        monkeypatch.setattr(auth, "OIDC_CLIENT_SECRET", "secret")

        async def fake_get(url, **kwargs):
            return mock_get(url)

        captured = {}
        token_resp = MagicMock()
        token_resp.json.return_value = {"id_token": "x.y.z"}
        token_resp.raise_for_status = MagicMock()

        async def fake_post(url, data=None, **kwargs):
            captured.update(data or {})
            return token_resp

        with patch("httpx.AsyncClient.get",  side_effect=fake_get), \
             patch("httpx.AsyncClient.post", side_effect=fake_post), \
             patch.object(auth, "validate_id_token", new=AsyncMock(return_value=FAKE_USER)):
            await auth.exchange_code("code-xyz", "my-verifier")

        assert captured.get("code_verifier") == "my-verifier"
        assert captured.get("code") == "code-xyz"
        assert captured.get("grant_type") == "authorization_code"


# ---------------------------------------------------------------------------
# dashboard middleware with OIDC
# ---------------------------------------------------------------------------

class TestOidcMiddleware:
    def test_no_session_redirects_to_oidc_login(self, client, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        monkeypatch.setattr(dashboard, "DASHBOARD_KEY", "")
        r = client.get("/dashboard/", follow_redirects=False)
        assert r.status_code == 302
        assert "/auth/login" in r.headers["location"]

    def test_valid_oidc_session_grants_access(self, client, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        monkeypatch.setattr(dashboard, "DASHBOARD_KEY", "")
        session = auth.create_session(FAKE_USER)
        client.cookies.set("cordon_session", session)
        r = client.get("/dashboard/")
        assert r.status_code == 200
        assert "alice@example.com" in r.text
        client.cookies.clear()

    def test_invalid_oidc_session_redirects(self, client, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        monkeypatch.setattr(dashboard, "DASHBOARD_KEY", "")
        client.cookies.set("cordon_session", "invalid-token")
        r = client.get("/dashboard/", follow_redirects=False)
        assert r.status_code == 302
        client.cookies.clear()

    def test_oidc_login_route_redirects_to_idp(self, client, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        monkeypatch.setattr(auth, "OIDC_ISSUER",    "https://idp.example.com")
        monkeypatch.setattr(auth, "OIDC_CLIENT_ID", "my-client")

        async def fake_get(url, **kwargs):
            return mock_get(url)

        with patch("httpx.AsyncClient.get", side_effect=fake_get):
            r = client.get("/dashboard/auth/login", follow_redirects=False)

        assert r.status_code == 302
        assert "idp.example.com/authorize" in r.headers["location"]
        assert "cordon_oidc_state" in r.cookies

    def test_callback_with_bad_state_returns_400(self, client, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        r = client.get("/dashboard/auth/callback?code=abc&state=wrong")
        assert r.status_code == 400

    def test_callback_with_valid_state_sets_session(self, client, monkeypatch):
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        monkeypatch.setattr(auth, "OIDC_ISSUER",        "https://idp.example.com")
        monkeypatch.setattr(auth, "OIDC_CLIENT_ID",     "my-client")
        monkeypatch.setattr(auth, "OIDC_CLIENT_SECRET", "secret")

        state_val = auth.create_state_cookie("teststate", "testverifier")
        client.cookies.set("cordon_oidc_state", state_val)

        async def fake_get(url, **kwargs):
            return mock_get(url)

        token_resp = MagicMock()
        token_resp.json.return_value = {"id_token": "x.y.z"}
        token_resp.raise_for_status = MagicMock()

        async def fake_post(url, **kwargs):
            return token_resp

        with patch("httpx.AsyncClient.get",  side_effect=fake_get), \
             patch("httpx.AsyncClient.post", side_effect=fake_post), \
             patch.object(auth, "validate_id_token", new=AsyncMock(return_value=FAKE_USER)):
            r = client.get("/dashboard/auth/callback?code=abc&state=teststate",
                           follow_redirects=False)

        assert r.status_code == 303
        assert "cordon_session" in r.cookies
        client.cookies.clear()


# ---------------------------------------------------------------------------
# resolved_by in approval queue
# ---------------------------------------------------------------------------

class TestResolvedBy:
    def test_resolved_by_recorded(self, client, monkeypatch):
        import db

        # Make a pending approval
        client.post("/messages", json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "execute_shell", "arguments": {}},
        })
        aid = db.get_pending_approvals()[0]["id"]

        # Resolve as a known OIDC user
        monkeypatch.setattr(auth, "OIDC_ENABLED", True)
        session = auth.create_session(FAKE_USER)
        client.cookies.set("cordon_session", session)

        client.post("/dashboard/approvals/resolve",
                    data={"approval_id": aid, "decision": "APPROVED"})

        row = db.get_approval(aid)
        assert row["resolved_by"] == "alice@example.com"
        client.cookies.clear()
