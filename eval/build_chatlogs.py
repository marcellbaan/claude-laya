#!/usr/bin/env python3
"""Extract short coding requests from WildChat as UNLABELLED eval candidates.

WildChat (allenai/WildChat-1M) is licensed ODC-BY 1.0, which allows redistribution of excerpts
with attribution. LMSYS-Chat-1M is deliberately not supported: its licence agreement forbids
transferring the data to third parties.

Standard library only; rows come from the public Hugging Face datasets-server API.

    python3 eval/build_chatlogs.py --scan 3000 --limit 300 --out eval/candidates/chatlogs.jsonl

Output rows carry no label: a human assigns haiku|sonnet|opus and a split before a candidate
moves into eval/data/. Each row keeps `conversation_hash` and `turn_identifier` so a WildChat
deletion request can be honoured. Country, IP hash and other metadata are never copied.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DATASET = "allenai/WildChat-1M"
ATTRIBUTION = f"https://huggingface.co/datasets/{DATASET}"
LICENSE = "ODC-BY-1.0"
API = "https://datasets-server.huggingface.co/rows"
PAGE = 100  # datasets-server maximum

# Requests that read like work for a coding assistant, not general chat.
CODING = re.compile(
    r"\b(code|function|bug|error|exception|stack ?trace|compile|refactor|unit tests?|regex|"
    r"git|python|javascript|typescript|java|rust|golang|c\+\+|sql|bash|shell|api|"
    r"variable|repo|dependency|docker|kubernetes|npm|pip)\b",
    re.IGNORECASE,
)


def fetch(offset, retries=8):
    query = urllib.parse.urlencode(
        {"dataset": DATASET, "config": "default", "split": "train", "offset": offset, "length": PAGE}
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(f"{API}?{query}", timeout=60) as res:
                return json.load(res)["rows"]
        except urllib.error.HTTPError as err:
            if err.code not in (429, 500, 502, 503) or attempt == retries - 1:
                raise
            retry_after = err.headers.get("Retry-After", "")
            wait = int(retry_after) if retry_after.isdigit() else min(2 ** (attempt + 1), 60)
            print(f"HTTP {err.code}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    return []


def candidate(row, min_chars, max_chars):
    """The conversation's first user turn if it is a short, clean, English coding request."""
    if row.get("language") != "English" or row.get("toxic") or row.get("redacted"):
        return None
    first = next((t for t in row.get("conversation", []) if t.get("role") == "user"), None)
    if not first:
        return None
    text = " ".join(first.get("content", "").split())
    if not (min_chars <= len(text) <= max_chars) or not CODING.search(text):
        return None
    return {
        "id": f"wildchat-{row['conversation_hash'][:12]}-{first['turn_identifier']}",
        "prompt": text,
        "source": "wildchat",
        "license": LICENSE,
        "attribution": ATTRIBUTION,
        "conversation_hash": row["conversation_hash"],
        "turn_identifier": first["turn_identifier"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offset", type=int, default=0, help="first dataset row to scan")
    parser.add_argument("--scan", type=int, default=3000, help="dataset rows to scan")
    parser.add_argument("--limit", type=int, default=300, help="maximum candidates to write")
    parser.add_argument("--min-chars", type=int, default=15)
    parser.add_argument("--max-chars", type=int, default=400)
    parser.add_argument("--out", default="eval/candidates/chatlogs.jsonl")
    args = parser.parse_args()

    seen, out = set(), []
    try:
        for offset in range(args.offset, args.offset + args.scan, PAGE):
            rows = fetch(offset)
            if not rows:
                break
            for item in rows:
                c = candidate(item["row"], args.min_chars, args.max_chars)
                if c and c["prompt"].lower() not in seen:
                    seen.add(c["prompt"].lower())
                    out.append(c)
            print(f"scanned {offset + len(rows) - args.offset} rows, {len(out)} candidates", file=sys.stderr)
            if len(out) >= args.limit:
                break
            time.sleep(1)
    except urllib.error.URLError as err:
        # Keep what was collected; rerun with --offset to continue.
        print(f"stopped early ({err}); writing partial results", file=sys.stderr)

    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in out[: args.limit]))
    print(f"wrote {min(len(out), args.limit)} unlabelled candidates to {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
