import OpenAI from "openai";
import { withRetry } from "../lib/retry.js";
import { buildPipelineSchema, validatePipelineStructure } from "../pipeline/schema.js";
import { buildOpenAISystemPrompt } from "../pipeline/system-prompt.js";

export function createOpenAIClient(config) {
  return new OpenAI({ apiKey: config.apiKey });
}

function buildCameraLockBlock(globalConfig) {
  const lens = globalConfig?.lens || "fixed lens";
  const altitude = typeof globalConfig?.altitude_m === "number" ? `${globalConfig.altitude_m}m` : "fixed altitude";
  const pitch = typeof globalConfig?.pitch_deg === "number" ? `${globalConfig.pitch_deg}deg` : "fixed pitch";
  const heading = globalConfig?.heading || "fixed heading";
  return [
    "CAMERA LOCK (HARD REQUIREMENT): Use EXACTLY the same camera across all stages.",
    `Lens=${lens}; Altitude=${altitude}; Pitch=${pitch}; Heading=${heading}.`,
    "No pan, no tilt, no roll, no dolly, no truck, no crane move, no zoom, no crop shift, no reframing, no FOV change, no sensor change, no stabilization drift, no parallax drift.",
    "Subject must keep consistent position and scale in frame relative to frame edges.",
  ].join(" ");
}

function hardenCameraLock(pipeline) {
  if (!pipeline?.global || !Array.isArray(pipeline?.images) || !Array.isArray(pipeline?.videos)) {
    return pipeline;
  }

  const cameraLockBlock = buildCameraLockBlock(pipeline.global);

  const globalFramingRules = Array.isArray(pipeline.global.framing_rules)
    ? [...pipeline.global.framing_rules]
    : [];
  if (!globalFramingRules.some((r) => String(r).includes("HARD CAMERA LOCK"))) {
    globalFramingRules.push(
      "HARD CAMERA LOCK: camera extrinsics/intrinsics/framing must remain exactly identical across all stages."
    );
  }

  const images = pipeline.images.map((image) => ({
    ...image,
    prompt: `${cameraLockBlock} ${image.prompt}`.trim(),
  }));

  const videos = pipeline.videos.map((video) => {
    const realism = Array.isArray(video.realism_constraints) ? [...video.realism_constraints] : [];
    if (!realism.some((r) => String(r).toLowerCase().includes("hard camera lock"))) {
      realism.push(
        "Hard camera lock: identical camera extrinsics/intrinsics/framing, with zero pan/tilt/roll/zoom/reframe/parallax drift."
      );
    }
    if (!realism.some((r) => String(r).toLowerCase().includes("no boundary snap"))) {
      realism.push("No boundary snap at stage transitions; maintain seamless frame continuity.");
    }

    return {
      ...video,
      prompt: `${cameraLockBlock} ${video.prompt}`.trim(),
      realism_constraints: realism,
    };
  });

  return {
    ...pipeline,
    global: {
      ...pipeline.global,
      camera_lock: `${pipeline.global.camera_lock}; HARD: camera fingerprint is immutable across all stages.`,
      framing_rules: globalFramingRules,
    },
    images,
    videos,
  };
}

export async function preflightOpenAIModel({ client, model, retryConfig }) {
  await withRetry(
    async () => {
      await client.models.retrieve(model);
    },
    {
      ...retryConfig,
    }
  );
}

function getResponseText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const chunks = [];
  for (const item of response.output || []) {
    if (!item?.content) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && part.text) chunks.push(part.text);
      if (part?.type === "text" && part.text) chunks.push(part.text);
    }
  }

  return chunks.join("\n").trim();
}

export async function generatePipelinePrompts({
  client,
  model,
  mode,
  structure,
  specialEvent,
  aspectRatio,
  imageSize,
  retryConfig,
}) {
  const schema = buildPipelineSchema();
  const systemPrompt = buildOpenAISystemPrompt({ mode, aspectRatio, imageSize });

  const normalizedEvent = String(specialEvent || "").trim();
  const userPrompt = `Mode: ${mode}
Primary description: ${structure}
Special event (optional): ${normalizedEvent || "none"}
Generate the full pipeline output.`;

  const response = await withRetry(
    async () => {
      return client.responses.create({
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ai_media_pipeline",
            schema,
            strict: true,
          },
        },
      });
    },
    {
      ...retryConfig,
    }
  );

  const rawText = getResponseText(response);
  if (!rawText) {
    throw new Error("OpenAI returned empty JSON payload.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`OpenAI JSON parse failed: ${error.message}`);
  }

  return hardenCameraLock(validatePipelineStructure(parsed));
}
