// shows.js / planner.js / storage.js / ui.js を index.html に埋め込んで、自己完結の1枚を吐く。
//
//   dist/index.html  ローカルのブラウザで確認する用
//   docs/index.html  配る用（GitHub Pages など）。中身は同じ
//
// 外部への通信はしない。<script src> を残さないので、ファイルを開くだけで動く。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toPlainScript, bundle } from "./tools/inline.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(root, name), "utf8");

const SOURCES = ["shows.js", "planner.js", "storage.js", "ui.js"];
const code = bundle(SOURCES.map((name) => ({ name, code: toPlainScript(read(name)) })));

const html = read("index.html");
const out = html.replace(/<script type="module" src="ui\.js"><\/script>/, () => `<script>\n${code}\n</script>`);
if (out === html) throw new Error('index.html の <script type="module" src="ui.js"> が見つかりません');

for (const dir of ["dist", "docs"]) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "index.html"), out);
}
console.log(`index.html ${(Buffer.byteLength(out) / 1024).toFixed(1)}KB → dist/ と docs/`);
