// What the AI made of the ball, in plain words (DESIGN.md 4.13). Pure: unit
// tested in ballWords.test.ts.
import type { AiRun } from "../api";

/** A share of the match as a percentage: "23%", "less than 1%". */
export function percent(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return "0%";
  if (x < 0.01) return "less than 1%";
  return `${Math.round(Math.min(x, 1) * 100)}%`;
}

const count = (n: number) => n.toLocaleString("en-GB");

/** How often the AI saw the ball and what the camera does with it (empty without numbers). */
export function ballWords(run: AiRun | null | undefined): string[] {
  const b = run?.ball;
  if (!run || !b || !b.frames) return [];
  const out: string[] = [];
  const seen = percent(b.seen);
  const followed = percent(b.followed);
  if (b.seen <= 0) {
    out.push(
      run.style === "ball"
        ? "The AI didn't see the ball in this match, so the camera follows the players."
        : "The AI didn't see the ball in this match.",
    );
  } else if (run.style === "ball") {
    out.push(
      followed !== seen
        ? `The AI saw the ball in ${seen} of the match. VeoClone filled short gaps, so the camera follows the ball for ${followed} of it; the rest follows the players.`
        : `The AI saw the ball in ${seen} of the match, so the camera follows the ball for ${followed} of it; the rest follows the players.`,
    );
  } else {
    out.push(`The AI saw the ball in ${seen} of the match. This camera style follows the players; “Follow the ball” would follow the ball for ${followed} of it.`);
  }
  const ignored = b.rejectedStatic + b.rejectedOther;
  if (ignored > 0) {
    const still = b.rejectedStatic > 0 ? `, ${count(b.rejectedStatic)} of them spots that never moved (a mark or a light on the grass, a spare ball)` : "";
    out.push(`VeoClone ignored ${count(ignored)} ${ignored === 1 ? "sighting that wasn't" : "sightings that weren't"} the ball${still}.`);
  }
  if (b.seen < 0.15) out.push("The ball is hard to see in the dark or far away: good light, and phones up high and close to the pitch, help the AI.");
  return out;
}

export const AI_REPORT_HELP =
  "Camera lost the ball? Save an AI report: a small file with what the AI saw in this match (no video, no names), and send it to the VeoClone developers so they can make the camera better.";

/** The report's file name (the helper's, without the match name). */
export function reportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `veoclone-ai-report-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

