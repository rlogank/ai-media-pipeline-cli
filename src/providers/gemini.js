import { GoogleGenAI } from "@google/genai";
import { toBase64 } from "../lib/fs-utils.js";
import { withRetry } from "../lib/retry.js";

function normalizeModelPath(modelName) {
  if (modelName.startsWith("models/")) return modelName;
  return `models/${modelName}`;
}

export function createGeminiClient(config) {
  return new GoogleGenAI({ apiKey: config.apiKey });
}

export async function preflightGeminiModel({ apiKey, model, retryConfig }) {
  const modelPath = normalizeModelPath(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}?key=${encodeURIComponent(apiKey)}`;

  await withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Gemini model preflight failed (${res.status}): ${text}`);
        err.status = res.status;
        throw err;
      }
    },
    {
      ...retryConfig,
    }
  );
}

function extractImageBytes(response) {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        return Buffer.from(part.inlineData.data, "base64");
      }
    }
  }

  const generated = response?.generatedImages || [];
  for (const item of generated) {
    if (item?.image?.imageBytes) {
      return Buffer.from(item.image.imageBytes, "base64");
    }
  }

  return null;
}

function extractText(response) {
  const candidates = response?.candidates || [];
  const chunks = [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part?.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

export async function generateGeminiImage({
  client,
  model,
  prompt,
  aspectRatio,
  imageSize,
  mimeType,
  referenceImagePaths,
  retryConfig,
}) {
  const refs = Array.isArray(referenceImagePaths)
    ? [...new Set(referenceImagePaths.filter(Boolean))]
    : [];

  const hasCameraAnchor = refs.length >= 2;
  const runtimeCameraLockHint = hasCameraAnchor
    ? " HARD CAMERA MATCH: reference image #2 is the immutable camera anchor. Keep exact perspective, framing, focal geometry, horizon placement, and subject position from reference #2. Apply only scene-state changes from reference image #1. No camera drift."
    : refs.length === 1
      ? " HARD CAMERA MATCH: keep exact perspective/framing from the provided reference image. No camera drift."
      : "";

  const promptWithRuntimeLock = `${prompt}${runtimeCameraLockHint}`;

  const contents =
    refs.length > 0
      ? [
          ...refs.map((refPath) => ({
            inlineData: {
              mimeType,
              data: toBase64(refPath),
            },
          })),
          { text: promptWithRuntimeLock },
        ]
      : promptWithRuntimeLock;

  const response = await withRetry(
    async () => {
      return client.models.generateContent({
        model,
        contents,
        config: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            imageSize,
            aspectRatio,
          },
        },
      });
    },
    {
      ...retryConfig,
    }
  );

  const bytes = extractImageBytes(response);
  if (!bytes) {
    const text = extractText(response);
    throw new Error(`Gemini returned no image bytes. Response text: ${text || "(none)"}`);
  }

  return bytes;
}
