const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "apps", "web", "public");
const LISTEN_PORT = parseInt(process.env.PORT, 10) || 3000;
const NEXT_PORT = LISTEN_PORT + 1;
const LISTEN_HOST = process.env.HOSTNAME || "0.0.0.0";

const MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".css": "text/css",
  ".js": "application/javascript",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

process.env.PORT = String(NEXT_PORT);
process.env.HOSTNAME = "127.0.0.1";

require("../apps/web/server.js");

function tryServePublic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" || urlPath.startsWith("/_next") || urlPath.startsWith("/api")) {
    return false;
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

  try {
    if (!fs.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function proxyToNext(req, res) {
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: NEXT_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(503);
      res.end("Service starting");
    }
  });
  req.pipe(proxyReq);
}

http
  .createServer((req, res) => {
    if (!tryServePublic(req, res)) {
      proxyToNext(req, res);
    }
  })
  .listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`[serve-public] Listening on ${LISTEN_HOST}:${LISTEN_PORT}, Next.js on 127.0.0.1:${NEXT_PORT}`);
  });
