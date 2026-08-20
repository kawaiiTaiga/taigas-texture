import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BENCH_PATH = path.join(ROOT, 'grain-bench.html');
const MATERIALS_PATH = path.join(ROOT, 'materials');
const MAX_SOURCE_BYTES = 200_000;
const DEFAULT_SAMPLE_RESOLUTION = 64;
const DEFAULT_RENDER_RESOLUTION = 192;
const VIEW_NAMES = ['shaded', 'albedo', 'height', 'normal', 'rough', 'metal'];

let runtimeCache;

function loadRuntime() {
  if (runtimeCache) return runtimeCache;
  const html = fs.readFileSync(BENCH_PATH, 'utf8');
  const scriptStart = html.indexOf('<script>');
  const scriptEnd = html.lastIndexOf('</script>');
  if (scriptStart < 0 || scriptEnd < 0) throw new Error('grain-bench.html에서 엔진 script를 찾지 못함');
  let source = html.slice(scriptStart + '<script>'.length, scriptEnd);
  const examplesAt = source.indexOf('const GRAIN_EXAMPLES');
  const uiAt = source.indexOf('(() => {', examplesAt);
  if (examplesAt < 0 || uiAt < 0) throw new Error('grain-bench.html 엔진 경계를 찾지 못함');
  source = source.slice(0, uiAt);
  source += '\n;globalThis.__grainRuntime = { GRAIN, GRAIN_RENDER, GRAIN_EXAMPLES };';
  const context = vm.createContext({ console });
  new vm.Script(source, { filename: BENCH_PATH }).runInContext(context);
  runtimeCache = context.__grainRuntime;
  return runtimeCache;
}

function assertSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('source는 비어 있지 않은 문자열이어야 함');
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw new RangeError(`source는 ${MAX_SOURCE_BYTES} bytes 이하여야 함`);
}

function boundedInteger(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`${label}은 ${min}..${max} 정수여야 함`);
  return n;
}

function finiteNumber(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`${label}은 ${min}..${max} 숫자여야 함`);
  return n;
}

function classifyCompilerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = message.match(/\bline\s+(\d+):/);
  let code = 'VALIDATION_ERROR';
  let suggestion = '오류가 난 줄을 단순화한 뒤 다시 validate_material을 호출하세요.';
  if (/필수 출력/.test(message)) {
    code = 'MISSING_OUTPUT'; suggestion = "최소한 'out height'와 'out albedo = hsv(h,s,v)'를 선언하세요.";
  } else if (/알 수 없는 var override/.test(message)) {
    code = 'UNKNOWN_VARIABLE_OVERRIDE'; suggestion = 'summary.variables에 나오는 이름만 values override로 전달하세요.';
  } else if (/var override/.test(message)) {
    code = 'INVALID_VARIABLE_OVERRIDE'; suggestion = 'values의 모든 값은 유한한 숫자여야 합니다.';
  } else if (/literal이어야|oct는 1\.\.|seed는 0 이상 정수|tile은 0 이상 정수/.test(message)) {
    code = 'STATIC_LITERAL_REQUIRED'; suggestion = 'oct, lac, seed, tile, enum 같은 구조 인자는 var나 field가 아닌 literal로 고정하세요.';
  } else if (/뒤에서 선언|전방 참조/.test(message)) {
    code = 'FORWARD_REFERENCE'; suggestion = '참조되는 field 또는 macro를 사용 지점보다 앞으로 옮기세요.';
  } else if (/알 수 없는 함수/.test(message)) {
    code = 'UNKNOWN_FUNCTION'; suggestion = '허용된 수학 함수·primitive·앞서 선언한 macro 이름만 사용하세요.';
  } else if (/알 수 없는 식별자/.test(message)) {
    code = 'UNKNOWN_IDENTIFIER'; suggestion = '이름 철자를 확인하고 var/field를 참조 전에 선언하세요.';
  } else if (/macro/.test(message)) {
    code = 'MACRO_CONTRACT'; suggestion = 'macro는 재귀 없이 앞선 macro만 호출하고, 본문에서는 파라미터·local·var만 참조하세요.';
  } else if (/tile>0|이음새/.test(message)) {
    code = 'TILE_PERIOD_INVALID'; suggestion = 'tile·freq를 정수로 만들고 lac을 정수로 고정하거나, 비타일 재질이면 tile = 0을 사용하세요.';
  } else if (/비용 .* > 예산/.test(message)) {
    code = 'COST_BUDGET_EXCEEDED'; suggestion = 'oct 수와 worley/spots 호출 수를 줄이거나 중복 계산을 field/macro local로 공유하세요.';
  } else if (/field 수|var 수|macro 수|확장 field/.test(message)) {
    code = 'STRUCTURE_LIMIT_EXCEEDED'; suggestion = '중복 field를 합치고 macro 확장 크기를 줄이세요.';
  } else if (/해석할 수 없는 문장|필요|문법|들여쓰기|수식/.test(message)) {
    code = 'SYNTAX_ERROR'; suggestion = '각 문장을 seed/tile/var/macro/field/out 형식 중 하나로 고치세요.';
  }
  return { severity: 'error', code, line: lineMatch ? Number(lineMatch[1]) : null, message, suggestion };
}

function classifyCompilerWarning(message) {
  const lineMatch = message.match(/\bline\s+(\d+):/);
  if (/색조\(h\)/.test(message)) return {
    severity: 'warning', code: 'ALBEDO_HUE_UNOWNED', line: lineMatch ? Number(lineMatch[1]) : null, message,
    suggestion: 'albedo의 hue를 base_h 같은 var에 연결해 재질 색조를 env에서 조절 가능하게 하세요.',
  };
  if (/미사용/.test(message)) return {
    severity: 'warning', code: 'UNUSED_VARIABLE', line: lineMatch ? Number(lineMatch[1]) : null, message,
    suggestion: '사용하지 않는 var를 제거하거나 의도한 field/output 수식에 연결하세요.',
  };
  if (/freq가 수식/.test(message)) return {
    severity: 'warning', code: 'TILE_FREQUENCY_DYNAMIC', line: null, message,
    suggestion: '기본 var 값에서 SEAM을 확인하고, var 범위 전체에서도 tile·freq가 정수가 되도록 설계하세요.',
  };
  return { severity: 'warning', code: 'COMPILER_WARNING', line: lineMatch ? Number(lineMatch[1]) : null, message, suggestion: '경고 내용을 반영한 뒤 다시 검증하세요.' };
}

function resolveValues(prog, values = {}) {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('values는 var 이름을 키로 하는 객체여야 함');
  const known = new Set(prog.vars.map(v => v.name));
  for (const name of Object.keys(values)) if (!known.has(name)) throw new Error(`알 수 없는 var override '${name}'`);
  return prog.vars.map(v => {
    const value = Object.hasOwn(values, v.name) ? Number(values[v.name]) : v.value;
    if (!Number.isFinite(value)) throw new Error(`var override '${v.name}'는 유한한 숫자여야 함`);
    return value;
  });
}

function stats(values) {
  let min = Infinity, max = -Infinity, mean = 0, m2 = 0, count = 0, nonFinite = 0, outside01 = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) { nonFinite++; continue; }
    count++;
    if (value < min) min = value;
    if (value > max) max = value;
    if (value < 0 || value > 1) outside01++;
    const delta = value - mean;
    mean += delta / count;
    m2 += delta * (value - mean);
  }
  const round = n => Number.isFinite(n) ? Number(n.toFixed(6)) : null;
  return {
    min: round(min), max: round(max), mean: round(mean), stddev: round(count ? Math.sqrt(m2 / count) : NaN),
    nonFinite, outside01, count,
  };
}

function equalTypedArrays(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function normalizeViewport({ zoom, centerU, centerV } = {}) {
  return {
    zoom: finiteNumber(zoom, 1, 1, 4096, 'zoom'),
    centerU: finiteNumber(centerU, 0.5, 0, 1, 'centerU'),
    centerV: finiteNumber(centerV, 0.5, 0, 1, 'centerV'),
  };
}

function spatialDetail(buffer, luminance) {
  const { N, H } = buffer;
  let gradH = 0, gradL = 0, gradCount = 0, hpH2 = 0, hpL2 = 0, hpCount = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    if (x + 1 < N) { gradH += Math.abs(H[k + 1] - H[k]); gradL += Math.abs(luminance[k + 1] - luminance[k]); gradCount++; }
    if (y + 1 < N) { gradH += Math.abs(H[k + N] - H[k]); gradL += Math.abs(luminance[k + N] - luminance[k]); gradCount++; }
    if (x > 0 && x + 1 < N && y > 0 && y + 1 < N) {
      const hh = H[k] - 0.25 * (H[k - 1] + H[k + 1] + H[k - N] + H[k + N]);
      const hl = luminance[k] - 0.25 * (luminance[k - 1] + luminance[k + 1] + luminance[k - N] + luminance[k + N]);
      hpH2 += hh * hh; hpL2 += hl * hl; hpCount++;
    }
  }
  const round = n => Number(n.toFixed(8));
  return {
    heightGradientMean: round(gradCount ? gradH / gradCount : 0),
    albedoGradientMean: round(gradCount ? gradL / gradCount : 0),
    heightHighpassRms: round(hpCount ? Math.sqrt(hpH2 / hpCount) : 0),
    albedoHighpassRms: round(hpCount ? Math.sqrt(hpL2 / hpCount) : 0),
  };
}

function analyzeBuffer(buffer) {
  const luminance = new Float32Array(buffer.N * buffer.N);
  for (let i = 0; i < luminance.length; i++) luminance[i] = 0.2126 * buffer.A[i * 3] + 0.7152 * buffer.A[i * 3 + 1] + 0.0722 * buffer.A[i * 3 + 2];
  return {
    channels: { height: stats(buffer.H), albedoLuminance: stats(luminance), roughness: stats(buffer.R), metalness: stats(buffer.M) },
    spatial: spatialDetail(buffer, luminance),
  };
}

function analyzeProgram(prog, resolution, values, checkDeterminism, viewport) {
  const { GRAIN } = loadRuntime();
  const normalizedViewport = normalizeViewport(viewport);
  const buffer = GRAIN.evaluate(prog, resolution, values, normalizedViewport);
  const metrics = analyzeBuffer(buffer);
  const channelStats = metrics.channels;
  const seam = GRAIN.seamError(prog, Math.max(32, resolution), values, buffer.viewport.rho);
  let deterministic = null;
  if (checkDeterminism) {
    const again = GRAIN.evaluate(prog, resolution, values, normalizedViewport);
    deterministic = equalTypedArrays(buffer.H, again.H) && equalTypedArrays(buffer.A, again.A)
      && equalTypedArrays(buffer.R, again.R) && equalTypedArrays(buffer.M, again.M);
  }
  const diagnostics = [];
  if (prog.tile && seam > 1e-6) diagnostics.push({
    severity: 'warning', code: 'TILE_SEAM_DETECTED', line: null,
    message: `tile=${prog.tile}인데 경계 오차가 ${seam.toFixed(6)}입니다.`,
    suggestion: 'primitive 좌표가 u/v 경계에서 같은 값을 갖는지 확인하고 warp 좌표도 주기적으로 구성하세요.',
  });
  if (channelStats.height.stddev !== null && channelStats.height.stddev < 0.005 && metrics.spatial.heightGradientMean * normalizedViewport.zoom < 0.005) diagnostics.push({
    severity: 'warning', code: 'HEIGHT_NEARLY_FLAT', line: null,
    message: `height 표준편차가 ${channelStats.height.stddev}로 거의 평평합니다.`,
    suggestion: '미세 요철이나 중간 스케일 구조의 진폭을 조금 늘리세요.',
  });
  if (channelStats.albedoLuminance.stddev !== null && channelStats.albedoLuminance.stddev < 0.005) diagnostics.push({
    severity: 'warning', code: 'ALBEDO_NEARLY_FLAT', line: null,
    message: `albedo 명도 표준편차가 ${channelStats.albedoLuminance.stddev}로 거의 균일합니다.`,
    suggestion: 'height와 완전히 같지 않은 저주파 색 변화나 입자별 색 변화를 추가하세요.',
  });
  for (const [name, value] of [['height', channelStats.height], ['roughness', channelStats.roughness], ['metalness', channelStats.metalness]]) {
    if (value.nonFinite) diagnostics.push({ severity: 'warning', code: 'NON_FINITE_CHANNEL', line: null, message: `${name}에 유한하지 않은 샘플 ${value.nonFinite}개가 있습니다.`, suggestion: '0으로 나누기, 음수 sqrt, 과도한 pow 입력을 확인하세요.' });
    if (value.outside01) diagnostics.push({ severity: 'warning', code: 'CHANNEL_OUT_OF_RANGE', line: null, message: `${name}의 [0,1] 밖 샘플이 ${value.outside01}/${value.count}개입니다.`, suggestion: `out ${name === 'roughness' ? 'rough' : name === 'metalness' ? 'metal' : 'height'}를 clamp(..., 0, 1)로 제한하세요.` });
  }
  return { resolution, viewport: buffer.viewport, seam: Number(seam.toFixed(8)), deterministic, channels: channelStats, spatial: metrics.spatial, diagnostics, buffer };
}

function allExamples() {
  const { GRAIN_EXAMPLES } = loadRuntime();
  const examples = GRAIN_EXAMPLES.map(item => ({ id: item.id, name: item.name, source: item.src, origin: 'bundled' }));
  if (fs.existsSync(MATERIALS_PATH)) {
    const files = fs.readdirSync(MATERIALS_PATH, { withFileTypes: true })
      .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.grain'))
      .map(item => item.name).sort();
    for (const file of files) {
      const id = path.basename(file, path.extname(file));
      if (examples.some(item => item.id === id)) throw new Error(`materials library id '${id}'가 bundled example과 충돌함`);
      const source = fs.readFileSync(path.join(MATERIALS_PATH, file), 'utf8');
      const firstComment = source.split(/\r?\n/).find(line => /^\s*#\s*\S/.test(line));
      const name = firstComment ? firstComment.replace(/^\s*#\s*/, '').trim() : id.replace(/[-_]+/g, ' ').toUpperCase();
      examples.push({ id, name, source, origin: 'library' });
    }
  }
  return examples;
}

export function listExamples() {
  return allExamples().map(({ id, name, origin }) => ({ id, name, origin }));
}

export function getExample(id) {
  const examples = allExamples();
  const example = examples.find(item => item.id === id);
  if (!example) throw new Error(`알 수 없는 example '${id}' (허용: ${examples.map(x => x.id).join(', ')})`);
  return { id: example.id, name: example.name, source: example.source, origin: example.origin };
}

export function validateMaterial({ source, values = {}, sampleResolution, checkDeterminism = true, includeIr = false, zoom, centerU, centerV } = {}) {
  try {
    assertSource(source);
    const resolution = boundedInteger(sampleResolution, DEFAULT_SAMPLE_RESOLUTION, 16, 256, 'sampleResolution');
    const { GRAIN } = loadRuntime();
    const built = GRAIN.build(source);
    GRAIN.validateIR(built.ir);
    const resolvedValues = resolveValues(built.prog, values);
    const analysis = analyzeProgram(built.prog, resolution, resolvedValues, Boolean(checkDeterminism), { zoom, centerU, centerV });
    const diagnostics = [...built.prog.warnings.map(classifyCompilerWarning), ...analysis.diagnostics];
    const result = {
      valid: true,
      diagnostics,
      summary: {
        seed: built.prog.seed, tile: built.prog.tile,
        cost: Number(built.prog.cost.toFixed(3)), costBudget: GRAIN.LIMITS.maxCost,
        fields: { user: built.prog.fieldNames.length, hidden: built.prog.hiddenFields, userLimit: GRAIN.LIMITS.maxFields, expandedLimit: GRAIN.LIMITS.maxExpandedFields },
        macros: { definitions: built.prog.macroDefs, instances: built.prog.macroInstances, depthLimit: GRAIN.LIMITS.maxMacroDepth },
        variables: built.prog.vars.map((v, index) => ({ name: v.name, default: v.value, value: resolvedValues[index] })),
        irInstructions: built.prog.irInstructions,
      },
      analysis: { resolution: analysis.resolution, viewport: analysis.viewport, seam: analysis.seam, deterministic: analysis.deterministic, channels: analysis.channels, spatial: analysis.spatial },
    };
    if (includeIr) result.ir = GRAIN.formatIR(built.ir);
    return result;
  } catch (error) {
    return { valid: false, diagnostics: [classifyCompilerError(error)] };
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function encodePngRgba(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('RGBA buffer 크기가 이미지 크기와 맞지 않음');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1); raw[row] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, row + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function grayscaleImage(values) {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const value = Math.round(255 * Math.min(1, Math.max(0, values[i])));
    out[i * 4] = value; out[i * 4 + 1] = value; out[i * 4 + 2] = value; out[i * 4 + 3] = 255;
  }
  return out;
}

function normalizedViews(views, fallback = VIEW_NAMES) {
  const requestedViews = views === undefined ? fallback : views;
  if (!Array.isArray(requestedViews) || !requestedViews.length || requestedViews.some(v => !VIEW_NAMES.includes(v))) throw new Error(`views는 ${VIEW_NAMES.join(', ')} 중 하나 이상이어야 함`);
  return [...new Set(requestedViews)];
}

function renderViews(GRAIN_RENDER, buffer, normals, size, views) {
  const rgbaByView = {
    shaded: () => GRAIN_RENDER.shade(buffer, normals, { az: 0.12, el: 0.45 }),
    albedo: () => GRAIN_RENDER.albedoImg(buffer),
    height: () => GRAIN_RENDER.heightImg(buffer),
    normal: () => GRAIN_RENDER.normalImg(normals, size),
    rough: () => GRAIN_RENDER.roughImg(buffer),
    metal: () => grayscaleImage(buffer.M),
  };
  return views.map(view => ({ view, width: size, height: size, mimeType: 'image/png', data: encodePngRgba(size, size, rgbaByView[view]()) }));
}

export function renderMaterial({ source, values = {}, resolution, relief, views, zoom, centerU, centerV } = {}) {
  assertSource(source);
  const size = boundedInteger(resolution, DEFAULT_RENDER_RESOLUTION, 16, 512, 'resolution');
  const reliefValue = finiteNumber(relief, 0.6, 0, 4, 'relief');
  const uniqueViews = normalizedViews(views);
  const viewport = normalizeViewport({ zoom, centerU, centerV });
  const validation = validateMaterial({ source, values, sampleResolution: Math.min(size, 128), checkDeterminism: true, ...viewport });
  if (!validation.valid) return { ...validation, images: [] };
  const { GRAIN, GRAIN_RENDER } = loadRuntime();
  const built = GRAIN.build(source);
  const resolvedValues = resolveValues(built.prog, values);
  const buffer = GRAIN.evaluate(built.prog, size, resolvedValues, viewport);
  const normals = GRAIN_RENDER.normals(buffer, reliefValue * viewport.zoom);
  const images = renderViews(GRAIN_RENDER, buffer, normals, size, uniqueViews);
  return { ...validation, render: { resolution: size, relief: reliefValue, views: uniqueViews, viewport: buffer.viewport }, images };
}

export function renderMaterialMultiscale({ source, values = {}, resolution, relief, views, zooms, centerU, centerV } = {}) {
  assertSource(source);
  const size = boundedInteger(resolution, 160, 16, 512, 'resolution');
  const reliefValue = finiteNumber(relief, 0.6, 0, 4, 'relief');
  const uniqueViews = normalizedViews(views, ['shaded', 'albedo', 'height', 'normal']);
  const requestedZooms = zooms === undefined ? [1, 4, 16, 64] : zooms;
  if (!Array.isArray(requestedZooms) || !requestedZooms.length || requestedZooms.length > 8) throw new Error('zooms는 1..8개 숫자 배열이어야 함');
  const uniqueZooms = [...new Set(requestedZooms.map(value => finiteNumber(value, undefined, 1, 4096, 'zoom')))];
  const center = normalizeViewport({ zoom: 1, centerU, centerV });
  const validation = validateMaterial({ source, values, sampleResolution: Math.min(size, 96), checkDeterminism: true, ...center });
  if (!validation.valid) return { ...validation, images: [], scales: [] };
  const { GRAIN, GRAIN_RENDER } = loadRuntime();
  const built = GRAIN.build(source);
  const resolvedValues = resolveValues(built.prog, values);
  const images = [], scales = [], scaleDiagnostics = [];
  for (const zoomValue of uniqueZooms) {
    const viewport = { zoom: zoomValue, centerU: center.centerU, centerV: center.centerV };
    const buffer = GRAIN.evaluate(built.prog, size, resolvedValues, viewport);
    const normals = GRAIN_RENDER.normals(buffer, reliefValue * zoomValue);
    const metrics = analyzeBuffer(buffer);
    scales.push({ zoom: zoomValue, viewport: buffer.viewport, channels: metrics.channels, spatial: metrics.spatial });
    if (zoomValue > 1 && metrics.channels.height.stddev < 0.003 && metrics.channels.albedoLuminance.stddev < 0.003) scaleDiagnostics.push({
      severity: 'warning', code: 'SCALE_DETAIL_COLLAPSE', line: null,
      message: `${zoomValue}× crop에서 height와 albedo가 동시에 거의 평평합니다.`,
      suggestion: '이 footprint에서만 활성화되는 더 작은 균열·응집토·입자 band를 rho로 추가하세요.',
    });
    for (const image of renderViews(GRAIN_RENDER, buffer, normals, size, uniqueViews)) images.push({ ...image, zoom: zoomValue });
  }
  return {
    ...validation, diagnostics: [...validation.diagnostics, ...scaleDiagnostics],
    multiscale: { resolution: size, relief: reliefValue, views: uniqueViews, zooms: uniqueZooms, centerU: center.centerU, centerV: center.centerV },
    scales, images,
  };
}

export const grainToolInfo = Object.freeze({
  root: ROOT, benchPath: BENCH_PATH, materialsPath: MATERIALS_PATH, maxSourceBytes: MAX_SOURCE_BYTES,
  sampleResolution: DEFAULT_SAMPLE_RESOLUTION, renderResolution: DEFAULT_RENDER_RESOLUTION,
  views: VIEW_NAMES,
});
