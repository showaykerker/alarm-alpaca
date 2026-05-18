"""HTTP Basic auth with loopback bypass.

Loopback (127.0.0.1, ::1) skips auth because the on-device Chromium kiosk is
implicitly trusted — physical access to the screen already wins. LAN clients
always present a password. We only trust the actual socket peer; X-Forwarded-*
headers are ignored on purpose (no proxy in front).
"""

import os
import secrets
from pathlib import Path

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

PASSWORD_FILE = Path(os.environ.get("KIOSK_PASSWORD_FILE", "/etc/kiosk-ui/password"))
AUTH_USER = os.environ.get("KIOSK_AUTH_USER", "admin")

_basic = HTTPBasic(auto_error=False)


def _load_password() -> str:
    return PASSWORD_FILE.read_text().strip()


def _is_loopback(request: Request) -> bool:
    if request.client is None:
        return False
    return request.client.host in ("127.0.0.1", "::1")


def auth_dep(
    request: Request,
    creds: HTTPBasicCredentials | None = Depends(_basic),
) -> str:
    if _is_loopback(request):
        return "localhost"
    if creds is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": 'Basic realm="alarm-alpaca kiosk"'},
        )
    try:
        expected_pw = _load_password()
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Password file unavailable",
        )
    user_ok = secrets.compare_digest(creds.username, AUTH_USER)
    pw_ok = secrets.compare_digest(creds.password, expected_pw)
    if not (user_ok and pw_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": 'Basic realm="alarm-alpaca kiosk"'},
        )
    return creds.username
