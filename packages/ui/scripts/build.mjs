import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, "public");
const output = join(packageRoot, "dist");
mkdirSync(output, { recursive: true });
for (const file of ["index.html", "app.js", "styles.css"]) {
  copyFileSync(join(source, file), join(output, file));
}
