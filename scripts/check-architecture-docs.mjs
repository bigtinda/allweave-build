#!/usr/bin/env node
/**
 * 架构文档一致性门禁。
 *
 * 校验 docs/architecture 下的 Markdown 与仓库真实代码一致：
 *   1. 行内代码里的仓库路径必须存在（无目录前缀的裸文件名不校验；计划新建的模块见 PLANNED）；
 *   2. `path:行号` 的行号不得超过文件真实行数；
 *   3. "`path` NNNN 行" 的声明与实测行数误差不得超过 5%；
 *   4. Markdown 相对链接必须能解析。
 *
 * 用法：node scripts/check-architecture-docs.mjs [--verbose]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs", "architecture");
// 计划中新建、尚未落盘的模块；这些路径允许暂不存在。
const PLANNED = [
  "packages/kernel-",
  "packages/adapters/",
  "docs/patches/",
  "docs/architecture/archive/",
  // S0–S9 计划产出（尚未落盘）：
  "scripts/measure-baseline.mjs",
  "scripts/metrics/",
  "scripts/check-kernel-boundaries.mjs",
  "scripts/check-cost-parity.mjs",
  "scripts/compare-projection.mjs",
  "docs/architecture/stages/baseline.json",
  "docs/architecture/stages/S0-traces.md",
  "apps/server/src/kernel/",
  "apps/server/src/extensions/",
  "apps/server/src/sandbox/",
  "apps/server/src/sessions/trace.ts",
  "apps/server/src/sessions/approval-store.ts",
  "apps/server/policies/",
  "policies/default.json",
  "scripts/tool-loadout-diff.mjs",
  "apps/server/test/kit/",
  "apps/server/test/fixtures/",
  "apps/server/test/extension-trust.test.ts",
  "apps/server/test/sandbox-exec.test.ts",
  "packages/ai/src/utils/token-estimate.ts",
  "packages/ai/test/token-estimate.test.ts",
  "packages/coding-agent/src/core/context-budget.ts",
  "compaction-controller.ts",
  "agentDir/trust.json",
];
// 计划中的相对片段（`kernel/x.ts`、`shared/protocol.ts` 这类写法按所在包展开）。
const PLANNED_FRAGMENTS = ["kernel/", "sessions/trace.ts", "shared/protocol.ts"];
// 文档中作为"历史事实"提到、已删除的路径；只在记录历史时出现。
const HISTORICAL = ["apps/server/src/app.ts", "docs/rebuild-frontend/"];
// 已按 2026-11-03 评审决定删除的历史文档；只在"记录历史"的上下文出现。
const DELETED = new Set([
  "README.interview.md",
  "current-code-architecture.md",
  "current-code-architecture.svg",
  "current-code-architecture.png",
  "harness-layers.svg",
  "harness-assessment.md",
  "01-current-architecture.md",
  "02-target-architecture.md",
  "03-refactoring-plan.md",
  "04-baseline.md",
  "project-architecture.md",
  "project-architecture.svg",
  "16-kernel-split-plan.md",
  "kernel-split-current.svg",
  "kernel-split-target.svg",
  "kernel-split-roadmap.svg",
  "legacy-issues.md",
]);
const PATH_RE = /^[\w@./-]+\.(?:ts|tsx|mjs|cjs|js|json|md|svg|ps1|yml|yaml|html|css)$/u;
const LINE_RE = /^([\w@./-]+\.(?:ts|tsx|mjs|js|json|md|svg)):(\d+)(?:-(\d+))?$/u;
const COUNT_RE = /`([^`\n]+\.(?:ts|tsx))`\s*(?:共|约)?\s*(\d[\d,]{2,})\s*行/gu;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".pi-console", "out", ".audit", "electron-cache"]);
const failures = [];
const lineCounts = new Map();
let fileIndex;
let verbose = process.argv.includes("--verbose");

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(relative(ROOT, path));
  }
  return files;
}

function index() {
  if (!fileIndex) fileIndex = walk(ROOT);
  return fileIndex;
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 返回绝对路径；无法解析返回 undefined。 */
function resolveTarget(from, target) {
  if (!target.includes("/")) return undefined; // 裸文件名：上下文相对，不校验
  const normalized = target.replaceAll("\\", "/").replace(/^\.\//u, "");
  const direct = [resolve(dirname(from), normalized), resolve(ROOT, normalized)];
  for (const candidate of direct) if (exists(candidate)) return candidate;
  const suffix = `/${normalized}`;
  const matches = index().filter((candidate) => candidate.replaceAll("\\", "/").endsWith(suffix));
  if (matches.length > 0) return resolve(ROOT, matches[0]);
  return undefined;
}

/** 文档里按"已删除的历史文档"出现的文件名（记录清理事实时允许出现）。 */
function isDeletedName(target) {
  const name = target.replaceAll("\\", "/").split("/").pop();
  return DELETED.has(name);
}

function isPlanned(target) {
  const normalized = target.replaceAll("\\", "/");
  if (PLANNED.some((prefix) => normalized.includes(prefix))) return true;
  return PLANNED_FRAGMENTS.some((fragment) => normalized === fragment || normalized.startsWith(fragment));
}

function isHistorical(target) {
  const normalized = target.replaceAll("\\", "/");
  return HISTORICAL.some((prefix) => normalized.includes(prefix));
}

/** 只有"仓库根相对"的路径才参与存在性校验；裸文件名、代码内的相对导入不校验。 */
function isCheckablePath(target) {
  if (!target.includes("/")) return false;
  if (target.startsWith(".")) return false;
  if (target.includes("/.")) return false;
  return true;
}

function countLines(path) {
  if (!lineCounts.has(path)) {
    const parts = readFileSync(path, "utf8").split("\n");
    if (parts.at(-1) === "") parts.pop();
    lineCounts.set(path, parts.length);
  }
  return lineCounts.get(path);
}

function fail(file, message) {
  failures.push(`${relative(ROOT, file).replaceAll(sep, "/")}: ${message}`);
}

function checkMarkdown(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/`([^`\n]+)`/gu)) {
      const token = match[1].trim();
      if (PATH_RE.test(token)) {
        if (isCheckablePath(token) && !resolveTarget(file, token) && !isPlanned(token) && !isHistorical(token) && !isDeletedName(token)) fail(file, `第 ${index + 1} 行引用的路径不存在: ${token}`);
        continue;
      }
      const lineRef = token.match(LINE_RE);
      if (!lineRef) continue;
      const [, target, start, end] = lineRef;
      if (!isCheckablePath(target)) continue;
      const resolved = resolveTarget(file, target);
      if (!resolved) {
        if (!isPlanned(target) && !isHistorical(target) && !isDeletedName(target)) fail(file, `第 ${index + 1} 行引用的路径不存在: ${target}`);
        continue;
      }
      const requested = Number(end ?? start);
      const total = countLines(resolved);
      if (requested > total) fail(file, `第 ${index + 1} 行行号越界: ${target}:${requested}（文件共 ${total} 行）`);
    }

    for (const match of line.matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = match[1].split("#")[0];
      if (!target || !isCheckablePath(target)) continue;
      if (!resolveTarget(file, target) && !isPlanned(target) && !isHistorical(target) && !isDeletedName(target)) fail(file, `第 ${index + 1} 行链接失效: ${target}`);
    }
  }

  for (const match of text.matchAll(COUNT_RE)) {
    const [, target, raw] = match;
    if (!isCheckablePath(target)) continue;
    const resolved = resolveTarget(file, target);
    if (!resolved) continue;
    const claimed = Number(raw.replaceAll(",", ""));
    const actual = countLines(resolved);
    if (Math.abs(claimed - actual) / actual > 0.05) fail(file, `声明行数与实测不符: ${target} 写 ${claimed} 行，实际 ${actual} 行`);
  }
}

for (const entry of readdirSync(DOCS, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".md")) checkMarkdown(join(entry.parentPath ?? entry.path, entry.name));
}

if (failures.length > 0) {
  console.error(`架构文档一致性检查失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

if (verbose) console.log(`检查了 ${lineCounts.size} 个被引用文件，无问题。`);
