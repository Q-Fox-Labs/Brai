# ABOUTME: Реализует построчный UTF-8 протокол JSON-RPC 2.0 исполнителя GigaAM.
# ABOUTME: Проверяет конверты и именованные параметры без раскрытия деталей распознавания.

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class RpcFault(Exception):
    """Хранить безопасную ошибку JSON-RPC, которую можно вернуть вызывающему коду."""

    code: int
    message: str


Method = Callable[[dict[str, Any]], dict[str, Any]]


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    """Собрать ответ JSON-RPC с ошибкой без поля result."""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def _success(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    """Собрать успешный ответ JSON-RPC без поля error."""
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _valid_id(value: Any) -> bool:
    """Проверить допустимый скалярный идентификатор запроса JSON-RPC."""
    if value is None or isinstance(value, str):
        return True
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return not isinstance(value, float) or math.isfinite(value)


def _handle_request(value: Any, methods: dict[str, Method]) -> dict[str, Any] | None:
    """Обработать запрос; для корректного уведомления вернуть None."""
    if not isinstance(value, dict):
        return _error(None, -32600, "Invalid Request")

    has_id = "id" in value
    request_id = value.get("id")
    if (
        value.get("jsonrpc") != "2.0"
        or not isinstance(value.get("method"), str)
        or (has_id and not _valid_id(request_id))
    ):
        return _error(None, -32600, "Invalid Request")

    notification = not has_id
    method = methods.get(value["method"])
    if method is None:
        return None if notification else _error(request_id, -32601, "Method not found")

    params = value.get("params", {})
    if not isinstance(params, dict):
        return None if notification else _error(request_id, -32602, "Invalid params")

    try:
        result = method(params)
        if not isinstance(result, dict):
            raise TypeError("RPC methods must return objects")
    except RpcFault as fault:
        return None if notification else _error(request_id, fault.code, fault.message)
    except Exception:
        return None if notification else _error(request_id, -32603, "Internal error")

    return None if notification else _success(request_id, result)


def _reject_json_constant(value: str) -> None:
    """Отклонить NaN и Infinity, которые не входят в JSON."""
    raise ValueError(f"Non-JSON constant: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Отклонить повтор ключа вместо молчаливого выбора одного значения."""
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON object key")
        value[key] = item
    return value


def process_line(line: bytes, methods: dict[str, Method]) -> bytes | None:
    """Разобрать один UTF-8 JSON-документ и вернуть строку ответа JSON-RPC."""
    try:
        payload = json.loads(
            line.decode("utf-8", errors="strict"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        response: Any = _error(None, -32700, "Parse error")
    else:
        if isinstance(payload, list):
            if not payload:
                response = _error(None, -32600, "Invalid Request")
            else:
                responses = [
                    item_response
                    for item in payload
                    if (item_response := _handle_request(item, methods)) is not None
                ]
                if not responses:
                    return None
                response = responses
        else:
            response = _handle_request(payload, methods)
            if response is None:
                return None

    return (
        json.dumps(response, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n"
    ).encode("utf-8", errors="strict")
