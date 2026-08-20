import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dispatch, TOOL_DEFINITIONS } from './grain-mcp-server.mjs';
import { getExample, listExamples, renderMaterial, renderMaterialMultiscale, validateMaterial } from './grain-tools.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const benchHtml = fs.readFileSync(path.join(root, 'grain-bench.html'), 'utf8');
assert.match(benchHtml, /function cubeMesh\(seg = 128\)/, 'studio cube subdivision');
assert.match(benchHtml, /vec3 studioEnv\(/, 'studio environment lighting');
assert.match(benchHtml, /float heightAO\(/, 'height ambient occlusion');
assert.match(benchHtml, /\.view\.preview3d::after/, 'compatible contact-shadow layer');
assert.match(benchHtml, /512 · FINAL/, 'final-quality texture option');
const examples = listExamples();
assert.equal(examples.filter(x => x.origin === 'bundled').length, 8, 'bundled example count');
assert.ok(examples.some(x => x.id === 'parched-earth' && x.origin === 'library'), 'materials library auto-discovery');

for (const example of examples) {
  const result = validateMaterial({ source: getExample(example.id).source, sampleResolution: 32 });
  assert.equal(result.valid, true, `${example.id} validates`);
  assert.equal(result.analysis.deterministic, true, `${example.id} deterministic`);
  assert.ok(result.summary.cost <= result.summary.costBudget, `${example.id} within cost`);
  if (example.id !== 'oak') assert.equal(result.analysis.seam, 0, `${example.id} tiles`);
  else assert.ok(result.analysis.seam > 0.01, 'oak intentionally non-tiled');
}

const invalidCases = [
  ["out height = 0.5", 'MISSING_OUTPUT'],
  ["var o = 3\nfield n = fbm(u,v,oct=o)\nout height=n\nout albedo=hsv(0,0,1)", 'STATIC_LITERAL_REQUIRED'],
  ["field a=b\nfield b=1\nout height=a\nout albedo=hsv(0,0,1)", 'FORWARD_REFERENCE'],
  ["tile=1\nfield n=noise(u,v,freq=2.5)\nout height=n\nout albedo=hsv(0,0,n)", 'TILE_PERIOD_INVALID'],
];
for (const [source, code] of invalidCases) {
  const result = validateMaterial({ source, sampleResolution: 16 });
  assert.equal(result.valid, false, `${code} rejects`);
  assert.equal(result.diagnostics[0].code, code, `${code} classified`);
  assert.ok(result.diagnostics[0].suggestion, `${code} suggests repair`);
}

const rendered = renderMaterial({ exampleId: undefined, source: getExample('ceramic').source, resolution: 32, zoom: 4, centerU: 0.4, centerV: 0.6 });
assert.equal(rendered.valid, true, 'render validates');
assert.equal(rendered.images.length, 6, 'all render views');
assert.equal(rendered.render.viewport.zoom, 4, 'single render zoom');
for (const image of rendered.images) {
  assert.deepEqual([...image.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${image.view} PNG signature`);
  assert.equal(image.data.readUInt32BE(16), 32, `${image.view} PNG width`);
  assert.equal(image.data.readUInt32BE(20), 32, `${image.view} PNG height`);
}

const initialized = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
assert.equal(initialized.result.serverInfo.name, 'grain-material-tools', 'MCP initialize');
const listed = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
assert.equal(listed.result.tools.length, TOOL_DEFINITIONS.length, 'MCP tools/list');
const validated = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'validate_material', arguments: { exampleId: 'leather', sampleResolution: 16 } } });
assert.equal(validated.result.structuredContent.valid, true, 'MCP validate_material');
const mcpRendered = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'render_material', arguments: { exampleId: 'rust', resolution: 16, views: ['shaded'] } } });
assert.equal(mcpRendered.result.content.filter(x => x.type === 'image').length, 1, 'MCP render image content');
assert.ok(mcpRendered.result.content.some(x => x.type === 'text' && x.text.startsWith('ZOOM 1× · VIEW shaded')), 'MCP image view label');

const rhoSource = `tile = 1
var base_h = 0.1
field coarse = noise(u, v, freq=4, seed=1)
field micro_gate = 1 - smoothstep(0.001, 0.004, rho)
field micro = micro_gate * (noise(u, v, freq=256, seed=2) - 0.5)
out height = clamp(0.5 + 0.1*(coarse-0.5) + 0.04*micro, 0, 1)
out albedo = hsv(base_h, 0.3, clamp(0.6 + 0.08*micro, 0, 1))
out rough = 0.8
out metal = 0`;
const rhoFar = validateMaterial({ source: rhoSource, sampleResolution: 32, zoom: 1 });
const rhoNear = validateMaterial({ source: rhoSource, sampleResolution: 32, zoom: 64 });
assert.equal(rhoFar.valid && rhoNear.valid, true, 'rho input validates at multiple zooms');
assert.ok(rhoNear.analysis.viewport.rho < rhoFar.analysis.viewport.rho, 'rho shrinks with zoom');

const scaleRender = renderMaterialMultiscale({ source: rhoSource, resolution: 16, zooms: [1, 4], views: ['shaded', 'height'] });
assert.equal(scaleRender.valid, true, 'multiscale render validates');
assert.equal(scaleRender.scales.length, 2, 'multiscale analysis count');
assert.equal(scaleRender.images.length, 4, 'multiscale image count');
const mcpScales = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'render_material_multiscale', arguments: { source: rhoSource, resolution: 16, zooms: [1, 8], views: ['shaded'] } } });
assert.equal(mcpScales.result.content.filter(x => x.type === 'image').length, 2, 'MCP multiscale images');
assert.ok(mcpScales.result.content.some(x => x.type === 'text' && x.text.startsWith('ZOOM 8×')), 'MCP multiscale zoom label');

const rpcInput = [
  { jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
].map(x => JSON.stringify(x)).join('\n') + '\n';
const stdio = spawnSync(process.execPath, ['grain-mcp-server.mjs'], { cwd: root, input: rpcInput, encoding: 'utf8' });
assert.equal(stdio.status, 0, `MCP stdio exit: ${stdio.stderr}`);
const rpcResponses = stdio.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
assert.equal(rpcResponses.length, 2, 'MCP stdio response count');
assert.equal(rpcResponses[1].result.tools.length, TOOL_DEFINITIONS.length, 'MCP stdio tools/list');

const cli = spawnSync(process.execPath, ['grain-cli.mjs', 'validate', '--example', 'canvas', '--json', '--resolution', '16'], { cwd: root, encoding: 'utf8' });
assert.equal(cli.status, 0, `CLI exit: ${cli.stderr}`);
assert.equal(JSON.parse(cli.stdout).valid, true, 'CLI JSON');

const badCli = spawnSync(process.execPath, ['grain-cli.mjs', 'validate', '-', '--json', '--resolution', '16'], { cwd: root, input: 'out height = 0.5\n', encoding: 'utf8' });
assert.equal(badCli.status, 1, `invalid CLI exit: ${badCli.stderr}`);
assert.equal(JSON.parse(badCli.stdout).diagnostics[0].code, 'MISSING_OUTPUT', 'invalid CLI structured diagnostic');

console.log(`PASS · ${examples.length} examples · ${invalidCases.length} repair diagnostics · rho/zoom · 6 PNG views · multiscale · ${TOOL_DEFINITIONS.length} MCP tools/stdio · CLI`);
