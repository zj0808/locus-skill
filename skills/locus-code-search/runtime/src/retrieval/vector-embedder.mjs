/**
 * Static-embedding encoder (model2vec / potion family) for the local vector
 * radar. Inference is: WordPiece tokenize → look up per-token embedding rows →
 * mean-pool → L2 normalize. No transformer pass, no native deps — a query
 * embeds in well under a millisecond of CPU.
 *
 * Model files (tokenizer.json / config.json / model.safetensors) are loaded
 * from LOCUS_VECTOR_MODEL_DIR, a project-local .locus-mcp/vector-model/, or
 * the package-local .model-cache/. Absent model → load() returns null and the
 * vector radar silently disables itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MODEL_SUBDIR = "potion-code-16M-v2";

function f16ToF32(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function isCjkChar(code) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

function isPunctChar(char) {
  const code = char.codePointAt(0);
  if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) return true;
  return /[\p{P}\p{S}]/u.test(char);
}

/** BertNormalizer(lowercase, CJK 逐字加空格) + BertPreTokenizer(空白/标点切分)。 */
function bertPreTokenize(text) {
  const padded = [];
  for (const char of String(text).toLowerCase()) {
    const code = char.codePointAt(0);
    if (code === 0 || code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) continue;
    if (isCjkChar(code)) {
      padded.push(" ", char, " ");
    } else {
      padded.push(char);
    }
  }
  const words = [];
  for (const raw of padded.join("").split(/\s+/)) {
    if (!raw) continue;
    let current = "";
    for (const char of raw) {
      if (isPunctChar(char)) {
        if (current) { words.push(current); current = ""; }
        words.push(char);
      } else {
        current += char;
      }
    }
    if (current) words.push(current);
  }
  return words;
}

function parseSafetensors(buffer) {
  const headerLen = Number(buffer.readBigUInt64LE(0));
  const header = JSON.parse(buffer.subarray(8, 8 + headerLen).toString("utf8"));
  const dataStart = 8 + headerLen;
  const tensors = {};
  for (const [name, info] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    tensors[name] = {
      dtype: info.dtype,
      shape: info.shape,
      start: dataStart + info.data_offsets[0],
      end: dataStart + info.data_offsets[1],
    };
  }
  return tensors;
}

export class StaticEmbedder {
  constructor({ vocab, unkId, matrixF16, vocabSize, dim, normalize }) {
    this._vocab = vocab;
    this._unkId = unkId;
    this._matrix = matrixF16; // Uint16Array — 按需转 F32，内存减半
    this.vocabSize = vocabSize;
    this.dim = dim;
    this._normalize = normalize;
  }

  /** @returns {StaticEmbedder|null} */
  static load(modelDir) {
    try {
      const tokenizerPath = join(modelDir, "tokenizer.json");
      const modelPath = join(modelDir, "model.safetensors");
      if (!existsSync(tokenizerPath) || !existsSync(modelPath)) return null;

      const tokenizer = JSON.parse(readFileSync(tokenizerPath, "utf8"));
      if (tokenizer.model?.type !== "WordPiece") return null;
      const vocab = new Map(Object.entries(tokenizer.model.vocab));
      const unkId = vocab.get(tokenizer.model.unk_token || "[UNK]") ?? 0;

      let normalize = true;
      try {
        const config = JSON.parse(readFileSync(join(modelDir, "config.json"), "utf8"));
        if (config.normalize === false) normalize = false;
      } catch { /* default */ }

      const raw = readFileSync(modelPath);
      const tensors = parseSafetensors(raw);
      const tensor = tensors.embeddings || Object.values(tensors)[0];
      if (!tensor || tensor.dtype !== "F16" || tensor.shape.length !== 2) return null;
      const [vocabSize, dim] = tensor.shape;
      const bytes = raw.subarray(tensor.start, tensor.end);
      let matrixF16;
      if (bytes.byteOffset % 2 === 0) {
        matrixF16 = new Uint16Array(bytes.buffer, bytes.byteOffset, vocabSize * dim);
      } else {
        // 未对齐（header 长度为奇数）：复制到对齐缓冲
        const aligned = Buffer.alloc(bytes.length);
        bytes.copy(aligned);
        matrixF16 = new Uint16Array(aligned.buffer, 0, vocabSize * dim);
      }

      return new StaticEmbedder({ vocab, unkId, matrixF16, vocabSize, dim, normalize });
    } catch {
      return null;
    }
  }

  /** WordPiece 贪心最长匹配。 */
  tokenize(text) {
    const ids = [];
    for (const word of bertPreTokenize(text)) {
      if (word.length > 100) { ids.push(this._unkId); continue; }
      let start = 0;
      const wordIds = [];
      let bad = false;
      while (start < word.length) {
        let end = word.length;
        let id = null;
        while (end > start) {
          const piece = (start > 0 ? "##" : "") + word.slice(start, end);
          const found = this._vocab.get(piece);
          if (found !== undefined) { id = found; break; }
          end -= 1;
        }
        if (id === null) { bad = true; break; }
        wordIds.push(id);
        start = end;
      }
      if (bad) ids.push(this._unkId);
      else ids.push(...wordIds);
    }
    return ids;
  }

  /** @returns {Float32Array|null} mean-pooled (optionally L2-normalized) */
  embed(text) {
    const ids = this.tokenize(text);
    if (!ids.length) return null;
    const dim = this.dim;
    const out = new Float32Array(dim);
    for (const id of ids) {
      const base = id * dim;
      for (let i = 0; i < dim; i++) out[i] += f16ToF32(this._matrix[base + i]);
    }
    for (let i = 0; i < dim; i++) out[i] /= ids.length;
    if (this._normalize) {
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += out[i] * out[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) out[i] /= norm;
    }
    return out;
  }
}

let _embedderPromiseCache = new Map(); // modelDir -> StaticEmbedder|null

/** 解析模型目录：env → 项目内 → 包内缓存；找不到返回 null（雷达静默停用）。 */
export function resolveModelDir(projectRoot, packageRoot) {
  const candidates = [
    process.env.LOCUS_VECTOR_MODEL_DIR,
    projectRoot ? join(projectRoot, ".locus-mcp", "vector-model") : null,
    packageRoot ? join(packageRoot, ".model-cache", DEFAULT_MODEL_SUBDIR) : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "model.safetensors"))) return dir;
  }
  return null;
}

export function loadEmbedderCached(modelDir) {
  if (!modelDir) return null;
  if (_embedderPromiseCache.has(modelDir)) return _embedderPromiseCache.get(modelDir);
  const embedder = StaticEmbedder.load(modelDir);
  _embedderPromiseCache.set(modelDir, embedder);
  return embedder;
}
