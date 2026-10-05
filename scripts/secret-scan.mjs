import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", ".next", "node_modules", "coverage", ".venv", ".agents"]);
const ignoredFiles = new Set(["package-lock.json", "skills-lock.json"]);
const extensions = new Set([".env", ".json", ".md", ".mjs", ".js", ".ts", ".tsx", ".yaml", ".yml", ".toml", ".service"]);
const findings = [];
const knownSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
];
const assignmentPattern = /\b(?:api[_-]?key|client[_-]?secret|server[_-]?token|webhook[_-]?secret|token[_-]?pepper)\b\s*[:=]\s*["']([^"'\n]{24,})["']/gi;
const safeMarkers = ["replace-with", "example", "integration", "fixture", "not-production", "process.env", "configured"];

for (const path of await walk(root)) {
  const name = path.split("/").at(-1) ?? "";
  if (ignoredFiles.has(name) || (name.startsWith(".env") && name !== ".env.example")) continue;
  if (!extensions.has(extname(path)) && !name.endsWith(".service")) continue;
  const content = await readFile(path, "utf8");
  for (const pattern of knownSecretPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) findings.push(`${relative(root, path)}: known credential pattern ${mask(match[0])}`);
  }
  assignmentPattern.lastIndex = 0;
  for (const match of content.matchAll(assignmentPattern)) {
    const value = match[1].toLowerCase();
    if (!safeMarkers.some((marker) => value.includes(marker))) {
      findings.push(`${relative(root, path)}: suspicious long secret assignment ${mask(match[1])}`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Secret scan passed: no credential-shaped values found.");
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function mask(value) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
