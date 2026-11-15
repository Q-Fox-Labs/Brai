# ABOUTME: Закреплённая вырезка настоящего native Hermes для regression tests.
# ABOUTME: Не запускает runtime; исходный post-overlay SHA-256 691506cf62dd91a40c1277fb2646875f01dccb21bca86360ed51f9fa5c832567.
def _drain_restart_safe_cron_deliveries(adapters, loop, runner=None) -> None:
    """Drain each profile's worker queue through its matching live adapters. A credential-less satellite
    profile (empty adapter map) drains through the primary's adapters routed by its own profile routes."""
    from hermes_cli.backend_retirement import retirement
    with retirement.work() as admitted:
        if not admitted:
            return
        return _brai_admitted_cron_deliveries(adapters, loop, runner)


def _start_gateway_start_cron_and_housekeeping(runner):
    """Start the cron scheduler thread + gateway housekeeping thread; returns
    ``(cron_stop, cron_provider, cron_thread, housekeeping_thread)``."""
    if os.environ.get("BRAI_IDENTITY_MODE") == "telegram" or (os.environ.get("BRAI_IDENTITY_MODE") == "worker" and __import__("identity.native_policy", fromlist=["guest_mode"]).guest_mode()):
        # Общий gateway не исполняет пользовательские задания и связанные housekeeping jobs.
        runner._brai_release_cron_supported = True
        stop = threading.Event()
        class _DisabledCron:
            def stop(self):
                pass
        cron_thread = threading.Thread(target=stop.wait, daemon=True, name="brai-cron-disabled")
        housekeeping_thread = threading.Thread(target=stop.wait, daemon=True, name="brai-housekeeping-disabled")
        cron_thread.start()
        housekeeping_thread.start()
        return stop, _DisabledCron(), cron_thread, housekeeping_thread
    # The event loop is passed so cron delivery can use live adapters (E2EE support).
    from cron.scheduler_provider import (
        InProcessCronScheduler, resolve_cron_scheduler, scheduler_for_profile_mode)
    cron_stop = threading.Event()
    # ONE gateway process per host multiplexes every profile, so its cron ticker owns EVERY
    # profile's store — `gateway.multiplex_profiles` gates adapters, not cron. Gating the tick set
    # on that flag left every non-launch profile's jobs in a store no ticker visited: they
    # silently never fired.
    try:
        cron_profile_homes = _cron_tick_profile_homes(runner.config)
    except Exception as exc:
        logger.warning("Could not resolve profile homes for cron: %s", exc)
        cron_profile_homes = []
    # External providers own one unscoped remote registry, so they can only serve a single home.
    cron_provider = scheduler_for_profile_mode(
        resolve_cron_scheduler(), multiplex_profiles=len(cron_profile_homes) > 1)
    runner._brai_release_cron_supported = isinstance(cron_provider, InProcessCronScheduler)
    cron_start_kwargs: dict[str, Any] = {"adapters": runner.adapters, "loop": asyncio.get_running_loop()}

    if isinstance(cron_provider, InProcessCronScheduler) and cron_profile_homes:
        # Live enumerator: the ticker re-reads profiles/ every cycle so a profile created while
        # the gateway runs gets its jobs fired without a restart (hot-serve).
        cron_start_kwargs["profile_homes"] = lambda: _cron_tick_profile_homes(runner.config)
        # Stand down, per tick, for a profile whose OWN gateway process ticks it.
        cron_start_kwargs["profile_gate"] = _cron_profile_gate
        # Per-profile adapters so each profile's cron output goes via its own bot, not the
        # default's. Absent (no multiplexed adapters), delivery for a secondary profile falls
        # back to the primary's routed adapters or fails closed — the job still FIRES.
        cron_start_kwargs["profile_adapters"] = getattr(runner, "_profile_adapters", None)
        # runner.adapters belongs to the LAUNCH profile (``default``, or the ``--profile``
        # name); naming it keeps the ticker from routing a secondary's cron through that bot
        # and lets a named multiplexer's own jobs reuse its live adapters.
        cron_start_kwargs["default_profile"] = runner._primary_profile_name
        logger.info(
            "Cron scheduler will tick %d profile(s): %s", len(cron_profile_homes),
            [p[0] if isinstance(p, tuple) else p for p in cron_profile_homes])

    # Only the in-process ticker polls local due jobs, so only it gets the external-drain dispatch gate.
    if isinstance(cron_provider, InProcessCronScheduler):
        cron_start_kwargs["can_dispatch"] = lambda: not (
            runner._draining or runner._external_drain_active)
    # Supervised: a ticker that dies without a stop request is respawned by housekeeping (#111010).
    from cron.scheduler_thread import SupervisedTickerThread
    cron_thread = SupervisedTickerThread(
        cron_provider.start, args=(cron_stop,), kwargs=cron_start_kwargs, stop_event=cron_stop)
    cron_thread.start()

    # External providers fire over loopback HTTP to THIS process's api_server; if it never came up (usually
    # API_SERVER_KEY missing) every fire fails while manual runs work — misread as a job bug. Say it ONCE.
    if not isinstance(cron_provider, InProcessCronScheduler):
        try:
            _has_api_server = Platform.API_SERVER in (runner.adapters or {})
        except Exception:
            _has_api_server = True  # never let the tell break startup
        if not _has_api_server:
            logger.warning(
                "Cron provider '%s' is active but the api_server adapter is "
                "NOT running in this gateway — scheduled fires arrive over "
                "loopback HTTP and will all fail (jobs only run when "
                "triggered manually). Most common cause: API_SERVER_KEY is "
                "missing from this gateway process's environment. Restart "
                "the gateway through its supervisor (`hermes gateway "
                "restart`) so the profile env loads.",
                getattr(cron_provider, "name", "external"))

    # Gateway-only housekeeping runs independently of the cron provider; shares cron_stop for shutdown.
    housekeeping_thread = threading.Thread(
        target=_start_gateway_housekeeping, args=(cron_stop,),
        kwargs={"adapters": runner.adapters, "loop": asyncio.get_running_loop(),
                "cron_provider": cron_provider, "runner": runner, "cron_thread": cron_thread},
        daemon=True, name="gateway-housekeeping")
    housekeeping_thread.start()
    return cron_stop, cron_provider, cron_thread, housekeeping_thread
