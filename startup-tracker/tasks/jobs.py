import asyncio

from tasks.celery_app import app
from tasks.pipeline import run_pipeline


@app.task(name="tasks.jobs.run_pipeline_task", bind=True, max_retries=2, default_retry_delay=600)
def run_pipeline_task(self):
    try:
        return asyncio.run(run_pipeline())
    except Exception as exc:  # retry transient failures (network etc.)
        raise self.retry(exc=exc)
