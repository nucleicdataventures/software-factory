import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface StageProvenance {
  role: string | null;
  stage: string;
  harness: string;
  model: string;
  promptHash: string;
  sandboxId: string | null;
  worktreePath: string | null;
}

export interface ProvenanceRecord {
  version: 1;
  workId: string;
  model: string;
  harness: string;
  promptHash: string;
  sandboxIds: string[];
  evidencePaths: string[];
  stages: StageProvenance[];
  createdAt: string;
}

export interface EvidenceFile {
  path: string;
  sha256: string;
}

function safeWorkId(workId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(workId)) throw new Error("Invalid work item id");
  return workId;
}

function safeRelativePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Evidence path must stay inside the work item evidence directory");
  }
  return normalized;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evidenceDirectory(repoRoot: string, workId: string): string {
  return join(repoRoot, "evidence", "runs", safeWorkId(workId));
}

export function writeEvidenceFile(repoRoot: string, workId: string, name: string, contents: string | Uint8Array): EvidenceFile {
  const base = evidenceDirectory(repoRoot, workId);
  const target = resolve(base, safeRelativePath(name));
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Evidence path escaped its work item directory");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return { path: target, sha256: sha256(contents) };
}

export function writeProvenance(repoRoot: string, record: ProvenanceRecord): EvidenceFile {
  const directory = evidenceDirectory(repoRoot, record.workId);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "provenance.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(temporary, body, { flag: "wx" });
  renameSync(temporary, target);
  return { path: target, sha256: sha256(body) };
}

export function makeEvidencePath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
}
