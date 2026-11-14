// Minimal TEI (as produced by Diogenes' xml-export.pl) -> markdown / plain text.

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : undefined;
}

function headerField(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decode(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
}

export function teiToText(xml: string, format: "markdown" | "text"): string {
  const md = format === "markdown";
  const title = headerField(xml, "title");
  const author = headerField(xml, "author");
  const source = headerField(xml, "sourceDesc");
  const bodyStart = xml.indexOf("<body");
  const bodyEnd = xml.lastIndexOf("</body>");
  const body = xml.slice(bodyStart, bodyEnd < 0 ? undefined : bodyEnd);

  const out: string[] = [];
  out.push(md ? `# ${author}, ${title}` : `${author}, ${title}`, "");
  if (source) out.push(md ? `*${source}*` : source, "");

  const stack: { type: string; n: string }[] = [];
  let line = "";
  const flush = () => {
    const t = line.replace(/[ \t]+/g, " ").trim();
    if (t) out.push(t);
    line = "";
  };
  const blank = () => {
    flush();
    if (out[out.length - 1] !== "") out.push("");
  };

  const re = /<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[5] !== undefined) {
      line += decode(m[5]).replace(/\s*\n\s*/g, " ");
      continue;
    }
    const [, close, tag, attrs, selfClose] = m;
    if (tag === "div") {
      if (close) {
        stack.pop();
        blank();
      } else {
        blank();
        stack.push({ type: attr(attrs, "type") ?? "", n: attr(attrs, "n") ?? "" });
        const cite = stack.map((d) => d.n).filter(Boolean).join(".");
        const top = stack.length === 1;
        const d = stack[stack.length - 1];
        if (top) {
          const label = `${d.type} ${d.n}`.trim();
          if (label) out.push(md ? `## ${label}` : label, "");
        } else if (cite) {
          out.push(md ? `**${cite}**` : `[${cite}]`);
        }
      }
    } else if (tag === "l" || tag === "p" || tag === "head" || tag === "lb") {
      if (close || selfClose) {
        if (tag === "p") blank();
        else flush();
      } else {
        flush();
        if (tag === "head" && md) line += "";
      }
    }
    // every other tag is dropped, its text kept
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
