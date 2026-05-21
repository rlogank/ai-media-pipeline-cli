#!/usr/bin/env node

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import { sanitizeProjectName } from "./lib/fs-utils.js";
import { runPipeline } from "./pipeline/run-pipeline.js";

function parseArgs(argv) {
  const args = { project: "", mode: "", structure: "", specialEvent: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--project" && argv[i + 1]) {
      args.project = argv[i + 1];
      i += 1;
    } else if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[i + 1];
      i += 1;
    } else if ((token === "--description" || token === "--subject" || token === "--structure") && argv[i + 1]) {
      args.structure = argv[i + 1];
      i += 1;
    } else if (token === "--special-event" && argv[i + 1]) {
      args.specialEvent = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function normalizeMode(input) {
  const mode = String(input || "")
    .trim()
    .toLowerCase();
  if (!mode) return "build";
  if (mode === "build" || mode === "construction") return "build";
  if (mode === "transformation") return mode;
  return "";
}

function loadExistingProjectState(cwd, projectName) {
  const statePath = path.resolve(cwd, "projects", projectName, ".run-state.json");
  if (!fs.existsSync(statePath)) return null;

  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function askMissingInputs(initial, cwd) {
  const rl = readline.createInterface({ input, output });
  const collected = { ...initial, resumeFromExistingProject: false, mode: normalizeMode(initial.mode) };

  if (!collected.project) {
    collected.project = await rl.question("Project name: ");
  }

  const sanitizedProject = sanitizeProjectName(collected.project);
  const existingState = sanitizedProject ? loadExistingProjectState(cwd, sanitizedProject) : null;
  const existingMode =
    existingState && typeof existingState.mode === "string" ? normalizeMode(existingState.mode) : "";
  const existingStructure =
    existingState && typeof existingState.structure === "string" ? existingState.structure.trim() : "";
  const existingSpecialEvent =
    existingState && typeof existingState.specialEvent === "string" ? existingState.specialEvent.trim() : "";

  if (existingStructure) {
    if (existingMode) {
      if (collected.mode && collected.mode !== existingMode) {
        console.log("Existing project detected. Ignoring provided mode and resuming with saved mode.");
      }
      collected.mode = existingMode;
    } else if (!collected.mode) {
      collected.mode = "build";
    }

    if (collected.structure && collected.structure.trim() !== existingStructure) {
      console.log(
        "\nExisting project detected. Ignoring provided description and resuming with saved description."
      );
    } else {
      console.log("\nExisting project detected. Resuming with saved settings.");
    }
    collected.structure = existingStructure;
    if ((collected.specialEvent || "").trim() !== existingSpecialEvent) {
      console.log(
        "Existing project detected. Ignoring provided special event and resuming with saved special event."
      );
    }
    collected.specialEvent = existingSpecialEvent;
    collected.resumeFromExistingProject = true;
  }

  if (!existingStructure) {
    if (!collected.mode) {
      while (true) {
        const rawMode = await rl.question("Mode (build/transformation) [build]: ");
        const parsed = normalizeMode(rawMode);
        if (parsed) {
          collected.mode = parsed;
          break;
        }
        console.log("Please choose 'build' or 'transformation'.");
      }
    }

    if (!collected.structure) {
      const label =
        collected.mode === "transformation"
          ? "Transformation description (e.g. 'dated retail space transformed into a bright modern studio')"
          : "Build description (e.g. 'glass skyscraper, garden studio, trade show booth, or public art installation')";
      collected.structure = await rl.question(`${label}: `);
    }
  }

  if (!existingStructure && !collected.specialEvent) {
    const eventInput = await rl.question('Special event (optional): ');
    collected.specialEvent = String(eventInput || "").trim();
  }

  await rl.close();
  return collected;
}

async function askProceedDecision(question) {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = String(await rl.question(`${question} (y/n/r): `))
        .trim()
        .toLowerCase();
      if (["y", "yes"].includes(answer)) return "yes";
      if (["n", "no"].includes(answer)) return "no";
      if (["r", "retry"].includes(answer)) return "retry";
      console.log("Please answer with y, n, or r.");
    }
  } finally {
    await rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const answers = await askMissingInputs(args, process.cwd());

  const projectName = sanitizeProjectName(answers.project);
  const mode = normalizeMode(answers.mode) || "build";
  const structure = String(answers.structure || "").trim();
  const specialEvent = String(answers.specialEvent || "").trim();

  if (!projectName) {
    throw new Error("Project name is required.");
  }

  if (!structure) {
    throw new Error("Description is required.");
  }

  const config = loadConfig();

  console.log(`\nProject: ${projectName}`);
  console.log(`Mode: ${mode}`);
  console.log(`Description: ${structure}`);
  console.log(`OpenAI model: ${config.openai.model}`);
  console.log(`Gemini image model: ${config.gemini.imageModel}`);
  console.log(`Veo model: ${config.vertex.modelId}`);
  console.log(`Veo audio: ${config.vertex.generateAudio ? "ON" : "OFF"}`);
  console.log(`Video concurrency: ${config.vertex.videoConcurrency}\n`);
  if (specialEvent) {
    console.log(`Special event: ${specialEvent}\n`);
  }

  const result = await runPipeline({
    projectName,
    mode,
    structure,
    specialEvent,
    cwd: process.cwd(),
    config: {
      ...config,
      confirmAfterFirstImage: async ({ firstImagePath, imagesDir }) => {
        console.log("\nFirst image is ready for review.");
        console.log(`First image: ${path.resolve(firstImagePath)}`);
        console.log(`Images folder: ${path.resolve(imagesDir)}`);
        return askProceedDecision("Proceed with remaining images?");
      },
      confirmVideoGeneration: async ({ pendingVideoCount, imagesDir }) => {
        console.log("\nImages are ready for review.");
        console.log(`Images folder: ${path.resolve(imagesDir)}`);
        console.log(`Pending videos: ${pendingVideoCount}`);
        return askProceedDecision("Proceed with video generation?");
      },
    },
  });

  if (result.deletedProject) {
    console.log("\nProject deleted by request.");
    return;
  }

  console.log("\nPipeline complete.");
  console.log(`Project folder: ${result.rootDir}`);
  console.log(`Prompts: ${result.promptsPath}`);

  console.log("Images:");
  for (const p of result.imagePaths) {
    console.log(` - ${path.resolve(p)}`);
  }

  console.log("Videos:");
  for (const p of result.videoPaths) {
    console.log(` - ${path.resolve(p)}`);
  }

  if (result.fullVideoPath) {
    console.log(`Full stitched video: ${path.resolve(result.fullVideoPath)}`);
  }

  console.log(`State: ${result.statePath}`);
}

main().catch((error) => {
  console.error("\nPipeline failed.");
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
