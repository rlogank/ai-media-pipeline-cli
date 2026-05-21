export function buildPipelineSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["structure", "global", "images", "videos"],
    properties: {
      structure: { type: "string", minLength: 1 },
      global: {
        type: "object",
        additionalProperties: false,
        required: [
          "camera_lock",
          "lens",
          "altitude_m",
          "pitch_deg",
          "heading",
          "framing_rules",
          "image_platform_note",
          "video_platform_note",
        ],
        properties: {
          camera_lock: { type: "string", minLength: 1 },
          lens: { type: "string", minLength: 1 },
          altitude_m: { type: "number" },
          pitch_deg: { type: "number" },
          heading: { type: "string", minLength: 1 },
          framing_rules: {
            type: "array",
            minItems: 3,
            items: { type: "string", minLength: 1 },
          },
          image_platform_note: { type: "string", minLength: 1 },
          video_platform_note: { type: "string", minLength: 1 },
        },
      },
      images: {
        type: "array",
        minItems: 6,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "stage", "prompt"],
          properties: {
            id: { type: "integer", minimum: 1, maximum: 6 },
            stage: { type: "string", minLength: 1 },
            prompt: { type: "string", minLength: 10 },
          },
        },
      },
      videos: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "from_image", "to_image", "prompt", "realism_constraints"],
          properties: {
            id: { type: "integer", minimum: 1, maximum: 5 },
            from_image: { type: "integer", minimum: 1, maximum: 5 },
            to_image: { type: "integer", minimum: 2, maximum: 6 },
            prompt: { type: "string", minLength: 10 },
            realism_constraints: {
              type: "array",
              minItems: 4,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  };
}

export function validatePipelineStructure(pipeline) {
  if (!pipeline || typeof pipeline !== "object") {
    throw new Error("Invalid pipeline: expected object");
  }

  const images = [...pipeline.images].sort((a, b) => a.id - b.id);
  const videos = [...pipeline.videos].sort((a, b) => a.id - b.id);

  for (let i = 0; i < images.length; i += 1) {
    const expectedId = i + 1;
    if (images[i].id !== expectedId) {
      throw new Error(`Invalid images sequence. Expected image id ${expectedId}.`);
    }
  }

  for (let i = 0; i < videos.length; i += 1) {
    const expectedId = i + 1;
    const expectedFrom = i + 1;
    const expectedTo = i + 2;
    const row = videos[i];

    if (row.id !== expectedId) {
      throw new Error(`Invalid videos sequence. Expected video id ${expectedId}.`);
    }

    if (row.from_image !== expectedFrom || row.to_image !== expectedTo) {
      throw new Error(
        `Invalid transition for video ${row.id}. Expected ${expectedFrom}->${expectedTo}, got ${row.from_image}->${row.to_image}.`
      );
    }
  }

  return {
    ...pipeline,
    images,
    videos,
  };
}
