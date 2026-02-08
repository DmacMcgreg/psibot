import { Hono } from "hono";
import { MemorySystem } from "../../memory/index.ts";
import {
  memoryPage,
  memoryEditFragment,
  memorySearchResults,
} from "../views/memory.ts";

interface MemoryEnv {
  Variables: {
    memory: MemorySystem;
  };
}

export function createMemoryRoutes() {
  const app = new Hono<MemoryEnv>();

  app.get("/memory", (c) => {
    const mem = c.get("memory");
    const files = mem.listKnowledgeFiles();
    const file = c.req.query("file");
    let content: string | undefined;
    if (file) {
      try {
        content = mem.readKnowledgeFile(file);
      } catch {
        content = "Error: file not found";
      }
    }
    return c.html(memoryPage(files, file, content));
  });

  app.get("/memory/edit", (c) => {
    const mem = c.get("memory");
    const file = c.req.query("file");
    if (!file) return c.text("Missing file param", 400);
    try {
      const content = mem.readKnowledgeFile(file);
      return c.html(memoryEditFragment(file, content));
    } catch {
      return c.text("File not found", 404);
    }
  });

  app.post("/api/memory/save", async (c) => {
    const mem = c.get("memory");
    const body = await c.req.parseBody();
    const file = String(body.file);
    const content = String(body.content);
    mem.writeKnowledgeFile(file, content);
    return c.html(
      `<div class="prose prose-invert prose-sm p-4">${content.replace(/</g, "&lt;")}</div>`
    );
  });

  app.get("/api/memory/search", (c) => {
    const mem = c.get("memory");
    const q = c.req.query("q") ?? "";
    if (q.length < 2) return c.html("");
    const results = mem.search(q);
    return c.html(memorySearchResults(results));
  });

  return app;
}
