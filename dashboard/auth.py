"""HTTP Basic Auth for the seamless-wan dashboard."""

import base64
import hashlib
import os
import secrets
import time

DEFAULT_USER = "admin"
DEFAULT_PASS = "seamless"

# Override via environment variables
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", DEFAULT_USER)
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", DEFAULT_PASS)

# In-memory session store: token -> expiry timestamp
_sessions: dict[str, float] = {}
SESSION_TTL = 3600 * 8  # 8 hours


def check_basic_auth(authorization: str) -> bool:
    """Verify HTTP Basic Auth header value."""
    if not authorization or not authorization.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(authorization[6:]).decode("utf-8")
        user, password = decoded.split(":", 1)
        return user == DASHBOARD_USER and password == DASHBOARD_PASS
    except Exception:
        return False


def create_session() -> str:
    """Create a new session token."""
    _cleanup_expired()
    token = secrets.token_hex(16)
    _sessions[token] = time.time() + SESSION_TTL
    return token


def check_session(token: str) -> bool:
    """Check if a session token is valid."""
    if not token:
        return False
    expiry = _sessions.get(token)
    if expiry is None:
        return False
    if time.time() > expiry:
        del _sessions[token]
        return False
    return True


def check_request_auth(headers: dict) -> bool:
    """Check if a request is authenticated (Basic Auth or session cookie)."""
    # Check session cookie first
    cookie = headers.get("Cookie", "")
    for part in cookie.split(";"):
        part = part.strip()
        if part.startswith("session="):
            token = part[8:]
            if check_session(token):
                return True

    # Fall back to Basic Auth
    auth = headers.get("Authorization", "")
    return check_basic_auth(auth)


def _cleanup_expired() -> None:
    """Remove expired sessions."""
    now = time.time()
    expired = [t for t, exp in _sessions.items() if now > exp]
    for t in expired:
        del _sessions[t]
