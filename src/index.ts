#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teiToText } from "./tei.js";

const SERVER_DIR =
  process.env.DIOGENES_SERVER_DIR ?? "/Applications/Diogenes.app/Contents/server";
const PERL = process.env.DIOGENES_PERL ?? "perl";
const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "perl", "dio.pl");
const SETTINGS_DIR =
  process.env.DIOGENES_SETTINGS_DIR ??
  path.join(os.homedir(), "Library", "Application Support", "Diogenes");
const OPEN_CMD = process.env.DIOGENES_OPEN_CMD; // overrides everything, e.g. "open -a Safari"
const CMUX = process.env.DIOGENES_CMUX ?? "/Applications/cmux.app/Contents/Resources/bin/cmux";

type Json = Record<string, any>;

function run(cmd: string, args: string[], input?: string, timeoutMs = 600_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.end(input ?? "");
  });
}

async function dio(req: Json): Promise<Json> {
  const r = await run(PERL, [SHIM], JSON.stringify(req));
  let res: Json;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw new Error(`Diogenes backend failed: ${r.stderr.trim().slice(-800) || "no output"}`);
  }
  if (res.error) throw new Error(String(res.error).trim());
  return res;
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }],
});

// ---- shared schemas

const scopeShape = {
  corpus: z
    .string()
    .optional()
    .describe("Name of a saved Diogenes corpus (see list_corpora). Takes precedence over authors/works."),
  authors: z
    .array(z.string())
    .optional()
    .describe('TLG author numbers to search all works of, e.g. ["0557"]. Find numbers with list_authors.'),
  works: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe('Specific works per author: {"0557": ["002"]} = Epictetus, Enchiridion. Find numbers with list_works.'),
};

function scopeArgs(a: { corpus?: string; authors?: string[]; works?: Record<string, string[]> }): Json {
  if (a.corpus) return { corpus: a.corpus };
  if (a.works && Object.keys(a.works).length) {
    const m: Json = { ...a.works };
    for (const au of a.authors ?? []) if (!(au in m)) m[au] = "all";
    return { authors: m };
  }
  if (a.authors?.length) return { authors: a.authors };
  return {};
}

const pageShape = {
  limit: z.number().int().min(0).max(200).optional().describe("Max passages to return (default 20)."),
  offset: z.number().int().min(0).optional().describe("Skip this many passages (for paging)."),
  count_only: z.boolean().optional().describe("Return only counts, no passage text."),
  context: z
    .string()
    .optional()
    .describe('Context per hit: "sentence" (default), "clause", "phrase", "paragraph", or a number of lines.'),
};

// Trim the repeated bibliography out of each hit; keep it once per work.
function tidy(res: Json): Json {
  const titles: Json = {};
  const byWork: Json = {};
  for (const [k, v] of Object.entries<Json>(res.by_work ?? {})) {
    byWork[k] = { passages: v.passages, matches: v.matches };
    titles[k] = v.title;
  }
  for (const h of res.hits ?? []) {
    const k = `${h.author}:${h.work}`;
    if (!titles[k] || h.title.length > titles[k].length) titles[k] = h.title;
  }
  const hits = (res.hits ?? []).map((h: Json) => ({
    ref: h.jump,
    citation: h.citation,
    text: h.text,
  }));
  const { by_work, hits: _h, forms_beta, ...rest } = res;
  return {
    ...rest,
    by_work: Object.fromEntries(
      Object.entries(byWork).map(([k, v]) => [k, { title: titles[k], ...(v as Json) }]),
    ),
    hits,
  };
}

// ---- server

const server = new McpServer({ name: "diogenes", version: "0.1.0" });

server.registerTool(
  "list_authors",
  {
    description:
      "Find TLG authors by name (regex, Latin-alphabet TLG names such as 'Epictet', 'Aristot', 'Plato'). Returns author numbers used by every other tool.",
    inputSchema: { pattern: z.string().describe("Name fragment or regex; empty string lists every author.") },
  },
  async ({ pattern }) => ok(await dio({ op: "authors", pattern })),
);

server.registerTool(
  "list_works",
  {
    description:
      "List the works of a TLG author with their work numbers and citation levels (e.g. Book/chapter/section/line).",
    inputSchema: { author: z.string().describe('TLG author number, e.g. "0557".') },
  },
  async ({ author }) => ok(await dio({ op: "works", author })),
);

server.registerTool(
  "search",
  {
    description:
      "Brute-force text search of the TLG for one or more patterns (substring match; put spaces around a pattern to match whole words). " +
      "Greek in Unicode: give all accents for strict matching or none for accent-insensitive matching. Simple regex (alternation, character classes, ? + *) is allowed. " +
      "With several patterns, hits are passages where min_matches of them co-occur within the context. " +
      "To find every inflected form of a word use morph_search instead. Unscoped searches cover the whole TLG and can take a while.",
    inputSchema: {
      patterns: z.array(z.string()).min(1).describe("One or more search patterns."),
      min_matches: z
        .union([z.number().int().min(1), z.literal("any"), z.literal("all")])
        .optional()
        .describe('With several patterns: how many must occur together ("all" by default).'),
      reject: z.string().optional().describe("Discard hits whose context contains this pattern."),
      ...scopeShape,
      ...pageShape,
    },
  },
  async (a) => {
    const res = await dio({
      op: "search",
      patterns: a.patterns,
      min_matches: a.min_matches,
      reject: a.reject,
      context: a.context,
      limit: a.limit,
      offset: a.offset,
      count_only: a.count_only,
      ...scopeArgs(a),
    });
    return ok(tidy(res));
  },
);

server.registerTool(
  "morph_search",
  {
    description:
      "Morphological (lemma) search: finds every inflected form of a Greek word via Diogenes' Perseus morphology data and the TLG word index, then returns the passages. " +
      "Use this for questions like 'how often does X use the word Y in any form'. Give the dictionary form with accents (e.g. ἄσκησις); an inflected form also works. " +
      "The result lists which forms were found and their counts. Note some forms are shared with other lemmata (e.g. ἀσκήσει is also a verb form), so inspect forms_found and the passages before reporting a count. " +
      "If several lemmata match, the tool returns them and you choose with lemma_beta.",
    inputSchema: {
      lemma: z.string().describe("Greek word, Unicode with accents."),
      lemma_beta: z.string().optional().describe("Pick one lemma (beta code key from a previous ambiguous result or lookup_lemmata)."),
      all_lemmata: z.boolean().optional().describe("If several lemmata match, search all of them."),
      form_filter: z
        .string()
        .optional()
        .describe('Only forms whose morphological analysis contains this text, e.g. "aor opt", "gen pl".'),
      forms: z.array(z.string()).optional().describe("Search exactly these forms instead of deriving them from the lemma."),
      ...scopeShape,
      ...pageShape,
    },
  },
  async (a) => {
    const res = await dio({
      op: "morph",
      lemma: a.lemma,
      lemma_beta: a.lemma_beta,
      all_lemmata: a.all_lemmata,
      form_filter: a.form_filter,
      forms: a.forms,
      context: a.context,
      limit: a.limit,
      offset: a.offset,
      count_only: a.count_only,
      ...scopeArgs(a),
    });
    return ok(res.ambiguous ? res : tidy(res));
  },
);

server.registerTool(
  "word_list",
  {
    description:
      "Look up the TLG word index: every indexed word form containing the pattern (unaccented Greek, or Unicode), with its frequency in the whole TLG or in the given scope. Fast; good for frequency questions and for discovering forms.",
    inputSchema: {
      pattern: z.string().describe('Word or fragment, e.g. "ασκησ". A leading space anchors the start of the word.'),
      limit: z.number().int().min(1).max(2000).optional().describe("Max forms to list (default 200)."),
      ...scopeShape,
    },
  },
  async (a) => ok(await dio({ op: "word_list", pattern: a.pattern, limit: a.limit, ...scopeArgs(a) })),
);

server.registerTool(
  "lookup_lemmata",
  {
    description:
      "Find the dictionary headword(s) for a Greek word and list all their inflected forms with morphological analyses (Perseus data bundled with Diogenes).",
    inputSchema: { word: z.string().describe("Greek word, Unicode; accents recommended.") },
  },
  async ({ word }) => ok(await dio({ op: "lemmata", word })),
);

server.registerTool(
  "parse_word",
  {
    description: "Morphologically parse an inflected Greek form: possible lemmata, short gloss and analyses. Needs the accented form.",
    inputSchema: { word: z.string().describe("Inflected Greek form with accents, e.g. ἀσκήσεως.") },
  },
  async ({ word }) => ok(await dio({ op: "parse", word })),
);

server.registerTool(
  "define",
  {
    description: "LSJ (Liddell-Scott-Jones) dictionary entry for a Greek word (headword or inflected form).",
    inputSchema: {
      word: z.string().describe("Greek word, Unicode."),
      max_chars: z.number().int().min(200).optional().describe("Truncate each entry to this many characters (default 6000)."),
    },
  },
  async ({ word, max_chars }) => ok(await dio({ op: "define", word, max_chars })),
);

server.registerTool(
  "read_passage",
  {
    description:
      "Read TLG text starting at a citation. location follows the work's levels from list_works, highest first (e.g. Enchiridion levels Chapter/section/line: [\"47\"] or [\"47\",\"1\",\"3\"]). " +
      "Omit location to start at the beginning. Search hits carry a ref like 'tlg,0557,002:47:1:3' = author, work, then location. For a whole work use export_work.",
    inputSchema: {
      author: z.string().describe("TLG author number."),
      work: z.string().describe("Work number."),
      location: z.array(z.string()).optional().describe("Citation, highest level first."),
      lines: z.number().int().min(1).max(600).optional().describe("Approximate number of lines to return (default 40)."),
    },
  },
  async (a) => {
    const res = await dio({ op: "read", ...a });
    return ok(`[levels: ${res.levels.join(" / ")}]\n${res.text}`);
  },
);

server.registerTool(
  "list_corpora",
  {
    description:
      "List the user's saved Diogenes corpora (custom subsets of authors/works, shared with the Diogenes app). Use a corpus name as the scope of search, morph_search or word_list.",
    inputSchema: {},
  },
  async () => ok(await dio({ op: "corpora" })),
);

server.registerTool(
  "save_corpus",
  {
    description:
      "Create (or with overwrite, replace) a saved Diogenes corpus. It is written to Diogenes' own corpora file, so it also appears in the app. " +
      'Give authors as a list of author numbers, and/or works as {"author": ["work", ...]}.',
    inputSchema: {
      name: z.string().min(1),
      authors: z.array(z.string()).optional().describe("Authors included in full."),
      works: z.record(z.string(), z.array(z.string())).optional().describe("Specific works per author."),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    const s = scopeArgs({ authors: a.authors, works: a.works });
    if (!s.authors) throw new Error("give authors and/or works");
    return ok(await dio({ op: "save_corpus", name: a.name, authors: s.authors, overwrite: a.overwrite }));
  },
);

server.registerTool(
  "delete_corpus",
  {
    description: "Delete a saved Diogenes corpus by name. Only do this when the user asks.",
    inputSchema: { name: z.string().min(1) },
  },
  async ({ name }) => ok(await dio({ op: "delete_corpus", name })),
);

server.registerTool(
  "export_work",
  {
    description:
      "Export whole works of a TLG author to files, using Diogenes' TEI XML exporter. format: xml (TEI P5), markdown, or text. " +
      "Omit works to export every work of the author. Returns the paths written.",
    inputSchema: {
      author: z.string().describe("TLG author number."),
      works: z.array(z.string()).optional().describe("Work numbers; default all."),
      format: z.enum(["xml", "markdown", "text"]),
      out_dir: z.string().describe("Absolute directory to write into (created if missing)."),
    },
  },
  async ({ author, works, format, out_dir }) => {
    const auth = author.padStart(4, "0");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "diogenes-export-"));
    try {
      const r = await run(
        PERL,
        [path.join(SERVER_DIR, "xml-export.pl"), "-c", "tlg", "-n", auth, "-o", tmp],
        undefined,
        1_800_000,
      );
      const dir = path.join(tmp, "Diogenes-Resources", "xml", "tlg");
      const want = works?.map((w) => w.padStart(3, "0"));
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir)).filter((f: string) => new RegExp(`^tlg${auth}\\d+\\.xml$`).test(f)).sort();
      } catch {
        /* handled below */
      }
      if (want) files = files.filter((f) => want.includes(f.slice(7, 10)));
      if (!files.length) {
        throw new Error(`nothing exported for author ${auth}: ${r.stderr.trim().slice(-500) || r.stdout.trim().slice(-500)}`);
      }
      await fs.mkdir(out_dir, { recursive: true });
      const written: string[] = [];
      for (const f of files) {
        const xml = await fs.readFile(path.join(dir, f), "utf8");
        const ext = format === "xml" ? "xml" : format === "markdown" ? "md" : "txt";
        const dest = path.join(out_dir, f.replace(/\.xml$/, `.${ext}`));
        await fs.writeFile(dest, format === "xml" ? xml : teiToText(xml, format), "utf8");
        written.push(dest);
      }
      return ok({ written });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);

// ---- opening screens of the running app in a browser

async function appPort(): Promise<number> {
  const lock = path.join(SETTINGS_DIR, "diogenes-lock.json");
  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(lock, "utf8")).port as number | undefined;
    } catch {
      return undefined;
    }
  };
  let port = await read();
  if (!port) {
    await run("open", ["-ga", "Diogenes"]);
    for (let i = 0; i < 40 && !port; i++) {
      await new Promise((r) => setTimeout(r, 500));
      port = await read();
    }
  }
  if (!port) throw new Error("Diogenes is not running and could not be started; open the Diogenes app and retry.");
  return port;
}

// Open a URL: custom command, else a reusable cmux browser pane, else the default browser.
let cmuxSurface: string | undefined;
async function openUrl(url: string): Promise<string> {
  if (OPEN_CMD) {
    const [cmd, ...args] = OPEN_CMD.split(" ");
    const r = await run(cmd, [...args, url], undefined, 15_000);
    if (r.code !== 0) throw new Error(`could not open URL (${r.stderr.trim()}): ${url}`);
    return OPEN_CMD;
  }
  try {
    if (cmuxSurface) {
      const r = await run(CMUX, ["browser", "--surface", cmuxSurface, "goto", url], undefined, 15_000);
      if (r.code === 0 && /^OK/.test(r.stdout)) return `cmux ${cmuxSurface}`;
      cmuxSurface = undefined;
    }
    const r = await run(CMUX, ["browser", "open-split", url, "--focus", "false"], undefined, 15_000);
    const m = /surface=(surface:\d+)/.exec(r.stdout);
    if (r.code === 0 && m) {
      cmuxSurface = m[1];
      return `cmux ${cmuxSurface}`;
    }
  } catch {
    /* cmux not installed */
  }
  const r = await run("open", [url], undefined, 15_000);
  if (r.code !== 0) throw new Error(`could not open URL (${r.stderr.trim()}): ${url}`);
  return "default browser";
}

server.registerTool(
  "open_in_diogenes",
  {
    description:
      "Build a URL for a screen of the user's running Diogenes app (served on localhost) and open it (in a cmux browser pane when cmux is running, otherwise the default browser): a passage in context, the results of a text search, or the results of a morphological search. " +
      "Searches can be scoped only to the whole TLG or a saved corpus (use save_corpus first for an ad-hoc scope). Set open=false to just get the URL (e.g. to load it in a specific browser pane).",
    inputSchema: {
      kind: z.enum(["passage", "search", "morph_search"]),
      ref: z.string().optional().describe("passage: a hit ref such as 'tlg,0557,002:47:1:3'."),
      author: z.string().optional().describe("passage: author number (alternative to ref)."),
      work: z.string().optional().describe("passage: work number."),
      location: z.array(z.string()).optional().describe("passage: citation, highest level first."),
      query: z.string().optional().describe("search: the pattern. morph_search: the lemma."),
      lemma_beta: z.string().optional().describe("morph_search: pick one lemma if ambiguous."),
      corpus: z.string().optional().describe("search/morph_search: saved corpus name; default whole TLG."),
      open: z.boolean().optional().describe("Open the URL in the browser (default true)."),
    },
  },
  async (a) => {
    const port = await appPort();
    const base = `http://localhost:${port}/Diogenes.cgi?`;
    let corpusIdx: number | undefined;
    if (a.corpus && a.kind !== "passage") {
      const { corpora } = await dio({ op: "corpora" });
      corpusIdx = (corpora as Json[]).findIndex((c) => c.name.toLowerCase() === a.corpus!.toLowerCase());
      if (corpusIdx < 0) throw new Error(`no saved corpus named '${a.corpus}'`);
    }
    let url: string;
    if (a.kind === "passage") {
      let ref = a.ref;
      if (!ref) {
        if (!a.author || !a.work) throw new Error("passage needs ref, or author and work");
        ref = `tlg,${a.author.padStart(4, "0")},${a.work.padStart(3, "0")}`;
        if (a.location?.length) ref += ":" + a.location.join(":");
      }
      url = base + new URLSearchParams({ JumpTo: ref }).toString();
    } else if (a.kind === "search") {
      if (!a.query) throw new Error("search needs query");
      url =
        base +
        new URLSearchParams({
          current_page: "splash",
          action: "search",
          corpus: corpusIdx === undefined ? "TLG Texts" : String(corpusIdx),
          query: a.query,
        }).toString();
    } else {
      if (!a.query) throw new Error("morph_search needs query (the lemma)");
      const res = await dio({
        op: "morph",
        lemma: a.query,
        lemma_beta: a.lemma_beta,
        forms_only: true,
        ...(a.corpus ? { corpus: a.corpus } : {}),
      });
      if (res.ambiguous) return ok(res);
      const forms: string[] = res.forms_beta ?? [];
      if (!forms.length) throw new Error("no forms of that lemma occur in the chosen scope");
      const p = new URLSearchParams({ current_page: "inflections", short_type: "tlg", type: "TLG Texts" });
      if (corpusIdx !== undefined) p.set("custom_corpus", String(corpusIdx));
      for (const f of forms) p.append("lemma_list", f);
      url = base + p.toString();
    }
    const doOpen = a.open !== false;
    let via: string | undefined;
    if (doOpen) via = await openUrl(url);
    return ok({ url, opened: doOpen, ...(via ? { via } : {}) });
  },
);

await server.connect(new StdioServerTransport());
