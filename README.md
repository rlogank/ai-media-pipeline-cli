# AI Media Pipeline CLI

A Node.js CLI for generating consistent multi-step image and video sequences with:

- OpenAI for structured prompt planning
- Gemini image generation for six still frames
- Veo on Vertex AI for five first-frame/last-frame video transitions
- `ffmpeg` for final video stitching

The default workflow creates a 6-image, 5-video sequence and stores resumable run state in `projects/<project-name>`.

## Use cases

- Physical build or installation progressions
- Before/after transformations
- Product, space, or environment evolution sequences
- Repeatable AI video experiments with saved prompts and state

## Requirements

- Node.js 18+
- `ffmpeg` available on your `PATH`
- OpenAI API key
- Gemini API key
- Google Cloud project with Vertex AI access and Application Default Credentials
- A GCS bucket for Veo input/output is recommended

Authenticate Google Cloud locally:

```bash
gcloud auth application-default login
```

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`, especially:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_CLOUD_PROJECT`
- `VEO_STORAGE_URI`

## Run

Interactive:

```bash
npm start
```

With flags:

```bash
node src/cli.js --project "garden-studio-001" --mode build --description "backyard garden studio from empty pad to finished workspace"
```

Transformation mode:

```bash
node src/cli.js --project "room-refresh-001" --mode transformation --description "cluttered storage room transformed into a bright home office"
```

## Resume behavior

Rerun the same `--project` name to resume from saved state. Completed images and videos are skipped. The CLI asks for confirmation after the first image and again before generating videos.

## Output layout

```text
projects/
  <project-name>/
    prompts.json
    .run-state.json
    images/
    videos/
      <project-name>-full.mp4
```

## Cost notes

This tool can spend money quickly because it calls multiple paid generation APIs. Read [COSTS.md](./COSTS.md) before running it with production credentials.
