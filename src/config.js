function parseBool(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseIntStrict(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig() {
  const primaryVeoModel = process.env.VEO_MODEL_ID || "veo-3.1-fast-generate-001";
  const requestedVideoConcurrency = parseIntStrict(process.env.VIDEO_CONCURRENCY, 4);

  const config = {
    openai: {
      apiKey: requireEnv("OPENAI_API_KEY"),
      model: process.env.OPENAI_MODEL || "gpt-5.2",
    },
    gemini: {
      apiKey: requireEnv("GEMINI_API_KEY"),
      imageModel: process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview",
      imageSize: process.env.IMAGE_SIZE || "1K",
      aspectRatio: process.env.ASPECT_RATIO || "16:9",
      mimeType: "image/png",
    },
    vertex: {
      projectId: requireEnv("GOOGLE_CLOUD_PROJECT"),
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
      modelId: primaryVeoModel,
      durationSeconds: parseIntStrict(process.env.VEO_DURATION_SECONDS, 8),
      resolution: process.env.VEO_RESOLUTION || "1080p",
      aspectRatio: process.env.ASPECT_RATIO || "16:9",
      videoMimeType: "video/mp4",
      sampleCount: 1,
      generateAudio: parseBool(process.env.VEO_GENERATE_AUDIO, false),
      storageUri: process.env.VEO_STORAGE_URI || "",
      inputMode: process.env.VEO_INPUT_MODE || "",
      videoConcurrency: Math.min(4, Math.max(1, requestedVideoConcurrency)),
    },
    retry: {
      attempts: Math.max(1, parseIntStrict(process.env.RETRY_MAX_ATTEMPTS, 5)),
      minDelayMs: Math.max(200, parseIntStrict(process.env.RETRY_MIN_DELAY_MS, 1200)),
      maxDelayMs: Math.max(1000, parseIntStrict(process.env.RETRY_MAX_DELAY_MS, 12000)),
      factor: Number(process.env.RETRY_FACTOR || 1.8),
    },
  };

  if (![4, 6, 8].includes(config.vertex.durationSeconds)) {
    throw new Error("VEO_DURATION_SECONDS must be one of: 4, 6, 8");
  }

  if (config.vertex.inputMode && !["gcs", "inline"].includes(config.vertex.inputMode)) {
    throw new Error("VEO_INPUT_MODE must be 'gcs' or 'inline' when provided");
  }

  if (!config.vertex.inputMode) {
    config.vertex.inputMode = config.vertex.storageUri ? "gcs" : "inline";
  }

  if (config.vertex.inputMode === "gcs" && !config.vertex.storageUri) {
    throw new Error("VEO_STORAGE_URI is required when VEO_INPUT_MODE=gcs");
  }

  return config;
}
