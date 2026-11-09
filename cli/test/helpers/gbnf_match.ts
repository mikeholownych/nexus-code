/** A small recognizer for the GBNF subset Nexus emits: literals, classes, groups, alternation, ? * + {n}, rule references. */
type Node =
  | { t: "lit"; v: string }
  | { t: "cls"; neg: boolean; items: Array<[number, number]> }
  | { t: "ref"; n: string }
  | { t: "seq"; xs: Node[] }
  | { t: "alt"; xs: Node[] }
  | { t: "rep"; x: Node; min: number; max: number };

function unescape(src: string, i: number): [number, number] {
  const c = src[i + 1];
  if (c === "x") return [parseInt(src.slice(i + 2, i + 4), 16), i + 4];
  const map: Record<string, number> = { n: 10, t: 9, r: 13, "\\": 92, '"': 34, "]": 93, "[": 91, "^": 94, "-": 45, "/": 47, b: 8, f: 12 };
  return [map[c] ?? c.charCodeAt(0), i + 2];
}

function parseRhs(src: string): Node {
  let i = 0;
  const ws = () => { while (/\s/.test(src[i] ?? "")) i++; };
  const alt = (): Node => {
    const xs: Node[] = [seq()];
    ws();
    while (src[i] === "|") { i++; xs.push(seq()); ws(); }
    return xs.length === 1 ? xs[0] : { t: "alt", xs };
  };
  const seq = (): Node => {
    const xs: Node[] = [];
    for (;;) {
      ws();
      if (i >= src.length || src[i] === "|" || src[i] === ")") break;
      xs.push(postfix());
    }
    return { t: "seq", xs };
  };
  const postfix = (): Node => {
    let x = atom();
    for (;;) {
      const c = src[i];
      if (c === "?") { i++; x = { t: "rep", x, min: 0, max: 1 }; }
      else if (c === "*") { i++; x = { t: "rep", x, min: 0, max: Infinity }; }
      else if (c === "+") { i++; x = { t: "rep", x, min: 1, max: Infinity }; }
      else if (c === "{") {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(i))!;
        i += m[0].length;
        x = { t: "rep", x, min: +m[1], max: m[2] === undefined ? +m[1] : m[2] === "" ? Infinity : +m[2] };
      } else return x;
    }
  };
  const atom = (): Node => {
    const c = src[i];
    if (c === "(") { i++; const n = alt(); ws(); i++; return n; }
    if (c === '"') {
      i++;
      let v = "";
      while (src[i] !== '"') {
        if (src[i] === "\\") { const [cp, j] = unescape(src, i); v += String.fromCharCode(cp); i = j; } else v += src[i++];
      }
      i++;
      return { t: "lit", v };
    }
    if (c === "[") {
      i++;
      const neg = src[i] === "^";
      if (neg) i++;
      const items: Array<[number, number]> = [];
      while (src[i] !== "]") {
        let lo: number;
        if (src[i] === "\\") { const [cp, j] = unescape(src, i); lo = cp; i = j; } else lo = src.charCodeAt(i++);
        let hi = lo;
        if (src[i] === "-" && src[i + 1] !== "]") {
          i++;
          if (src[i] === "\\") { const [cp, j] = unescape(src, i); hi = cp; i = j; } else hi = src.charCodeAt(i++);
        }
        items.push([lo, hi]);
      }
      i++;
      return { t: "cls", neg, items };
    }
    const m = /^[A-Za-z][\w-]*/.exec(src.slice(i));
    if (!m) throw new Error(`cannot parse GBNF at: ${src.slice(i, i + 20)}`);
    i += m[0].length;
    return { t: "ref", n: m[0] };
  };
  const out = alt();
  ws();
  return out;
}

/** True when `input` is a complete sentence of `grammar` (root rule `root`). */
export function gbnfAccepts(grammar: string, input: string): boolean {
  const rules = new Map<string, Node>();
  for (const line of grammar.split("\n")) {
    const at = line.indexOf(" ::= ");
    if (at > 0) rules.set(line.slice(0, at), parseRhs(line.slice(at + 5)));
  }
  const memo = new Map<string, Set<number>>();
  const ends = (node: Node, pos: number): Set<number> => {
    switch (node.t) {
      case "lit": return input.startsWith(node.v, pos) ? new Set([pos + node.v.length]) : new Set();
      case "cls": {
        if (pos >= input.length) return new Set();
        const cp = input.charCodeAt(pos);
        const inside = node.items.some(([lo, hi]) => cp >= lo && cp <= hi);
        return inside !== node.neg ? new Set([pos + 1]) : new Set();
      }
      case "ref": {
        const key = `${node.n}@${pos}`;
        const hit = memo.get(key);
        if (hit) return hit;
        memo.set(key, new Set()); // a nullable cycle yields nothing new
        const r = ends(rules.get(node.n)!, pos);
        memo.set(key, r);
        return r;
      }
      case "seq": {
        let cur = new Set([pos]);
        for (const x of node.xs) {
          const next = new Set<number>();
          for (const p of cur) for (const e of ends(x, p)) next.add(e);
          cur = next;
          if (cur.size === 0) break;
        }
        return cur;
      }
      case "alt": { const out = new Set<number>(); for (const x of node.xs) for (const e of ends(x, pos)) out.add(e); return out; }
      case "rep": {
        let frontier = new Set([pos]);
        const all = new Set<number>(node.min === 0 ? [pos] : []);
        for (let count = 1; count <= node.max && frontier.size; count++) {
          const next = new Set<number>();
          for (const p of frontier) for (const e of ends(node.x, p)) if (e !== p || count <= node.min) next.add(e);
          if (count >= node.min) for (const e of next) all.add(e);
          frontier = count >= node.min ? new Set([...next].filter((e) => !all.has(e) || true)) : next;
          if (count > input.length + node.min + 1) break;
        }
        return all;
      }
    }
  };
  return ends({ t: "ref", n: "root" }, 0).has(input.length);
}
