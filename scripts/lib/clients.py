"""
HTTP clients for SEC EDGAR and Finnhub, with local response caching (for
resumable runs) and rate limiting (SEC: 10 req/s max; Finnhub free tier:
60 req/min max). Every raw response is cached to disk before any parsing
happens, so an interrupted run can resume without re-fetching.
"""
import json
import os
import time
import threading
import urllib.parse
from datetime import datetime, timezone
import requests

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
SEC_CACHE_DIR = os.path.join(CACHE_DIR, "sec")
FINNHUB_CACHE_DIR = os.path.join(CACHE_DIR, "finnhub")

os.makedirs(SEC_CACHE_DIR, exist_ok=True)
os.makedirs(FINNHUB_CACHE_DIR, exist_ok=True)


class RateLimiter:
    """Simple blocking rate limiter: at most `max_per_window` calls per `window_seconds`."""

    def __init__(self, max_per_window, window_seconds):
        self.max_per_window = max_per_window
        self.window_seconds = window_seconds
        self.lock = threading.Lock()
        self.timestamps = []

    def wait(self):
        with self.lock:
            now = time.monotonic()
            self.timestamps = [t for t in self.timestamps if now - t < self.window_seconds]
            if len(self.timestamps) >= self.max_per_window:
                sleep_for = self.window_seconds - (now - self.timestamps[0]) + 0.01
                if sleep_for > 0:
                    time.sleep(sleep_for)
                now = time.monotonic()
                self.timestamps = [t for t in self.timestamps if now - t < self.window_seconds]
            self.timestamps.append(time.monotonic())


class CachedHttpClient:
    def __init__(self, base_headers, rate_limiter, cache_dir, name):
        self.base_headers = base_headers
        self.rate_limiter = rate_limiter
        self.cache_dir = cache_dir
        self.name = name
        self.session = requests.Session()

    def _cache_path(self, cache_key):
        safe = cache_key.replace("/", "_").replace("?", "_").replace("&", "_")
        return os.path.join(self.cache_dir, safe + ".json")

    def get_json(self, url, cache_key, params=None, refresh=False, timeout=30):
        path = self._cache_path(cache_key)
        if not refresh and os.path.exists(path):
            with open(path) as f:
                cached = json.load(f)
            # fetched_at is missing on cache entries written before this field
            # existed; None signals "unknown freshness" rather than a fabricated time.
            return cached["body"], cached.get("status", 200), True, cached.get("fetched_at")

        self.rate_limiter.wait()
        resp = self.session.get(url, headers=self.base_headers, params=params, timeout=timeout)
        try:
            body = resp.json()
        except ValueError:
            body = {"_non_json_text": resp.text[:2000]}

        fetched_at = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            json.dump({"status": resp.status_code, "body": body, "url": resp.url, "fetched_at": fetched_at}, f)

        return body, resp.status_code, False, fetched_at


def make_sec_client(user_agent):
    limiter = RateLimiter(max_per_window=8, window_seconds=1)  # SEC allows 10/s; stay under
    return CachedHttpClient(
        base_headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
        rate_limiter=limiter,
        cache_dir=SEC_CACHE_DIR,
        name="sec",
    )


def make_finnhub_client(api_key):
    limiter = RateLimiter(max_per_window=55, window_seconds=60)  # free tier: 60/min; stay under
    client = CachedHttpClient(
        base_headers={},
        rate_limiter=limiter,
        cache_dir=FINNHUB_CACHE_DIR,
        name="finnhub",
    )
    client.api_key = api_key
    return client


def finnhub_get(client, endpoint, params, cache_key, refresh=False):
    params = dict(params)
    params["token"] = client.api_key
    url = f"https://finnhub.io/api/v1/{endpoint}"
    return client.get_json(url, cache_key, params=params, refresh=refresh)
