#!/usr/bin/env python3
from pathlib import Path
import argparse
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.engine.pipeline.processor import process_uploaded_file

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Input PDF or DXF")
    parser.add_argument("--output-dir", default="server_files/cli_output")
    args = parser.parse_args()

    result = process_uploaded_file(Path(args.input), Path(args.output_dir))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))

if __name__ == "__main__":
    main()
