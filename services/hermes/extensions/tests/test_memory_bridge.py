# ABOUTME: Проверяет сроки очереди MemOS bridge и освобождение ресурсов после отмены.
# ABOUTME: Использует синтетические запросы и процессы без сети, модели или профиля.
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


# AIDEV-NOTE: CI без Python-зависимостей проверяет ядро lifecycle отдельно от ASGI.
# Живая HTTP-проверка дополнительно выполняется с закреплённым Starlette/uvicorn.
try:
    import fastapi
except ImportError:
    fastapi = types.ModuleType("fastapi")
    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            self.status_code, self.detail = status_code, detail
    class FastAPI:
        def __init__(self, **kwargs):
            pass
        def get(self, path):
            return lambda fn: fn
        post = get
    fastapi.FastAPI, fastapi.HTTPException, fastapi.Request = FastAPI, HTTPException, object
    sys.modules["fastapi"] = fastapi
    responses = types.ModuleType("fastapi.responses")
    responses.StreamingResponse = object
    sys.modules["fastapi.responses"] = responses

SOURCE = Path(__file__).resolve().parents[2] / "memos/bridge/codex_bridge.py"
spec = importlib.util.spec_from_file_location("memory_bridge_test", SOURCE)
bridge = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {"MEMOS_CODEX_WORKER_DIR": "/nonexistent-neutral",
                            "MEMOS_CODEX_EXECUTABLE": "/nonexistent-codex"}):
    spec.loader.exec_module(bridge)


class Request:
    """Подать управляемое отключение клиента после прочтения тела."""
    def __init__(self, timeout="0.06"):
        self.headers = {"x-memos-timeout-seconds": timeout, "x-memos-stage": "rank"}
        self.disconnected = False
    async def is_disconnected(self):
        return self.disconnected


class BridgeBudgetTests(unittest.IsolatedAsyncioTestCase):
    """Проверить реальные coroutine bridge с заменой только внешней модели."""
    async def asyncSetUp(self):
        bridge.semaphore = asyncio.Semaphore(1)

    async def test_success_returns_result_and_releases_slot(self):
        with patch.object(bridge, "run_codex", new=AsyncMock(return_value=("ok", {}))):
            self.assertEqual(await bridge.complete_with_budget(Request(), "", "", None), ("ok", {}))
        self.assertEqual(bridge.semaphore._value, 1)

    async def test_queued_request_expires_without_starting_model(self):
        await bridge.semaphore.acquire()
        model = AsyncMock()
        with patch.object(bridge, "run_codex", new=model):
            with self.assertRaises(bridge.HTTPException) as error:
                await bridge.complete_with_budget(Request(), "", "", None)
        self.assertEqual(error.exception.status_code, 504)
        model.assert_not_awaited()
        bridge.semaphore.release()
        await asyncio.sleep(0)
        model.assert_not_awaited()

    async def test_queue_and_running_model_use_one_budget(self):
        await bridge.semaphore.acquire()
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def model(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        async def release():
            await asyncio.sleep(0.08)
            bridge.semaphore.release()
        release_task = asyncio.create_task(release())
        begin = asyncio.get_running_loop().time()
        with patch.object(bridge, "run_codex", new=model):
            with self.assertRaises(bridge.HTTPException) as error:
                await bridge.complete_with_budget(Request("0.12"), "", "", None)
        await release_task
        self.assertEqual(error.exception.status_code, 504)
        self.assertTrue(started.is_set())
        self.assertTrue(cleaned.is_set())
        self.assertLess(asyncio.get_running_loop().time() - begin, 0.19)
        self.assertEqual(bridge.semaphore._value, 1)

    async def test_disconnected_client_cancels_running_request(self):
        request = Request("2")
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def model(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        with patch.object(bridge, "run_codex", new=model):
            task = asyncio.create_task(bridge.complete_with_budget(request, "", "", None))
            await started.wait()
            request.disconnected = True
            with self.assertRaises(bridge.HTTPException) as error:
                await task
        self.assertEqual(error.exception.status_code, 499)
        self.assertTrue(cleaned.is_set())
        self.assertEqual(bridge.semaphore._value, 1)

    async def test_disconnected_queued_client_never_starts_later(self):
        await bridge.semaphore.acquire()
        request = Request("2")
        request.disconnected = True
        model = AsyncMock()
        with patch.object(bridge, "run_codex", new=model):
            with self.assertRaises(bridge.HTTPException) as error:
                await bridge.complete_with_budget(request, "", "", None)
        self.assertEqual(error.exception.status_code, 499)
        bridge.semaphore.release()
        await asyncio.sleep(0)
        model.assert_not_awaited()

    async def test_caller_cancellation_cleans_model_before_returning(self):
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def model(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        with patch.object(bridge, "run_codex", new=model):
            task = asyncio.create_task(bridge.complete_with_budget(Request("2"), "", "", None))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(cleaned.is_set())
        self.assertEqual(bridge.semaphore._value, 1)

    async def test_invalid_timeouts_do_not_start_model(self):
        model = AsyncMock()
        with patch.object(bridge, "run_codex", new=model):
            for value in ["nan", "inf", "0", "-1", "invalid"]:
                with self.assertRaises(bridge.HTTPException) as error:
                    await bridge.complete_with_budget(Request(value), "", "", None)
                self.assertEqual(error.exception.status_code, 400)
        model.assert_not_awaited()

    @unittest.skipIf(bridge.Request is object, "Requires operator-provided ASGI dependencies")
    async def test_real_asgi_disconnect_after_json_body_cancels_model(self):
        events = asyncio.Queue()
        events.put_nowait({"type":"http.request", "body":b'{"messages":[]}', "more_body":False})
        request = bridge.Request({"type":"http", "method":"POST", "path":"/v1/chat/completions",
                                  "headers":[(b"x-memos-timeout-seconds", b"2")]}, events.get)
        await request.json()
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def model(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        with patch.object(bridge, "run_codex", new=model):
            task = asyncio.create_task(bridge.complete_with_budget(request, "", "", None))
            await started.wait()
            events.put_nowait({"type":"http.disconnect"})
            with self.assertRaises(bridge.HTTPException) as error:
                await task
        self.assertEqual(error.exception.status_code, 499)
        self.assertTrue(cleaned.is_set())

    async def test_run_codex_terminates_and_reaps_process_on_cancellation(self):
        waiting = asyncio.Event()
        class Writer:
            def write(self, value):
                pass
            async def drain(self):
                pass
        class Process:
            returncode = None
            stdin = Writer()
            def __init__(self):
                self.stdout = self
                self.terminated = self.reaped = False
            async def readline(self):
                waiting.set()
                await asyncio.Event().wait()
            def terminate(self):
                self.terminated = True
            async def wait(self):
                self.reaped = True
                self.returncode = 0
        process = Process()
        with patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=process)):
            task = asyncio.create_task(bridge.run_codex("neutral", "neutral", None))
            await waiting.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(process.terminated)
        self.assertTrue(process.reaped)


if __name__ == "__main__":
    unittest.main()
