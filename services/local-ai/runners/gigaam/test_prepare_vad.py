# ABOUTME: Проверяет ограничения HTTPS и передачи учётных данных в VAD preparer.
# ABOUTME: Использует фиктивные заголовки и не выполняет сетевые запросы.

from __future__ import annotations

import unittest
from email.message import Message
from urllib.request import Request

from prepare_vad import _SafeRedirectHandler, _safe_https_url


class VadDownloadBoundaryTests(unittest.TestCase):
    """Ограничить downloader официальными HTTPS-хостами HF."""

    def test_allows_only_https_hugging_face_hosts_on_default_port(self) -> None:
        """Принимать root и CDN HF, отклонять похожие и локальные адреса."""
        for url in (
            "https://huggingface.co/repo/resolve/revision/file",
            "https://cdn-lfs.huggingface.co/artifact",
            "https://cas-bridge.xethub.hf.co/artifact",
        ):
            with self.subTest(url=url):
                self.assertTrue(_safe_https_url(url))
        for url in (
            "http://huggingface.co/repo",
            "https://huggingface.co.attacker.example/repo",
            "https://user@huggingface.co/repo",
            "https://huggingface.co:8443/repo",
            "https://127.0.0.1/repo",
        ):
            with self.subTest(url=url):
                self.assertFalse(_safe_https_url(url))

    def test_cross_origin_redirect_strips_authorization(self) -> None:
        """Не передавать bearer заголовок с HF origin на file CDN."""
        request = Request(
            "https://huggingface.co/repo/resolve/revision/file",
            headers={"Authorization": "Bearer test-only-placeholder"},
        )
        redirected = _SafeRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            Message(),
            "https://cdn-lfs.huggingface.co/artifact?signature=placeholder",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertIsNone(redirected.get_header("Authorization"))

    def test_refuses_non_hf_redirect_before_request(self) -> None:
        """Отклонить HTTP и loopback цели до создания redirect запроса."""
        request = Request(
            "https://huggingface.co/repo/resolve/revision/file",
            headers={"Authorization": "Bearer test-only-placeholder"},
        )
        for target in (
            "http://127.0.0.1:8080/metadata",
            "https://huggingface.co.attacker.example/file",
        ):
            with self.subTest(target=target):
                self.assertIsNone(
                    _SafeRedirectHandler().redirect_request(
                        request, None, 302, "Found", Message(), target
                    )
                )


if __name__ == "__main__":
    unittest.main()
