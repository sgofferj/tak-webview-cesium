from typing import Any

from app.config import Settings
from app.tak_client import TAKClient


def test_parse_cot_valid_xml() -> None:
    config = Settings()
    client = TAKClient(config, lambda x: None)
    xml_data = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        b'<event version="2.0" uid="test-uid" type="a-f-G-U-C-I" '
        b'time="2024-02-13T14:28:08Z" start="2024-02-13T14:28:07Z" '
        b'stale="2024-02-13T14:28:17Z" how="m-g">'
        b'<point lat="61.25" lon="24.05" hae="112.6" ce="2.0" le="999.0"/>'
        b'<detail><contact callsign="TestUnit"/></detail></event>'
    )
    parsed = client.parse_cot(xml_data)
    assert parsed is not None
    assert parsed["uid"] == "test-uid"
    assert parsed["callsign"] == "TestUnit"
    assert parsed["lat"] == 61.25
    assert parsed["lon"] == 24.05


def test_parse_cot_invalid_xml() -> None:
    config = Settings()
    client = TAKClient(config, lambda x: None)
    xml_data = b"invalid xml"
    parsed = client.parse_cot(xml_data)
    assert parsed is None


def test_parse_cot_emergency() -> None:
    config = Settings()
    client = TAKClient(config, lambda x: None)
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
