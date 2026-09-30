import * as fs from "node:fs";
import * as path from "node:path";
const MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
};
/**
 * Read and base64-encode an image for vision-capable models (Candidate #25)
 */
export function encodeImageFile(filePath, workspace) {
    const resolvedPath = workspace ? path.resolve(workspace, filePath) : path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        return {
            success: false,
            filePath,
            mimeType: "",
            dataUri: "",
            sizeBytes: 0,
            error: `Image file does not exist: ${filePath}`,
        };
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeType = MIME_MAP[ext];
    if (!mimeType) {
        return {
            success: false,
            filePath,
            mimeType: "",
            dataUri: "",
            sizeBytes: 0,
            error: `Unsupported image format '${ext}'. Supported: png, jpg, jpeg, webp, gif, svg`,
        };
    }
    try {
        const buffer = fs.readFileSync(resolvedPath);
        const base64 = buffer.toString("base64");
        const dataUri = `data:${mimeType};base64,${base64}`;
        return {
            success: true,
            filePath: resolvedPath,
            mimeType,
            dataUri,
            sizeBytes: buffer.length,
        };
    }
    catch (err) {
        return {
            success: false,
            filePath,
            mimeType: "",
            dataUri: "",
            sizeBytes: 0,
            error: `Failed to read image file: ${err.message}`,
        };
    }
}
/**
 * Format an OpenAI/vLLM vision message payload
 */
export function formatVisionContent(prompt, imageUris) {
    const list = Array.isArray(imageUris) ? imageUris : [imageUris];
    const items = [
        { type: "text", text: prompt },
    ];
    for (const uri of list) {
        items.push({
            type: "image_url",
            image_url: {
                url: uri,
            },
        });
    }
    return items;
}
