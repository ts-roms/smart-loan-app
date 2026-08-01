/**
 * Browser-local face match using @vladmandic/face-api. Lazy-loads the
 * library + model weights on first invocation so the ~6 MB cost is
 * only paid when an officer actually clicks "Run face match" on a
 * loan detail page.
 *
 * Model weights are loaded from `import.meta.env.VITE_FACE_API_MODELS`
 * (default `/models`). To run offline / fully self-hosted, copy the
 * model files from the @vladmandic/face-api repo into your web public
 * folder; the small models we need are:
 *
 *   - tiny_face_detector_model
 *   - face_landmark_68_model
 *   - face_recognition_model
 *
 * Total weight: ~6 MB. If the models aren't reachable, `compareFaces`
 * throws and the caller is expected to surface that as a degraded
 * state ("face match unavailable") rather than crashing.
 */

import type * as faceapi from "@vladmandic/face-api";

const MODEL_BASE_URL = import.meta.env.VITE_FACE_API_MODELS ?? "/models";

let modulePromise: Promise<typeof faceapi> | null = null;
let modelsLoaded = false;

/** Identifier persisted alongside the score so audits know which model produced it. */
export const MODEL_ID = "face-api/vladmandic/tiny+landmarks68+recognition";

/**
 * Lazy-import the lib. Subsequent calls return the same promise so we
 * don't re-download / re-init the TF.js backends.
 */
function importLib(): Promise<typeof faceapi> {
  if (!modulePromise) {
    modulePromise = import("@vladmandic/face-api");
  }
  return modulePromise;
}

/** Idempotent — first call loads, subsequent calls no-op. */
async function ensureModels(api: typeof faceapi): Promise<void> {
  if (modelsLoaded) return;
  // Three models in parallel. Tiny detector is small + fast and
  // sufficient for our use case (one well-lit face per image).
  await Promise.all([
    api.nets.tinyFaceDetector.loadFromUri(MODEL_BASE_URL),
    api.nets.faceLandmark68Net.loadFromUri(MODEL_BASE_URL),
    api.nets.faceRecognitionNet.loadFromUri(MODEL_BASE_URL),
  ]);
  modelsLoaded = true;
}

/**
 * Load an image URL into an HTMLImageElement that face-api can read.
 * crossOrigin is required so the WebGL backend can sample pixels even
 * when the URL is on a different origin (CDN / S3 / our /uploads).
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`Failed to load image: ${url.slice(0, 80)}…`));
    img.src = url;
  });
}

export interface FaceMatchResult {
  /** Normalized similarity 0..1, higher = better. */
  score: number;
  /** Raw Euclidean distance (face-api native output; lower = better). */
  distance: number;
  /** True when score ≥ 0.55 — the conventional "same person" threshold. */
  passed: boolean;
  /** Model identifier for reproducibility. */
  model: string;
}

/**
 * Compare two image URLs. Throws when either image has no detectable
 * face — the caller should treat that as "match indeterminate" rather
 * than a fraud signal (e.g. blurry ID scan).
 */
export async function compareFaces(
  selfieUrl: string,
  idUrl: string,
): Promise<FaceMatchResult> {
  const api = await importLib();
  await ensureModels(api);

  // Load + detect in parallel. Each Image() can fetch independently.
  const [selfieImg, idImg] = await Promise.all([
    loadImage(selfieUrl),
    loadImage(idUrl),
  ]);

  const opts = new api.TinyFaceDetectorOptions({
    inputSize: 416,
    scoreThreshold: 0.4,
  });
  const [selfieDetection, idDetection] = await Promise.all([
    api
      .detectSingleFace(selfieImg, opts)
      .withFaceLandmarks()
      .withFaceDescriptor(),
    api.detectSingleFace(idImg, opts).withFaceLandmarks().withFaceDescriptor(),
  ]);

  if (!selfieDetection || !selfieDetection.descriptor) {
    throw new Error(
      "No face detected in the selfie. Retake with better lighting.",
    );
  }
  if (!idDetection || !idDetection.descriptor) {
    throw new Error("No face detected on the ID. Re-upload a clearer photo.");
  }

  // face-api returns the Euclidean distance between 128-d descriptors.
  // Conventional same-person threshold is 0.6 (i.e. distance < 0.6 ⇒
  // likely same person). We normalize to a 0..1 similarity where 1 =
  // identical: similarity = max(0, 1 - distance).
  const distance = api.euclideanDistance(
    selfieDetection.descriptor,
    idDetection.descriptor,
  );
  const score = Math.max(0, 1 - distance);
  const passed = score >= 0.55;

  return {
    score: Math.round(score * 1000) / 1000,
    distance: Math.round(distance * 1000) / 1000,
    passed,
    model: MODEL_ID,
  };
}
