import { parse, type DefaultTreeAdapterMap } from "parse5";

const MAX_CHARACTERS = 8_000;
const omittedTags = new Set(["head", "script", "style", "template", "blockquote"]);
const blockTags = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "hr"]);

/** Extract visible text only; never render HTML or load its links or attachments. */
export function extractEmailReply(text: string, html: string): string {
  let source = text;
  if (!source.trim() && html) {
    const parts: string[] = [];
    let stopped = false;
    function visit(node: DefaultTreeAdapterMap["node"]) {
      if (stopped) return;
      if ("tagName" in node) {
        const classes = node.attrs.find((attribute) => attribute.name === "class")?.value ?? "";
        const id = node.attrs.find((attribute) => attribute.name === "id")?.value ?? "";
        if (/^(?:divRplyFwdMsg|lineBreakAtBeginningOfSignature)$/i.test(id)) {
          stopped = true;
          return;
        }
        if (omittedTags.has(node.tagName) || /\b(?:gmail_quote|gmail_signature|yahoo_quoted|moz-cite-prefix)\b/.test(classes) ||
            node.attrs.some((attribute) => attribute.name === "hidden" || (attribute.name === "aria-hidden" && attribute.value === "true"))) return;
        if (blockTags.has(node.tagName)) parts.push("\n");
      }
      if ("value" in node) parts.push(node.value);
      if ("childNodes" in node) for (const child of node.childNodes) visit(child);
      if ("tagName" in node && blockTags.has(node.tagName)) parts.push("\n");
    }
    visit(parse(html.slice(0, 1_048_576)));
    source = parts.join("");
  }

  const lines: string[] = [];
  for (const line of source.replaceAll("\u0000", "").replaceAll("\u00a0", " ").split(/\r?\n/)) {
    if (/^\s*(?:On .+wrote:|Le .+écrit\s*:|From:\s|Begin forwarded message:|Sent from my (?:iPhone|iPad)|--\s*$)/iu.test(line)) break;
    if (!/^\s*>/.test(line)) lines.push(line.trimEnd());
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_CHARACTERS);
}
