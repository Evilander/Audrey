import pytest


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: requires running Audrey server")
    config.addinivalue_line("markers", "asyncio: async test")
