# ABOUTME: Проверяет кадрирование и конверты JSON-RPC дочернего GigaAM.
# ABOUTME: Использует внедрённые методы и стандартный модуль unittest.

from __future__ import annotations

import json
import unittest

from rpc import RpcFault, process_line


def _health(params: dict[str, object]) -> dict[str, object]:
    """Вернуть готовность для проверки только протокола."""
    if params:
        raise RpcFault(-32602, "Invalid params")
    return {"ready": True}


class JsonRpcTest(unittest.TestCase):
    """Проверить запросы, batch, уведомления и UTF-8 ответы."""

    def setUp(self) -> None:
        self.methods = {"health": _health}

    def response(self, line: bytes) -> object:
        """Разобрать строку ответа протокола."""
        result = process_line(line, self.methods)
        self.assertIsNotNone(result)
        return json.loads(result)

    def test_success_echoes_string_and_numeric_ids(self) -> None:
        for request_id in ("request-1", 42):
            with self.subTest(request_id=request_id):
                response = self.response(
                    json.dumps(
                        {"jsonrpc": "2.0", "method": "health", "params": {}, "id": request_id}
                    ).encode()
                )
                self.assertEqual(response["id"], request_id)
                self.assertEqual(response["result"], {"ready": True})
                self.assertNotIn("error", response)

    def test_optional_params_default_to_an_empty_object(self) -> None:
        response = self.response(b'{"jsonrpc":"2.0","method":"health","id":1}')
        self.assertEqual(response["result"], {"ready": True})

    def test_nonempty_health_params_are_rejected(self) -> None:
        response = self.response(b'{"jsonrpc":"2.0","method":"health","params":{"x":1},"id":1}')
        self.assertEqual((response["id"], response["error"]["code"]), (1, -32602))

    def test_parse_error_has_null_id_and_no_result(self) -> None:
        response = self.response(b"{broken")
        self.assertEqual(response["id"], None)
        self.assertEqual(response["error"]["code"], -32700)
        self.assertNotIn("result", response)

    def test_duplicate_keys_are_parse_errors(self) -> None:
        response = self.response(
            b'{"jsonrpc":"2.0","method":"health","params":{},"id":1,"id":2}'
        )
        self.assertEqual((response["id"], response["error"]["code"]), (None, -32700))

    def test_nonfinite_request_ids_are_invalid_requests(self) -> None:
        response = self.response(b'{"jsonrpc":"2.0","method":"health","params":{},"id":1e999}')
        self.assertEqual((response["id"], response["error"]["code"]), (None, -32600))

    def test_unknown_method_and_params_keep_request_id(self) -> None:
        unknown = self.response(b'{"jsonrpc":"2.0","method":"missing","params":{},"id":"x"}')
        invalid = self.response(b'{"jsonrpc":"2.0","method":"health","params":{"x":1},"id":7}')
        self.assertEqual((unknown["id"], unknown["error"]["code"]), ("x", -32601))
        self.assertEqual((invalid["id"], invalid["error"]["code"]), (7, -32602))

    def test_notifications_never_emit_responses(self) -> None:
        self.assertIsNone(process_line(b'{"jsonrpc":"2.0","method":"health","params":{}}', self.methods))
        self.assertIsNone(process_line(b'{"jsonrpc":"2.0","method":"missing","params":{}}', self.methods))

    def test_batch_preserves_order_and_omits_notification(self) -> None:
        response = self.response(
            b'[{"jsonrpc":"2.0","method":"health","params":{},"id":1},'
            b'{"jsonrpc":"2.0","method":"missing","params":{},"id":2},'
            b'{"jsonrpc":"2.0","method":"health","params":{}}]'
        )
        self.assertEqual([item["id"] for item in response], [1, 2])
        self.assertEqual([item.get("result", {}).get("ready") for item in response], [True, None])

    def test_empty_batch_is_invalid_request(self) -> None:
        response = self.response(b"[]")
        self.assertEqual((response["id"], response["error"]["code"]), (None, -32600))

    def test_response_is_utf8_json(self) -> None:
        methods = {"text": lambda _params: {"text": "Привет"}}
        response = process_line(b'{"jsonrpc":"2.0","method":"text","params":{},"id":"ru"}', methods)
        self.assertIn("Привет".encode("utf-8"), response)
        self.assertEqual(json.loads(response)["result"]["text"], "Привет")

    def test_invalid_utf8_is_parse_error(self) -> None:
        response = self.response(b"\xff")
        self.assertEqual((response["id"], response["error"]["code"]), (None, -32700))


if __name__ == "__main__":
    unittest.main()
