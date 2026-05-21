import fs from "node:fs";
import path from "node:path";
import { loadOrInitState, saveState, isStageComplete } from "../lib/state.js";
import { ensureDir, fileExists, readJsonIfExists, writeBuffer, writeJsonAtomic } from "../lib/fs-utils.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import { createOpenAIClient, generatePipelinePrompts, preflightOpenAIModel } from "../providers/openai.js";
import { createGeminiClient, generateGeminiImage, preflightGeminiModel } from "../providers/gemini.js";
import { VertexVeoClient, sanitizeRunPrefix } from "../providers/vertex.js";
import { stitchVideosSequential } from "../lib/video-stitch.js";
import { validatePipelineStructure } from "./schema.js";

function log(message) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${message}`);
}

function stageRecord(pathValue, extra = {}) {
  return {
    status: "completed",
    path: pathValue,
    completedAt: new Date().toISOString(),
    ...extra,
  };
}

function normalizeProceedDecision(value, fallback = "yes") {
  if (value === true) return "yes";
  if (value === false) return "no";

  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "y" || normalized === "yes") return "yes";
  if (normalized === "n" || normalized === "no") return "no";
  if (normalized === "r" || normalized === "retry") return "retry";
  return fallback;
}

function deleteProjectDirectory(rootDir) {
  if (!rootDir) return;
  fs.rmSync(rootDir, { recursive: true, force: true });
}

function tryLoadExistingPrompts(promptsPath) {
  const json = readJsonIfExists(promptsPath, null);
  if (!json) return null;
  return validatePipelineStructure(json);
}

export async function runPipeline({ projectName, mode, structure, specialEvent, cwd, config }) {
  const projectsDir = path.resolve(cwd, "projects");
  const rootDir = path.resolve(projectsDir, projectName);
  const imagesDir = path.join(rootDir, "images");
  const videosDir = path.join(rootDir, "videos");
  const statePath = path.join(rootDir, ".run-state.json");

  ensureDir(projectsDir);
  ensureDir(rootDir);
  ensureDir(imagesDir);
  ensureDir(videosDir);

  const state = loadOrInitState({
    statePath,
    projectName,
    mode,
    structure,
    specialEvent,
    rootDir,
  });

  if (!state.runPrefix) {
    state.runPrefix = sanitizeRunPrefix(projectName);
  }

  saveState(statePath, state);

  const openaiClient = createOpenAIClient(config.openai);
  const geminiClient = createGeminiClient(config.gemini);
  const vertexClient = new VertexVeoClient({
    ...config.vertex,
    retryConfig: config.retry,
  });

  log("Preflight: checking model access for OpenAI and Gemini...");
  await Promise.all([
    preflightOpenAIModel({
      client: openaiClient,
      model: config.openai.model,
      retryConfig: config.retry,
    }),
    preflightGeminiModel({
      apiKey: config.gemini.apiKey,
      model: config.gemini.imageModel,
      retryConfig: config.retry,
    }),
  ]);

  let pipeline;
  const promptsPath = state.prompts.path;

  if (state.prompts.generated && fileExists(promptsPath)) {
    log("Resume: loading existing prompts.json");
    pipeline = tryLoadExistingPrompts(promptsPath);
  }

  if (!pipeline && fileExists(promptsPath)) {
    log("Found prompts.json on disk, validating and reusing it.");
    pipeline = tryLoadExistingPrompts(promptsPath);
    state.prompts.generated = true;
    saveState(statePath, state);
  }

  if (!pipeline) {
    log("Generating prompts via OpenAI...");
    pipeline = await generatePipelinePrompts({
      client: openaiClient,
      model: config.openai.model,
      mode,
      structure,
      specialEvent,
      aspectRatio: config.gemini.aspectRatio,
      imageSize: config.gemini.imageSize,
      retryConfig: config.retry,
    });
    writeJsonAtomic(promptsPath, pipeline);
    state.prompts.generated = true;
    saveState(statePath, state);
  }

  const imagePaths = [];

  function clearAllVideoArtifacts() {
    if (fileExists(videosDir) && fs.statSync(videosDir).isDirectory()) {
      const prefix = `${projectName}-`;
      for (const entry of fs.readdirSync(videosDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith(prefix)) continue;
        if (!entry.name.endsWith(".mp4")) continue;
        fs.unlinkSync(path.join(videosDir, entry.name));
      }
    }

    state.videos = {};
    delete state.fullVideo;
    saveState(statePath, state);
  }

  function clearDownstreamAfterFirstImageRetry() {
    if (fileExists(imagesDir) && fs.statSync(imagesDir).isDirectory()) {
      const escapedProjectName = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imageNamePattern = new RegExp(`^${escapedProjectName}-img([2-6])\\.png$`);
      for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!imageNamePattern.test(entry.name)) continue;
        fs.unlinkSync(path.join(imagesDir, entry.name));
      }
    }

    for (const [id, record] of Object.entries(state.images)) {
      if (Number(id) <= 1) continue;
      if (record?.path && fileExists(record.path)) {
        fs.unlinkSync(record.path);
      }
      delete state.images[id];
    }
    imagePaths.length = 1;
    clearAllVideoArtifacts();
    saveState(statePath, state);
  }

  async function generateImageStage(image, options = {}) {
    const forceRegenerate = !!options.forceRegenerate;
    const outPath = path.join(imagesDir, `${projectName}-img${image.id}.png`);
    const stateKey = String(image.id);
    const existingState = state.images[stateKey];

    if (forceRegenerate) {
      if (fileExists(outPath)) {
        fs.unlinkSync(outPath);
      }
      delete state.images[stateKey];
      saveState(statePath, state);
    } else if (isStageComplete(existingState)) {
      imagePaths[image.id - 1] = existingState.path;
      log(`Image ${image.id}: already complete, skipping.`);
      return existingState.path;
    } else if (fileExists(outPath)) {
      state.images[stateKey] = stageRecord(outPath, {
        mode: image.id === 1 ? "generate" : "edit",
      });
      saveState(statePath, state);
      imagePaths[image.id - 1] = outPath;
      log(`Image ${image.id}: existing file found, marked complete.`);
      return outPath;
    }

    const previousImagePath = image.id === 1 ? "" : imagePaths[image.id - 2];
    if (image.id > 1 && !previousImagePath) {
      throw new Error(`Cannot generate image ${image.id}; previous image is missing.`);
    }

    const cameraAnchorPath = imagePaths[0] || "";
    const referenceImagePaths =
      image.id === 1
        ? []
        : image.id === 2
          ? [previousImagePath]
          : [previousImagePath, cameraAnchorPath].filter(Boolean);

    log(`Image ${image.id}: generating (${image.id === 1 ? "text->image" : "edit"})...`);
    const bytes = await generateGeminiImage({
      client: geminiClient,
      model: config.gemini.imageModel,
      prompt: image.prompt,
      aspectRatio: config.gemini.aspectRatio,
      imageSize: config.gemini.imageSize,
      mimeType: config.gemini.mimeType,
      referenceImagePaths,
      isFirstImage: image.id === 1,
      retryConfig: config.retry,
    });

    writeBuffer(outPath, bytes);
    state.images[stateKey] = stageRecord(outPath, {
      mode: image.id === 1 ? "generate" : "edit",
    });
    saveState(statePath, state);
    imagePaths[image.id - 1] = outPath;
    return outPath;
  }

  log("Generating/resuming image chain (6 images, sequential edits)...");
  const firstImage = pipeline.images.find((row) => row.id === 1);
  if (!firstImage) {
    throw new Error("Pipeline is missing image stage 1.");
  }

  await generateImageStage(firstImage);

  if (typeof config.confirmAfterFirstImage === "function") {
    while (true) {
      const decision = normalizeProceedDecision(
        await config.confirmAfterFirstImage({
          projectName,
          rootDir,
          imagesDir,
          firstImagePath: imagePaths[0],
        }),
        "yes"
      );

      if (decision === "yes") break;

      if (decision === "no") {
        log("Image generation declined. Deleting project directory.");
        deleteProjectDirectory(rootDir);
        return {
          rootDir,
          promptsPath,
          imagePaths: [],
          videoPaths: [],
          fullVideoPath: "",
          statePath,
          deletedProject: true,
          abortedStage: "images",
        };
      }

      log("Image 1 retry requested. Regenerating first image and clearing downstream outputs.");
      clearDownstreamAfterFirstImageRetry();
      await generateImageStage(firstImage, { forceRegenerate: true });
    }
  }

  for (const image of pipeline.images) {
    if (image.id === 1) continue;
    await generateImageStage(image);
  }

  let pendingVideos = [];
  const completedVideoPaths = [];

  for (const video of pipeline.videos) {
    const outPath = path.join(videosDir, `${projectName}-${video.id}.mp4`);
    const existingState = state.videos[String(video.id)];

    if (isStageComplete(existingState)) {
      completedVideoPaths[video.id - 1] = existingState.path;
      log(`Video ${video.id}: already complete, skipping.`);
      continue;
    }

    if (fileExists(outPath)) {
      state.videos[String(video.id)] = stageRecord(outPath, {
        from: video.from_image,
        to: video.to_image,
      });
      saveState(statePath, state);
      completedVideoPaths[video.id - 1] = outPath;
      log(`Video ${video.id}: existing file found, marked complete.`);
      continue;
    }

    if (
      existingState &&
      existingState.status === "in_progress" &&
      typeof existingState.operationName === "string" &&
      existingState.operationName.length > 0
    ) {
      pendingVideos.push({
        ...video,
        resumeOperationName: existingState.operationName,
      });
      continue;
    }

    pendingVideos.push({
      ...video,
      resumeOperationName: null,
    });
  }

  if (pendingVideos.length > 0) {
    if (typeof config.confirmVideoGeneration === "function") {
      while (true) {
        const decision = normalizeProceedDecision(
          await config.confirmVideoGeneration({
            projectName,
            rootDir,
            imagesDir,
            videosDir,
            imagePaths,
            pendingVideoCount: pendingVideos.length,
          }),
          "yes"
        );

        if (decision === "yes") break;

        if (decision === "no") {
          log("Video generation declined. Deleting project directory.");
          deleteProjectDirectory(rootDir);
          return {
            rootDir,
            promptsPath,
            imagePaths: [],
            videoPaths: [],
            fullVideoPath: "",
            statePath,
            deletedProject: true,
            abortedStage: "videos",
          };
        }

        log("Video retry requested. Clearing existing video outputs and resetting video stage.");
        clearAllVideoArtifacts();
        completedVideoPaths.length = 0;
        pendingVideos = pipeline.videos.map((video) => ({
          ...video,
          resumeOperationName: null,
        }));
      }
    }

    log("Preflight: checking model access for Vertex Veo...");
    const preflight = await vertexClient.preflightModel();
    if (preflight?.skipped) {
      log(`Vertex preflight skipped: ${preflight.reason}`);
    }

    log(
      `Generating ${pendingVideos.length} video clip(s) in parallel (concurrency=${config.vertex.videoConcurrency})...`
    );

    await runWithConcurrency(pendingVideos, config.vertex.videoConcurrency, async (video) => {
      const firstFramePath = imagePaths[video.from_image - 1];
      const lastFramePath = imagePaths[video.to_image - 1];

      if (!firstFramePath || !lastFramePath || !fs.existsSync(firstFramePath) || !fs.existsSync(lastFramePath)) {
        throw new Error(`Video ${video.id} is missing first/last frame files.`);
      }

      let operationName = video.resumeOperationName;
      if (operationName) {
        log(`Video ${video.id}: resuming existing Vertex operation ${operationName}...`);
      } else {
        log(`Video ${video.id}: starting Vertex operation...`);
        operationName = await vertexClient.startVideoOperation({
          prompt: video.prompt,
          firstFramePath,
          lastFramePath,
          runPrefix: state.runPrefix,
          videoId: video.id,
        });

        // Persist operation name immediately so reruns can resume polling instead of creating duplicate jobs.
        state.videos[String(video.id)] = {
          status: "in_progress",
          path: "",
          from: video.from_image,
          to: video.to_image,
          operationName,
          startedAt: new Date().toISOString(),
        };
        saveState(statePath, state);
      }

      log(`Video ${video.id}: polling operation ${operationName}...`);
      const videoBytes = await vertexClient.pollOperation(operationName);

      const outPath = path.join(videosDir, `${projectName}-${video.id}.mp4`);
      writeBuffer(outPath, videoBytes);

      state.videos[String(video.id)] = stageRecord(outPath, {
        from: video.from_image,
        to: video.to_image,
        operationName,
      });
      saveState(statePath, state);
      completedVideoPaths[video.id - 1] = outPath;

      log(`Video ${video.id}: complete.`);
      return outPath;
    });
  }

  let fullVideoPath = state.fullVideo?.path || "";
  const allVideosReady =
    completedVideoPaths.length === pipeline.videos.length &&
    completedVideoPaths.every((videoPath) => typeof videoPath === "string" && fs.existsSync(videoPath));

  if (allVideosReady) {
    const stitchedOutPath = path.join(videosDir, `${projectName}-full.mp4`);
    log(`Stitching final short: ${path.basename(stitchedOutPath)}...`);
    const stitchResult = await stitchVideosSequential({
      inputPaths: completedVideoPaths.map((p) => path.resolve(p)),
      outputPath: stitchedOutPath,
      workDir: rootDir,
      musicDir: path.resolve(cwd, "music"),
    });
    fullVideoPath = stitchedOutPath;
    if (stitchResult?.usedMusicTrack) {
      log(`Added music track: ${path.basename(stitchResult.usedMusicTrack)} (removed from /music).`);
    } else {
      log("No music track found in /music; keeping stitched video without added music.");
    }
    state.fullVideo = stageRecord(stitchedOutPath, {
      clipCount: completedVideoPaths.length,
      musicTrack: stitchResult?.usedMusicTrack || "",
    });
    saveState(statePath, state);
  }

  saveState(statePath, state);

  return {
    rootDir,
    promptsPath,
    imagePaths,
    videoPaths: completedVideoPaths,
    fullVideoPath,
    statePath,
  };
}
