// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Vendor the SVG build and optional TeX/accessibility extensions for offline cards.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(webRoot, "node_modules", "mathjax", "es5");
const vendorDir = join(webRoot, "public", "vendor", "mathjax");
const outDir = join(vendorDir, "es5");
if (!existsSync(srcDir)) { throw new Error("Install web dependencies before vendoring MathJax."); }
rmSync(outDir, { recursive: true, force: true });
rmSync(join(vendorDir, "precache.json"), { force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(srcDir, "tex-svg.js"), join(outDir, "tex-svg.js"));
cpSync(join(srcDir, "input", "tex", "extensions"), join(outDir, "input", "tex", "extensions"), { recursive: true });
cpSync(join(srcDir, "a11y"), join(outDir, "a11y"), { recursive: true });
cpSync(join(webRoot, "node_modules", "mathjax", "LICENSE"), join(vendorDir, "LICENSE"));

function collectFiles(dir, prefix) {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        return statSync(path).isDirectory()
            ? collectFiles(path, `${prefix}/${name}`)
            : [`${prefix}/${name}`];
    });
}
const files = collectFiles(outDir, "/vendor/mathjax/es5");
writeFileSync(join(vendorDir, "precache-svg.json"), JSON.stringify(files, null, 2) + "\n");
console.log(`Vendored ${files.length} offline MathJax assets.`);
