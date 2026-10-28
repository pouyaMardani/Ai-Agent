"""Throwaway helper: delete whole line ranges from app.py (CRLF preserved).

Ranges are 1-based inclusive line numbers of the ORIGINAL app.py:

    147-285   fetch_url constants block + FetchProblem
    517-552   resolve_workspace_path (read_file only)
    585-627   read_workspace_file (read_file only)
    1054-1944 fetch_url helper section + run_fetch_url + READ_FILE_TOOL
"""

from pathlib import Path

PATH = Path(__file__).resolve().parent / "app.py"

RANGES = [
    (147, 285, "# --- web pages (fetch_url)", ""),
    (517, 552, "def resolve_workspace_path", ""),
    (585, 627, "def read_workspace_file", ""),
    (1054, 1944, "def fetch_failure", ""),
]

text = PATH.read_text(encoding="utf-8", newline="")
lines = text.splitlines(keepends=True)

for start, end, first, _last in RANGES:
    actual = lines[start - 1].rstrip("\r\n")
    if not actual.startswith(first):
        raise SystemExit(f"range {start}-{end}: expected {first!r}, found {actual!r}")
    if not lines[end - 1].strip():
        raise SystemExit(f"range {start}-{end}: last line is not blank")
    print(f"deleting {start}-{end}: {actual[:60]!r} .. {lines[end - 2].strip()[:60]!r}")

keep = [
    line
    for index, line in enumerate(lines, start=1)
    if not any(start <= index <= end for start, end, _, _ in RANGES)
]
PATH.write_text("".join(keep), encoding="utf-8", newline="")
print(f"lines before={len(lines)} after={len(keep)}")
