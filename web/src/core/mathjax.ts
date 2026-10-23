// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

export interface MathJaxAssets {
    script: string;
    sources: Record<string, string>;
    hashes: string[];
}

let assetsPromise: Promise<MathJaxAssets> | null = null;

async function sha256CspSource(bytes: Uint8Array): Promise<string | null> {
    if (typeof crypto === "undefined" || !crypto.subtle) { return null; }
    try {
        const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
        const hashBytes = new Uint8Array(digest);
        let binary = "";
        for (let i = 0; i < hashBytes.length; i++) {
            binary += String.fromCharCode(hashBytes[i]);
        }
        return `'sha256-${btoa(binary)}'`;
    } catch {
        return null;
    }
}

// An opaque-origin iframe cannot use its parent's service worker. Fetch the
// bundled scripts through the controlled parent, then pass inert data URLs into
// the sandbox along with their SHA-256 CSP hashes (SEC-07). SVG output embeds
// glyphs, so no font requests escape the sandbox.
export function loadMathJaxAssets(): Promise<MathJaxAssets> {
    if (!assetsPromise) {
        assetsPromise = (async () => {
            const response = await fetch("/vendor/mathjax/precache-svg.json");
            if (!response.ok) { throw new Error("Offline math assets unavailable"); }
            const paths: string[] = await response.json();
            const sources: Record<string, string> = {};
            const hashes: string[] = [];
            let script = "";
            await Promise.all(paths.map(async path => {
                if (!/^\/vendor\/mathjax\/es5\/[\w/.-]+\.js$/.test(path)) { return; }
                const asset = await fetch(path);
                if (!asset.ok) { throw new Error(`Math asset unavailable: ${path}`); }
                const bytes = new Uint8Array(await asset.arrayBuffer());
                const cspHash = await sha256CspSource(bytes);
                if (cspHash) { hashes.push(cspHash); }
                let binary = "";
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                const url = `data:text/javascript;base64,${btoa(binary)}`;
                if (path.endsWith("/tex-svg.js")) { script = url; }
                else {
                    const name = path.replace("/vendor/mathjax/es5/", "").replace(/\.js$/, "");
                    const key = name.replace("input/tex/extensions/", "[tex]/");
                    sources[key] = url;
                    if (name.startsWith("a11y/")) { sources[name.replace("a11y/", "[a11y]/")] = url; }
                }
            }));
            if (!script) { throw new Error("Offline math renderer unavailable"); }
            return { script, sources, hashes };
        })().catch(error => {
            assetsPromise = null;
            throw error;
        });
    }
    return assetsPromise;
}
