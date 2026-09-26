"""Dalal market-data layer.

    from marketdata import MarketService, symbols, calendar, validate

Public shape:

    providers.MarketDataProvider   interface (NSEProvider, YahooFinanceProvider)
    providers.ProviderChain        ordered fallback; records who answered
    store.Store                    SQLite cache of last-known-good values
    service.MarketService          refresh policy + every JSON payload
    symbols                        canonical symbols and provider tickers
    calendar                       IST trading calendar (holidays, sessions)
    validate                       quote validation, change maths, freshness

The web layer (server.py) is a thin HTTP adapter over MarketService; the
frontend only ever sees validated, timestamped, provider-attributed JSON.
"""
from __future__ import annotations

from . import calendar, config, providers, service, store, symbols, validate

__all__ = ["config", "symbols", "calendar", "validate", "providers", "store",
           "service", "MarketService", "MarketDataProvider", "ProviderChain"]

MarketService = service.MarketService
MarketDataProvider = providers.MarketDataProvider
ProviderChain = providers.ProviderChain
Store = store.Store
