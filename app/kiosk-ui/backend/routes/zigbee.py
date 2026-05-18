"""Zigbee routes: pair mode toggle, device count via MQTT."""

import asyncio
import json
import threading
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import auth_dep

router = APIRouter(prefix="/api/zigbee", tags=["zigbee"])

MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1883
TOPIC_PERMIT_JOIN = "zigbee2mqtt/bridge/request/permit_join"
TOPIC_DEVICES = "zigbee2mqtt/bridge/devices"
TOPIC_DEVICE_RENAME = "zigbee2mqtt/bridge/request/device/rename"
TOPIC_DEVICE_REMOVE = "zigbee2mqtt/bridge/request/device/remove"


def _mqtt_get_devices(timeout: float = 4.0) -> list[dict[str, Any]]:
    """Subscribe to bridge/devices (retained), return first message as list."""
    import paho.mqtt.client as mqtt  # type: ignore[import]

    result: list[dict[str, Any]] = []
    done = threading.Event()

    def on_connect(client: Any, _ud: Any, _flags: Any, rc: int) -> None:
        if rc == 0:
            client.subscribe(TOPIC_DEVICES)

    def on_message(_client: Any, _ud: Any, msg: Any) -> None:
        try:
            result.extend(json.loads(msg.payload.decode()))
        except Exception:
            pass
        done.set()

    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=5)
        client.loop_start()
        done.wait(timeout=timeout)
    except Exception:
        pass
    finally:
        client.loop_stop()
        client.disconnect()

    return result


def _mqtt_publish(topic: str, payload: str) -> None:
    import paho.mqtt.publish as publish  # type: ignore[import]

    publish.single(topic, payload, hostname=MQTT_HOST, port=MQTT_PORT)


class ZigbeeStatus(BaseModel):
    device_count: int  # non-coordinator devices
    coordinator_present: bool
    devices: list[dict[str, Any]]


class PairRequest(BaseModel):
    enable: bool
    # Clamp to 0..300s. Z2M takes any non-negative int, but unbounded values
    # let a caller leave pair mode open indefinitely; the kiosk pair button
    # is meant for a brief join window during setup.
    duration_secs: int = Field(default=60, ge=0, le=300)


@router.get("", response_model=ZigbeeStatus, dependencies=[Depends(auth_dep)])
async def get_zigbee() -> ZigbeeStatus:
    loop = asyncio.get_event_loop()
    try:
        devices = await asyncio.wait_for(
            loop.run_in_executor(None, _mqtt_get_devices),
            timeout=6.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MQTT bridge/devices timeout")

    coordinator = [d for d in devices if d.get("type") == "Coordinator"]
    end_devices = [d for d in devices if d.get("type") != "Coordinator"]

    return ZigbeeStatus(
        device_count=len(end_devices),
        coordinator_present=len(coordinator) > 0,
        devices=[
            {
                "ieee_address": d.get("ieee_address", ""),
                "friendly_name": d.get("friendly_name", ""),
                "type": d.get("type", ""),
                "model": (
                    d.get("definition", {}).get("model", "")
                    if d.get("definition")
                    else ""
                ),
                # Interview lifecycle so the kiosk can show "正在識別 / 配對失敗"
                # badges next to each row. z2m newer builds publish
                # `interview_state` ("PENDING" | "IN_PROGRESS" | "SUCCESSFUL"
                # | "FAILED"); older builds only had `interview_completed`
                # plus the deprecated `interviewing` bool. We pass all three
                # through and let the frontend decide which is authoritative.
                "interview_state": d.get("interview_state"),
                "interview_completed": d.get("interview_completed"),
                "interviewing": d.get("interviewing"),
                # `disabled` mirrors the bridge state — a manually-disabled
                # device should look distinct from one that is mid-interview.
                "disabled": d.get("disabled"),
            }
            for d in devices
        ],
    )


@router.post("/permit-join", dependencies=[Depends(auth_dep)])
async def permit_join(req: PairRequest) -> dict[str, object]:
    # Disabling pair mode always implies time=0 — leaving a non-zero
    # duration_secs alongside enable=false is a contradictory payload that
    # z2m would interpret as "leave open for N seconds". Normalise here.
    duration = req.duration_secs if req.enable else 0
    payload = json.dumps({"value": req.enable, "time": duration})
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, _mqtt_publish, TOPIC_PERMIT_JOIN, payload),
            timeout=5.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MQTT publish timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MQTT error: {e}")

    return {
        "status": "ok",
        "permit_join": req.enable,
        "duration_secs": duration,
    }


class RenameRequest(BaseModel):
    # `from_` mirrors the zigbee2mqtt request payload key but is renamed in
    # Python because `from` is a reserved word. The Pydantic alias keeps the
    # JSON shape (`from`) caller-facing.
    from_: str = Field(alias="from", min_length=1, max_length=128)
    to: str = Field(min_length=1, max_length=64)


@router.post("/rename", dependencies=[Depends(auth_dep)])
async def rename_device(req: RenameRequest) -> dict[str, object]:
    # zigbee2mqtt expects {"from": "<ieee_or_old_friendly_name>", "to":
    # "<new_friendly_name>"}. We disable homeassistant rename — this kiosk
    # does not run HA and the bridge would emit a warning. The bridge
    # publishes the result asynchronously; we don't block on confirmation
    # because the kiosk re-fetches /api/zigbee after every action anyway.
    payload = json.dumps(
        {"from": req.from_, "to": req.to, "homeassistant_rename": False}
    )
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, _mqtt_publish, TOPIC_DEVICE_RENAME, payload),
            timeout=5.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MQTT publish timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MQTT error: {e}")

    return {"status": "ok", "from": req.from_, "to": req.to}


class RemoveRequest(BaseModel):
    # `id` is either the friendly_name or the IEEE address — z2m accepts
    # both. We mirror the rename route's caller pattern, where the frontend
    # passes whichever string it displays.
    id: str = Field(min_length=1, max_length=128)
    # `force=true` removes the device from the database even if z2m can't
    # reach it to send the leave command (battery dead, out of range). The
    # kiosk surface defaults this on because the operator-facing motivation
    # for the delete button is "this device is gone, get it out of the list".
    force: bool = True


@router.post("/remove", dependencies=[Depends(auth_dep)])
async def remove_device(req: RemoveRequest) -> dict[str, object]:
    # zigbee2mqtt expects {"id": "<friendly_or_ieee>", "force": bool,
    # "block": bool}. `block=false` lets the same device re-pair later; the
    # kiosk has no UI to unblock so we keep this off.
    payload = json.dumps({"id": req.id, "force": req.force, "block": False})
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, _mqtt_publish, TOPIC_DEVICE_REMOVE, payload),
            timeout=5.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MQTT publish timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MQTT error: {e}")

    return {"status": "ok", "id": req.id, "force": req.force}
