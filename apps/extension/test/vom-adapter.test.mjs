import assert from 'node:assert/strict';
import test from 'node:test';
import { renderLocalObservation } from '../src/background/vom-adapter.ts';

/**
 * Fixture: a 1000x600 viewport with a fixed modal dialog covering ~67% of the
 * viewport (>= 60% blocking threshold). The modal carries a heading, a publish
 * button (valid CDP backendNodeId) and a sensitive text input whose value must
 * be redacted. A page-level button below the modal exercises the occlusion
 * path.
 */
const fixture = {
  viewport: { width: 1000, height: 600 },
  rootFrameId: 'root',
  nodes: [
    {
      id: 10,
      parentId: null,
      tag: 'button',
      role: 'button',
      name: '页面按钮',
      frameId: 'root',
      rect: { x: 20, y: 20, w: 120, h: 40 },
      paintOrder: 1,
      position: 'static',
      pointerEvents: 'auto',
      backendNodeId: 11,
    },
    {
      id: 20,
      parentId: null,
      tag: 'div',
      role: 'dialog',
      name: '发布确认',
      modal: true,
      frameId: 'root',
      rect: { x: 100, y: 50, w: 800, h: 500 },
      paintOrder: 100,
      position: 'fixed',
      pointerEvents: 'auto',
    },
    {
      id: 21,
      parentId: 20,
      tag: 'h1',
      role: 'heading',
      name: '发布设置',
      frameId: 'root',
      rect: { x: 140, y: 80, w: 400, h: 30 },
      paintOrder: 101,
      position: 'static',
      pointerEvents: 'auto',
    },
    {
      id: 22,
      parentId: 20,
      tag: 'button',
      role: 'button',
      name: '发布',
      frameId: 'root',
      rect: { x: 200, y: 300, w: 120, h: 40 },
      paintOrder: 102,
      position: 'static',
      pointerEvents: 'auto',
      backendNodeId: 123,
    },
    {
      id: 23,
      parentId: 20,
      tag: 'input',
      role: 'textbox',
      name: '访问令牌',
      value: 'supersecret-value-9f2',
      sensitive: true,
      frameId: 'root',
      rect: { x: 200, y: 200, w: 300, h: 30 },
      paintOrder: 103,
      position: 'static',
      pointerEvents: 'auto',
      backendNodeId: 124,
    },
  ],
};

test('renderLocalObservation emits a VOM header with @vom 1', () => {
  const result = renderLocalObservation(fixture);
  assert.match(result.text, /@vom 1/);
  assert.match(result.text, /@view 1000x600/);
});

test('fixture carries a heading that renders into the VOM text', () => {
  const result = renderLocalObservation(fixture);
  assert.match(result.text, /heading "发布设置"/);
});

test('publish button is published with a ref and valid backendNodeId', () => {
  const result = renderLocalObservation(fixture);
  assert.match(result.text, /button "发布"/);
  const buttonRef = result.refs.find((ref) => ref.name === '发布');
  assert.ok(buttonRef, 'expected a ref for the 发布 button');
  assert.equal(buttonRef.backendNodeId, 123);
  assert.equal(buttonRef.role, 'button');
});

test('fixed modal >= 60% viewport is detected as an L1 modal layer', () => {
  const result = renderLocalObservation(fixture);
  assert.match(result.text, /@layers 2 focus=L1/);
  assert.match(result.text, /L1 modal cover=\d+%/);
  assert.match(result.text, /L2 page … occluded by L1/);
});

test('sensitive input value is redacted and never leaked', () => {
  const result = renderLocalObservation(fixture);
  assert.doesNotMatch(result.text, /supersecret-value-9f2/);
  assert.match(result.text, /访问令牌/);
  assert.match(result.text, /="•••"/);
});

test('at least one ref is produced and refs carry stable ref strings', () => {
  const result = renderLocalObservation(fixture);
  assert.ok(result.refs.length >= 1);
  for (const ref of result.refs) {
    assert.match(ref.ref, /^e\d+$/);
    assert.ok(ref.backendNodeId > 0);
  }
});
