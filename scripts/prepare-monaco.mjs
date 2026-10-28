import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
// Monaco's exports map does not expose package.json. Resolve its public entry
// and locate the owning package without relying on node_modules layout.
let packageRoot = path.dirname(require.resolve("monaco-editor"));
while (true) {
  try {
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name === "monaco-editor") break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(packageRoot);
  if (parent === packageRoot) throw new Error("Cannot locate the installed monaco-editor package");
  packageRoot = parent;
}
const source = path.join(packageRoot, "min/vs");
const destination = path.join(root, "public/monaco");
const marker = ".generated-monaco.json";

async function exists(target) {
  try { return await lstat(target); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inventory(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === marker) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files[`${relative}/`] = "directory";
      Object.assign(files, await inventory(absolute, relative));
    }
    else if (entry.isFile()) files[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    else throw new Error(`Refusing non-regular generated asset: ${absolute}`);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

await mkdir(path.join(root, "public"), { recursive: true });
const existing = await exists(destination);
if (existing) {
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Refusing unexpected destination: ${destination}`);
  const markerPath = path.join(destination, marker);
  const markerStat = await exists(markerPath);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) throw new Error(`Refusing unowned Monaco directory: ${destination}`);
  const previous = JSON.parse(await readFile(markerPath, "utf8"));
  if (previous.generator !== "scripts/prepare-monaco.mjs" || JSON.stringify(previous.files) !== JSON.stringify(await inventory(destination))) {
    throw new Error(`Refusing to overwrite modified or unexpected Monaco assets: ${destination}`);
  }
}

// Build outside the served directory, then publish a complete matching asset tree.
const staging = path.join(root, `public/.monaco-stage-${process.pid}`);
await mkdir(staging); // Never reuse or overwrite an unexpected staging directory.
try {
  await cp(source, path.join(staging, "vs"), { recursive: true, force: false, errorOnExist: true });
  const files = await inventory(staging);
  await writeFile(path.join(staging, marker), JSON.stringify({ generator: "scripts/prepare-monaco.mjs", files }, null, 2));
  if (existing) await rm(destination, { recursive: true });
  await rename(staging, destination);
  console.log(`Prepared ${Object.keys(files).length} local Monaco assets in ${destination}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
