import fs from "node:fs";
import { spawn } from "node:child_process";

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim().split("\n").slice(-10).join("\n") || "ffmpeg failed";
      const error = new Error(message);
      error.code = code;
      reject(error);
    });
  });
}

function latestMtimeMs(filePaths) {
  return Math.max(...filePaths.map((p) => fs.statSync(p).mtimeMs));
}

function isOutputUpToDate(outputPath, inputPaths) {
  if (!fs.existsSync(outputPath)) return false;
  const outputMtime = fs.statSync(outputPath).mtimeMs;
  return outputMtime >= latestMtimeMs(inputPaths);
}

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
]);

function pickMusicTrack(musicDir) {
  if (!musicDir || !fs.existsSync(musicDir) || !fs.statSync(musicDir).isDirectory()) {
    return "";
  }

  const candidates = fs
    .readdirSync(musicDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const dot = name.lastIndexOf(".");
      if (dot < 0) return false;
      const ext = name.slice(dot).toLowerCase();
      return SUPPORTED_AUDIO_EXTENSIONS.has(ext);
    })
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) return "";
  return `${musicDir}/${candidates[0]}`;
}

export async function stitchVideosSequential({ inputPaths, outputPath, workDir, musicDir }) {
  void workDir;
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error("No input video paths provided for stitching.");
  }

  for (const videoPath of inputPaths) {
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error(`Cannot stitch missing video file: ${videoPath}`);
    }
  }

  const selectedMusicTrack = pickMusicTrack(musicDir);

  if (!selectedMusicTrack && isOutputUpToDate(outputPath, inputPaths)) {
    return { outputPath, skipped: true };
  }
  const args = ["-y"];

  for (const videoPath of inputPaths) {
    args.push("-i", videoPath);
  }

  if (selectedMusicTrack) {
    // Loop the chosen music track so audio can span the entire final video.
    args.push("-stream_loop", "-1", "-i", selectedMusicTrack);
  }

  const filterParts = [];
  const concatRefs = [];

  for (let i = 0; i < inputPaths.length; i += 1) {
    const outLabel = `v${i}`;
    if (i === 0) {
      filterParts.push(`[${i}:v]setpts=PTS-STARTPTS[${outLabel}]`);
    } else {
      // Drop the first frame of each subsequent clip to remove duplicated boundary frames.
      filterParts.push(`[${i}:v]trim=start_frame=1,setpts=PTS-STARTPTS[${outLabel}]`);
    }
    concatRefs.push(`[${outLabel}]`);
  }

  filterParts.push(`${concatRefs.join("")}concat=n=${inputPaths.length}:v=1:a=0[vout]`);
  const filterComplex = filterParts.join(";");

  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart"
  );

  if (selectedMusicTrack) {
    const audioInputIndex = inputPaths.length;
    args.push("-map", `${audioInputIndex}:a:0`, "-c:a", "aac", "-b:a", "192k", "-shortest");
  }

  args.push(outputPath);

  await runFfmpeg(args);

  if (selectedMusicTrack) {
    fs.unlinkSync(selectedMusicTrack);
  }

  return { outputPath, skipped: false, usedMusicTrack: selectedMusicTrack || "" };
}
