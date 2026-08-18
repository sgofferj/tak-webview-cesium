import json
from typing import Any
from unittest.mock import AsyncMock, patch

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
    config = Settings()
    config.use_msgpack = True
    config.ws_throttle = 0  # Disable throttle for testing
    client = TAKClient(config)

    data = {
        "uid": "test-uid",
        "type": "a-f-G",
        "callsign": "TestUnit",
        "lat": 61.25,
        "lon": 24.05,
        "alt": 112.6,
        "stale": "2024-02-13T14:28:17Z",
    }

    with patch(
        "app.tak_client.manager.broadcast", new_callable=AsyncMock
    ) as mock_broadcast:
        await client._broadcast_if_needed(data)
        mock_broadcast.assert_called_once()
        last_payload = mock_broadcast.call_args[0][0]

    assert last_payload is not None
    decoded = msgpack.unpackb(last_payload)

    # Check for minified keys
    assert decoded[KEY_MAP["uid"]] == "test-uid"
    assert decoded[KEY_MAP["type"]] == "a-f-G"
    assert decoded[KEY_MAP["lat"]] == 61.25


@pytest.mark.asyncio
async def test_broadcast_minified_json() -> None:
    # Test minification (Suggestion 5) with JSON fallback
    config = Settings()
    config.use_msgpack = False
    config.ws_throttle = 0
    client = TAKClient(config)

    data = {
        "uid": "test-uid",
        "type": "a-f-G",
        "callsign": "TestUnit",
        "lat": 61.25,
        "lon": 24.05,
        "alt": 112.6,
        "stale": "2024-02-13T14:28:17Z",
    }

    with patch(
        "app.tak_client.manager.broadcast", new_callable=AsyncMock
    ) as mock_broadcast:
        await client._broadcast_if_needed(data)
        mock_broadcast.assert_called_once()
        last_payload = mock_broadcast.call_args[0][0]

    assert last_payload is not None
    decoded = json.loads(last_payload)

    # Check for minified keys
    assert decoded[KEY_MAP["uid"]] == "test-uid"
    assert decoded[KEY_MAP["callsign"]] == "TestUnit"


DELETE_XML = {
    "valid": (
        b'<event version="2.0" uid="a60a0594-1" type="t-x-d-d" '
        b'time="2024-03-04T12:00:00Z" start="2024-03-04T11:59:40Z" '
        b'stale="2024-03-04T12:00:20Z" how="h-g-i-g-o">'
        b'<point ce="9999999" le="9999999" hae="0" lat="0" lon="0"/>'
        b'<detail><link relation="p-p" uid="ANDROID-deadbeef" type="a-f-G-U-C"/>'
        b"</detail></event>"
    ),
    "linkless": (
        b'<event version="2.0" uid="keepalive" type="t-x-d-d" time="" '
        b'how="m-g"><point lat="0" lon="0" hae="0"/></event>'
    ),
    "missing_attrs": (b'<event version="2.0" uid="u2" type="t-x-d-d" time=""></event>'),
}


def test_parse_delete_valid() -> None:
    config = Settings()
    client = TAKClient(config)
    client._chat_contacts["ANDROID-deadbeef"] = {"callsign": "Alpha"}
    removed = client._parse_delete(DELETE_XML["valid"])
    assert removed == ["ANDROID-deadbeef"]
    assert "ANDROID-deadbeef" not in client._chat_contacts


def test_parse_delete_linkless_keepalive_ignored() -> None:
    config = Settings()
    client = TAKClient(config)
    client._chat_contacts["ANDROID-deadbeef"] = {"callsign": "Alpha"}
    removed = client._parse_delete(DELETE_XML["linkless"])
    assert removed == []
    assert "ANDROID-deadbeef" in client._chat_contacts


def test_parse_delete_missing_link_attrs_ignored() -> None:
    config = Settings()
    client = TAKClient(config)
    removed = client._parse_delete(DELETE_XML["missing_attrs"])
    assert removed == []


def test_parse_delete_ignores_own_uid() -> None:
    config = Settings()
    config.tak_uid = "ANDROID-self"
    client = TAKClient(config)
    xml = DELETE_XML["valid"].replace(b"ANDROID-deadbeef", b"ANDROID-self")
    removed = client._parse_delete(xml)
    assert removed == []


def test_parse_delete_invalid_xml() -> None:
    config = Settings()
    client = TAKClient(config)
    assert client._parse_delete(b"not xml") == []


@pytest.mark.asyncio
async def test_apply_delete_broadcasts_cot_delete() -> None:
    config = Settings()
    config.use_msgpack = False
    client = TAKClient(config)
    with patch(
        "app.tak_client.manager.broadcast", new_callable=AsyncMock
    ) as mock_broadcast:
        await client._apply_delete(DELETE_XML["valid"])
    mock_broadcast.assert_called_once()
    payload = mock_broadcast.call_args[0][0]
    assert json.loads(payload) == {"cot_delete": ["ANDROID-deadbeef"]}
