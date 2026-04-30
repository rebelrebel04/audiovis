import * as polygonEnvelope from './polygonEnvelope.js';
import * as particleRings from './particleRings.js';
import * as lightPainting from './lightPainting.js';
import * as hyperspaceTunnel from './hyperspaceTunnel.js';

/**
 * Registry of available primitives, keyed by display name.
 * Order here determines dropdown order in the UI.
 *
 * Every primitive must satisfy the contract:
 *   { params, modulation, init(scene), dispose(scene),
 *     mountGui(parent, helpers), update({ time, dt, audio, bus }) }
 */
export const PRIMITIVES = {
  'polygon envelope': polygonEnvelope,
  'particle rings': particleRings,
  'light painting': lightPainting,
  'hyperspace tunnel': hyperspaceTunnel,
};

export const DEFAULT_PRIMITIVE = 'polygon envelope';
