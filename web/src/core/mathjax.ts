// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { AUTHORIZED_MATHJAX_SCRIPTS } from "./csp-constants";

export interface MathJaxAssets {
    script: string;
    sources: Record<string, string>;
    hashes: string[];
}

let assetsPromise: Promise<MathJaxAssets> | null = null;

/**
 * Filter the cached MathJax extension map to only the extensions referenced by the
 * current card's TeX markup so we do not repeatedly embed every extension into every
 * card iframe's `srcDoc` (U-06).
 */
export function selectMathJaxSourcesForHtml(
    html: string,
    allSources: Record<string, string>,
): Record<string, string> {
    if (!html) { return {}; }
    const selected: Record<string, string> = {};
    const addKey = (key: string) => {
        if (allSources[key]) {
            selected[key] = allSources[key];
        }
    };

    if (/\\(?:textcolor|colorbox|fcolorbox|color|pagecolor)\b/.test(html)) {
        addKey("[tex]/color");
    }
    if (/\\(?:ce|pu)\b/.test(html)) {
        addKey("[tex]/mhchem");
    }
    if (/\\(?:dv|pdv|grad|div|curl|dd|va|vb|vu|abs|norm|eval|order|comm|acomm|pb)\b/.test(html)) {
        addKey("[tex]/physics");
    }
    if (/\\(?:bra|ket|braket|set|Bra|Ket|Braket|Set)\b/.test(html)) {
        addKey("[tex]/braket");
    }
    if (/\\(?:cancel|bcancel|xcancel|cancelto)\b/.test(html)) {
        addKey("[tex]/cancel");
    }
    if (/\\begin\{(?:numcases|subnumcases)\}/.test(html)) {
        addKey("[tex]/cases");
    }
    if (/\\enclose\b/.test(html)) {
        addKey("[tex]/enclose");
    }
    if (/\\(?:xmapsto|xtofrom|xleftrightarrow|xrightequilibrium|xleftequilibrium|Newextarrow)\b/.test(html)) {
        addKey("[tex]/extpfeil");
    }
    if (/\\(?:degree|celsius|perthousand|micro|ohm)\b/.test(html)) {
        addKey("[tex]/gensymb");
    }
    if (/\\bbox\b/.test(html)) {
        addKey("[tex]/bbox");
    }
    if (/\\boldsymbol\b/.test(html)) {
        addKey("[tex]/boldsymbol");
    }
    if (/\\(?:coloneqq|eqqcolon|coloneq|Prescript| smashoperator|mathclap)\b/.test(html)) {
        addKey("[tex]/mathtools");
    }
    if (/\\begin\{CD\}/.test(html)) {
        addKey("[tex]/amscd");
    }
    if (/\\unicode\b/.test(html)) {
        addKey("[tex]/unicode");
    }
    if (
        /\\up(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/i
            .test(html)
    ) {
        addKey("[tex]/upgreek");
    }
    if (/\\verb\b/.test(html)) {
        addKey("[tex]/verb");
    }
    if (/\\require\b/.test(html)) {
        addKey("[tex]/require");
        const reqRe = /\\require\s*\{\s*([a-zA-Z0-9_-]+)\s*\}/g;
        let m: RegExpExecArray | null;
        while ((m = reqRe.exec(html)) !== null) {
            addKey(`[tex]/${m[1]}`);
        }
    }

    return selected;
}

// Fetch the authorized self-hosted MathJax scripts through the controlled parent
// and cache their base64 data URLs and CSP hashes in memory (M-02, U-06).
export function loadMathJaxAssets(): Promise<MathJaxAssets> {
    if (!assetsPromise) {
        assetsPromise = (async () => {
            const response = await fetch("/vendor/mathjax/precache-svg.json");
            if (!response.ok) { throw new Error("Offline math assets unavailable"); }
            const manifestPaths = new Set<string>(await response.json());
            const sources: Record<string, string> = {};
            const hashes: string[] = [];
            let script = "";

            await Promise.all(
                AUTHORIZED_MATHJAX_SCRIPTS.map(async entry => {
                    if (!manifestPaths.has(entry.path)) { return; }
                    const asset = await fetch(entry.path);
                    if (!asset.ok) { throw new Error(`Math asset unavailable: ${entry.path}`); }
                    const bytes = new Uint8Array(await asset.arrayBuffer());
                    hashes.push(entry.sha256);
                    let binary = "";
                    for (let i = 0; i < bytes.length; i += 0x8000) {
                        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                    }
                    const url = `data:text/javascript;base64,${btoa(binary)}`;
                    if (entry.key === "tex-svg") {
                        script = url;
                    } else {
                        sources[entry.key] = url;
                    }
                }),
            );
            if (!script) { throw new Error("Offline math renderer unavailable"); }
            return { script, sources, hashes };
        })().catch(error => {
            assetsPromise = null;
            throw error;
        });
    }
    return assetsPromise;
}
