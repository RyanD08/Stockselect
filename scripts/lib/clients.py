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
EPA_ECHO_CACHE_DIR = os.path.join(CACHE_DIR, "epa_echo")
OSHA_CACHE_DIR = os.path.join(CACHE_DIR, "osha")
NLRB_CACHE_DIR = os.path.join(CACHE_DIR, "nlrb")
FOSSIL_FREE_FUNDS_CACHE_DIR = os.path.join(CACHE_DIR, "fossil_free_funds")
WIKIPEDIA_CACHE_DIR = os.path.join(CACHE_DIR, "wikipedia")
SEC_PROXY_CACHE_DIR = os.path.join(CACHE_DIR, "sec_proxy")
BLS_CACHE_DIR = os.path.join(CACHE_DIR, "bls")

os.makedirs(SEC_CACHE_DIR, exist_ok=True)
os.makedirs(FINNHUB_CACHE_DIR, exist_ok=True)
os.makedirs(EPA_ECHO_CACHE_DIR, exist_ok=True)
os.makedirs(OSHA_CACHE_DIR, exist_ok=True)
os.makedirs(NLRB_CACHE_DIR, exist_ok=True)
os.makedirs(FOSSIL_FREE_FUNDS_CACHE_DIR, exist_ok=True)
os.makedirs(WIKIPEDIA_CACHE_DIR, exist_ok=True)
os.makedirs(SEC_PROXY_CACHE_DIR, exist_ok=True)
os.makedirs(BLS_CACHE_DIR, exist_ok=True)


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

    def _get_with_429_retry(self, url, params, timeout, max_retries=4):
        """A 429 means the rate limit was already too aggressive for this
        run; back off with growing delays rather than caching a spurious
        failure that a resume run would then treat as a real "no data"."""
        delay = 2.0
        for attempt in range(max_retries + 1):
            resp = self.session.get(url, headers=self.base_headers, params=params, timeout=timeout)
            if resp.status_code != 429 or attempt == max_retries:
                return resp
            time.sleep(delay)
            delay *= 2
        return resp

    def get_json(self, url, cache_key, params=None, refresh=False, timeout=30):
        path = self._cache_path(cache_key)
        if not refresh and os.path.exists(path):
            with open(path) as f:
                cached = json.load(f)
            # fetched_at is missing on cache entries written before this field
            # existed; None signals "unknown freshness" rather than a fabricated time.
            return cached["body"], cached.get("status", 200), True, cached.get("fetched_at")

        self.rate_limiter.wait()
        resp = self._get_with_429_retry(url, params, timeout)
        try:
            body = resp.json()
        except ValueError:
            body = {"_non_json_text": resp.text[:2000]}

        fetched_at = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            json.dump({"status": resp.status_code, "body": body, "url": resp.url, "fetched_at": fetched_at}, f)

        return body, resp.status_code, False, fetched_at

    def post_text(self, url, cache_key, data=None, refresh=False, timeout=30):
        """Like get_text but POSTs form data -- used for the NLRB case search,
        which is a Drupal form that only returns filtered results on POST."""
        path = self._cache_path(cache_key)
        if not refresh and os.path.exists(path):
            with open(path) as f:
                cached = json.load(f)
            return cached["body"], cached.get("status", 200), True, cached.get("fetched_at")

        self.rate_limiter.wait()
        resp = self.session.post(url, headers=self.base_headers, data=data, timeout=timeout)
        body = resp.text

        fetched_at = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            json.dump({"status": resp.status_code, "body": body, "url": resp.url, "fetched_at": fetched_at}, f)

        return body, resp.status_code, False, fetched_at

    def get_text(self, url, cache_key, params=None, refresh=False, timeout=30):
        """Like get_json but for HTML endpoints (OSHA/NLRB scraping) --
        caches raw response text instead of parsed JSON."""
        path = self._cache_path(cache_key)
        if not refresh and os.path.exists(path):
            with open(path) as f:
                cached = json.load(f)
            return cached["body"], cached.get("status", 200), True, cached.get("fetched_at")

        self.rate_limiter.wait()
        resp = self._get_with_429_retry(url, params, timeout)
        body = resp.text

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


# --- Free ESG data source clients -------------------------------------------
# No API keys required for any of these (confirmed). All are ~1 req/sec,
# government/nonprofit sites with no documented rate limit, so we self-impose
# a conservative limiter and a descriptive contact string in the User-Agent,
# the same courtesy this project already extends to SEC EDGAR.

def make_epa_echo_client(contact):
    limiter = RateLimiter(max_per_window=1, window_seconds=1)
    return CachedHttpClient(
        base_headers={"User-Agent": f"Stockselect ESG Research ({contact})"},
        rate_limiter=limiter,
        cache_dir=EPA_ECHO_CACHE_DIR,
        name="epa_echo",
    )


def make_osha_client(contact):
    limiter = RateLimiter(max_per_window=1, window_seconds=1)
    return CachedHttpClient(
        base_headers={"User-Agent": f"Stockselect ESG Research ({contact})"},
        rate_limiter=limiter,
        cache_dir=OSHA_CACHE_DIR,
        name="osha",
    )


def make_nlrb_client(contact):
    limiter = RateLimiter(max_per_window=1, window_seconds=1)
    return CachedHttpClient(
        base_headers={"User-Agent": f"Stockselect ESG Research ({contact})"},
        rate_limiter=limiter,
        cache_dir=NLRB_CACHE_DIR,
        name="nlrb",
    )


# --- Additional approved-source clients (fossilfreefunds, Wikipedia, SEC
# proxy/8-K, BLS) added for the aggressive multi-source mining pass. Same
# courtesy self-imposed rate limits as the clients above; none of these
# sites document a rate limit or require an API key.

def make_fossil_free_funds_client(contact):
    # api.fossilfreefunds.org is a small loopback/Node API (not a CDN-backed
    # static site like the others) -- stay conservative.
    limiter = RateLimiter(max_per_window=2, window_seconds=1)
    return CachedHttpClient(
        base_headers={
            "User-Agent": f"Stockselect ESG Research ({contact})",
            "Accept": "application/json",
        },
        rate_limiter=limiter,
        cache_dir=FOSSIL_FREE_FUNDS_CACHE_DIR,
        name="fossil_free_funds",
    )


def make_wikipedia_client(contact):
    # Started at 5 req/s; in practice Wikimedia returned 429s well before
    # that budget was exhausted (bursty client-side throttling on the
    # w/api.php endpoints in particular), so this is deliberately conservative.
    limiter = RateLimiter(max_per_window=1, window_seconds=1)
    return CachedHttpClient(
        base_headers={"User-Agent": f"Stockselect ESG Research ({contact})"},
        rate_limiter=limiter,
        cache_dir=WIKIPEDIA_CACHE_DIR,
        name="wikipedia",
    )


def make_sec_proxy_client(user_agent):
    # Full DEF 14A documents are large (1-5MB); reuse the SEC's own courtesy
    # rate limit (10 req/s max) but stay a little under it since these are
    # bigger payloads than the XBRL/submissions calls.
    limiter = RateLimiter(max_per_window=6, window_seconds=1)
    return CachedHttpClient(
        base_headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
        rate_limiter=limiter,
        cache_dir=SEC_PROXY_CACHE_DIR,
        name="sec_proxy",
    )


def make_bls_client(contact):
    limiter = RateLimiter(max_per_window=1, window_seconds=1)
    return CachedHttpClient(
        base_headers={"User-Agent": f"Stockselect ESG Research ({contact})"},
        rate_limiter=limiter,
        cache_dir=BLS_CACHE_DIR,
        name="bls",
    )
