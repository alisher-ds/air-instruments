// The camera may be HD (1280x720) so the picture on screen is sharper, but MediaPipe works on a small image anyway (~256 px).
// Sending 720p bitmaps to the worker only costs time, so the frame is shrunk to at most `maxWidth` while it is grabbed
// (createImageBitmap does it cheaply). The landmarks are normalized (0..1), so the smaller picture changes nothing for them.

export interface BitmapSize {
  resizeWidth: number;
  resizeHeight: number;
  resizeQuality: "low";
}

/** null = send the video as it is (already small enough). */
export function trackingBitmapSize(videoWidth: number, videoHeight: number, maxWidth = 640): BitmapSize | null {
  if (!(videoWidth > maxWidth) || !(videoHeight > 0)) return null;
  const k = maxWidth / videoWidth;
  return { resizeWidth: maxWidth, resizeHeight: Math.max(1, Math.round(videoHeight * k)), resizeQuality: "low" };
}
