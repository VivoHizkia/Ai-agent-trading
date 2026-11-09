import { subscribe } from "@/lib/office/watcher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SSE: kirim { type, paths } setiap ada file berubah di office/. Klien lalu mengambil ulang snapshot.
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(enc.encode(data));
        } catch {
          cleanup();
        }
      };
      send(`retry: 5000\ndata: ${JSON.stringify({ type: "hello" })}\n\n`);
      const unsubscribe = subscribe(ev => send(`data: ${JSON.stringify(ev)}\n\n`));
      const ping = setInterval(() => send(`: ping\n\n`), 25_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* sudah tertutup */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
