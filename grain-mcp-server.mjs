#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getExample, listExamples, renderMaterial, renderMaterialMultiscale, validateMaterial } from './grain-tools.mjs';

const TOOL_DEFINITIONS = [
  {
    name: 'list_material_examples',
    description: 'List the bundled GRAIN material examples. Start here when choosing a proven graph to adapt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_material_example',
    description: 'Get one complete, validated GRAIN source example by id. Adapt its graph instead of inventing an unrelated syntax.',
    inputSchema: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string', description: 'Example id returned by list_material_examples.' } },
    },
  },
  {
    name: 'validate_material',
    description: 'Parse, expand, validate, lower, sample, and determinism-check a GRAIN material. Always call this before rendering and use diagnostic suggestions to repair the source.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Complete GRAIN DSL source. Provide source or exampleId, not both.' },
        exampleId: { type: 'string', description: 'Validate a bundled example instead of source.' },
        values: { type: 'object', additionalProperties: { type: 'number' }, description: 'Optional var overrides by name.' },
        sampleResolution: { type: 'integer', minimum: 16, maximum: 256, default: 64 },
        checkDeterminism: { type: 'boolean', default: true },
        includeIr: { type: 'boolean', default: false, description: 'Include canonical SSA IR when debugging lowering.' },
        zoom: { type: 'number', minimum: 1, maximum: 4096, default: 1, description: 'Sample a smaller world-space window around centerU/centerV.' },
        centerU: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        centerV: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      },
      anyOf: [{ required: ['source'] }, { required: ['exampleId'] }],
    },
  },
  {
    name: 'render_material',
    description: 'Validate and render a GRAIN material into image content for visual scoring. Returns metrics plus requested shaded/PBR views.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Complete GRAIN DSL source. Provide source or exampleId, not both.' },
        exampleId: { type: 'string', description: 'Render a bundled example instead of source.' },
        values: { type: 'object', additionalProperties: { type: 'number' }, description: 'Optional var overrides by name.' },
        resolution: { type: 'integer', minimum: 16, maximum: 512, default: 192 },
        relief: { type: 'number', minimum: 0, maximum: 4, default: 0.6 },
        zoom: { type: 'number', minimum: 1, maximum: 4096, default: 1 },
        centerU: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        centerV: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        views: {
          type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', enum: ['shaded', 'albedo', 'height', 'normal', 'rough', 'metal'] },
          default: ['shaded', 'albedo', 'height', 'normal', 'rough', 'metal'],
        },
      },
      anyOf: [{ required: ['source'] }, { required: ['exampleId'] }],
    },
  },
  {
    name: 'render_material_multiscale',
    description: 'Render the same material point at several procedural zoom levels. Use this to verify that the material remains structurally convincing from macro scale through close-up, rather than merely enlarging pixels.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Complete GRAIN DSL source. Provide source or exampleId, not both.' },
        exampleId: { type: 'string', description: 'Render a bundled/library example instead of source.' },
        values: { type: 'object', additionalProperties: { type: 'number' } },
        resolution: { type: 'integer', minimum: 16, maximum: 512, default: 160 },
        relief: { type: 'number', minimum: 0, maximum: 4, default: 0.6 },
        zooms: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'number', minimum: 1, maximum: 4096 }, default: [1, 4, 16, 64] },
        centerU: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        centerV: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        views: {
          type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', enum: ['shaded', 'albedo', 'height', 'normal', 'rough', 'metal'] },
          default: ['shaded', 'albedo', 'height', 'normal'],
        },
      },
      anyOf: [{ required: ['source'] }, { required: ['exampleId'] }],
    },
  },
];

function sourceFromArgs(args) {
  const hasSource = typeof args.source === 'string';
  const hasExample = typeof args.exampleId === 'string';
  if (hasSource === hasExample) throw new Error('source와 exampleId 중 정확히 하나를 제공해야 함');
  return hasSource ? args.source : getExample(args.exampleId).source;
}

function jsonContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export async function callTool(name, args = {}) {
  if (name === 'list_material_examples') {
    const result = { examples: listExamples(), workflow: ['get_material_example', 'validate_material', 'render_material_multiscale', 'render_material', 'edit source and repeat'] };
    return { content: jsonContent(result), structuredContent: result };
  }
  if (name === 'get_material_example') {
    const result = getExample(args.id);
    return { content: jsonContent(result), structuredContent: result };
  }
  if (name === 'validate_material') {
    const source = sourceFromArgs(args);
    const result = validateMaterial({
      source, values: args.values, sampleResolution: args.sampleResolution,
      checkDeterminism: args.checkDeterminism, includeIr: args.includeIr,
      zoom: args.zoom, centerU: args.centerU, centerV: args.centerV,
    });
    return { content: jsonContent(result), structuredContent: result };
  }
  if (name === 'render_material') {
    const source = sourceFromArgs(args);
    const result = renderMaterial({ source, values: args.values, resolution: args.resolution, relief: args.relief, views: args.views, zoom: args.zoom, centerU: args.centerU, centerV: args.centerV });
    const metadata = { ...result };
    delete metadata.images;
    const content = jsonContent(metadata);
    for (const image of result.images) {
      content.push({ type: 'text', text: `ZOOM ${result.render.viewport.zoom}× · VIEW ${image.view} · ${image.width}x${image.height}` });
      content.push({ type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType });
    }
    return { content, structuredContent: metadata };
  }
  if (name === 'render_material_multiscale') {
    const source = sourceFromArgs(args);
    const result = renderMaterialMultiscale({
      source, values: args.values, resolution: args.resolution, relief: args.relief, views: args.views,
      zooms: args.zooms, centerU: args.centerU, centerV: args.centerV,
    });
    const metadata = { ...result }; delete metadata.images;
    const content = jsonContent(metadata);
    for (const image of result.images) {
      content.push({ type: 'text', text: `ZOOM ${image.zoom}× · VIEW ${image.view} · ${image.width}x${image.height}` });
      content.push({ type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType });
    }
    return { content, structuredContent: metadata };
  }
  throw new Error(`알 수 없는 tool '${name}'`);
}

export async function dispatch(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (message.method.startsWith('notifications/')) return null;
  try {
    let result;
    if (message.method === 'initialize') result = {
      protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'grain-material-tools', version: '0.6.0' },
      instructions: 'Use list/get to reuse a proven graph. Validate, then render_material_multiscale at 1×/4×/16×/64×. Inspect whether new physically plausible structure appears at each scale, then use render_material for full PBR review.',
    };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: TOOL_DEFINITIONS };
    else if (message.method === 'tools/call') result = await callTool(message.params?.name, message.params?.arguments ?? {});
    else return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `Method not found: ${message.method}` } };
    return { jsonrpc: '2.0', id: message.id ?? null, result };
  } catch (error) {
    return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: error.message } };
  }
}

export function startServer() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on('line', line => {
    pending = pending.then(async () => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); return; }
      const response = await dispatch(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) startServer();

export { TOOL_DEFINITIONS };
