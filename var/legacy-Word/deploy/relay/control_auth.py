# -*- coding: utf-8 -*-
"""用户注册登录、短票签发与校验。"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

from control_db import connect, init_db

ACCESS_TTL = 30 * 60
REFRESH_TTL = 30 * 24 * 3600
CAPABILITY_LABELS = {"fast": "标准", "strong": "增强", "proof": "校对"}


def _secret() -> bytes:
    s = (os.environ.get("CONTROL_SECRET") or os.environ.get("RELAY_TOKEN") or "dev-only").strip()
    return s.encode("utf-8")


def _hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 120000
    ).hex()
    return digest, salt


def _verify_password(password: str, pass_hash: str, salt: str) -> bool:
    digest, _ = _hash_password(password, salt)
    return hmac.compare_digest(digest, pass_hash)


def _b64url(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    import base64

    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def mint_access(
    user_id: int,
    plan_code: str,
    capabilities: list[str],
    token_ver: int = 0,
) -> str:
    payload = {
        "uid": user_id,
        "plan": plan_code,
        "caps": capabilities,
        "ver": int(token_ver or 0),
        "iat": int(time.time()),
        "jti": secrets.token_hex(8),
        "exp": int(time.time()) + ACCESS_TTL,
        "typ": "access",
    }
    body = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = _b64url(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    return body + "." + sig


def verify_access(token: str) -> dict[str, Any] | None:
    try:
        body, sig = token.split(".", 1)
    except ValueError:
        return None
    expect = _b64url(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except Exception:
        return None
    if payload.get("typ") != "access":
        return None
    if int(payload.get("exp") or 0) < time.time():
        return None
    return payload


def _user_token_ver(conn, user_id: int) -> int:
    row = conn.execute(
        "SELECT token_ver FROM users WHERE id=?", (int(user_id),)
    ).fetchone()
    if not row:
        return -1
    try:
        return int(row["token_ver"] or 0)
    except Exception:
        return 0


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def register(
    email: str,
    password: str,
    invite_code: str = "",
) -> dict[str, Any]:
    from control_invite import (
        consume_invite,
        peek_invite,
        register_mode,
    )

    init_db()
    mode = register_mode()
    if mode == "closed":
        raise ValueError("当前未开放注册")
    email = (email or "").strip().lower()
    password = password or ""
    if "@" not in email or len(password) < 8:
        raise ValueError("邮箱无效或密码至少 8 位")
    code = (invite_code or "").strip()
    if mode == "invite" and not code:
        raise ValueError("需要邀请码才能注册")
    digest, salt = _hash_password(password)
    now = time.time()
    with connect() as conn:
        invite = None
        if code:
            invite = peek_invite(conn, code)
            if not invite:
                raise ValueError("邀请码无效")
        elif mode == "invite":
            raise ValueError("需要邀请码才能注册")
        try:
            cur = conn.execute(
                "INSERT INTO users(email,pass_hash,pass_salt,status,created_at) VALUES(?,?,?,?,?)",
                (email, digest, salt, "active", now),
            )
        except Exception:
            raise ValueError("该邮箱已注册") from None
        uid = int(cur.lastrowid)
        plan_code = str(invite["plan_code"]) if invite else "free"
        plan = conn.execute(
            "SELECT id FROM plans WHERE code=?", (plan_code,)
        ).fetchone()
        if not plan:
            raise ValueError("套餐未初始化：" + plan_code)
        # 试用 / 邀请开通 30 天
        conn.execute(
            "INSERT INTO subscriptions(user_id,plan_id,expire_at,created_at) VALUES(?,?,?,?)",
            (uid, int(plan["id"]), now + 30 * 86400, now),
        )
        if invite:
            consume_invite(conn, int(invite["id"]))
        conn.commit()
    return login(email, password)


def _user_plan(conn, user_id: int) -> tuple[str, list[str], dict]:
    row = conn.execute(
        """
        SELECT p.code, p.capabilities, p.monthly_requests, p.daily_requests, p.max_chars, s.expire_at
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.user_id=?
        """,
        (user_id,),
    ).fetchone()
    if not row or float(row["expire_at"]) < time.time():
        return "none", [], {
            "monthly_requests": 0,
            "daily_requests": 0,
            "max_chars": 0,
            "expire_at": 0,
        }
    caps = [c.strip() for c in str(row["capabilities"] or "").split(",") if c.strip()]
    return (
        str(row["code"]),
        caps,
        {
            "monthly_requests": int(row["monthly_requests"]),
            "daily_requests": int(row["daily_requests"]),
            "max_chars": int(row["max_chars"]),
            "expire_at": float(row["expire_at"]),
        },
    )


def _session_payload(
    *,
    uid: int,
    email: str,
    access: str,
    refresh: str,
    plan_code: str,
    caps: list[str],
    plan_meta: dict,
) -> dict[str, Any]:
    return {
        "ok": True,
        "access_token": access,
        "refresh_token": refresh,
        "expires_in": ACCESS_TTL,
        "user": {"id": uid, "email": email},
        "plan": {"code": plan_code, "capabilities": caps, **plan_meta},
        "capability_labels": dict(CAPABILITY_LABELS),
    }


def login(email: str, password: str, device_id: str = "") -> dict[str, Any]:
    init_db()
    email = (email or "").strip().lower()
    with connect() as conn:
        user = conn.execute(
            "SELECT id,pass_hash,pass_salt,status FROM users WHERE email=?",
            (email,),
        ).fetchone()
        if not user or user["status"] != "active":
            raise ValueError("账号或密码错误")
        if not _verify_password(password, user["pass_hash"], user["pass_salt"]):
            raise ValueError("账号或密码错误")
        uid = int(user["id"])
        plan_code, caps, plan_meta = _user_plan(conn, uid)
        if plan_code == "none":
            raise ValueError("订阅已过期，请联系开通")
        ver = _user_token_ver(conn, uid)
        refresh = secrets.token_urlsafe(32)
        now = time.time()
        conn.execute(
            "INSERT INTO refresh_tokens(user_id,token_hash,device_id,expires_at,revoked,created_at)"
            " VALUES(?,?,?,?,0,?)",
            (uid, _hash_token(refresh), device_id or "", now + REFRESH_TTL, now),
        )
        conn.commit()
    access = mint_access(uid, plan_code, caps, ver)
    return _session_payload(
        uid=uid,
        email=email,
        access=access,
        refresh=refresh,
        plan_code=plan_code,
        caps=caps,
        plan_meta=plan_meta,
    )


def refresh(refresh_token: str, device_id: str = "") -> dict[str, Any]:
    init_db()
    raw = (refresh_token or "").strip()
    if not raw:
        raise ValueError("缺少 refresh_token")
    with connect() as conn:
        row = conn.execute(
            "SELECT id,user_id,expires_at,revoked FROM refresh_tokens WHERE token_hash=?",
            (_hash_token(raw),),
        ).fetchone()
        if not row or int(row["revoked"]) or float(row["expires_at"]) < time.time():
            raise ValueError("登录已失效，请重新登录")
        uid = int(row["user_id"])
        user = conn.execute(
            "SELECT email,status FROM users WHERE id=?", (uid,)
        ).fetchone()
        if not user or user["status"] != "active":
            raise ValueError("账号不可用")
        plan_code, caps, plan_meta = _user_plan(conn, uid)
        if plan_code == "none":
            raise ValueError("订阅已过期")
        ver = _user_token_ver(conn, uid)
        # 轮换 refresh
        conn.execute(
            "UPDATE refresh_tokens SET revoked=1 WHERE id=?", (int(row["id"]),)
        )
        new_refresh = secrets.token_urlsafe(32)
        now = time.time()
        conn.execute(
            "INSERT INTO refresh_tokens(user_id,token_hash,device_id,expires_at,revoked,created_at)"
            " VALUES(?,?,?,?,0,?)",
            (uid, _hash_token(new_refresh), device_id or "", now + REFRESH_TTL, now),
        )
        conn.commit()
    access = mint_access(uid, plan_code, caps, ver)
    return _session_payload(
        uid=uid,
        email=str(user["email"]),
        access=access,
        refresh=new_refresh,
        plan_code=plan_code,
        caps=caps,
        plan_meta=plan_meta,
    )


def revoke_user_sessions(user_id: int) -> int:
    init_db()
    with connect() as conn:
        conn.execute(
            "UPDATE users SET token_ver=COALESCE(token_ver,0)+1 WHERE id=?",
            (int(user_id),),
        )
        cur = conn.execute(
            "UPDATE refresh_tokens SET revoked=1 WHERE user_id=? AND revoked=0",
            (user_id,),
        )
        conn.commit()
        return cur.rowcount


def set_user_status(email: str, status: str) -> dict[str, Any]:
    """运维：active | disabled。禁用时吊销全部 refresh。"""
    init_db()
    status = (status or "").strip().lower()
    if status not in ("active", "disabled"):
        raise ValueError("status 仅支持 active|disabled")
    email = (email or "").strip().lower()
    with connect() as conn:
        user = conn.execute(
            "SELECT id FROM users WHERE email=?", (email,)
        ).fetchone()
        if not user:
            raise ValueError("用户不存在")
        uid = int(user["id"])
        conn.execute("UPDATE users SET status=? WHERE id=?", (status, uid))
        conn.commit()
    revoked = 0
    if status == "disabled":
        revoked = revoke_user_sessions(uid)
    return {"ok": True, "email": email, "status": status, "revoked_sessions": revoked}


def find_user_id(email: str) -> int | None:
    init_db()
    email = (email or "").strip().lower()
    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM users WHERE email=?", (email,)
        ).fetchone()
    return int(row["id"]) if row else None


def user_is_active(user_id: int) -> bool:
    init_db()
    with connect() as conn:
        row = conn.execute(
            "SELECT status FROM users WHERE id=?", (int(user_id),)
        ).fetchone()
    return bool(row) and str(row["status"]) == "active"


def access_still_valid(payload: dict[str, Any]) -> bool:
    """status + token_ver 双重校验（踢人立刻作废短票）。"""
    if not payload:
        return False
    uid = int(payload.get("uid") or 0)
    if not uid or not user_is_active(uid):
        return False
    init_db()
    with connect() as conn:
        ver = _user_token_ver(conn, uid)
    return int(payload.get("ver") or 0) == int(ver)


def list_users(limit: int = 100) -> list[dict[str, Any]]:
    init_db()
    limit = max(1, min(500, int(limit or 100)))
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.email, u.status, u.created_at,
                   p.code AS plan, s.expire_at
            FROM users u
            LEFT JOIN subscriptions s ON s.user_id=u.id
            LEFT JOIN plans p ON p.id=s.plan_id
            ORDER BY u.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def grant_subscription(
    email: str,
    plan_code: str = "pro",
    days: int = 30,
) -> dict[str, Any]:
    """运维：给人开通/续期套餐。"""
    init_db()
    email = (email or "").strip().lower()
    plan_code = (plan_code or "pro").strip().lower()
    days = max(1, int(days or 30))
    with connect() as conn:
        user = conn.execute(
            "SELECT id,status FROM users WHERE email=?", (email,)
        ).fetchone()
        if not user:
            raise ValueError("用户不存在")
        plan = conn.execute(
            "SELECT id FROM plans WHERE code=?", (plan_code,)
        ).fetchone()
        if not plan:
            raise ValueError("套餐不存在：" + plan_code)
        uid = int(user["id"])
        now = time.time()
        sub = conn.execute(
            "SELECT id,expire_at FROM subscriptions WHERE user_id=?", (uid,)
        ).fetchone()
        base = now
        if sub and float(sub["expire_at"]) > now:
            base = float(sub["expire_at"])
        expire = base + days * 86400
        if sub:
            conn.execute(
                "UPDATE subscriptions SET plan_id=?, expire_at=? WHERE id=?",
                (int(plan["id"]), expire, int(sub["id"])),
            )
        else:
            conn.execute(
                "INSERT INTO subscriptions(user_id,plan_id,expire_at,created_at) VALUES(?,?,?,?)",
                (uid, int(plan["id"]), expire, now),
            )
        if user["status"] != "active":
            conn.execute("UPDATE users SET status='active' WHERE id=?", (uid,))
        conn.commit()
    return {
        "ok": True,
        "email": email,
        "plan": plan_code,
        "expire_at": expire,
        "days_added": days,
    }


def me(access_payload: dict[str, Any]) -> dict[str, Any]:
    init_db()
    uid = int(access_payload["uid"])
    with connect() as conn:
        user = conn.execute(
            "SELECT email,status FROM users WHERE id=?", (uid,)
        ).fetchone()
        plan_code, caps, plan_meta = _user_plan(conn, uid)
    return {
        "ok": True,
        "user": {"id": uid, "email": user["email"] if user else "", "status": user["status"] if user else ""},
        "plan": {"code": plan_code, "capabilities": caps, **plan_meta},
        "capability_labels": dict(CAPABILITY_LABELS),
    }
