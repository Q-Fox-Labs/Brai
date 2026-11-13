# Pinned native startup method; external services are supplied by the test.
class GatewayStartup:
    async def _start_recover_previous_run(self) -> None:
        """Plugins, relay, hooks, then crash/clean-exit recovery of processes and sessions."""
        if os.environ.get("BRAI_IDENTITY_MODE") == "telegram":
            return  # Не запускать прежние hooks, плагины и восстановление.
        from gateway.run import _hermes_home
        self._start_register_plugins_relay_hooks()
        # Plugins that load later (force re-discovery, install/enable nudge) re-wire live adapters (#87770).
        with _log_suppressed(logging.WARNING, "plugin re-wire subscription failed", exc_info=True):
            from hermes_cli.plugins import get_plugin_manager
            self._subscribe_plugin_rewire(get_plugin_manager())
        self.hooks.discover_and_load()
        # Recover background processes from checkpoint (crash recovery). ``_checkpoint_path`` is
        # scope-relative, so a served secondary's turn wrote ITS home's processes.json; recover each
        # served profile's file under its scope or those processes are never re-adopted.
        with _log_suppressed(logging.WARNING, "Process checkpoint recovery: %s"):
            from tools.process_registry import process_registry
            recovered = process_registry.recover_from_checkpoint()
            recovered += self._recover_secondary_process_checkpoints(process_registry)
            if recovered:
                logger.info("Recovered %s background process(es) from previous run", recovered)
        # Recover the turns the last process left marked (in flight, or reply not yet ledgered).
        # SKIP after a clean exit — the previous process already drained.
        _clean_marker = _hermes_home / ".clean_shutdown"
        if _clean_marker.exists():
            logger.info("Previous gateway exited cleanly — skipping session suspension")
            try:
                discarded = await self._consume_clean_shutdown_marker(_clean_marker)
            except Exception as exc:
                logger.error(
                    "Clean-start marker cleanup failed; refusing startup so the "
                    "clean-exit receipt cannot mask a later unclean exit: %s", exc,
                )
                raise RuntimeError("clean-start recovery cleanup failed") from exc
            if discarded:
                logger.info("Discarded %d orphan active-turn marker(s) after clean shutdown", discarded)
        else:
            resumed, ledgered = await self._recover_unclean_sessions()
            if resumed + ledgered:
                logger.info(
                    "Recovered %d interrupted turn(s) from previous run (%d to resume, %d reply(ies) "
                    "owed delivery)", resumed + ledgered, resumed, ledgered,
                )
        # Stuck-loop detection: a session active across 3+ consecutive restarts is auto-suspended.
        with _log_suppressed(logging.DEBUG, "Stuck-loop detection failed: %s"):
            # Auto-suspend it so the user gets a clean slate on the next message. See #7536.
            stuck = self._suspend_stuck_loop_sessions()
            if stuck:
                logger.warning("Auto-suspended %d stuck-loop session(s)", stuck)
