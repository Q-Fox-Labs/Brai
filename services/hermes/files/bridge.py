# ABOUTME: Выполняет ограниченный private JSON-RPC к существующему Hermes bridge.
# ABOUTME: Не повторяет запросы и завершает собственную process group при timeout.
import json
import logging
import os
import re
import secrets
import selectors
import signal
import subprocess
import threading
import time

RPC_TIMEOUT = 30

class BridgeError(Exception):
    """Безопасный код ошибки private порта."""

class Bridge:
    """Вызывает ровно один JSON-RPC запрос в отдельном процессе без повторов."""

    def __init__(self, config):
        """Сохранить путь запуска из защищённой конфигурации."""
        self.config = config
        self.slots = threading.BoundedSemaphore(2)

    def call(self, method, params, timeout=RPC_TIMEOUT):
        """Вернуть object result; ограничить ожидание, stdout и размер запроса."""
        started = time.monotonic()
        if timeout <= 0 or not self.slots.acquire(timeout=timeout):
            raise BridgeError("RPC_OVERLOADED")
        try:
            return self._call(method, params, timeout - (time.monotonic() - started))
        finally:
            self.slots.release()

    def _call(self, method, params, timeout):
        # The managed bootstrap provides this in-memory port only to this exact plugin.
        # Legacy gateway launches retain the existing trusted stdio subprocess below.
        import sys
        private = sys.modules.get('_brai_codeworks_gateway')
        if private is not None:
            try:
                port = sys.modules.get('_brai_hermes_file_port')
                if port is None:
                    raise BridgeError('FILES_PORT_NOT_READY')
                return port.call(method, params, timeout)
            except Exception as error:
                code = str(error)
                allowed = {'HUMAN_OUTPUT_REQUIRED', 'HUMAN_FINAL_DECISION_REQUIRED', 'HUMAN_OUTPUT_MAPPING_REQUIRED', 'STALE_ACTION', 'NOT_FOUND'}
                raise BridgeError(code if code in allowed else 'RPC_REJECTED') from None
        request_id = secrets.token_hex(16)
        request = (json.dumps({"jsonrpc": "2.0", "id": request_id,
                               "method": method, "params": params}, ensure_ascii=False) + "\n").encode()
        if len(request) > 65_536 or timeout <= 0:
            raise BridgeError("RPC_LIMIT")
        process = None
        try:
            process = subprocess.Popen([self.config.node, self.config.entry], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
                                       env={**os.environ, **getattr(self.config, 'environment', {})})
            deadline, output, sent = time.monotonic() + timeout, bytearray(), 0
            with selectors.DefaultSelector() as selector:
                for stream, mode in ((process.stdin, selectors.EVENT_WRITE),
                                     (process.stdout, selectors.EVENT_READ)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, mode)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise BridgeError("RPC_TIMEOUT")
                    for key, _ in selector.select(remaining):
                        if key.fileobj is process.stdin:
                            sent += os.write(process.stdin.fileno(), request[sent:])
                            if sent == len(request):
                                selector.unregister(process.stdin)
                                process.stdin.close()
                        else:
                            chunk = os.read(process.stdout.fileno(), 65_536)
                            if not chunk:
                                selector.unregister(process.stdout)
                            else:
                                output.extend(chunk)
                                if len(output) > 1_048_576:
                                    raise BridgeError("RPC_LIMIT")
            process.wait(timeout=max(0.001, deadline - time.monotonic()))
            if process.returncode != 0:
                raise BridgeError("RPC_FAILED")
            lines = output.decode("utf-8", errors="strict").splitlines()
            if len(lines) != 1 or not output.endswith(b"\n"):
                raise BridgeError("RPC_MALFORMED")
            response = json.loads(lines[0])
            if (not isinstance(response, dict) or response.get("jsonrpc") != "2.0"
                    or response.get("id") != request_id
                    or ("result" in response) == ("error" in response)
                    or set(response) - {"jsonrpc", "id", "result", "error"}):
                raise BridgeError("RPC_MALFORMED")
            if "error" in response:
                error = response["error"]
                if (not isinstance(error, dict) or type(error.get("code")) is not int
                        or not isinstance(error.get("message"), str)):
                    raise BridgeError("RPC_MALFORMED")
                if error["code"] == -32000 and isinstance(error.get("data"), dict) and error["data"].get("code") == "HUMAN_OUTPUT_REQUIRED":
                    raise BridgeError("HUMAN_OUTPUT_REQUIRED")
                if error["code"] == -32000 and isinstance(error.get("data"), dict) and error["data"].get("code") in {"HUMAN_FINAL_DECISION_REQUIRED", "HUMAN_OUTPUT_MAPPING_REQUIRED", "STALE_ACTION"}:
                    raise BridgeError(error["data"]["code"])
                code = error.get("data", {}).get("code") if isinstance(error.get("data"), dict) else None
                if method == "files.publish" and isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,80}", code):
                    logging.getLogger(__name__).warning("BRAI_FILE_PUBLISH_REJECTED code=%s", code)
                raise BridgeError("RPC_REJECTED")
            if not isinstance(response["result"], dict):
                raise BridgeError("RPC_MALFORMED")
            return response["result"]
        except BridgeError:
            raise
        except Exception:
            raise BridgeError("RPC_FAILED") from None
        finally:
            if process:
                # AIDEV-NOTE: Private Node запускает publisher child; timeout завершает всю свою группу.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                for stream in (process.stdin, process.stdout):
                    if stream and not stream.closed:
                        stream.close()
