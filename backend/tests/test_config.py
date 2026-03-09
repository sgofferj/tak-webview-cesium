from app.config import Settings


def test_trusted_proxies_parsing_comma_string() -> None:
    settings = Settings(trusted_proxies="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
    assert settings.trusted_proxies == ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]


def test_trusted_proxies_parsing_json_string() -> None:
    settings = Settings(trusted_proxies='["1.2.3.4", "5.6.7.8"]')
    assert settings.trusted_proxies == ["1.2.3.4", "5.6.7.8"]


def test_trusted_proxies_parsing_list() -> None:
    settings = Settings(trusted_proxies=["1.1.1.1", "2.2.2.2"])
    assert settings.trusted_proxies == ["1.1.1.1", "2.2.2.2"]


def test_trusted_proxies_default() -> None:
    settings = Settings()
    assert settings.trusted_proxies == ["127.0.0.1"]
