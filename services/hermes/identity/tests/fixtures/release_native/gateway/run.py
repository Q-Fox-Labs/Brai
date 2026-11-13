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
