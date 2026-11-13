# ABOUTME: Закреплённая вырезка настоящего native Hermes для regression tests.
# ABOUTME: Не запускает runtime; исходный post-overlay SHA-256 fc7be09e03c523f47604c54542e16732c7e6ec2b72f606770c304d3bbc4bb4de.
class GatewaySessionWatchersMixin:
    async def _session_housekeeping_watcher(self, interval: int = 300):
            """Reclaim resources without ending durable conversations."""
            await asyncio.sleep(60)
            while self._running:
                async with self._brai_release_source():
                    try:
                        await self._session_housekeeping()
                    except Exception as e:
                        logger.debug("Session housekeeping error: %s", e)
                await _interruptible_sleep(self, interval)
