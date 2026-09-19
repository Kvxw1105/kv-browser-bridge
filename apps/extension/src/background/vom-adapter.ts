/**
 * VOM semantic observation adapter.
 *
 * Thin, CDP-free boundary between the extension's raw observation collection
 * and the pure VOM renderer (`@kv-browser-bridge/vom`, vendored from
 * Tencent/BrowserSkill packages/vom/src). The extension joins AX semantics and
 * DOMSnapshot geometry by backendNodeId before constructing `RawVomNode`s;
 * `renderLocalObservation` then normalizes them into a `VomScene` and routes
 * through `renderVom`.
 *
 * Nothing here owns transport, credentials, identity, or publish state.
 */

import {
  renderVom,
  type Rect,
  type VomNode,
  type VomOptions,
  type VomResult,
  type VomScene,
  type Viewport,
} from '@kv-browser-bridge/vom';

/**
 * Raw scene node as produced by the extension's CDP collection (AX + DOM
 * geometry), before normalization. `id`/`parentId` use a single numeric id
 * space; `backendNodeId` is the CDP DOM node id used to address actions.
 */
export interface RawVomNode {
  id: number;
  parentId: number | null;
  backendNodeId?: number;
  frameId?: string;
  role?: string;
  name?: string;
  value?: string;
  checked?: boolean | 'mixed';
  placeholder?: string;
  inputState?: 'empty' | 'filled' | 'default' | 'unknown';
  href?: string;
  text?: string;
  nearbyText?: string;
  tag?: string;
  rect?: Rect | null;
  paintOrder?: number;
  position?: string;
  pointerEvents?: string;
  cursor?: string;
  attrs?: Record<string, string>;
  modal?: boolean;
  sensitive?: boolean;
  disabled?: boolean;
  inert?: boolean;
  referenceable?: boolean;
}

/** The raw scene slice consumed by `renderLocalObservation`. */
export interface RawVomObservation {
  viewport: Viewport;
  rootFrameId?: string;
  nodes: RawVomNode[];
  options?: VomOptions;
  /** Optional VomScene extension points kept aligned with the upstream contract. */
  visuals?: VomScene['visuals'];
  surfaces?: VomScene['surfaces'];
  activeScopeBlocks?: VomScene['activeScopeBlocks'];
}

const DEFAULT_TAG_BY_ROLE: Record<string, string> = {
  button: 'button',
  link: 'a',
  textbox: 'input',
  searchbox: 'input',
  checkbox: 'input',
  radio: 'input',
  combobox: 'select',
  listbox: 'select',
  img: 'img',
  heading: 'h1',
  iframe: 'iframe',
};

function tagFor(raw: RawVomNode, index: number): string {
  if (raw.tag) return raw.tag;
  const role = (raw.role ?? '').toLowerCase();
  return DEFAULT_TAG_BY_ROLE[role] ?? 'div';
}

function toVomNode(raw: RawVomNode, index: number): VomNode {
  const paintOrder = raw.paintOrder ?? index;
  return {
    id: raw.id,
    parentId: raw.parentId,
    ...(raw.backendNodeId !== undefined ? { backendNodeId: raw.backendNodeId } : {}),
    ...(raw.frameId ? { frameId: raw.frameId } : {}),
    ...(raw.referenceable !== undefined ? { referenceable: raw.referenceable } : {}),
    ...(raw.role ? { role: raw.role } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
    ...(raw.value !== undefined ? { value: raw.value } : {}),
    ...(raw.checked !== undefined ? { checked: raw.checked } : {}),
    ...(raw.placeholder !== undefined ? { placeholder: raw.placeholder } : {}),
    ...(raw.inputState !== undefined ? { inputState: raw.inputState } : {}),
    ...(raw.href !== undefined ? { href: raw.href } : {}),
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.nearbyText !== undefined ? { nearbyText: raw.nearbyText } : {}),
    tag: tagFor(raw, index),
    rect: raw.rect ?? null,
    paintOrder,
    position: raw.position ?? 'static',
    pointerEvents: raw.pointerEvents ?? 'auto',
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
    ...(raw.attrs ? { attrs: raw.attrs } : {}),
    ...(raw.modal === true ? { modal: true } : {}),
    ...(raw.sensitive === true ? { sensitive: true } : {}),
    ...(raw.disabled === true ? { disabled: true } : {}),
    ...(raw.inert === true ? { inert: true } : {}),
  };
}

/**
 * Render a raw observation into a local VOM view (text + refs + truncation).
 * Pure: no CDP, no side effects. Result carries the vendored `VomResult`
 * shape; callers wrap it with their transport-facing envelope.
 */
export function renderLocalObservation(raw: RawVomObservation): VomResult {
  const nodes = raw.nodes.map(toVomNode);
  const scene: VomScene = {
    viewport: raw.viewport,
    nodes,
    ...(raw.rootFrameId ? { rootFrameId: raw.rootFrameId } : {}),
    ...(raw.visuals && raw.visuals.length > 0 ? { visuals: raw.visuals } : {}),
    ...(raw.surfaces && raw.surfaces.length > 0 ? { surfaces: raw.surfaces } : {}),
    ...(raw.activeScopeBlocks && raw.activeScopeBlocks.length > 0 ? { activeScopeBlocks: raw.activeScopeBlocks } : {}),
  };
  return renderVom(scene, raw.options ?? {});
}
