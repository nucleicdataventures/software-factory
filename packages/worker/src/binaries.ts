import { statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, win32 } from "node:path";

export type HostBinaryName = "codex" | "docker";

export interface HostBinaryResolverOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  const direct = environment[key];
  if (direct !== undefined || platform !== "win32") return direct;
  const actualKey = Object.keys(environment).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actualKey ? environment[actualKey] : undefined;
}

function absoluteFile(candidate: string | undefined, platform: NodeJS.Platform): string | null {
  if (!candidate?.trim()) return null;
  const path = platform === "win32" ? win32 : { isAbsolute, resolve };
  const absolutePath = path.resolve(candidate.trim().replace(/^"|"$/g, ""));
  try {
    return statSync(absolutePath).isFile() ? absolutePath : null;
  } catch {
    return null;
  }
}

function pathExtensions(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const configured = environmentValue(environment, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = configured.split(";").map((extension) => extension.trim()).filter(Boolean);
  for (const required of [".CMD", ".EXE", ".BAT"]) {
    if (!extensions.some((extension) => extension.toLowerCase() === required.toLowerCase())) extensions.push(required);
  }
  return [...extensions, ""];
}

function searchPath(name: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathApi = platform === "win32" ? win32 : { join, resolve };
  const pathValue = environmentValue(environment, "PATH", platform) ?? "";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const entries = pathValue.split(pathDelimiter).filter(Boolean);
  const extensions = extname(name) ? [""] : pathExtensions(environment, platform);

  for (const entry of entries) {
    for (const extension of extensions) {
      const found = absoluteFile(pathApi.join(entry, name + extension), platform);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve a host CLI once by the same ordered rules wherever Forge needs it. */
export function resolveHostBinary(name: HostBinaryName, options: HostBinaryResolverOptions = {}): string | null {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = environmentValue(environment, name === "codex" ? "FORGE_CODEX_BIN" : "FORGE_DOCKER_BIN", platform);
  const configured = absoluteFile(override, platform);
  if (configured) return configured;

  const pathName = name === "docker" && platform === "win32" ? "docker.exe" : name;
  const onPath = searchPath(pathName, environment, platform);
  if (onPath) return onPath;

  if (name === "codex") {
    const appData = environmentValue(environment, "APPDATA", platform);
    const localAppData = environmentValue(environment, "LOCALAPPDATA", platform);
    const pathApi = platform === "win32" ? win32 : { join, resolve };
    for (const fallback of [
      appData ? pathApi.join(appData, "npm", "codex.cmd") : undefined,
      appData ? pathApi.join(appData, "npm", "codex") : undefined,
      localAppData ? pathApi.join(localAppData, "npm", "codex.cmd") : undefined,
    ]) {
      const found = absoluteFile(fallback, platform);
      if (found) return found;
    }
    return null;
  }

  if (platform === "win32") {
    return absoluteFile("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", platform);
  }
  return null;
}

/** Normalize a caller-supplied binary path without searching PATH. */
export function resolveBinaryFile(candidate: string | null | undefined, platform: NodeJS.Platform = process.platform): string | null {
  return absoluteFile(candidate ?? undefined, platform);
}

export function usesWindowsCommandShell(executable: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && [".cmd", ".bat"].includes(win32.extname(executable).toLowerCase());
}

/** Quote an executable when it is passed to cmd.exe through Node's shell mode. */
export function quoteWindowsShellExecutable(executable: string): string {
  return `"${executable}"`;
}

/** Keep shell metacharacters and whitespace inside one Windows command argument. */
export function quoteWindowsShellArgument(argument: string): string {
  if (!/[\s&|<>^()%;!]/.test(argument)) return argument;
  return `"${argument.replace(/"/g, '""')}"`;
}

/** Build a direct cmd.exe invocation for a resolved .cmd or .bat executable. */
export function windowsCommandShellInvocation(executable: string, args: string[]): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments: true;
} {
  const env: NodeJS.ProcessEnv = { FORGE_SHELL_EXECUTABLE: executable };
  const argumentReferences = args.map((argument, index) => {
    const key = `FORGE_SHELL_ARG_${index}`;
    env[key] = quoteWindowsShellArgument(argument);
    return `%${key}%`;
  });
  const commandLine = `"${[`"%FORGE_SHELL_EXECUTABLE%"`, ...argumentReferences].join(" ")}"`;
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
    env,
    windowsVerbatimArguments: true,
  };
}
