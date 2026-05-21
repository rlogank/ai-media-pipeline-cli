# Cost Notes

This CLI can trigger paid API usage from three providers:

- OpenAI for structured prompt planning
- Gemini image generation for still frames
- Vertex AI / Veo for generated videos

Exact pricing changes by provider, model, region, and account terms. Check your provider dashboards before running large batches.

## Default run shape

One successful full run usually requests:

- 1 OpenAI structured prompt plan
- 6 Gemini image generations or edits
- 5 Veo video generations
- Local `ffmpeg` stitching

Retries can multiply those calls.

## Settings that affect spend

- `VEO_DURATION_SECONDS`: higher durations generally cost more.
- `VEO_RESOLUTION`: higher resolution generally costs more.
- `VIDEO_CONCURRENCY`: controls parallel video generation, not total cost, but high concurrency can make spend happen faster.
- `RETRY_MAX_ATTEMPTS`: high retry counts can multiply failed-call costs depending on provider billing behavior.
- Project retries/regeneration: choosing `r` at checkpoints intentionally spends more.

## Practical safeguards

- Start with one small test project.
- Keep `VEO_GENERATE_AUDIO=false` unless you need generated audio.
- Use `VEO_INPUT_MODE=gcs` for reliability, but monitor GCS storage and operation costs.
- Set provider-side budgets and alerts in OpenAI, Google AI Studio, and Google Cloud Billing.
- Delete generated projects and temporary GCS objects you no longer need.

## No cost warranty

This project does not estimate or enforce provider cost limits. Treat every run as potentially billable.
