"""UTC ISO 8601 timestamp helpers: millisecond precision, trailing Z, per output-contract.md."""

from datetime import datetime, timezone


def now_utc():
    return datetime.now(timezone.utc)


def iso_utc(dt):
    """Format a datetime as ISO 8601 UTC with millisecond precision and a trailing Z."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_iso(s):
    """Parse an ISO 8601 UTC timestamp, with or without fractional seconds or a trailing Z."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def compact_utc(dt):
    """Compact form used in conjunction ids, e.g. 20260824T031522Z."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")
