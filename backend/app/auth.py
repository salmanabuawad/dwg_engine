"""Minimal admin-only auth, ported from Solarica.

Seeds a single admin user (`admin`/`admin123` by default; override with
`ADMIN_USER` / `ADMIN_PASS` env vars) on first boot. Issues HMAC-SHA256
signed bearer tokens valid for 7 days.

Unlike the Solarica original, this module does NOT install a global
middleware that locks down `/api/*` — the navvix backend keeps
`/api/health` and `/api/process` public.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import APIRouter, Body, HTTPException, Request

AUTH_SECRET = os.environ.get("AUTH_SECRET") or secrets.token_hex(32)
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "admin123")
TOKEN_TTL_SECONDS = 7 * 24 * 3600

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg2://navvix:navvix@localhost:5432/navvix",
)

# psycopg2 wants `postgresql://`, not SQLAlchemy's `postgresql+psycopg2://`.
PSYCOPG2_DSN = DATABASE_URL.replace("postgresql+psycopg2://", "postgresql://", 1)


def _conn():
    return psycopg2.connect(PSYCOPG2_DSN, cursor_factory=RealDictCursor)


# --- Password hashing (salted SHA-256) --------------------------------

def _hash_pw(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
    return f"{salt}${h}"


def _verify_pw(plain: str, stored: str) -> bool:
    if not stored:
        return False
    if "$" not in stored:
        return hmac.compare_digest(plain, stored)
    salt, h = stored.split("$", 1)
    expected = hashlib.sha256(f"{salt}{plain}".encode()).hexdigest()
    return hmac.compare_digest(expected, h)


# --- Users table ------------------------------------------------------

USERS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def ensure_users_schema() -> None:
    """Create the users table and seed admin/admin123 if empty."""
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(USERS_SCHEMA_SQL)
        cur.execute("SELECT COUNT(*) AS n FROM users")
        row = cur.fetchone()
        n = (row["n"] if row else 0) or 0
        if n == 0:
            cur.execute(
                "INSERT INTO users (username, password_hash, display_name, role) "
                "VALUES (%s, %s, %s, %s)",
                (ADMIN_USER, _hash_pw(ADMIN_PASS), "Administrator", "admin"),
            )
        conn.commit()


def _db_user_row(username: str) -> Optional[dict]:
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, username, password_hash, display_name, role, is_active "
            "FROM users WHERE username = %s",
            (username,),
        )
        return cur.fetchone()


# --- Token signing / verification -------------------------------------

def _sign_token(user: str, role: str = "viewer") -> str:
    ts = int(time.time())
    payload = f"{user}|{role}|{ts}"
    sig = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()


def _verify_token(token: str) -> Optional[dict]:
    try:
        decoded = base64.urlsafe_b64decode(token.encode()).decode()
        parts = decoded.rsplit("|", 3)
        if len(parts) != 4:
            return None
        user, role, ts_str, sig = parts
        payload = f"{user}|{role}|{ts_str}"
        expected = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        ts = int(ts_str)
        if time.time() - ts > TOKEN_TTL_SECONDS:
            return None
        return {"username": user, "role": role, "issued_at": ts}
    except Exception:
        return None


# --- Routes ----------------------------------------------------------

router = APIRouter(tags=["auth"])


@router.post("/auth/login")
async def api_login(creds: dict = Body(...)):
    username = str(creds.get("username") or "")
    password = str(creds.get("password") or "")
    row = _db_user_row(username)
    if row and row.get("is_active") and _verify_pw(password, row.get("password_hash") or ""):
        role = row.get("role") or "viewer"
        return {
            "access_token": _sign_token(username, role),
            "token_type": "bearer",
            "user": {
                "username": username,
                "role": role,
                "display_name": row.get("display_name"),
            },
        }
    # Env-var fallback if the DB has no such user (e.g. before first seed)
    if not row and username == ADMIN_USER and password == ADMIN_PASS:
        return {
            "access_token": _sign_token(username, "admin"),
            "token_type": "bearer",
            "user": {"username": username, "role": "admin"},
        }
    raise HTTPException(status_code=401, detail="Invalid credentials")


@router.get("/auth/me")
async def api_me(request: Request):
    auth = request.headers.get("authorization", "")
    data = _verify_token(auth[7:]) if auth.startswith("Bearer ") else None
    if not data:
        raise HTTPException(401, "Not authenticated")
    return data
