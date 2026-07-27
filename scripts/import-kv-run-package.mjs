#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg) throw new Error('Usage: node scripts/import-kv-run-package.mjs <KV_RUN_PACKAGE_V1> [output-dir]');
const source = resolve(sourceArg);
const output = resolve(outputArg ?? join(source, 'guide'));
const manifest = readJson(join(source, 'manifest.json'));
const recipe = readJson(join(source, 'recipe-draft.json'));
const events = readJsonl(join(source, 'events.jsonl'));
const sensitive = findSensitive(JSON.stringify({ manifest, recipe, events }));
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'assets'), { recursive: true, mode: 0o700 });

const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
const images = artifacts.filter((artifact) => artifact?.kind === 'screenshot' && typeof artifact.path === 'string').map((artifact) => {
  const from = resolve(source, artifact.path);
  const name = basename(artifact.path);
  if (existsSync(from)) cpSync(from, join(output, 'assets', name));
  return { path: `assets/${name}`, caption: `Browser evidence ${artifact.id}`, source_ids: [String(artifact.event_id ?? artifact.id)] };
});
const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
const article = {
  schema_version: '0.1', title: String(recipe?.intent ?? 'Kv Browser Run Guide'),
  summary: 'Evidence-linked guide generated from a Kv Browser Bridge run package.',
  goal: String(recipe?.intent ?? 'Reproduce the recorded browser workflow.'), audience: 'Operators with access to the same browser workflow.',
  content_type: 'tutorial-review', preset: 'technical',
  sections: [
    { heading: 'Steps', blocks: [{ type: 'steps', locked: true, items: steps.map((step, index) => ({ text: step.description ?? `Step ${index + 1}: ${step.action ?? 'manual action'}`, source_ids: [String(step.id ?? `step-${index + 1}`)] })) }] },
    { heading: 'Evidence', blocks: images.map((image) => ({ type: 'image', ...image, locked: true })) },
    { heading: 'Verification', blocks: [{ type: 'checklist', locked: true, items: [`Run ${manifest.run?.id ?? 'unknown'} exported with ${events.length} events.`, `Recipe draft contains ${steps.length} steps.`] }] },
  ],
  verification: { success_signals: ['The referenced screenshots and event records are present.'], failure_signals: sensitive.length ? ['Sensitive content was detected.'] : [], recovery: ['Review the source event and rerun only the affected browser step.'] },
};
const report = { status: sensitive.length ? 'blocked' : 'pass', source: 'KV_RUN_PACKAGE_V1', events: events.length, artifacts: images.length, issues: sensitive.map((sample) => ({ severity: 'P0', code: 'sensitive-content', sample })) };
writeJson(join(output, 'article.json'), article);
writeFileSync(join(output, 'article.md'), markdown(article), 'utf8');
writeFileSync(join(output, 'preview.html'), html(article), 'utf8');
writeFileSync(join(output, 'quality-report.md'), `# Quality report\n\nStatus: **${report.status}**\n\n- Events: ${report.events}\n- Screenshots: ${report.artifacts}\n${report.issues.map((issue) => `- ${issue.severity}: ${issue.code}`).join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ output, status: report.status, files: ['article.md', 'article.json', 'preview.html', 'quality-report.md'] }, null, 2));
process.exitCode = sensitive.length ? 2 : 0;

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function readJsonl(path) { return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []; }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function findSensitive(text) { return [...new Set((text.match(/(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/gi) ?? []).map((value) => value.slice(0, 16)))]; }
function markdown(value) { return `# ${value.title}\n\n${value.summary}\n\n## Steps\n\n${value.sections[0].blocks[0].items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}\n\n## Verification\n\n${value.sections[2].blocks[0].items.map((item) => `- ${item}`).join('\n')}\n`; }
function html(value) { return `<!doctype html><meta charset="utf-8"><title>${escape(value.title)}</title><main><h1>${escape(value.title)}</h1><p>${escape(value.summary)}</p><h2>Steps</h2><ol>${value.sections[0].blocks[0].items.map((item) => `<li>${escape(item.text)}</li>`).join('')}</ol>${value.sections[1].blocks.map((block) => `<figure><img src="${escape(block.path)}" alt="${escape(block.caption)}"><figcaption>${escape(block.caption)}</figcaption></figure>`).join('')}</main>`; }
function escape(value) { return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]); }
