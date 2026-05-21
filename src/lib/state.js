import path from "node:path";
import { fileExists, readJsonIfExists, writeJsonAtomic } from "./fs-utils.js";

export function createInitialState({ projectName, mode, structure, specialEvent, rootDir }) {
  return {
    projectName,
    mode: mode || "build",
    structure,
    specialEvent: String(specialEvent || "").trim(),
    rootDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prompts: {
      generated: false,
      path: path.join(rootDir, "prompts.json"),
    },
    images: {},
    videos: {},
  };
}

export function loadOrInitState({ statePath, projectName, mode, structure, specialEvent, rootDir }) {
  const existing = readJsonIfExists(statePath);
  if (!existing) {
    return createInitialState({ projectName, mode, structure, specialEvent, rootDir });
  }

  if (existing.projectName && existing.projectName !== projectName) {
    throw new Error(
      `Existing state belongs to project '${existing.projectName}', but CLI provided '${projectName}'.`
    );
  }

  const existingMode = String(existing.mode || "build").trim();
  const incomingMode = String(mode || "build").trim();
  if (existingMode !== incomingMode) {
    throw new Error(
      `Existing state has mode '${existingMode}', but incoming run requested mode '${incomingMode}'. Use the same mode to resume or create a new project name.`
    );
  }

  if (existing.structure && existing.structure !== structure) {
    throw new Error(
      "Existing state has a different description. Use a new project name or keep the same description to resume safely."
    );
  }

  const existingSpecialEvent = String(existing.specialEvent || "").trim();
  const incomingSpecialEvent = String(specialEvent || "").trim();
  if (existingSpecialEvent !== incomingSpecialEvent) {
    throw new Error(
      "Existing state has a different special event. Use a new project name or keep the same special event to resume safely."
    );
  }

  return {
    ...existing,
    projectName,
    mode: existingMode,
    structure,
    specialEvent: existingSpecialEvent,
    rootDir,
    prompts: {
      generated: !!existing?.prompts?.generated,
      path: path.join(rootDir, "prompts.json"),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function saveState(statePath, state) {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(statePath, nextState);
}

export function isStageComplete(record) {
  return !!record && record.status === "completed" && !!record.path && fileExists(record.path);
}
