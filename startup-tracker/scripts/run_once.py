"""Run the full pipeline once from the command line:  python -m scripts.run_once"""
import asyncio
import json
import logging

from tasks.pipeline import run_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

if __name__ == "__main__":
    print(json.dumps(asyncio.run(run_pipeline()), indent=2))
