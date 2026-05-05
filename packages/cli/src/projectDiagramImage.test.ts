import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectDiagramImageDownloadUrl,
  downloadProjectDiagramImage,
  normalizeProjectDiagramImageFormat,
  normalizeProjectDiagramImageLabels,
  normalizeProjectDiagramImageLayout,
  resolveProjectDiagramImageFrontendUrl,
} from "./projectDiagramImage.js";

test("buildProjectDiagramImageDownloadUrl builds private bearer image URLs", () => {
  const url = buildProjectDiagramImageDownloadUrl({
    frontendUrl: "https://cloudeval.ai/",
    projectId: "project 1",
    layout: "architecture",
    format: "png",
    labels: "all",
    userId: "user-1",
    publicGraph: false,
  });

  assert.equal(
    url,
    "https://cloudeval.ai/api/projects/project%201/diagram-image?layout=architecture&format=png&labels=all&user_id=user-1",
  );
});

test("buildProjectDiagramImageDownloadUrl builds explicit public share URLs", () => {
  const url = buildProjectDiagramImageDownloadUrl({
    frontendUrl: "http://localhost:3011",
    projectId: "project-main",
    layout: "dependency",
    format: "svg",
    labels: "viewport",
    publicGraph: true,
    syncVersion: "sync-1",
  });

  assert.equal(
    url,
    "http://localhost:3011/api/projects/project-main/diagram-image?layout=dependency&format=svg&labels=viewport&public=1&sync_version=sync-1",
  );
});

test("buildProjectDiagramImageDownloadUrl rejects private user scope on public downloads", () => {
  assert.throws(
    () =>
      buildProjectDiagramImageDownloadUrl({
        frontendUrl: "https://cloudeval.ai",
        projectId: "project-main",
        layout: "dependency",
        format: "png",
        labels: "all",
        userId: "user-1",
        publicGraph: true,
      }),
    /Public diagram image downloads cannot include userId/,
  );
});

test("downloadProjectDiagramImage explains frontend network failures", async () => {
  const originalFetch = globalThis.fetch;
  const cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:3011"),
    { code: "ECONNREFUSED" },
  );
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
  globalThis.fetch = async () => {
    throw fetchError;
  };

  try {
    await assert.rejects(
      () =>
        downloadProjectDiagramImage({
          frontendUrl: "http://localhost:3011",
          projectId: "project-main",
          layout: "architecture",
          format: "png",
          labels: "all",
          userId: "user-1",
          token: "token-1",
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /Failed to fetch diagram image from http:\/\/localhost:3011\/api\/projects\/project-main\/diagram-image\?layout=architecture&format=png&labels=all&user_id=user-1/,
        );
        assert.match(error.message, /ECONNREFUSED/);
        assert.match(error.message, /frontend dev server is running/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadProjectDiagramImage summarizes frontend HTML errors", async () => {
  const originalFetch = globalThis.fetch;
  const html = `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    err: {
      message:
        "Cannot find module './vendor-chunks/@opentelemetry.js'\nRequire stack:\n- /repo/.next/server/webpack-runtime.js",
    },
  })}</script></body></html>`;
  globalThis.fetch = async () =>
    new Response(html, {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  try {
    await assert.rejects(
      () =>
        downloadProjectDiagramImage({
          frontendUrl: "http://localhost:3000",
          projectId: "project-main",
          layout: "architecture",
          format: "svg",
          labels: "all",
          userId: "user-1",
          token: "token-1",
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /Diagram image download failed with status 500 Internal Server Error/,
        );
        assert.match(
          error.message,
          /Frontend returned an HTML error page: Cannot find module '.\/vendor-chunks\/@opentelemetry.js'/,
        );
        assert.match(error.message, /stale Next.js dev server\/cache/);
        assert.doesNotMatch(error.message, /<!DOCTYPE html>/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project diagram image option normalizers reject unsupported values", () => {
  assert.equal(normalizeProjectDiagramImageLayout("dependency"), "dependency");
  assert.equal(normalizeProjectDiagramImageFormat("jpg"), "jpeg");
  assert.equal(normalizeProjectDiagramImageLabels(undefined), "all");

  assert.throws(() => normalizeProjectDiagramImageLayout("network"), /layout/);
  assert.throws(() => normalizeProjectDiagramImageFormat("pdf"), /format/);
  assert.throws(() => normalizeProjectDiagramImageLabels("hidden"), /labels/);
});

test("resolveProjectDiagramImageFrontendUrl defaults to public frontend unless explicit", () => {
  assert.equal(resolveProjectDiagramImageFrontendUrl(), "https://cloudeval.ai");
  assert.equal(
    resolveProjectDiagramImageFrontendUrl({
      frontendUrl: "http://localhost:3011/",
    }),
    "http://localhost:3011",
  );
  assert.equal(
    resolveProjectDiagramImageFrontendUrl({
      env: { CLOUDEVAL_FRONTEND_URL: "https://preview.example.test/" } as any,
    }),
    "https://preview.example.test",
  );
});
