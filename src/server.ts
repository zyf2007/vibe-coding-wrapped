import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export type StaticServer = {
  server: Server;
  url: string;
};

export async function startStaticServer(directory: string, host = "127.0.0.1", port = 4173): Promise<StaticServer> {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const pathname = decodeURIComponent(url.pathname);
      let path = resolve(root, `.${pathname}`);
      if (path !== root && !path.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let info = await stat(path);
      if (info.isDirectory()) {
        path = join(path, "index.html");
        info = await stat(path);
      }
      if (!info.isFile() || relative(root, path).startsWith("..")) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": extname(path) === ".html" ? "no-cache" : "public, max-age=60",
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${actualPort}/` };
}
