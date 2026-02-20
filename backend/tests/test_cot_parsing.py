import json
from typing import Any

import msgpack  # type: ignore
import pytest

from app.config import Settings
from app.tak_client import KEY_MAP, TAKClient


def test_parse_cot_valid_xml() -> None:
    config = Settings()
    client = TAKClient(config)
    xml_data = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        b'<event version="2.0" uid="test-uid" type="a-f-G-U-C-I" '
        b'time="2024-02-13T14:28:08Z" start="2024-02-13T14:28:07Z" '
        b'stale="2024-02-13T14:28:17Z" how="m-g">'
        b'<point lat="61.250000001" lon="24.050000001" '
        b'hae="112.645" ce="2.0" le="999.0"/>'
        b'<detail><contact callsign="TestUnit"/></detail></event>'
    )
    parsed = client.parse_cot(xml_data)
    assert parsed is not None
    assert parsed["uid"] == "test-uid"
    assert parsed["callsign"] == "TestUnit"
    # Suggestion 3: Rounding
    assert parsed["lat"] == 61.25
    assert parsed["lon"] == 24.05
    assert parsed["alt"] == 112.6


def test_parse_cot_invalid_xml() -> None:
    config = Settings()
    client = TAKClient(config)
    xml_data = b"invalid xml"
    parsed = client.parse_cot(xml_data)
    assert parsed is None


def test_parse_cot_emergency() -> None:
    config = Settings()
    client = TAKClient(config)
    xml_data = (
        b'<?xml version="1.0" encoding="UTF-8"?><event uid="911-uid" '
        b'type="b-a-o-tbl"><point lat="61.0" lon="24.0" hae="100.0"/>'
        b'<detail><contact callsign="Wolfman-Alert"/><emergency type="911 Alert">'
        b"Wolfman</emergency></detail></event>"
    )
    parsed: Any = client.parse_cot(xml_data)
    assert parsed is not None
    assert parsed["emergency"]["status"] == "active"
    assert parsed["callsign"] == "Wolfman"


@pytest.mark.asyncio
async def test_broadcast_minified_msgpack() -> None:
    # Test minification (Suggestion 5) and MessagePack (Suggestion 4)
    last_payload = None

    async def mock_broadcast(payload: bytes) -> None:
        nonlocal last_payload
        last_payload = payload

    config = Settings()
    config.use_msgpack = True
    config.ws_throttle = 0  # Disable throttle for testing
    client = TAKClient(config, mock_broadcast)

    data = {
        "uid": "test-uid",
        "type": "a-f-G",
        "callsign": "TestUnit",
        "lat": 61.25,
        "lon": 24.05,
        "alt": 112.6,
        "stale": "2024-02-13T14:28:17Z",
    }

    await client._broadcast_if_needed(data)

    assert last_payload is not None
    decoded = msgpack.unpackb(last_payload)

    # Check for minified keys
    assert decoded[KEY_MAP["uid"]] == "test-uid"
    assert decoded[KEY_MAP["type"]] == "a-f-G"
    assert decoded[KEY_MAP["lat"]] == 61.25


@pytest.mark.asyncio
async def test_broadcast_minified_json() -> None:
    # Test minification (Suggestion 5) with JSON fallback
    last_payload = None

    async def mock_broadcast(payload: str) -> None:
        nonlocal last_payload
        last_payload = payload

    config = Settings()
    config.use_msgpack = False
    config.ws_throttle = 0
    client = TAKClient(config, mock_broadcast)

    data = {
        "uid": "test-uid",
        "type": "a-f-G",
        "callsign": "TestUnit",
        "lat": 61.25,
        "lon": 24.05,
        "alt": 112.6,
        "stale": "2024-02-13T14:28:17Z",
    }

    await client._broadcast_if_needed(data)

    assert last_payload is not None
    decoded = json.loads(last_payload)

    # Check for minified keys
    assert decoded[KEY_MAP["uid"]] == "test-uid"
    assert decoded[KEY_MAP["callsign"]] == "TestUnit"
