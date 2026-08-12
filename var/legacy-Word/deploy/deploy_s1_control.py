# -*- coding: utf-8 -*-
"""Upload S1 control plane into LXD mybox:/home/ubuntu/gongwen-relay/."""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RELAY = HERE / "relay"
LOCAL = HERE / "server.local.md"
HOST = "49.233.190.103"
USER = "ubuntu"
HOSTKEY = "SHA256:+IkvKSm3hyoxIIsG7eqGPI0FTI0F3bX47H0sg0PKhOc"
PLINK = r"C:\Program Files\PuTTY\plink.exe"
PSCP = r"C:\Program Files\PuTTY\pscp.exe"
REMOTE_DIR = "/home/ubuntu/gongwen-relay"
FILES = [
    "control_db.py",
    "control_auth.py",
    "control_gate.py",
    "control_content.py",
    "control_user_tpl.py",
    "control_invite.py",
    "control_org.py",
    "relay_server.py",
    "suggest.py",
    "admin.html",
    "test_control_invite_smoke.py",
    "test_control_org_smoke.py",
    "test_control_user_tpl_smoke.py",
    "start.sh",
    "env.example",
    "README.md",
    "remote_apply_s1.sh",
    "test_control_smoke.py",
    "test_control_http_smoke.py",
    "test_control_boot.py",
    "test_control_admin_smoke.py",
    "test_control_content_smoke.py",
]


def read_pass() -> str:
    text = LOCAL.read_text(encoding="utf-8")
    for line in text.splitlines():
        if "SSH" in line and "密码" in line and "|" in line:
            parts = [p.strip().strip("`") for p in line.split("|") if p.strip()]
            if len(parts) >= 2:
                return parts[-1]
    raise SystemExit("password not found in server.local.md")


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, check=False)
    if r.returncode != 0:
        raise SystemExit("cmd failed: " + " ".join(cmd[:4]) + " ...")


def main() -> int:
    if not Path(PLINK).is_file() or not Path(PSCP).is_file():
        raise SystemExit("PuTTY plink/pscp not found")
    if not LOCAL.is_file():
        raise SystemExit("missing server.local.md")
    password = read_pass()
    common = ["-batch", "-noagent", "-hostkey", HOSTKEY, "-pw", password]

    # 1) pack
    tar_path = Path(tempfile.gettempdir()) / "gongwen-s1.tgz"
    if tar_path.exists():
        tar_path.unlink()
    import tarfile

    with tarfile.open(tar_path, "w:gz") as tf:
        for name in FILES:
            src = RELAY / name
            if not src.is_file():
                raise SystemExit(f"missing {src}")
            tf.add(src, arcname=name)
    print("packed", tar_path, "bytes", tar_path.stat().st_size)

    # 2) upload tarball to host /tmp
    run(
        [PSCP, *common, str(tar_path), f"{USER}@{HOST}:/tmp/gongwen-s1.tgz"]
    )
    print("uploaded tarball to host /tmp")

    # 3) push into mybox + apply
    remote = (
        "set -e; "
        "sudo lxc exec mybox -- mkdir -p /home/ubuntu/gongwen-relay; "
        "sudo lxc file push /tmp/gongwen-s1.tgz mybox/tmp/gongwen-s1.tgz; "
        "sudo lxc exec mybox -- bash -lc "
        "'cd /home/ubuntu/gongwen-relay && tar -xzf /tmp/gongwen-s1.tgz && "
        "bash remote_apply_s1.sh'"
    )
    run([PLINK, "-ssh", *common, f"{USER}@{HOST}", remote])
    print("done. probe health for control=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
