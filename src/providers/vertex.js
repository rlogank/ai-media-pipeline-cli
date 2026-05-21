import fs from "node:fs";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { toBase64 } from "../lib/fs-utils.js";
import { withRetry } from "../lib/retry.js";

const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function parseGsUri(gsUri) {
  if (!gsUri || !gsUri.startsWith("gs://")) {
    throw new Error(`Invalid GCS URI: ${gsUri}`);
  }

  const withoutScheme = gsUri.slice("gs://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) {
    return { bucket: withoutScheme, object: "" };
  }

  const bucket = withoutScheme.slice(0, slashIndex);
  const object = withoutScheme.slice(slashIndex + 1);
  return { bucket, object };
}

function joinGsUri(baseGsUri, ...parts) {
  const trimmedBase = baseGsUri.replace(/\/+$/, "");
  const cleanParts = parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+/, "").replace(/\/+$/, ""));
  return `${trimmedBase}/${cleanParts.join("/")}`;
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeHttpError(status, bodyText) {
  const error = new Error(`HTTP ${status}: ${bodyText}`);
  error.status = status;
  error.bodyText = bodyText;
  return error;
}

function extractUnknownParameterFromBody(text) {
  const body = String(text || "");
  const quotedMatch = body.match(/Unknown name \"([a-zA-Z0-9_]+)\"/);
  if (quotedMatch) return quotedMatch[1];
  const fieldMatch = body.match(/Cannot find field[: ]+([a-zA-Z0-9_]+)/i);
  if (fieldMatch) return fieldMatch[1];
  return null;
}

export class VertexVeoClient {
  constructor(config) {
    this.projectId = config.projectId;
    this.location = config.location;
    this.modelId = config.modelId;
    this.durationSeconds = config.durationSeconds;
    this.resolution = config.resolution;
    this.aspectRatio = config.aspectRatio;
    this.sampleCount = config.sampleCount;
    this.generateAudio = !!config.generateAudio;
    this.storageUri = config.storageUri;
    this.inputMode = config.inputMode;
    this.retryConfig = config.retryConfig;

    this.auth = new GoogleAuth({ scopes: [CLOUD_SCOPE] });
    this.authClientPromise = null;
  }

  baseUrl() {
    return `https://${this.location}-aiplatform.googleapis.com/v1`;
  }

  modelResourceName() {
    return this.modelResourceNameFor(this.modelId);
  }

  modelResourceNameFor(modelId) {
    return `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${modelId}`;
  }

  async getAuthClient() {
    if (!this.authClientPromise) {
      this.authClientPromise = this.auth.getClient();
    }
    return this.authClientPromise;
  }

  async getAccessToken() {
    const client = await this.getAuthClient();
    const tokenResponse = await client.getAccessToken();
    const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
    if (!token) {
      throw new Error("Failed to obtain Google Cloud access token.");
    }
    return token;
  }

  async fetchWithAuth(url, options = {}) {
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };
    return fetch(url, { ...options, headers });
  }

  async preflightModel() {
    // Lightweight auth check without spending generation calls.
    await withRetry(async () => this.getAccessToken(), this.retryConfig);
    return {
      ok: true,
      skipped: true,
      reason: "Auth preflight completed; model existence is validated on first generation call.",
    };
  }

  async uploadToGcs({ localPath, targetGsUri }) {
    const bytes = fs.readFileSync(localPath);
    const mimeType = this.detectMime(localPath);
    const parsed = parseGsUri(targetGsUri);
    if (!parsed.object) {
      throw new Error(`Target GCS object path is empty: ${targetGsUri}`);
    }

    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
      parsed.bucket
    )}/o?uploadType=media&name=${encodeURIComponent(parsed.object)}`;

    await withRetry(
      async () => {
        const res = await this.fetchWithAuth(url, {
          method: "POST",
          headers: {
            "Content-Type": mimeType,
          },
          body: bytes,
        });

        if (!res.ok) {
          throw makeHttpError(res.status, await res.text());
        }
      },
      this.retryConfig
    );

    return targetGsUri;
  }

  async downloadFromGcs(gsUri) {
    const parsed = parseGsUri(gsUri);
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
      parsed.bucket
    )}/o/${encodeURIComponent(parsed.object)}?alt=media`;

    const res = await withRetry(
      async () => {
        const response = await this.fetchWithAuth(url, { method: "GET" });
        if (!response.ok) {
          throw makeHttpError(response.status, await response.text());
        }
        return response;
      },
      this.retryConfig
    );

    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }

  detectMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    return "image/png";
  }

  async buildFrameInput({ localPath, runPrefix, label }) {
    if (this.inputMode === "inline") {
      return {
        bytesBase64Encoded: toBase64(localPath),
        mimeType: this.detectMime(localPath),
      };
    }

    const safeLabel = sanitizePathSegment(label || "frame");
    const targetGsUri = joinGsUri(
      this.storageUri,
      runPrefix,
      "inputs",
      `${safeLabel}${path.extname(localPath) || ".png"}`
    );

    const uploaded = await this.uploadToGcs({
      localPath,
      targetGsUri,
    });

    return {
      gcsUri: uploaded,
      mimeType: this.detectMime(localPath),
    };
  }

  async startVideoOperation({ prompt, firstFramePath, lastFramePath, runPrefix, videoId }) {
    const firstFrame = await this.buildFrameInput({
      localPath: firstFramePath,
      runPrefix,
      label: `video-${videoId}-first`,
    });

    const lastFrame = await this.buildFrameInput({
      localPath: lastFramePath,
      runPrefix,
      label: `video-${videoId}-last`,
    });

    const parameters = {
      aspectRatio: this.aspectRatio,
      resolution: this.resolution,
      sampleCount: this.sampleCount,
      durationSeconds: this.durationSeconds,
      generateAudio: this.generateAudio,
    };

    if (this.storageUri) {
      parameters.storageUri = joinGsUri(this.storageUri, runPrefix, "outputs", `video-${videoId}`);
    }

    const body = {
      instances: [
        {
          prompt,
          image: firstFrame,
          lastFrame,
        },
      ],
      parameters,
    };

    const url = `${this.baseUrl()}/${this.modelResourceName()}:predictLongRunning`;
    return this.requestPredictWithFieldFallback({ url, body });
  }

  async requestPredictWithFieldFallback({ url, body }) {
    const requestBody = structuredClone(body);
    const removedParams = new Set();

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await withRetry(
          async () => {
            const res = await this.fetchWithAuth(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
              },
              body: JSON.stringify(requestBody),
            });

            if (!res.ok) {
              const text = await res.text();
              const err = makeHttpError(res.status, text);
              throw err;
            }

            return res.json();
          },
          this.retryConfig
        );

        if (response?.name) return response.name;
        throw new Error("Vertex predictLongRunning returned response without operation name.");
      } catch (error) {
        const isClientError = error?.status === 400 || error?.status === 422;
        const unknownField = extractUnknownParameterFromBody(error?.bodyText || error?.message);
        const removable =
          unknownField &&
          requestBody.parameters &&
          Object.prototype.hasOwnProperty.call(requestBody.parameters, unknownField) &&
          !removedParams.has(unknownField);

        if (isClientError && removable) {
          delete requestBody.parameters[unknownField];
          removedParams.add(unknownField);
          continue;
        }

        throw error;
      }
    }

    throw new Error("Vertex request failed after parameter fallback attempts.");
  }

  async pollOperation(operationName) {
    const resourceName = String(operationName || "").split("/operations/")[0];
    if (!resourceName || !resourceName.includes("/models/")) {
      throw new Error(`Invalid operation name for fetchPredictOperation: ${operationName}`);
    }
    const url = `${this.baseUrl()}/${resourceName}:fetchPredictOperation`;
    let delayMs = 1500;

    for (let attempt = 1; attempt <= 240; attempt += 1) {
      const op = await withRetry(
        async () => {
          const res = await this.fetchWithAuth(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({ operationName }),
          });
          if (!res.ok) {
            throw makeHttpError(res.status, await res.text());
          }
          return res.json();
        },
        this.retryConfig
      );

      if (op.done) {
        if (op.error) {
          throw new Error(`Vertex operation failed: ${JSON.stringify(op.error)}`);
        }

        const videos = op?.response?.videos || [];
        if (!videos.length) {
          throw new Error("Vertex operation completed with no videos in response.");
        }

        const first = videos[0];
        if (first.bytesBase64Encoded) {
          return Buffer.from(first.bytesBase64Encoded, "base64");
        }

        if (first.gcsUri) {
          return this.downloadFromGcs(first.gcsUri);
        }

        throw new Error("Vertex response video missing both bytesBase64Encoded and gcsUri.");
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.floor(delayMs * 1.25), 10000);
    }

    throw new Error("Timed out waiting for Vertex long-running operation.");
  }
}

export function sanitizeRunPrefix(projectName) {
  const safeProject = sanitizePathSegment(projectName || "project");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeProject}/${ts}`;
}
