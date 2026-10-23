// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Shared Media Content, Signature, Dimension & Filename Validation (SEC-13, UX-10)

export const MAX_SINGLE_MEDIA_BYTES = 1 * 1024 * 1024; // Conservative SQLite-backed storage limit; larger files require R2
export const MAX_MEDIA_DATA_URL_LEN = 1_450_000; // Base64 limit leaves headroom below 2 MiB SQLite value ceiling
export const MAX_IMAGE_DIMENSION = 8192; // Max width or height in pixels
export const MAX_IMAGE_PIXELS = 33_554_432; // 32 megapixels max decoded area
export const MAX_MEDIA_FILENAME_LEN = 200;

const ALLOWED_MEDIA_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "avif",
    "mp3",
    "wav",
    "ogg",
    "m4a",
    "webm",
]);

const ALLOWED_DATA_URL_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/avif",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/webm",
]);

/**
 * Normalize and validate a media filename against path traversal, control characters,
 * hidden dot-files, and disallowed extensions (SEC-13).
 */
export function normalizeMediaFilename(raw: string): string | null {
    if (typeof raw !== "string") { return null; }
    // Strip control characters and null bytes
    let cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!cleaned) { return null; }

    // Replace path separators with underscores and forbid traversal segments
    if (cleaned === "." || cleaned === ".." || cleaned.includes("..")) {
        cleaned = cleaned.replace(/\.\.+/g, "_");
    }
    cleaned = cleaned.replace(/[\\/]+/g, "_").replace(/^\.+/, "");
    if (!cleaned || cleaned.length > MAX_MEDIA_FILENAME_LEN) {
        return null;
    }

    const dotIdx = cleaned.lastIndexOf(".");
    if (dotIdx <= 0 || dotIdx === cleaned.length - 1) {
        return null;
    }
    const ext = cleaned.slice(dotIdx + 1).toLowerCase();
    if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
        return null;
    }
    return cleaned;
}

function readU16BE(bytes: Uint8Array, off: number): number {
    return (bytes[off] << 8) | bytes[off + 1];
}

function readU16LE(bytes: Uint8Array, off: number): number {
    return bytes[off] | (bytes[off + 1] << 8);
}

function readU24LE(bytes: Uint8Array, off: number): number {
    return bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
}

function readU32BE(bytes: Uint8Array, off: number): number {
    return (
        ((bytes[off] << 24) >>> 0)
        + ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3])
    );
}

function readU32LE(bytes: Uint8Array, off: number): number {
    return (
        (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16))
        + ((bytes[off + 3] << 24) >>> 0)
    );
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    let off = 2;
    while (off + 4 <= bytes.length) {
        if (bytes[off] !== 0xff) {
            off++;
            continue;
        }
        while (off < bytes.length && bytes[off] === 0xff) {
            off++;
        }
        if (off >= bytes.length) { break; }
        const marker = bytes[off++];
        // Standalone markers without length
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            continue;
        }
        if (off + 2 > bytes.length) { break; }
        const segLen = readU16BE(bytes, off);
        if (segLen < 2 || off + segLen > bytes.length) { break; }

        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        const isSof = (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf);
        if (isSof && segLen >= 7) {
            const height = readU16BE(bytes, off + 3);
            const width = readU16BE(bytes, off + 5);
            return { width, height };
        }
        off += segLen;
    }
    return null;
}

function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    if (bytes.length < 30) { return null; }
    const chunkTag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunkTag === "VP8 " && bytes.length >= 30) {
        // Keyframe start code 0x9d 0x01 0x2a at offset 23..25
        if (bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
            const width = readU16LE(bytes, 26) & 0x3fff;
            const height = readU16LE(bytes, 28) & 0x3fff;
            return { width, height };
        }
    } else if (chunkTag === "VP8L" && bytes.length >= 25) {
        if (bytes[20] === 0x2f) {
            const b0 = bytes[21];
            const b1 = bytes[22];
            const b2 = bytes[23];
            const b3 = bytes[24];
            const width = 1 + (b0 | ((b1 & 0x3f) << 8));
            const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
            return { width, height };
        }
    } else if (chunkTag === "VP8X" && bytes.length >= 30) {
        const width = 1 + readU24LE(bytes, 24);
        const height = 1 + readU24LE(bytes, 27);
        return { width, height };
    }
    return null;
}

function validateImageDimensions(
    width: number,
    height: number,
): { ok: true; width: number; height: number } | { ok: false; error: string } {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { ok: false, error: "Invalid image dimensions" };
    }
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        return {
            ok: false,
            error:
                `Image dimensions (${width}x${height}) exceed maximum allowed (${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION})`,
        };
    }
    if (width * height > MAX_IMAGE_PIXELS) {
        return {
            ok: false,
            error: `Image pixel count (${width * height}) exceeds maximum allowed (${MAX_IMAGE_PIXELS})`,
        };
    }
    return { ok: true, width, height };
}

/**
 * Inspect raw media bytes to verify content magic-byte signatures, byte size caps,
 * and image dimension bounds (SEC-13).
 */
export function inspectMediaBytes(
    bytes: Uint8Array,
): { ok: true; mime: string; width?: number; height?: number } | { ok: false; error: string } {
    if (!bytes || bytes.byteLength === 0) {
        return { ok: false, error: "Media file is empty" };
    }
    if (bytes.byteLength > MAX_SINGLE_MEDIA_BYTES) {
        return {
            ok: false,
            error: `Media file exceeds maximum size (${Math.round(MAX_SINGLE_MEDIA_BYTES / 1024 / 1024)} MB)`,
        };
    }

    // 1. PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
    if (
        bytes.length >= 24
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a
    ) {
        const width = readU32BE(bytes, 16);
        const height = readU32BE(bytes, 20);
        const dim = validateImageDimensions(width, height);
        if (!dim.ok) { return dim; }
        return { ok: true, mime: "image/png", width, height };
    }

    // 2. JPEG: FF D8 FF
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        const dims = parseJpegDimensions(bytes);
        if (dims) {
            const dim = validateImageDimensions(dims.width, dims.height);
            if (!dim.ok) { return dim; }
            return { ok: true, mime: "image/jpeg", width: dims.width, height: dims.height };
        }
        return { ok: true, mime: "image/jpeg" };
    }

    // 3. GIF: "GIF87a" or "GIF89a"
    if (
        bytes.length >= 10
        && bytes[0] === 0x47
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x38
        && (bytes[4] === 0x37 || bytes[4] === 0x39)
        && bytes[5] === 0x61
    ) {
        const width = readU16LE(bytes, 6);
        const height = readU16LE(bytes, 8);
        const dim = validateImageDimensions(width, height);
        if (!dim.ok) { return dim; }
        return { ok: true, mime: "image/gif", width, height };
    }

    // 4. RIFF containers: WEBP or WAV
    if (
        bytes.length >= 12
        && bytes[0] === 0x52
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x46
    ) {
        const fourCc = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (fourCc === "WEBP") {
            const dims = parseWebpDimensions(bytes);
            if (dims) {
                const dim = validateImageDimensions(dims.width, dims.height);
                if (!dim.ok) { return dim; }
                return { ok: true, mime: "image/webp", width: dims.width, height: dims.height };
            }
            return { ok: true, mime: "image/webp" };
        }
        if (fourCc === "WAVE") {
            return { ok: true, mime: "audio/wav" };
        }
    }

    // 5. BMP: "BM"
    if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
        const width = Math.abs(readU32LE(bytes, 18) | 0);
        const height = Math.abs(readU32LE(bytes, 22) | 0);
        const dim = validateImageDimensions(width, height);
        if (!dim.ok) { return dim; }
        return { ok: true, mime: "image/bmp", width, height };
    }

    // 6. ISO BMFF (AVIF / M4A): "ftyp" at offset 4..8
    if (
        bytes.length >= 12
        && bytes[4] === 0x66
        && bytes[5] === 0x74
        && bytes[6] === 0x79
        && bytes[7] === 0x70
    ) {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (brand === "avif" || brand === "avis") {
            return { ok: true, mime: "image/avif" };
        }
        if (brand === "M4A " || brand === "mp42" || brand === "isom") {
            return { ok: true, mime: "audio/mp4" };
        }
    }

    // 7. OGG: "OggS"
    if (
        bytes.length >= 4
        && bytes[0] === 0x4f
        && bytes[1] === 0x67
        && bytes[2] === 0x67
        && bytes[3] === 0x53
    ) {
        return { ok: true, mime: "audio/ogg" };
    }

    // 8. MP3: "ID3" or MPEG frame sync (FF FB / FF F3 / FF F2 / FF E3 / FF FA)
    if (
        bytes.length >= 3
        && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
            || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    ) {
        return { ok: true, mime: "audio/mpeg" };
    }

    // 9. WebM / Matroska: 1A 45 DF A3
    if (
        bytes.length >= 4
        && bytes[0] === 0x1a
        && bytes[1] === 0x45
        && bytes[2] === 0xdf
        && bytes[3] === 0xa3
    ) {
        return { ok: true, mime: "audio/webm" };
    }

    return {
        ok: false,
        error: "Unsupported or unrecognized media file signature (only valid images and audio are allowed)",
    };
}

function canonicalizeMime(mime: string): string {
    const lower = mime.toLowerCase().trim();
    if (lower === "image/jpg") { return "image/jpeg"; }
    if (lower === "audio/mp3") { return "audio/mpeg"; }
    if (lower === "audio/x-wav") { return "audio/wav"; }
    if (lower === "audio/x-m4a") { return "audio/mp4"; }
    return lower;
}

/**
 * Validate a media filename and `data:<mime>;base64,...` URL, enforcing that the
 * declared MIME matches the inspected binary magic-byte signature and returning
 * the canonical normalized filename and data URL (SEC-13, L-02, L-03).
 */
export function validateMediaDataUrl(
    filename: string,
    dataUrl: string,
):
    | { ok: true; safeFilename: string; mime: string; canonicalDataUrl: string; decodedBytes: number }
    | { ok: false; error: string }
{
    const safeFilename = normalizeMediaFilename(filename);
    if (!safeFilename) {
        return { ok: false, error: "Invalid or disallowed media filename" };
    }
    if (typeof dataUrl !== "string" || !dataUrl || dataUrl.length > MAX_MEDIA_DATA_URL_LEN) {
        return { ok: false, error: "Media dataUrl exceeds maximum allowed size" };
    }

    const match = dataUrl.match(/^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
        return { ok: false, error: "Media must be a valid base64 data URL" };
    }

    const declaredMime = match[1].toLowerCase();
    if (!ALLOWED_DATA_URL_MIMES.has(declaredMime)) {
        return { ok: false, error: `Disallowed media MIME type: ${declaredMime}` };
    }

    const b64 = match[2].replace(/\s+/g, "");
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor((b64.length * 3) / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > MAX_SINGLE_MEDIA_BYTES) {
        return {
            ok: false,
            error:
                `Decoded media size (${decodedBytes} bytes) exceeds maximum allowed (${MAX_SINGLE_MEDIA_BYTES} bytes)`,
        };
    }

    let detectedMime = canonicalizeMime(declaredMime);
    if (decodedBytes >= 12) {
        try {
            const prefixChars = Math.min(b64.length, 87_380); // ~64 KB
            const alignedLen = prefixChars - (prefixChars % 4);
            const rawStr = atob(b64.slice(0, alignedLen));
            const prefix = new Uint8Array(rawStr.length);
            for (let i = 0; i < rawStr.length; i++) {
                prefix[i] = rawStr.charCodeAt(i);
            }
            const sig = inspectMediaBytes(prefix);
            if (!sig.ok) {
                return sig;
            }
            if (canonicalizeMime(declaredMime) !== canonicalizeMime(sig.mime)) {
                return {
                    ok: false,
                    error: `Declared MIME type (${declaredMime}) does not match detected file signature (${sig.mime})`,
                };
            }
            detectedMime = sig.mime;
        } catch {
            return { ok: false, error: "Malformed base64 media payload" };
        }
    }

    return {
        ok: true,
        safeFilename,
        mime: detectedMime,
        canonicalDataUrl: `data:${detectedMime};base64,${b64}`,
        decodedBytes,
    };
}
