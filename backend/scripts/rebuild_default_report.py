"""Reparse the checked-in HTML and refresh the default API JSON caches."""
import json
import gzip

from app.main import DEFAULT_REPORT_CACHE, DEFAULT_REPLAY_CACHE, build_default_cache


def main() -> None:
    report, replay = build_default_cache()
    DEFAULT_REPORT_CACHE.parent.mkdir(parents=True, exist_ok=True)
    for path, value in ((DEFAULT_REPORT_CACHE, report), (DEFAULT_REPLAY_CACHE, replay)):
        with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as cache:
            json.dump(value, cache, separators=(",", ":"))
            cache.write("\n")
    print(f"Wrote {DEFAULT_REPORT_CACHE}")
    print(f"Wrote {DEFAULT_REPLAY_CACHE}")


if __name__ == "__main__":
    main()
