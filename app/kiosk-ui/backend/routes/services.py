"""Services page routes: status, toggle active, restart, recent logs."""

import asyncio
import json
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/services", tags=["services"])

# Managed-unit allowlist. Sourced from KIOSK_MANAGED_UNITS (set by
# kiosk-ui.nix from the same `managedUnits` list that builds the sudoers
# rule), so adding/removing a unit only needs the Nix edit. Fail closed if
# the env is missing or empty: every restart/start/stop returns 400 rather
# than silently allowing nothing-or-anything.
MANAGED_UNITS = [
    u.strip()
    for u in os.environ.get("KIOSK_MANAGED_UNITS", "").split(",")
    if u.strip()
]


async def _run(*args: str, timeout: float = 3.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return (-1, "", "timeout")
    return (
        proc.returncode or 0,
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
    )


class ServiceDetail(BaseModel):
    name: str
    active: str
    sub_state: str
    recent_logs: list[str]


@router.get("", response_model=list[ServiceDetail], dependencies=[Depends(auth_dep)])
async def list_services() -> list[ServiceDetail]:
    async def _detail(unit: str) -> ServiceDetail:
        rc, out, _ = await _run(
            "systemctl",
            "show",
            unit,
            "--property=ActiveState,SubState",
            "--no-pager",
        )
        active = "unknown"
        sub = "unknown"
        for line in out.splitlines():
            if line.startswith("ActiveState="):
                active = line.split("=", 1)[1]
            elif line.startswith("SubState="):
                sub = line.split("=", 1)[1]

        # Last 5 log lines as plain text
        _, jout, _ = await _run(
            "journalctl",
            "-u",
            unit,
            "--output=short-iso",
            "-n",
            "5",
            "--no-pager",
            timeout=4.0,
        )
        logs = [l for l in jout.splitlines() if l and not l.startswith("--")]

        return ServiceDetail(name=unit, active=active, sub_state=sub, recent_logs=logs)

    return list(await asyncio.gather(*[_detail(u) for u in MANAGED_UNITS]))


class ActionRequest(BaseModel):
    unit: str


@router.post("/restart", dependencies=[Depends(auth_dep)])
async def restart_unit(req: ActionRequest) -> dict[str, str]:
    if req.unit not in MANAGED_UNITS:
        raise HTTPException(status_code=400, detail="unit not in allowlist")
    rc, _, err = await _run("sudo", "systemctl", "restart", req.unit, timeout=10.0)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"restart failed: {err.strip()}")
    return {"status": "ok", "unit": req.unit}


@router.post("/stop", dependencies=[Depends(auth_dep)])
async def stop_unit(req: ActionRequest) -> dict[str, str]:
    if req.unit not in MANAGED_UNITS:
        raise HTTPException(status_code=400, detail="unit not in allowlist")
    # kiosk-ui cannot stop itself gracefully — return error
    if req.unit == "kiosk-ui.service":
        raise HTTPException(status_code=400, detail="cannot stop kiosk-ui from itself")
    rc, _, err = await _run("sudo", "systemctl", "stop", req.unit, timeout=10.0)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"stop failed: {err.strip()}")
    return {"status": "ok", "unit": req.unit}


@router.post("/start", dependencies=[Depends(auth_dep)])
async def start_unit(req: ActionRequest) -> dict[str, str]:
    if req.unit not in MANAGED_UNITS:
        raise HTTPException(status_code=400, detail="unit not in allowlist")
    rc, _, err = await _run("sudo", "systemctl", "start", req.unit, timeout=10.0)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"start failed: {err.strip()}")
    return {"status": "ok", "unit": req.unit}
