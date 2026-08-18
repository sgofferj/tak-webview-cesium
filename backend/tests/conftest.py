# Point the auth/TAK ephemeral storage at a writable location for tests.
import app.config as config_module

config_module.settings._ephemeral_dir = "/tmp/tak-webview-test-ephemeral"
