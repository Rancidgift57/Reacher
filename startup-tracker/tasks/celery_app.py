"""Celery app + beat schedule (used when SCHEDULER_MODE=celery).

  celery -A tasks.celery_app worker -l info          # add `--pool=solo` on Windows
  celery -A tasks.celery_app beat   -l info
"""
from celery import Celery
from celery.schedules import crontab

from config import get_settings

s = get_settings()
app = Celery("startup_tracker", broker=s.redis_url, backend=s.redis_url, include=["tasks.jobs"])
app.conf.update(
    timezone="UTC",
    task_serializer="json",
    result_expires=86400,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    beat_schedule={
        "daily-pipeline": {
            "task": "tasks.jobs.run_pipeline_task",
            "schedule": crontab(hour=s.pipeline_cron_hour, minute=s.pipeline_cron_minute),
        }
    },
)
