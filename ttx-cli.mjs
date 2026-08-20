#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getExample, listExamples, renderMaterial, renderMaterialMultiscale, validateMaterial } from './ttx-tools.mjs';

function usage() {
  return `TTX CLI

Usage:
  node ttx-cli.mjs examples [--json]
  node ttx-cli.mjs example <id>
  node ttx-cli.mjs validate <file|-> [--json] [--resolution N] [--zoom N] [--center U,V] [--values JSON] [--ir]
  node ttx-cli.mjs validate --example <id> [--json] [--resolution N] [--zoom N] [--center U,V] [--values JSON] [--ir]
  node ttx-cli.mjs render <file|-> --out <dir> [--resolution N] [--zoom N] [--center U,V] [--relief N] [--views shaded,albedo,height,normal,rough,metal] [--values JSON] [--json]
  node ttx-cli.mjs render-scales <file|-> --out <dir> [--resolution N] [--zooms 1,4,16,64] [--center U,V] [--views shaded,albedo,height,normal] [--json]

Exit codes: 0 success, 1 invalid material, 2 usage/tool error.`;
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (['json', 'ir'].includes(name)) { options[name] = true; continue; }
    if (i + 1 >= args.length) throw new Error(`--${name} 값이 없음`);
    options[name] = args[++i];
  }
  return { positional, options };
}

function sourceFrom(positional, options) {
  if (options.example) return getExample(options.example).source;
  const target = positional[0];
  if (!target) throw new Error('spec file 또는 --example <id>가 필요함');
  return target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(target), 'utf8');
}

function valuesFrom(options) {
  if (options.values === undefined) return {};
  let values;
  try { values = JSON.parse(options.values); }
  catch { throw new Error('--values는 JSON 객체여야 함 (예: --values "{\\"wear\\":0.7}")'); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('--values는 var 이름을 키로 하는 JSON 객체여야 함');
  return values;
}

function centerFrom(options) {
  if (options.center === undefined) return {};
  const parts = options.center.split(',').map(Number);
  if (parts.length !== 2 || parts.some(x => !Number.isFinite(x))) throw new Error('--center는 U,V 형식이어야 함 (예: --center 0.5,0.5)');
  return { centerU: parts[0], centerV: parts[1] };
}

function zoomTag(zoom) { return String(zoom).replace('.', 'p'); }

function printHuman(result) {
  if (!result.valid) {
    for (const d of result.diagnostics) console.error(`✕ ${d.code}${d.line ? ` line ${d.line}` : ''}: ${d.message}\n  → ${d.suggestion}`);
    return;
  }
  const s = result.summary, a = result.analysis;
  console.log(`✓ valid · cost ${s.cost}/${s.costBudget} · fields ${s.fields.user}+${s.fields.hidden} · macros ${s.macros.definitions}/${s.macros.instances} · IR ${s.irInstructions}`);
  console.log(`  seam ${a.seam} · deterministic ${a.deterministic} · height σ ${a.channels.height.stddev} · albedo σ ${a.channels.albedoLuminance.stddev}`);
  for (const d of result.diagnostics) console.log(`⚠ ${d.code}: ${d.message}\n  → ${d.suggestion}`);
}

async function main() {
  const command = process.argv[2];
  const { positional, options } = parseArgs(process.argv.slice(3));
  if (!command || command === 'help' || command === '--help') { console.log(usage()); return 0; }
  if (command === 'examples') {
    const examples = listExamples();
    if (options.json) console.log(JSON.stringify(examples, null, 2));
    else examples.forEach(x => console.log(`${x.id}\t${x.name}`));
    return 0;
  }
  if (command === 'example') {
    if (!positional[0]) throw new Error('example id가 필요함');
    process.stdout.write(getExample(positional[0]).source);
    return 0;
  }
  if (command === 'validate') {
    const source = sourceFrom(positional, options);
    const result = validateMaterial({ source, values: valuesFrom(options), sampleResolution: options.resolution === undefined ? undefined : Number(options.resolution), includeIr: Boolean(options.ir), zoom: options.zoom === undefined ? undefined : Number(options.zoom), ...centerFrom(options) });
    if (options.json) console.log(JSON.stringify(result, null, 2)); else { printHuman(result); if (options.ir && result.ir) console.log(`\n${result.ir}`); }
    return result.valid ? 0 : 1;
  }
  if (command === 'render') {
    if (!options.out) throw new Error('--out <dir>가 필요함');
    const source = sourceFrom(positional, options);
    const views = options.views ? options.views.split(',').map(x => x.trim()).filter(Boolean) : undefined;
    const result = renderMaterial({ source, values: valuesFrom(options), resolution: options.resolution === undefined ? undefined : Number(options.resolution), relief: options.relief === undefined ? undefined : Number(options.relief), views, zoom: options.zoom === undefined ? undefined : Number(options.zoom), ...centerFrom(options) });
    if (!result.valid) {
      if (options.json) console.log(JSON.stringify(result, null, 2)); else printHuman(result);
      return 1;
    }
    const outDir = path.resolve(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const files = [];
    for (const image of result.images) {
      const file = path.join(outDir, `${image.view}.png`);
      fs.writeFileSync(file, image.data); files.push(file);
    }
    const metadata = { valid: result.valid, diagnostics: result.diagnostics, summary: result.summary, analysis: result.analysis, render: result.render, files };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(metadata, null, 2));
    if (options.json) console.log(JSON.stringify(metadata, null, 2));
    else { printHuman(result); console.log(`  rendered ${files.length} views → ${outDir}`); }
    return 0;
  }
  if (command === 'render-scales') {
    if (!options.out) throw new Error('--out <dir>가 필요함');
    const source = sourceFrom(positional, options);
    const views = options.views ? options.views.split(',').map(x => x.trim()).filter(Boolean) : undefined;
    const zooms = options.zooms ? options.zooms.split(',').map(Number) : undefined;
    const result = renderMaterialMultiscale({ source, values: valuesFrom(options), resolution: options.resolution === undefined ? undefined : Number(options.resolution), relief: options.relief === undefined ? undefined : Number(options.relief), views, zooms, ...centerFrom(options) });
    if (!result.valid) { if (options.json) console.log(JSON.stringify(result, null, 2)); else printHuman(result); return 1; }
    const outDir = path.resolve(options.out); fs.mkdirSync(outDir, { recursive: true });
    const files = [];
    for (const image of result.images) {
      const file = path.join(outDir, `zoom-${zoomTag(image.zoom)}x-${image.view}.png`);
      fs.writeFileSync(file, image.data); files.push(file);
    }
    const metadata = { valid: result.valid, diagnostics: result.diagnostics, summary: result.summary, analysis: result.analysis, multiscale: result.multiscale, scales: result.scales, files };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(metadata, null, 2));
    if (options.json) console.log(JSON.stringify(metadata, null, 2));
    else { printHuman(result); console.log(`  rendered ${result.scales.length} scales / ${files.length} views → ${outDir}`); }
    return 0;
  }
  throw new Error(`알 수 없는 command '${command}'\n\n${usage()}`);
}

main().then(code => { process.exitCode = code; }).catch(error => { console.error(`ttx: ${error.message}`); process.exitCode = 2; });
