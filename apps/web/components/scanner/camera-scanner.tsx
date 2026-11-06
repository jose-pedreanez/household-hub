"use client";

import { Camera, CameraOff, Flashlight, FlashlightOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/primitives";
import { detectFormat } from "@/lib/barcode/normalize";
import { DEFAULT_SCAN_GATE, ScanGate } from "@/lib/barcode/scan-gate";

type DetectorCtor = typeof import("barcode-detector/ponyfill").BarcodeDetector;
let detectorCtor: Promise<DetectorCtor> | null = null;

/** Load the ZXing-C++ decoder once, served from this app (public/zxing), never from a CDN. */
function loadDetector(): Promise<DetectorCtor> {
  detectorCtor ??= import("barcode-detector/ponyfill").then((m) => {
    m.prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? `/zxing/${path}` : prefix + path) },
    });
    return m.BarcodeDetector;
  });
  return detectorCtor;
}

const FORMATS = ["ean_13", "upc_a", "ean_8", "upc_e"] as const;
const FRAME_INTERVAL_MS = 120;

function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow camera access for this site in your browser settings, then tap Start camera.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device. Use the scanner or type the barcode instead.";
  if (name === "NotReadableError") return "The camera is in use by another app. Close it and try again.";
  return `Could not start the camera${e instanceof Error ? `: ${e.message}` : ""}.`;
}

export function CameraScanner({ onDetect, paused }: { onDetect: (code: string) => void; paused: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const gateRef = useRef(new ScanGate(DEFAULT_SCAN_GATE));
  const onDetectRef = useRef(onDetect);
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });

  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    gateRef.current.reset();
    setTorch({ supported: false, on: false });
    setState((s) => (s === "error" ? s : "idle"));
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setError(
        window.isSecureContext
          ? "This browser cannot access the camera."
          : "The camera only works over HTTPS. Open the hub through its https:// address (see Settings), or use the scanner / manual entry.",
      );
      return;
    }
    setState("starting");
    try {
      const Detector = await loadDetector();
      const detector = new Detector({ formats: [...FORMATS] });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorch({ supported: !!caps.torch, on: false });
      runningRef.current = true;
      setState("running");

      const tick = async () => {
        if (!runningRef.current) return;
        try {
          if (video.readyState >= 2 && !document.hidden) {
            const found = await detector.detect(video);
            // Accept only checksum-valid retail codes (UPC-A, EAN-13, EAN-8, UPC-E).
            const codes = found.map((b) => b.rawValue).filter((c) => detectFormat(c) !== "other");
            for (const code of gateRef.current.observe(codes, performance.now())) {
              setFlash((n) => n + 1);
              navigator.vibrate?.(60);
              onDetectRef.current(code);
            }
          }
        } catch {
          // A single failed frame is not fatal; keep scanning.
        }
        if (runningRef.current) timerRef.current = setTimeout(tick, FRAME_INTERVAL_MS);
      };
      void tick();
    } catch (e) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState("error");
      setError(cameraError(e));
    }
  }, []);

  // Release the camera when the page is hidden; it can be restarted with one tap.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && runningRef.current) stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (paused && runningRef.current) stop();
  }, [paused, stop]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on });
    } catch {
      setTorch({ supported: false, on: false });
    }
  }

  const running = state === "running";
  return (
    <div className="grid gap-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black sm:aspect-video">
        <video ref={videoRef} className="h-full w-full object-cover" playsInline muted aria-label="Camera preview" />
        {running ? (
          <>
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="relative h-[38%] w-[78%] rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.38)]">
                {["left-0 top-0 border-l-4 border-t-4 rounded-tl-lg", "right-0 top-0 border-r-4 border-t-4 rounded-tr-lg", "left-0 bottom-0 border-l-4 border-b-4 rounded-bl-lg", "right-0 bottom-0 border-r-4 border-b-4 rounded-br-lg"].map((c) => (
                  <span key={c} className={`absolute size-7 border-white ${c}`} />
                ))}
                <span className="absolute inset-x-3 top-1/2 h-0.5 bg-accent/80" />
              </div>
            </div>
            {flash > 0 ? <div key={flash} className="animate-scan-flash pointer-events-none absolute inset-0 bg-success/60" /> : null}
            <p className="absolute inset-x-0 bottom-2 text-center text-xs font-medium text-white/90">Hold the barcode inside the frame</p>
          </>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-white/70">
            <div className="flex flex-col items-center gap-2 text-sm">
              <Camera className="size-8" />
              {state === "starting" ? "Starting camera…" : "Camera is off"}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button variant="outline" onClick={stop}>
            <CameraOff /> Stop camera
          </Button>
        ) : (
          <Button onClick={start} disabled={state === "starting" || paused}>
            <Camera /> {state === "starting" ? "Starting…" : "Start camera"}
          </Button>
        )}
        {running && torch.supported ? (
          <Button variant="outline" onClick={toggleTorch} aria-pressed={torch.on}>
            {torch.on ? <FlashlightOff /> : <Flashlight />} Light
          </Button>
        ) : null}
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}
